//! Spawning `ffmpeg`, supervising it for the whole render, and stopping it on request.
//!
//! This is the one stage of the ADR 014 renderer that owns a child process. It takes a
//! finished command line, starts `ffmpeg`, streams the `-progress pipe:1` blocks out to the
//! caller as they arrive, captures a bounded stderr tail for the diagnostic, and kills the
//! child when the user cancels. It builds no arguments, reads no settings, and touches no
//! file: [`super::output::PendingOutput`] owns the temporary output, and the caller decides
//! what the outcome means.
//!
//! # There is no deadline here, on purpose
//!
//! [`capabilities::smoke::run_with_timeout`](crate::ffmpeg::capabilities::smoke::run_with_timeout)
//! looks like the same function and is not. A smoke test encodes 0.2 s of black and must be
//! killed at a fixed timeout, because ADR 006's whole problem is a broken hardware encoder
//! that hangs instead of failing. An export legitimately runs for an hour: any deadline this
//! module could pick would be either useless or a truncated render. Cancellation replaces the
//! timeout, so the only thing that ends a healthy run early is the user asking for it.
//!
//! # Three threads, and why the callback stays on the caller's
//!
//! The child gets two pipes, and both must be drained from the moment it spawns:
//!
//! - **stderr**, on its own thread, through
//!   [`read_capped_tail`](crate::ffmpeg::capabilities::smoke::read_capped_tail). This is not a
//!   nicety. A chatty `ffmpeg` fills the pipe's operating-system buffer and then blocks *inside
//!   a write* before it can exit, so an undrained pipe turns a finished encode into a hang that
//!   only cancellation can end. `read_capped_tail` keeps reading past its cap for exactly this
//!   reason, which is why it is `pub(crate)` and shared with `read_capped` rather than copied
//!   here. It retains the *last* bytes: `ffmpeg` writes its reason for stopping last.
//! - **stdout**, on a second thread, parsed into [`ProgressSnapshot`] values and sent down an
//!   unbounded channel. The supervising thread cannot read this pipe itself: `read_until`
//!   blocks until `ffmpeg` writes a line, an encode can go seconds between progress blocks,
//!   and a supervisor parked in a blocking read is a supervisor that is not polling the
//!   cancel flag.
//!
//! The progress callback then runs on the **caller's** thread, fed from the channel on each
//! poll tick, which is why `F` carries no `Send` bound. The caller is a Tauri worker that
//! emits an event per snapshot; keeping the callback on its own thread means it can hold
//! whatever non-`Send` state it likes, and it makes the ordering guarantee trivial to state:
//! snapshots reach the callback in the order `ffmpeg` produced them, one at a time, with no
//! lock for the caller to reason about.
//!
//! # The child is owned by a drop guard, like everything else in this module tree
//!
//! The callback runs on the supervising thread, so a panic in it unwinds through the middle of
//! the supervision loop, and dropping a [`Child`] neither kills nor reaps the process it names.
//! [`ChildGuard`] therefore owns the child from the moment of the spawn and kills and reaps it
//! on the way out of every path, the unwind included -- the same discipline
//! [`super::registry::ExportSlot`] applies to the export slot and
//! [`super::output::PendingOutput`] applies to the temporary file, and for the same reason: a
//! panic is an exit path no `?` and no `match` covers. Without it, an orphaned `ffmpeg` outlives
//! both of those guards and keeps encoding into a file they have already deleted, while the slot
//! they freed lets the next export start against the same destination.
//!
//! # The progress parser must never be able to kill an export
//!
//! [`super::progress`]'s module documentation is explicit about how this stage has to read the
//! pipe, and the obvious reader is the wrong one: `BufReader::lines()` answers
//! `Err(InvalidData)` for a line that is not valid UTF-8, and a `?` on that error would abort
//! an export that is encoding perfectly well -- the exact failure that parser was written to
//! make impossible, reintroduced one layer up. [`pump_progress`] therefore reads with
//! `read_until(b'\n')` and [`String::from_utf8_lossy`], so a byte sequence `ffmpeg` never meant
//! to write costs a field, or at worst one block boundary, instead of the export;
//! [`pump_progress`] sets out exactly what each case costs and why the final frame count
//! survives both.
//!
//! # A zero exit status is not a successful export. Read this before you trust it
//!
//! [`ExportProcessStatus::Exited`] with `success: true` means one thing only: the process
//! exited zero. It does **not** mean a video was written, and the caller must not commit the
//! output on that basis alone.
//!
//! Measured on ffmpeg 9.0.1: with the output path already present and no `-y` on the command
//! line, `ffmpeg` prints `File '<path>' already exists. Exiting.` and **exits 0** without
//! writing a frame, because fftools maps `AVERROR_EXIT` onto exit code zero. The renderer
//! reserves its temporary output before it spawns (see [`super::output::PendingOutput`]), so
//! that path always exists and is always zero bytes at spawn time -- this is a live failure
//! mode of this pipeline, not a hypothetical one. A caller that gates
//! [`super::output::PendingOutput::commit`] on `success` alone renames an empty file over the
//! user's video and reports a completed export.
//!
//! Nothing this module can observe distinguishes that from a healthy run: the child exited
//! zero and said so on a stderr this module only captures. **The caller must compare
//! [`ExportProcessOutcome::last_progress`]'s final `frame` count against
//! [`super::ExportPlan::expected_frames`] and report
//! [`super::ExportErrorCode::FrameCountMismatch`] when they differ** (ADR 014, "Progress").
//! That comparison is the only thing standing between this failure and a destroyed source
//! file, and it also catches the failure ADR 014 measurement 9 describes, where a seek that
//! landed after its target silently dropped frames from the cut.
//!
//! # Kill the child, not a shell around it
//!
//! Killing a process does not kill its children, and the pipes this module drains are
//! inherited by every one of them: a child that is really a shell wrapping `ffmpeg` would
//! die on cancel while `ffmpeg` kept the pipes open, and the joins below would then block
//! until the encode finished on its own -- turning cancellation into a wait. The renderer
//! spawns the `ffmpeg` executable directly, with no shell, so `kill` closes both pipes at
//! once and every join returns immediately. The tests keep to the same rule.

use super::{ProgressReader, ProgressSnapshot};
use crate::ffmpeg::capabilities::smoke::{read_capped_tail, stderr_tail};
use crate::procutil::command_without_console;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

/// The largest number of stderr bytes [`run_export_process`] retains from one export.
///
/// This is a **tail** cap: [`read_capped_tail`] keeps the **last** 8 KiB in a ring buffer and
/// keeps reading past it, so a chatty child is still drained and can never block on a full
/// pipe.
///
/// The tail is the end that carries the answer. `ffmpeg` writes its reason for stopping as its
/// last line, so a head capture on a build that floods stderr discards the fatal message and no
/// amount of tailing [`ExportProcessOutcome::stderr_detail`] can recover it. That matters beyond
/// the diagnostic: ADR 016 defers the `encoderUnavailable` pre-check and leans on this text as
/// its stand-in, which makes it the only thing in the export path that can explain a bad
/// encoder. At `-loglevel error` (ADR 014) a run that reaches 8 KiB is repeating one line
/// thousands of times, so the head is the least informative half exactly when it differs from
/// the tail.
///
/// `capabilities::smoke`'s `STDERR_CAPTURE_LIMIT` and `ffmpeg::probe`'s are the same size and
/// both bound a **head**. The three stay separate constants on purpose: they no longer bound
/// the same end of a stream, so one shared constant would assert an equality that is not true.
const STDERR_CAPTURE_LIMIT: usize = 8 * 1024;

/// The largest number of stderr-tail bytes [`ExportProcessOutcome::stderr_detail`] returns.
///
/// Matches the limit the capability probe puts on its own `detail` field, for the same
/// reason: this text travels to the frontend beside an [`super::ExportErrorCode`], where it is
/// a diagnostic a user can copy into a bug report, never the message the interface shows
/// (ADR 011).
const STDERR_DETAIL_LIMIT: usize = 512;

/// The largest single stdout line [`pump_progress`] will buffer before it gives up on that line.
///
/// A `-progress` line is a short `key=value` pair -- the longest `ffmpeg` writes is an
/// `out_time` of about thirty bytes -- so 64 KiB is not a limit any real line approaches. It
/// bounds the failure where nothing on the pipe is a line at all: `read_until` grows a single
/// allocation until it meets a newline, so a child that writes a gigabyte without one would
/// otherwise be answered by growing a gigabyte-long `Vec` inside the export worker.
const MAX_PROGRESS_LINE_BYTES: usize = 64 * 1024;

/// One export process to run: the executable, its arguments, the flag that stops it, and how
/// often to look at that flag.
///
/// The arguments arrive fully built. This module adds nothing to them -- not `-y`, not
/// `-nostdin`, not `-progress pipe:1` -- because ADR 014 fixes the command shape in one place
/// and a flag injected here would be invisible to the stage that reasons about it.
#[derive(Debug, Clone, Copy)]
pub struct ExportProcessRequest<'a> {
    /// The `ffmpeg` executable, as located by [`crate::ffmpeg::locate`].
    ///
    /// This must be `ffmpeg` itself and not a shell that runs it; the module documentation
    /// explains what a wrapper process does to cancellation.
    pub ffmpeg: &'a Path,
    /// The complete argument list, in ADR 014's order.
    ///
    /// Two of those arguments are load-bearing for this module and are checked nowhere:
    /// `-progress pipe:1 -nostats`, without which stdout carries nothing to parse and every
    /// snapshot stays `None`, and `-y`, without which the run ends in the silent zero-exit
    /// refusal the module documentation describes.
    pub arguments: &'a [String],
    /// The cancellation flag, normally [`super::registry::ExportSlot::cancel_flag`].
    ///
    /// Read with [`Ordering::SeqCst`], to pair with [`super::registry::ExportRegistry::cancel`]'s
    /// store.
    pub cancel: &'a AtomicBool,
    /// How long to sleep between two looks at the child and the cancel flag.
    ///
    /// This is the whole latency budget of a cancel request, and also of a progress snapshot
    /// reaching the callback, so it belongs on the caller's side of the interface rather than
    /// as a constant in here: the tests drive it at 10 ms, and the application picks something
    /// closer to the rate at which a progress bar can usefully be redrawn.
    pub poll: Duration,
}

/// How an export process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportProcessStatus {
    /// The process ran to completion on its own.
    ///
    /// # `success: true` is not a successful export
    ///
    /// It means the process exited zero, and nothing more. `ffmpeg` exits zero when it
    /// refuses to overwrite an existing output, writing no frames at all; the module
    /// documentation gives the measurement. Before it commits the output the caller **must**
    /// compare the final `frame` count in [`ExportProcessOutcome::last_progress`] with
    /// [`super::ExportPlan::expected_frames`], exactly as ADR 014's "Progress" section
    /// requires, and it must re-read the cancel flag as
    /// [`super::registry::ExportRegistry::cancel`] documents.
    Exited {
        /// The process's exit code, or `None` when a signal terminated it (Unix only).
        code: Option<i32>,
        /// Whether the process reported success. On Unix this means exit code zero.
        success: bool,
    },
    /// The cancel flag was set, so no output should be published.
    ///
    /// This covers both shapes of a cancellation: a flag that was already set before the
    /// spawn, where no process ever ran, and a flag set during the render, where the child
    /// was killed and reaped. The caller treats them identically -- discard the temporary
    /// file, report [`super::ExportErrorCode::Canceled`] -- so they are deliberately not two
    /// variants.
    Canceled,
}

/// Everything one export process left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportProcessOutcome {
    /// How the process ended.
    pub status: ExportProcessStatus,
    /// Up to [`STDERR_CAPTURE_LIMIT`] bytes from the end of the child's stderr, captured on
    /// a separate thread while it ran.
    pub stderr: Vec<u8>,
    /// The last complete `-progress` block the child wrote, or `None` when it wrote none.
    ///
    /// This is the value ADR 014's frame-count comparison reads. `None` after an
    /// [`ExportProcessStatus::Exited`] is itself a finding, not an absence of information: an
    /// `ffmpeg` that exited zero having never written a progress block encoded nothing, which
    /// is exactly what the missing-`-y` refusal looks like from here.
    ///
    /// A snapshot whose `done` flag is set is the `progress=end` block, the last one `ffmpeg`
    /// writes. A killed or crashed child leaves the last `progress=continue` block instead,
    /// with a frame count short of the plan's expectation.
    pub last_progress: Option<ProgressSnapshot>,
}

impl ExportProcessOutcome {
    /// Up to [`STDERR_DETAIL_LIMIT`] bytes from the end of the child's stderr, as text.
    ///
    /// This is the end of the stream whether or not the capture hit its cap. The capture itself
    /// is a tail ([`read_capped_tail`]), so a child that wrote less than
    /// [`STDERR_CAPTURE_LIMIT`] leaves its whole stderr here to cut from, and one that wrote
    /// more leaves its last 8 KiB -- either way the line that says why the encode stopped is
    /// inside it.
    ///
    /// The cut itself is [`stderr_tail`], the same function the capability probe fills its own
    /// `detail` field with, so both paths cut on a UTF-8 character boundary the same way and
    /// neither hand-rolls a slice that can split a multi-byte character in half.
    #[must_use]
    pub fn stderr_detail(&self) -> Option<String> {
        stderr_tail(&self.stderr, STDERR_DETAIL_LIMIT)
    }
}

/// Run one `ffmpeg` export to completion, to a cancellation, or to a spawn failure.
///
/// `on_progress` is called once per completed `-progress` block, in order, on this thread.
/// Snapshots that arrive between two polls are delivered together on the next one, and the
/// blocks `ffmpeg` wrote just before it exited are delivered after the wait, so the final
/// `progress=end` block reaches the callback even though the process is already gone by then.
///
/// A panic in `on_progress` is contained but still costly. It runs on this thread, inside the
/// supervision loop, so a panic unwinds straight out of this function: [`ChildGuard`] kills and
/// reaps `ffmpeg` on the way past, so no encoder is orphaned and no zombie is left, but the
/// outcome is gone -- no status, no stderr, no frame count -- and the caller can only report
/// the panic. An event emit that can fail should report or ignore the failure and let the
/// render finish.
///
/// # Errors
///
/// The `io::Error` cases are the ones where the operating system refused: the spawn failed
/// (map it to [`super::ExportErrorCode::FfmpegSpawnFailed`]), or waiting on or killing the
/// child failed. A child that ran and exited non-zero is **not** an error here; it is
/// [`ExportProcessStatus::Exited`] with `success: false`, together with the stderr that says
/// why, and the caller maps that to [`super::ExportErrorCode::FfmpegProcessFailed`].
///
/// # A set flag means no process at all
///
/// [`super::registry::ExportRegistry::begin`] states this obligation and it is discharged
/// here: the flag is read *before* the spawn, and a cancel that landed while the caller was
/// still probing the source and reserving the output returns
/// [`ExportProcessStatus::Canceled`] without starting `ffmpeg`. Without that check a run the
/// user already stopped would spawn an encoder and write to the reserved file for a whole
/// poll interval before anyone looked at the flag.
///
/// # What the caller still has to do
///
/// Two checks belong to the caller and cannot be moved in here, because this module sees
/// neither the plan nor the output file:
///
/// 1. Compare the final `frame` count against [`super::ExportPlan::expected_frames`]. A zero
///    exit status alone does not mean a video was written; the module documentation gives the
///    measured case where it means the opposite.
/// 2. Read the cancel flag once more, after this returns and before publishing the output, as
///    [`super::registry::ExportRegistry::cancel`] requires. A cancel that lands in the window
///    between `ffmpeg` exiting and the rename is reported here as `Exited`, because that is
///    what the process did.
pub fn run_export_process<F: FnMut(&ProgressSnapshot)>(
    request: ExportProcessRequest<'_>,
    mut on_progress: F,
) -> io::Result<ExportProcessOutcome> {
    let ExportProcessRequest {
        ffmpeg,
        arguments,
        cancel,
        poll,
    } = request;

    // Before the spawn, not after it. See the section above.
    if cancel.load(Ordering::SeqCst) {
        return Ok(ExportProcessOutcome {
            status: ExportProcessStatus::Canceled,
            stderr: Vec::new(),
            last_progress: None,
        });
    }

    // Owned by a guard from the moment it exists. Everything below can unwind -- the caller's
    // progress callback most of all -- and a bare `Child` local would survive that unwind as an
    // orphaned encoder; see [`ChildGuard`].
    let mut child = ChildGuard::new(
        command_without_console(ffmpeg)
            .args(arguments)
            // ADR 004 and ADR 014 both put `-nostdin` on the command line, and this null
            // stdin says the same thing a second way. The flag stops `ffmpeg` prompting; the
            // null handle stops it inheriting the parent's stdin at all, so a build or a fork
            // that ignores the flag still cannot park the export waiting on a console that,
            // in a packaged Tauri application, does not exist. The smoke path pairs them the
            // same way.
            .stdin(Stdio::null())
            // `-progress pipe:1` writes here. Piped, never inherited: this is the data this
            // module exists to read.
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?,
    );

    let stderr = child
        .child_mut()
        .stderr
        .take()
        .expect("stderr was requested as piped above");
    let stderr_thread = thread::spawn(move || read_capped_tail(stderr, STDERR_CAPTURE_LIMIT));

    let stdout = child
        .child_mut()
        .stdout
        .take()
        .expect("stdout was requested as piped above");
    let (progress_sender, progress_receiver) = mpsc::channel();
    let stdout_thread = thread::spawn(move || {
        // The send result is dropped on purpose. A closed channel means this function has
        // already returned or is unwinding, and stopping the pump there would leave the pipe
        // undrained while the child is possibly still writing to it -- the hang described at
        // the top of this file. Draining to end of stream costs nothing and cannot block the
        // child, which is the same discipline `read_capped_tail` follows past its own cap.
        pump_progress(stdout, |snapshot| {
            let _ = progress_sender.send(snapshot);
        });
    });

    let mut last_progress = None;

    // The supervision loop returns its `Result` into a binding instead of using `?` in the
    // body of this function, for the reason `run_with_timeout` gives: every path out of here,
    // the error paths included, must still join both reader threads, or a failed `try_wait`
    // would abandon them reading pipes nobody ever joins.
    let poll_result = (|| -> io::Result<ExportProcessStatus> {
        loop {
            drain_progress(&progress_receiver, &mut on_progress, &mut last_progress);

            // The cancel flag is read before `try_wait`, so a request that arrives in the
            // same tick as a normal exit is reported as `Canceled` rather than as a success
            // the caller would then have to un-report. Either order leaves the same race --
            // the child can exit between any check and the kill below -- and `kill_and_reap`
            // is what absorbs it.
            if cancel.load(Ordering::SeqCst) {
                kill_and_reap(child.child_mut())?;
                return Ok(ExportProcessStatus::Canceled);
            }

            if let Some(status) = child.child_mut().try_wait()? {
                return Ok(ExportProcessStatus::Exited {
                    code: status.code(),
                    success: status.success(),
                });
            }

            thread::sleep(poll);
        }
    })();

    if poll_result.is_err() {
        // `try_wait` or `kill` failed, so the child may still be running with both pipes
        // open, and joining a reader blocked on a pipe that never closes would hang this
        // thread for as long as the encode would have taken. Both results are discarded: this
        // is a best-effort attempt to close those pipes on a path that is already reporting
        // the first failure, and a second error here would only hide it.
        //
        // `ChildGuard` cannot cover this one. It runs when this function returns, which on
        // this path is *after* the joins below, and by then the hang has already happened.
        let _ = child.child_mut().kill();
        let _ = child.child_mut().wait();
    }

    // Both joins run before the `?` on `poll_result`. Killing the child, or the child exiting
    // on its own, closes both pipes, so each reader reaches end of stream and returns.
    let stderr = stderr_thread.join().unwrap_or_default();
    let stdout_join = stdout_thread.join();

    // Delivered after the join, so this cannot race the pump: every snapshot the child
    // produced has been sent by the time its thread is joined, including the `progress=end`
    // block that a poll loop watching an already-exited process would otherwise never pick
    // up. This is what makes `last_progress` the *final* frame count rather than the
    // second-to-last one, which is the value ADR 014's comparison needs.
    drain_progress(&progress_receiver, &mut on_progress, &mut last_progress);

    // A panic in the pump is not an export failure. The parser it calls cannot fail by
    // design, and even if it found a way to, the encode itself already succeeded or failed on
    // its own terms; losing the progress stream must not turn a finished render into an
    // error, so the frame-count comparison reads whatever was delivered before the panic.
    drop(stdout_join);

    Ok(ExportProcessOutcome {
        status: poll_result?,
        stderr,
        last_progress,
    })
}

/// Read a `-progress` stream to end of stream, calling `emit` once per completed block.
///
/// Split out of [`run_export_process`] so the byte-level behaviour can be tested with a plain
/// [`std::io::Cursor`], with no process and no `ffmpeg` anywhere near it -- the same way
/// `read_capped_tail` is tested.
///
/// Nothing in here can fail upward, which is the point:
///
/// - A line that is not valid UTF-8 is repaired by [`String::from_utf8_lossy`] instead of
///   being reported. `BufReader::lines()`, the reader this replaces, would answer
///   `Err(InvalidData)` for that line, and [`super::progress`]'s module documentation names
///   propagating it as the way to kill a healthy export.
/// - A read error ends the pump instead of propagating. The only errors a closed or broken
///   pipe produces repeat on every following read, so continuing would spin; the export is
///   still supervised, and the exit status is still reported.
/// - A line longer than [`MAX_PROGRESS_LINE_BYTES`] is discarded rather than buffered. A
///   `read_until` with no bound grows one allocation until the allocator refuses, so a stream
///   that never writes a newline would take the application down; the twin of this pump on the
///   stderr side is bounded by [`read_capped_tail`], and this closes the asymmetry.
///
/// # What a bad byte actually costs
///
/// It depends on where it lands, and the worse case is not the obvious one:
///
/// - In a **value**, the field fails to parse and reads as absent -- `frame` becomes `None` for
///   that block. One field, one block.
/// - In a **key**, the key is unrecognised and is skipped. When the mangled key is `progress`
///   itself, that costs a whole block *boundary*: the terminator is not recognised, so the
///   collected keys stay pending and merge into the next block, and the next terminator seals
///   both as one snapshot. The caller sees one fewer snapshot, not a wrong one.
///
/// Neither case disturbs the number ADR 014's comparison reads. Within a merged block the last
/// value of a repeated key wins, so the surviving snapshot carries the *later* block's `frame`,
/// and the final count at `progress=end` is still the count `ffmpeg` reported.
///
/// Only the trailing `\n` is stripped. A `\r` from a CRLF line ending is left on the line
/// deliberately, because [`ProgressReader::push_line`] already removes it and states that it
/// does; removing it twice would put the same assumption in two places.
fn pump_progress(stdout: impl Read, mut emit: impl FnMut(ProgressSnapshot)) {
    let mut reader = BufReader::new(stdout);
    let mut parser = ProgressReader::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        // A fresh `take` per line, so the limit bounds one line rather than the whole stream.
        match (&mut reader)
            .take(MAX_PROGRESS_LINE_BYTES as u64)
            .read_until(b'\n', &mut line)
        {
            Ok(0) => break,
            Ok(_) => {
                if !line.ends_with(b"\n") && line.len() >= MAX_PROGRESS_LINE_BYTES {
                    // The limit cut this line short, so what is in the buffer is a fragment,
                    // not a field. Drop it and resynchronise on the next newline; a `-progress`
                    // key never comes near this length, so the only thing lost is one line of
                    // whatever else got onto this pipe.
                    if !skip_to_newline(&mut reader) {
                        break;
                    }
                    continue;
                }
                let text = String::from_utf8_lossy(&line);
                let text = text.strip_suffix('\n').unwrap_or(text.as_ref());
                if let Some(snapshot) = parser.push_line(text) {
                    emit(snapshot);
                }
            }
            Err(_) => break,
        }
    }
}

/// Discard bytes up to and including the next newline, and report whether one was found.
///
/// Constant memory on purpose: this is what [`pump_progress`] resynchronises with after it
/// refuses an over-long line, so buffering the rest of that line here would reintroduce exactly
/// the unbounded growth the refusal exists to prevent. `false` means end of stream, or a read
/// error, and ends the pump.
fn skip_to_newline(reader: &mut impl BufRead) -> bool {
    loop {
        let Ok(buffer) = reader.fill_buf() else {
            return false;
        };
        if buffer.is_empty() {
            return false;
        }
        match buffer.iter().position(|byte| *byte == b'\n') {
            Some(index) => {
                reader.consume(index + 1);
                return true;
            }
            None => {
                let consumed = buffer.len();
                reader.consume(consumed);
            }
        }
    }
}

/// Hand every snapshot the pump has parsed since the last call to `on_progress`, newest last.
///
/// Never blocks: the supervision loop calls this on every tick, and a blocking receive would
/// park the loop on a child that is busy encoding and therefore silent, which is the same
/// mistake as reading the pipe on this thread.
///
/// Both ways the loop below ends are normal, which is why it treats them alike.
/// [`Empty`](std::sync::mpsc::TryRecvError::Empty) is the child still encoding, and
/// [`Disconnected`](std::sync::mpsc::TryRecvError::Disconnected) is the pump having reached end
/// of stream and finished -- the ordinary end of every export.
/// `try_recv` reports `Disconnected` only once the buffered snapshots are exhausted, so
/// nothing the child wrote is dropped by ending on it.
fn drain_progress<F: FnMut(&ProgressSnapshot)>(
    receiver: &Receiver<ProgressSnapshot>,
    on_progress: &mut F,
    last_progress: &mut Option<ProgressSnapshot>,
) {
    while let Ok(snapshot) = receiver.try_recv() {
        on_progress(&snapshot);
        *last_progress = Some(snapshot);
    }
}

/// A spawned child that is killed and reaped when its scope ends, however that scope ends.
///
/// **This is the module's answer to a panic, and every module around it has the same answer.**
/// [`super::registry::ExportSlot`] releases the single export slot from its [`Drop`] rather
/// than from a call the worker has to remember, because "a panic in the worker is an exit path
/// that no `?` and no `match` covers"; [`super::output::PendingOutput`] deletes its reservation
/// on every exit path, "a panic included". This module owns something neither of those owns --
/// an operating-system process -- and a plain `Child` local is the one thing here that an
/// unwind does *not* clean up: dropping a `Child` neither kills nor reaps it, by design.
///
/// The panic that matters is the caller's own progress callback, which runs on this thread
/// inside the supervision loop. Measured before this guard existed: a callback that panicked on
/// the first snapshot unwound past the kill, past the wait, and past both joins, leaving
/// `ffmpeg` running and, once it finally exited, a zombie parented to the application.
///
/// What that orphan then does is precisely the state the modules above are built to make
/// impossible. The worker's [`super::registry::ExportSlot`] drops and frees the single-flight
/// slot while the orphaned `ffmpeg` is still encoding; the worker's
/// [`super::output::PendingOutput`] drops and deletes the temporary file out from under the
/// process still writing to it; and the next export starts against the same destination with
/// the previous encoder alive. One guard here closes all of it.
///
/// The unwind path does **not** join the reader threads: [`std::thread::JoinHandle`]'s own drop
/// detaches rather than blocks, so they are still running when this guard's drop kills the
/// child. That is the correct order and not a leak. Killing the child closes both pipes, each
/// reader reaches end of stream within the next read, and the two threads finish on their own
/// moments later.
struct ChildGuard {
    child: Child,
}

impl ChildGuard {
    /// Take ownership of a freshly spawned child.
    fn new(child: Child) -> Self {
        Self { child }
    }

    /// The child, for the supervision loop to poll, kill, and reap in the ordinary way.
    fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

impl Drop for ChildGuard {
    /// Kill the child and reap it, on the paths that already did neither.
    ///
    /// Both results are discarded because a drop cannot report and because, on every path that
    /// ended normally, both calls are already no-ops: [`Child::kill`] returns `Ok(())` for a
    /// child whose status this `Child` has already collected, and [`Child::wait`] then answers
    /// from that stored status without touching the operating system. That same stored status
    /// is what makes the kill safe rather than reckless -- it is why this cannot signal a pid
    /// the operating system has since handed to an unrelated process.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Kill a child and reap it, reporting either failure.
///
/// Both calls run unconditionally, as in `run_with_timeout`: the process can exit on its own in
/// the window between the last poll and this kill, and [`Child::wait`] has to run either way so
/// the operating system does not keep the finished process around as a zombie for the lifetime
/// of the application.
///
/// # Why the `InvalidInput` arm is kept, and what it is not
///
/// It is **not** the documented shape of that race. Rust 1.98's [`Child::kill`] says that if the
/// child has already exited, `Ok(())` is returned, and it states that the `ErrorKind` a failure
/// maps to is not part of its compatibility contract. So `InvalidInput` is neither promised for
/// this case nor, on this code path, reachable: `kill_and_reap` is called only from the cancel
/// branch, where the `Child` has just been polled and its status collected or not by
/// `try_wait`, and both of those outcomes leave `kill` returning `Ok`.
///
/// The arm stays because the cost of keeping it is one match arm and the cost of dropping it is
/// an export that reports a spurious `io::Error` -- losing the stderr and the frame count with
/// it -- on any platform or standard library that answers this unspecified case with an error
/// instead of `Ok`. It is tolerance for an uncontracted detail, not a claim about what the
/// contract says.
fn kill_and_reap(child: &mut Child) -> io::Result<()> {
    let kill_result = child.kill();
    let wait_result = child.wait();
    match kill_result {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => {}
        Err(error) => return Err(error),
    }
    wait_result?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::AssertUnwindSafe;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    /// A poll fast enough that a test never waits noticeably on the loop itself.
    const TEST_POLL: Duration = Duration::from_millis(10);

    /// The test binary, standing in for `ffmpeg`.
    ///
    /// The same stand-in `capabilities::smoke`'s tests use, and for the same reason: no test
    /// in this crate may require `ffmpeg` to be installed. Every invocation below passes an
    /// argument, because running the test binary with no arguments would run the whole test
    /// suite again inside itself.
    fn test_binary() -> PathBuf {
        std::env::current_exe().expect("the test binary has a path")
    }

    /// A program that reports its own process id as one `-progress` block and then occupies a
    /// process for 120 seconds, with no shell and no grandchild around it.
    ///
    /// The process id leaves through the progress stream, as the `frame` value of that block.
    /// Neither of the tests that use this helper can reach the `Child` -- one cancels through a
    /// flag, the other unwinds out of the function entirely -- so this is what lets them name
    /// the process afterwards and ask the operating system whether it is still there.
    ///
    /// One process per arm, and that is a requirement rather than tidiness. `exec` replaces the
    /// shell with `sleep`, which keeps the pid the shell just printed; PowerShell's `$PID` is
    /// its own, and it sleeps in that same process. A shell that forked instead would die on
    /// the kill while its child kept the inherited pipes open, and the joins in
    /// `run_export_process` would then block for the full 120 seconds -- in tests that are
    /// asserting the opposite.
    #[cfg(unix)]
    fn pid_reporting_sleeper() -> (PathBuf, Vec<String>) {
        (
            PathBuf::from("/bin/sh"),
            vec![
                "-c".to_owned(),
                "echo frame=$$; echo progress=continue; exec sleep 120".to_owned(),
            ],
        )
    }

    /// The Windows counterpart of [`pid_reporting_sleeper`]. `cmd.exe` cannot report its own
    /// process id, so this arm uses PowerShell, spawned directly rather than through `cmd /c`
    /// so that no quote in the script has to survive `cmd`'s own parsing.
    ///
    /// Both lines go through `[Console]::Out` rather than being written as bare strings. A bare
    /// string goes to PowerShell's success output stream, which the host formats and writes on
    /// its own path; whether that path ends in the same writer `[Console]::Out.Flush()` empties
    /// has not been established here. Writing through `[Console]::Out` removes the question,
    /// because that writer is the one on the parent's stdout pipe.
    ///
    /// This is a precaution, not a fix for a measured defect. The CI failure measured
    /// `24.4525496s` against a 30-second sleep, so the first block had already reached the
    /// callback about 5.5 seconds before the sleep could end: the delay sat in front of the
    /// block, not behind it, and buffering that holds a block until the process exits is ruled
    /// out by that arithmetic. The part that addresses the failure is the assertion change in
    /// `a_cancel_flag_set_during_the_run_kills_the_process_and_reports_canceled`.
    ///
    /// `[Console]::Out.Flush()` stays in the command string as insurance only. .NET builds
    /// `Console.Out` as a `StreamWriter` with `AutoFlush = true`, so `WriteLine` has already
    /// flushed by the time it returns; the explicit flush is harmless and covers a host that
    /// differs, and nothing here leans on it.
    ///
    /// One process per arm, as above: PowerShell's `$PID` is its own, and it sleeps in that
    /// same process, so the pid the test reads is the pid the kill has to reach.
    #[cfg(windows)]
    fn pid_reporting_sleeper() -> (PathBuf, Vec<String>) {
        (
            PathBuf::from("powershell.exe"),
            vec![
                "-NoProfile".to_owned(),
                "-NonInteractive".to_owned(),
                "-Command".to_owned(),
                "[Console]::Out.WriteLine('frame=' + $PID); \
                 [Console]::Out.WriteLine('progress=continue'); [Console]::Out.Flush(); \
                 Start-Sleep -Seconds 120"
                    .to_owned(),
            ],
        )
    }

    /// Whether the operating system has no process with this id left: killed **and** reaped.
    ///
    /// Both arms ask a separate tool rather than making a system call, because this crate takes
    /// no `libc` dependency and this is a test. `ps -p` is the sharper of the two: it lists a
    /// zombie as `<defunct>` and exits zero for it, so a non-zero exit rules out an unreaped
    /// child as well as a live one. Windows has no zombie to rule out -- a terminated process
    /// leaves no `tasklist` entry whether or not its handle has been waited on -- so that arm
    /// proves the kill and takes the reap from the same `Drop` code path.
    ///
    /// A process id can in principle be recycled between the reap and this call, which would
    /// make the answer wrong. Neither platform reuses an id that quickly in practice.
    #[cfg(unix)]
    fn process_is_gone(pid: u64) -> bool {
        !command_without_console("/bin/ps")
            .args(["-p", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("/bin/ps should run")
            .success()
    }

    /// The Windows counterpart of [`process_is_gone`]. `tasklist` exits zero whether or not the
    /// filter matched, printing an informational line when it did not, so the answer is in the
    /// output rather than in the status.
    #[cfg(windows)]
    fn process_is_gone(pid: u64) -> bool {
        let output = command_without_console("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .stdin(Stdio::null())
            .output()
            .expect("tasklist.exe should run");
        !String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
    }

    /// How many complete `-progress` blocks [`flooding_progress_command`] writes.
    ///
    /// The Unix arm uses the volume the failure was measured at. The Windows arm is smaller
    /// because `cmd`'s `for /l` is a slow producer, and a slow producer is also the arm least
    /// likely to leave anything in the pipe at exit; the Unix arm is the one that defends the
    /// post-join drain, and this arm asserts the same invariant more cheaply.
    #[cfg(unix)]
    const FLOOD_BLOCKS: u64 = 200_001;

    /// See the Unix arm.
    #[cfg(windows)]
    const FLOOD_BLOCKS: u64 = 10_000;

    /// A command that writes [`FLOOD_BLOCKS`] complete blocks as fast as it can and then exits.
    ///
    /// `awk` is spawned directly, with the loop in its `BEGIN` block, so this is one process
    /// writing about 6 MB through the pipe in well under a second -- faster than the pump can
    /// parse it, which is the whole point.
    #[cfg(unix)]
    fn flooding_progress_command() -> (PathBuf, Vec<String>) {
        (
            PathBuf::from("/usr/bin/awk"),
            vec![format!(
                r#"BEGIN{{for(i=1;i<={FLOOD_BLOCKS};i++){{print "frame=" i; print "progress=continue"}}}}"#
            )],
        )
    }

    /// The Windows counterpart of [`flooding_progress_command`]. `@echo off` at the front is
    /// what stops the `for` body being echoed to stdout alongside its own output, and the
    /// script again holds no double quote of its own, so `cmd`'s outer-quote stripping leaves
    /// it verbatim.
    #[cfg(windows)]
    fn flooding_progress_command() -> (PathBuf, Vec<String>) {
        (
            PathBuf::from("cmd.exe"),
            vec![
                "/c".to_owned(),
                format!(
                    "@echo off&for /l %i in (1,1,{FLOOD_BLOCKS}) do \
                     (echo frame=%i&echo progress=continue)"
                ),
            ],
        )
    }

    /// A command that writes two complete `-progress` blocks to stdout and exits.
    ///
    /// The block shape is ADR 014's: `frame` lines, then a `progress=` terminator whose value
    /// is `continue` or `end`.
    #[cfg(unix)]
    fn progress_emitting_command() -> (PathBuf, Vec<String>) {
        (
            PathBuf::from("/bin/sh"),
            vec![
                "-c".to_owned(),
                "printf 'frame=1\\nprogress=continue\\nframe=2\\nprogress=end\\n'".to_owned(),
            ],
        )
    }

    /// The Windows counterpart of [`progress_emitting_command`].
    ///
    /// The script holds no double quote of its own, which is what makes it survive the trip
    /// through `cmd.exe`: the argument contains spaces, so Rust wraps it in exactly one pair
    /// of quotes, and `cmd /c` strips exactly that pair before running the rest verbatim.
    #[cfg(windows)]
    fn progress_emitting_command() -> (PathBuf, Vec<String>) {
        (
            PathBuf::from("cmd.exe"),
            vec![
                "/c".to_owned(),
                "echo frame=1&echo progress=continue&echo frame=2&echo progress=end".to_owned(),
            ],
        )
    }

    /// How many lines [`chatty_stderr_command`] writes to stderr.
    const CHATTY_LINES: u32 = 500;

    /// A command that writes far more than [`STDERR_CAPTURE_LIMIT`] bytes to stderr.
    ///
    /// 500 lines of about 40 characters is roughly 20 KiB, comfortably past the 8 KiB cap.
    ///
    /// Every line carries its own number, and that is what makes the capture test worth
    /// anything: a flood of identical bytes reads the same from either end, so a head capture
    /// and a tail capture would both satisfy a length-and-ASCII assertion. Numbered lines let
    /// the test name which end survived.
    #[cfg(unix)]
    fn chatty_stderr_command() -> (PathBuf, Vec<String>) {
        (
            PathBuf::from("/bin/sh"),
            vec![
                "-c".to_owned(),
                format!(
                    "i=1; while [ $i -le {CHATTY_LINES} ]; do \
                     echo line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx >&2; i=$((i+1)); done"
                ),
            ],
        )
    }

    /// The Windows counterpart of [`chatty_stderr_command`]. The `@` matters: command echo is
    /// on for a `for` body run from a command line, so without it the loop would also fill
    /// stdout with a copy of itself.
    ///
    /// The lines are numbered for the reason the Unix arm gives.
    #[cfg(windows)]
    fn chatty_stderr_command() -> (PathBuf, Vec<String>) {
        (
            PathBuf::from("cmd.exe"),
            vec![
                "/c".to_owned(),
                format!(
                    "for /l %i in (1,1,{CHATTY_LINES}) do \
                     @echo line %i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx 1>&2"
                ),
            ],
        )
    }

    /// Run one command with a flag that is never set, collecting every snapshot delivered.
    fn run_to_completion(
        program: &Path,
        arguments: &[String],
    ) -> (ExportProcessOutcome, Vec<ProgressSnapshot>) {
        let cancel = AtomicBool::new(false);
        let mut seen = Vec::new();
        let outcome = run_export_process(
            ExportProcessRequest {
                ffmpeg: program,
                arguments,
                cancel: &cancel,
                poll: TEST_POLL,
            },
            |snapshot| seen.push(*snapshot),
        )
        .expect("the process should spawn and exit on its own");
        (outcome, seen)
    }

    #[test]
    fn a_process_that_exits_zero_is_reported_as_a_successful_exit() {
        // `--list` makes the test harness print its test names and exit zero, which is a
        // portable quick success that does not re-enter the suite the way a bare invocation
        // would.
        let (outcome, _) = run_to_completion(&test_binary(), &["--list".to_owned()]);

        assert!(matches!(
            outcome.status,
            ExportProcessStatus::Exited {
                code: Some(0),
                success: true
            }
        ));
    }

    #[test]
    fn a_process_that_exits_non_zero_is_reported_as_an_unsuccessful_exit() {
        let arguments = vec!["--this-flag-does-not-exist".to_owned()];
        let (outcome, _) = run_to_completion(&test_binary(), &arguments);

        assert!(matches!(
            outcome.status,
            ExportProcessStatus::Exited { success: false, .. }
        ));
        // The distinction this whole module rests on: an unsuccessful exit is an outcome, not
        // an `io::Error`. `run_to_completion` unwrapping the `Result` above is the assertion.
        assert!(outcome.last_progress.is_none());
    }

    #[test]
    fn a_cancel_flag_set_during_the_run_kills_the_process_and_reports_canceled() {
        let (program, arguments) = pid_reporting_sleeper();
        let cancel = AtomicBool::new(false);
        let mut child_pid = None;
        let mut canceled_at = None;
        let started = Instant::now();

        let outcome = run_export_process(
            ExportProcessRequest {
                ffmpeg: &program,
                arguments: &arguments,
                cancel: &cancel,
                poll: TEST_POLL,
            },
            |snapshot| {
                // The child announces its own process id in its first block and then sleeps.
                // Cancelling from here rather than from a timer thread makes the test
                // deterministic whatever the interpreter's startup costs: the flag is set at
                // the moment the process is known to exist, never before it started and never
                // after it finished.
                child_pid = snapshot.frame;
                cancel.store(true, Ordering::SeqCst);
                // The start of the interval the test asserts on. Taken here, on the first
                // block only, so that it marks the moment the flag went up.
                canceled_at.get_or_insert_with(Instant::now);
            },
        )
        .expect("the process should spawn and then be killed");

        let after_cancel = canceled_at
            .expect("the callback runs at least once")
            .elapsed();
        let pid = child_pid.expect("the child reports its process id before it is cancelled");

        assert_eq!(outcome.status, ExportProcessStatus::Canceled);
        // Two separate claims, because the timing alone proves less than it looks like it
        // does. The early return proves the pipes closed, which is what unblocks the joins;
        // only the process table says whether the process behind them is gone.
        assert!(
            process_is_gone(pid),
            "the cancelled child survived as process {pid}"
        );
        // The quantity the cancel path owns, measured from the flag going up: a kill, a wait,
        // two reader-thread joins and the final drain. No poll interval is inside it.
        // `drain_progress` runs at the top of the loop body and `cancel.load` is the next
        // statement, with no sleep between them, so the flag is read on the same iteration that
        // delivered this block; `thread::sleep(poll)` elapses before the snapshot ever reaches
        // the callback. Five seconds is generous for all of that on a loaded runner.
        assert!(
            after_cancel < Duration::from_secs(5),
            "expected the cancel to end the process promptly, took {after_cancel:?}"
        );
        // The status alone does not prove the child was cut short: the supervision loop reads
        // the cancel flag before `try_wait`, and `Child::kill` on an already-exited child
        // returns `Ok`, so a child that reached its natural end with the flag already up is
        // still reported `Canceled`. This bound carries that claim instead -- the first
        // progress block reached the callback during the run rather than at the end of it.
        // Sixty seconds is half the child's own sleep, so no run that waited the sleep out can
        // meet it, and it sits far above any interpreter startup this test does not control.
        let total = started.elapsed();
        assert!(
            total < Duration::from_secs(60),
            "expected the first progress block to arrive during the run, took {total:?}"
        );
    }

    #[test]
    fn a_panicking_callback_leaves_no_survivor_and_no_zombie() {
        // Measured before `ChildGuard` existed: this unwinds past the kill, past the wait, and
        // past both joins, leaving the child running and then `<defunct>` under the test
        // process. The panic message this prints into the test log is the deliberate one below.
        let (program, arguments) = pid_reporting_sleeper();
        let cancel = AtomicBool::new(false);
        let mut child_pid = None;

        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            run_export_process(
                ExportProcessRequest {
                    ffmpeg: &program,
                    arguments: &arguments,
                    cancel: &cancel,
                    poll: TEST_POLL,
                },
                |snapshot| {
                    child_pid = snapshot.frame;
                    panic!("the caller's progress callback panics on its first block");
                },
            )
        }));

        assert!(
            result.is_err(),
            "the callback's panic must still reach the caller"
        );
        let pid = child_pid.expect("the child reports its process id before the panic");
        assert!(
            process_is_gone(pid),
            "the unwind orphaned the child as process {pid}"
        );
    }

    #[test]
    fn a_cancel_flag_that_is_already_set_prevents_the_spawn_entirely() {
        // The program does not exist. A spawn would therefore fail with `NotFound`, so an
        // `Ok(Canceled)` here is proof that the pre-spawn check ran and that no process was
        // started -- the obligation `ExportRegistry::begin` states, tested by making the
        // spawn observable through its failure.
        let missing = PathBuf::from("/quipclip-no-such-executable-for-the-pre-spawn-test");
        let cancel = AtomicBool::new(true);

        let outcome = run_export_process(
            ExportProcessRequest {
                ffmpeg: &missing,
                arguments: &[],
                cancel: &cancel,
                poll: TEST_POLL,
            },
            |_| panic!("a run that never spawned must report no progress"),
        )
        .expect("a pre-spawn cancel is an outcome, not an error");

        assert_eq!(outcome.status, ExportProcessStatus::Canceled);
        assert!(outcome.stderr.is_empty());
        assert!(outcome.last_progress.is_none());
    }

    #[test]
    fn progress_blocks_reach_the_callback_in_order_and_the_last_one_is_kept() {
        let (program, arguments) = progress_emitting_command();

        let (outcome, seen) = run_to_completion(&program, &arguments);

        assert_eq!(
            seen.iter()
                .map(|snapshot| snapshot.frame)
                .collect::<Vec<_>>(),
            vec![Some(1), Some(2)]
        );
        assert!(!seen[0].done);
        assert!(seen[1].done);
        assert_eq!(outcome.last_progress, Some(seen[1]));
        // What this test does *not* prove: that the drain after the join is needed. Four lines
        // are pumped and sent well inside one poll tick, so the loop's own drain already holds
        // both snapshots by the time `try_wait` reports the exit, and deleting the post-join
        // drain leaves this test green.
        // `every_progress_block_survives_a_flood_that_outruns_the_supervision_loop` is the one
        // that defends it.
    }

    #[test]
    fn every_progress_block_survives_a_flood_that_outruns_the_supervision_loop() {
        // This is the production shape: `ffmpeg` writes `progress=end` and exits while the pipe
        // still holds blocks the pump has not parsed yet. The supervision loop sees the exit,
        // stops draining, and the tail is delivered only by the drain that runs after the pump
        // thread is joined.
        //
        // Measured on the Unix arm with that drain deleted: eight runs delivered between
        // 197 983 and 198 030 of 200 001 blocks, losing about 1980 each time; with the drain in
        // place, ten runs delivered 200 001. A tail lost that way makes the final `frame` fall
        // short of `ExportPlan::expected_frames`, so the orchestration unit reports
        // `frameCountMismatch` on a perfect export -- or, on a genuinely short one, hides a real
        // mismatch behind a plausible number.
        //
        // `poll: Duration::ZERO` below is load-bearing, and this test is worth nothing without
        // it. At `TEST_POLL` the supervising thread spends 10 ms asleep per iteration, which is
        // all the time the pump needs to catch up and empty the pipe before the loop wakes to
        // notice the exit: with the drain deleted and a 10 ms poll, eleven runs lost blocks once
        // and delivered every block the other ten times. A spinning supervisor is what keeps the
        // pump behind, which is the state a real encoder writing faster than this process can
        // parse produces on its own. Do not tidy this into `TEST_POLL`; it disarms the test.
        let (program, arguments) = flooding_progress_command();
        let cancel = AtomicBool::new(false);
        let mut delivered = 0_u64;
        let mut first_out_of_order = None;

        let outcome = run_export_process(
            ExportProcessRequest {
                ffmpeg: &program,
                arguments: &arguments,
                cancel: &cancel,
                poll: Duration::ZERO,
            },
            |snapshot| {
                // Counted rather than collected: 200 001 snapshots in a `Vec` would be the
                // largest allocation in the test suite, and the ordering claim needs only the
                // frame number this delivery should be carrying.
                delivered += 1;
                if first_out_of_order.is_none() && snapshot.frame != Some(delivered) {
                    first_out_of_order = Some((delivered, snapshot.frame));
                }
            },
        )
        .expect("the producer should spawn and exit on its own");

        assert_eq!(
            first_out_of_order, None,
            "a block arrived out of order: (expected frame, delivered frame)"
        );
        assert_eq!(delivered, FLOOD_BLOCKS, "blocks were lost");
        assert_eq!(
            outcome.last_progress.and_then(|snapshot| snapshot.frame),
            Some(FLOOD_BLOCKS)
        );
        assert!(matches!(
            outcome.status,
            ExportProcessStatus::Exited { success: true, .. }
        ));
    }

    #[test]
    fn a_non_utf8_line_does_not_stop_the_pump_or_lose_the_block_around_it() {
        // 0xFF cannot appear in valid UTF-8. `BufReader::lines()` would answer
        // `Err(InvalidData)` for this line, and propagating that is how a healthy export gets
        // killed by its own progress parser; see the module documentation.
        let mut stream = b"frame=7\n".to_vec();
        stream.extend_from_slice(b"junk=\xff\xfe\n");
        stream.extend_from_slice(b"progress=end\n");

        let mut seen = Vec::new();
        pump_progress(io::Cursor::new(stream), |snapshot| seen.push(snapshot));

        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].frame, Some(7));
        assert!(seen[0].done);
    }

    #[test]
    fn an_over_long_line_is_dropped_and_the_pump_resynchronises_on_the_next_one() {
        // Three times the per-line limit with no newline in it. Unbounded, `read_until` would
        // buffer all of it -- and, on a stream that never sends a newline at all, would keep
        // growing one allocation until the allocator refused.
        let mut stream = vec![b'x'; MAX_PROGRESS_LINE_BYTES * 3];
        stream.push(b'\n');
        stream.extend_from_slice(b"frame=5\nprogress=end\n");

        let mut seen = Vec::new();
        pump_progress(io::Cursor::new(stream), |snapshot| seen.push(snapshot));

        // The over-long line contributes nothing, and the block after it parses normally:
        // the pump skipped to the next newline instead of stopping or misreading a fragment.
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].frame, Some(5));
        assert!(seen[0].done);
    }

    #[test]
    fn a_line_without_a_trailing_newline_still_completes_its_block() {
        // The last line `ffmpeg` writes before it is killed has no terminator. `read_until`
        // returns it anyway, with no `\n` to strip, and the block must still complete rather
        // than be discarded with the partial state.
        let mut seen = Vec::new();
        pump_progress(
            io::Cursor::new(b"frame=3\nprogress=continue".to_vec()),
            |s| {
                seen.push(s);
            },
        );

        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].frame, Some(3));
        assert!(!seen[0].done);
    }

    #[test]
    fn a_capped_stderr_capture_keeps_the_last_line_and_drops_the_first() {
        // `ffmpeg` writes its reason for stopping last, so this is the claim that matters: a
        // capture that filled up must hold the end of the stream. The earlier version of this
        // test asserted only the length and that the bytes were ASCII, which a head capture and
        // a tail capture satisfy alike, so it could not have caught the head/tail fault.
        let (program, arguments) = chatty_stderr_command();

        let (outcome, _) = run_to_completion(&program, &arguments);

        // Reaching this assertion at all is half the test: an undrained stderr pipe would
        // have blocked the child inside a write, and the run would never have finished.
        assert_eq!(outcome.stderr.len(), STDERR_CAPTURE_LIMIT);
        let captured = String::from_utf8_lossy(&outcome.stderr);
        assert!(
            captured.contains(&format!(
                "line {CHATTY_LINES} xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            )),
            "the last line the child wrote must survive the cap"
        );
        // The full line body, not just `line 1`, which is a prefix of `line 100`.
        assert!(
            !captured.contains("line 1 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
            "the capture is a tail, so the first line must have been dropped"
        );
    }

    #[test]
    fn stderr_detail_reads_the_tail_of_the_capture_not_its_head() {
        let outcome = ExportProcessOutcome {
            status: ExportProcessStatus::Exited {
                code: Some(1),
                success: false,
            },
            stderr: {
                let mut bytes = vec![b'a'; STDERR_DETAIL_LIMIT];
                bytes.extend_from_slice(b"the error that stopped the encode");
                bytes
            },
            last_progress: None,
        };

        let detail = outcome
            .stderr_detail()
            .expect("non-empty stderr has a tail");

        assert!(detail.ends_with("the error that stopped the encode"));
        assert!(detail.len() <= STDERR_DETAIL_LIMIT);
    }

    #[test]
    fn stderr_detail_is_none_when_the_process_wrote_nothing() {
        let outcome = ExportProcessOutcome {
            status: ExportProcessStatus::Exited {
                code: Some(0),
                success: true,
            },
            stderr: Vec::new(),
            last_progress: None,
        };

        assert_eq!(outcome.stderr_detail(), None);
    }
}
