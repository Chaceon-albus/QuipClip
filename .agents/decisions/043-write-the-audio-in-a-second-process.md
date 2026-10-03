# 043. Write the audio of an export with video in a second process

- Status: Accepted
- Date: 2026-10-03
- Deciders: capric98
- Amends: ADR 014, ADR 016, ADR 017, ADR 018, ADR 036

## Context

ADR 014 cuts the video and the audio of each segment in one filter graph of one `ffmpeg`. FFmpeg
configures a filter graph only when each input link of the graph has a first frame. Until then, it
keeps each decoded video frame of the inputs in memory (ADR 014 measurement 21). So an input whose
audio comes late, never, or only after a gap makes the export keep the decoded video of that time.

ADR 014 measurement 22 added a second input of the source for the audio of every segment, under
three conditions with a threshold of 0.5 s. That rule did not cover every case:

- A seek into a gap inside the audio stream. The probe does not report the gap.
- A probe that reports no length of the audio, or a wrong length.
- A wait shorter than 0.5 s. At 3840x2160, 60 fps and 10 bits, that is 750 MB of decoded video.
- The third graph shape. It drops the second input when the second input does not fit the Windows
  budget.

Also, `concat` holds in memory the silence that it adds to the end of a segment whose audio ends
early, when another segment follows. That took 900 MiB for 575 s of 48 kHz 5.1 audio. The end pad of
ADR 014 measurement 23 streams its silence, but the budget of one command had no room for it in
every chain.

## Measurements

These measurements used FFmpeg 9.0.2 on macOS, MP4 output with libx264 and AAC, and the commands that
the renderer builds.

1. Two processes give the output of one process. The audio process runs the audio chains of ADR 014
   and writes 32-bit float PCM in WAV to its stdout. The encoder runs the video chains, reads that
   stream as `pipe:0`, and maps it. Each graph has stand-ins for the other half, so that `concat`
   places each segment where one process places it:

   - In the audio process, a video of the planned frame count of each segment, at the output frame
     rate: `color=s=2x2:r=<rate>,trim=end_frame=<frames>`.
   - In the encoder, the silence of the planned length of each segment:
     `anullsrc=r=<sourceRate>:cl=mono,atrim=end_sample=<out - in>,aformat=f=fltp:r=<outputRate>`.

   These cases gave output identical to the output of one process:

   - a CFR source, in both shapes
   - a 24 fps preset and a 25 fps preset on a 30 fps source
   - a 44.1 kHz source written at 48 kHz, and at its own rate and layout
   - a VFR source
   - audio with a gap from 10 s to 100 s
   - audio 60 s late, in both shapes
   - 5.1 audio
   - one segment of 119 s

   In each case, the video frames with their timestamps, the decoded audio samples, and the audio
   packets with their timestamps were identical.

   In one case, the output changed. The audio of the source ends at 20 s. A segment from 30 s to
   600 s, with another segment behind it, holds no audio at all. One process padded that segment to
   the length of its video, 27358400 samples. The audio process pads it to its length in ticks,
   27358416 samples, because every chain now ends in the end pad. The ticks come from millisecond
   timestamps of the MKV source, so the two lengths differ by 16 samples, 0.33 ms. The PCM in front
   of the encoder was otherwise identical. The next segment was bit-identical after that shift. Both
   shapes gave the same result.

2. Peak memory, in MiB:

   | Case | One process | Audio process | Encoder |
   | --- | --- | --- | --- |
   | CFR source, three segments | 84 | 29 | 80 |
   | Audio 60 s late, three segments | 1005 | 38 | 82 |
   | The same, one input | 747 | 35 | 182 |
   | Audio gap from 10 s to 100 s | 263 | 29 | 81 |
   | Audio ends at 20 s, [30, 600) then [0, 5) | 3127 | 29 | 80 |
   | The same, one input | 577 | 32 | 130 |
   | One segment of 119 s | 66 | 26 | 68 |

   In the one-input case with audio 60 s late, the segments are out of source order, and `split`
   holds video for the later segments, as ADR 014 records.

3. A first form sent the stand-in video of the audio process to `nullsink` in the graph. That let
   FFmpeg request frames of the stand-in at any time. When the stand-in of a segment ended, `concat`
   answered each request with the audio of the segment. `apad` writes silence without input. So one
   pass of the graph put 570 s of silence in the queue of the audio output, and the process took
   344 MiB. With the stand-in mapped to an output of the `null` muxer, FFmpeg requests its frames in
   step with the audio. The process then took 28 MiB, and the output did not change.

   The stand-in silence of the encoder has no such effect. On a VFR source with a static gap of
   70 s, `anullsink` and a `null` output both peaked at 383 MiB, as one process did. The outputs
   were identical. That cost is the frames that `fps` repeats over the gap, and it is older than
   this record.

4. The pipe keeps the length and most layouts. WAV kept a `5.1(side)` layout, and NUT and
   Matroska reported `unknown` on the other side. A stereo or mono stream arrives as 2 or 1
   channels of no layout, and the encoder writes them as stereo and mono again. The audio stream
   headers of the old and the new MP4 were identical for stereo and for 5.1. A layout that the WAV
   channel mask cannot name, such as `downmix`, `7.2.3` or `22.2`, arrives without its names. A WAV
   stream on a pipe has no length in its header, and the reader reads it to the end. A stream of
   4608000000 bytes, 25 min of 7.1 audio at 96 kHz, arrived whole.

5. Audio that overlaps itself needs a cut. A source joined with `-c copy` overlaps its audio by
   about 21 ms at each join. The gap fill of ADR 014 keeps an overlap of 0.1 s or less. The end pad
   never removes a sample. So a chain over a join is longer than its ticks. The stand-in silence of
   the encoder has exactly the ticks, so the audio of each later segment would play behind its
   video, by the sum of the overlaps. The audio process therefore cuts each chain to its length
   after the end pad: `apad=whole_len=<out - in>,atrim=end_sample=<out - in>,asetpts=N`.

   The source had two joins, and the segments were [25, 35), [55, 65) and [0, 5). The audio process
   wrote 1200000 samples, exactly 25 s. The third segment started at 20.000 s in the video and in
   the audio. One process wrote 1202048 samples and moved the video of the third segment to
   20.033 s, about 9 ms away from its audio. The cut changed no output of measurement 1.

6. Each command line is shorter than the one command. At the segment cap, on the longest Windows
   path, with every setting at its widest, the encoder needs 24735 bytes and the audio process
   29477 bytes of the 31743 that Windows allows. Up to 130 and 107 segments fit. One process
   needed 31547 bytes.

## Decision

An export with video and with audio that its chains read from the source stream runs two `ffmpeg`
processes. `ExportPlan::separate_audio_process` states the rule. These exports stay one process,
because none of them waits for an audio input while it decodes video:

- an export without video
- an export without audio
- an export whose audio stream holds no packets (ADR 014 measurement 26)

### The audio process

The audio process opens the inputs of the source as the encoder does, with the same seeks. Its graph
holds, for each segment, the stand-in video and the audio chain of ADR 014. Every audio chain ends in
the end pad of ADR 014 measurement 23 and a cut to the same length (measurement 5), so `concat` pads
only the rounding of a frame. The command is:

```
ffmpeg -nostdin -hide_banner -loglevel error -nostats -copyts \
  [-ss <seek>] -i <source>             (once for each segment, or once) \
  -filter_complex "<audio graph>" \
  -map "[a]" -c:a pcm_f32le -f wav pipe:1 \
  -map "[pv]" -c:v rawvideo -f null -
```

It has no `-progress`, because its stdout carries the audio, and no `-y`, because it writes no file.
The `null` muxer opens no file. The stand-in video must go to that output and not to `nullsink`
(measurement 3).

### The encoder

The encoder runs the command of ADR 014 with three changes:

- Its graph holds the stand-in silence where ADR 014 holds the audio chain, and `[pa]anullsink`.
- The pipe follows the inputs of the source: `-f wav -i pipe:0`.
- It maps the audio of the pipe directly: `-map <n>:a`, where `<n>` is the number of inputs of the
  source. The audio encoder settings of the preset apply to that stream as before.

The encoder reads `pipe:0` to its end. No command may carry `-shortest` or an output `-t`.

### The processes

The process layer starts the audio process first. Its stdout becomes the stdin of the encoder. A
cancel kills both. A failure of either kills the other at once. The export succeeds only when both
exit successfully. The frame count check of ADR 016 reads the progress of the encoder. When both
processes fail, the diagnostic holds the tail of the stderr of each. On Windows, the standard library
copies the pipe through a thread of the application. That thread ends when either process dies.

Each process chooses its graph shape against the command-line budget on its own. Nothing in either
graph depends on the shape of the other.

### What this replaces

This record removes the second input of ADR 014 measurement 22, its three conditions, the threshold
of 0.5 s, and the third graph shape. The bound of 60 s on the silence in front of the first audio
sample stays for the fill of ADR 014 measurement 20. It now counts only the segments that reach the
first sample, in every export, because every chain that reads the stream ends in the end pad.

## Consequences

- An export with video and audio starts two processes and reads the source twice. The audio process
  decodes no video, so it adds little CPU, but the reads of the file double. On a slow share, the
  export can take longer.
- No late start, early end, gap, or empty audio stream makes the encoder keep decoded video. The
  fill in front of a late start, and in a gap inside the stream, still holds its silence in memory
  in the audio process (ADR 014 measurement 20).
  (Changed on 2026-10-03: a prefix streams the silence in front of a late start, ADR 014
  measurement 27. The plan bounds the silence of the gaps, measurement 28.)
- A segment that the audio does not cover to its Out point gets audio of its length in ticks, as a
  covered segment does. When another segment follows it, the timeline of the following segments
  moves by the difference between that length and the length of the video, a fraction of a
  millisecond in the measured case (measurement 1).
- A segment whose audio overlaps itself loses the samples past its length, at its end, where one
  process moved the video of the next segment instead (measurement 5). The audio of every segment
  starts with its video.
- A layout that the WAV channel mask cannot name reaches the encoder without its names, when the
  preset keeps the channels of the source (measurement 4).
- The stand-in video needs the frame count of the plan to be the count that `fps` gives each
  segment. One process padded the audio to the real video of a segment. The frame count check of
  ADR 016 compares only the sum of the counts, and it reports only a smaller sum. If `fps` gives a
  segment more frames than the plan, the audio of each later segment starts earlier than its
  video, and nothing reports it. No measured case showed a difference.
- The cap of 100 segments stays. At the widest, the audio process limits the reach, to 107
  segments.
- ADR 016: the process layer supervises two processes as one export.
- ADR 017: an exit cancels the export, and the process layer kills both processes.
- ADR 018: both processes start without a console window.
- ADR 036: an audio-only export is one process, as before.
- These results come from the behaviour of FFmpeg 9.0.2 that its documentation does not state: the
  request of frames through `nullsink`, the pacing of a `null` output, and the length of WAV on a
  pipe. Measurements 1 to 5 must run again for each new release of FFmpeg that QuipClip supports.
