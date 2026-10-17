//! Running a remux window: the processes, the stdin writer of an FLV window, and the readers that
//! send the output to the page (ADR 046).
//!
//! An FLV window reads the source once. The writer copies the head and then tag after tag into
//! the stdin of the remux process and, when the scrub cue needs it, into the stdin of the PCM
//! process. It records the keyframes and configurations that it passes, and it ends the slice
//! itself: in front of the first keyframe after the time or byte limit, and in front of a tag
//! whose timestamp decreases, so the mp4 muxer never sees a restart. The reader of the remux
//! output waits for the credit of the page, so a page that does not append stops the whole
//! chain down to the reads of the share.

use super::registry::{WindowHandle, CREDIT_LIMIT};
use crate::ffmpeg::capabilities::smoke::read_capped_tail;
use crate::flv::locate::DECREASE_LIMIT_MS;
use crate::flv::scan::TagStream;
use crate::flv::table::{ConfigTag, KeyframeEntry};
use crate::flv::tag::{TagKind, TagRole};
use crate::flv::FlvSource;
use crate::procutil::command_without_console;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// The largest piece of output that one message carries.
const CHUNK_LEN: usize = 256 * 1024;
/// The bytes of stderr that a failed window reports.
const STDERR_TAIL: usize = 4 * 1024;
/// How long a reader waits for a process to exit after its stdout closed, and for the writer to
/// report, before it reports what it knows.
const EXIT_WAIT: Duration = Duration::from_secs(5);
const EXIT_POLL: Duration = Duration::from_millis(10);

/// The page side of a window: a Tauri channel in the application, a recorder in the tests.
pub trait WindowSink: Send + Sync {
    /// Send one piece of output. Return false when the page is gone.
    fn chunk(&self, bytes: Vec<u8>) -> bool;
    /// Send the end message, after the last piece.
    fn end(&self, message: &EndMessage);
}

/// How a window ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EndStatus {
    Complete,
    Canceled,
    Failed,
}

/// The keyframe tag where the next window of an FLV starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePoint {
    pub offset: u64,
    pub pts_ms: i64,
}

/// The last message of a window.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndMessage {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub status: EndStatus,
    /// True when an FLV window reached the end of the file. A seek-form window leaves it false:
    /// the page sees its end in the buffered data.
    pub reached_end: bool,
    /// Where the next window starts: the keyframe tag at the limit of this window, or, after a
    /// restart of the timestamps or a damaged tag, the place where this window stopped, from
    /// which the next request walks to the next keyframe. A complete window with
    /// neither `next` nor `reached_end` is one whose writer did not report within the wait of
    /// its reader, as when a read of a share stalls. The page then resumes by time from the
    /// last fragment that it appended, and never takes it as the end of the file.
    pub next: Option<ResumePoint>,
    /// The bytes that Rust read from the source for this window.
    pub bytes_read: u64,
    /// True when the window stopped in front of a timestamp that decreases. `next` then points
    /// at the restart.
    pub non_monotonic: bool,
    /// True when the window stopped at a damaged tag. `next` then points just past the start of
    /// the damage, where a resync begins.
    pub damaged: bool,
    /// The end of the stderr of a failed process.
    pub detail: Option<String>,
}

impl EndMessage {
    fn new(status: EndStatus) -> Self {
        Self {
            kind: "end",
            status,
            reached_end: false,
            next: None,
            bytes_read: 0,
            non_monotonic: false,
            damaged: false,
            detail: None,
        }
    }
}

/// The FLV part of a window: where it starts and where it must stop.
pub struct FlvSlice {
    pub source: Arc<FlvSource>,
    pub head: Vec<u8>,
    pub start_offset: u64,
    pub start_dts: i64,
    pub limit_ms: i64,
    pub limit_bytes: u64,
}

/// What the stdin writer found.
#[derive(Debug, Clone, Default, PartialEq)]
struct WriterOutcome {
    reached_end: bool,
    next: Option<ResumePoint>,
    bytes_read: u64,
    non_monotonic: bool,
    damaged: bool,
    /// A read of the source that failed, as on a share that stopped answering. It is not
    /// damage: a later window can read the same bytes.
    read_error: Option<String>,
}

/// Runs an action once, after each of a number of parts reported that it ended.
struct Finisher {
    remaining: std::sync::atomic::AtomicUsize,
    action: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Finisher {
    fn new(parts: usize, action: Box<dyn FnOnce() + Send>) -> Arc<Self> {
        Arc::new(Self {
            remaining: std::sync::atomic::AtomicUsize::new(parts),
            action: Mutex::new(Some(action)),
        })
    }

    fn part_done(&self) {
        if self.remaining.fetch_sub(1, Ordering::SeqCst) == 1 {
            let action = self
                .action
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            if let Some(action) = action {
                action();
            }
        }
    }
}

struct Spawned {
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
    stdout: std::process::ChildStdout,
    stderr: thread::JoinHandle<Vec<u8>>,
}

fn spawn(ffmpeg: &Path, arguments: &[String], piped_stdin: bool) -> io::Result<Spawned> {
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
    let stderr = thread::spawn(move || read_capped_tail(stderr, STDERR_TAIL));
    Ok(Spawned {
        child: Arc::new(Mutex::new(child)),
        stdin,
        stdout,
        stderr,
    })
}

/// Start an FLV window. The remux process takes `remux_arguments`, and the PCM process, when
/// `pcm` is given, takes its arguments and sends to its own sink. `release` runs after the end
/// message of the remux output, and `on_finish` runs once, after the writer and both processes
/// ended.
#[allow(clippy::too_many_arguments)]
pub fn start_flv_window(
    ffmpeg: &Path,
    slice: FlvSlice,
    remux_arguments: &[String],
    pcm: Option<(Vec<String>, Arc<dyn WindowSink>)>,
    handle: Arc<WindowHandle>,
    sink: Arc<dyn WindowSink>,
    release: Box<dyn FnOnce() + Send>,
    on_finish: Box<dyn FnOnce() + Send>,
) -> io::Result<()> {
    let mut remux = spawn(ffmpeg, remux_arguments, true)?;
    handle.adopt(remux.child.clone());
    let video_stdin = remux.stdin.take().expect("stdin was requested as piped");

    // A PCM process that does not start only disables the cue.
    let pcm = pcm.and_then(
        |(arguments, pcm_sink)| match spawn(ffmpeg, &arguments, true) {
            Ok(mut spawned) => {
                handle.adopt(spawned.child.clone());
                let stdin = spawned.stdin.take();
                Some((spawned, stdin, pcm_sink))
            }
            Err(error) => {
                let mut message = EndMessage::new(EndStatus::Failed);
                message.detail = Some(error.to_string());
                pcm_sink.end(&message);
                None
            }
        },
    );
    let (pcm_reader, pcm_stdin) = match pcm {
        Some((spawned, stdin, pcm_sink)) => (Some((spawned, pcm_sink)), stdin),
        None => (None, None),
    };
    // The writer, the remux reader and the PCM reader each report their end.
    let finisher = Finisher::new(2 + usize::from(pcm_reader.is_some()), on_finish);

    let (outcome_sender, outcome_receiver) = mpsc::channel();
    let cancel = handle.cancel.clone();
    let writer_finisher = finisher.clone();
    thread::Builder::new()
        .name("preview-writer".to_owned())
        .spawn(move || {
            let outcome = write_slice(&slice, video_stdin, pcm_stdin, &cancel);
            let _ = outcome_sender.send(outcome);
            writer_finisher.part_done();
        })?;

    if let Some((spawned, pcm_sink)) = pcm_reader {
        let handle = handle.clone();
        let finisher = finisher.clone();
        thread::Builder::new()
            .name("preview-pcm".to_owned())
            .spawn(move || {
                drain(spawned.stdout, &*pcm_sink, None, &handle);
                let message = finish_process(spawned.child, spawned.stderr, &handle, None);
                pcm_sink.end(&message);
                finisher.part_done();
            })?;
    }

    thread::Builder::new()
        .name("preview-remux".to_owned())
        .spawn(move || {
            drain(remux.stdout, &*sink, Some(&handle.credit), &handle);
            let outcome = outcome_receiver.recv_timeout(EXIT_WAIT).ok();
            let message = finish_process(remux.child, remux.stderr, &handle, outcome);
            sink.end(&message);
            release();
            finisher.part_done();
        })?;
    Ok(())
}

/// Start a window of a container that FFmpeg seeks in: one process and one sink.
pub fn start_seek_window(
    ffmpeg: &Path,
    arguments: &[String],
    handle: Arc<WindowHandle>,
    sink: Arc<dyn WindowSink>,
    on_finish: Box<dyn FnOnce() + Send>,
) -> io::Result<()> {
    let spawned = spawn(ffmpeg, arguments, false)?;
    handle.adopt(spawned.child.clone());
    thread::Builder::new()
        .name("preview-seek".to_owned())
        .spawn(move || {
            drain(spawned.stdout, &*sink, Some(&handle.credit), &handle);
            let message = finish_process(spawned.child, spawned.stderr, &handle, None);
            sink.end(&message);
            on_finish();
        })?;
    Ok(())
}

/// Send the output of a process to `sink` until its stdout closes, under `credit` when one is
/// given.
fn drain(
    mut stdout: impl Read,
    sink: &dyn WindowSink,
    credit: Option<&super::registry::Credit>,
    handle: &WindowHandle,
) {
    let mut buffer = vec![0u8; CHUNK_LEN];
    loop {
        let count = match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        if let Some(credit) = credit {
            if !credit.reserve(count as u64, CREDIT_LIMIT) {
                break;
            }
        }
        if !sink.chunk(buffer[..count].to_vec()) {
            // The page is gone, so nothing will read the rest.
            handle.kill();
            break;
        }
    }
}

/// Wait for a process whose stdout closed, and build its end message.
fn finish_process(
    child: Arc<Mutex<Child>>,
    stderr: thread::JoinHandle<Vec<u8>>,
    handle: &WindowHandle,
    outcome: Option<WriterOutcome>,
) -> EndMessage {
    // A short poll, not a blocking wait: the registry locks the child to kill it.
    let deadline = Instant::now() + EXIT_WAIT;
    let status = loop {
        let polled = child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .try_wait();
        match polled {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(EXIT_POLL),
            _ => {
                handle.kill();
                break None;
            }
        }
    };
    let stderr = stderr.join().unwrap_or_default();
    let canceled = handle.is_canceled();
    let read_error = outcome.as_ref().and_then(|o| o.read_error.clone());
    let succeeded = status.is_some_and(|status| status.success()) && read_error.is_none();
    let mut message = EndMessage::new(if canceled {
        EndStatus::Canceled
    } else if succeeded {
        EndStatus::Complete
    } else {
        EndStatus::Failed
    });
    if !canceled && !succeeded {
        let text = String::from_utf8_lossy(&stderr).trim().to_owned();
        message.detail = Some(match read_error {
            Some(error) => format!("the source could not be read: {error}"),
            None if text.is_empty() => format!("ffmpeg ended with {status:?}"),
            None => text,
        });
    }
    if let Some(outcome) = outcome {
        message.reached_end = outcome.reached_end;
        message.next = outcome.next;
        message.bytes_read = outcome.bytes_read;
        message.non_monotonic = outcome.non_monotonic;
        message.damaged = outcome.damaged;
    }
    message
}

/// A reader that counts its bytes.
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

/// Copy the head and then the tags of the slice into the stdin of the remux process and of the
/// PCM process, and record what the tags show.
fn write_slice<V: Write, P: Write>(
    slice: &FlvSlice,
    mut video: V,
    mut pcm: Option<P>,
    cancel: &AtomicBool,
) -> WriterOutcome {
    let mut outcome = WriterOutcome::default();
    let opened = File::open(slice.source.path()).and_then(|mut file| {
        file.seek(SeekFrom::Start(slice.start_offset))?;
        Ok(file)
    });
    let file = match opened {
        Ok(file) => file,
        Err(error) => {
            outcome.read_error = Some(error.to_string());
            return outcome;
        }
    };
    // The count sits under the buffer, so it reports the bytes that left the file, read-ahead
    // included, and not only the bytes that the tags used.
    let mut stream = TagStream::new(
        BufReader::with_capacity(
            1024 * 1024,
            Counting {
                inner: file,
                count: 0,
            },
        ),
        slice.start_offset,
    );

    if video.write_all(&slice.head).is_err() {
        return outcome;
    }
    if pcm
        .as_mut()
        .is_some_and(|stdin| stdin.write_all(&slice.head).is_err())
    {
        pcm = None;
    }

    let mut buffer = Vec::new();
    let mut run = Vec::new();
    let mut latest_dts: Option<i64> = None;
    let mut written: u64 = 0;
    // Where a window that stops at a restart or at damage resumes from.
    let mut resume_from = None;
    loop {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let at = stream.offset();
        let tag = match stream.next_tag(&mut buffer) {
            Ok(Some(tag)) => tag,
            Ok(None) => {
                outcome.reached_end = true;
                break;
            }
            // A recording that was killed, or that still grows, ends inside its last tag.
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                outcome.reached_end = true;
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                outcome.damaged = true;
                resume_from = Some((at + 1, latest_dts.unwrap_or(slice.start_dts)));
                break;
            }
            Err(error) => {
                outcome.read_error = Some(error.to_string());
                break;
            }
        };
        if tag.role.is_frame() {
            if latest_dts.is_some_and(|latest| tag.dts() < latest - DECREASE_LIMIT_MS) {
                // The mp4 muxer would refuse the decreasing time and lose the fragment that it
                // holds, so the window ends in front of the restart.
                outcome.non_monotonic = true;
                resume_from = Some((tag.offset, tag.pts()));
                break;
            }
            latest_dts = latest_dts.max(Some(tag.dts()));
        }
        let keyframe = tag.header.kind == TagKind::Video && tag.is_keyframe();
        if keyframe {
            let entry = KeyframeEntry {
                offset: tag.offset,
                dts: tag.dts(),
                pts: tag.pts(),
            };
            run.push(entry);
            let past_limit = tag.dts() >= slice.start_dts.saturating_add(slice.limit_ms)
                || written >= slice.limit_bytes;
            if tag.offset != slice.start_offset && past_limit {
                outcome.next = Some(ResumePoint {
                    offset: tag.offset,
                    pts_ms: tag.pts(),
                });
                break;
            }
        }
        if tag.role == TagRole::Config {
            slice.source.record_config(ConfigTag {
                offset: tag.offset,
                kind: tag.header.kind,
                bytes: buffer.clone(),
            });
        }
        if video.write_all(&buffer).is_err() {
            // The remux process ended or was killed.
            break;
        }
        if pcm
            .as_mut()
            .is_some_and(|stdin| stdin.write_all(&buffer).is_err())
        {
            // A PCM process that failed only disables the cue.
            pcm = None;
        }
        written += buffer.len() as u64;
    }
    drop(video);
    drop(pcm);
    outcome.bytes_read = stream_count(&stream);
    slice.source.record_run(&run, outcome.reached_end);
    if outcome.non_monotonic {
        slice.source.record_non_monotonic();
    }
    if let Some((offset, pts_ms)) = resume_from {
        // The page cannot resume by time past a restart, where a time occurs twice, or past
        // damage. The window names where it stopped, and the next request walks from there to
        // the next keyframe, where a newer request can cancel the walk.
        outcome.next = Some(ResumePoint { offset, pts_ms });
    }
    outcome
}

fn stream_count<R: Read>(stream: &TagStream<BufReader<Counting<R>>>) -> u64 {
    stream.reader().get_ref().count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::preview::arguments::{
        flv_pcm_arguments, flv_remux_arguments, seek_remux_arguments, AudioMode, SeekContainer,
    };
    use crate::ffmpeg::preview::registry::Lane;
    use crate::flv::test_support::TestDirectory;
    use std::path::PathBuf;

    /// A sink that keeps what it receives and acknowledges each piece at once.
    struct Recorder {
        bytes: Mutex<Vec<u8>>,
        end: Mutex<Option<EndMessage>>,
        handle: Mutex<Option<Arc<WindowHandle>>>,
    }

    impl Recorder {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                bytes: Mutex::new(Vec::new()),
                end: Mutex::new(None),
                handle: Mutex::new(None),
            })
        }

        fn wait_end(&self) -> EndMessage {
            let deadline = Instant::now() + Duration::from_secs(60);
            loop {
                if let Some(message) = self.end.lock().unwrap().clone() {
                    return message;
                }
                assert!(Instant::now() < deadline, "the window did not end");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    impl WindowSink for Recorder {
        fn chunk(&self, bytes: Vec<u8>) -> bool {
            let len = bytes.len() as u64;
            self.bytes.lock().unwrap().extend(bytes);
            if let Some(handle) = &*self.handle.lock().unwrap() {
                handle.credit.release(len);
            }
            true
        }

        fn end(&self, message: &EndMessage) {
            *self.end.lock().unwrap() = Some(message.clone());
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

    /// A 12 s FLV of 30 fps H.264 with a GOP of 2 s and AAC, made by ffmpeg.
    fn sample_flv(ffmpeg: &Path, dir: &TestDirectory) -> PathBuf {
        let path = dir.path.join("sample.flv");
        let status = command_without_console(ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=30",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-t",
                "12",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-bf",
                "2",
                "-g",
                "60",
                "-c:a",
                "aac",
                "-f",
                "flv",
            ])
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success());
        path
    }

    fn slice(source: &Arc<FlvSource>, offset: u64, dts: i64, limit_ms: i64) -> FlvSlice {
        FlvSlice {
            source: source.clone(),
            head: source.head_bytes_at(offset),
            start_offset: offset,
            start_dts: dts,
            limit_ms,
            limit_bytes: 64 * 1024 * 1024,
        }
    }

    fn handle() -> Arc<WindowHandle> {
        Arc::new(WindowHandle::new(
            1,
            Lane::Video,
            Arc::new(AtomicBool::new(false)),
        ))
    }

    #[test]
    fn an_flv_window_streams_fragments_and_stops_at_the_keyframe_after_its_limit() {
        let Some(ffmpeg) = ffmpeg() else {
            return;
        };
        let dir = TestDirectory::new();
        let path = sample_flv(&ffmpeg, &dir);
        let source = Arc::new(FlvSource::open(&path, None).unwrap());
        let start = source.head().first_frame_offset;
        let handle = handle();
        let sink = Recorder::new();
        *sink.handle.lock().unwrap() = Some(handle.clone());
        let pcm = Recorder::new();
        let finished = Arc::new(AtomicBool::new(false));
        let done = finished.clone();
        start_flv_window(
            &ffmpeg,
            slice(&source, start, 0, 4_000),
            &flv_remux_arguments(AudioMode::Copy),
            Some((flv_pcm_arguments(0), pcm.clone() as Arc<dyn WindowSink>)),
            handle,
            sink.clone(),
            Box::new(|| {}),
            Box::new(move || done.store(true, Ordering::SeqCst)),
        )
        .unwrap();
        let end = sink.wait_end();
        assert_eq!(end.status, EndStatus::Complete, "{:?}", end.detail);
        assert!(!end.reached_end);
        let next = end.next.unwrap();
        assert!(next.pts_ms >= 4_000);
        assert!(source.is_keyframe_at(next.offset).unwrap());
        assert!(end.bytes_read > 0);
        let bytes = sink.bytes.lock().unwrap().clone();
        assert_eq!(&bytes[4..8], b"ftyp");
        assert!(bytes.windows(4).any(|w| w == b"moof"));
        // The keyframes of the window entered the table as one run.
        let (located, read) = source.locate(3_000, None).unwrap();
        assert_eq!(read, 0);
        assert!(located.keyframe.pts <= 3_000);
        // The PCM of the same slice: mono 16-bit at 48 kHz from the first tag.
        let pcm_end = pcm.wait_end();
        assert_eq!(pcm_end.status, EndStatus::Complete, "{:?}", pcm_end.detail);
        // The finish runs after both processes ended.
        let deadline = Instant::now() + Duration::from_secs(10);
        while !finished.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline, "the finish did not run");
            thread::sleep(Duration::from_millis(5));
        }
        let samples = pcm.bytes.lock().unwrap().len() / 2;
        let seconds = samples as f64 / 48_000.0;
        let expected = next.pts_ms as f64 / 1000.0;
        assert!(
            (seconds - expected).abs() < 0.2,
            "{seconds} s of PCM, {expected} s of video"
        );
    }

    #[test]
    fn a_failed_pcm_process_does_not_stop_the_video() {
        let Some(ffmpeg) = ffmpeg() else {
            return;
        };
        let dir = TestDirectory::new();
        let path = sample_flv(&ffmpeg, &dir);
        let source = Arc::new(FlvSource::open(&path, None).unwrap());
        let start = source.head().first_frame_offset;
        let handle = handle();
        let sink = Recorder::new();
        *sink.handle.lock().unwrap() = Some(handle.clone());
        let pcm = Recorder::new();
        // A PCM process that maps a stream that does not exist ends at once.
        let broken = vec![
            "-hide_banner".to_owned(),
            "-loglevel".to_owned(),
            "error".to_owned(),
            "-f".to_owned(),
            "flv".to_owned(),
            "-i".to_owned(),
            "pipe:0".to_owned(),
            "-map".to_owned(),
            "0:s:9".to_owned(),
            "-f".to_owned(),
            "s16le".to_owned(),
            "pipe:1".to_owned(),
        ];
        start_flv_window(
            &ffmpeg,
            slice(&source, start, 0, 60_000),
            &flv_remux_arguments(AudioMode::Copy),
            Some((broken, pcm.clone() as Arc<dyn WindowSink>)),
            handle,
            sink.clone(),
            Box::new(|| {}),
            Box::new(|| {}),
        )
        .unwrap();
        let end = sink.wait_end();
        assert_eq!(end.status, EndStatus::Complete, "{:?}", end.detail);
        assert!(end.reached_end);
        assert_eq!(pcm.wait_end().status, EndStatus::Failed);
    }

    fn write_file(dir: &TestDirectory, bytes: &[u8]) -> Arc<FlvSource> {
        let path = dir.path.join("synthetic.flv");
        std::fs::write(&path, bytes).unwrap();
        Arc::new(FlvSource::open(&path, None).unwrap())
    }

    /// A writer that fails at once, as the stdin of a process that died does.
    struct Broken;

    impl Write for Broken {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn the_writer_stops_in_front_of_the_first_keyframe_after_its_time_limit() {
        let recording =
            crate::flv::test_support::recording(&crate::flv::test_support::RecordingOptions {
                seconds: 20,
                ..Default::default()
            });
        let dir = TestDirectory::new();
        let source = write_file(&dir, &recording.bytes);
        let start = source.head().first_frame_offset;
        let mut video = Vec::new();
        let mut pcm = Vec::new();
        let outcome = write_slice(
            &slice(&source, start, 0, 5_000),
            &mut video,
            Some(&mut pcm),
            &AtomicBool::new(false),
        );
        let stop = recording.keyframes.iter().find(|k| k.dts >= 5_000).unwrap();
        assert_eq!(
            outcome.next,
            Some(ResumePoint {
                offset: stop.offset,
                pts_ms: stop.pts
            })
        );
        assert!(!outcome.reached_end);
        // The head, then every byte from the start up to the stop keyframe, and the PCM process
        // takes the same bytes.
        let head = source.head_bytes_at(start);
        assert_eq!(&video[..head.len()], head.as_slice());
        assert_eq!(
            &video[head.len()..],
            &recording.bytes[start as usize..stop.offset as usize]
        );
        assert_eq!(video, pcm);
        assert!(outcome.bytes_read >= stop.offset - start);
    }

    #[test]
    fn the_writer_stops_at_the_byte_limit_and_at_the_end_of_the_file() {
        let recording = crate::flv::test_support::recording(
            &crate::flv::test_support::RecordingOptions::default(),
        );
        let dir = TestDirectory::new();
        let source = write_file(&dir, &recording.bytes);
        let start = source.head().first_frame_offset;
        let outcome = write_slice(
            &FlvSlice {
                limit_bytes: 100_000,
                ..slice(&source, start, 0, 60_000)
            },
            Vec::new(),
            None::<Vec<u8>>,
            &AtomicBool::new(false),
        );
        let next = outcome.next.unwrap();
        assert!(next.offset - start >= 100_000);
        assert!(recording.keyframes.iter().any(|k| k.offset == next.offset));

        let to_end = write_slice(
            &slice(&source, start, 0, 600_000),
            Vec::new(),
            None::<Vec<u8>>,
            &AtomicBool::new(false),
        );
        assert!(to_end.reached_end);
        assert_eq!(to_end.next, None);
    }

    #[test]
    fn the_writer_stops_in_front_of_a_restart_and_names_the_keyframe_after_it() {
        let (bytes, keys) = crate::flv::test_support::restart_recording();
        let dir = TestDirectory::new();
        let source = write_file(&dir, &bytes);
        let start = source.head().first_frame_offset;
        let outcome = write_slice(
            &slice(&source, start, 0, 600_000),
            Vec::new(),
            None::<Vec<u8>>,
            &AtomicBool::new(false),
        );
        assert!(outcome.non_monotonic);
        assert!(source.non_monotonic());
        let restart = keys.iter().find(|(part, _, _)| *part == 1).unwrap();
        let next = outcome.next.unwrap();
        let keyframe = source
            .next_keyframe_from(next.offset, None)
            .unwrap()
            .unwrap();
        assert_eq!((keyframe.offset, keyframe.pts), (restart.1, restart.2));
    }

    #[test]
    fn the_writer_stops_at_a_damaged_tag_and_a_truncated_end() {
        let recording = crate::flv::test_support::recording(
            &crate::flv::test_support::RecordingOptions::default(),
        );
        let start = recording.first_frame_offset;
        let damaged_at = recording.frames[100].0;
        let mut damaged = recording.bytes.clone();
        // A wrong stream id makes the tag header invalid.
        damaged[damaged_at as usize + 9] = 7;
        let dir = TestDirectory::new();
        let source = write_file(&dir, &damaged);
        let outcome = write_slice(
            &slice(&source, start, 0, 600_000),
            Vec::new(),
            None::<Vec<u8>>,
            &AtomicBool::new(false),
        );
        assert!(outcome.damaged);
        let after = recording
            .keyframes
            .iter()
            .find(|k| k.offset > damaged_at)
            .unwrap();
        let next = outcome.next.unwrap();
        let keyframe = source
            .next_keyframe_from(next.offset, None)
            .unwrap()
            .unwrap();
        assert_eq!(keyframe.offset, after.offset);

        let mut truncated = recording.bytes.clone();
        truncated.truncate(truncated.len() - 40);
        let other = TestDirectory::new();
        let source = write_file(&other, &truncated);
        let outcome = write_slice(
            &slice(&source, start, 0, 600_000),
            Vec::new(),
            None::<Vec<u8>>,
            &AtomicBool::new(false),
        );
        assert!(outcome.reached_end);
        assert!(!outcome.damaged);
    }

    #[test]
    fn a_broken_pcm_writer_does_not_stop_the_video() {
        let recording = crate::flv::test_support::recording(
            &crate::flv::test_support::RecordingOptions::default(),
        );
        let dir = TestDirectory::new();
        let source = write_file(&dir, &recording.bytes);
        let start = source.head().first_frame_offset;
        let mut video = Vec::new();
        let outcome = write_slice(
            &slice(&source, start, 0, 600_000),
            &mut video,
            Some(Broken),
            &AtomicBool::new(false),
        );
        assert!(outcome.reached_end);
        let head = source.head_bytes_at(start);
        assert_eq!(
            video.len(),
            head.len() + recording.bytes.len() - start as usize
        );
    }

    /// A sink whose first piece waits until the test lets it go, so the window is still running
    /// when the test kills it.
    struct Held {
        released: AtomicBool,
        end: Mutex<Option<EndMessage>>,
    }

    impl WindowSink for Held {
        fn chunk(&self, _bytes: Vec<u8>) -> bool {
            let deadline = Instant::now() + Duration::from_secs(30);
            while !self.released.load(Ordering::SeqCst) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            true
        }

        fn end(&self, message: &EndMessage) {
            *self.end.lock().unwrap() = Some(message.clone());
        }
    }

    #[test]
    fn a_killed_window_ends_as_canceled() {
        let Some(ffmpeg) = ffmpeg() else {
            return;
        };
        let dir = TestDirectory::new();
        let path = sample_flv(&ffmpeg, &dir);
        let source = Arc::new(FlvSource::open(&path, None).unwrap());
        let start = source.head().first_frame_offset;
        let handle = handle();
        let sink = Arc::new(Held {
            released: AtomicBool::new(false),
            end: Mutex::new(None),
        });
        start_flv_window(
            &ffmpeg,
            slice(&source, start, 0, 60_000),
            &flv_remux_arguments(AudioMode::Copy),
            None,
            handle.clone(),
            sink.clone(),
            Box::new(|| {}),
            Box::new(|| {}),
        )
        .unwrap();
        thread::sleep(Duration::from_millis(300));
        handle.kill();
        sink.released.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(30);
        let end = loop {
            if let Some(end) = sink.end.lock().unwrap().clone() {
                break end;
            }
            assert!(Instant::now() < deadline, "the window did not end");
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(end.status, EndStatus::Canceled);
    }

    #[test]
    fn a_seek_window_reads_its_part_of_a_matroska_file() {
        let Some(ffmpeg) = ffmpeg() else {
            return;
        };
        let dir = TestDirectory::new();
        let flv = sample_flv(&ffmpeg, &dir);
        let mkv = dir.path.join("sample.mkv");
        let status = command_without_console(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&flv)
            .args(["-c", "copy"])
            .arg(&mkv)
            .status()
            .unwrap();
        assert!(status.success());
        let handle = handle();
        let sink = Recorder::new();
        *sink.handle.lock().unwrap() = Some(handle.clone());
        start_seek_window(
            &ffmpeg,
            &seek_remux_arguments(
                &mkv,
                SeekContainer::Matroska,
                Some(5.0),
                3.0,
                AudioMode::Copy,
                true,
            ),
            handle,
            sink.clone(),
            Box::new(|| {}),
        )
        .unwrap();
        let end = sink.wait_end();
        assert_eq!(end.status, EndStatus::Complete, "{:?}", end.detail);
        let bytes = sink.bytes.lock().unwrap().clone();
        assert_eq!(&bytes[4..8], b"ftyp");
    }
}
