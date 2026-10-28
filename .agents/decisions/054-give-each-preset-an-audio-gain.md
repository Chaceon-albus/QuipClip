# 054. Give each preset an audio gain

- Status: Accepted
- Date: 2026-10-28
- Deciders: capric98
- Amends: ADR 013, ADR 014, ADR 023, ADR 040, ADR 041
- Amended by: ADR 055

## Context

Many sources have a limiter that holds the peaks at 0 dBFS. A lossy encoder changes the
waveform. After the decoder reconstructs the signal, the true peak can be above full scale, and
the player then clips it. A small negative gain before the encoder, such as -1 dB, leaves
headroom for this.

The export decodes the audio of each piece, cuts it, and encodes it with the preset (ADR 014,
ADR 043). The only exception is the copy of ADR 048. No setting changes the level. The extra
parameters of a preset cannot add a filter, because `af`, `filter` and `filter_complex` are on
the deny list (ADR 040).

The user asked to set a gain before the export starts. The user chose a field of the preset,
shown read-only in the setup step of the export dialog.

The user also asked about a two-pass `loudnorm` for interviews: analyse the loudness first,
then let the user set targets. The user agreed to defer it. This record states the constraints
that a later record must meet.

## Measurements

These measurements used FFmpeg 9.0.2 (Homebrew) on macOS.

1. **Level and sign.** By hand: a 2 s tone of 1 kHz at 48000 Hz went through
   `volume=<g>,aformat=f=fltp` and then `astats`.
   - `volume=-1.0dB` lowered the peak level and the RMS level by 1.000 dB each.
   - `volume=-20.0dB` lowered them by 20.000 dB.
   - `volume=0.5dB` raised them by 0.500 dB.
   - A constant input of 0.5 gave 0.445625 with `volume=-1.0dB`, which is 0.5 × 10^(-1/20). The
     minus sign does not invert the samples.
2. **Export.** The test `a_real_export_lowers_the_audio_by_the_gain_of_the_preset` runs real
   `ffmpeg`. It exports 1.5 s of an FLV source with a 440 Hz tone. It
   writes FLAC in Matroska twice: with a gain of 0 and with -1.0 dB. It does this for an export
   with video (two processes, ADR 043) and for an export without video (one process). In each
   case, the RMS level and the peak level fall by 1.0 dB, within 0.05 dB. The number of samples
   does not change.
3. **Command line.** The gain chain costs at most 23 bytes, once for each command. The test of
   the widest plan carries a gain of -200. These are the lengths for the plans of ADR 014:

   | Command | Plan | Before | With the gain |
   | --- | --- | --- | --- |
   | Encoder | 1 source, 91 pieces, FLV input, silence | 31,618 | 31,618 |
   | Audio process (ADR 043) | 44 sources, 48 pieces in turn, FLV input | 30,468 | 30,491 |
   | Without video | 1 source, 91 pieces, one input | 22,203 | 22,226 |

   The first two rows are the worst plans of ADR 014. The third row is the plan of the test of an
   export without video at the limit of one source.

   The worst plan of the encoder does not grow, because a plan of silence gets no gain. The
   longest encoder command that production chooses grows from 31,736 to 31,741 bytes. It is now
   an export without video of 36 sources, whose FLV source has 6 of 56 pieces. The longest audio
   process that production chooses grows from 31,733 to 31,736 bytes: 32 sources, whose FLV
   source has 17 of 48 pieces. Both fit in 31,743.

   (Changed on 2026-10-28.) ADR 055 moves the graph into a file. The gain chain then costs no
   bytes of the command line.

The sign depends on the expression parser of FFmpeg. It must read `-1.0dB` as 10^(-1/20), and
not as the negative of 10^(1/20), which would raise the level and invert the samples. Measurement
1 checks this. It must run again for each new release of FFmpeg, as ADR 014 requires for its
measurements 20 and 23. Measurement 2 also fails on that error, because the level would rise, so
each run of the tests with real `ffmpeg` checks the sign again.

## Decision

### The field

A preset has the field `audioGainTenthsDb`: the gain in tenths of a decibel, a whole number from
-200 to 200 (-20.0 dB to +20.0 dB). The value -10 is -1.0 dB.

- The field is an integer, so that the stored value and the filter text are exact (ADR 002).
- 0 means no change. An absent key reads as 0. A save always writes the key.
- The seeds have 0, so they export as before.
- Rust and the interface check the same bounds. Rust refuses a value out of range with the
  field path `presets[i].audioGainTenthsDb`.

### Schema version 3

v0.1.1 writes schema version 2, and its `Preset` refuses an unknown key. So
`CURRENT_SCHEMA_VERSION` is 3 (ADR 040 states the rule).

- A load of a version 1 or version 2 file gives the gain 0 and writes nothing. The next save
  writes version 3 at the next revision.
- The permissive reader of the FFmpeg path reads all three versions.
- v0.1.1 and v0.1.0 read a version 3 file as a later version, and they do not write over it
  (ADR 013).

### The filter

The graph applies the gain as one chain behind `concat`. `concat` writes `[ac]`. The chain
`[ac]volume=-1.0dB[a]` then writes the `[a]` that the argument builder maps. The filter text comes
from the integer: a sign, the whole decibels, a point, and the tenth.

- The chain is in the graph of the audio process of an export with video (ADR 043), and in the
  graph of an export without video.
- The graph of the encoder of ADR 043 gets no gain. Its audio is a stand-in that goes to
  `anullsink`.
- A plan in which no piece reads an audio stream gets no gain. Silence has no level to change.
- A gain of 0 adds no chain. The command stays the same, byte for byte.
- The gain is one chain and not a filter in each audio chain, for the reason of the pixel format
  of ADR 014: a filter in each chain costs its bytes once for each piece.
- Every chain ends in the one `aformat` of ADR 023 and ADR 053. So `volume` receives one rate and
  one layout in planar float, and the gain cannot clip inside the graph. A positive gain can
  still clip where ffmpeg converts the float samples for an encoder that takes integer samples,
  such as `flac`, or in the player. The editor warns about this.

### Copy of the audio

An export that copies the audio (ADR 048) applies no gain. It applies none of the other audio
settings of the preset either (ADR 023). The setup step shows no gain row for a copy.

### The preset test

The test of a preset (ADR 041) adds the same `volume` filter behind its `aformat` when the gain is
not 0: `[1:a]<aformat>,volume=-1.0dB[a]`. So a test also runs the filter of the export. A preset
with a gain of 0 renders the same command as before, and its stored result still matches. The
fingerprint of the interface includes the gain.

### The interface

- The preset editor shows the gain in decibels in the Audio group, after the channels, with a
  step of 0.1 and the unit dB.
- A positive value shows a warning about clipping.
- A blank value, or a value with more than one decimal place, cannot be saved.
- The setup step of the export dialog shows a Volume row in the Audio group: "No Change" for 0,
  otherwise the gain with its sign and one decimal place, such as "-1.0 dB".

### Two-pass loudnorm: later

This record does not add `loudnorm`. A later record that adds it must meet these constraints:

- The analysis must measure the audio that the export writes. That audio is the pieces after
  `concat` and after the final `aformat`, not the whole source file.
- The analysis decodes all the audio of the pieces. It belongs in the run stage, not in the
  preparation. The preparation has a time limit of 30 s for each child process, and one limit
  for the whole preparation of 180 s multiplied by the number of sources (ADR 050).
- The export must control the analysis process as it controls its other processes: cancel,
  exit, and the constructor without a console (ADR 016, ADR 017, ADR 018).
- The FFmpeg documentation says that `loudnorm` resamples to 192 kHz inside the filter. After
  it, the graph must convert the audio to the output rate of the plan again.
- The FFmpeg documentation also says that linear mode changes to dynamic mode when the target
  needs more gain than the true peak target allows. The interface should show this before the
  export.
- The measured values must travel in the request, as a new field, so that a queued run uses what
  the user saw (ADR 049).
- An export with `loudnorm` must not also apply the gain of this record.
- The command-line budget of ADR 014 must be measured again with the longest `loudnorm` chain.

## Consequences

- A preset can lower or raise the exported audio by up to 20 dB, in steps of 0.1 dB.
- A user who installs v0.1.1 or v0.1.0 again after a save cannot read the settings file. The
  old release reports a later version and keeps the file.
- The tests of the graph, the plan, the preset test and the preparation have new cases with a
  gain. A test with real `ffmpeg` checks the level and the length of the output.
- The margin of the audio process of ADR 014 falls by 23 bytes. The margin of the encoder in
  its worst plan stays at 125 bytes.
