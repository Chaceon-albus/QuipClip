# 036. Choose the output streams of an export: video and audio, video only, or audio only

- Status: Accepted
- Date: 2026-10-02
- Deciders: capric98
- Amends: ADR 014, ADR 016, ADR 023, ADR 024, ADR 025
- Amended by: ADR 043

## Context

Every export wrote a video stream, and it wrote an audio stream whenever the source had one.
The user asked for an export of the video only and an export of the audio only. The user chose
to make this a choice of the export dialog, not a field of the preset: the video and the audio
are both on by default, the user can turn one of them off, and the user can never turn both
off. This record states the backend and the wire contract, and the control in the export dialog.

The export plan already had optional parts after a refactor: `video: Option<PlannedVideo>` and
`audio: Option<PlannedAudio>`. The graph and the arguments already rendered a plan without
audio, and a plan without video rendered no video chain, no format chain and no video flags.

Two rules of the pipeline do not work without video. ADR 016 decides success by the frame
count, and an audio-only output has no frames. ADR 014 measurement 12 shows that `out_time_us`
is not correct under `-copyts`, so the progress cannot measure time either.

## Decision

### The wire contract

`ExportRequestWire` holds a required field `streams`: `videoAndAudio`, `videoOnly` or
`audioOnly`. It has no default, and an unknown value is refused, as for every field of the
request. `ExportStart` echoes the value. The TypeScript types hold the same three values, and a
test compares them with the Rust names.

### The plan

- `videoAndAudio` builds the plan of every earlier export. The command line does not change.
- `videoOnly` builds no audio part. A source without audio is accepted, and so is a source whose
  audio stream reports no sample rate.
- `audioOnly` builds no video part. The check of the frame rate does not apply. A source without
  an audio stream is refused with `sourceHasNoAudio` before any process starts. That check is
  step 13 of the preflight, after the frame rate and before the sample rate of the audio,
  because a missing stream has no rate to ask about.
- (Added on 2026-10-02.) `videoAndAudio` and `audioOnly` refuse segments that need more than
  60 s of silence in total before the first sample of the audio, with `audioGapTooLong` (ADR 014
  measurement 21). `audioOnly` counts only the segments that reach the first sample. `videoOnly`
  reads no audio, so the video of such segments still exports.
  (Changed on 2026-10-03: the segments count only the silence that the fills hold in memory, ADR
  014 measurement 27. A silence prefix streams the rest.)
  (Changed on 2026-10-03: the longest gap inside the stream of each segment counts too, when it is
  longer than the silence in front of the first sample, ADR 014 measurement 28.)
- (Added on 2026-10-02.) `audioOnly` refuses a source whose audio stream holds no packets with
  `sourceHasNoAudio` (ADR 014 measurement 26), because it would write only silence. Before this
  change, the plan refused a stream without packets and without a sample rate, as in MPEG-TS,
  with `sourceAudioRateUnknown`. `videoAndAudio` writes silence for a stream without packets when
  the stream has a sample rate.
- (Added on 2026-10-03.) `videoAndAudio` with audio that its chains read from the stream runs two
  processes (ADR 043). `videoOnly` and `audioOnly` stay one process.

### The command

- Video only: no audio chain, `concat` with `a=0`, and no `-map [a]`, `-c:a` or `-b:a`.
- Audio only: no video chain, no format chain, `concat` with `v=0:a=1`, and only `-map [a]`. The
  muxer is `mp4`, with `+faststart`, for a preset whose container is MP4 or MOV, and the file is
  an `.m4a` file. The muxer is `matroska` for an MKV preset, and the file is an `.mka` file.
  - `ipod`, the muxer that FFmpeg selects for a `.m4a` name, refuses FLAC. `mp4` accepts it.
  - `mov` is not used for audio only. The editor already refuses MOV with FLAC or Opus (ADR
    023). A custom PCM encoder from a MOV preset can need a newer FFmpeg in `mp4`.
  - The frontend names the destination. The backend does not change the extension.

### Progress and success of an audio-only export

An audio-only progress block has no `frame` key. The start payload therefore holds no
`expectedFrames`, the run sends no progress event, and the interface shows an indeterminate
progress for the whole encode (ADR 025).

The success check reads the output file. After FFmpeg exits with status 0:

1. A run that wrote no progress block fails with `outputStreamsMismatch`. FFprobe does not run.
2. FFprobe reads the temporary file, with the probe timeout and the rules for child processes.
   It must find exactly one audio stream and no video stream, or the run fails with
   `outputStreamsMismatch`.
3. The duration of the file must lie within −0.10 s and +0.50 s of the expected duration, or the
   run fails with `audioDurationMismatch`. The error carries the measured and the expected
   duration in whole microseconds.

The expected duration is the sum of the overlap of each segment with the audio stream of the
source. (Changed on 2026-10-02: since ADR 014 measurement 20 fills a late start with silence,
a segment that the audio reaches counts from its In point to the earlier of its Out point and
the end of the audio. A segment wholly before the first sample, or wholly after the last one,
still writes nothing and counts nothing. In 160 runs, late starts measured 0 to +0.023 s and
early ends −0.014 to +0.023 s against this rule.) The probe reads the start and the duration of
that stream. A side of the stream that the
probe does not know limits nothing, and an overflow of the sum gives the planned duration. Without
this rule a correct export failed whenever the audio of the source started late or ended early,
as many phone and screen recordings do. Only an audio-only plan computes this value. An
audio-only export whose segments the audio stream does not reach at all is refused in the plan
with `sourceHasNoAudio`, because it would write an empty file that a check against 0 s passes.

(Changed on 2026-10-02.) The expected duration is now the planned duration. ADR 014 measurement
23 adds `apad` to every audio chain of an export without video. So each segment writes its full
length. A segment that the audio does not reach becomes silence, and so does the part of a
segment after the last sample. The plan therefore reads no extent of the audio for this value.
The plan no longer refuses an export whose segments the audio does not reach. That export now
writes silence for the whole duration, as the export with video does. Only a source without an
audio stream gives `sourceHasNoAudio`. The measurement used sources whose audio starts late, ends
early or has a gap. In 592 runs, the duration of the file minus the planned duration was
−0.0007 s to +0.0233 s.

In a Matroska file the probe reads the end of the track from its `DURATION` tag, as the
Matroska muxer of FFmpeg writes it. A file from another muxer that writes the length of the
track in that tag gives an end that is too early by the start of the audio. For audio that
starts late by more than 0.5 s, a correct export of such a file can then fail. (Changed on
2026-10-02: the check no longer reads the end of the track, so it cannot fail for this reason.)

(Added on 2026-10-02.) The probe misses an audio start that is more than about 5 s late in MKV,
MPEG-TS and MPEG-PS. It then reports the start and the length of the container. The export
therefore reads the first packet of the audio stream and moves the start to it (ADR 014
measurement 24). The expected duration above does not read the start or the end of the audio, so
this correction does not change the check of this record.

A failed FFprobe of the output is a wrong output, not a fault of the source. An exit failure or a
parse failure gives `outputStreamsMismatch` with the stderr of FFmpeg as its detail. A probe that
cannot start or that times out keeps its own code.

The check runs before the second cancel check and before `publishing`. A failed check publishes
nothing, and the guard of the reservation deletes the temporary file. The output probe reads the
cancel flag of the run every 25 ms. A cancel kills and reaps FFprobe, and the run ends as
canceled, inside the exit budget of ADR 017.

### Measurement

FFmpeg and FFprobe 9.0.2 on macOS, with the exact command that the code builds, in 1044 runs.
The sources were 30 fps H.264 with AAC at 44.1 kHz and 48 kHz. The encoders were `aac`, `aac_at`,
`libopus`, `libmp3lame`, `flac` and `alac`. The outputs were `.m4a` and `.mka`, with 1, 3 and 100
segments, both graph shapes, output rates from 8 kHz to 192 kHz, stereo and mono.

- No audio-only progress block had a `frame` key.
- The duration of the output minus the planned duration:

  | Output | At the source rate | Over the whole rate range |
  | --- | --- | --- |
  | `.m4a`, every encoder | 0 to +0.017 s | −0.000125 to +0.095 s |
  | `.mka`, FLAC and ALAC | 0 | 0 to +0.004 s |
  | `.mka`, Opus | +0.008 s | +0.007 to +0.011 s |
  | `.mka`, AAC | +0.021 to +0.023 s | +0.011 to +0.132 s |
  | `.mka`, MP3 | +0.023 to +0.025 s | +0.023 to +0.142 s |
  | `.mka`, `aac_at` | +0.048 to +0.061 s | +0.048 to +0.324 s |

  The overhang of `.mka` is the priming of the encoder plus a padded last frame. The worst case
  was `aac_at` into `.mka` at 8 kHz. The tolerance of +0.50 s covers it with a margin.
- The check found a truncated output: 2 of 3 segments gave 7.667 s against 9.700 s. A killed
  `.mka` reports no duration and fails. A killed `.m4a` and an empty file make FFprobe fail.
- In 48 more runs, sources whose audio starts 0.3 s late or ends 1 s early failed by −0.258 s to
  −1.600 s against the planned duration, and passed within ±0.021 s against the expected
  duration. A truncated output of the same sources still failed.
- In 24 pairs, the audio-only output decoded to the same samples as the audio of a video and
  audio export of the same plan. The audio-only cut uses the same `atrim` ticks. An export with
  video can pad a segment other than the last with silence in `concat` when its video is longer.

### The control in the export dialog

(Added on 2026-10-02.) The preset summary of the setup step (ADR 024) shows a small switch at the
end of the Video heading and of the Audio heading. Both are on by default. A group whose switch is
off shows one line, "Not exported", in place of its rows. The last switch that is on cannot be
turned off: it is `aria-disabled`, and its tooltip says that the export writes at least the video
or the audio. With a source that has no audio, the audio switch is off and locked, the video
switch is locked with a tooltip that names the missing audio, and the request asks for the video
only. The switches do not change while the save panel is open, because the request already holds
the choice. The choice lasts for the session, and it goes back to both streams when the open media
changes. Nothing stores it.

The container row, the size estimate, the blockers and the marks of the encoders follow the
choice. The MOV preset with FLAC or Opus is blocked only when the export writes both streams,
because an audio-only export of a MOV preset uses the `mp4` muxer. The save panel proposes the
extension of the output, `.m4a` or `.mka` for the audio only, and the filter names Audio Files or
Video Files. A name that the user types with another extension is kept, as for an export with
video; the muxer is set explicitly, so the file is still valid.

## Consequences

- (Added on 2026-10-02.) An audio-only export and an export with video differ for a segment
  that lies wholly before the first audio sample: the export with video fills it with silence,
  and the audio-only export writes nothing for it, so its later segments come earlier in the
  file. Near an Out point, an error in the probed start of the audio can therefore move the
  expected duration by the whole segment and fail a correct export. A segment wholly inside a
  gap of the stream counts in full and writes nothing, which also fails the check. (Changed on
  2026-10-02: ADR 014 measurement 23 removes the difference. Both exports write silence for such
  a segment, and the check expects the planned duration, so neither failure can occur.)
- (Added on 2026-10-02.) An audio-only export can now write a file that holds only silence,
  when the audio of the source reaches none of its segments. The plan does not refuse it, as it
  does not refuse the same segments with video.

- An audio-only export has no progress percentage, no speed and no time estimate.
- A loss of audio shorter than 0.10 s plus the overhang of the output passes the check: about
  0.10 s in `.m4a`, and up to about 0.42 s for `aac_at` in `.mka` at 8 kHz.
- `libmp3lame` in `.m4a` fails at 8 kHz and 11.025 kHz, and `aac_at` fails at 96 kHz and 192 kHz.
  FFmpeg exits with an error, and the run reports `ffmpegProcessFailed`.
- The measurement found a fault that existed before this record and that this record does not
  correct. (Changed on 2026-10-02: ADR 014 measurement 20 corrects it.) In a video and audio export of a source whose audio starts late, `asetpts=PTS-STARTPTS`
  removes the gap before the first audio sample, and `concat` pads silence at the end of the
  segment instead. The audio of that segment then plays about as early as the gap, 0.3 s in the
  measurement. A later unit must correct it.
