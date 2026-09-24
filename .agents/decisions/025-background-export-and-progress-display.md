# 025. Let an export continue behind the editor, and show its progress in three places

- Status: Accepted
- Date: 2026-09-22
- Deciders: capric98

## Context

The export dialog refused every dismissal while an export ran. The rule was
`isExportDismissalRefused`. It hid the close control and it blocked Escape and the outside
click in `running`, in `publishing`, and in `preparing` with a run identifier. The user could
only wait or cancel. The user could not mark more segments while the encode ran.

The dialog showed a plain bar with no percent, no time estimate, and no accessible role.

The backend already reports everything that a progress display needs. Each `-progress`
block of `ffmpeg` becomes one `progress` event on `export:progress` (ADR 016). The event
carries `frame`, `expectedFrames`, `fps`, and `speed`. The export store is one instance for
the whole application, so the state of a run does not depend on the dialog.

The user asked for these changes:

- A progress bar component with a determinate mode, an indeterminate mode that moves from
  side to side, and a gradient that moves along the filled part.
- A close action that does not stop the export.
- A progress indicator in the status bar while the dialog is hidden.

## Decision

### A dismissal hides the dialog while a run is active

`resolveExportDismissal` replaces `isExportDismissalRefused`. It answers `hide` in
`preparing`, `running`, and `publishing`. It answers `close` in every other status.

- `hide` closes the dialog. It does not reset the store, and it does not cancel the run.
- `close` closes the dialog and resets the store. This is the behavior of every dismissal
  before this decision.

The close control, Escape, and the outside click all use that rule. The footer of an active
run shows two buttons: Stop Export and "Run in Background". Stop Export keeps the cancel
rules from ADR 016. "Run in Background" hides the dialog.

A dismissal never cancels. Only the Stop Export button cancels.

(Changed on 2026-09-23. The button was named Cancel. The setup step shows a Cancel button
in the same place, and that button only closes the dialog. The same word in the same place
had two results, and one of them discards the work of the encode. The button is now Stop
Export, in the destructive style. The close control of an active run says "Hide (export
continues)". A stop that the user asked for shows in a neutral style, not as an error.)

### A long run needs a second click to stop

A run that started 30 seconds ago or more needs two clicks on Stop Export. The first click
changes the button to Confirm Stop for 3 seconds. A second click in that time stops the run.
A second click that comes less than 500 ms after the first does nothing, so a double-click
cannot arm and stop in one gesture. 500 ms is the default double-click time on macOS and on
Windows. A run shorter than 30 seconds stops on one click, because it costs little to start
again. `src/components/export/exportStopPresenter.ts` holds the rule and its constants.

**This replaces the last section of ADR 016, "Dismissing the dialog during preparation now
cancels".** That section cancelled by slot on a dismissal because the dismissal reset the
store. A reset store could not learn the run identifier, so the run became an orphan that
held the export slot. A hidden dialog does not reset the store. The store keeps the start in
flight, learns the run identifier when `start_export` answers, and tracks the run to its end.
No orphan is possible, so the dismissal has no reason to cancel. The Cancel button still
cancels by slot in `preparing` with no run identifier.

### The store holds the cancel request

The dialog held two local flags: `cancelingRunId` and `unnamedCancelPending`. The status bar
also has to show "Stopping…", and it cannot read the local state of the dialog. The store
therefore holds `cancelRequested`.

1. `cancelExport` sets `cancelRequested` to true before it calls the backend.
2. When the call answers, the store writes the answer back to `cancelRequested`. It writes
   the answer only while the store still tracks the same start or the same run.
3. `startExport` and `reset` set `cancelRequested` to false.

Step 2 keeps a property of the old flags. A cancel by slot can arrive before the backend
claims the slot. The backend then answers false, the button becomes available again, and the
user can ask again.

### The open state of the dialog is in a store

`exportPanelStore` holds the open state of the export dialog. The title bar held that state
in a local `useState`, and the status bar could not open the dialog. The dialog still has one
mount, in the title bar component (ADR 020).

### The status bar shows a hidden export

The status bar shows an indicator when the dialog is hidden and the export status is not
`idle`.

- An active run shows a small progress bar, the percent, and the time estimate. A click
  opens the dialog.
- A run that ended shows its result: finished, failed, or canceled. A click opens the dialog
  on that result. A dismiss control resets the store.

The result stays until the user acts. A dismissal of the dialog in a final status resets the
store. A final status with a hidden dialog therefore always comes from a run that ended while
it was hidden.

The indicator is a leaf component. It reads the progress fields itself, so a progress event
does not render the whole status bar again.

(Changed on 2026-09-24.) The store exposes `tracking`. It is true while the store tracks a
start or a run that the backend can still prepare or encode. It becomes true at
`startExport`, so it is true in `preparing` before the run identifier is known. It becomes
false when `start_export` refuses the start, when the `finished` or `failed` event of the run
arrives, or at a reset. A Stop request that fails sets `failed` while the backend still
encodes, so `failed` alone does not mean that the run ended. The store also exposes
`encodeStarted`, which is true from the `started` event or the first `progress` event.

- Back in the failed dialog, and the dismiss control of a failed result in the status bar,
  act only while `tracking` is false. Otherwise the reset would drop the only record of a
  live run.
- When a run ends in `finished` or `failed` with `tracking` false while the window does not
  have the focus, the frontend calls `requestUserAttention(Informational)` once for that run.
  macOS bounces the Dock icon once, and Windows flashes the taskbar button until the window
  gets the focus. A `canceled` run does not ask, because the user chose that result. A start
  that the backend refuses counts as an end, because the prepare step can take up to 30
  seconds. A failed focus query or request is ignored. The capability file grants
  `core:window:allow-request-user-attention`.
- A polite live region in the status bar announces the result while the dialog is hidden.
  It announces no progress.

A Stop request that the IPC layer rejects does not end the tracking, in both of its forms:

- `cancel_export` rejects. The store keeps the run that it knows by its identifier.
- `cancel_active_export` rejects while the start waits for its run identifier. The store
  keeps the start. It takes the later `start_export` answer and tracks the run to its end.

In both forms the store reports `failed` with `tracking` true. The error is the failure of
the request, not a failure of the run, and each failure gets its own error object. A failure
during `publishing` changes nothing, because Stop is off for the rename (ADR 016). The dialog
shows "QuipClip could not stop the export. The export continues." under the bar of the run,
with Stop Export and Run in Background. Stop can be tried again: by run identifier when the
store has one, and by slot while the start still waits. The status bar shows the run as
active, with the line "Stop failed · export continues", and announces the failure once
while the dialog is hidden. The `started` and `publishing` events return the run to its
phase and clear the error. No orphan is possible, so the statement above holds.

### A live run is never reset

`isExportRunLive` is the one rule for a live run: an active status, or `failed` while
`tracking` is true. Four more places read it.

1. **Close, the close control, Escape and the outside click of the dialog** hide the dialog
   while the run is live, and they do not reset the store.
2. **File > Export and the title-bar Export** open the dialog on a live run. They reset a
   final store only when the run is not live.
3. **The quit guard (ADR 027)** counts a live run as an export that a quit stops. A close or
   a quit therefore asks for confirmation, and a confirmed quit lets ADR 017 cancel the run
   that holds the export slot.
4. **The task bar** shows a live `failed` in the state of its phase, not as an error.

A hidden dialog is not in the document. The keyboard layer of ADR 021 therefore gives the
window shortcuts back to the editor with no change.

### The progress comes from the frame count

The percent is `frame / expectedFrames`. ADR 014 measurement 12 found `out_time_us` wrong
under `-copyts`, so no display uses it. The percent label rounds down, and it stops at 99
percent until the status leaves `running`.

The time estimate is `(expectedFrames - frame) / fps`, rounded up to whole seconds. The `fps`
value of `ffmpeg` is the mean since the start of the encode, so the estimate does not jump
from one block to the next. The interface shows no estimate when `fps` is absent or zero, or
when `expectedFrames` is unknown. The conversion from `Rational` to a number is for display
only (ADR 002).

(Changed on 2026-09-24.) The dialog also shows the elapsed time of the run. One small store,
`src/features/export/runTiming.ts`, records when a run starts and ends, from the same store
update that changes the status, so the finished result shows its duration on its first
frame. The progress bar stays on screen from the run into its result and takes the tone of
the result: success when finished, destructive when failed, and neutral when the user
stopped it. A `failed` status that the store still tracks keeps the running bar, because the
backend still encodes. One rule, `isExportRunLive`, says when a run is still live: an active
status, or `failed` while `tracking` is true. The dialog, the status bar and the attention
request all use it.

One pure presenter computes these values for the dialog, the status bar, and the task bar.

### The window shows progress on the Dock and the task bar

The frontend calls `setProgressBar` on the main window. The capability file grants
`core:window:allow-set-progress-bar`.

| Export status                                | Task bar state        |
| -------------------------------------------- | --------------------- |
| `idle`, `finished`, `canceled`               | None                  |
| `preparing`, or `running` with no frame goal | Indeterminate         |
| `running`                                    | Normal, with percent  |
| `publishing`                                 | Normal, 100 percent   |
| `failed` with `tracking` false               | Error, 100 percent    |

The error state stays until the store resets, the same as the status bar result.

The frontend sends the state once at start, and then only when the state or the whole percent
changes. The start call clears a bar that a reloaded web view left behind. One call is in flight
at a time. When a call settles, the frontend sends the latest state if it differs from the state
of that call. `set_progress_bar` is an asynchronous command, so two calls that are sent together
can arrive in the wrong order. A `publishing` state and a `finished` state arrive about one
millisecond apart, and the wrong order leaves a full bar after the export.

On macOS, Tauri draws the bar on the Dock icon. The Dock bar does not move in the indeterminate
state. It also keeps its last value when a state arrives with no value. On macOS the
indeterminate state therefore carries the value 0, so a new export does not show the full bar of
the previous export. On Windows the indeterminate state carries no value, because a value changes
the task bar state to normal.

### One progress bar component serves every display

`ProgressBar` is in `src/components/common/`. `src/components/ui/` holds generated shadcn code,
so the component does not go there.

- A value from 0 to 100 draws a determinate bar. No value draws an indeterminate bar.
- The filled part carries a gradient that moves at a fixed period. A fixed period keeps the
  gradient steady while the filled part becomes wider.
- The indeterminate bar is a segment one third of the track wide that moves from side to
  side.
- `prefers-reduced-motion` stops both movements and the width transition. The indeterminate
  bar then fills the track at reduced opacity.
- The component sets `role="progressbar"`, the minimum, the maximum, and the current value.
  It omits the current value in the indeterminate mode.

The publishing phase shows a full bar that keeps its gradient movement. The encode is
complete in that phase, and only the rename remains (ADR 016).

## Consequences

- The user can mark and edit segments while an export runs.
- A dismissal during preparation no longer asks the backend to stop. A user who wants to
  stop the run must press Cancel.
- The export action and the status bar indicator both open the dialog on the active run.
  The export action already did this (ADR 024).
- A quit during a hidden export still cancels the export (ADR 017). The user does not see
  the dialog at that time, so an accidental quit is more probable than before. A later unit
  can ask for a confirmation before a quit while an export runs. This decision does not add
  one.
- The Dock and the task bar show the state of the export while the window is minimized or
  covered.
- The store carries three new fields: `fps`, `speed`, and `cancelRequested`.
