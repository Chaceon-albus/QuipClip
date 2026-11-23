# 061. Adjust the gain of an export by its true peak

- Status: Accepted
- Date: 2026-11-22
- Deciders: capric98
- Amends: ADR 016, ADR 017, ADR 024, ADR 036, ADR 043, ADR 048, ADR 049, ADR 054

## Context

Many sources have a limiter that holds the sample peaks at 0 dBFS. ADR 054 explains why the
true peak after a lossy encode can then be above full scale, and why a negative gain before the
encoder leaves headroom. ADR 054 puts that gain in the preset. A preset does not know the audio
of an export, so its gain is one fixed margin for every export.

The user wants to see the integrated loudness (I) and the true peak (TP) of the audio that an
export writes. Then the user wants a gain for that one export, so that the true peak stays below
full scale after a lossy encode.

The user chose these points:

- The setup step of the export dialog (ADR 024) holds the feature, in the Audio group. That group
  already shows the gain of the preset (ADR 054).
- A switch with the label "Adjust" starts the feature. It is off by default. While it is off, the
  step shows no measurement.
- The row of the gain has the label "Gain", not "Volume". It always shows a number, such as
  "0.0 dB".
- When the user turns the switch on, QuipClip measures the audio once. Then it fills the field of
  the gain with the gain that brings the true peak to -1 dBTP. The ceiling is -1 dBTP for every
  encoder and every bitrate. The step has no button that computes the gain again.
- The filled gain only lowers the level. When the true peak is already at -1 dBTP or below, the
  filled gain is 0.0 dB. The user can still type a positive gain.
- Under the row of the gain, the step shows two lines: the measured values, and the values after
  the gain. The step shows no values for each segment.
- An export with the switch on encodes its audio, so the Copy audio switch of ADR 048 is locked.
  Its reason shows only in a tooltip, when the pointer is on the switch or the switch has the
  focus.

ADR 054 deferred a two-pass `loudnorm`. This record does not add `loudnorm`. It adds a
measurement and a linear gain that the user sees and can change.

## Measurements

These measurements used FFmpeg 9.0.2 (Homebrew `ffmpeg-full`) on macOS. The test signal was 30 s
of synthetic audio at 48000 Hz in stereo: pink noise, a 55 Hz tone whose level decays and starts
again every 0.5 s, and two sawtooth tones. `alimiter=limit=1:level=0` held its sample peaks at
0 dBFS. `ebur128=peak=true+sample` measured each file. FFmpeg decoded each lossy file for its
measurement.

1. **The limiter does not hold the true peak.** The signal had I -10.7 LUFS, a sample peak of
   0.0 dBFS and a true peak of +0.2 dBTP before any encode. A louder mix of the same parts had I
   -4.5 LUFS and a true peak of +1.4 dBTP.
2. **The encoders raised the true peak.** Each value is the true peak in dBTP after the encode:

   | Encoder and bitrate | Gain 0 dB | Gain -1.0 dB |
   | ------------------- | --------- | ------------ |
   | Before the encode   | +0.2      | -0.8         |
   | `aac` 96k           | 0.0       | -0.4         |
   | `aac` 128k          | +0.1      | -0.5         |
   | `aac` 192k          | -0.1      | +1.2         |
   | `libopus` 96k       | +0.8      | -0.2         |
   | `libopus` 128k      | +0.7      | -0.4         |
   | `libmp3lame` 128k   | 0.0       | -1.2         |
   | `libmp3lame` 320k   | +0.1      | -0.8         |

   In most cases, the encode raised the true peak by 0 to 1 dB. Opus raised it the most.

3. **One encoder wrote a spike at the start of the file.** With `aac` at 160k and at 192k, and a
   gain of -0.5, -1.0, -1.5 or -2.0 dB, the true peak after the encode was +1.2 to +2.7 dBTP. Each
   time, the peak was in the first 10 ms of the file. At 256k, and with a gain of -3.0 dB, no spike
   occurred. A file that started 0.23 s into the signal, with a second cut joined at 10.14 s, had
   no spike at its start or at the join. A measurement before the encode cannot predict this spike.
4. **Speed.** `ebur128` with the true peak read the 30 s file in 0.08 s, about 376 times real time.
   This record has no measurement of the meter that it chooses. The implementation measures it.

The signals are synthetic. They show that the rise exists, and that its size depends on the
encoder, the bitrate and the signal. They do not give an upper limit.

## Decision

### The Gain row

The row of ADR 054 in the setup step, and the field of the preset editor, get the label "Gain"
("增益"). The catalog key `settings.preset.audioGainLabel` serves both places, so they keep one
name.

The row always shows the gain with one decimal place, and with its sign when it is not 0:
"0.0 dB", "-1.0 dB", "+2.0 dB". The step no longer shows the text "No Change"
(`export.setup.audioGainNone`), and the catalogs no longer hold it.

The rule of ADR 054 for a copy does not change: while the copy is on, the Audio group shows no
Gain row.

### The Adjust switch

- The switch has the visible label "Adjust" ("调整"). It is at the end of the Gain row, as the
  Copy audio switch is at the end of the Encoder row (ADR 048). Each switch is on the row that it
  changes.
- The step shows the switch where it shows the Gain row: the export writes audio, the source has
  audio, and the copy is off.
- The switch is off by default. It lasts for the session in the store of the stream choice
  (`src/features/export/streamChoice.ts`, ADR 036), as the copy does. Nothing stores it on disk.
  The store sets it to off when the open media changes.
- While the save panel is open, the switch and the field of the gain do not change, as the stream
  switches do not.

While the switch is off, the Gain row shows the gain of the preset, read-only. The request then
carries no gain of its own, and the export does what ADR 054 states. The switch does not change
its commands.

### The switch and the copy

An export with the switch on must encode its audio, because a copy applies no gain (ADR 054).

- While the switch is on, the Copy audio switch stays in its place, off and locked. It carries
  `aria-disabled` and not `disabled`, so that it still gets the pointer and the focus. Its reason
  shows only in a tooltip, on hover and on focus: "Adjusting the gain encodes the audio, so it
  cannot be copied." The stream switches of ADR 036 show their lock in the same way.
- While the copy is on, the step shows no Gain row and no Adjust switch. To adjust the gain, the
  user must first set the copy to off.
- The store never holds both choices on. A turn of Adjust to on also turns the copy to off. This
  clears a copy that the user chose earlier and that the step does not offer now, such as after a
  second segment. A turn of the copy to on does nothing while Adjust is on.
- `resolveExportAudioMode` gives `copy` only when the copy is chosen, the step offers it, and
  Adjust is off.

### The two lines under the Gain row

When the user turns the switch on, the step starts a measurement. It shows two lines under the
Gain row:

| Line       | While the measurement runs | After a measurement that completed  |
| ---------- | -------------------------- | ----------------------------------- |
| Measured   | The progress               | `I -14.6 LUFS · TP +0.7 dBTP`       |
| After gain | Absent                     | The measured values plus the gain   |

- The values have one decimal place. The true peak shows rounded up to a tenth, as the section
  "The filled gain" states. A value that the meter does not give, such as the loudness of
  silence, shows as "—".
- While the measurement runs, the field of the gain is disabled and shows the gain of the preset.
- When the measurement completes, the step fills the field. The next section gives the value.
- The user can change the value, from -20.0 to +20.0 dB in steps of 0.1 dB. The After gain line
  changes with each change. A blank value, a value out of range, or a value with more than one
  decimal place blocks the export, as in the preset editor (ADR 054).
- The After gain line has three tones, from the true peak after the gain in tenths (section "The
  filled gain"). At or below -1.0 dBTP, the line has the normal tone. Above -1.0 dBTP and at or
  below 0, it has the warning tone. Above 0, it has the destructive tone. This tone is the
  clipping warning of the step.

The step starts a new measurement while the switch is on when the key of the measurement changes
(see below): another preset with another sample rate, channel setting or, with video, frame rate,
or another choice of the streams. The field then shows the gain of the preset again until the new
measurement completes.

The step also starts a measurement when it shows the switch already on: at a later opening of the
dialog in the same session, and when the Audio switch turns on again. The rules for a turn to on
apply. The field does not keep a value that the user typed before the dialog closed.

The page keeps each completed result in memory for the application run, by a key: the path and
the revision of each source, the pieces in order, the sample rate and the channels of the preset,
the streams, and for an export with video the frame rate of the preset. A measurement with the
same key shows the kept result at once and fills the field again. The page does not keep these
results:

- A failed or canceled measurement.
- A measurement of a source that has no revision in the request, because the user chose to export
  a changed file (ADR 024). The key cannot see a later change of that file (ADR 058).

The key holds the frame rate because the stand-in video of ADR 043 can pad the audio of each
segment with silence shorter than one frame. Another frame rate can change that padding, and the
silence at a join can change the true peak near that join. Nothing writes a result to disk.

The Export action of the step is not available while the measurement runs. Its reason says that
the measurement runs. To export at once, the user turns the switch off, and the export uses the
gain of the preset.

When the measurement fails, the Measured line shows the error and the diagnostic text of ADR 011.
The field becomes available with the gain of the preset. The After gain line is absent. The
Export action is available.

The step cancels a running measurement when the user turns the switch off, when the Audio switch
turns off, and when the dialog closes.

### The filled gain

TP is the true peak in dBTP from the end message, at full precision. The step rounds it up to a
tenth of a decibel, and the Measured line shows P / 10:

```
P = ceil(TP × 10)
```

The step fills the field with this gain G, in tenths of a decibel:

```
G = min(0, -10 - P)
```

- P + G is -10 or lower, so the true peak after the gain is -1.0 dBTP or lower. The rounding up
  is on the safe side. A rounding error of the floating point can change P only when TP × 10 is
  within about 1e-15 of an integer.
- The minimum with 0 makes the gain a cut only.
- A result below -200 becomes -200 (-20.0 dB). The After gain line then shows the tone of the
  result.
- For any gain in the field, the After gain line shows (P + gain) / 10 as the true peak. Its tone
  compares the integer P + gain with -10 and 0. The line therefore has the normal tone right
  after the fill. The integrated loudness on that line is the measured value plus the gain,
  rounded to a tenth.
- The gain of the preset has no part in the formula. With the switch on, the measurement replaces
  the fixed margin of the preset.
- When the end message gives no true peak (`null`), as for silence, the step fills 0. The After
  gain line then shows "—" for the true peak and the normal tone.

### The request

`ExportRequestWire` gets the optional field `adjustedAudioGainTenthsDb`. While Adjust is on, it
holds the value of the Gain row in tenths of a decibel. While Adjust is off, it is absent.

- When the field is present, the plan writes it as `PlannedAudio::gain_tenths_db` in place of the
  gain of the preset. The graph applies it as ADR 054 states. A value of 0 adds no chain.
- The preset in the request stays the preset of the settings file (ADR 049). The setup step does
  not write the gain into the preset.
- `start_export` refuses the request before it accepts the run, with the new code
  `invalidAudioGain`, when the value is outside -200 to 200 or when `audioMode` is `copy`.
- A run that waits in the queue uses the value that the user saw (ADR 049). The run does not need
  the measured values, so the request does not carry them. ADR 054 asks a later `loudnorm` to
  carry its measured values in the request. A linear gain needs only the gain.

### The measurement job

Two new commands start and cancel a measurement: `start_loudness_measurement` and
`cancel_loudness_measurement`. Only the main window can call them. The start command takes the
fields of an export request that decide the audio: the sources with their revisions, the pieces,
the segment count, the preset and the streams. It takes no output path. It returns at once, and
the data comes through a Tauri channel, as the envelope does (ADR 056).

**The audio that the job measures.** The job measures the audio that the encoder of the export
would receive, with a gain of 0:

- For an export with video, the job runs the audio process of ADR 043, with its graph and its
  command. That process writes 32-bit float PCM in WAV to its stdout. The job reads that stdout.
- For an export without video, the job runs the graph of the one process. It maps `[a]` to the
  output of the audio process: `pcm_f32le` in WAV on stdout. It writes no file.

The measurement therefore includes each step of the audio of the export: the cut of each piece,
the fill of silence, `concat`, and the final `aformat` with the sample rate and the channels of
the preset (ADR 023, ADR 053).

Two plans have no process that filters audio:

- A plan with video in which no piece reads an audio stream, because each audio stream holds no
  packets. The encoder generates the silence, and ADR 054 gives silence no gain. After the plan,
  the job skips the option probe of ADR 055 and starts no process. It ends `complete` with
  `null` for both values, so the step fills 0.
- A plan without video in which no source has an audio stream that holds packets. Check 13 of
  `build_plan` refuses it with `sourceHasNoAudio`, as it refuses the export (ADR 036). The job
  ends `failed` with that code.

**Preparation.** The job runs the steps of the export preparation that the plan and the commands
need: the discovery of FFmpeg, the revision check, the re-probe, the reads of the audio, the FLV
inputs (ADR 046, ADR 058), the plan, and the option probe of ADR 055. It skips the steps of the
output:

- `PlanRequest::destination` becomes optional. With no destination, `build_plan` skips its checks
  of the output path (its checks 7 to 11). An export always gives a destination, so its checks do
  not change.
- The job makes no reservation of an output file.

The job uses a work directory of the export kind (`export-`, ADR 055). It holds the graph file
and the FLV heads, as for an export. The time limits of ADR 050 apply to this preparation. The
measurement after the preparation has no time limit, and the user can cancel it.

The command of an export without video changes only in its output. The job checks it with
`check_command_line`, as the export checks its commands (ADR 014, ADR 055).

The job meets these constraints of ADR 054 for an analysis:

- It measures the audio that the export writes, after `concat` and the final `aformat`.
- It decodes the audio after the preparation, in a run of its own, not inside the preparation and
  its time limits.
- It controls its process as the export does: cancel, exit, and a process with no console window.

**The meter.** Rust reads the WAV stream and gives the samples to a meter of ITU-R BS.1770-4: the
crate `ebur128`, version 0.1, a port of libebur128 under the MIT license. Its dependencies are
`bitflags`, `dasp_frame`, `dasp_sample` and `smallvec`. The meter computes the integrated loudness
with its gates, and the true peak of each channel with oversampling. The true peak of the
measurement is the highest true peak of the channels.

- The WAV header gives the sample rate, the channel count, and the position of each channel in
  its channel mask (ADR 043). The job gives the meter the position of each channel. A
  low-frequency channel then has no part in the loudness, and the surround channels get the weight
  of BS.1770-4.
- A stream of 1 or 2 channels has no mask, and the meter uses its default order. A layout that no
  mask names, such as `downmix` or `22.2`, also arrives with no mask (ADR 043). The meter then uses
  its default order for that channel count, and the weights can be wrong for such a layout.
- A WAV stream on a pipe has no valid length in its header (ADR 043). The reader does not use the
  RIFF size or the data size. It reads the samples to the end of the stream.
- The meter runs in Rust, not in FFmpeg. QuipClip does not bundle FFmpeg (ADR 005). A meter in Rust
  gives the same values with each build of FFmpeg that a user installs.

(Changed on 2026-11-22.) The implementation of the meter found these rules:

- Above 48000 Hz, FFmpeg writes a mask also for 1 and 2 channels: the centre for mono, and left
  and right for stereo. The meter then gets these positions, and their weights are the weights of
  the default order.
- A sample that is NaN or infinite ends the measurement with `invalidAudio`. FFmpeg passes such
  values through float PCM. A NaN would stay in the filters of the loudness, and an infinity would
  hide every other peak.
- The interpolator of the true peak gives its output some frames late. At the end of the stream,
  the meter reads the integrated loudness, and then gives the interpolator 64 frames of silence.
  So the peaks between the last samples count, as they do for a player that reaches the end.
- The meter forms its blocks of 400 ms from a step of 100 ms that it rounds to whole frames. At a
  rate that is not a multiple of 10 Hz, a block can differ from 400 ms by up to 2 frames. The
  change of the loudness is much less than 0.1 LU, so QuipClip keeps the blocks of the meter.

**Messages.** The channel carries JSON messages:

- A progress message, at most 4 times each second: the duration of the audio that the job read,
  and the duration of the export.
- One end message: the status `complete`, `canceled` or `failed`, an error code, the integrated
  loudness in LUFS and the true peak in dBTP as numbers, or `null` where the meter gives no value.
  A failure also gives the last lines of the error output of FFmpeg, untranslated (ADR 011).

A zero exit status of FFmpeg is not a complete measurement, as it is not a successful export
(ADR 016). The job ends `complete` only when FFmpeg exits 0 and the audio that it read lasts at
least `PlannedAudio::expected_duration` less 100 ms (`AUDIO_DURATION_SHORT_TOLERANCE_MS`). Each
audio chain is at least the length of its segment (`apad=whole_len`). With video it is exact, and
the stand-in video of ADR 043 can only add silence after it. A run that read all the audio is
therefore never shorter. When the audio is shorter, the job ends `failed` with `audioShort`.

**Control.** The job follows the envelope job of ADR 056:

- One measurement runs at a time in the application. Its slot is separate from the slot of the
  envelope and from the export queue (ADR 049). A start while a measurement runs fails with
  `busy`. The page cancels a measurement and waits for its end message before it starts the next
  one.
- A cancel sets the cancel flag of the job and kills its process.
- Each request carries a number. A page load of the main window sets the floor and cancels the
  job, as in ADR 056.
- When the main window is destroyed, Rust kills the job and refuses each later request. The exit
  handler of ADR 017 does the same, and it gives the job no part of its budget.
- Each child process starts without a console window (ADR 018).
- The job deletes its work directory at its end, as an export does (ADR 055). A kill at the exit
  can leave the directory. The sweep of the export kind deletes it after 24 h.

A measurement can run while an export runs. Both read the sources. On a network share, each read
then becomes slower.

**Error codes.** The codes are stable names (ADR 011):

- The start command: `invalidRequest`, `busy`, `superseded` and `closed`.
- The end message: each failure code of the export preparation (ADR 016, ADR 050) with the same
  meaning, and `spawnFailed`, `readFailed`, `decodeFailed`, `invalidAudio` and `audioShort`.
  `invalidAudio` means that Rust cannot read the WAV header.

### Out of scope

- Values for each segment.
- A check of the true peak of the output file after the export. Measurement 3 shows why that check
  is useful. A later record can add it.
- `loudnorm`, a limiter, and a loudness target. The constraints of ADR 054 for `loudnorm` stay in
  force.
- A positive gain that QuipClip puts in the field.
- A change of the project file or of the settings file (ADR 010, ADR 013).

## Rejected alternatives

- **A measurement on the timeline, from the cache of the envelope.** The envelope is 8 kHz mono in
  buckets of 10 ms (ADR 056). A true peak needs the full sample rate and oversampling. The
  K-weighting of BS.1770 needs the band above 4 kHz. A downmix to mono changes both values. The
  timeline also does not know the preset, so it does not know the sample rate and the channels of
  the output.
- **A measurement each time the step opens, with no switch.** Each export would read its sources
  once more, also when the user does not want the values.
- **The `ebur128` filter of FFmpeg.** It gives its result as a summary in the log text. Its true
  peak comes from a resample in the build that the user installed. The Rust meter gives the same
  result with each build and needs no parse of the log.
- **The first pass of `loudnorm`.** It writes JSON, but it resamples to 192 kHz in the filter, and
  it is the filter that ADR 054 deferred. Its result also depends on the build.
- **The gain in the copy of the preset in the request.** The request would then carry a preset
  that the settings file does not hold. A separate field states the choice of the user, and the
  preset stays as ADR 049 requires.
- **A filled gain that also raises quiet audio to -1 dBTP.** A gain of +7 dB for a quiet
  recording also raises its noise. The user chose a cut only.
- **A ceiling of -2 dBTP for low bitrates.** The user chose one ceiling.
- **A Fit button, and a list of the segments.** The user chose a filled gain and two lines.
- **A Volume row and a separate Gain field.** Both showed the same value. The user chose one row.

## Consequences

- With Adjust off, the switch changes nothing. The commands of an export stay the same, byte for
  byte, except for one change that is not about the gain: the audio process of ADR 043 now writes
  no metadata of the source (`-map_metadata -1`), because the meter and the encoder must read its
  WAV header (ADR 043, note of 2026-11-22).
- The preset editor shows "Gain" in place of "Volume".
- An export with Adjust on reads the audio of its sources twice: once to measure and once to
  export. For an FLV source, each read also reads the video bytes of the segments.
- The user cannot start an export with Adjust on until its measurement ends.
- After the encode, the true peak can still be above -1 dBTP, and in rare cases above 0
  (measurement 3). This record does not check the output.
- Rust gets a new dependency, `ebur128`, with four dependencies of its own.
- Two new commands, a new request field, the error codes `invalidAudioGain`, `invalidAudio` and
  `audioShort`, and new catalog text in English and Simplified Chinese.
- `build_plan` accepts a plan request with no destination.
- New tests: the formula of the filled gain, the rule of the store for Adjust and the copy, the
  check of the request, the plan with no destination, the WAV reader, and a test with real
  `ffmpeg` that measures a tone of a known level.
