# 027. Confirm a close or a quit that would lose work

- Status: Accepted
- Date: 2026-09-23
- Deciders: capric98
- Amends: ADR 017

## Context

Version 1 writes no project file. The segments live only for the session. A click on the
close button, `Alt+F4`, the red window button or `Cmd+Q` therefore removes every marked
segment at once, with no warning.

ADR 025 lets an export continue while its dialog is hidden. A user who forgets the hidden
export can now close the window during a long encode. ADR 017 then cancels the export, and
the encode is lost.

The Settings dialog can also hold an unsaved preset draft. A close drops it.

ADR 017 says: "A quit cancels the export. It does not refuse the quit." It chose this
because the window was already closing and there was no way to ask. The user now asked
for a confirmation, and the frontend can ask before the window closes.

## Decision

A close or a quit asks for a confirmation when it would lose one of these:

- one or more segments, or a pending In point, of the open source;
- an export that is preparing, running or finishing;
- an unsaved preset draft in the Settings dialog.

When nothing would be lost, the close or the quit continues at once, with no dialog.

### One path for every way to close

Every way to close goes through the same frontend decision.

1. **The window close.** The close button, `Alt+F4` and the red window button raise the
   close request of the window. The frontend listens with `onCloseRequested`. It always
   cancels the request, and then runs the decision.
2. **The application quit.** `Cmd+Q` and the Quit item of the macOS application menu raise
   `RunEvent::ExitRequested` in Rust. While a window is open and the quit is not confirmed,
   Rust calls `prevent_exit` and sends an event to the frontend. The frontend then runs the
   decision.
3. **The decision.** If nothing would be lost, the frontend calls the `confirm_quit`
   command at once. Otherwise it shows a confirmation dialog that names what would be lost.
   Cancel is the default button. Quit calls `confirm_quit`.
4. **`confirm_quit`.** Rust marks the quit as confirmed and calls `exit(0)`. That raises
   `ExitRequested` again. The quit is now confirmed, so Rust does not prevent it, and the
   ADR 017 handler cancels the export and waits its bounded time.

When no window is open, Rust never prevents the exit. The frontend could not answer.

### What this changes in ADR 017

ADR 017 still cancels a running export on exit and waits at most 5 seconds. The sentence
"It does not refuse the quit" no longer holds: a quit that would lose work is refused once,
until the user confirms it. The handler also calls `prevent_exit` now, which ADR 017 did
not.

## Consequences

- A close with segments, an active export or an unsaved preset draft shows one dialog. A
  close with nothing to lose closes at once.
- `Cmd+Q` on macOS reaches the same dialog. This closes the open question in ADR 017 about
  the Quit menu item, provided that `Cmd+Q` raises `ExitRequested`. A manual check in the
  built `.app` must confirm this.
- If the web view stops answering, the window close does nothing, because the frontend
  owns the decision. The user can still force the application to quit through the
  operating system.
- The window needs the `core:window:allow-destroy` permission only if the frontend closes
  the window directly. With `confirm_quit`, Rust ends the application, so the frontend does
  not destroy the window.
