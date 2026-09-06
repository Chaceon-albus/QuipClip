# 016. Run one export at a time, and report it through one event

- Status: Accepted
- Date: 2026-09-06
- Deciders: capric98

## Context

ADR 004 gives the semantic steps of an export. ADR 014 selects the command shape. The Rust modules
that perform those steps are complete and tested: `plan`, `graph`, `arguments`, `output`,
`process`, `progress`, `registry` and `fsinspect`. No production code calls any of them. There is
no export command, `lib.rs` registers none, and the Export item in the File menu is disabled.

Three rules that an export must obey are in the code today, and no decision record holds them.

**The single-flight rule.** `ExportRegistry` permits one export at a time. Its module doc reasons
from ADR 006. Two exports that run at the same time compete for the same encoder hardware. ADR
006 already records that false-negative problem for the smoke tests.

**The cancellation rule.** ADR 015 states the gap directly:

> `PendingOutput::commit` requires its caller to test `ExportSlot::is_canceled` before the rename.
> No decision record holds that rule, and `ffmpeg/export/output.rs` holds it.

**The publication wait.** ADR 015 sized its retry budget at 511 milliseconds for a settings file
and a cache file. It defers the export:

> This decision does not size the wait for the export publication. [...] The decision that gives
> `PendingOutput::commit` a production caller must size that wait, and must specify the report that
> the user sees while the wait continues.

This decision adds that caller, so it closes all three gaps.

One more constraint comes from the interface. `src/features/export/types.ts` is committed. Its
tests pin 26 error codes in a fixed order, and they pin the event union. The command must produce
exactly those codes and those payloads.

## Decision

### One export at a time

The command claims the slot with `ExportRegistry::begin`. `None` means an export is already
running, and the command rejects with `exportAlreadyRunning`.

This is a refusal, not a replacement. ADR 006 lets a second capability probe supersede the first,
because a probe only reads. An export writes a file the user named, so a second export must not
start and quietly take the first one's place.

The command claims the slot before it answers the interface, and then moves the slot to the worker
thread. `ExportSlot` owns an `Arc<ExportRegistry>` for that reason: Tauri lends managed state for
the length of the command, and the run outlives the command.

### The cancel is tested twice

Once before `ffmpeg` starts, and once after the process exits and before the rename.

The second test is the one that matters. Without it, a cancel that arrives during the last seconds
of an encode still renames the output over the file the user chose. The interface then reports a
cancelled export while that file stays on disk.

A cancel that arrives after that second test still publishes. The window is small, and this
decision accepts it. A cancel cannot un-rename a file. A rename that stops half way is worse
than a publication the user did not want.

### The publication waits for 30 seconds

`EXPORT_PUBLISH_BUDGET` is 30 seconds. `fsutil::replace_file` keeps its 511-millisecond budget for
every other caller.

The reason is the cost, not the probability. The encode already cost minutes. `PendingOutput`
arms a cleanup guard that deletes the temporary file on an early return, so a rename that gives up
destroys the finished encode. Waiting seconds is better than that. A virus scanner that reads back
a file of several gigabytes holds it for seconds, which 511 milliseconds does not cover.

The budget is a limit and not an unbounded wait. A different application that holds the
destination open, such as a media player, can hold it for as long as the user leaves it open. Only
the user can clear that condition, so QuipClip reports it instead of waiting for it.

### The interface hears about the wait

The event union gains a `publishing` variant. The command emits it after the process exits and
before the rename.

**Nothing is processed in that phase.** The encode is complete, the frame count is verified, and
the cancel flag is tested. Only the rename remains.

The name is therefore not `postProcessing` and not `finalizing`. `-movflags +faststart` is a real
post-write pass, and it happens earlier, inside `ffmpeg`, before the process exits. A name shared
between the two phases would tell a reader that the bytes are still changing when they are not.
`publishing` also matches the words `output.rs` and ADR 015 already use.

The interface does not show that word. It shows "Finishing...". ADR 011 puts a stable code on the
wire and the sentence in the catalogs, and this follows that split.

### The encoder test reports only a known failure

The command reports `encoderUnavailable` only when the capability cache of ADR 006 positively
records that this encoder failed its smoke test.

A cache miss does not block an export. The cache is a cache, and a user who has never run a probe
must still be able to export. `ffmpeg` reports a bad encoder at the first frame, and the command
maps that to `ffmpegProcessFailed` with the diagnostic text.

### One event, one name

All four progress reports, and the new fifth, cross on the event `export:progress`. The payload is
a tagged union, and every variant carries the `runId` that the command returned.

This mirrors ADR 006. One event name gives the interface one subscription, one validator and one
order of arrival.

### The frame count decides success, not the exit status

ADR 014 requires the comparison. This decision records why the command cannot skip it.

`PendingOutput::reserve` creates the temporary file before `ffmpeg` starts. ADR 014 therefore
requires `-y`. Without it, `ffmpeg` refuses the existing file, prints an error, and **exits with
status zero**. A command that trusted the exit status would rename an empty file over the video of
the user. The frame count is the only signal that separates the two outcomes.

## Consequences

- The four steps of the product work end to end: import, preview, mark and export.
- A second export is refused while one runs. The interface must show that state rather than let
  the user press the button twice.
- A cancel during the last seconds of the publication still writes the file. The interface must
  not promise that a cancel always prevents an output.
- An export waits up to 30 seconds before it reports a failed publication. A user whose media
  player holds the destination open sees a failure after that wait, not at once.
- The export is the first caller of `fsutil::replace_file_within`. Every other caller keeps the
  511-millisecond budget of ADR 015, so this decision changes no existing write path.
- The command is the first user of Tauri managed state in this repository.
- A machine with no capability cache exports with no encoder test. A broken hardware encoder then
  fails at the first frame, and the report names the `ffmpeg` diagnostic instead of the encoder.
- The export worker runs on a dedicated thread. A blocking pool sized for short work is wrong for
  a process that can run for minutes.
- ADR 014 requires the interface to refuse more than 100 segments before the user marks them. This
  decision does not add that warning. `build_plan` still reports `tooManySegments`, so the failure
  is reported late, and the timeline work that reports it early is separate.
