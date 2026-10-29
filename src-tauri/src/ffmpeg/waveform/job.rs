//! One envelope job (ADR 056): FFmpeg decodes the audio of a whole file, and Rust folds it.
//!
//! A source thread reads: FFmpeg itself for most containers, or Rust for an FLV, which sends its
//! audio tags to one process for each run (`flv_runs`). The source thread sends the folded
//! buckets to the job thread through a channel. The job thread owns the envelope, sends it to
//! the page every [`FLUSH_INTERVAL`], and polls the cancel flag every [`POLL`] (ADR 050), so a
//! read that waits for a share never holds a cancel. After a cancel it waits at most
//! [`CANCEL_WAIT`] for the source thread, then ends and frees the slot.
//!
//! The job writes the cache only at its end, with one atomic replace, so an exit can kill it at
//! any time and leave no partial entry.

use super::arguments::{file_arguments, flv_run_arguments};
use super::cache::{self, CachedEnvelope, EnvelopeFlags, EnvelopeKey};
use super::flv_runs::{AudioRuns, RunStart, TagAction};
use super::fold::EnvelopeFolder;
use super::registry::{JobHandle, WaveformJobs};
use super::{BUCKET_RATE, BYTES_PER_BUCKET};
use crate::flv::reader::{is_canceled, FileSource};
use crate::flv::scan::{resync, TagStream, RESYNC_REACH};
use crate::flv::tag::{parse_file_header, FILE_HEADER_LEN};
use crate::procutil::command_without_console;
use serde::Serialize;
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How often the job sends the new buckets to the page.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(250);
/// The shortest time between two progress messages: at most four each second.
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// How often the job checks the cancel flag while it waits for the source thread.
pub const POLL: Duration = Duration::from_millis(50);
/// How long a canceled job waits for its source thread before it ends.
pub const CANCEL_WAIT: Duration = Duration::from_secs(2);
/// The most buckets of one message of a cache hit.
pub const CACHED_MESSAGE_BUCKETS: usize = 65_536;
/// The longest envelope: 72 hours.
pub const MAX_BUCKETS: u64 = 72 * 60 * 60 * BUCKET_RATE as u64;

/// How long a process may take to exit after its stdout closed. Then it gets the kill.
const EXIT_WAIT: Duration = Duration::from_secs(5);
const EXIT_POLL: Duration = Duration::from_millis(10);
/// How often a process that got the kill is polled until it is reaped.
const REAP_POLL: Duration = Duration::from_millis(100);
/// The bytes of FFmpeg's error output that a failure reports.
const STDERR_TAIL: usize = 4 * 1024;
/// The bytes of PCM of one read of a process.
const PCM_CHUNK: usize = 64 * 1024;
/// The buffer of the sequential read of an FLV.
const FLV_READ_BUFFER: usize = 1024 * 1024;
/// The read bytes between two reports of an FLV read.
const BYTES_READ_STEP: u64 = 1024 * 1024;
/// The text that FFmpeg writes at `-loglevel info` when a change of the audio format makes it
/// build the filter graph again, which adds silence (ADR 056 measurement 4).
const RECONFIGURE_TEXT: &[u8] = b"Reconfiguring filter graph";
/// The bytes of one read of the error output.
const STDERR_CHUNK: usize = 4 * 1024;

/// The page side of a job: a Tauri channel in the application, a recorder in the tests.
pub trait WaveformSink: Send + Sync {
    /// Send the codes of the buckets from `start`. Return false when the page is gone.
    fn buckets(&self, start: u64, codes: &[u8]) -> bool;
    /// Send a progress message. Return false when the page is gone.
    fn progress(&self, progress: &Progress) -> bool;
    /// Send the end message, after the last buckets.
    fn end(&self, message: &EndMessage);
}

/// A progress message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename = "progress", rename_all = "camelCase")]
pub struct Progress {
    /// The count of buckets from bucket 0 to the last bucket that has data.
    pub high_water: u64,
    /// The bytes of the file that Rust read, for an FLV.
    pub bytes_read: Option<u64>,
    /// The size of the file, for an FLV.
    pub total_bytes: Option<u64>,
}

/// How a job ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EndStatus {
    Complete,
    Canceled,
    Failed,
}

/// Why a job failed (ADR 011).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EndCode {
    SpawnFailed,
    ReadFailed,
    DecodeFailed,
    SourceChanged,
}

/// The last message of a job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename = "end", rename_all = "camelCase")]
pub struct EndMessage {
    pub status: EndStatus,
    pub code: Option<EndCode>,
    /// The untranslated diagnostic of a failure (ADR 011).
    pub detail: Option<String>,
    pub bucket_count: u64,
    pub cached: bool,
    pub timestamps_decrease: bool,
    pub damaged: bool,
    pub truncated: bool,
    pub alignment_uncertain: bool,
}

/// The bytes of a binary message: a little-endian `u32` start bucket, a little-endian `u32`
/// count, then two codes for each bucket. An envelope holds at most [`MAX_BUCKETS`], so both
/// values fit.
#[must_use]
pub fn encode_buckets(start: u64, codes: &[u8]) -> Vec<u8> {
    let count = (codes.len() / BYTES_PER_BUCKET) as u32;
    let mut bytes = Vec::with_capacity(8 + codes.len());
    bytes.extend_from_slice(&(start as u32).to_le_bytes());
    bytes.extend_from_slice(&count.to_le_bytes());
    bytes.extend_from_slice(&codes[..count as usize * BYTES_PER_BUCKET]);
    bytes
}

/// The most buckets of an envelope: the duration of the probe × 1.25 + 60 s, and at most
/// [`MAX_BUCKETS`]. A damaged timestamp therefore cannot allocate a large buffer.
#[must_use]
pub fn max_buckets(duration_seconds: Option<f64>) -> u64 {
    match duration_seconds.filter(|seconds| seconds.is_finite() && *seconds >= 0.0) {
        Some(seconds) => {
            let buckets = ((seconds * 1.25 + 60.0) * f64::from(BUCKET_RATE)).ceil();
            if buckets >= MAX_BUCKETS as f64 {
                MAX_BUCKETS
            } else {
                buckets as u64
            }
        }
        None => MAX_BUCKETS,
    }
}

/// What a job needs to run.
pub struct JobRequest {
    pub ffmpeg: PathBuf,
    pub path: PathBuf,
    /// True for an FLV, which Rust reads in runs.
    pub flv: bool,
    /// The absolute index of the audio stream that the probe chose.
    pub audio_stream_index: u32,
    /// `videoStartPts` in samples of the PCM, the time of bucket 0.
    pub origin: i64,
    pub duration_seconds: Option<f64>,
    pub total_bytes: u64,
    /// The application cache directory, or `None` when it is not known: the job then writes no
    /// cache.
    pub cache_root: Option<PathBuf>,
    pub cache_key: EnvelopeKey,
    /// True when the source still has the size and the modification time of the request. The
    /// source thread calls it, because it can wait for a share.
    pub still_same: Box<dyn Fn() -> bool + Send>,
}

/// Sends a cached envelope to the page, in messages of at most [`CACHED_MESSAGE_BUCKETS`], then
/// the end message.
pub fn send_cached(envelope: &CachedEnvelope, sink: &dyn WaveformSink) {
    let mut start = 0;
    for codes in envelope
        .buckets
        .chunks(CACHED_MESSAGE_BUCKETS * BYTES_PER_BUCKET)
    {
        if !sink.buckets(start, codes) {
            return;
        }
        start += (codes.len() / BYTES_PER_BUCKET) as u64;
    }
    sink.end(&EndMessage {
        status: EndStatus::Complete,
        code: None,
        detail: None,
        bucket_count: envelope.bucket_count() as u64,
        cached: true,
        timestamps_decrease: envelope.flags.timestamps_decrease,
        damaged: envelope.flags.damaged,
        truncated: envelope.flags.truncated,
        alignment_uncertain: false,
    });
}

enum SourceEvent {
    Buckets { start: u64, codes: Vec<u8> },
    BytesRead(u64),
    Done(SourceOutcome),
}

#[derive(Debug, Default)]
struct SourceOutcome {
    failure: Option<(EndCode, String)>,
    reconfigured: bool,
    timestamps_decrease: bool,
    damaged: bool,
    /// The size or the modification time of the source changed while the job read it.
    changed: bool,
}

impl SourceOutcome {
    fn failed(code: EndCode, detail: impl Into<String>) -> Self {
        Self {
            failure: Some((code, detail.into())),
            ..Self::default()
        }
    }
}

/// The envelope that the job thread builds.
struct Envelope {
    codes: Vec<u8>,
    high_water: u64,
    limit: u64,
    truncated: bool,
    dirty: Option<(u64, u64)>,
}

impl Envelope {
    fn new(limit: u64) -> Self {
        Self {
            codes: Vec::new(),
            high_water: 0,
            limit,
            truncated: false,
            dirty: None,
        }
    }

    fn write(&mut self, start: u64, codes: &[u8]) {
        let count = (codes.len() / BYTES_PER_BUCKET) as u64;
        let end = start.saturating_add(count).min(self.limit);
        if end < start.saturating_add(count) {
            self.truncated = true;
        }
        if end <= start {
            return;
        }
        let needed = end as usize * BYTES_PER_BUCKET;
        if self.codes.len() < needed {
            self.codes.resize(needed, 0);
        }
        let from = start as usize * BYTES_PER_BUCKET;
        self.codes[from..needed].copy_from_slice(&codes[..needed - from]);
        self.high_water = self.high_water.max(end);
        self.dirty = Some(match self.dirty {
            Some((low, high)) => (low.min(start), high.max(end)),
            None => (start, end),
        });
    }

    /// Sends the buckets that changed since the last flush. False when the page is gone.
    fn flush(&mut self, sink: &dyn WaveformSink) -> bool {
        let Some((low, high)) = self.dirty.take() else {
            return true;
        };
        sink.buckets(
            low,
            &self.codes[low as usize * BYTES_PER_BUCKET..high as usize * BYTES_PER_BUCKET],
        )
    }
}

/// Frees the slot of a job when the job ends, also after a panic.
struct Slot<'a> {
    jobs: &'a WaveformJobs,
    id: u64,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.jobs.finish(self.id);
    }
}

/// Runs the job on the calling thread until it ends, sends its end message, and frees its slot
/// in `jobs`.
pub fn run(
    jobs: &WaveformJobs,
    handle: Arc<JobHandle>,
    request: JobRequest,
    sink: Arc<dyn WaveformSink>,
) {
    let _slot = Slot {
        jobs,
        id: handle.id,
    };
    let message = run_job(&handle, request, sink.as_ref());
    sink.end(&message);
}

fn run_job(handle: &Arc<JobHandle>, request: JobRequest, sink: &dyn WaveformSink) -> EndMessage {
    let JobRequest {
        ffmpeg,
        path,
        flv,
        audio_stream_index,
        origin,
        duration_seconds,
        total_bytes,
        cache_root,
        cache_key,
        still_same,
    } = request;
    let (sender, receiver) = mpsc::channel();
    let source = {
        let handle = handle.clone();
        thread::Builder::new()
            .name("waveform-source".to_owned())
            .spawn(move || {
                let mut outcome = if flv {
                    read_flv(&ffmpeg, &path, origin, &handle, &sender)
                } else {
                    decode_file(&ffmpeg, &path, audio_stream_index, origin, &handle, &sender)
                };
                // The check of the source can wait for a share, so it runs here, where the
                // cancel wait of the job thread bounds it (ADR 050).
                if outcome.failure.is_none() && !handle.is_canceled() {
                    outcome.changed = !still_same();
                }
                let _ = sender.send(SourceEvent::Done(outcome));
            })
    };
    let source = match source {
        Ok(source) => source,
        Err(error) => {
            return end_message(
                EndStatus::Failed,
                Some((EndCode::SpawnFailed, error.to_string())),
                &Envelope::new(0),
                &SourceOutcome::default(),
                false,
            )
        }
    };

    let mut envelope = Envelope::new(max_buckets(duration_seconds));
    let mut outcome = None;
    let mut bytes_read = None;
    let mut cancel_deadline: Option<Instant> = None;
    let mut last_flush = Instant::now();
    let mut last_progress: Option<Instant> = None;
    loop {
        match receiver.recv_timeout(POLL) {
            Ok(SourceEvent::Buckets { start, codes }) => envelope.write(start, &codes),
            Ok(SourceEvent::BytesRead(count)) => bytes_read = Some(count),
            Ok(SourceEvent::Done(done)) => {
                outcome = Some(done);
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        let now = Instant::now();
        if handle.is_canceled() {
            // The page drops the data of a canceled job, so nothing more goes to it.
            if now >= *cancel_deadline.get_or_insert(now + CANCEL_WAIT) {
                break;
            }
            continue;
        }
        if now.duration_since(last_flush) >= FLUSH_INTERVAL {
            last_flush = now;
            if !envelope.flush(sink) {
                handle.signal();
                continue;
            }
        }
        if last_progress.is_none_or(|last| now.duration_since(last) >= PROGRESS_INTERVAL) {
            last_progress = Some(now);
            let progress = Progress {
                high_water: envelope.high_water,
                bytes_read,
                total_bytes: bytes_read.map(|_| total_bytes),
            };
            if !sink.progress(&progress) {
                handle.signal();
            }
        }
    }
    if outcome.is_some() {
        let _ = source.join();
    }

    let canceled = handle.is_canceled();
    let outcome = match outcome {
        Some(outcome) => outcome,
        None if canceled => SourceOutcome::default(),
        None => SourceOutcome::failed(EndCode::ReadFailed, "the reading thread stopped"),
    };
    if canceled {
        return end_message(EndStatus::Canceled, None, &envelope, &outcome, false);
    }
    if let Some(failure) = outcome.failure.clone() {
        return end_message(EndStatus::Failed, Some(failure), &envelope, &outcome, false);
    }
    if outcome.changed {
        let failure = (
            EndCode::SourceChanged,
            "the source changed while the job read it".to_owned(),
        );
        return end_message(EndStatus::Failed, Some(failure), &envelope, &outcome, false);
    }
    // A file that is not FLV and that is much longer than its probe gained silence at a change
    // of its audio format. An FLV is not checked so: a restart of its timestamps can make the
    // envelope longer than the duration of the probe.
    let too_long = !flv
        && duration_seconds.is_some_and(|seconds| {
            envelope.high_water as f64 > (seconds + 1.0) * f64::from(BUCKET_RATE)
        });
    let alignment_uncertain = outcome.reconfigured || too_long;
    if !envelope.flush(sink) {
        handle.signal();
        return end_message(EndStatus::Canceled, None, &envelope, &outcome, false);
    }
    // An envelope with no bucket, as from an FLV whose frames all wait for a configuration,
    // stays out of the cache, so a later request reads the file again.
    if !alignment_uncertain && envelope.high_water > 0 {
        if let Some(root) = &cache_root {
            let entry = CachedEnvelope {
                buckets: envelope.codes[..envelope.high_water as usize * BYTES_PER_BUCKET].to_vec(),
                flags: EnvelopeFlags {
                    timestamps_decrease: outcome.timestamps_decrease,
                    damaged: outcome.damaged,
                    truncated: envelope.truncated,
                },
            };
            if let Err(error) = cache::write(root, &cache_key, &entry) {
                eprintln!("waveform: the cache entry could not be written: {error}");
            }
        }
    }
    end_message(
        EndStatus::Complete,
        None,
        &envelope,
        &outcome,
        alignment_uncertain,
    )
}

fn end_message(
    status: EndStatus,
    failure: Option<(EndCode, String)>,
    envelope: &Envelope,
    outcome: &SourceOutcome,
    alignment_uncertain: bool,
) -> EndMessage {
    let (code, detail) = match failure {
        Some((code, detail)) => (Some(code), Some(detail)),
        None => (None, None),
    };
    EndMessage {
        status,
        code,
        detail,
        bucket_count: envelope.high_water,
        cached: false,
        timestamps_decrease: outcome.timestamps_decrease,
        damaged: outcome.damaged,
        truncated: envelope.truncated,
        alignment_uncertain,
    }
}

/// What a process wrote to its error output: the reconfigure line, and the last bytes.
#[derive(Debug, Default)]
struct StderrReport {
    reconfigured: bool,
    tail: Vec<u8>,
}

/// Reads the error output to its end in pieces of a fixed size, so a long line costs no memory
/// and a full pipe never blocks FFmpeg. The search for the reconfigure text keeps the end of
/// each piece, so the text is found also across two pieces.
fn read_stderr(mut stderr: impl Read) -> StderrReport {
    let mut report = StderrReport::default();
    let mut buffer = [0u8; STDERR_CHUNK];
    let mut window: Vec<u8> = Vec::with_capacity(STDERR_CHUNK + RECONFIGURE_TEXT.len());
    loop {
        let count = match stderr.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let piece = &buffer[..count];
        window.extend_from_slice(piece);
        if !report.reconfigured
            && window
                .windows(RECONFIGURE_TEXT.len())
                .any(|candidate| candidate == RECONFIGURE_TEXT)
        {
            report.reconfigured = true;
        }
        let keep = window.len().min(RECONFIGURE_TEXT.len() - 1);
        window.drain(..window.len() - keep);
        report.tail.extend_from_slice(piece);
        if report.tail.len() > STDERR_TAIL {
            let excess = report.tail.len() - STDERR_TAIL;
            report.tail.drain(..excess);
        }
    }
    report
}

/// A process of the job, with the threads that read its outputs.
struct Process {
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
    drain: thread::JoinHandle<()>,
    stderr: thread::JoinHandle<StderrReport>,
}

fn spawn(
    ffmpeg: &Path,
    arguments: &[String],
    piped_stdin: bool,
    base_bucket: u64,
    handle: &JobHandle,
    sender: &Sender<SourceEvent>,
) -> io::Result<Process> {
    let mut child = command_without_console(ffmpeg)
        .args(arguments)
        .stdin(if piped_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout was requested as piped");
    let stderr = child.stderr.take().expect("stderr was requested as piped");
    let child = Arc::new(Mutex::new(child));
    handle.adopt(child.clone());
    let sender = sender.clone();
    let threads = thread::Builder::new()
        .name("waveform-stderr".to_owned())
        .spawn(move || read_stderr(stderr))
        .and_then(|stderr| {
            thread::Builder::new()
                .name("waveform-pcm".to_owned())
                .spawn(move || drain_pcm(stdout, base_bucket, &sender))
                .map(|drain| (drain, stderr))
        });
    match threads {
        Ok((drain, stderr)) => Ok(Process {
            child,
            stdin,
            drain,
            stderr,
        }),
        Err(error) => {
            // No thread reads the outputs, so the process must not run on.
            {
                let mut child = child
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let _ = child.kill();
                let _ = child.wait();
            }
            handle.release(&child);
            Err(error)
        }
    }
}

/// Folds the PCM of a process and sends its buckets from `base_bucket`.
fn drain_pcm(mut stdout: ChildStdout, base_bucket: u64, sender: &Sender<SourceEvent>) {
    let mut folder = EnvelopeFolder::new();
    let mut buffer = vec![0u8; PCM_CHUNK];
    let mut next = base_bucket;
    let send = |codes: Vec<u8>, next: &mut u64| {
        if codes.is_empty() {
            return true;
        }
        let start = *next;
        *next += (codes.len() / BYTES_PER_BUCKET) as u64;
        sender.send(SourceEvent::Buckets { start, codes }).is_ok()
    };
    loop {
        let count = match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let mut codes = Vec::new();
        folder.push(&buffer[..count], &mut codes);
        if !send(codes, &mut next) {
            return;
        }
    }
    let mut codes = Vec::new();
    folder.finish(&mut codes);
    send(codes, &mut next);
}

/// Closes the stdin of `process`, waits for its outputs and its exit, and gives the failure of
/// a process that the job did not cancel.
fn finish(process: Process, handle: &JobHandle) -> SourceOutcome {
    let Process {
        child,
        stdin,
        drain,
        stderr,
    } = process;
    drop(stdin);
    let _ = drain.join();
    // Short polls, not a blocking wait: the handle locks the child to kill it. A process that
    // does not exit in time gets the kill and is polled until it is reaped, so it leaves no
    // zombie. Its job fails; the cancel flag of the job stays as it is.
    let deadline = Instant::now() + EXIT_WAIT;
    let mut killed = false;
    let status = loop {
        let polled = child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .try_wait();
        match polled {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(EXIT_POLL),
            Ok(None) if !killed => {
                let _ = child
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .kill();
                killed = true;
            }
            Ok(None) => thread::sleep(REAP_POLL),
            Err(_) => break None,
        }
    };
    handle.release(&child);
    let report = stderr.join().unwrap_or_default();
    if handle.is_canceled() {
        return SourceOutcome {
            reconfigured: report.reconfigured,
            ..SourceOutcome::default()
        };
    }
    if killed {
        return SourceOutcome {
            reconfigured: report.reconfigured,
            ..SourceOutcome::failed(
                EndCode::DecodeFailed,
                "ffmpeg did not exit after its output ended",
            )
        };
    }
    if status.is_some_and(|status| status.success()) {
        return SourceOutcome {
            reconfigured: report.reconfigured,
            ..SourceOutcome::default()
        };
    }
    let text = String::from_utf8_lossy(&report.tail).trim().to_owned();
    SourceOutcome {
        reconfigured: report.reconfigured,
        ..SourceOutcome::failed(
            EndCode::DecodeFailed,
            if text.is_empty() {
                format!("ffmpeg ended with {status:?}")
            } else {
                text
            },
        )
    }
}

/// The form of every container but FLV: FFmpeg reads the file itself.
fn decode_file(
    ffmpeg: &Path,
    path: &Path,
    audio_stream_index: u32,
    origin: i64,
    handle: &JobHandle,
    sender: &Sender<SourceEvent>,
) -> SourceOutcome {
    let arguments = file_arguments(path, audio_stream_index, origin);
    match spawn(ffmpeg, &arguments, false, 0, handle, sender) {
        Ok(process) => finish(process, handle),
        Err(error) => SourceOutcome::failed(EndCode::SpawnFailed, error.to_string()),
    }
}

/// A reader that counts its bytes from an offset.
struct Counting<R> {
    inner: R,
    count: u64,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(buf)?;
        self.count += count as u64;
        Ok(count)
    }
}

type FlvStream = TagStream<BufReader<Counting<File>>>;

fn open_stream(path: &Path, offset: u64) -> io::Result<FlvStream> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    Ok(TagStream::new(
        BufReader::with_capacity(
            FLV_READ_BUFFER,
            Counting {
                inner: file,
                count: offset,
            },
        ),
        offset,
    ))
}

/// The FLV form: Rust reads the tags in order and sends the audio tags to one process for each
/// run (ADR 056).
fn read_flv(
    ffmpeg: &Path,
    path: &Path,
    origin: i64,
    handle: &JobHandle,
    sender: &Sender<SourceEvent>,
) -> SourceOutcome {
    let first_tag = match first_tag_offset(path) {
        Ok(offset) => offset,
        Err(error) => return SourceOutcome::failed(EndCode::ReadFailed, error.to_string()),
    };
    let mut stream = match open_stream(path, first_tag) {
        Ok(stream) => stream,
        Err(error) => return SourceOutcome::failed(EndCode::ReadFailed, error.to_string()),
    };
    let mut runs = AudioRuns::new(origin);
    let mut current: Option<Process> = None;
    let mut outcome = SourceOutcome::default();
    let mut buf = Vec::new();
    let mut reported = 0;
    let end_run = |current: &mut Option<Process>, outcome: &mut SourceOutcome| {
        if let Some(process) = current.take() {
            let finished = finish(process, handle);
            outcome.reconfigured |= finished.reconfigured;
            if outcome.failure.is_none() {
                outcome.failure = finished.failure;
            }
        }
        outcome.failure.is_none()
    };
    loop {
        if handle.is_canceled() {
            break;
        }
        let read = stream.reader().get_ref().count;
        if read >= reported + BYTES_READ_STEP {
            reported = read;
            let _ = sender.send(SourceEvent::BytesRead(read));
        }
        let tag = match stream.next_tag(&mut buf) {
            Ok(Some(tag)) => tag,
            Ok(None) => break,
            // A recording that was killed ends inside its last tag.
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                match resync_after(path, stream.offset(), handle) {
                    Ok(Some(offset)) => match open_stream(path, offset) {
                        Ok(next) => {
                            stream = next;
                            continue;
                        }
                        Err(error) => {
                            outcome.failure = Some((EndCode::ReadFailed, error.to_string()));
                            break;
                        }
                    },
                    Ok(None) => {
                        outcome.damaged = true;
                        break;
                    }
                    Err(error) if is_canceled(&error) => break,
                    Err(error) => {
                        outcome.failure = Some((EndCode::ReadFailed, error.to_string()));
                        break;
                    }
                }
            }
            Err(error) => {
                outcome.failure = Some((EndCode::ReadFailed, error.to_string()));
                break;
            }
        };
        match runs.push(&tag, &buf) {
            TagAction::Skip => {}
            TagAction::EndRun => {
                if !end_run(&mut current, &mut outcome) {
                    break;
                }
            }
            TagAction::Feed => {
                if !feed(&mut current, &buf) && !stopped_feeding(&mut current, &mut outcome, handle)
                {
                    break;
                }
            }
            TagAction::StartRun(start) => {
                if !end_run(&mut current, &mut outcome) {
                    break;
                }
                match start_run(ffmpeg, &start, handle, sender) {
                    Ok(process) => current = Some(process),
                    Err(error) => {
                        outcome.failure = Some((EndCode::SpawnFailed, error.to_string()));
                        break;
                    }
                }
                if !feed(&mut current, &buf) && !stopped_feeding(&mut current, &mut outcome, handle)
                {
                    break;
                }
            }
        }
    }
    end_run(&mut current, &mut outcome);
    outcome.timestamps_decrease = runs.timestamps_decrease();
    let _ = sender.send(SourceEvent::BytesRead(stream.reader().get_ref().count));
    outcome
}

fn first_tag_offset(path: &Path) -> io::Result<u64> {
    let mut header = [0u8; FILE_HEADER_LEN];
    File::open(path)?.read_exact(&mut header)?;
    parse_file_header(&header)
        .map(|header| header.first_tag_offset())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "not an FLV file"))
}

/// The offset of the first proven tag after the damaged tag at `offset`, as the preview searches
/// (ADR 046).
fn resync_after(path: &Path, offset: u64, handle: &JobHandle) -> io::Result<Option<u64>> {
    let mut source = FileSource::open(path, Some(handle.cancel_flag()))?;
    let from = offset + 1;
    Ok(resync(&mut source, from, from.saturating_add(RESYNC_REACH))?.map(|tag| tag.offset))
}

fn start_run(
    ffmpeg: &Path,
    start: &RunStart,
    handle: &JobHandle,
    sender: &Sender<SourceEvent>,
) -> io::Result<Process> {
    let arguments = flv_run_arguments(start.first_pts);
    let mut process = spawn(ffmpeg, &arguments, true, start.start_bucket, handle, sender)?;
    let written = process
        .stdin
        .as_mut()
        .is_some_and(|stdin| stdin.write_all(&start.head).is_ok());
    if !written {
        // The process stopped at once. The next feed fails, and the end of the process gives
        // the reason.
        process.stdin = None;
    }
    Ok(process)
}

/// Writes one tag to the process of the current run. False when the process stopped reading.
fn feed(current: &mut Option<Process>, bytes: &[u8]) -> bool {
    let Some(stdin) = current.as_mut().and_then(|process| process.stdin.as_mut()) else {
        return false;
    };
    stdin.write_all(bytes).is_ok()
}

/// The process of the current run stopped reading its input. Its end gives the reason, or the
/// job fails with a decode failure. Returns false: the read stops.
fn stopped_feeding(
    current: &mut Option<Process>,
    outcome: &mut SourceOutcome,
    handle: &JobHandle,
) -> bool {
    if let Some(process) = current.take() {
        let finished = finish(process, handle);
        outcome.reconfigured |= finished.reconfigured;
        outcome.failure = finished.failure.or_else(|| {
            (!handle.is_canceled()).then(|| {
                (
                    EndCode::DecodeFailed,
                    "ffmpeg stopped reading its input".to_owned(),
                )
            })
        });
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::cache::Revision;
    use crate::flv::test_support::TestDirectory;
    use crate::time::{Pts, Rational};
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct Recorder {
        buckets: Mutex<Vec<u8>>,
        messages: Mutex<usize>,
        progress: Mutex<Vec<Progress>>,
        end: Mutex<Option<EndMessage>>,
        refuse_progress: AtomicBool,
    }

    impl WaveformSink for Recorder {
        fn buckets(&self, start: u64, codes: &[u8]) -> bool {
            let mut buckets = self.buckets.lock().unwrap();
            let from = start as usize * BYTES_PER_BUCKET;
            if buckets.len() < from + codes.len() {
                buckets.resize(from + codes.len(), 0);
            }
            buckets[from..from + codes.len()].copy_from_slice(codes);
            *self.messages.lock().unwrap() += 1;
            true
        }

        fn progress(&self, progress: &Progress) -> bool {
            self.progress.lock().unwrap().push(progress.clone());
            !self.refuse_progress.load(Ordering::SeqCst)
        }

        fn end(&self, message: &EndMessage) {
            *self.end.lock().unwrap() = Some(message.clone());
        }
    }

    impl Recorder {
        fn end(&self) -> EndMessage {
            self.end.lock().unwrap().clone().expect("the job ended")
        }

        /// The peak code of each bucket.
        fn peaks(&self) -> Vec<u8> {
            self.buckets
                .lock()
                .unwrap()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|bucket| bucket[0])
                .collect()
        }
    }

    /// The ffmpeg of this machine, or `None`, in which case the test does nothing.
    fn ffmpeg() -> Option<PathBuf> {
        let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        directories.push(PathBuf::from("/opt/homebrew/bin"));
        directories.push(PathBuf::from("/usr/local/bin"));
        let name = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        directories
            .into_iter()
            .map(|directory| directory.join(name))
            .find(|candidate| candidate.is_file())
    }

    /// Audio of `seconds` with a 1 kHz burst of 50 ms at the start of each second, at `rate`.
    fn bursts(ffmpeg: &Path, path: &Path, seconds: u32, rate: u32, format: &str) {
        let source = format!(
            "aevalsrc=if(lt(mod(t\\,1)\\,0.05)\\,0.8*sin(2*PI*1000*t)\\,0):s={rate}:d={seconds}"
        );
        let status = command_without_console(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"])
            .args(["-i", &source, "-c:a", "aac", "-f", format])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn key(path: &Path) -> EnvelopeKey {
        EnvelopeKey {
            revision: Revision {
                path: path.to_string_lossy().into_owned(),
                size: 1,
                mtime: 1,
            },
            audio_stream_index: 0,
            origin_pts: Pts::new(0),
            time_base: Rational::new(1, 1000).unwrap(),
        }
    }

    fn request(ffmpeg: &Path, path: &Path, flv: bool, cache_root: &Path) -> JobRequest {
        JobRequest {
            ffmpeg: ffmpeg.to_owned(),
            path: path.to_owned(),
            flv,
            audio_stream_index: 0,
            origin: 0,
            duration_seconds: None,
            total_bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            cache_root: Some(cache_root.to_owned()),
            cache_key: key(path),
            still_same: Box::new(|| true),
        }
    }

    fn run_to_end(request: JobRequest) -> (Arc<Recorder>, WaveformJobs) {
        let jobs = WaveformJobs::default();
        let handle = jobs.begin(1).unwrap();
        let recorder = Arc::new(Recorder::default());
        run(&jobs, handle, request, recorder.clone());
        (recorder, jobs)
    }

    /// The bucket of the start of each burst.
    fn onsets(peaks: &[u8]) -> Vec<usize> {
        let mut found = Vec::new();
        let mut quiet = true;
        for (bucket, peak) in peaks.iter().enumerate() {
            if *peak >= 200 && quiet {
                found.push(bucket);
                quiet = false;
            } else if *peak < 150 {
                quiet = true;
            }
        }
        found
    }

    #[test]
    fn the_message_holds_the_start_the_count_and_the_codes() {
        assert_eq!(
            encode_buckets(258, &[1, 2, 3, 4]),
            vec![2, 1, 0, 0, 2, 0, 0, 0, 1, 2, 3, 4]
        );
    }

    #[test]
    fn the_limit_follows_the_duration() {
        assert_eq!(max_buckets(None), MAX_BUCKETS);
        assert_eq!(max_buckets(Some(f64::NAN)), MAX_BUCKETS);
        assert_eq!(max_buckets(Some(100.0)), 18_500);
        assert_eq!(max_buckets(Some(1.0e12)), MAX_BUCKETS);
    }

    #[test]
    fn the_envelope_keeps_overlapping_writes_and_its_limit() {
        let mut envelope = Envelope::new(10);
        envelope.write(2, &[1, 1, 2, 2]);
        envelope.write(0, &[3, 3, 4, 4, 5, 5]);
        assert_eq!(envelope.codes, vec![3, 3, 4, 4, 5, 5, 2, 2]);
        assert_eq!(envelope.high_water, 4);
        assert_eq!(envelope.dirty, Some((0, 4)));
        envelope.write(8, &[6, 6, 7, 7, 8, 8]);
        assert!(envelope.truncated);
        assert_eq!(envelope.high_water, 10);
        assert_eq!(&envelope.codes[16..], &[6, 6, 7, 7]);
    }

    #[test]
    fn a_cached_envelope_goes_in_bounded_messages() {
        let recorder = Recorder::default();
        let envelope = CachedEnvelope {
            buckets: vec![9; (CACHED_MESSAGE_BUCKETS + 10) * 2],
            flags: EnvelopeFlags {
                timestamps_decrease: false,
                damaged: true,
                truncated: false,
            },
        };
        send_cached(&envelope, &recorder);
        assert_eq!(*recorder.messages.lock().unwrap(), 2);
        assert_eq!(
            recorder.buckets.lock().unwrap().len(),
            envelope.buckets.len()
        );
        let end = recorder.end();
        assert_eq!(end.status, EndStatus::Complete);
        assert!(end.cached && end.damaged);
        assert_eq!(end.bucket_count, CACHED_MESSAGE_BUCKETS as u64 + 10);
    }

    #[test]
    fn the_messages_serialize_with_their_type() {
        let progress = serde_json::to_value(Progress {
            high_water: 5,
            bytes_read: None,
            total_bytes: None,
        })
        .unwrap();
        assert_eq!(
            progress,
            serde_json::json!({"type": "progress", "highWater": 5, "bytesRead": null, "totalBytes": null})
        );
        let end = serde_json::to_value(EndMessage {
            status: EndStatus::Failed,
            code: Some(EndCode::SourceChanged),
            detail: Some("x".to_owned()),
            bucket_count: 3,
            cached: false,
            timestamps_decrease: false,
            damaged: false,
            truncated: false,
            alignment_uncertain: true,
        })
        .unwrap();
        assert_eq!(end["type"], "end");
        assert_eq!(end["status"], "failed");
        assert_eq!(end["code"], "sourceChanged");
        assert_eq!(end["bucketCount"], 3);
        assert_eq!(end["alignmentUncertain"], true);
    }

    #[test]
    fn the_stderr_report_finds_the_reconfigure_line_and_keeps_the_tail() {
        // The text crosses the boundary of the first two pieces, after a long line.
        let mut text = vec![b'm'; STDERR_CHUNK - 10];
        text.extend_from_slice(
            b"[af#0:0] Reconfiguring filter graph because audio parameters changed\n",
        );
        text.extend(std::iter::repeat_n(b'x', STDERR_TAIL));
        text.extend_from_slice(b"\nlast line\n");
        let report = read_stderr(&text[..]);
        assert!(report.reconfigured);
        assert_eq!(report.tail.len(), STDERR_TAIL);
        assert!(report.tail.ends_with(b"last line\n"));
        assert!(!read_stderr(&b"Input #0\nOutput #0\n"[..]).reconfigured);
    }

    #[test]
    fn a_file_folds_into_aligned_buckets_and_goes_into_the_cache() {
        let Some(ffmpeg) = ffmpeg() else { return };
        let dir = TestDirectory::new();
        let path = dir.path.join("bursts.mka");
        bursts(&ffmpeg, &path, 5, 48_000, "matroska");
        let mut request = request(&ffmpeg, &path, false, &dir.path);
        request.duration_seconds = Some(5.0);
        let (recorder, jobs) = run_to_end(request);
        let end = recorder.end();
        assert_eq!(end.status, EndStatus::Complete, "{end:?}");
        assert!(!end.alignment_uncertain && !end.cached);
        assert!(
            (499..=502).contains(&end.bucket_count),
            "{}",
            end.bucket_count
        );
        assert_eq!(onsets(&recorder.peaks()), vec![0, 100, 200, 300, 400]);
        assert_eq!(jobs.running(), None);
        let cached = cache::read(&dir.path, &key(&path)).expect("the job wrote the cache");
        assert_eq!(cached.buckets, *recorder.buckets.lock().unwrap());
    }

    #[test]
    fn an_flv_folds_in_runs_and_marks_a_restart() {
        let Some(ffmpeg) = ffmpeg() else { return };
        let dir = TestDirectory::new();
        let first = dir.path.join("first.flv");
        let second = dir.path.join("second.flv");
        bursts(&ffmpeg, &first, 12, 48_000, "flv");
        bursts(&ffmpeg, &second, 3, 44_100, "flv");
        // The second recording follows the first in one file, with timestamps from 0 again and
        // another sample rate, as after a reconnect.
        let mut joined = std::fs::read(&first).unwrap();
        let second_bytes = std::fs::read(&second).unwrap();
        let skip = parse_file_header(&second_bytes).unwrap().first_tag_offset() as usize;
        joined.extend_from_slice(&second_bytes[skip..]);
        let path = dir.path.join("joined.flv");
        std::fs::write(&path, joined).unwrap();
        let (recorder, _) = run_to_end(request(&ffmpeg, &path, true, &dir.path));
        let end = recorder.end();
        assert_eq!(end.status, EndStatus::Complete, "{end:?}");
        assert!(end.timestamps_decrease);
        assert!(!end.alignment_uncertain);
        // The second run replaced the first three seconds, and each burst keeps its place
        // within the delay of the encoder.
        let found = onsets(&recorder.peaks());
        assert!(found.len() >= 12, "{found:?}");
        for (second, onset) in found.iter().take(12).enumerate() {
            let offset = *onset as i64 - second as i64 * 100;
            assert!((0..=8).contains(&offset), "{found:?}");
        }
        let progress = recorder.progress.lock().unwrap();
        assert!(progress
            .iter()
            .all(|p| p.total_bytes.is_some() || p.bytes_read.is_none()));
    }

    #[test]
    fn a_page_that_is_gone_cancels_the_job() {
        let Some(ffmpeg) = ffmpeg() else { return };
        let dir = TestDirectory::new();
        let path = dir.path.join("bursts.mka");
        bursts(&ffmpeg, &path, 5, 48_000, "matroska");
        let jobs = WaveformJobs::default();
        let handle = jobs.begin(1).unwrap();
        let recorder = Arc::new(Recorder::default());
        recorder.refuse_progress.store(true, Ordering::SeqCst);
        run(
            &jobs,
            handle,
            request(&ffmpeg, &path, false, &dir.path),
            recorder.clone(),
        );
        assert_eq!(recorder.end().status, EndStatus::Canceled);
        assert!(cache::read(&dir.path, &key(&path)).is_none());
        assert_eq!(jobs.running(), None);
    }

    #[test]
    fn a_source_that_changed_fails_and_writes_no_cache() {
        let Some(ffmpeg) = ffmpeg() else { return };
        let dir = TestDirectory::new();
        let path = dir.path.join("bursts.mka");
        bursts(&ffmpeg, &path, 2, 48_000, "matroska");
        let mut request = request(&ffmpeg, &path, false, &dir.path);
        request.still_same = Box::new(|| false);
        let (recorder, _) = run_to_end(request);
        let end = recorder.end();
        assert_eq!(end.status, EndStatus::Failed);
        assert_eq!(end.code, Some(EndCode::SourceChanged));
        assert!(cache::read(&dir.path, &key(&path)).is_none());
    }

    #[test]
    fn a_missing_ffmpeg_fails_to_spawn() {
        let dir = TestDirectory::new();
        let path = dir.path.join("missing.mka");
        std::fs::write(&path, b"x").unwrap();
        let missing = dir.path.join("no-ffmpeg-here");
        let (recorder, jobs) = run_to_end(request(&missing, &path, false, &dir.path));
        let end = recorder.end();
        assert_eq!(end.status, EndStatus::Failed);
        assert_eq!(end.code, Some(EndCode::SpawnFailed));
        assert_eq!(jobs.running(), None);
    }

    #[test]
    fn a_file_that_ffmpeg_cannot_read_fails_to_decode() {
        let Some(ffmpeg) = ffmpeg() else { return };
        let dir = TestDirectory::new();
        let path = dir.path.join("garbage.mka");
        std::fs::write(&path, vec![7u8; 4096]).unwrap();
        let (recorder, _) = run_to_end(request(&ffmpeg, &path, false, &dir.path));
        let end = recorder.end();
        assert_eq!(end.status, EndStatus::Failed);
        assert_eq!(end.code, Some(EndCode::DecodeFailed));
        assert!(end.detail.is_some_and(|detail| !detail.is_empty()));
    }

    /// The offsets of the tags of an FLV.
    fn tag_offsets(bytes: &[u8]) -> Vec<usize> {
        let first = parse_file_header(bytes).unwrap().first_tag_offset() as usize;
        let mut stream = TagStream::new(&bytes[first..], first as u64);
        let mut buf = Vec::new();
        let mut offsets = Vec::new();
        while let Some(tag) = stream.next_tag(&mut buf).unwrap() {
            offsets.push(tag.offset as usize);
        }
        offsets
    }

    #[test]
    fn a_damaged_tag_is_skipped_and_a_cut_end_completes() {
        let Some(ffmpeg) = ffmpeg() else { return };
        let dir = TestDirectory::new();
        let clean = dir.path.join("clean.flv");
        bursts(&ffmpeg, &clean, 4, 48_000, "flv");
        let bytes = std::fs::read(&clean).unwrap();
        let offsets = tag_offsets(&bytes);
        let middle = offsets[offsets.len() / 2];

        // Garbage between two tags: the read finds the next tag and goes on.
        let mut damaged = bytes[..middle].to_vec();
        damaged.extend(std::iter::repeat_n(0xEE, 300));
        damaged.extend_from_slice(&bytes[middle..]);
        let path = dir.path.join("damaged.flv");
        std::fs::write(&path, damaged).unwrap();
        let (recorder, _) = run_to_end(request(&ffmpeg, &path, true, &dir.path));
        let end = recorder.end();
        assert_eq!(end.status, EndStatus::Complete, "{end:?}");
        assert!(!end.damaged);
        assert!(end.bucket_count >= 390, "{}", end.bucket_count);

        // Garbage at the end with no tag after it: the envelope ends there, flagged.
        let mut tail = bytes.clone();
        tail.extend(std::iter::repeat_n(0xEE, 300));
        let path = dir.path.join("tail.flv");
        std::fs::write(&path, tail).unwrap();
        let (recorder, _) = run_to_end(request(&ffmpeg, &path, true, &dir.path));
        let end = recorder.end();
        assert_eq!(end.status, EndStatus::Complete, "{end:?}");
        assert!(end.damaged);

        // A recording that was killed ends inside its last tag.
        let last = *offsets.last().unwrap();
        let path = dir.path.join("cut.flv");
        std::fs::write(&path, &bytes[..last + 20]).unwrap();
        let (recorder, _) = run_to_end(request(&ffmpeg, &path, true, &dir.path));
        let end = recorder.end();
        assert_eq!(end.status, EndStatus::Complete, "{end:?}");
        assert!(!end.damaged);
    }

    #[cfg(unix)]
    #[test]
    fn a_cancel_ends_a_job_whose_read_never_returns() {
        // The source thread blocks in the open of a FIFO that has no writer, as a read of a share
        // that stopped answering does.
        let dir = TestDirectory::new();
        let fifo = dir.path.join("blocked.flv");
        let made = command_without_console("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(made.success());
        let jobs = Arc::new(WaveformJobs::default());
        let handle = jobs.begin(1).unwrap();
        let id = handle.id;
        let recorder = Arc::new(Recorder::default());
        let job = {
            let jobs = jobs.clone();
            let recorder = recorder.clone();
            let request = request(Path::new("ffmpeg"), &fifo, true, &dir.path);
            thread::spawn(move || run(&jobs, handle, request, recorder))
        };
        thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        jobs.cancel(id);
        job.join().unwrap();
        assert!(started.elapsed() < CANCEL_WAIT + Duration::from_secs(1));
        assert_eq!(recorder.end().status, EndStatus::Canceled);
        assert_eq!(jobs.running(), None);
        // Open the FIFO for writing, so the blocked open returns and its thread ends.
        drop(std::fs::OpenOptions::new().write(true).open(&fifo));
    }

    #[cfg(unix)]
    #[test]
    fn a_cancel_ends_a_job_whose_process_never_writes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TestDirectory::new();
        let fake = dir.path.join("fake-ffmpeg");
        std::fs::write(&fake, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = dir.path.join("source.mka");
        std::fs::write(&path, b"x").unwrap();
        let jobs = Arc::new(WaveformJobs::default());
        let handle = jobs.begin(1).unwrap();
        let id = handle.id;
        let recorder = Arc::new(Recorder::default());
        let job = {
            let jobs = jobs.clone();
            let recorder = recorder.clone();
            let request = request(&fake, &path, false, &dir.path);
            thread::spawn(move || run(&jobs, handle, request, recorder))
        };
        thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        jobs.cancel(id);
        job.join().unwrap();
        assert!(started.elapsed() < CANCEL_WAIT + Duration::from_secs(1));
        assert_eq!(recorder.end().status, EndStatus::Canceled);
        assert_eq!(jobs.running(), None);
    }
}
