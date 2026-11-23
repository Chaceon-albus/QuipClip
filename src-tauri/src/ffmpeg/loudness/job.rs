//! The run of one measurement of loudness (ADR 061): the process that writes the audio of an
//! export, and the meter that reads it.
//!
//! `commands::loudness` prepares the run as an export prepares (ADR 016, ADR 050). This module
//! starts the process in the work directory, reads its WAV stream with
//! [`super::wav::read_header`] and [`super::meter::LoudnessMeter`], reports the progress, and
//! decides how the run ended ([`decide`]).
//!
//! A zero exit status is not a complete measurement, as it is not a successful export (ADR 016).
//! The run is complete only when FFmpeg exits 0 and the audio that the meter read lasts at least
//! the duration of the export less [`AUDIO_DURATION_SHORT_TOLERANCE_MS`].

use super::meter::{Loudness, LoudnessMeter};
use super::wav::{self, WavError};
use crate::ffmpeg::export::verify::AUDIO_DURATION_SHORT_TOLERANCE_MS;
use crate::ffmpeg::export::ExportErrorCode;
use crate::ffmpeg::waveform::registry::JobHandle;
use crate::procutil::command_without_console;
use crate::time::Rational;
use serde::Serialize;
use std::io::{self, BufReader, Read};
use std::path::Path;
use std::process::{Child, ExitStatus, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// The least time between two progress messages: at most 4 messages each second (ADR 061).
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// The bytes of one read of the stdout of the process.
const READ_CHUNK: usize = 64 * 1024;

/// The bytes of the end of the error output that a failure keeps as its diagnostic.
const STDERR_TAIL: usize = 4 * 1024;

/// The bytes of one read of the error output.
const STDERR_CHUNK: usize = 4 * 1024;

/// How long the run waits for the process to exit after its stdout ended, before it kills it.
const EXIT_WAIT: Duration = Duration::from_secs(5);

/// How often the run polls a process that it waits for.
const EXIT_POLL: Duration = Duration::from_millis(10);

/// How often the run polls a process that it killed, until it reaps it.
const REAP_POLL: Duration = Duration::from_millis(100);

/// How long the run polls a process that it killed, before it hands it to [`reap_later`].
const REAP_WAIT: Duration = Duration::from_secs(10);

/// How many reads of the status in a row may fail before [`reap`] stops.
const REAP_ERRORS: u32 = 10;

/// How often [`reap`] kills and polls a process that it holds.
const REAP_LATER_POLL: Duration = Duration::from_secs(1);

/// How often the run reads the cancel flag and the events of its reader thread (ADR 056).
pub const POLL: Duration = Duration::from_millis(50);

/// How long the run waits for its reader thread after a cancel, before it ends as canceled
/// (ADR 056).
pub const CANCEL_WAIT: Duration = Duration::from_secs(2);

/// How long the run waits for the end of the error output after the process exited.
const STDERR_WAIT: Duration = Duration::from_secs(1);

/// Microseconds in one second.
const MICROSECONDS_PER_SECOND: u128 = 1_000_000;

/// A progress message: the audio that the meter read, and the audio of the export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename = "progress", rename_all = "camelCase")]
pub struct Progress {
    /// The duration of the audio that the meter read, in microseconds.
    pub read_us: u64,
    /// The duration of the audio of the export, in microseconds.
    pub total_us: u64,
}

/// The page side of a measurement: a Tauri channel in the application, a recorder in the tests.
pub trait LoudnessSink: Send + Sync {
    /// Send a progress message. Return false when the page is gone.
    fn progress(&self, progress: &Progress) -> bool;
    /// Send the end message.
    fn end(&self, message: &EndMessage);
}

/// Why the run of a measurement failed (ADR 011). A failure of the preparation has the code of
/// the export preparation ([`ExportErrorCode`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunCode {
    /// The process did not start.
    SpawnFailed,
    /// The stdout of the process could not be read.
    ReadFailed,
    /// FFmpeg failed, or did not exit after its output ended.
    DecodeFailed,
    /// Rust cannot read the WAV header, or the meter cannot take its format.
    InvalidAudio,
    /// FFmpeg exited 0, but the audio is shorter than the export.
    AudioShort,
}

/// The code of a failed measurement: a code of the export preparation, or a code of the run. Both
/// serialize as their stable name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum EndCode {
    Preparation(ExportErrorCode),
    Run(RunCode),
}

/// How a measurement ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EndStatus {
    Complete,
    Canceled,
    Failed,
}

/// The last message of a measurement.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename = "end", rename_all = "camelCase")]
pub struct EndMessage {
    pub status: EndStatus,
    pub code: Option<EndCode>,
    /// The untranslated diagnostic of a failure (ADR 011).
    pub detail: Option<String>,
    /// The integrated loudness in LUFS, or `None` where the meter gives no value.
    pub integrated_lufs: Option<f64>,
    /// The true peak in dBTP, or `None` where the meter gives no value.
    pub true_peak_dbtp: Option<f64>,
}

impl EndMessage {
    /// A measurement that completed with `loudness`.
    #[must_use]
    pub fn complete(loudness: Loudness) -> Self {
        Self {
            status: EndStatus::Complete,
            code: None,
            detail: None,
            integrated_lufs: loudness.integrated_lufs,
            true_peak_dbtp: loudness.true_peak_dbtp,
        }
    }

    /// A measurement that the page or the application canceled.
    #[must_use]
    pub fn canceled() -> Self {
        Self {
            status: EndStatus::Canceled,
            code: None,
            detail: None,
            integrated_lufs: None,
            true_peak_dbtp: None,
        }
    }

    /// A measurement that failed with `code`.
    #[must_use]
    pub fn failed(code: EndCode, detail: Option<String>) -> Self {
        Self {
            status: EndStatus::Failed,
            code: Some(code),
            detail,
            integrated_lufs: None,
            true_peak_dbtp: None,
        }
    }
}

/// The process of one measurement.
#[derive(Debug, Clone, Copy)]
pub struct RunRequest<'a> {
    /// The located `ffmpeg`.
    pub ffmpeg: &'a Path,
    /// The command, which writes the audio as `pcm_f32le` in WAV on its stdout.
    pub arguments: &'a [String],
    /// The work directory, which holds the graph file that the command names (ADR 055).
    pub working_directory: &'a Path,
    /// The duration of the audio of the export (`PlannedAudio::expected_duration`).
    pub expected_duration: Rational,
}

/// What the meter read from a stream that ended.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StreamRead {
    pub loudness: Loudness,
    /// The whole frames that the meter read.
    pub frames: u64,
    /// The sample rate of the stream, from its header.
    pub sample_rate: u32,
}

impl StreamRead {
    /// The duration of the frames that the meter read, in whole microseconds, for a message.
    #[must_use]
    pub fn read_us(&self) -> u64 {
        frames_us(self.frames, self.sample_rate)
    }
}

/// `frames` at `sample_rate`, in whole microseconds, rounded down.
fn frames_us(frames: u64, sample_rate: u32) -> u64 {
    let micros = u128::from(frames) * MICROSECONDS_PER_SECOND / u128::from(sample_rate.max(1));
    u64::try_from(micros).unwrap_or(u64::MAX)
}

/// Why [`read_stream`] stopped before the end of a valid stream.
#[derive(Debug)]
pub enum ReadFailure {
    /// The header or the format is not one that the meter can read. `ended` is true when the
    /// stream ended in the header, so the process stopped writing on its own.
    Invalid { fault: String, ended: bool },
    /// The stream could not be read.
    Read(io::Error),
    /// The run stopped reading: a cancel, or a page that is gone.
    Stopped,
}

/// A reader that notes the end of its stream.
struct Tracking<R> {
    inner: R,
    ended: bool,
}

impl<R: Read> Read for Tracking<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(buffer)?;
        if count == 0 && !buffer.is_empty() {
            self.ended = true;
        }
        Ok(count)
    }
}

/// Read a WAV stream to its end and measure it.
///
/// `stop` is read before each read: a true answer ends the read with [`ReadFailure::Stopped`].
/// `progress` gets a message at most once each [`PROGRESS_INTERVAL`], and a false answer, for a
/// page that is gone, also ends the read with [`ReadFailure::Stopped`]. `total_us` is the
/// duration of the export, which the messages carry.
pub fn read_stream(
    reader: impl Read,
    total_us: u64,
    stop: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(&Progress) -> bool,
) -> Result<StreamRead, ReadFailure> {
    let mut reader = Tracking {
        inner: reader,
        ended: false,
    };
    let format = wav::read_header(&mut reader).map_err(|error| match error {
        WavError::Read(error) => ReadFailure::Read(error),
        WavError::Invalid(fault) => ReadFailure::Invalid {
            fault,
            ended: reader.ended,
        },
    })?;
    let mut meter = LoudnessMeter::new(&format).map_err(|error| ReadFailure::Invalid {
        fault: error.to_string(),
        ended: false,
    })?;
    let mut buffer = vec![0u8; READ_CHUNK];
    let mut last_progress = Instant::now();
    loop {
        if stop() {
            return Err(ReadFailure::Stopped);
        }
        let count = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(ReadFailure::Read(error)),
        };
        meter
            .add_bytes(&buffer[..count])
            .map_err(|error| ReadFailure::Invalid {
                fault: error.to_string(),
                ended: false,
            })?;
        if last_progress.elapsed() >= PROGRESS_INTERVAL {
            last_progress = Instant::now();
            let message = Progress {
                read_us: frames_us(meter.frames(), format.sample_rate),
                total_us,
            };
            if !progress(&message) {
                return Err(ReadFailure::Stopped);
            }
        }
    }
    let frames = meter.frames();
    Ok(StreamRead {
        loudness: meter.finish(),
        frames,
        sample_rate: format.sample_rate,
    })
}

/// How the process ended.
#[derive(Debug)]
pub enum Exit {
    /// The process exited with this status.
    Status(ExitStatus),
    /// The process did not exit in [`EXIT_WAIT`] after its stdout ended, and the run killed it.
    Hung,
    /// The status could not be read.
    Unknown(String),
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq)]
pub enum RunOutcome {
    Complete(Loudness),
    Canceled,
    Failed(RunCode, Option<String>),
}

/// `seconds` in whole microseconds, rounded down.
#[must_use]
pub fn microseconds(seconds: Rational) -> u64 {
    let micros =
        i128::from(seconds.num()) * MICROSECONDS_PER_SECOND as i128 / i128::from(seconds.den());
    u64::try_from(micros.max(0)).unwrap_or(u64::MAX)
}

/// True when `frames` at `sample_rate` last at least `expected` less
/// [`AUDIO_DURATION_SHORT_TOLERANCE_MS`]. The comparison is exact: no duration is rounded.
fn lasts_long_enough(frames: u64, sample_rate: u32, expected: Rational) -> bool {
    // frames / rate + tolerance / 1000 >= num / den, multiplied by 1000 × rate × den, all
    // positive. A left side too large for `u128` is far longer than any export.
    let rate = u128::from(sample_rate.max(1));
    let tolerance = u128::try_from(AUDIO_DURATION_SHORT_TOLERANCE_MS).unwrap_or(0);
    let (Ok(num), Ok(den)) = (
        u128::try_from(expected.num()),
        u128::try_from(expected.den()),
    ) else {
        // A duration that is not positive asks for no audio.
        return true;
    };
    let read = (1_000 * u128::from(frames))
        .checked_add(tolerance * rate)
        .and_then(|read| read.checked_mul(den));
    match read {
        Some(read) => read >= 1_000 * num * rate,
        None => true,
    }
}

/// `reason`, with the end of the error output of FFmpeg when it has one (ADR 011).
fn with_stderr(reason: String, stderr: &str) -> String {
    let tail = stderr.trim();
    if tail.is_empty() {
        reason
    } else {
        format!("{reason}\n{tail}")
    }
}

/// Decide how a run ended, from what it read and how its process exited.
///
/// The rules, in order:
///
/// 1. A canceled run is canceled, whatever else happened. A read that stopped for a page that
///    is gone is canceled too.
/// 2. A failed read of the stdout is `readFailed`.
/// 3. A header or a format that the meter cannot read, while the process still wrote, is
///    `invalidAudio`. The run killed the process, so its exit says nothing.
/// 4. A process that did not exit, or that exited with a failure, is `decodeFailed`. A stream that
///    ended in its header comes here first, because a process that failed before it wrote
///    explains the short header.
/// 5. A stream that ended in its header of a process that exited 0 is `invalidAudio`.
/// 6. Audio shorter than `expected` less [`AUDIO_DURATION_SHORT_TOLERANCE_MS`] is `audioShort`.
/// 7. Otherwise the run is complete.
///
/// Each failure keeps the end of the error output of FFmpeg in its detail, when there is one.
#[must_use]
pub fn decide(
    canceled: bool,
    read: Result<StreamRead, ReadFailure>,
    exit: &Exit,
    stderr: &str,
    expected: Rational,
) -> RunOutcome {
    if canceled {
        return RunOutcome::Canceled;
    }
    let failed =
        |code: RunCode, reason: String| RunOutcome::Failed(code, Some(with_stderr(reason, stderr)));
    let read = match read {
        Err(ReadFailure::Stopped) => return RunOutcome::Canceled,
        Err(ReadFailure::Read(error)) => return failed(RunCode::ReadFailed, error.to_string()),
        Err(ReadFailure::Invalid {
            fault,
            ended: false,
        }) => return failed(RunCode::InvalidAudio, fault),
        other => other,
    };
    match exit {
        Exit::Hung => {
            return failed(
                RunCode::DecodeFailed,
                "ffmpeg did not exit after its output ended".to_owned(),
            )
        }
        Exit::Unknown(error) => return failed(RunCode::DecodeFailed, error.clone()),
        Exit::Status(status) if !status.success() => {
            return failed(RunCode::DecodeFailed, format!("ffmpeg ended with {status}"))
        }
        Exit::Status(_) => {}
    }
    let read = match read {
        Ok(read) => read,
        Err(ReadFailure::Invalid { fault, .. }) => return failed(RunCode::InvalidAudio, fault),
        Err(_) => unreachable!("the other failures returned above"),
    };
    if !lasts_long_enough(read.frames, read.sample_rate, expected) {
        return failed(
            RunCode::AudioShort,
            format!(
                "the meter read {} ms of {} ms",
                read.read_us() / 1_000,
                microseconds(expected) / 1_000
            ),
        );
    }
    RunOutcome::Complete(read.loudness)
}

/// What the reader thread of a run sends to the run.
enum ReaderEvent {
    Progress(Progress),
    Done(Result<StreamRead, ReadFailure>),
}

/// Run the process of one measurement and measure its audio.
///
/// The process starts with no console window (ADR 018), and `handle` adopts it, so a cancel and
/// the exit of the application kill it. The read of its stdout runs on a reader thread, and the
/// run polls every [`POLL`], as the envelope job of ADR 056 does:
///
/// - A progress message goes to `sink`. A page that is gone cancels the job.
/// - A cancel kills the process, and the run waits at most [`CANCEL_WAIT`] for the reader. Then it
///   ends as canceled, also when a pipe stays open, for example in a descendant of the process.
/// - A read that fails while the process still writes kills the process at once. Otherwise the
///   run waits up to [`EXIT_WAIT`] for its exit, and then kills it.
/// - The end of the error output comes from a thread that keeps it as it reads. The run does not
///   wait for the end of that thread longer than [`STDERR_WAIT`].
///
/// A guard kills and reaps the process on every path out of this function, a panic included. A
/// process that a kill does not end in [`REAP_WAIT`] goes to a thread that kills and reaps it
/// later, so it holds no slot.
pub fn run(handle: &JobHandle, request: &RunRequest<'_>, sink: &dyn LoudnessSink) -> RunOutcome {
    let total_us = microseconds(request.expected_duration);
    let spawned = command_without_console(request.ffmpeg)
        .args(request.arguments)
        .current_dir(request.working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => return RunOutcome::Failed(RunCode::SpawnFailed, Some(error.to_string())),
    };
    let stdout = child.stdout.take().expect("stdout was requested as piped");
    let stderr = child.stderr.take().expect("stderr was requested as piped");
    let child = Arc::new(Mutex::new(child));
    handle.adopt(child.clone());
    let guard = ProcessGuard {
        child: child.clone(),
        handle,
        done: false,
    };

    let tail = Arc::new(Mutex::new(Vec::new()));
    let (tail_done, tail_ended) = mpsc::channel::<()>();
    let stderr_started = {
        let tail = tail.clone();
        thread::Builder::new()
            .name("loudness-stderr".to_owned())
            .spawn(move || {
                read_stderr_tail(stderr, &tail);
                let _ = tail_done.send(());
            })
    };
    if let Err(error) = stderr_started {
        // No thread reads the error output, so the process must not run on. The guard ends it.
        return RunOutcome::Failed(RunCode::SpawnFailed, Some(error.to_string()));
    }

    let (events, received) = mpsc::channel::<ReaderEvent>();
    let reader_started = {
        let cancel = handle.cancel_flag();
        thread::Builder::new()
            .name("loudness-read".to_owned())
            .spawn(move || {
                let progress_events = events.clone();
                let read = read_stream(
                    BufReader::with_capacity(READ_CHUNK, stdout),
                    total_us,
                    &|| cancel.load(Ordering::SeqCst),
                    &mut |progress| {
                        progress_events
                            .send(ReaderEvent::Progress(*progress))
                            .is_ok()
                    },
                );
                let _ = events.send(ReaderEvent::Done(read));
            })
    };
    if let Err(error) = reader_started {
        return RunOutcome::Failed(RunCode::SpawnFailed, Some(error.to_string()));
    }

    let mut cancel_deadline: Option<Instant> = None;
    let read = loop {
        match received.recv_timeout(POLL) {
            Ok(ReaderEvent::Progress(progress)) => {
                // A page that is gone cancels the job.
                if !sink.progress(&progress) {
                    handle.signal();
                }
            }
            Ok(ReaderEvent::Done(read)) => break Some(read),
            // The reader always sends before it ends, so this is a reader that panicked.
            Err(mpsc::RecvTimeoutError::Disconnected) => break None,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if handle.is_canceled() {
            let now = Instant::now();
            if now >= *cancel_deadline.get_or_insert(now + CANCEL_WAIT) {
                // The reader did not end in time: a pipe stays open. It stays behind, and it ends
                // when the pipe closes.
                break None;
            }
        }
    };
    let Some(read) = read else {
        // The guard kills and reaps the process.
        drop(guard);
        return if handle.is_canceled() {
            RunOutcome::Canceled
        } else {
            RunOutcome::Failed(
                RunCode::ReadFailed,
                Some("the reader of the audio stopped with no result".to_owned()),
            )
        };
    };
    // A canceled run needs neither the exit of its process nor its error output. The guard kills
    // the process, and a process that has not ended goes to the reaper, so the cancel keeps the
    // bound of `CANCEL_WAIT`.
    if handle.is_canceled() {
        drop(guard);
        return RunOutcome::Canceled;
    }
    // A read that stopped while the process still writes leaves it with nobody that reads its
    // output. The run does not need its exit, so it kills it at once.
    let ended_on_its_own = matches!(read, Ok(_) | Err(ReadFailure::Invalid { ended: true, .. }));
    if !ended_on_its_own {
        kill(&child);
    }
    let exit = guard.wait(if ended_on_its_own {
        EXIT_WAIT
    } else {
        Duration::ZERO
    });
    if handle.is_canceled() {
        return RunOutcome::Canceled;
    }
    let _ = tail_ended.recv_timeout(STDERR_WAIT);
    let stderr =
        String::from_utf8_lossy(&tail.lock().unwrap_or_else(PoisonError::into_inner)).into_owned();
    decide(
        handle.is_canceled(),
        read,
        &exit,
        &stderr,
        request.expected_duration,
    )
}

/// The process of a run, adopted by its job. When the guard drops before [`ProcessGuard::wait`],
/// as on an early return or a panic, it kills and reaps the process and releases it from the job.
struct ProcessGuard<'a> {
    child: Arc<Mutex<Child>>,
    handle: &'a JobHandle,
    done: bool,
}

impl ProcessGuard<'_> {
    /// Wait up to `wait` for the exit of the process, then kill it and reap it.
    fn wait(mut self, wait: Duration) -> Exit {
        self.done = true;
        let handle = self.handle;
        let exit = wait_for_exit(&self.child, wait, &|| handle.is_canceled());
        self.handle.release(&self.child);
        exit
    }
}

impl Drop for ProcessGuard<'_> {
    /// Kill the process and reap it if it already ended. One that has not ended goes to
    /// [`reap_later`], so a cancel ends the run within [`CANCEL_WAIT`] as ADR 056 states.
    fn drop(&mut self) {
        if !self.done {
            kill(&self.child);
            let reaped = matches!(
                self.child
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .try_wait(),
                Ok(Some(_))
            );
            if !reaped {
                reap_later(self.child.clone());
            }
            self.handle.release(&self.child);
        }
    }
}

/// Send the kill to `child`, without waiting.
fn kill(child: &Arc<Mutex<Child>>) {
    let _ = child.lock().unwrap_or_else(PoisonError::into_inner).kill();
}

/// Wait up to `wait` for the exit of `child`, then kill it and reap it.
///
/// Short polls, not a blocking wait: the handle of the job locks the child to kill it. A process
/// that the run killed is polled up to [`REAP_WAIT`] more. One that is still not reaped then, or
/// whose status cannot be read, goes to [`reap_later`], so it cannot hold the slot of the
/// measurements. A cancel (`canceled`) ends both waits at once: the process gets the kill and goes
/// to [`reap_later`].
fn wait_for_exit(child: &Arc<Mutex<Child>>, wait: Duration, canceled: &dyn Fn() -> bool) -> Exit {
    let deadline = Instant::now() + wait;
    let mut killed_at: Option<Instant> = None;
    loop {
        let polled = child
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .try_wait();
        match polled {
            // The status of a process that the run killed says nothing about FFmpeg.
            Ok(Some(_)) if killed_at.is_some() => return Exit::Hung,
            Ok(Some(status)) => return Exit::Status(status),
            Ok(None) if Instant::now() < deadline && !canceled() => thread::sleep(EXIT_POLL),
            Ok(None) => match killed_at {
                None => {
                    kill(child);
                    killed_at = Some(Instant::now());
                }
                Some(at) if at.elapsed() < REAP_WAIT && !canceled() => thread::sleep(REAP_POLL),
                Some(_) => {
                    reap_later(child.clone());
                    return Exit::Hung;
                }
            },
            Err(error) => {
                kill(child);
                reap_later(child.clone());
                return Exit::Unknown(error.to_string());
            }
        }
    }
}

/// Kill and reap `child` on a thread of its own ([`reap`]). When the system refuses the thread,
/// the caller reaps it in place: the kill was sent, so that wait is short for any process that the
/// system can end.
fn reap_later(child: Arc<Mutex<Child>>) {
    let spawned = {
        let child = child.clone();
        thread::Builder::new()
            .name("loudness-reap".to_owned())
            .spawn(move || reap(&child))
    };
    if spawned.is_err() {
        reap(&child);
    }
}

/// Kill and reap `child` until the system gives its status. A status that cannot be read is
/// polled again, and [`REAP_ERRORS`] such reads in a row end the reap: the system then holds no
/// such child to give.
fn reap(child: &Arc<Mutex<Child>>) {
    let mut errors = 0;
    loop {
        let mut locked = child.lock().unwrap_or_else(PoisonError::into_inner);
        match locked.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {
                errors = 0;
                let _ = locked.kill();
            }
            Err(_) if errors + 1 >= REAP_ERRORS => return,
            Err(_) => errors += 1,
        }
        drop(locked);
        thread::sleep(REAP_LATER_POLL);
    }
}

/// Read the error output to its end, and keep its last [`STDERR_TAIL`] bytes in `tail` as it
/// reads, so the run can take the tail without waiting for the end of the output.
fn read_stderr_tail(mut stderr: impl Read, tail: &Mutex<Vec<u8>>) {
    let mut buffer = [0u8; STDERR_CHUNK];
    loop {
        let count = match stderr.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let mut tail = tail.lock().unwrap_or_else(PoisonError::into_inner);
        tail.extend_from_slice(&buffer[..count]);
        if tail.len() > STDERR_TAIL {
            let excess = tail.len() - STDERR_TAIL;
            tail.drain(..excess);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::loudness::wav::tests::ffmpeg_header;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(windows)]
    use std::os::windows::process::ExitStatusExt;

    /// The status of a process that exited with `code`.
    fn exited(code: i32) -> ExitStatus {
        #[cfg(unix)]
        {
            ExitStatus::from_raw(code << 8)
        }
        #[cfg(windows)]
        {
            ExitStatus::from_raw(code as u32)
        }
    }

    /// A WAV stream of FFmpeg in stereo at 48000 Hz with `seconds` of a sine of 1 kHz at -20
    /// dBFS in both channels.
    fn stereo_stream(seconds: f64) -> Vec<u8> {
        let mut bytes = ffmpeg_header("stereo");
        let frames = (48_000.0 * seconds) as usize;
        for frame in 0..frames {
            let value = (0.1
                * (2.0 * std::f64::consts::PI * 1000.0 * frame as f64 / 48_000.0).sin())
                as f32;
            bytes.extend_from_slice(&value.to_le_bytes());
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    fn read(bytes: &[u8]) -> Result<StreamRead, ReadFailure> {
        read_stream(bytes, 0, &|| false, &mut |_| true)
    }

    #[test]
    fn a_whole_stream_gives_its_values_and_its_duration() {
        let read = read(&stereo_stream(2.0)).unwrap();
        assert_eq!(read.frames, 96_000);
        assert_eq!(read.read_us(), 2_000_000);
        let lufs = read.loudness.integrated_lufs.unwrap();
        assert!((lufs + 20.0).abs() < 0.1, "{lufs}");
    }

    #[test]
    fn a_stream_that_ends_in_its_header_is_invalid_and_ended() {
        let header = ffmpeg_header("stereo");
        match read(&header[..20]) {
            Err(ReadFailure::Invalid { ended: true, .. }) => {}
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_header_that_the_meter_cannot_take_is_invalid_and_not_ended() {
        // A valid header of 16-bit PCM, followed by samples: the process still writes.
        let mut bytes = ffmpeg_header("stereo");
        bytes[20..22].copy_from_slice(&1u16.to_le_bytes());
        bytes[34..36].copy_from_slice(&16u16.to_le_bytes());
        bytes[32..34].copy_from_slice(&4u16.to_le_bytes());
        bytes.extend(vec![0u8; 1024]);
        match read(&bytes) {
            Err(ReadFailure::Invalid { ended: false, .. }) => {}
            other => panic!("{other:?}"),
        }
        // A sample that is not finite.
        let mut nan = ffmpeg_header("stereo");
        nan.extend_from_slice(&f32::NAN.to_le_bytes());
        nan.extend_from_slice(&0.0_f32.to_le_bytes());
        match read(&nan) {
            Err(ReadFailure::Invalid {
                ended: false,
                fault,
            }) => {
                assert!(fault.contains("not a finite number"), "{fault}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_stop_or_a_page_that_is_gone_stops_the_read() {
        let bytes = stereo_stream(1.0);
        assert!(matches!(
            read_stream(&bytes[..], 0, &|| true, &mut |_| true),
            Err(ReadFailure::Stopped)
        ));
        // A reader that waits longer than the interval between two messages.
        struct Slow<'a>(&'a [u8]);
        impl Read for Slow<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                thread::sleep(PROGRESS_INTERVAL);
                let count = buffer.len().min(self.0.len()).min(4096);
                buffer[..count].copy_from_slice(&self.0[..count]);
                self.0 = &self.0[count..];
                Ok(count)
            }
        }
        let mut messages = Vec::new();
        let result = read_stream(Slow(&bytes), 1_000_000, &|| false, &mut |progress| {
            messages.push(*progress);
            false
        });
        assert!(matches!(result, Err(ReadFailure::Stopped)));
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].total_us, 1_000_000);
    }

    #[test]
    fn a_failed_read_is_a_read_failure() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("the pipe broke"))
            }
        }
        assert!(matches!(
            read_stream(Broken, 0, &|| false, &mut |_| true),
            Err(ReadFailure::Read(_))
        ));
    }

    /// A read that ended with `frames` frames at 48000 Hz.
    fn complete_read(frames: u64) -> Result<StreamRead, ReadFailure> {
        Ok(StreamRead {
            loudness: Loudness {
                integrated_lufs: Some(-20.0),
                true_peak_dbtp: Some(-19.9),
            },
            frames,
            sample_rate: 48_000,
        })
    }

    fn invalid(ended: bool) -> Result<StreamRead, ReadFailure> {
        Err(ReadFailure::Invalid {
            fault: "x".to_owned(),
            ended,
        })
    }

    #[test]
    fn the_outcome_follows_the_rules_in_their_order() {
        let ok = Exit::Status(exited(0));
        let failed = Exit::Status(exited(1));
        // 2 s of the export, 96,000 frames at 48000 Hz.
        let total = Rational::new(2, 1).unwrap();
        let whole = 96_000;
        let complete = RunOutcome::Complete(Loudness {
            integrated_lufs: Some(-20.0),
            true_peak_dbtp: Some(-19.9),
        });
        // 1. A cancel wins over everything, and a stopped read is a cancel.
        assert_eq!(
            decide(true, complete_read(whole), &ok, "", total),
            RunOutcome::Canceled
        );
        assert_eq!(
            decide(false, Err(ReadFailure::Stopped), &failed, "", total),
            RunOutcome::Canceled
        );
        // 2. A failed read.
        assert!(matches!(
            decide(
                false,
                Err(ReadFailure::Read(io::Error::other("x"))),
                &ok,
                "",
                total
            ),
            RunOutcome::Failed(RunCode::ReadFailed, _)
        ));
        // 3. A format that the meter cannot read while the process wrote: the exit of the
        // process that the run killed says nothing.
        assert!(matches!(
            decide(false, invalid(false), &failed, "", total),
            RunOutcome::Failed(RunCode::InvalidAudio, _)
        ));
        // 4. A failed process, also when its stream ended in the header.
        assert!(matches!(
            decide(false, complete_read(whole), &failed, " decoder error \n", total),
            RunOutcome::Failed(RunCode::DecodeFailed, Some(detail))
                if detail.starts_with("ffmpeg ended with") && detail.ends_with("\ndecoder error")
        ));
        assert!(matches!(
            decide(false, invalid(true), &failed, "", total),
            RunOutcome::Failed(RunCode::DecodeFailed, Some(detail)) if detail.contains("ffmpeg ended with")
        ));
        assert!(matches!(
            decide(false, complete_read(whole), &Exit::Hung, "", total),
            RunOutcome::Failed(RunCode::DecodeFailed, _)
        ));
        // 5. A header that ended early from a process that exited 0.
        assert!(matches!(
            decide(false, invalid(true), &ok, "", total),
            RunOutcome::Failed(RunCode::InvalidAudio, _)
        ));
        // 6. Audio shorter than the export less 100 ms, and audio within the tolerance. The
        // failure keeps the error output of FFmpeg.
        assert_eq!(
            decide(false, complete_read(whole - 4_801), &ok, "warning\n", total),
            RunOutcome::Failed(
                RunCode::AudioShort,
                Some("the meter read 1899 ms of 2000 ms\nwarning".to_owned())
            )
        );
        assert_eq!(
            decide(false, complete_read(whole - 4_800), &ok, "", total),
            complete
        );
        // 7. A complete run, also with audio longer than the export.
        assert_eq!(
            decide(false, complete_read(whole + 2_400), &ok, "", total),
            complete
        );
    }

    #[test]
    fn the_duration_check_rounds_nothing() {
        // 44,124 frames at 44100 Hz are 100.000227 ms short of 99,049 ticks at 90 kHz. Both
        // durations rounded down to microseconds would differ by exactly 100 ms.
        let read = Ok(StreamRead {
            loudness: Loudness {
                integrated_lufs: None,
                true_peak_dbtp: None,
            },
            frames: 44_124,
            sample_rate: 44_100,
        });
        let expected = Rational::new(99_049, 90_000).unwrap();
        assert!(matches!(
            decide(false, read, &Exit::Status(exited(0)), "", expected),
            RunOutcome::Failed(RunCode::AudioShort, _)
        ));
        assert!(lasts_long_enough(44_125, 44_100, expected));
    }

    #[test]
    fn a_duration_rounds_down_to_whole_microseconds() {
        assert_eq!(microseconds(Rational::new(3, 2).unwrap()), 1_500_000);
        assert_eq!(microseconds(Rational::new(1, 3).unwrap()), 333_333);
        assert_eq!(microseconds(Rational::new(1001, 30_000).unwrap()), 33_366);
    }

    /// A folder of a test, with the header of a stereo WAV stream of FFmpeg in `header.wav`.
    #[cfg(unix)]
    struct FakeRun {
        directory: std::path::PathBuf,
    }

    #[cfg(unix)]
    impl FakeRun {
        fn new(name: &str) -> Self {
            let directory = std::env::temp_dir()
                .join(format!("quipclip-loudness-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&directory);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("header.wav"), ffmpeg_header("stereo")).unwrap();
            Self { directory }
        }

        /// Run `/bin/sh -c script` in the folder, as the process of a measurement of 1 s.
        fn run(&self, handle: &JobHandle, script: &str, sink: &dyn LoudnessSink) -> RunOutcome {
            let arguments = ["-c".to_owned(), script.to_owned()];
            run(
                handle,
                &RunRequest {
                    ffmpeg: Path::new("/bin/sh"),
                    arguments: &arguments,
                    working_directory: &self.directory,
                    expected_duration: Rational::new(1, 1).unwrap(),
                },
                sink,
            )
        }
    }

    #[cfg(unix)]
    impl Drop for FakeRun {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    /// A sink that drops what it gets.
    #[cfg(unix)]
    struct Quiet;

    #[cfg(unix)]
    impl LoudnessSink for Quiet {
        fn progress(&self, _: &Progress) -> bool {
            true
        }

        fn end(&self, _: &EndMessage) {}
    }

    /// Wait up to 10 s for `condition`.
    #[cfg(unix)]
    fn wait_until(condition: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /// True while the process `pid` exists, a zombie included.
    #[cfg(unix)]
    fn exists(pid: &str) -> bool {
        crate::procutil::command_without_console("kill")
            .args(["-0", pid])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(unix)]
    #[test]
    fn a_cancel_ends_the_run_in_time_when_a_child_of_the_process_holds_its_pipe() {
        // The process writes a header and starts a child that keeps its stdout open, and the
        // child writes `ready` when it runs. A cancel kills the process, but the pipe stays open,
        // so the reader never ends. The run ends as canceled within `CANCEL_WAIT` all the same,
        // and releases its process (ADR 056).
        let fake = FakeRun::new("pipe");
        let jobs = crate::ffmpeg::waveform::registry::WaveformJobs::default();
        let handle = jobs.begin(1).unwrap();
        let ready = fake.directory.join("ready");
        let canceled_at = Arc::new(Mutex::new(None));
        let canceler = {
            let handle = handle.clone();
            let ready = ready.clone();
            let canceled_at = canceled_at.clone();
            thread::spawn(move || {
                assert!(wait_until(|| ready.exists()));
                *canceled_at.lock().unwrap() = Some(Instant::now());
                handle.signal();
            })
        };
        let outcome = fake.run(
            &handle,
            "cat header.wav; (touch ready; exec sleep 5) & wait",
            &Quiet,
        );
        let ended_at = Instant::now();
        canceler.join().unwrap();
        assert_eq!(outcome, RunOutcome::Canceled);
        let canceled_at = canceled_at.lock().unwrap().unwrap();
        assert!(ended_at - canceled_at < CANCEL_WAIT + Duration::from_secs(1));
        assert_eq!(handle.adopted(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_panic_after_the_spawn_kills_the_process_and_releases_it() {
        // The process writes its id and then silence without end. The sink panics at the first
        // progress message. The guard kills the process, which then ends, and releases it.
        struct Panics;
        impl LoudnessSink for Panics {
            fn progress(&self, _: &Progress) -> bool {
                panic!("the page broke");
            }

            fn end(&self, _: &EndMessage) {}
        }
        let fake = FakeRun::new("panic");
        let jobs = crate::ffmpeg::waveform::registry::WaveformJobs::default();
        let handle = jobs.begin(1).unwrap();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            fake.run(
                &handle,
                "echo $$ > pid; cat header.wav; exec cat /dev/zero",
                &Panics,
            )
        }));
        let payload = outcome.unwrap_err();
        assert_eq!(payload.downcast_ref::<&str>(), Some(&"the page broke"));
        assert_eq!(handle.adopted(), 0);
        let pid = std::fs::read_to_string(fake.directory.join("pid")).unwrap();
        let pid = pid.trim().to_owned();
        assert!(wait_until(|| !exists(&pid)), "the process {pid} still runs");
    }

    #[cfg(unix)]
    #[test]
    fn a_process_that_fails_keeps_its_error_output_in_the_detail() {
        let fake = FakeRun::new("fails");
        let jobs = crate::ffmpeg::waveform::registry::WaveformJobs::default();
        let handle = jobs.begin(1).unwrap();
        let outcome = fake.run(&handle, "echo 'no such filter' >&2; exit 1", &Quiet);
        assert!(matches!(
            outcome,
            RunOutcome::Failed(RunCode::DecodeFailed, Some(detail)) if detail.ends_with("no such filter")
        ));
        assert_eq!(handle.adopted(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_keeps_the_error_output_open_delays_a_failure_by_no_more_than_its_bound() {
        // The process fails after a child of it takes its error output and keeps it open. The
        // run takes the error output that came before, after `STDERR_WAIT` at most.
        let fake = FakeRun::new("stderr");
        let jobs = crate::ffmpeg::waveform::registry::WaveformJobs::default();
        let handle = jobs.begin(1).unwrap();
        let started = Instant::now();
        let outcome = fake.run(
            &handle,
            "echo 'decoder broke' >&2; (exec sleep 5 >/dev/null) & exit 1",
            &Quiet,
        );
        assert!(started.elapsed() < STDERR_WAIT + Duration::from_secs(1));
        assert!(matches!(
            outcome,
            RunOutcome::Failed(RunCode::DecodeFailed, Some(detail)) if detail.ends_with("decoder broke")
        ));
    }

    #[test]
    fn the_end_messages_carry_their_wire_names() {
        let failed = EndMessage::failed(EndCode::Run(RunCode::AudioShort), Some("x".to_owned()));
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            serde_json::json!({
                "type": "end",
                "status": "failed",
                "code": "audioShort",
                "detail": "x",
                "integratedLufs": null,
                "truePeakDbtp": null,
            })
        );
        let preparation = EndMessage::failed(
            EndCode::Preparation(ExportErrorCode::SourceHasNoAudio),
            None,
        );
        assert_eq!(
            serde_json::to_value(&preparation).unwrap()["code"],
            "sourceHasNoAudio"
        );
        let complete = EndMessage::complete(Loudness {
            integrated_lufs: Some(-14.5),
            true_peak_dbtp: None,
        });
        assert_eq!(
            serde_json::to_value(&complete).unwrap(),
            serde_json::json!({
                "type": "end",
                "status": "complete",
                "code": null,
                "detail": null,
                "integratedLufs": -14.5,
                "truePeakDbtp": null,
            })
        );
        assert_eq!(
            serde_json::to_value(Progress {
                read_us: 5,
                total_us: 9,
            })
            .unwrap(),
            serde_json::json!({ "type": "progress", "readUs": 5, "totalUs": 9 })
        );
    }
}
