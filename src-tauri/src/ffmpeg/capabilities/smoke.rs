//! The encoder smoke test: run a short real encode and classify the outcome.
//!
//! ADR 006 splits capability probing into a listing step (see [`super::listing`]) and a
//! smoke-test step. The listing step only proves an encoder is present in the ffmpeg
//! build; a GPL build lists `h264_nvenc` on a machine with no NVIDIA GPU, and the encoder
//! fails at the first frame. This module runs a real, short encode per candidate and
//! reports whether it actually works, within a bounded time.
//!
//! Every function here that spawns a process takes an explicit timeout and poll interval,
//! so the timing behaviour is testable without a real ffmpeg build. No test in this module
//! requires ffmpeg to be installed.

use super::{CodecKind, EncoderStatus};
use std::io::{self, Read};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

/// The timeout for one smoke test.
///
/// ADR 006 sets this bound because a broken hardware encoder can hang instead of failing
/// outright, and a probe of a dozen candidates must not block on one of them forever.
pub const SMOKE_TIMEOUT: Duration = Duration::from_secs(5);

/// How often [`run_smoke_test`] polls the child process for completion.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The largest number of stderr bytes [`run_with_timeout`] retains from a smoke test.
const STDERR_CAPTURE_LIMIT: usize = 8 * 1024;

/// The largest number of stdout bytes [`run_with_timeout`] retains for a caller that asked
/// for stdout.
///
/// A stderr tail of 8 KiB is a diagnostic, and a truncated one still reads. Captured stdout is
/// input to a parser instead, so the cap must sit far above the real output rather than near
/// it: `ffmpeg -encoders` on a full GPL build prints tens of kilobytes, and `-filters` prints
/// more. One mebibyte leaves that whole range untouched and still bounds the memory a runaway
/// process can make this process hold.
const STDOUT_CAPTURE_LIMIT: usize = 1024 * 1024;

/// The largest number of stderr-tail bytes [`run_smoke_report`] keeps in a [`SmokeReport`]'s
/// `detail` field.
const SMOKE_DETAIL_LIMIT: usize = 512;

/// One lock, held for one smoke test at a time, for the whole application.
///
/// ADR 006 requires that the smoke tests run one after another, never two at once: two
/// hardware encoder tests that run at the same time compete for the same encoder device,
/// and that competition reports a working encoder as broken. [`run_smoke_test`] holds this
/// lock for the duration of one test, so a superseded probe run and the active probe run
/// never test an encoder at the same time; the active run simply waits its turn.
static SMOKE_LOCK: Mutex<()> = Mutex::new(());

/// How a smoke-test process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandStatus {
    /// The process ran to completion before the deadline.
    Exited {
        /// The process's exit code, or `None` when a signal terminated it (Unix only).
        code: Option<i32>,
        /// Whether the process reported success. On Unix this means exit code zero.
        success: bool,
    },
    /// The process was still running at the deadline and was killed.
    TimedOut,
}

/// The result of running one command with a timeout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutcome {
    /// How the process ended.
    pub status: CommandStatus,
    /// Up to [`STDERR_CAPTURE_LIMIT`] bytes of the process's stderr, captured on a
    /// separate thread while the process ran or was awaited.
    pub stderr: Vec<u8>,
    /// Up to [`STDOUT_CAPTURE_LIMIT`] bytes of the process's stdout, captured the same way,
    /// and empty when the caller passed [`StdoutCapture::Discard`].
    pub stdout: Vec<u8>,
}

/// Whether [`run_with_timeout`] keeps the child's stdout or sends it to the null device.
///
/// A smoke test discards it: ADR 006's command writes its encode to the null muxer and every
/// verdict comes from the exit status and stderr. A listing command is the opposite -- its
/// stdout is the whole result -- so the two cases are named rather than passed as a bare
/// `bool` at the call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdoutCapture {
    /// Send stdout to the null device. [`CommandOutcome::stdout`] is then empty.
    Discard,
    /// Pipe stdout and drain it on its own thread, the same way stderr is drained.
    Capture,
}

/// Build the ffmpeg arguments for the smoke test of one encoder, or `None` when `kind` has
/// no smoke-test command.
///
/// The two command shapes are fixed by ADR 006, verbatim, down to the flag order. The
/// audio form's `-t 0.2` is a correctness requirement, not a style choice: `anullsrc` is an
/// infinite source, and without an explicit duration a working audio encoder would run
/// until [`SMOKE_TIMEOUT`] and be misreported as broken.
///
/// ADR 006 defines no subtitle smoke test, so `kind: CodecKind::Subtitle` returns `None`.
/// `CodecKind` is `pub`, and [`super::listing::parse_codec_list`] genuinely produces
/// `Subtitle` rows from real ffmpeg output, so a caller mapping over a parsed listing can
/// reach this case; [`run_smoke_test`] turns the `None` into a handled error rather than
/// this function panicking on a publicly reachable input.
pub fn smoke_arguments(encoder: &str, kind: CodecKind) -> Option<Vec<String>> {
    match kind {
        CodecKind::Video => Some(
            [
                "-hide_banner",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=256x256:r=25:d=0.2",
                "-c:v",
                encoder,
                "-f",
                "null",
                "-",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        ),
        CodecKind::Audio => Some(
            [
                "-hide_banner",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=48000:cl=stereo",
                "-t",
                "0.2",
                "-c:a",
                encoder,
                "-f",
                "null",
                "-",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        ),
        CodecKind::Subtitle => None,
    }
}

/// Classify a finished smoke test into the [`EncoderStatus`] the listing step cannot
/// produce on its own.
///
/// This never returns [`EncoderStatus::NotListed`]: that status means the encoder was
/// absent from the `-encoders` listing, a fact the listing step establishes before any
/// smoke test runs.
pub fn classify(outcome: &CommandOutcome) -> EncoderStatus {
    match outcome.status {
        CommandStatus::Exited { success: true, .. } => EncoderStatus::Works,
        CommandStatus::Exited { success: false, .. } => EncoderStatus::Failed,
        CommandStatus::TimedOut => EncoderStatus::TimedOut,
    }
}

/// Return up to `limit` bytes from the end of `bytes` as text, or `None` when `bytes` is
/// empty.
///
/// The cut point walks forward from `len - limit` to the next UTF-8 character boundary, so
/// a multi-byte character is never split in half; the character that boundary walk skips
/// is simply left out of the tail rather than turned into a replacement character.
/// [`String::from_utf8_lossy`] then guards the remaining slice, since ffmpeg can emit
/// non-ASCII diagnostic text under some locales.
pub fn stderr_tail(bytes: &[u8], limit: usize) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let mut start = bytes.len().saturating_sub(limit);
    while start < bytes.len() && !is_utf8_char_boundary(bytes[start]) {
        start += 1;
    }
    Some(String::from_utf8_lossy(&bytes[start..]).into_owned())
}

/// Whether `byte` can start a UTF-8 character, as opposed to continuing one.
///
/// `&[u8]` has no `is_char_boundary` method (that belongs to `str`), so this checks the
/// top two bits directly: a UTF-8 continuation byte is always `10xxxxxx`, and every other
/// byte, ASCII included, starts a new character.
fn is_utf8_char_boundary(byte: u8) -> bool {
    byte & 0b1100_0000 != 0b1000_0000
}

/// Run `program` with `args`, killing it if it has not finished by `timeout`.
///
/// `std` has no `wait_timeout`, and the obvious thread-plus-channel shape is wrong here:
/// `Child::wait_with_output` consumes the `Child`, so once it moves into a waiter thread
/// nothing outside that thread can kill it, and a hung hardware encoder is exactly the
/// case a smoke test must survive. Instead this function keeps the `Child` and polls
/// [`std::process::Child::try_wait`] every `poll` interval until `timeout` elapses, then
/// kills and reaps the process itself.
///
/// The child's stderr is piped and drained on a separate thread from the moment it spawns.
/// This is not an optimization: a chatty ffmpeg build fills the stderr pipe's OS buffer
/// and blocks the child before it can exit, and an undrained pipe would then produce a
/// false timeout on exactly that build. Killing the child closes its end of the pipe, which
/// unblocks the drain thread's read and bounds the final join, and [`kill_and_reap`] runs on
/// every path that leaves the polling loop with a child that may still be alive.
///
/// `stdout` decides whether the child's stdout is kept. [`StdoutCapture::Capture`] gives it a
/// pipe and a drain thread of its own, for the same reason and with the same guarantees as
/// stderr's: a listing command that fills the stdout buffer must not block before it exits.
/// [`StdoutCapture::Discard`] sends it to the null device, where no buffer can fill.
pub fn run_with_timeout(
    program: &Path,
    args: &[String],
    timeout: Duration,
    poll: Duration,
    stdout: StdoutCapture,
) -> io::Result<CommandOutcome> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(match stdout {
            StdoutCapture::Capture => Stdio::piped(),
            StdoutCapture::Discard => Stdio::null(),
        })
        .stderr(Stdio::piped())
        .spawn()?;

    let stderr = child
        .stderr
        .take()
        .expect("stderr was requested as piped above");
    let stderr_thread = thread::spawn(move || read_capped(stderr, STDERR_CAPTURE_LIMIT));
    // Taken before the polling loop, like stderr's, so the drain runs for the whole life of
    // the process rather than starting once it has already filled the pipe and stopped.
    let stdout_thread = child
        .stdout
        .take()
        .map(|stdout| thread::spawn(move || read_capped(stdout, STDOUT_CAPTURE_LIMIT)));

    // The polling below returns `Result` instead of using `?` directly in this function:
    // every path here must still end the child and join the drain threads before this
    // function returns, including the error paths. A failed `try_wait` that returned early
    // would leave a live, unreaped process holding its pipe ends open, and the joins below
    // would then wait for it with no bound -- the exact failure this timeout exists to
    // prevent -- because `read_capped` reads until the pipe closes and the pipe closes when
    // the child exits. On Unix, dropping a `Child` neither kills nor reaps it, so no later
    // step would end it either.
    let polled = (|| -> io::Result<Option<ExitStatus>> {
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait()? {
                Some(status) => return Ok(Some(status)),
                None if Instant::now() >= deadline => return Ok(None),
                None => thread::sleep(poll),
            }
        }
    })();

    // Only the first arm has a child the polling already reaped. The deadline arm and the
    // failed-`try_wait` arm both leave a process that may still be running, so each one ends
    // it here, before the joins below.
    let status = match polled {
        Ok(Some(status)) => Ok(CommandStatus::Exited {
            code: status.code(),
            success: status.success(),
        }),
        Ok(None) => kill_and_reap(&mut child).map(|()| CommandStatus::TimedOut),
        Err(error) => {
            // The polling failure is what this run reports. The kill runs only to bound the
            // joins below, so its own result has nowhere to go.
            let _ = kill_and_reap(&mut child);
            Err(error)
        }
    };

    // Ending the child above closes its stderr pipe, so this join completes even when
    // the process timed out; when the process exited on its own, the pipe already closed
    // with it. Joined unconditionally, before the `?` below, so an error from the polling
    // closure still leaves the drain thread reaped rather than detached.
    let stderr = stderr_thread.join().unwrap_or_default();
    let stdout = stdout_thread
        .map(|thread| thread.join().unwrap_or_default())
        .unwrap_or_default();

    Ok(CommandOutcome {
        status: status?,
        stderr,
        stdout,
    })
}

/// Kill `child` and reap it, so the operating system keeps neither a runaway process nor a
/// zombie, and so both of the child's pipe ends close for the drain threads reading them.
///
/// Every exit from a timed runner's polling loop that did not already collect the child's
/// status calls this: the deadline path, and a `try_wait` that failed. `read_capped` returns
/// only when the pipe closes, so a live child left behind here turns each drain-thread join
/// into an unbounded wait.
///
/// The order is kill, inspect, then wait. `Child::kill` reports the process it was asked to
/// end as already gone with an `InvalidInput` error on some platforms, which is the documented
/// race between the last poll and this call rather than a real failure, and the `wait` is
/// needed to reap the process either way. A kill that failed for any other reason is
/// different: it leaves a process that is still running, and a blocking `wait` on that process
/// would last as long as the process does, so the failure is reported without waiting.
///
/// `ffmpeg::export::process` keeps a `kill_and_reap` of its own. That one is called from a
/// cancel branch where the `Child` was just polled, so it documents why it can wait
/// unconditionally; this one runs on a path where the child's state is unknown.
pub(crate) fn kill_and_reap(child: &mut Child) -> io::Result<()> {
    match child.kill() {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => {}
        Err(error) => return Err(error),
    }
    child.wait().map(|_| ())
}

/// Read `reader` to end of stream, retaining only the first `cap` bytes.
///
/// The read loop does not stop once `cap` bytes are captured: it keeps reading and
/// discarding until the pipe closes, so a chatty process is fully drained and can never
/// block on a full pipe buffer waiting for a reader that stopped early.
///
/// The export process runner (ADR 004, ADR 014) is a second caller of this function: it
/// must drain a long-running ffmpeg process's stderr without blocking, and that
/// keep-reading-after-the-cap behaviour is exactly why this function is shared rather than
/// duplicated there.
pub(crate) fn read_capped(mut reader: impl Read, cap: usize) -> Vec<u8> {
    let mut captured = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if captured.len() < cap {
                    let take = count.min(cap - captured.len());
                    captured.extend_from_slice(&buffer[..take]);
                }
            }
            Err(ref error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    captured
}

/// The outcome of one smoke test, together with the diagnostic detail a failure leaves
/// behind.
///
/// [`run_smoke_report`] always fills `exit_code` and `detail` from the process it ran,
/// regardless of `status`: deciding which status keeps them and which discards them on the
/// wire is the orchestrator's job, not this module's. See
/// [`EncoderResult`](super::EncoderResult)'s own field docs for that wire-level rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmokeReport {
    /// The classified outcome, exactly as [`classify`] would produce it.
    pub status: EncoderStatus,
    /// The process's exit code, when it ran to completion before the deadline.
    pub exit_code: Option<i32>,
    /// Up to [`SMOKE_DETAIL_LIMIT`] bytes of the process's stderr tail, when it produced any.
    pub detail: Option<String>,
}

/// Run the ADR 006 smoke test for one encoder and report the outcome together with its exit
/// code and a stderr tail.
///
/// Acquires [`SMOKE_LOCK`] for the duration of the test. A poisoned lock is recovered
/// rather than propagated as a panic: a panicking test thread must not permanently disable
/// capability probing for the rest of the application's lifetime.
pub fn run_smoke_report(ffmpeg: &Path, encoder: &str, kind: CodecKind) -> io::Result<SmokeReport> {
    let _guard = SMOKE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let arguments = smoke_arguments(encoder, kind).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the smoke test has no command for CodecKind::Subtitle",
        )
    })?;
    let outcome = run_with_timeout(
        ffmpeg,
        &arguments,
        SMOKE_TIMEOUT,
        POLL_INTERVAL,
        StdoutCapture::Discard,
    )?;
    let status = classify(&outcome);
    let exit_code = match outcome.status {
        CommandStatus::Exited { code, .. } => code,
        CommandStatus::TimedOut => None,
    };
    let detail = stderr_tail(&outcome.stderr, SMOKE_DETAIL_LIMIT);
    Ok(SmokeReport {
        status,
        exit_code,
        detail,
    })
}

/// Run the ADR 006 smoke test for one encoder and classify the outcome.
///
/// A thin wrapper over [`run_smoke_report`] for a caller that only needs the classified
/// status, such as this module's own tests.
pub fn run_smoke_test(ffmpeg: &Path, encoder: &str, kind: CodecKind) -> io::Result<EncoderStatus> {
    run_smoke_report(ffmpeg, encoder, kind).map(|report| report.status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke_arguments_builds_the_exact_video_command_from_adr_006() {
        let args = smoke_arguments("libx264", CodecKind::Video).expect("video has a smoke command");
        assert_eq!(
            args,
            vec![
                "-hide_banner",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=256x256:r=25:d=0.2",
                "-c:v",
                "libx264",
                "-f",
                "null",
                "-",
            ]
        );
    }

    #[test]
    fn smoke_arguments_builds_the_exact_audio_command_from_adr_006() {
        let args = smoke_arguments("libopus", CodecKind::Audio).expect("audio has a smoke command");
        assert_eq!(
            args,
            vec![
                "-hide_banner",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=48000:cl=stereo",
                "-t",
                "0.2",
                "-c:a",
                "libopus",
                "-f",
                "null",
                "-",
            ]
        );
    }

    #[test]
    fn smoke_arguments_audio_form_bounds_the_infinite_anullsrc_source() {
        // anullsrc never ends on its own. Without this explicit duration a working audio
        // encoder would run until SMOKE_TIMEOUT and be misreported as broken; ADR 006
        // calls this a correctness requirement, so it is pinned as its own assertion here
        // rather than folded into the exact-command test above.
        let args = smoke_arguments("aac", CodecKind::Audio).expect("audio has a smoke command");
        let position = args
            .iter()
            .position(|argument| argument == "-t")
            .expect("the audio smoke test must pass -t");
        assert_eq!(args[position + 1], "0.2");
    }

    #[test]
    fn smoke_arguments_returns_none_for_subtitle() {
        // ADR 006 defines no subtitle smoke test, but CodecKind is pub and a real ffmpeg
        // listing can produce a Subtitle row, so this must be a handled None rather than
        // a panic.
        assert_eq!(smoke_arguments("mov_text", CodecKind::Subtitle), None);
    }

    #[test]
    fn classify_maps_a_successful_exit_to_works() {
        let outcome = CommandOutcome {
            status: CommandStatus::Exited {
                code: Some(0),
                success: true,
            },
            stderr: Vec::new(),
            stdout: Vec::new(),
        };
        assert_eq!(classify(&outcome), EncoderStatus::Works);
    }

    #[test]
    fn classify_maps_an_unsuccessful_exit_to_failed() {
        let outcome = CommandOutcome {
            status: CommandStatus::Exited {
                code: Some(1),
                success: false,
            },
            stderr: Vec::new(),
            stdout: Vec::new(),
        };
        assert_eq!(classify(&outcome), EncoderStatus::Failed);
    }

    #[test]
    fn classify_maps_a_timeout_to_timed_out() {
        let outcome = CommandOutcome {
            status: CommandStatus::TimedOut,
            stderr: Vec::new(),
            stdout: Vec::new(),
        };
        assert_eq!(classify(&outcome), EncoderStatus::TimedOut);
    }

    #[test]
    fn stderr_tail_returns_none_for_empty_input() {
        assert_eq!(stderr_tail(&[], 10), None);
    }

    #[test]
    fn stderr_tail_caps_at_the_limit() {
        let bytes = b"0123456789";
        assert_eq!(stderr_tail(bytes, 4).unwrap(), "6789");
    }

    #[test]
    fn stderr_tail_does_not_split_a_multi_byte_character_in_half() {
        // Byte layout: 'a' (1 byte), then 'e' with an acute accent (2 bytes: 0xC3 0xA9),
        // then 'b' (1 byte); four bytes total. A limit of 2 places the naive cut point on
        // the second byte of the accented character, which is not a char boundary.
        let text = "a\u{e9}b";
        let bytes = text.as_bytes();
        assert_eq!(bytes.len(), 4);

        let tail = stderr_tail(bytes, 2).expect("non-empty input yields Some");

        // The cut point must move forward, off the split character entirely, rather than
        // panic on a non-boundary slice or emit a replacement character.
        assert_eq!(tail, "b");
    }

    #[test]
    fn a_nonzero_exit_classifies_as_failed() {
        // Running this test binary against an argument the test harness rejects is a
        // portable way to get a deterministic, immediate, non-zero exit: no shell, no
        // platform-specific executable, and no dependency on ffmpeg being installed. The
        // harness parses arguments and exits non-zero on every platform this crate
        // targets.
        let program = std::env::current_exe().expect("the test binary has a path");
        let args = vec!["--this-flag-does-not-exist".to_owned()];

        let outcome = run_with_timeout(
            &program,
            &args,
            Duration::from_secs(5),
            POLL_INTERVAL,
            StdoutCapture::Discard,
        )
        .expect("the test binary should spawn and exit quickly");

        assert!(matches!(
            outcome.status,
            CommandStatus::Exited { success: false, .. }
        ));
        assert_eq!(classify(&outcome), EncoderStatus::Failed);
    }

    #[cfg(unix)]
    #[test]
    fn a_hanging_process_is_killed_and_reported_as_timed_out() {
        // One process, no shell. A shell that forked would die on `Child::kill` while `sleep`
        // kept the inherited stderr write handle open, and the drain-thread join at the end of
        // `run_with_timeout` would then block for the full 10 seconds -- the Windows failure the
        // counterpart arm below was fixed for.
        let program = Path::new("/bin/sleep");
        let args = vec!["10".to_owned()];
        let started = Instant::now();

        let outcome = run_with_timeout(
            program,
            &args,
            Duration::from_millis(200),
            Duration::from_millis(10),
            StdoutCapture::Discard,
        )
        .expect("the process should spawn and then be killed");

        let elapsed = started.elapsed();
        assert_eq!(outcome.status, CommandStatus::TimedOut);
        assert!(
            elapsed < Duration::from_secs(2),
            "expected the timeout to fire well before the 10-second sleep, took {elapsed:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_hanging_process_is_killed_and_reported_as_timed_out() {
        // `ping -n 20 127.0.0.1` occupies a process for about 19 seconds and needs no tool
        // outside a default install. It must run as one process, not through `cmd.exe /c`:
        // `cmd.exe` stays alive as the parent of `ping`, so `Child::kill` terminates only
        // `cmd.exe` while `ping` keeps the inherited stderr write handle open. The pipe then
        // reaches end of stream only when `ping` exits on its own, and the drain-thread join
        // at the end of `run_with_timeout` blocks for that full runtime -- which is what the
        // elapsed-time assertion below catches. `pid_reporting_sleeper` in
        // `ffmpeg::export::process`'s tests states the same one-process-per-arm requirement.
        let program = Path::new("ping.exe");
        let args = vec!["-n".to_owned(), "20".to_owned(), "127.0.0.1".to_owned()];
        let started = Instant::now();

        let outcome = run_with_timeout(
            program,
            &args,
            Duration::from_millis(200),
            Duration::from_millis(10),
            StdoutCapture::Discard,
        )
        .expect("the process should spawn and then be killed");

        let elapsed = started.elapsed();
        assert_eq!(outcome.status, CommandStatus::TimedOut);
        assert!(
            elapsed < Duration::from_secs(2),
            "expected the timeout to fire well before ping finishes, took {elapsed:?}"
        );
    }

    #[test]
    fn kill_and_reap_answers_for_a_process_that_already_exited_on_its_own() {
        // The race arm, which every non-deadline exit from the polling loop now runs into:
        // the child ended between the last poll and the kill. It must read as success and
        // must not block, because the two drain-thread joins are behind it.
        let program = std::env::current_exe().expect("the test binary has a path");
        let mut child = Command::new(program)
            .arg("--list")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the test binary should spawn");
        // Poll rather than sleep, so the child is known to have exited before the kill.
        while child.try_wait().expect("try_wait must answer").is_none() {
            thread::sleep(Duration::from_millis(10));
        }

        let started = Instant::now();
        kill_and_reap(&mut child).expect("a child that already exited is not a failure");

        assert!(
            started.elapsed() < Duration::from_secs(2),
            "kill_and_reap must not block on a process that is already gone, took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn read_capped_drains_past_the_cap_so_a_chatty_process_never_blocks() {
        let data = vec![b'x'; 32 * 1024];
        let mut cursor = std::io::Cursor::new(data.clone());
        let captured = read_capped(&mut cursor, 8 * 1024);
        assert_eq!(captured.len(), 8 * 1024);
        // The load-bearing half: the reader must be consumed to the end, not abandoned at the cap.
        assert_eq!(cursor.position() as usize, data.len());
    }

    #[test]
    fn stdout_is_captured_only_when_the_caller_asks_for_it() {
        // The test binary stands in for ffmpeg again. `--list` makes the harness print its test
        // names to stdout and exit at once, on every platform this crate targets, so this needs
        // no real listing command and no ffmpeg build.
        let program = std::env::current_exe().expect("the test binary has a path");
        let args = vec!["--list".to_owned()];

        let captured = run_with_timeout(
            &program,
            &args,
            Duration::from_secs(30),
            POLL_INTERVAL,
            StdoutCapture::Capture,
        )
        .expect("the test binary should spawn and exit quickly");
        assert!(
            !captured.stdout.is_empty(),
            "Capture must keep the child's stdout, which is the whole result of a listing command"
        );

        let discarded = run_with_timeout(
            &program,
            &args,
            Duration::from_secs(30),
            POLL_INTERVAL,
            StdoutCapture::Discard,
        )
        .expect("the test binary should spawn and exit quickly");
        assert!(
            discarded.stdout.is_empty(),
            "Discard must send stdout to the null device and leave the field empty"
        );
    }

    #[test]
    fn run_smoke_test_recovers_from_a_poisoned_lock() {
        // Poison SMOKE_LOCK from a thread that panics while holding it, the same way a
        // panicking probe would. run_smoke_test's `PoisonError::into_inner` recovery must
        // still hand back a usable guard afterward instead of propagating the poison as a
        // panic of its own.
        let poison_result = thread::spawn(|| {
            let _guard = SMOKE_LOCK.lock().unwrap();
            panic!("poison SMOKE_LOCK on purpose for the recovery test");
        })
        .join();
        assert!(
            poison_result.is_err(),
            "the spawned thread should have panicked"
        );
        assert!(SMOKE_LOCK.is_poisoned());

        // The current executable stands in for ffmpeg, exactly as in
        // `a_nonzero_exit_classifies_as_failed`: it spawns and exits quickly on any
        // platform this crate targets, so this needs no real ffmpeg binary. Reaching the
        // assertion at all is the point: a still-poisoned lock would have panicked inside
        // run_smoke_test's recovery `.unwrap_or_else` on the way here.
        let program = std::env::current_exe().expect("the test binary has a path");
        let result = run_smoke_test(&program, "--this-flag-does-not-exist", CodecKind::Video);
        assert!(
            result.is_ok(),
            "run_smoke_test should recover the poisoned lock, got {result:?}"
        );
    }

    #[test]
    fn run_smoke_report_captures_the_exit_code_and_stderr_tail_for_a_failing_process() {
        // Same stand-in as `a_nonzero_exit_classifies_as_failed`: the current test binary
        // spawns and exits non-zero on an argument it does not recognize, with no
        // dependency on ffmpeg being installed.
        let program = std::env::current_exe().expect("the test binary has a path");

        let report = run_smoke_report(&program, "--this-flag-does-not-exist", CodecKind::Video)
            .expect("the test binary should spawn and exit quickly");

        assert_eq!(report.status, EncoderStatus::Failed);
        assert!(report.exit_code.is_some());
        assert!(report.detail.is_some());
    }

    #[test]
    fn run_smoke_test_reports_subtitle_as_a_handled_error_not_a_panic() {
        // CodecKind is pub, so a caller can pass Subtitle even though ADR 006 defines no
        // subtitle smoke test. That must surface as an io::Error, not a panic that would
        // poison SMOKE_LOCK for every probe after it.
        let program = std::env::current_exe().expect("the test binary has a path");
        let error = run_smoke_test(&program, "mov_text", CodecKind::Subtitle)
            .expect_err("Subtitle has no smoke command");
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}
