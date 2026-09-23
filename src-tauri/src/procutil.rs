//! The one constructor every child process in this crate is started from.
//!
//! A release build of QuipClip is a Windows GUI-subsystem process, so it owns no console of its
//! own. Windows still gives a console program a console: when the parent has none, the operating
//! system allocates a fresh console *window* for the child, which opens when the child starts and
//! closes when it exits. `ffmpeg` and `ffprobe` are console programs, so every spawn this
//! application makes flashed such a window.
//!
//! The capability probe (ADR 006) was the loudest of the three call sites, and its true shape is
//! worth stating, because the ceiling and the common case are far apart. A full probe runs three
//! listing commands -- `-version`, `-encoders` and `-hwaccels`; `-decoders` and `-filters` are
//! recorded non-goals -- and then one smoke test per *listed* candidate out of the sixteen in
//! `capabilities::TESTED_ENCODERS`, one process each. Nineteen windows is therefore the ceiling,
//! and a run reaches it only on the first probe of a binary, on a cache miss after an ffmpeg
//! upgrade, and on a forced re-probe. Every start after that hits the on-disk cache, which answers
//! after `-version` and before `-encoders`: one child, and so one window. A media import
//! (`ffmpeg::probe`) and an export (`ffmpeg::export::process`, ADR 016) spawn one each.
//!
//! `CREATE_NO_WINDOW` is the process creation flag that suppresses the allocation, and
//! [`command_without_console`] is the only place in this crate that sets it. ADR 018 makes that a
//! rule rather than a habit: `std::process::Command::new` must not appear anywhere else under
//! `src-tauri/src/`, the tests included. A spawn that bypasses this module brings the window back,
//! and it brings it back invisibly -- the flag, the extension trait that sets it and the whole
//! failure mode are `#[cfg(windows)]`, so on macOS the mistake compiles, lints and passes every
//! test. `clippy.toml` is what stops it: it disallows `std::process::Command::new` for the whole
//! crate, so a spawn added anywhere else fails the gate on either platform, and the two
//! `#[allow(clippy::disallowed_methods)]` in this file are the single exemption.
//!
//! The constructor configures the console window and nothing else. The program, the arguments, the
//! three standard streams, the timeout discipline and how the child is ended all stay with the
//! caller, which is what keeps each call site one token wide: `run_with_timeout`
//! (`ffmpeg::capabilities::smoke`), `run_probe_process` (`ffmpeg::probe`) and `run_export_process`
//! (`ffmpeg::export::process`, ADR 016) keep their stdio configuration, their drain threads, their
//! poll-and-kill timeouts and their `ChildGuard` exactly as they were.

use std::ffi::OsStr;
use std::process::Command;

/// A [`Command`] for `program` that starts no console window on Windows.
///
/// Call this in place of `std::process::Command::new` for every spawn in this crate, tests
/// included (ADR 018). It differs from `Command::new` in exactly one respect on Windows, and in no
/// respect at all anywhere else.
///
/// **The flag decides the console, not the standard handles.** stdin, stdout and stderr are
/// untouched by it, and by every other creation flag: `Command` fills all three `STARTUPINFO`
/// entries and sets `STARTF_USESTDHANDLES` whatever flags it carries. So the probe still reads its
/// JSON answer from a pipe (`ffmpeg::probe`), the export still reads `-progress pipe:1` from one
/// (ADR 014, ADR 016), and the smoke test still reads stderr from one. The second test below
/// guards that for the constructor as a whole; its comment states what it does and does not
/// establish, and it cannot tell one creation flag from another.
///
/// This returns a configured `Command` rather than taking `&mut Command`, so adopting it at a call
/// site is a one-token edit and no caller can build a command and then forget the second call.
// The single exemption ADR 018 names: `clippy.toml` disallows `std::process::Command::new` for the
// whole crate, so that a spawn added anywhere else fails the build rather than quietly bringing the
// window back. This module is the one place that must still call it.
#[allow(clippy::disallowed_methods)]
#[cfg(windows)]
pub fn command_without_console(program: impl AsRef<OsStr>) -> Command {
    use std::os::windows::process::CommandExt;

    let mut command = Command::new(program);
    // `creation_flags` replaces the caller's whole flag word rather than adding to it: a second
    // call here would drop this constant instead of joining it. (What `std` itself contributes --
    // `CREATE_UNICODE_ENVIRONMENT` always, and `EXTENDED_STARTUPINFO_PRESENT` where it needs it --
    // sits outside that word and is unaffected either way.) Nothing else in this crate sets a
    // creation flag, so there is nothing here to preserve; a future caller that needs one has to
    // combine it with this constant rather than set it in a call of its own.
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// `CREATE_NO_WINDOW`: run a console child without giving it a console window.
///
/// The child is still a console application; Windows simply allocates no console for it and sets
/// no console handle. That is the right shape here, because nothing this crate spawns reads or
/// writes a console device: every caller hands all three standard streams a pipe or the null
/// device, and the export command line also carries `-nostdin` (ADR 014).
///
/// The constant is spelled out instead of imported. `std` does not define it, and the alternative
/// is a `windows-sys` dependency for one `u32` -- which would also be the first dependency this
/// module needs at all. Nothing in this repository checks the value: `CreateProcessW` ignores a
/// flag bit it does not define, so a mistyped constant spawns just as happily and leaves every
/// test green on both platforms. It is taken from the Windows documentation, and a window
/// reappearing on a real Windows run is the only thing that would report it wrong.
///
/// Windows documents three conditions under which it *ignores* this flag, and they differ in what
/// that costs:
/// - with `CREATE_NEW_CONSOLE` the child gets a new console, so the window is back and nothing
///   reports it;
/// - with `DETACHED_PROCESS` the child gets no console at all, so there is no window either and
///   this flag is merely redundant, not defeated;
/// - when the program is not a console application there is nothing to suppress. That case is
///   reachable rather than academic: ADR 005 resolves `ffmpeg` from an explicit path in the
///   settings first, so the user can name any executable there, and a GUI program named that way
///   shows its own window whatever creation flags its parent passed.
///
/// This crate passes no creation flag other than this one, and [`command_without_console`] is the
/// only place that could.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A [`Command`] for `program`, on a platform where no console window is ever allocated.
///
/// macOS and Linux have nothing to suppress: a child inherits the parent's terminal, or has none,
/// and neither case opens a window. So this arm is a plain `Command::new`, and it exists only so
/// that the call sites are identical on every platform and the Windows arm has a single home.
// The same single exemption; see the Windows arm above.
#[allow(clippy::disallowed_methods)]
#[cfg(not(windows))]
pub fn command_without_console(program: impl AsRef<OsStr>) -> Command {
    Command::new(program)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::process::Stdio;

    /// The line [`line_writing_command`] writes to stdout.
    const EXPECTED_LINE: &str = "quipclip";

    /// A program that writes [`EXPECTED_LINE`] to stdout and exits with status 0.
    ///
    /// Both arms follow the shape of the fixtures in `ffmpeg::export::process`'s tests: a program
    /// a default install of the platform already has, so this test needs neither `ffmpeg` nor any
    /// other tool to be installed. The one-process-per-arm rule those fixtures carry does not bind
    /// here, because nothing below kills a child -- each one runs to completion and closes its own
    /// pipe.
    #[cfg(unix)]
    fn line_writing_command() -> (&'static str, Vec<String>) {
        (
            "/bin/sh",
            vec!["-c".to_owned(), format!("printf '{EXPECTED_LINE}\\n'")],
        )
    }

    /// The Windows counterpart of [`line_writing_command`], and the arm that actually carries
    /// `CREATE_NO_WINDOW`.
    ///
    /// `echo {EXPECTED_LINE}` contains a space, so Rust wraps the argument in exactly one pair of
    /// quotes, and `cmd /c` then strips the leading quote and the last quote and runs the rest
    /// verbatim. That is `cmd`'s second quote-handling rule, and it applies here only because the
    /// first one does not: that rule would *preserve* the pair, and it requires the quoted string
    /// to be the name of an executable file, which `echo quipclip` is not. The script also holds
    /// no double quote of its own. Adding one would put both rules back in play, so keep it plain.
    ///
    /// `echo` ends the line with CRLF rather than LF, which is why the assertion trims the end.
    #[cfg(windows)]
    fn line_writing_command() -> (&'static str, Vec<String>) {
        (
            "cmd.exe",
            vec!["/c".to_owned(), format!("echo {EXPECTED_LINE}")],
        )
    }

    #[test]
    fn a_command_from_the_constructor_spawns_and_reports_an_exit_status() {
        // What this pins: a `Command` from the constructor still runs an ordinary child and still
        // reports that child's status, so nothing the constructor configures costs a caller its
        // spawn. That is worth asserting on Windows, where a creation flag the operating system
        // rejects fails `CreateProcessW` outright and every caller in this crate would then report
        // an `io::Error` where it used to run a child.
        //
        // What it does not pin: the value of `CREATE_NO_WINDOW`. `CreateProcessW` ignores a flag
        // bit it does not define, so a mistyped constant would spawn just as happily and leave
        // this test green. Nothing in this repository checks that value.
        let (program, arguments) = line_writing_command();

        let status = command_without_console(program)
            .args(&arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("a command from the constructor must spawn");

        assert!(
            status.success(),
            "the child must run to completion and report its own status, got {status:?}"
        );
    }

    #[test]
    fn stdout_from_a_command_from_the_constructor_still_arrives_through_a_pipe() {
        // What this pins: a child started through the constructor still writes to the pipe the
        // caller gave it. Every caller in this crate leans on that -- the probe reads its whole
        // JSON answer from stdout (`ffmpeg::probe`), the export reads `-progress pipe:1`
        // (ADR 014, ADR 016), and the smoke test reads stderr -- and this module now sits on the
        // path of all three, so a later change here that pre-configured or disturbed the standard
        // handles would break every one of them at once. This is the regression guard for that,
        // and it is the reason a creation flag can be applied to every spawn in the crate at all.
        //
        // What it does not pin: which creation flag is set. `CREATE_NO_WINDOW` and
        // `DETACHED_PROCESS` both leave the standard handles alone, so a constructor that set the
        // wrong one of the two would pass this unchanged. On macOS it pins even less: both tests
        // here run the `#[cfg(not(windows))]` arm, which sets no creation flag and observes none,
        // so nothing about Windows is established until the Windows job runs them.
        let (program, arguments) = line_writing_command();

        let mut child = command_without_console(program)
            .args(&arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("a command from the constructor must spawn");
        let mut captured = String::new();
        child
            .stdout
            .take()
            .expect("stdout was requested as piped above")
            .read_to_string(&mut captured)
            .expect("the child's stdout pipe must be readable");
        // Read to end of stream first, then reap: the output is a single short line, so the pipe
        // buffer cannot fill and the read cannot outlive the child.
        let status = child.wait().expect("the child must be reapable");

        assert!(status.success(), "got {status:?}");
        assert_eq!(
            captured.trim_end(),
            EXPECTED_LINE,
            "the child's stdout must reach the parent through the pipe it was given"
        );
    }
}
