# 018. Start Windows child processes without a console window

- Status: Accepted
- Date: 2026-09-20
- Deciders: capric98

## Context

QuipClip runs `ffmpeg` and `ffprobe` as child processes. Both are console programs. The
application itself is a window. A release build sets the Windows GUI subsystem, so the
application process has no console.

Windows gives a console program a console. When the parent process has none, the operating
system makes a new console window for the child. That window opens when the child starts.
It closes when the child stops.

QuipClip starts many short child processes:

- The capability probe of ADR 006 runs `-version`. It then reads the cache. On a cache miss
  it runs `-encoders` and `-hwaccels`, and then one smoke test for each of the twelve
  candidate encoders. A first probe is therefore up to fifteen processes. A start that hits
  the cache is one process, because the cache lookup returns before `-encoders`.
- A media import runs one `ffprobe`.
- An export runs one `ffmpeg`.

Each of those processes showed a console window. A first probe flashes up to fifteen windows
during startup. This looks like a fault in the application.

The Windows process creation flag `CREATE_NO_WINDOW` stops the new console. The Rust
standard library sets the flag through `std::os::windows::process::CommandExt`. The flag
does not change the standard input, output or error streams. QuipClip gives each of those
streams a pipe or the null device at each start.

## Decision

The crate has one constructor for a child process, in `src-tauri/src/procutil.rs`. Every
start of a child process in `src-tauri/` uses it, the tests included.

On Windows the constructor sets `CREATE_NO_WINDOW`. On other operating systems it makes a
plain command.

`std::process::Command::new` must not occur in this crate outside that module. A later call
to `Command::new` shows the console window again, and a macOS build gives no signal about
that mistake. A rule that only a reader can apply is not sufficient here, so `clippy.toml`
puts `Command::new` in `disallowed-methods`. The constructor module holds the one `allow`
that the rule permits. The gate runs `cargo clippy --all-targets -- -D warnings`, so a new
direct call fails the build.

The constructor changes only the console window. The caller keeps full control of the
program, the arguments, the three streams, the timeout and the termination.

## Consequences

- A first capability probe, a media import and an export show no console window on Windows.
- A child process on Windows gets no console. The child is still a console program, and it
  can make its own console. A call that opens the `CONOUT$` device fails. `ffmpeg` and
  `ffprobe` do not open it. QuipClip gives each stream a pipe or the null device, and the
  export command line also carries `-nostdin` (ADR 014).
- Windows ignores the flag in three conditions: the target is not a console program, the
  caller also passes `CREATE_NEW_CONSOLE`, or the caller also passes `DETACHED_PROCESS`.
  Windows reports no error for any of the three. This crate passes no other creation flag.
  A configured path that names a program which is not a console program is possible (ADR
  005), and such a program shows whatever window it makes for itself.
- A macOS build compiles no Windows code. A cross-compilation check lints the Windows code
  from macOS, and the Windows job of the continuous integration workflow compiles it and
  runs the tests. Neither one looks at the screen. Only a person who starts the application
  on Windows can confirm that no window appears.
