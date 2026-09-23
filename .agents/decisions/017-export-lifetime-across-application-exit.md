# 017. Cancel a running export when the application exits, and wait a bounded time

- Status: Accepted
- Date: 2026-09-06
- Deciders: capric98
- Amended by: ADR 027

## Context

ADR 016 gives the export a dedicated thread, a single-flight slot, and two guards. `ChildGuard`
kills and reaps the `ffmpeg` child on every path out of `run_export_process`, and
`PendingOutput` arms a cleanup guard that deletes the reserved temporary file on an early
return. Both guards are destructors.

A destructor does not run when the process ends. The export worker is a detached operating
system thread, and `tauri::Builder::run` returns when the last window closes. `main` then
returns and every thread dies without unwinding.

An audit found the result. A quit during an export leaves `ffmpeg` reparented and still
encoding at full processor cost, writing into a temporary file in the destination directory
that nothing will ever rename or delete. On macOS that file starts with a dot, so the file
manager hides it and the user sees only the missing disk space. Each quit during an export
leaves another one.

`process.rs` already names this class of fault: "an orphaned `ffmpeg` outlives both of those
guards and keeps encoding into a file they have already deleted." Here the file is not even
deleted.

ADR 016 does not cover a process exit. It reasons about a panic in the worker, which unwinds
and therefore runs the guards. An exit is a second path that no `?` and no `match` covers, and
unlike a panic it runs no destructor at all.

## Decision

The application handles `RunEvent::ExitRequested`. It cancels the active export through the
`ExportRegistry`, and it waits for the export slot to go free before the exit continues.

**A quit cancels the export. It does not refuse the quit.**

The user asked to close the application. Refusing that, or asking a question in a window that
is already closing, is worse than losing an encode that the user chose to abandon. A cancelled
export leaves no output, which is the same result the Cancel button gives.

**The wait is bounded. `EXIT_CANCEL_BUDGET` is 5 seconds, polled every 25 milliseconds.**

The wait has to cover one poll of the cancel flag by the export supervisor, the kill and the
reap of the `ffmpeg` child, the join of its two pipe reader threads, and the deletion of the
reserved temporary file. That sum is well under one second. Five seconds is far above it and is
still short enough that a quit reads as a quit.

The budget is a limit, not a wait for completion. An exit that can be delayed without limit is
worse than an orphaned process, because only the user can end it, and the window is already
closing. Whatever has not finished at the deadline is left exactly as it would have been
without the handler.

The wait watches the slot, not the run identifier it cancelled. `ExportSlot` drops after both
the child guard and the reservation guard, so a free slot is the signal that the worker ran its
guards to completion.

The handler blocks the event loop thread inline. It therefore does not call `prevent_exit`,
which would need a second path to resume the exit.

## Consequences

- A quit during an export ends the `ffmpeg` child and removes the temporary file, in the
  ordinary case.
- A quit takes up to 5 seconds longer while an export runs. The interface shows nothing during
  that wait. A later unit can report it; this record does not require one.
- The cancel flag is read by the export supervisor between two polls, and by the command
  between preparation and the worker. An export still in preparation therefore stops at the
  first of those reads.
- The handler covers the event that Tauri raises when the last window closes. Whether the macOS
  application menu Quit item and `Cmd+Q` raise the same event is not established by reading, and
  `tauri.conf.json` configures no menu, so Tauri builds the default macOS menu whose Quit item
  ends in the `terminate:` selector. **This needs a manual check on macOS: start an export, then
  press `Cmd+Q`.** If that path does not raise `ExitRequested`, the orphan remains reachable on
  one of the two shipping platforms, and a later unit must handle the menu event or route the
  quit through the same wait.
- Nothing exercises the wiring above `cancel_active_export`. The tests call that function
  directly, because no test in this repository can start the application.
