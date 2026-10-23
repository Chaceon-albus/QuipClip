//! Running a remux window: the processes, the stdin writer of an FLV window, and the readers that
//! send the output to the page (ADR 046).
//!
//! An FLV window reads the source once. The writer copies the head and then tag after tag into
//! the stdin of the remux process and, when the scrub cue needs it, into the stdin of the PCM
//! process. It records the keyframes and configurations that it passes, and it ends the slice
//! itself: in front of the first keyframe after the time or byte limit, and in front of a tag
//! whose timestamp decreases, so the mp4 muxer never sees a restart. At a decoder configuration
//! that differs from the one in the head, which one mp4 output cannot switch to, it stops writing
//! and reads on to the next keyframe, where the next window starts. A video frame whose NAL units
//! do not fill its data, as the last frame of a recording that was cut, fails the append of the
//! whole window in Chromium, so the writer leaves out the video from that frame up to the next
//! keyframe that passes, and it keeps the audio. The reader of the remux output waits for the
//! credit of the page, so a page that does not append stops the whole chain down to the reads of
//! the share.

use super::registry::{WindowHandle, CREDIT_LIMIT};
use crate::ffmpeg::capabilities::smoke::read_capped_tail;
use crate::flv::locate::DECREASE_LIMIT_MS;
use crate::flv::scan::TagStream;
use crate::flv::table::{ConfigTag, KeyframeEntry};
use crate::flv::tag::{
    frame_nal_units, nal_length_size, nal_units_fill, parse_tag_header, TagKind, TagRole,
    PREVIOUS_TAG_SIZE_LEN, TAG_HEADER_LEN,
};
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
    /// Where the next window starts: the keyframe tag at the limit of this window or after a
    /// changed decoder configuration, or, after a restart of the timestamps, a damaged tag, or
    /// video left out for more than [`crate::flv::NEXT_KEYFRAME_REACH`] bytes, the place where
    /// this window stopped, from which the next request walks to the next keyframe. A complete
    /// window with neither `next` nor `reached_end` is one whose writer did not report within
    /// the wait of its reader, as when a read of a share stalls. The page then resumes by time
    /// from the last fragment that it appended, and never takes it as the end of the file.
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
    let draining = Arc::new(AtomicBool::new(false));
    let writer_draining = draining.clone();
    let writer_finisher = finisher.clone();
    thread::Builder::new()
        .name("preview-writer".to_owned())
        .spawn(move || {
            let outcome = write_slice(&slice, video_stdin, pcm_stdin, &cancel, &writer_draining);
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
            let outcome = wait_for_writer(&outcome_receiver, &draining, &handle);
            let message = finish_process(remux.child, remux.stderr, &handle, outcome);
            sink.end(&message);
            release();
            finisher.part_done();
        })?;
    Ok(())
}

/// The outcome of the writer of a window: within [`EXIT_WAIT`] after the remux output closed,
/// or, while the writer reads on to the keyframe after a changed configuration, until it reports
/// or the window is canceled. That read can take longer than the wait on a slow share, and an
/// end message without its keyframe would make the page run the same window again.
fn wait_for_writer(
    receiver: &mpsc::Receiver<WriterOutcome>,
    draining: &AtomicBool,
    handle: &WindowHandle,
) -> Option<WriterOutcome> {
    match receiver.recv_timeout(EXIT_WAIT) {
        Ok(outcome) => return Some(outcome),
        Err(mpsc::RecvTimeoutError::Disconnected) => return None,
        Err(mpsc::RecvTimeoutError::Timeout) => {}
    }
    while draining.load(Ordering::SeqCst) && !handle.is_canceled() {
        match receiver.recv_timeout(EXIT_POLL) {
            Ok(outcome) => return Some(outcome),
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    receiver.try_recv().ok()
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
    draining: &AtomicBool,
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

    let held_configs = head_configs(&slice.head);
    // The init segment of the window carries the video configuration of the head, and the web
    // view splits each video sample of the window into NAL units with its length size. Without a
    // length size, as for another codec, no frame is checked.
    let nal_length = held_configs
        .iter()
        .find(|(kind, _)| *kind == TagKind::Video)
        .and_then(|(_, data)| nal_length_size(data));
    let mut video = Some(video);
    let mut buffer = Vec::new();
    let mut run = Vec::new();
    let mut latest_dts: Option<i64> = None;
    let mut written: u64 = 0;
    let mut audio_written = false;
    // The offset of a configuration that differs from the head, after which the window writes
    // no more: the writer reads on to the next keyframe, where the next window starts with a head
    // that holds the configurations that it passed.
    let mut drain_from: Option<u64> = None;
    // Where a window that stops at a restart or at damage resumes from.
    let mut resume_from = None;
    // The offset of a video frame whose NAL units do not fill its data, while the writer leaves
    // out the video from it up to the next keyframe whose NAL units do. Chromium fails the append
    // of the whole window at such a frame. The audio goes on. For a stretch of up to 10 s, the
    // interleave limit of FFmpeg, the mp4 muxer then lines up the last video sample with the next
    // frame that it gets, and the web view keeps one buffered range. A longer stretch leaves a
    // hole, which the page seeks over (ADR 046).
    let mut dropped_from: Option<u64> = None;
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
        let video_frame = tag.header.kind == TagKind::Video && tag.role.is_frame();
        let whole = !video_frame
            || nal_length.is_none_or(|length_size| {
                frame_nal_units(&buffer[TAG_HEADER_LEN..buffer.len() - PREVIOUS_TAG_SIZE_LEN])
                    .is_none_or(|units| nal_units_fill(units, length_size))
            });
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
            // The limit ends the window only at a keyframe that it writes and that does not end
            // video left out. Otherwise the next window would start with no video there, or the
            // last sample in front of the stretch would get no later frame in its own window to
            // line up with.
            let ends_at_limit = past_limit && whole && dropped_from.is_none();
            if tag.offset != slice.start_offset && (ends_at_limit || drain_from.is_some()) {
                outcome.next = Some(ResumePoint {
                    offset: tag.offset,
                    pts_ms: tag.pts(),
                });
                break;
            }
        }
        if tag.role == TagRole::Config {
            let config = ConfigTag {
                offset: tag.offset,
                kind: tag.header.kind,
                bytes: buffer.clone(),
            };
            // A reconnect writes a new configuration, as for another picture size. The mp4
            // muxer keeps the configuration of the head for the whole output, so the window
            // writes nothing from the new one on. It closes the stdin of both processes, so
            // they finish the output, and reads on to the next keyframe. On the way it records
            // the configurations, as the one of the audio that a reconnect writes too, and it
            // checks the timestamps. The page appends the init segment of the next window. A
            // copy of the configuration of the head changes nothing and passes, and so does a
            // configuration in front of the first frame of its kind, which the head of the
            // window took (`FlvSource::window_head`).
            let changes = held_configs
                .iter()
                .any(|(kind, held)| *kind == tag.header.kind && held.as_slice() != config.data());
            let framed = match tag.header.kind {
                TagKind::Video => !run.is_empty(),
                TagKind::Audio => audio_written,
                TagKind::Script => false,
            };
            slice.source.record_config(config);
            if changes && framed && drain_from.is_none() {
                drain_from = Some(tag.offset);
                draining.store(true, Ordering::SeqCst);
                video = None;
                pcm = None;
            }
        }
        if let Some(from) = drain_from {
            // A tail with no keyframe within the reach of a walk to the next keyframe ends
            // the read there, and the next request walks on from it.
            if tag.offset.saturating_sub(from) > crate::flv::NEXT_KEYFRAME_REACH {
                resume_from = Some((tag.offset, tag.pts()));
                break;
            }
            continue;
        }
        if video_frame {
            if !whole && dropped_from.is_none() {
                eprintln!(
                    "preview: the video frame at byte {} ({} ms) does not split into NAL units; \
                     the window leaves out the video up to the next keyframe that does",
                    tag.offset,
                    tag.dts()
                );
                dropped_from = Some(tag.offset);
            } else if whole && keyframe {
                dropped_from = None;
            }
        }
        if let Some(from) = dropped_from {
            // A stretch with no keyframe that passes within the reach of a walk to the next
            // keyframe ends the read there, as the drain does.
            if tag.offset.saturating_sub(from) > crate::flv::NEXT_KEYFRAME_REACH {
                resume_from = Some((tag.offset, tag.pts()));
                break;
            }
            if video_frame {
                continue;
            }
        }
        if video
            .as_mut()
            .is_none_or(|stdin| stdin.write_all(&buffer).is_err())
        {
            // The remux process ended or was killed.
            break;
        }
        if tag.header.kind == TagKind::Audio && tag.role.is_frame() {
            audio_written = true;
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

/// The data of each decoder configuration in `head`, the head of a window: the FLV header, its
/// `PreviousTagSize0`, and the configuration tags.
fn head_configs(head: &[u8]) -> Vec<(TagKind, Vec<u8>)> {
    let mut configs = Vec::new();
    let Some(mut position) = head
        .get(5..9)
        .and_then(|offset| usize::try_from(u32::from_be_bytes(offset.try_into().ok()?)).ok())
        .map(|offset| offset + PREVIOUS_TAG_SIZE_LEN)
    else {
        return configs;
    };
    while let Some(header) = head.get(position..).and_then(parse_tag_header) {
        let start = position + TAG_HEADER_LEN;
        let Some(end) = usize::try_from(header.data_size)
            .ok()
            .and_then(|size| start.checked_add(size))
        else {
            break;
        };
        let Some(data) = head.get(start..end) else {
            break;
        };
        configs.push((header.kind, data.to_vec()));
        position = end + PREVIOUS_TAG_SIZE_LEN;
    }
    configs
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

    use crate::flv::test_support::{nal_chain, FlvBuilder};

    /// The data of a configuration of AAC at 44100 Hz, which differs from the one of
    /// `FlvBuilder::aac_config` at 48000 Hz.
    const OTHER_AAC: [u8; 4] = [0xAF, 0, 0x12, 0x10];

    /// A recording of 120 frames, 33 ms apart, with a keyframe each 30 frames and, with `audio`, an
    /// audio frame after each video frame. In front of frame 60, `reconnect` writes its tags. The
    /// answer holds the bytes and the offset of each keyframe.
    fn recording_with(
        audio: bool,
        reconnect: impl Fn(&mut FlvBuilder, u32),
    ) -> (Vec<u8>, Vec<u64>) {
        let mut builder = FlvBuilder::new(audio, true);
        if audio {
            builder.aac_config(0);
        }
        builder.avc_config(0, 0);
        let mut keyframes = Vec::new();
        for frame in 0..120u32 {
            if frame == 60 {
                reconnect(&mut builder, frame * 33);
            }
            let offset = builder.video(frame * 33, frame % 30 == 0, 0, 500);
            if frame % 30 == 0 {
                keyframes.push(offset);
            }
            if audio {
                builder.audio(frame * 33 + 10, 100);
            }
        }
        (builder.finish(), keyframes)
    }

    /// A video-only recording of 120 frames with a configuration at frame 60 with `marker`, and
    /// the offset of that configuration.
    fn recording_with_a_config_at_frame_60(marker: u8) -> (Vec<u8>, u64) {
        let config = std::cell::Cell::new(0);
        let (bytes, _) = recording_with(false, |builder, at| {
            config.set(builder.avc_config(at, marker));
        });
        (bytes, config.get())
    }

    /// Write the window of `source` from its first frame, with no limit.
    fn whole_window(source: &Arc<FlvSource>) -> (WriterOutcome, Vec<u8>) {
        window_from(source, source.head().first_frame_offset, 0, 600_000)
    }

    #[test]
    fn the_writer_stops_writing_at_a_new_configuration_and_names_the_keyframe_after_it() {
        let dir = TestDirectory::new();
        let (bytes, config) = recording_with_a_config_at_frame_60(1);
        let source = write_file(&dir, &bytes);
        let start = source.head().first_frame_offset;
        let (outcome, video) = whole_window(&source);
        assert!(!outcome.reached_end);
        assert!(!outcome.non_monotonic);
        // The window holds the head and the tags up to the new configuration, and nothing after.
        let head = source.head_bytes_at(start);
        assert_eq!(&video[..head.len()], head.as_slice());
        assert_eq!(
            &video[head.len()..],
            &bytes[start as usize..config as usize]
        );
        // The next window starts at the keyframe after it, with a head that holds it.
        let next = outcome.next.unwrap();
        let keyframe = source.tag_at(next.offset).unwrap().unwrap();
        assert!(keyframe.is_keyframe());
        assert_eq!((keyframe.dts(), next.pts_ms), (60 * 33, 60 * 33));
        assert!(source.has_config_change());
        assert_ne!(source.window_head(next.offset, None).unwrap(), head);
    }

    #[test]
    fn a_reconnect_that_changes_both_configurations_gives_the_next_window_both() {
        let dir = TestDirectory::new();
        let (bytes, keyframes) = recording_with(true, |builder, at| {
            builder.tag(8, at, &OTHER_AAC);
            builder.avc_config(at, 1);
        });
        let source = write_file(&dir, &bytes);
        let (outcome, _) = whole_window(&source);
        // The writer stops at the configuration of the audio, and it records the one of the
        // video on its way to the keyframe.
        let next = outcome.next.unwrap();
        assert_eq!(next.offset, keyframes[2]);
        let head = source.window_head(next.offset, None).unwrap();
        let configs = head_configs(&head);
        assert!(configs.contains(&(TagKind::Audio, OTHER_AAC.to_vec())));
        assert!(configs.contains(&(TagKind::Video, vec![0x17, 0, 0, 0, 0, 1, 0x64, 0, 1])));
    }

    #[test]
    fn a_configuration_of_the_audio_after_the_keyframe_goes_into_the_head_of_its_window() {
        let dir = TestDirectory::new();
        // FFmpeg's flv muxer writes the new configuration of a stream in front of its next
        // packet, so the one of the audio can follow the keyframe.
        let (mut bytes, keyframes) = recording_with(true, |builder, at| {
            builder.avc_config(at, 1);
        });
        // Put the new configuration of the audio right after the keyframe at frame 60.
        let keyframe = keyframes[2] as usize;
        let after = keyframe + 11 + 500 + 4;
        let mut audio_config = FlvBuilder::new(false, false);
        audio_config.tag(8, 60 * 33, &OTHER_AAC);
        let tag = audio_config.finish()[13..].to_vec();
        bytes.splice(after..after, tag);
        let source = write_file(&dir, &bytes);
        let (outcome, _) = whole_window(&source);
        let next = outcome.next.unwrap();
        assert_eq!(next.offset, keyframes[2]);
        let head = source.window_head(next.offset, None).unwrap();
        assert!(head_configs(&head).contains(&(TagKind::Audio, OTHER_AAC.to_vec())));
    }

    #[test]
    fn a_new_configuration_with_no_keyframe_after_it_reaches_the_end() {
        let dir = TestDirectory::new();
        let mut builder = FlvBuilder::new(false, true);
        builder.avc_config(0, 0);
        for frame in 0..120u32 {
            if frame == 100 {
                builder.avc_config(frame * 33, 1);
            }
            builder.video(frame * 33, frame % 30 == 0, 0, 500);
        }
        let source = write_file(&dir, &builder.finish());
        let (outcome, _) = whole_window(&source);
        assert!(outcome.reached_end);
        assert_eq!(outcome.next, None);
    }

    #[test]
    fn a_restart_after_a_new_configuration_is_found() {
        let dir = TestDirectory::new();
        let mut builder = FlvBuilder::new(false, true);
        builder.avc_config(0, 0);
        for frame in 0..120u32 {
            // A reconnect writes a new configuration and starts its timestamps again.
            if frame == 60 {
                builder.avc_config(0, 1);
            }
            // The restart lies more than the 10 s of `DECREASE_LIMIT_MS` back.
            let dts = if frame < 60 {
                20_000 + frame * 33
            } else {
                (frame - 60) * 33
            };
            builder.video(dts, frame % 30 == 0, 0, 500);
        }
        let source = write_file(&dir, &builder.finish());
        let (outcome, _) = whole_window(&source);
        assert!(outcome.non_monotonic);
        assert!(source.non_monotonic());
        // The next window walks from the restart to the keyframe there.
        let next = outcome.next.unwrap();
        let keyframe = source
            .next_keyframe_from(next.offset, None)
            .unwrap()
            .unwrap();
        assert_eq!(keyframe.dts, 0);
    }

    #[test]
    fn the_reader_waits_for_a_writer_that_reads_on_to_the_next_keyframe() {
        let (sender, receiver) = mpsc::channel();
        let draining = AtomicBool::new(true);
        let window = handle();
        thread::spawn(move || {
            thread::sleep(EXIT_WAIT + Duration::from_millis(200));
            let _ = sender.send(WriterOutcome {
                reached_end: true,
                ..WriterOutcome::default()
            });
        });
        let outcome = wait_for_writer(&receiver, &draining, &window).unwrap();
        assert!(outcome.reached_end);
    }

    #[test]
    fn the_writer_passes_a_copy_of_the_configuration_of_its_head() {
        let dir = TestDirectory::new();
        let source = write_file(&dir, &recording_with_a_config_at_frame_60(0).0);
        let start = source.head().first_frame_offset;
        let outcome = write_slice(
            &slice(&source, start, 0, 600_000),
            Vec::new(),
            None::<Vec<u8>>,
            &AtomicBool::new(false),
            &AtomicBool::new(false),
        );
        assert!(outcome.reached_end);
        assert_eq!(outcome.next, None);
    }

    #[test]
    fn the_configurations_of_a_head_are_its_tags_after_the_header() {
        let dir = TestDirectory::new();
        let source = write_file(&dir, &recording_with_a_config_at_frame_60(1).0);
        let head = source.head_bytes_at(source.head().first_frame_offset);
        let configs = head_configs(&head);
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].0, TagKind::Video);
        assert!(head_configs(&head[..20]).is_empty());
        assert!(head_configs(&[]).is_empty());
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
            &AtomicBool::new(false),
        );
        assert!(outcome.reached_end);
        assert!(!outcome.damaged);
    }

    /// The data of the frame that a recording that was cut ends with: a NAL unit length of 202
    /// and no unit after it.
    const CUT_FRAME: [u8; 4] = [0, 0, 0, 0xCA];

    /// A recording of 120 frames, 33 ms apart, whose NAL units carry a length of 4 bytes, with a
    /// keyframe each 30 frames and an audio frame after each video frame. The frames in
    /// `malformed` hold [`CUT_FRAME`]. With `config_at_50`, another configuration comes in front
    /// of frame 50. The answer holds the bytes and the offset of each video frame.
    fn checked_recording(malformed: &[u32], config_at_50: bool) -> (Vec<u8>, Vec<u64>) {
        let mut builder = FlvBuilder::new(true, true);
        builder.aac_config(0);
        builder.avcc_config(0, 4, 0);
        let mut frames = Vec::new();
        for frame in 0..120u32 {
            if config_at_50 && frame == 50 {
                builder.avcc_config(frame * 33, 4, 1);
            }
            let units = if malformed.contains(&frame) {
                CUT_FRAME.to_vec()
            } else {
                nal_chain(4, &[12, 300])
            };
            frames.push(builder.video_units(frame * 33, frame % 30 == 0, 0, &units));
            builder.audio(frame * 33 + 10, 100);
        }
        (builder.finish(), frames)
    }

    /// The video frames that `video` holds after its head of `head_len` bytes, as their index in
    /// a recording of frames 33 ms apart, and the number of its audio frames.
    fn written_frames(video: &[u8], head_len: usize) -> (Vec<u32>, usize) {
        let mut stream = TagStream::new(&video[head_len..], 0);
        let mut buffer = Vec::new();
        let mut frames = Vec::new();
        let mut audio = 0;
        while let Some(tag) = stream.next_tag(&mut buffer).unwrap() {
            if tag.header.kind == TagKind::Video && tag.role.is_frame() {
                frames.push(u32::try_from(tag.dts()).unwrap() / 33);
            } else if tag.header.kind == TagKind::Audio && tag.role.is_frame() {
                audio += 1;
            }
        }
        (frames, audio)
    }

    /// Write the window of `source` from `offset` at `dts`, up to `limit_ms`.
    fn window_from(
        source: &Arc<FlvSource>,
        offset: u64,
        dts: i64,
        limit_ms: i64,
    ) -> (WriterOutcome, Vec<u8>) {
        let mut video = Vec::new();
        let outcome = write_slice(
            &slice(source, offset, dts, limit_ms),
            &mut video,
            None::<Vec<u8>>,
            &AtomicBool::new(false),
            &AtomicBool::new(false),
        );
        (outcome, video)
    }

    #[test]
    fn the_writer_leaves_out_the_video_from_a_cut_frame_up_to_the_next_keyframe() {
        let dir = TestDirectory::new();
        let source = write_file(&dir, &checked_recording(&[40], false).0);
        let start = source.head().first_frame_offset;
        let mut video = Vec::new();
        let mut pcm = Vec::new();
        let outcome = write_slice(
            &slice(&source, start, 0, 600_000),
            &mut video,
            Some(&mut pcm),
            &AtomicBool::new(false),
            &AtomicBool::new(false),
        );
        assert!(outcome.reached_end);
        assert_eq!(outcome.next, None);
        let (frames, audio) = written_frames(&video, source.head_bytes_at(start).len());
        assert_eq!(frames, (0..40).chain(60..120).collect::<Vec<_>>());
        assert_eq!(audio, 120);
        // The PCM process takes the same bytes, so its audio goes on through the stretch.
        assert_eq!(video, pcm);
    }

    #[test]
    fn video_left_out_does_not_count_toward_the_byte_limit() {
        let dir = TestDirectory::new();
        let (bytes, offsets) = checked_recording(&[40], false);
        let source = write_file(&dir, &bytes);
        let start = source.head().first_frame_offset;
        // Counted with frames 40 to 59, the bytes in front of keyframe 90 would reach the limit.
        let outcome = write_slice(
            &FlvSlice {
                limit_bytes: offsets[90] - start - 1,
                ..slice(&source, start, 0, 600_000)
            },
            Vec::new(),
            None::<Vec<u8>>,
            &AtomicBool::new(false),
            &AtomicBool::new(false),
        );
        assert!(outcome.reached_end);
        assert_eq!(outcome.next, None);
    }

    #[test]
    fn a_cut_last_frame_leaves_the_rest_of_the_window_whole() {
        // A recording that was cut: only its last frame goes, and the audio after it stays.
        let dir = TestDirectory::new();
        let source = write_file(&dir, &checked_recording(&[119], false).0);
        let start = source.head().first_frame_offset;
        let (outcome, video) = whole_window(&source);
        assert!(outcome.reached_end);
        assert_eq!(outcome.next, None);
        let (frames, audio) = written_frames(&video, source.head_bytes_at(start).len());
        assert_eq!(frames, (0..119).collect::<Vec<_>>());
        assert_eq!(audio, 120);
    }

    #[test]
    fn a_window_whose_start_keyframe_is_cut_starts_its_video_at_the_next_keyframe() {
        let dir = TestDirectory::new();
        let (bytes, offsets) = checked_recording(&[30], false);
        let source = write_file(&dir, &bytes);
        let (outcome, video) = window_from(&source, offsets[30], 30 * 33, 600_000);
        assert!(outcome.reached_end);
        let (frames, audio) = written_frames(&video, source.head_bytes_at(offsets[30]).len());
        assert_eq!(frames, (60..120).collect::<Vec<_>>());
        assert_eq!(audio, 90);
    }

    #[test]
    fn a_window_ends_neither_at_a_cut_keyframe_nor_at_the_keyframe_after_a_cut() {
        // The time limit of 900 ms lies at keyframe 30.
        let dir = TestDirectory::new();
        let (bytes, offsets) = checked_recording(&[30], false);
        let source = write_file(&dir, &bytes);
        let start = source.head().first_frame_offset;
        let (outcome, _) = window_from(&source, start, 0, 900);
        assert_eq!(outcome.next.map(|next| next.offset), Some(offsets[90]));

        let other = TestDirectory::new();
        let (bytes, offsets) = checked_recording(&[20], false);
        let source = write_file(&other, &bytes);
        let start = source.head().first_frame_offset;
        let (outcome, _) = window_from(&source, start, 0, 900);
        assert_eq!(outcome.next.map(|next| next.offset), Some(offsets[60]));
    }

    #[test]
    fn a_new_configuration_after_a_cut_frame_still_ends_the_window_at_the_next_keyframe() {
        let dir = TestDirectory::new();
        let (bytes, offsets) = checked_recording(&[40], true);
        let source = write_file(&dir, &bytes);
        let (outcome, _) = whole_window(&source);
        assert_eq!(outcome.next.map(|next| next.offset), Some(offsets[60]));
        assert!(source.has_config_change());

        // The window after a new configuration checks with its own head, so the read on after
        // the configuration ends at a cut keyframe too.
        let other = TestDirectory::new();
        let (bytes, offsets) = checked_recording(&[40, 60], true);
        let source = write_file(&other, &bytes);
        let (outcome, _) = whole_window(&source);
        assert_eq!(outcome.next.map(|next| next.offset), Some(offsets[60]));
    }

    #[test]
    fn the_frames_of_a_real_encoder_split_into_nal_units() {
        let Some(ffmpeg) = ffmpeg() else {
            return;
        };
        let dir = TestDirectory::new();
        let path = sample_flv(&ffmpeg, &dir);
        let source = Arc::new(FlvSource::open(&path, None).unwrap());
        let start = source.head().first_frame_offset;
        let head = source.head_bytes_at(start);
        let (_, config) = head_configs(&head)
            .into_iter()
            .find(|(kind, _)| *kind == TagKind::Video)
            .unwrap();
        assert_eq!(nal_length_size(&config), Some(4));
        let (outcome, video) = window_from(&source, start, 0, 600_000);
        assert!(outcome.reached_end);
        // Every frame passed the check, so the window holds every byte of the file.
        let len = std::fs::metadata(&path).unwrap().len() as usize;
        assert_eq!(video.len(), head.len() + len - start as usize);
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
