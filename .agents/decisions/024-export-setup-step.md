# 024. Choose the preset in the export dialog, before the save dialog

- Status: Accepted
- Date: 2026-09-22
- Deciders: capric98
- Amended by: ADR 038, ADR 036, ADR 048, ADR 049, ADR 052, ADR 053

## Context

The export action opened the native save dialog at once. The export started as soon as the
user named a file. It used the active preset, and the user could change that preset only in
the Settings dialog. The export dialog did not show which preset the export used.

The user reported that an export started before they could choose a preset.

## Decision

(Changed on 2026-10-28.) On a sequence of several clips, the table "What replaces the active
source" in ADR 052 gives the replacement for each rule here that names the active source.

The export action opens the export dialog first, at a setup step. The flow has four steps:

1. The flow controller examines the state that makes an export impossible or doubtful:
   - An export that is in progress. The dialog opens on that export. (Changed on 2026-10-27:
     the dialog opens a new setup step, and the new export waits in the queue, ADR 049. The
     checks of this step report into the state of that setup, not into the running export.)
   - No open media. The dialog reports `sourceNotFound`.
   - No segment for the active source. The dialog reports `noSegments`.
   - A source file that changed on disk. The dialog shows the `sourceRevisionChanged`
     confirmation.
2. The dialog shows the setup step. The step lists the presets and selects the active
   preset. If no preset has the active identifier, the step selects the first preset. The
   step shows a summary of the selected preset: the container, the two encoders, the
   quality, the audio bitrate, the sample rate, the channels, the resolution, and the frame
   rate.
3. The user selects "Export…". The native save dialog opens with the file extension of the
   container of the selected preset.
4. The export starts with the identifier of the selected preset.

Step 1 comes before the setup step, so the user never configures an export that the
application then refuses. "Export anyway" skips the source check and continues at step 2.

(Changed on 2026-10-27.) Step 4 sends the whole selected preset, as the setup step shows it,
and not its identifier. The run renders with that preset and does not read the presets of
the settings file. An export that waits in a queue therefore renders the settings that the
user saw, also when the user edits or deletes the preset while the export waits.

- `start_export` checks the preset with the rules of the settings file before it accepts the
  export. It refuses an invalid preset with `invalidPreset`.
- The backend codes `settingsUnreadable` and `presetNotFound` are removed, because the export
  reads no preset from the settings file.
- The flow controller still reports `presetNotFound` when the settings hold no preset with
  the selected identifier. The code is now a frontend code.
- The settings file still gives the configured path of ffmpeg. The run reads it when it
  starts, because the path belongs to the machine and not to the export.

(Changed on 2026-10-27.) Step 4 also sends the revision of the source that the segments were
marked against: the size and the modification time that the import read. An export can wait
in a queue, and the file can change while it waits.

- Preparation reads the file again, in the same way as the import, just before the re-probe.
  When the size or the whole-second modification time differs, the export fails with
  `sourceRevisionMismatch`, and the failed panel offers Back. Back runs step 1 again, and its
  check then raises the `sourceRevisionChanged` confirmation.
- The comparison has the limits of the revision of ADR 010. It does not see a replacement of
  the same size inside the same second, a copy that keeps the modification time, or a change
  after that one read.
- A read that fails is not a mismatch, as in step 1. The re-probe and the plan report a file
  that is gone, or that is no longer a regular file, with codes of their own.
- Step 1 stops its read after 3 seconds, and the backend read has no time limit. On a share
  that answers more slowly than that, Back does not raise the confirmation, and the export
  fails again. The user can then open the file again.
- After "Export anyway", step 4 sends no revision, and the backend checks nothing. A close,
  Back, or a started export ends that acceptance.

A cancel in the save dialog returns the user to the setup step. The export store stays
`idle`, so a second attempt needs no new check.

The setup step disables "Export…" in three conditions:

- The save dialog is open.
- No preset exists.
- The selected preset pairs a container with an audio encoder that ADR 023 lists as a
  conflict.

The setup step marks an encoder that the capability probe reports as unavailable, with the
badge of the preset list. The mark does not block the export. ADR 013 lets a preset name an
encoder that this machine does not have, and the interface marks it instead of hiding it.

**The selected preset becomes the active preset.** When an export starts with a preset that
is not the active preset, the controller saves its identifier as `activePresetId`. The next
export then selects it first.

That save does not delay the export, and a failed save does not stop the export. Rust reads
the preset from the settings file by its identifier, and the file already holds that preset.
(Changed on 2026-10-27: the request carries the whole preset, so Rust reads no preset from
the file.)
The settings store keeps the error of a failed save, and the Settings dialog shows it.

The active preset therefore means the preset of the last export, or the preset that the user
set in Settings. The action in Settings that sets it stays.

(Changed on 2026-09-24.) The interface calls the active preset the default preset: the
action is "Set as Default", and its row carries a Default badge. The default preset is still
the preset of the last export or the one set in Settings, so an export with another preset
moves the badge. The action that brings back the seeded presets is "Restore Built-in
Presets", so the word "default" has one meaning. The settings file and the code keep the
name `activePresetId`.

The export button and the File menu item still call one handler (ADR 020). That handler runs
step 1.

(Changed on 2026-09-24.) Step 1 runs once at a time for one file: a second call for the same
media path does nothing, and a call for another path replaces the old step, whose late result
is then dropped. The check of the source revision waits at most 3 seconds, and a timeout
counts as a failed read, so the setup step opens.

(Changed on 2026-09-24.) Manage Presets… and Open Settings… in the setup step open
Settings on the Presets tab with the preset that the step shows. The export flow, not the
export store, keeps the chosen preset while Settings is open. When Settings closes by any
path, the setup step opens again with this preset selected: the one the user selected in
Settings, if it changed there and still exists; else the kept choice, if it still exists;
else the default. The return is dropped when the store is not idle, when a run is live, or
when the media closed or changed its path, size or modification time. A Settings opening from
anywhere else never returns.

Each return runs step 1 again, with its source check, and Export stays disabled until the
check answers. That run replaces a step for the same file that still waits, for example the
check of an earlier Back; otherwise that step would hold the guard, and the return would get
no check. A close of the dialog while such a check waits leaves Export unavailable until the
check answers, at most 3 seconds.

(Changed on 2026-10-02.) The preset summary carries a switch for the video and one for the
audio, and the save dialog proposes the extension of the chosen output (ADR 036).

(Changed on 2026-10-02.) Settings is its own window (ADR 038). Manage Presets… and Open
Settings… open that window on the Presets tab with the preset of the step, and the export
dialog stays open. The return to the setup step and its second source check are removed. The
list of presets of the step follows each write of the settings file, and a preset selected in
Settings does not become the choice of the step.

(Changed on 2026-10-23.) The preset summary can carry a Copy audio switch at the end of the
Encoder row of the Audio group, for an export of one segment (ADR 048). While it is on, the
Audio group names the codec, the sample rate and the channels of the source, and the step shows
no size estimate.

(Changed on 2026-10-28.) With several sources, the step shows the values that the plan of
ADR 053 finds: the canvas, the frame rate, the sample rate and the channel layout. The limit of
`tooManySegments` counts pieces, and the Copy audio switch needs an export of one piece
(ADR 053).

## Consequences

- An export needs one more click.
- The user sees the preset before each export.
- The flow controller has two entry points. One opens the setup step. The other starts the
  export. Each has its own tests.
- An export can write the settings file. A settings conflict (ADR 013) from that write shows
  in the Settings dialog, not in the export dialog.
