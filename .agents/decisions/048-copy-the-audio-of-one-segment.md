# 048. Copy the source audio of an export of one segment

- Status: Accepted
- Date: 2026-10-23
- Deciders: capric98
- Amends: ADR 014, ADR 016, ADR 023, ADR 024, ADR 036, ADR 043, ADR 046
- Amended by: ADR 052, ADR 053, ADR 055

## Context

Every export decodes the source audio, cuts it with `atrim`, and encodes it with the preset
(ADR 014, ADR 043). The encode loses quality, and it costs time. The user asked for an option
that copies the audio stream of the source into the output. The user set these conditions:

- The option is for an export of one segment only.
- Each end of the copied audio can lie up to one packet from its In point or its Out point,
  earlier or later. The interface shows no note about this error.
- When a copy is not possible, the export writes the audio as before.

A copy keeps whole packets. AAC at 48000 Hz has packets of 1024 samples, 21.3 ms. So a copy
cannot cut at the sample, as `atrim` does.

The command of ADR 014 sets `-copyts` once, for every input. The video chain resets its
timestamps to zero with `setpts=PTS-STARTPTS`. Copied packets keep the timestamps of the
source. An output `-t` under `-copyts` writes no frames (ADR 046 measurement 6).

## Measurements

These measurements used FFmpeg 9.0.2 (the full build of gyan.dev) on Windows 10.

The fixtures were 120 s of 640x360 H.264 at 30 fps. Every 2 s, one frame was white and the
audio held a burst of 1 kHz for 10 ms, at the same time. The audio was AAC at 48000, 44100
and 32000 Hz, stereo and 5.1, MP3, AC-3 in stereo and 5.1(side), E-AC-3, and Opus. The
containers were MP4, MOV, MKV, MPEG-TS and FLV. Other fixtures had audio that started 30 ms
or 300 ms late, audio that ended at 100 s, and a gap of 0.5 s at 50 s. The segments were
[0, 5), [30, 35), one frame inside a GOP, [40, 100) and [115, 120).

The commands were the commands of the decision below. A pipe of the test harness joined the
two processes. The encoder used `libx264 -preset ultrafast`.

1. Every run, except the E-AC-3 runs of measurement 7, exited with 0 in each of its processes.
   No run wrote to stderr at `-loglevel error`, with one exception. The H.264 decoder of the
   encoder wrote `mmco: unref short failure` for the MPEG-TS source. That message belongs to
   the video path.
2. The audio packets of each output were a run of packets of the source, with no packet
   missing in the run. An MD5 of each packet was equal to the MD5 of its source packet. This
   held for AAC from all five containers, MP3, AC-3, Opus, and E-AC-3 into Matroska. The
   conversion from ADTS removes 7 bytes from each AAC packet of MPEG-TS, and only those bytes
   changed.
3. Under `-copyts`, an output `-ss` with `-to` cut the copy. The first packet of the output was
   the first packet of the source whose decoding time was at or after the In point. The last
   packet was the last one whose decoding time was before the Out point. The first packet
   started 0 to 16 ms after the In point for AAC, 1 ms for MP3, 11 ms for AC-3 and 14 ms for
   Opus. The last packet ended 0 to 17 ms after the Out point. Opus in the `mp4` muxer ended
   6 ms before it.
4. The output kept the place of the audio against the video. Each burst of the output, moved
   by the In point, started where it started in the source. The difference was 0.000 ms for
   sources from MP4, MOV and MPEG-TS. It was 0.17 to 0.48 ms for sources from Matroska and FLV,
   whose timestamps are whole milliseconds. Opus into Matroska moved 1.0 ms. Each flash frame
   lay where it lay in the source. The video of each output was equal, by `framemd5`, to an
   export of the same graph without audio.
5. At an In point of zero, the output `-ss 0` dropped the first AAC packet, whose timestamp is
   negative. The copy then started at the timestamp 0.
6. An `.m4a` started its audio stream at the first packet, less the priming of AAC, and counted
   its duration from that start. The sum of the two was 0 to 17 ms longer than the segment. An
   `.mka` counted its duration from zero, and its audio stream started at 0 to 21 ms. Its
   duration was 8 to 31 ms longer than the segment.
7. NUT gave E-AC-3 the codec of AC-3 on the other side of the pipe. The `mp4` muxer then
   refused the stream ("RealAudio AC-3/DolbyNet with bsid 16 ...") and failed at its trailer.
   The `mov` muxer wrote it with the same message. A Matroska pipe kept E-AC-3, but it rounded
   the timestamps to milliseconds.
8. Audio that started 300 ms late kept its place in the output. The audio of the output then
   started 279 ms after the In point. The duration of the `.m4a` alone was 264 ms short. The
   start plus the duration was 14.7 ms longer than the segment.
9. Audio that ended at 100 s, in the segment [95, 105), stopped at 100 s in the output. The
   start plus the duration of the `.m4a` was 5.000 s short.
10. The gap of 0.5 s stayed in the output. MP4 stored it as one packet of 533 ms.
11. The layouts stereo, 5.1 and 5.1(side) arrived unchanged in MP4, MOV and MKV.
12. The pair of processes took 0.1 s for 5 s and 0.28 s for 60 s of this video. Almost all of
    that time was the encode of the video. The copy process decodes nothing.
13. A first form of the decision took the extent of the audio from the probe. It joined the
    frames of the read across 0.1 s. It allowed 50 ms at each end. A review found two faults
    with it.
    - An MKV with no audio packets from 8 s to 20 s gave no frame in [10, 15). The probe and the
      `DURATION` tag reported audio up to 30 s. The copy wrote a NUT of only a header. The
      encoder failed with "EOF before video frames", and an `.m4a` held no stream.
    - An MPEG-TS with a hole of 85 ms right after the packet that holds the In point gave an
      `.m4a` of 4.842667 s for a segment of 4.966667 s. The check of ADR 036 needs 4.866667 s.
    A second review found a third fault. A segment of one frame at 60 fps can hold no AAC packet
    start, and the copy then also wrote no packet.
14. The decision below was tested on 28 cases. The test harness read the frames as the export
    reads them and applied the rules. 21 cases copied. Each `.m4a` passed the check of the
    decision below. Its end lay 0.7 to 19 ms after the Out point. Each pair exited with 0 and
    held one video and one audio stream. These 7 cases encoded:
    - the late start of 300 ms (a late start)
    - the early end at 100 s (an early end)
    - the gap of 0.5 s (a gap)
    - the MKV hole (no frame)
    - the MPEG-TS hole of 85 ms (a gap)
    - one dropped AAC packet (a gap)
    - a segment of one frame from MPEG-TS (too short)

    The first frame of the read lay from 471 packets before the In point to 1.05 packets after
    it. The value 1.05 is Opus in Matroska at an In point of zero: 21 ms against frames of
    20 ms.

## Decision

(Changed on 2026-10-28.) The copy process runs in the work directory of ADR 055. Its command
carries no graph. So an export that only copies the audio does not run the option probe.

(Changed on 2026-10-28.) The condition "an export of one segment" now reads "an export of one
piece" (ADR 053). A segment that crosses a junction has two or more pieces, so its audio is
encoded.

(Changed on 2026-10-28.) On a sequence of several clips, the table "What replaces the active
source" in ADR 052 gives the replacement for each rule here that names the active source.

### The switch

The setup step (ADR 024) shows a switch with the label "Copy audio" at the end of the Encoder
row of the Audio group, under the switch of the Audio heading. The switch is off by default. It
lasts for the session, as the stream switches of ADR 036 do. Nothing stores it, and the step
sets it to off when the open media changes. While the save panel is open, it does not change.

(Changed on 2026-10-23.) The switch first showed in front of the switch of the Audio heading.
The user asked for the two switches one above the other, and for no new row. The switch is now
in the Encoder row, which is the first row of the Audio group with and without the copy.

The step shows the switch only where the facts of the import probe allow a copy
(`canCopyAudio` in `src/features/export/audioCopy.ts`):

- The active source has one segment, and the export writes audio.
- A format name of the probe is `mov`, `matroska`, `mpegts` or `flv`.
- The sample rate is known and is 32000 Hz or more.
- The muxer of the output takes the codec (`COPYABLE_AUDIO`). AAC, MP3 and AC-3 go into
  `mp4`, `mov` and `matroska`. Opus goes into `matroska` only. An audio-only export of a MOV
  preset writes through `mp4` (ADR 036).

`src-tauri/src/ffmpeg/export/copy.rs` holds the same lists, and a test compares them.

While the copy is on, the Audio group of the summary names the codec of the source in place
of the encoder ("Copied from Source (aac)"), and the sample rate and the channels of the
source. It shows no bitrate and no extra parameters. The step shows no size estimate, because
the probe does not report the bitrate of the source.

The blocker of ADR 023 and the mark of the audio encoder do not change. The plan can refuse the
copy for a fact that only the export reads, and it then encodes the audio with the preset. A
MOV preset with FLAC must therefore stay blocked, or that export fails after the save panel.

### The request

The request carries `audioMode`, `encode` or `copy`. The field is required and has no default,
as `streams` is. `ExportStart` does not echo it, because the value is a request. (Changed on
2026-10-27: `start_export` answers with the run identifier only.) The plan decides the mode that
the run uses.

### The decision of the plan

`build_plan` asks `copy::decide` when the request asks for a copy. A refusal is not an error.
The plan then writes the audio as for `encode`, and the reason goes to the log. The checks run
in this order:

1. The export writes audio, and has one segment.
2. The source has an audio stream that holds packets.
3. The source format, the sample rate and the codec follow the lists of the switch.
4. The In point and the Out point are times. The In point is not before zero, and it is
   before the Out point.
5. The read of the frames inside the segment (`probe_audio_gaps`) found frames. A read that
   failed also gives no copy. The probe alone is not enough, because it can report audio over a
   segment that holds none (measurement 13).
6. The segment lasts three of the longest frames of the read (not capped at 60 ms) or more. A
   shorter segment can hold no packet start.
7. The first frame of the read starts at most one packet and 2 ms after the In point. The read
   of a Matroska source leaves out the frame that holds the In point. A decoder can also drop
   the first frame after a seek. The 2 ms cover the millisecond timestamps of Matroska and FLV.
8. No gap between two frames that reaches into the segment is longer than one packet. The read
   reports these gaps joined across 2 ms only, so it also shows the short holes that the bound
   of ADR 014 joins across 0.1 s.
9. The last frame of the read ends at most one packet before the Out point.

One packet is the longest frame of the read, and at most 60 ms. The check of an export without
video allows its audio to end 100 ms early (ADR 036), so the cap leaves a margin of 40 ms. The
lowest sample rate of the switch follows from the cap. At 32000 Hz, the frame of HE-AAC, 2048
samples, lasts 64 ms. Below that rate, most packets would be longer than the cap.

Checks 7 and 9 also refuse audio that starts late or ends early, and check 8 refuses a gap.
A copy writes no silence, so such audio would start or stop more than one packet from its
point. The user accepts only one packet. The check of an export without video also fails an
early end (measurement 9). It does not fail a late start (measurement 8).

### The commands

With video, a second `ffmpeg` copies the audio. It takes the place of the audio process of
ADR 043:

```
ffmpeg -nostdin -hide_banner -loglevel error -nostats -copyts \
  [-ss <seek>] -i <source>             (or the FLV slice of ADR 046) \
  -map 0:<audio stream> -c:a copy -ss <In> -to <Out> -f nut pipe:1
```

The encoder renders the graph of an export without audio. It reads the pipe as
`-f nut -i pipe:0`, maps `-map <n>:a`, and writes `-c:a copy`. It adds
`-bsf:a aac_adtstoasc` for the AAC of an MPEG-TS source. The encoder has no output `-ss`,
`-to`, `-t` or `-shortest`. It reads the pipe to its end.

Without video, one `ffmpeg` copies the audio into the reserved file. It has no graph:

```
ffmpeg <flags of ADR 014> -copyts [-ss <seek>] -i <source>   (or the FLV slice of ADR 046) \
  -map 0:<audio stream> -c:a copy [-bsf:a aac_adtstoasc] -ss <In> -to <Out> \
  <muxer of an audio-only export> <reserved file>
```

The output `-ss` is not the input seek of ADR 014. It is written at an In point of zero too
(measurement 5).

### The checks of success

An export with video that copies its audio passes the frame count of ADR 016. It then reads
its file back. The file must hold one video stream and one audio stream. A wrong stream set
fails the export with `outputStreamsMismatch`. A probe that fails is reported as for an export
without video (ADR 036). No measured copy failed this check. The check is a defence, because
FFmpeg can exit with 0 and write no audio track (ADR 014 measurement 23).

An export without video that copies its audio passes the check of ADR 036 with one change. The
measured value is the duration of the file plus the start of its audio stream, when that start
is after zero (measurement 6). An `.mka` counts its duration from zero, so the sum counts its
start twice. The tolerance of +0.50 s covers that.

## Consequences

- Each end of the copied audio lies within one packet of its point. With video, the audio keeps
  its place against the video, within 1 ms.
- A hole of up to one packet inside the segment stays in the output. The read does not bound
  the sum of such holes. The timestamps keep each packet in its place.
- The first AAC or MP3 frame after the cut decodes without the frame in front of it, as after
  any seek.
- An MP4 keeps the start of the copied audio in an edit list. A player that ignores edit lists
  plays the audio up to one packet early.
- The pair reads the source twice, as the pair of ADR 043 does.
- These are not copied: E-AC-3, FLAC, ALAC, PCM, Vorbis and every other codec outside the list,
  Opus into MP4 or MOV, audio below 32000 Hz, and sources in other formats, such as AVI and
  MPEG-PS.
- Audio that starts late, ends early, has a gap, or holds no frame in the segment is encoded.
  So is a segment shorter than three of the longest frames of the read. The switch can show for
  such a source, and the summary then names a copy that the export does not make. The
  interface does not report the mode that the run used.
- The export reads the sample rate of an MPEG-TS stream that the import probe missed. The plan
  could copy such audio, but the switch does not show for it.
- `ExportStart` echoes `streams` (ADR 036) but not `audioMode`. (Changed on 2026-10-27: no
  report of the run repeats either value.)
- The setup step shows no size estimate while the copy is on.
- The copy does not check for a change of the codec configuration inside the segment, such as a
  new sample rate after a reconnect of a live recording. An MP4 holds one configuration.
- These results come from FFmpeg 9.0.2 on Windows. The cut by an output `-ss` and `-to` under
  `-copyts`, and the codecs that NUT keeps, are not in the documentation of FFmpeg. The rule of
  the first frame depends on how the Matroska demuxer reads and how a decoder drops frames after
  a seek. Measurements 1 to 7 and 14 must run again for each new release of FFmpeg that QuipClip
  supports, and on macOS. These were not measured: HE-AAC, a path on a network share (UNC), and
  the peak memory of the pair.
