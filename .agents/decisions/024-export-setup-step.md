# 024. Choose the preset in the export dialog, before the save dialog

- Status: Accepted
- Date: 2026-09-22
- Deciders: capric98

## Context

The export action opened the native save dialog at once. The export started as soon as the
user named a file. It used the active preset, and the user could change that preset only in
the Settings dialog. The export dialog did not show which preset the export used.

The user reported that an export started before they could choose a preset.

## Decision

The export action opens the export dialog first, at a setup step. The flow has four steps:

1. The flow controller examines the state that makes an export impossible or doubtful:
   - An export that is in progress. The dialog opens on that export.
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

## Consequences

- An export needs one more click.
- The user sees the preset before each export.
- The flow controller has two entry points. One opens the setup step. The other starts the
  export. Each has its own tests.
- An export can write the settings file. A settings conflict (ADR 013) from that write shows
  in the Settings dialog, not in the export dialog.
