# 051. List the export queue for a new page

- Status: Accepted
- Date: 2026-10-28
- Deciders: capric98
- Amends: ADR 016, ADR 025, ADR 049

## Context

The backend runs the export queue (ADR 049). The web view keeps a copy of the batch in two
stores: the export store and the queue store. It builds that copy from the answers of
`start_export` and from the events of `export:progress`.

A reload of the page, or a crash of the web view, loses that copy. The backend queue goes on.
The page that loaded again then shows no progress and no waiting runs. The user cannot stop the
run, and the quit guard (ADR 027) counts no work. Tauri gives an event only to the listeners
that exist when the event goes out. So a page that loaded again cannot read the events that
came before it.

The user asked for a command that gives the state of the queue at any time. The user also
chose that a page that loaded again restores a batch only while a run of that batch has not
ended.

## Decision

### The backend keeps a journal of the batch

`ExportJournal` (`src-tauri/src/commands/export_journal.rs`) is Tauri managed state.

- `start_export` records the facts of each run before it submits the run: the output path, the
  name of the preset, the number of segments, and the streams. A run that the closed queue
  refused leaves the journal.
- Every export event goes through the journal. Under one lock, the journal gives the event the
  next sequence number, applies the event to the record of its run, and sends the event. So
  the numbers come in the order in which the events go out, and the journal and the events
  always agree.
- A run has one of these phases: `waiting`, `preparing`, `running`, `publishing`, `finished`,
  `failed` and `canceled`. A run that a cancel removed from the list of waiting runs leaves the
  journal, as it leaves the list of the interface.
- The journal keeps at most 64 ended runs, as the record of published runs does (ADR 029). The
  limit never removes a run that did not end.
- A request with `newBatch` makes the journal remove the ended runs first. The interface sends
  it only when it starts a new batch. So the journal holds the runs of the batch that the
  interface shows, but at most the last 64 ended runs.

The lock is held while the event goes out. That is safe because a send from a thread that is
not the main thread only puts a message in the queue of the event loop. This needs the
`tracing` feature of `tauri-runtime-wry` to stay off. No code may take the lock on the main
thread, in a Tauri callback, or in a Rust listener of an event. The module states this. A debug
build checks the main thread only. For the same reason, `export_queue_snapshot` is an `async`
command, so it does not run on the main thread.

### Each event carries its number

The payload of `export:progress` gains `seq`, the number that the journal gave the event. `seq`
is a field at the top level of the payload, next to the fields of the event. So a reader that
does not read it sees the event as before.

### The command `export_queue_snapshot` lists the batch

The command takes no argument. It answers `{ seq, runs }`. `seq` is the number of the last
event that went out before the snapshot. The runs come in this order:

1. the ended runs, in the order of their end,
2. the run that holds the slot,
3. the waiting runs, in the order of the queue,
4. the waiting runs that the queue does not list, in the order of submission. An example is a
   run that just took the slot and did not send `preparing` yet.

Each run carries its facts and its phase. It also carries the last frame and the frame goal
when the run reported them, and the error of a run that failed or was canceled. A run that sent
`preparing` and did not end carries `elapsedMs`, the time since its `preparing`. An ended run
carries `endOrder`. That number only sorts. It has gaps.

### A page that loaded again restores the batch

`src/features/export/recovery.ts` runs once per page, from an effect of the application shell.

1. It closes a gate (`recoveryGate.ts`). `submit` of the queue store waits at that gate before
   its check of the output path. So a submission cannot start a batch that the restore then
   replaces.
2. It subscribes both stores, and a listener of its own that keeps each event until the
   restore. All three are live before the snapshot call. So no event can fall between the
   subscriptions and the snapshot.
3. It reads the snapshot. When no run waits, prepares, runs or publishes, the batch is over,
   and the page restores nothing.
4. Otherwise, in one synchronous task, it does these steps:
   - It raises a sequence floor (`eventFloor.ts`) to the `seq` of the snapshot. Both stores
     ignore each event at or below the floor, because the snapshot holds it.
   - It restores the run that holds the slot into the export store, and then the batch into
     the queue store. A snapshot between two runs leaves the export store idle.
   - It starts the run timing at the current time minus `elapsedMs`.
   - It gives each kept event above the floor, in the order of the numbers, first to the
     export store and then to the queue store.
5. It opens the gate.

The gate always opens: after a failure of a subscription or of the snapshot, after a time
limit of 10 seconds, and after a restore that throws. The limit covers the subscriptions and
the snapshot call together. A snapshot that comes after the limit is ignored.

A start of the page before the reload can reach the backend after the snapshot. Its run is in
neither store. The page learns of it from its `preparing` event, with a number above the
snapshot, for a run that neither store knows. The recovery then closes the gate, reads the
snapshot once more, and restores again. While a submission of this page has no answer, such a
run can be the run of that submission. The recovery checks it again when no submission of this
page waits for its answer. It reads the snapshot again at most once per page.

## Consequences

- After a reload, the dialog lists the runs of the batch again, with Show File for each
  finished run (ADR 029). The status bar, the Dock and the task bar show the run again (ADR
  025). Stop and Remove work, and the quit guard counts the runs (ADR 027).
- The run timing keeps the start of the run. So the elapsed time is correct, and a run that
  ran 30 seconds or more before the reload still needs two clicks on Stop (ADR 025).
- A batch that ended before the reload is not restored. Its files stay on the disk, and the
  page cannot show them with Show File.
- A restored run shows no speed and no time estimate until its next progress report, because
  the snapshot holds no `fps`.
- A run whose start reached the backend after the snapshot sends no event until it starts.
  Until then, the page does not know it, and the quit guard does not count it. A quit then
  stops it with no question (ADR 027). When the runs that the page knows end, the page can
  show the batch as over and ask for attention (ADR 025). The run then starts, and the page
  reads the snapshot again and shows it.
- The page reads the snapshot a second time only once. A second unknown run after that is not
  shown, and it still runs.
- When the subscriptions and the snapshot do not answer in 10 seconds, or when one of them
  fails, the page restores nothing. It also does not read the snapshot again. Submissions then
  start as before.
- The journal adds one lock to every export event. The lock has the precondition above.
