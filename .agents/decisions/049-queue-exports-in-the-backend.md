# 049. Queue exports in the backend

- Status: Accepted
- Date: 2026-10-27
- Deciders: capric98
- Amends: ADR 016, ADR 017, ADR 020, ADR 024, ADR 025, ADR 027, ADR 029, ADR 031, ADR 041
- Amended by: ADR 050, ADR 051, ADR 053

## Context

ADR 016 runs one export at a time and refuses a second export while one runs. The Export
action then only shows the running export (ADR 024, ADR 025). The user asked for more: while an
export runs, the user can set up another export, and that export waits and starts when the
exports before it end.

Three facts shape the decision.

- Two exports must still not run at the same time. They compete for the same encoder (ADR 006,
  ADR 016).
- The web view does not always run. On macOS 14 and later, WKWebView suspends a web view that
  is not visible, by default (`inactiveSchedulingPolicy`). A queue that the web view drives
  stops while the window is minimized.
- The setup step shows the encoding settings of the preset. An export that waits must render
  what the user saw, and it must not cut the frames of a source file that changed while it
  waited.

## Decision

(Changed on 2026-10-28.) With several sources (ADR 053), a run stores the size and the
modification time of each source, and preparation compares and re-probes each source that a
piece names.

### The backend holds the queue

`ExportRegistry` keeps the run that holds the slot and a list of the runs that wait, under one
lock. The list is first in, first out.

- `start_export` hands each export to `ExportRegistry::submit`. When the slot is free, the run
  starts at once. Otherwise it waits at the end of the list.
- The command answers at once with `{ runId, queued }`. The run prepares on its own export
  thread (ADR 016).
- When a run releases the slot, the registry gives the slot to the first waiting run in the
  same critical section, and starts it after the lock is released. A run that comes at that
  moment waits behind the list.
- Every end of a run releases the slot: a success, a failure, a cancel, a panic, a failure of
  preparation, and an export thread that the system refused. So every end starts the next run.
- A run whose export thread runs sends `preparing` first. A run that a cancel removed from the
  list, or whose thread the system refused, sends only `failed`.
- The events of one run keep their order. A run sends its last event before it releases the
  slot, so that event comes before the `preparing` event of the next run.

The backend is the authority. The web view keeps a copy of the list for display, which it
builds from the answers of `start_export` and from the events, by run id. It only submits,
removes and shows. A web view that the system suspends does not stop the queue. When the web
view runs again, it reads the events that waited, in their order.

(Changed on 2026-10-28.) The backend also keeps a journal of the runs of the batch. A page that
loaded again reads it with `export_queue_snapshot` and builds its copy from it (ADR 051).

### A run is fixed when the user submits it

The request carries everything that the run renders with:

- the segments and the output streams, as before,
- the whole preset that the setup step showed (ADR 024),
- the size and the modification time of the source that the segments were marked against
  (ADR 024).

`start_export` checks the preset before the run waits. Preparation compares the revision of
the source file just before the re-probe.

A run still reads the machine when it starts. It finds ffmpeg, re-probes the source, and checks
and reserves the destination. A run that waited can therefore fail on a destination problem
that came up while it waited.

### A cancel names the run

`cancel_export` stops the run that holds the slot, or removes a run that waits. A run that
leaves the list sends `failed` with `canceled`. That event and the `preparing` event of another
run can come in either order, so the interface matches each event to its run by run id. A
failure or a cancel of one run does not stop the runs after it.

### The exit closes the queue

`ExportRegistry::close_for_exit` refuses every later run and drops the runs that wait. It sends
no event for them, because the window is closing. The exit handler calls it before it cancels
the running export and waits for its slot (ADR 017). Otherwise the release of the slot would
start the next run during the exit. A request after the close fails with `exportQueueClosed`.

### The interface

- The Export action, while a run is live, runs wait, or a submission has no answer yet, opens
  the setup step for a new export.
  Its button reads "Add to Queue…". The run footer offers the same action as "New Export…".
- That setup step keeps its own state. Its checks and a refused submission report there, and
  never into the export store, so a setup never hides or resets the running export.
- Cancel and Close leave the setup and show the run again, or close the dialog when the export
  store is idle. The close control and Escape leave the setup and hide the dialog. Neither
  resets the export store.
- A new batch starts only when the export store is idle. While the export store shows the
  result of a run that ended, the next submission goes through the queue of the backend, which
  starts it at once when the slot is free. The run that ended stays in the list with Show File.
- A refusal that comes after the user left the setup opens that setup again, so the user sees
  why the export did not start.
- The dialog lists the runs of the batch in the order of submission: the runs that ended, the
  run that holds the slot, and the runs that wait. A finished run keeps Show File (ADR 029). A
  waiting run can be removed.
- The interface refuses an export whose output path is the path of the running export or of a
  waiting export, with `outputAlreadyQueued`. It compares the paths without regard to letter
  case.
- The status bar shows the number of waiting runs. The Dock and the taskbar ask for attention
  once, when the batch ends. A batch ends when no run waits, no submission has an answer
  pending, and every run of the batch has ended (ADR 025).
- The quit guard counts the waiting runs, and the submissions to the queue that have no answer
  yet, as work that a quit loses (ADR 027).
- The main window sets `backgroundThrottling` to `throttle`, so the Dock progress and the
  request for attention still work while the window is minimized.

## Consequences

- A second export is no longer refused. The code `exportAlreadyRunning` no longer exists.
- The queue goes on while the window is minimized or hidden. The Dock progress can lag, and
  the list of the dialog catches up when the web view runs again.
- A reload of the page, or a crash of the web view, loses the list in the interface. The
  backend queue goes on. A command that lists the queue for a new page is separate work.
  (Changed on 2026-10-28: `export_queue_snapshot` lists the batch, and a page that loaded
  again restores it while a run of the batch has not ended, ADR 051.)
- The command refuses a preset test (ADR 041) for the whole batch, because an export holds the
  slot until the list is empty.
- A run that hangs in a step of preparation without a time limit, such as the discovery of
  ffmpeg on a share that stopped answering (ADR 016), holds the slot. The runs after it wait,
  and a cancel takes effect only when that step returns. (Changed on 2026-10-27: preparation
  ends after 180 seconds, or about 2 seconds after a Stop, and the next run starts, ADR 050.)
- The record of published runs keeps 64 runs (ADR 029), so Show File works for each run of a
  long batch.
- The revision check has the limits of ADR 010. It does not see a replacement of the same size
  inside the same second, or a change after its one read.
