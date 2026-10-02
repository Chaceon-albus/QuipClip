# 014. Cut segments with trim on raw source PTS, after a seeked input

- Status: Accepted
- Date: 2026-09-04
- Deciders: capric98
- Amended by: ADR 023, ADR 036, ADR 040

## Context

ADR 004 gives the semantic steps of the renderer. It deliberately does not select a `trim`
expression, and it does not select a position for the input `-ss`. It says that
implementation work must first define the timestamps that FFmpeg exposes after the selected
seek configuration.

This record supplies that definition, and it selects the command shape.

Two forces pull against each other. An export must cut at the exact frames that the user
selected. An export must also not decode four hours of a live stream to write five seconds
of output.

## Measurements

These measurements come from ffmpeg 9.0.1. They use six fixtures:

- A constant-frame-rate MP4. Its video starts at PTS 128000 (10.0 s, time base 1/12800).
  Its audio starts earlier.
- The same content as FLV, with time base 1/1000.
- The same content as MPEG-TS, with time base 1/90000.
- A variable-frame-rate MKV.
- An NTSC MP4, with time base 1/30000.
- A 10-minute FLV. It stands for a download from a content delivery network.

1. `-copyts` makes the filter graph observe the raw source PTS. Without `-copyts`, the
   first frame arrives as PTS 297. With `-copyts`, it arrives as PTS 128000. That is the
   value that ffprobe reports as `start_pts`.
2. The shift that occurs without `-copyts` is the container `start_time`, not the video
   stream `start_time`. The two values differed in every fixture. Each fixture had an audio
   stream that starts before the video stream, so the measurement does not establish whether
   any other condition also separates the two values. Treat any file as capable of a non-zero
   container start time.
3. The filter input link time base is equal to the video stream time base. The measured
   values were 1/12800, 1/15360, 1/1000, and 1/30000.
4. The audio filter input link time base is `1/sample_rate`. The measurement covers
   44100 Hz, 48000 Hz, and 32000 Hz.
5. `trim` is exactly half-open. FFmpeg documents `start_pts` as the first frame that it
   passes, and `end_pts` as the first frame that it drops.
6. `-accurate_seek` is enabled by default. FFmpeg added it in version 2.1. A run with
   `-noaccurate_seek` returned the key frame at PTS 140800. The default run returned the
   requested frame at PTS 148480.
7. The trailing `-ss 0` idiom has no effect. It is a workaround for versions before 2.1.
8. Input `-ss` is relative to the container `start_time`. It is not an absolute timestamp.
   A run with `-ss 11.6` on a file whose video starts at 10.0 s returned no frames.
9. Input seek alone is not frame-exact on MPEG-TS. A request for PTS 277200 returned
   PTS 313200. That is an error of ten frames. The seek landed only on key frames, and it
   landed after the target. Accurate seek can only discard the frames that it receives. It
   cannot recover the frames that the demuxer did not supply.
10. Input seek and `trim` together are exact on each container in the fixture list. This
    includes MPEG-TS. A seek that lands before the target lets `trim` cut correctly.
11. `trim` does not decode. It receives decoded frames and it drops some of them. The cost
    is in the decoding, and the seek controls the decoding. One cut took 5 s from the
    9-minute position of the 10-minute FLV. A full decode took 0.62 s. A seek took 0.09 s.
12. `out_time_us` is not correct when the command includes `-copyts`. One run reported 0
    at frame 979, and it reported 20.84 s at the end of a 60-second output. The `frame`
    field was correct.
13. `-filter_complex_script` does not exist in version 9.0.1. The replacement is
    `-/filter_complex`. FFmpeg added that syntax in version 7.1. No single spelling works on
    each version that a user can have.
14. Many inputs of one file do not cause a failure. Runs with 8, 32, and 64 segments gave
    exactly 200, 800, and 1600 frames. The largest run used 20 MB of memory.
15. Both graph shapes grow with the segment count, by roughly the same amount for each
    added segment. One input reaches further than one input for each segment, because it
    writes the source path once instead of once for each segment. That saving is outside the
    graph, in the argument list.
    The two graphs themselves changed places after measurement 17. The input rate pin adds
    one filter to every audio chain under one input for each segment. It adds exactly one
    filter in front of `asplit` under one input. One input therefore holds the larger graph
    for the first three segments. It holds the smaller graph from four segments upward,
    measured as 29804 bytes against 31266 bytes at the segment cap. No decision reads this number: the shape
    is chosen on the length of the whole command line, not on the size of the graph.
    (Changed on 2026-10-02.) After measurement 19 moved the pixel format out of the chains,
    the two graphs measure 28327 bytes against 29789 bytes at the segment cap. One input
    still holds the larger graph for the first three segments.
16. `setsar=1` changes the picture of a source that does not have square pixels. A 720x480
    source with a sample aspect ratio of 32:27 shows a display aspect ratio of 16:9. The
    filter `setsar=1` gives that source a display aspect ratio of 3:2, which is compressed
    horizontally. `setsar=sar` and no filter at all both keep 16:9.
17. An input seek changes the sample rate that the audio filter link reports. Without `-ss`,
    a 44100 Hz source presents its audio at 44100 Hz. With `-ss`, FFmpeg configures that
    input at the rate the graph negotiates for its output, which is 48000 Hz. The same
    `atrim=start_pts=441000` therefore reads as 10 seconds without the seek and as 9.1875
    seconds with it. The error grows with the position in the source, and it also shortens
    the segment. A 48000 Hz source shows nothing, because the two rates agree.
18. `-copyts` is global, not per input. One instance before the first input gives raw source
    PTS on every input. A command with two inputs and one `-copyts` reports PTS 128000 on
    both. The same command without it reports PTS 297.
19. (Added on 2026-10-02.) The position of the `format` filter in the graph text decides where
    FFmpeg converts a segment whose decoded pixel format differs from the others. FFmpeg
    merges the format lists of the links in the order of the filters in the graph text, and
    `concat` shares one format list across its video pads. FFmpeg does not document that order.
    - With one `format` behind `concat` and last in the text, the shared list took the format
      of the first segment. A segment of another format was converted to that format in front
      of `concat`, and the joined video was converted again behind it. The output changed. This
      happened only at the source resolution, with one input for each segment, and when the
      input of the first segment had no `-ss`.
    - With the same filter as the first chain of the text, `[vc]format=<pix>[v]`, each segment
      of another format is converted once, in front of `concat`.
    - With `format` at the end of each chain, as before, each segment is also converted once.

    The measurement used FFmpeg 9.0.2 and wrote video and audio framemd5 from the real input
    shape: one `-copyts`, the same seeks and both graph shapes, with and without `scale`. The
    fixtures were the six of this record, a 4:2:2 10-bit ProRes source, three stream copies
    that join a 4:2:2 part to a 4:2:0 part, a 10-bit part to an 8-bit part and an 8-bit part to
    a 10-bit part, and two generated inputs of different formats. In 68 runs, the graph with
    the format chain first matched the graph with `format` in each chain, for video and for
    audio. A later FFmpeg can change the order of the merge. This measurement must then be
    repeated.

    A change of the pixel format inside one input is a different case. FFmpeg then rebuilds the
    graph and loses frames, in every position of `format`. This happens with one input on a
    joined source. The frame count check of ADR 016 then reports `frameCountMismatch`, so the
    export fails and no wrong cut is published.

20. (Added on 2026-10-02.) `asetpts=PTS-STARTPTS` moved the audio of a segment to its first
    sample, not to its In point. When the audio of the source starts after the In point, or has
    a gap there, the audio of the segment then played early by that gap, and `concat` padded
    silence at its end. FFmpeg 9.0.2 on macOS measured the offset of a tone burst against a
    white frame on the same frame. Sources were 30 fps with AAC at 44.1 kHz and 48 kHz, in MP4
    and MKV, normal, with audio 0.3 s late, with audio that ends 1 s early, and with a 0.5 s gap
    of packets, in both graph shapes and three output formats, in 480 runs:

    | Case | Before | After |
    | --- | --- | --- |
    | Audio 0.3 s late, a segment from 0 | −277 to −300 ms | 0.0 ms |
    | Audio late, a segment that starts inside the late part, not first | −43 to −67 ms | −0.1 to +0.2 ms |
    | A 0.5 s gap inside a segment | −500 ms after the gap | 0 to +0.9 ms |
    | 100 segments of the gap source | −310.6 ms | 0.0 ms |
    | Audio that ends early, and normal sources | 0 to −0.2 ms | 0 to −0.2 ms |

    Each audio chain now resets its timestamps to the In tick, `asetpts=PTS-<in>`, and fills a
    leading gap with silence, `aresample=<sourceRate>:first_pts=0`. On the six fixtures of this
    record, on stereo and 5.1 sources, and at 100 segments, the samples that leave the graph are
    identical to before, and the video frames too. On MPEG-TS, four runs differ only in the
    audio timestamps, by one tick, because they are now contiguous. Two other forms failed: one
    fill behind `concat` left late starts under 0.1 s unfilled in a later segment, and one fill
    on the input link changed the cut on MPEG-TS by 2 samples.

21. (Added on 2026-10-02.) A late first audio sample costs memory in three ways. FFmpeg 9.0.2
    on macOS exported MP4 sources with 30 fps H.264 and AAC audio that starts 60 s or 120 s after
    the video. The figures are the peak resident memory, in MiB:

    - The fill of measurement 20 holds all of its silence in memory before it writes any of it.
      An audio-only export of the chain took 28 MiB with no gap. With a gap of 60 s it took
      95 MiB on 48000 Hz stereo, 215 MiB on 48000 Hz 5.1, and 532 MiB on 96000 Hz 7.1. A gap of
      120 s on 48000 Hz 5.1 took 407 MiB. AAC decodes to 32-bit samples. A 16-bit source took
      about half.
    - `concat` also holds its padding in memory. It pads a segment whose audio ends early only
      when another segment follows it. A last or only segment that lies wholly before the first
      sample gets no audio at all. When it is the only segment, an export with video fails in
      FFmpeg. With the audio
      from a second input that gives only the audio (see the last item), a segment of 58.9 s
      that ends before the first sample, followed by a segment that reaches it, took 176 MiB on
      48000 Hz 5.1. A segment of 118.9 s took 277 MiB. The fills of segments that overlap add
      up, because each chain builds its fill before `concat` reads it.
    - The largest cost comes before the filters. FFmpeg configures the filter graph only when
      each input link of the graph has a first frame. Until the first audio frame arrives, it
      keeps each decoded video frame of the input in memory. A segment from 0 with audio 60 s
      late took 924 MiB at 640x360 and 2.6 GiB at 1280x720, against 66 MiB with no gap. The
      chain from before measurement 20 took 742 MiB at 640x360, so this cost is older than the
      fill. A segment that ends before the first sample has the same cost: [0, 10) and
      [62, 65) together took 787 MiB at 640x360, and the padded project of the item above took
      869 MiB with one input for each segment. A second input that gives only the audio of the
      source removes this cost. Then the segment from 0 took 255 MiB at 640x360 with 5.1 audio,
      and 226 MiB at 1280x720 with stereo audio. The rest was the fill.

22. (Added on 2026-10-02.) A second input of the source with the same seek, from which the graph
    reads only the audio, gives the same output as the input of the segment. FFmpeg 9.0.2 on
    macOS compared the framemd5 of every video and audio frame that leaves the graph, with the
    audio from the input of each segment and with the audio from second inputs. The sources had
    audio 3 s late in MP4, MKV and MPEG-TS, audio 12 s late in MP4 and MKV, and audio that ends
    at 20 s of 40 s in MP4 and MKV. Six plans included a segment from 0, a segment that ends
    before the first sample, three segments out of source order, an In point after the first
    sample, a segment after the last sample, and a segment that ends after the last sample with
    another segment behind it. All 72 runs with second inputs, in both shapes, were identical.
    In 36 more runs, on sources whose audio starts at most 0.3 s late and on the plans that the
    rule of the decision leaves alone, the command did not change.

    The second input decodes no video, because no filter reads its video stream. With libx264,
    the peak memory fell as follows, in new runs, and the time of the export did not change:

    | Case | One input | Second input |
    | --- | --- | --- |
    | Audio 60 s late, segment from 0, 640x360, 5.1 | 925 MiB | 256 MiB |
    | The same at 1280x720, stereo | 2675 MiB | 229 MiB |
    | Three segments, one input for each | 1121 MiB | 134 MiB |
    | Three segments, one input | 790 MiB | 177 MiB |
    | Keyframes 10 s apart, audio 25 s late, seek at 28 s | 332 MiB | 158 MiB |
    | Audio ends at 20 s, a segment at 60 s, one input for each | 2870 MiB | 186 MiB |
    | Audio ends at 20 s, [17, 22) then [23, 83), one input | 1609 MiB | 170 MiB |

    In the keyframe case the seek lies after the first audio sample, but FFmpeg reads from the
    keyframe at 20 s, before it. In the last case the audio of [17, 22) ends only at the end of
    the file, and `concat` holds the video that `split` gives [23, 83) until then. With one input
    for each segment, the same plan took 186 MiB without the second input. A source with no
    late audio used the same memory as before. Two hundred inputs, the most that the first shape
    can open, ran with about 50 of the 256 file descriptors of a macOS application to spare.

    The default analysis of ffprobe reads about 5 s of a file. In MKV and MPEG-TS sources
    whose audio starts later than that, it reports the start of the audio stream as 0 or as the
    start of the container. In one MPEG-TS source with audio 12 s late, it reported no sample
    rate either. An MP4 file has an index, so its probe reported each start correctly.

23. (Added on 2026-10-02.) When a segment lies wholly before the first audio sample, or wholly
    after the last one, `atrim` passes no sample. The chain of that segment then gives no audio.
    The fill of measurement 20 writes silence only in front of a sample. FFmpeg 9.0.2 on macOS ran the
    graph of this record on 40 s sources of 30 fps H.264 with AAC. The audio started 3 s or 30 s
    late, ended at 20 s, or had no packets for 0.5 s, in MP4, MKV and MPEG-TS. The plans held
    such a segment alone, behind a covered segment, and in front of one. Other plans held a
    segment that the audio ends inside, and three segments of each kind. The runs used the three
    shapes, the source rate and 48000 Hz, with video and without video. Each run compared the
    audio samples and the video frames that leave the graph: 444 comparisons.

    - Without a change, a lone segment outside the audio failed in 17 runs with "Could not open
      encoder before EOF". In 55 runs FFmpeg exited 0, and the graph gave no audio. An MP4
      export of such a segment then held no audio track. The frame count check passes that file.
      When the last segment was outside the audio, the audio track ended with the segment before
      it.
    - `apad=whole_len=<out - in>` behind the fill adds silence to the audio of the chain. The
      result has the length of the segment, in samples of the source rate. With it, every run
      exited 0, and every chain held the planned number of samples. The silence lay where the
      audio does not reach, within the 0.024 s of the AAC priming. The video frames did not
      change. Where the audio covered a part of the segment, the old samples were the start of
      the new samples. When the output changed 44100 Hz to 48000 Hz, the last 17 samples in front
      of the silence changed. There the resampler reads silence and not the end of the stream.
    - `apad` gives its silence no timestamp when it receives no frame. `concat` converts that
      missing value as a number, so these frames left `concat` at about −9.2 × 10^18. FFmpeg
      9.0.2 replaced the timestamps before the encoder, but FFmpeg does not document that
      behaviour. `asetpts=N` behind `apad` sets the timestamp of each frame to the number of
      samples in front of it. The timestamps that leave `concat` are then contiguous.
    - On sources whose audio covers every segment, `apad` and `asetpts=N` in every chain did not
      change the output. The framemd5 of the video and audio frames that leave the graph was
      identical in 441 runs. The runs used MP4, MKV, MPEG-TS and MOV, 32000 Hz to 48000 Hz, and
      mono, stereo and 5.1 audio. They used 1, 3 and 100 segments, all shapes, and three output
      formats. FFmpeg put its resampler behind `asetpts`, so `apad` counts samples at the source
      rate. The fill leaves a gap of 0.1 s or less inside a segment unfilled. In the last segment,
      `apad` now adds that time as silence at the end, as `concat` already did for every other
      segment. A gap of 0.064 s in an MKV gave 3064 samples of silence at the end, at 48000 Hz.
    - `apad` writes its silence one frame at a time. A last segment of 575 s after the end of
      48000 Hz 5.1 audio took 42 MiB, against 45 MiB for a source whose audio covers it. The
      padding of `concat` stays in memory. The same segment with another segment behind it took
      900 MiB, and a segment of 120 s took 226 MiB. With `apad` in every chain, the case of 575 s
      took 50 MiB.
    - An export without video, with `apad` in every chain, wrote each segment at its full
      length. There were 592 runs into `aac` in `.m4a`, and into `aac`, `libopus` and `flac` in
      `.mka`. The duration of each file minus the planned duration was −0.0007 s to +0.0233 s.

24. (Added on 2026-10-02.) The first packet of the audio stream gives the start that the probe of
    measurement 22 misses. FFmpeg and FFprobe 9.0.2 on macOS read sources of 120 s at 1280x720
    and 30 fps, H.264 at 20 Mb/s with AAC at 48 kHz stereo. The audio started at 0 s, 12 s and
    60 s, in MP4, MKV and MPEG-TS. One more MKV source of 630 s had its audio at 600 s. After the
    usual analysis of FFprobe, this command reads packets until it has one packet of the selected
    stream. It decodes none of those packets:

    ```
    ffprobe -v error -select_streams <audioStreamIndex> -show_entries packet=pts:stream=time_base \
      -read_intervals %+#1 -of json -i <source>
    ```

    | Source | Probe: start, length | First packet | Full analysis: start |
    | --- | --- | --- | --- |
    | MKV, audio at 0 s | 0, 120.021 s | −0.021 s | 0 |
    | MKV, audio at 60 s | 0, 120.010 s | 59.979 s | 60.000 s |
    | MPEG-TS, audio at 0 s | 1.400 s, 120.000 s | 1.400 s | 1.400 s |
    | MPEG-TS, audio at 60 s | 1.400 s, 120.000 s | 61.379 s | 61.379 s |
    | MP4, audio at 60 s | 59.979 s, 60.011 s | 59.979 s | 59.979 s |

    The full analysis is `-analyzeduration 200M -probesize 2G`. The sources with audio at 12 s
    gave the same pattern. When the probe reads no packet of a stream, FFmpeg gives that stream
    the start and the duration of the container. In the MKV source with audio at 60 s,
    `duration_ts` was therefore 120.010 s, which is the duration of the container. The `DURATION`
    tag held the end of the track. If that `duration_ts` stays a length after the start moves, the
    audio ends at 180 s in a file of 120 s. In the MPEG-TS sources with late audio, the probe also
    reported a sample rate of 0. The packet does not give the rate.

    The full analysis skips the priming of the encoder. In MKV, the first packet of AAC therefore
    comes 21 ms before the start that the full analysis reports. In each source that the probe read
    correctly, the first packet came at the reported start or before it.

    The table gives the time of each command. Each value is the median of 15 runs with the file in
    the page cache.

    | Source | Probe | First packet |
    | --- | --- | --- |
    | MP4, audio at 0 s | 48 ms | 53 ms |
    | MKV, audio at 0 s | 54 ms | 53 ms |
    | MPEG-TS, audio at 0 s | 61 ms | 60 ms |
    | MKV, audio at 60 s | 54 ms | 62 ms |
    | MPEG-TS, audio at 60 s | 61 ms | 74 ms |
    | MKV, audio at 600 s, 1.4 GB | 98 ms | 198 ms |

    Most of that time is the analysis that FFprobe does before it reads a packet, as in the probe.
    The full analysis also found the start. But it decodes, and it took 912 ms on the MPEG-TS
    source with audio at 60 s.

    The export of [0, 65 s) of the MKV source with audio at 60 s then used the start from the first
    packet. It took its audio from a second input. With libx264, the peak memory fell from 2042 MiB
    to 443 MiB, and the framemd5 of the video and the audio did not change. Without the first
    packet, an audio-only export of [0, 30 s) of the same source expected 30 s of audio. FFmpeg
    exited 0 with a file that had no audio stream. With the first packet, the plan refused that
    export with `sourceHasNoAudio`. This case came before the pad of measurement 23, and nobody ran
    it again after that change. From measurement 23, that export now writes 30 s of silence, and
    the plan expects 30 s and does not refuse it.

25. (Added on 2026-10-02.) The position of the first audio packet gives the sample rate that the
    probe misses. FFmpeg and FFprobe 9.0.2 on macOS read MPEG-TS sources of 120 s at 1280x720 and
    30 fps, H.264 at 20 Mb/s, with 48 kHz stereo audio that starts 12 s or 60 s late. The audio
    was AAC, MP2 or AC-3. One more source of 630 s had AAC at 600 s. One source was M2TS, with
    packets of 192 bytes and AAC at 60 s. One source was MPEG-PS, with MPEG-2 video and MP2 at
    60 s. For each of these sources, the probe reported a sample rate of 0. For MP2 in MPEG-TS, it
    also reported the codec as `mp3`. In the MPEG-PS source, the probe also reported the start of
    the container, 0.533 s, as the start of the audio, and the first packet came at 60.523 s.

    The command of measurement 24 also reads `pos` and the stream `id`. This command then starts
    its analysis at that byte, and it selects the stream by its id:

    ```
    ffprobe -v error -skip_initial_bytes <pos> -select_streams i:<id> \
      -show_entries stream=id,sample_rate -of json -i <source>
    ```

    It reported 48000 for each source, the same rate as an analysis of 200M. After the skip, the
    demuxer can give the streams other indices, so the id selects the stream. In MPEG-TS the id is
    the PID, and in MPEG-PS it is the stream id. A Matroska stream has no id, but its header holds
    the rate. The H.264 decoder writes errors to stderr after the skip, because the read starts
    between two keyframes. The rate does not change because of them.

    The time of each command, as the median of 9 runs with the file in the page cache:

    | Source | Probe | First packet | Rate from `pos` | Analysis to the first packet |
    | --- | --- | --- | --- | --- |
    | MPEG-TS, AAC at 12 s | 64 ms | 67 ms | 62 ms | 95 ms |
    | MPEG-TS, AAC at 60 s | 62 ms | 76 ms | 62 ms | 234 ms |
    | MPEG-TS, MP2 at 60 s | 62 ms | 76 ms | 62 ms | 237 ms |
    | MPEG-TS, AC-3 at 60 s | 63 ms | 77 ms | 63 ms | 242 ms |
    | M2TS, AAC at 60 s | 65 ms | 86 ms | 72 ms | 270 ms |
    | MPEG-TS, AAC at 600 s, 1.5 GB | 69 ms | 227 ms | 64 ms | 1877 ms |

    The last column is a probe with `-analyzeduration` set to the time of the first packet plus
    1 s. Its time grows with the gap. The read from `pos` takes the same time at any gap.

    With that rate, each of these sources exported with video and audio through a second input,
    and FFmpeg exited 0. The first sound of each output came where it comes when FFmpeg decodes the
    source alone. For AAC at 60 s in MPEG-TS, that is 59.987 s after the start of the video, and
    11.987 s for AAC at 12 s. A segment that starts 30 s before the audio at 600 s had its first
    sound at 29.987 s. MP2 and AC-3 gave 59.999 s. MPEG-TS has no field for the priming of the AAC
    encoder, so its sound starts 13 ms earlier than in the MKV source. An audio-only export of 80 s
    from the start of the video wrote 80.000 s against an expected 80.000 s. Before this change,
    the plan refused each of these exports with `sourceAudioRateUnknown`.

## Decision

### The boundary mechanism

The renderer cuts with `trim` and `atrim`. It gives the boundaries as integer ticks in
`start_pts` and `end_pts`.

The video boundaries are the stored source PTS values, without conversion. Measurements 1
and 3 make this correct. The audio boundaries are
`round(pts * videoTimeBase * sampleRate)`, computed as an exact rational value.

The renderer must not use the `start` and `end` options of `trim`. FFmpeg parses those
options into microseconds, and that truncation loses the precision that ADR 002 protects.

The audio chain applies `aformat` with the source sample rate before `atrim`. Measurement
17 gives the reason. An input seek makes FFmpeg present that input at the output rate. The
boundary ticks count the source rate. The cut therefore lands early, and the segment loses
length. The video frame count stays correct, so the frame comparison cannot report
this. Pinning the input link to the source rate restores the boundary.

The chain applies `scale` and `setsar=1` together, and only when the preset gives an
explicit resolution. A chain that keeps the source resolution applies neither filter.
Measurement 16 gives the reason. `setsar=1` on its own compresses a source that does not
have square pixels. The preview shows that source correctly. The export would therefore not
match what the user marked. Version 1 exports one source, so every chain already reports
the same sample aspect ratio, and `concat` has nothing to make equal.

The renderer must set `-copyts` once, before the first input. Measurement 18 shows the
option is global. One instance covers every input, and a second instance changes nothing
except the length of the command line, which measurement 15 counts.

### The seek

The renderer seeks each input to
`inPts * videoTimeBase - formatStartTime - SEEK_MARGIN_SECONDS`, and it clamps that value
at zero. It omits `-ss` when the result is zero.

`SEEK_MARGIN_SECONDS` is 5. The margin must be larger than one group of pictures, because
measurement 9 shows that a seek can land after the target.

The renderer must not emit a trailing `-ss 0`.

`formatStartTime` is necessary because of measurement 8. `probe.rs` must report it.

### The command

One process writes one output. The renderer opens one input for each segment.

(Changed on 2026-10-02.) The command below is the export of the video and the audio. ADR 036
gives the shapes of a video-only and of an audio-only export, the muxer of an audio-only export,
and the check of its output.

```
ffmpeg -nostdin -hide_banner -loglevel error -progress pipe:1 -nostats -y \
  -copyts \
  -ss <seek> -i <source>             (once for each segment) \
  -filter_complex "<graph>" \
  -map "[v]" -map "[a]" \
  -c:v <encoder> <quality> -c:a <encoder> [-movflags +faststart] \
  -f <mp4|mov|matroska> <temporary file in the destination directory>
```

Each segment has this chain:

```
[<i>:<videoStreamIndex>]trim=start_pts=<in>:end_pts=<out>,setpts=PTS-STARTPTS,
     fps=<rate>[,scale=<w>:<h>,setsar=1],format=yuv420p[v<i>];
[<i>:<audioStreamIndex>]aformat=sample_rates=<sourceRate>,
     atrim=start_pts=<in>:end_pts=<out>,asetpts=PTS-STARTPTS,
     aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a<i>];
```

(Changed on 2026-10-02.) The audio chain starts at the In point (measurement 20):

```
[<i>:<audioStreamIndex>]aformat=r=<sourceRate>,
     atrim=start_pts=<in>:end_pts=<out>,asetpts=PTS-<in>,
     aresample=<sourceRate>:first_pts=0,aformat=f=fltp:r=<outputRate>[:cl=<layout>][a<i>];
```

`<in>` is the In point in ticks of the source sample rate, and a negative tick renders as
`PTS+<magnitude>`. `first_pts` makes swresample pad the time from the In point to the first
sample with silence, when that time is more than 1 ms, and fill a gap of more than 0.1 s inside
the segment. The fill names the source rate, so the conversion to the output rate stays in the
final `aformat`. The short option names `r`, `f` and `cl` need FFmpeg 4.3 or later, and keep the
command line within the budget. The widest plan now measures 31509 bytes at the cap, which leaves
234 bytes of the Windows budget free.

(Changed on 2026-10-02.) An audio chain that `concat` does not pad ends at the length of its
segment (measurement 23):

```
[<i>:<audioStreamIndex>]aformat=r=<sourceRate>,
     atrim=start_pts=<in>:end_pts=<out>,asetpts=PTS-<in>,
     aresample=<sourceRate>:first_pts=0,apad=whole_len=<out - in>,asetpts=N,
     aformat=f=fltp:r=<outputRate>[:cl=<layout>][a<i>];
```

`concat` pads the audio of a segment to its video when another segment follows it. So an export
with video adds `apad` and `asetpts=N` to the last audio chain only. An export without video
adds them to every audio chain. `<out - in>` is the length of the segment in ticks of the source
sample rate. A chain whose audio covers the segment without a gap already holds that number of
samples, so its output does not change. A segment that the audio does not reach, or the part of a segment after
the last sample, becomes silence. `asetpts=N` gives that silence its timestamps. The two filters
cost 26 bytes and the digits of the length. With the filters in the last chain only, and a length
of 12 digits, the widest plan measures 31547 bytes at the cap. Then 196 bytes of the Windows
budget stay free.
In every chain, the filters would cost up to 3800 bytes at the cap, and the budget does not have
them. The widest plan without video measures 21323 bytes at the cap.

(Changed on 2026-10-02.) The plan refuses an export that writes audio when the parts of its
segments before the first sample of the source audio add up to more than 60 s (measurement 21).
The code is `audioGapTooLong`, and `MAX_LEADING_AUDIO_SILENCE_SECONDS` holds the bound. The sum
counts the fills and the padding of `concat` together, because FFmpeg holds both in memory, and
the chains of overlapping segments build theirs at the same time. With video, a segment that ends
at or before the first sample counts in full, so a cut at the first sample does not get around
the bound. An audio-only export writes nothing for such a segment, so it counts only the segments
that reach the sample. (Changed on 2026-10-02: an audio-only export now writes silence for such a
segment, with `apad`, which does not keep that silence in memory (measurement 23). The sum still
counts only the segments that reach the sample.) At the bound, the fill alone took 95 MiB on 48000 Hz stereo and 215 MiB on
48000 Hz 5.1. A video-only export reads no audio. The probe reports only where the stream starts,
so the bound does not apply to a gap inside the stream. This bound does not cover the decoded
video that waits for the first audio frame (measurement 21). A second input of the source removes
that wait; see "The graph shape".

(Changed on 2026-10-02.) The video chain no longer ends in `format=yuv420p`. One chain at the
start of the graph text sets the pixel format of the joined video, and `concat` writes `[vc]`:

```
[vc]format=yuv420p[v];
[<i>:<videoStreamIndex>]trim=start_pts=<in>:end_pts=<out>,setpts=PTS-STARTPTS,
     fps=<rate>[,scale=<w>:<h>,setsar=1][v<i>];
...
[v0][a0][v1][a1]...concat=n=<count>:v=1:a=1[vc][a]
```

A later unit makes the pixel format a field of the preset, such as `p010le`. A format in each
chain would then cost up to 19 bytes for each segment, and at the cap of 100 segments only 130
bytes were free. The format chain must stay first in the text (measurement 19). The widest
plan that the settings permit measures 30136 bytes at the cap, which leaves 1607 bytes of the
Windows budget free, and 105 segments fit. (Changed on 2026-10-02: the preset now names the
pixel format, and its encoder options can add 1024 bytes. The widest plan measures 31620 bytes
and leaves 123 bytes free, and 100 segments fit, ADR 040.)

The chains end in `concat`, in project array order. `scale` and `setsar=1` appear only when
the preset gives an explicit resolution, and the leading `aformat` pins the input link to the
source sample rate, as the decision text above requires.

Each chain names an absolute stream index. It must not use the short specifiers `[<i>:v]`
and `[<i>:a]`.

A short specifier selects the **first** stream of that type. The probe selects the stream
that carries the `default` disposition. The two rules disagree when a file holds more than
one audio stream and the default one is not the first one.

One file shows the disagreement. It holds an AC-3 stream at index 1, which does not carry
the default disposition. It holds an AAC stream at index 2, which does. The probe reports
stream 2. `[0:a]` binds stream 1. The export would then contain audio that the preview
never played, and nothing would report an error.

`MediaProbe.video_stream_index` already carries the video index. `AudioProbe.index` carries
the audio index for the same reason.

`-f` is necessary. The temporary file has no usable extension, so FFmpeg cannot select a
muxer from the name. `mkv` selects the muxer `matroska`.

### The graph shape

Measurement 13 removes the filter-graph file, so the renderer writes the graph inline.
Windows limits a command line to 32767 bytes. The graph therefore competes with the
arguments for one budget.

Measurement 15 shows how each shape uses that budget. The graph grows by about 260 bytes for
each segment, in both shapes. One input for each segment adds the source path and its flags
again for each segment. One input adds the path once, and it adds a `split` chain and an
`asplit` chain, which cost more than the labels they replace.

The renderer selects between the two shapes:

- One input for each segment, when the computed command line is inside the platform budget.
- One input, one seek before the first segment, and `split` and `asplit`, when it is not.

The second shape does not remove the growth. It removes the repeated path only, so it
extends the reachable segment count by about half on a long path. Neither shape can spell an
export of more than about 125 segments on Windows.

`MAX_EXPORT_SEGMENTS` is therefore 100. That value stays inside the Windows budget for a
long path. It is also far above the number of segments a person marks by hand.

(Changed on 2026-10-02.) Every segment takes its audio from a second input of the source, with
the seek of the segment, when the plan writes video and audio and one of three conditions holds
(measurements 21 and 22):

- The first sample of the source audio comes more than 0.5 s after the start of the container.
- An input of a segment starts to read less than 0.5 s before the last sample of the audio, or
  after it. The input starts to read no later than its seek, or the start of the container when
  the seek is clamped.
- A segment that another segment follows in concat order ends less than 0.5 s before the last
  sample, or after it. Under one input, its audio ends only at the end of the file, and
  `concat` holds the video of the segments behind it until then.

The last two conditions apply only when the probe reports where the audio starts and how long
it is.

The graph then has its first audio frame at once, so FFmpeg does not keep the decoded video
until the audio arrives. The rule is one for the whole plan, because an input reads from the
keyframe at or before its seek. The plan does not know where that keyframe is, so a segment
whose seek lies after the first audio sample can still start to read before it. Under the first
shape, the second inputs follow the inputs of the segments, in segment order: input `n + i`
gives the audio of segment `i`. Under the second shape there is one second input, with the one
seek. When the second shape and its second input do not fit in the budget, a third shape drops
the second input and writes the command of the second shape as it was before. Then the graph
waits for the audio again. At the cap on the longest Windows path, with every setting at its
widest, the second input costs 288 bytes and misses the budget by 54 bytes (92 bytes since
measurement 23), so that plan uses
the third shape. A plan whose audio neither starts late nor ends before a segment does has no
second input and does not change. Below the threshold the wait stays: at 3840x2160 and 60 fps,
0.5 s of decoded video is about 370 MB with 8-bit samples, and about 750 MB with 10-bit samples.

A larger export needs the graph off the command line. That syntax exists as
`-/filter_complex <file>` in FFmpeg 7.1 and later. The capability probe already reads the
version. A later unit can select that form when the installed build offers it. It keeps the
inline form for an older build. This record does not require that work.

This satisfies the requirement in ADR 004 for a filter-graph file. The renderer never needs
one, because the segment cap keeps the command line inside the limit.

### Progress

The renderer reads progress from `frame`, and it compares that value with an expected
count. It must ignore `out_time_us`, because of measurement 12.

The expected count is
`sum of round((outPts - inPts) * videoTimeBase * outputFrameRate)`.

The renderer compares the final `frame` value with the expected count. A smaller value
means that the seek removed frames that the output needed. The renderer then reports the
error code `frameCountMismatch`. It must not write an incorrect cut without a report.

### Output timing

Version 1 writes constant-frame-rate output. It applies `fps` to each segment, because
`concat` needs one frame rate and a variable-frame-rate source has none.

The plan holds the timing mode in an enumeration, and the graph builder selects the `fps`
filter through that enumeration. Version 1 has one value.

The preset value `source` means the constant frame rate that `avg_frame_rate` reports, and
then `r_frame_rate`. A later variable-frame-rate mode will need a different value, and the
settings schema version will increase.

The expected frame count is optional on the interface. A variable-frame-rate mode cannot
predict a frame count.

### Other rules

The renderer writes a temporary file in the destination directory, and it renames that file
after a success.

The renderer decodes the original media. It must not decode a preview proxy.

(Added on 2026-10-02.) After the re-probe, an export that writes audio reads the first packet of
the selected audio stream with the command of measurement 24. The time of that packet becomes the
start of the audio only when the packet comes after the reported start. It also becomes the start
when the probe reports no start. The plan of a source that the probe reads correctly therefore
does not change.

When the start moves, the end of the stream stays where it was. That end is the reported start
plus the reported length. When that end is unknown or does not lie after the packet, the end is the
`DURATION` tag, if the tag lies after the packet. The length becomes that end less the new start.
The reported end comes first, because a muxer other than FFmpeg's can write the length of the track
in the tag (ADR 036). Read as an end, such a tag ends the audio too early. When the probe reports a
start, the end therefore never moves earlier than the end that the export used before this change.
When the probe reports no start, the export had no end before, and the tag can give one. (Changed
on 2026-10-02: since the pad of measurement 23, the plan reads the end only for the second input
of measurement 22. In the measured sources, a start that moves lies more than 5 s after the start
of the container, so the plan takes that input whatever the end. There, the choice of the end
does not change the plan.)

The read uses the runner, the deadline and the cancel flag of the probe of an export output
(ADR 036). When the read cannot start, fails, finds no packet, or does not finish in time, the plan
uses the values of the probe, and the export continues. A cancel ends the run.

The start can be early by the priming of the encoder, which is 21 ms for AAC at 48 kHz. The read
does not correct a sample rate of 0. It does not run when the probe reports no sample rate, because
the plan then refuses the audio with `sourceAudioRateUnknown`. (Changed on 2026-10-02: the next
paragraph reads that rate. The export now reads the first packet of a stream without a rate too,
because the read of the rate starts at the position of that packet.)

(Added on 2026-10-02.) When the probe reports no sample rate, the export reads the rate again with
the command of measurement 25. That read needs the position of the first packet and the id of its
stream. It uses the runner, the deadline and the cancel flag of the read of the first packet. The
rate that it reports becomes the source rate of the plan. When the read cannot start, fails, finds
no positive rate, or does not finish in time, the rate stays unknown. The plan then refuses the
audio with `sourceAudioRateUnknown`, as before. A cancel ends the run. The export reads the first
packet of a stream without a rate only in MPEG-TS and MPEG-PS, the demuxers `mpegts` and `mpeg`.
In another container, the reads cannot give the rate, and the plan refuses the audio at once.

## Consequences

- (Added on 2026-10-02.) The fill of measurement 20 holds the whole of a gap in memory before it
  writes it. A leading gap of 600 s on 48 kHz 5.1 audio took 1.6 GB, against 44 MB for 10 s. A
  segment that spans a long late start or a long drop of the audio therefore needs memory in
  proportion to the gap. (Changed on 2026-10-02.) The plan refuses more than 60 s of silence in
  front of the first sample, summed over the segments (measurement 21). A gap inside the stream
  stays unbounded, because the probe does not report it. The padding after the end of the stream
  stays unbounded too: this change does not bound it. (Changed on 2026-10-02.) `apad`
  (measurement 23) writes the padding of each chain that `concat` does not pad. It does not keep
  that padding in memory. The padding of `concat`, for a segment with another segment behind it,
  stays unbounded. It took 900 MiB for 575 s of 48000 Hz 5.1 audio after the end of the stream.
  `apad` in
  every chain removes this cost too, but the command line at the cap has no room for it. A later
  unit can add `apad` to every chain of a command that fits the budget.
- (Added on 2026-10-02.) Until the first audio frame of an input arrives, FFmpeg keeps each
  decoded video frame of that input in memory (measurement 21). A segment that starts long
  before the first sample therefore needs memory in proportion to that time and to the size of
  a frame: 2.6 GiB for 60 s at 1280x720. This cost is older than measurement 20.
  (Changed on 2026-10-02.) A second input for the audio now removes it (measurement 22). The
  wait stays in these cases:
  - the third shape of the budget;
  - an MKV or MPEG-TS source whose probe misses a late start of the audio, which then also
    takes the length of the audio from the container, so the end of the audio is wrong too
    (changed on 2026-10-02: the first packet now gives the start and keeps the end, measurement
    24, so this case stays only when that read fails);
  - a probe that reports no length of the audio, so the conditions at its end do not apply;
  - a seek into a gap inside the audio stream, which the probe does not report;
  - a wait shorter than 0.5 s.
- (Added on 2026-10-02.) An export that writes audio runs FFprobe twice before FFmpeg starts
  (measurement 24). The second run reads the file up to the first audio packet. On a slow disk or
  a share, a source whose audio starts late can make that read last up to the probe timeout of
  30 s. Preparation then lasts up to 60 s. A cancel stops the read. When the read fails, the plan
  uses the values of the probe. The two decisions that read the audio start then do not apply, as
  before this change. They are the bound of measurement 21 and the second input of measurement 22.
  Since the pad of measurement 23, the expected duration of an audio-only export (ADR 036) does not
  read the start. (Changed on 2026-10-02: a source whose probe reports no sample rate runs FFprobe
  three times, measurement 25, so its preparation lasts up to 90 s.)
- (Added on 2026-10-02.) An MPEG-TS source whose audio starts more than about 5 s late still has
  no sample rate in the probe (measurement 22). The plan refuses its audio with
  `sourceAudioRateUnknown`, and only a video-only export of it works. The export does not read the
  first packet of such a stream. (Changed on 2026-10-02: the export reads the rate from the
  position of the first packet, measurement 25. The plan refuses the audio only when that read
  fails, and in MPEG-PS too.)
- (Added on 2026-10-02.) When the probe misses a late start in MKV, the end of the audio stays at
  the end of the container, as before measurement 24. The `DURATION` tag of FFmpeg's muxer can give
  an earlier end, but the tag of another muxer can hold a length, so the export does not prefer
  the tag. (Changed on 2026-10-02: since measurement 23, this end decides only the second input
  for the audio, and such a late start takes that input anyway.)
- (Added on 2026-10-02.) Under one input, `split` can give a segment its video before the
  segments ahead of it in concat order have finished, and `concat` then holds that decoded
  video. This happens when the segments are out of source order or overlap, and it has nothing
  to do with the audio, so a second input does not help. On a 1280x720 source with libx264,
  [60, 70) then [0, 50) took 2078 MiB, against 156 MiB in source order. Only the second shape has this cost,
  and Windows uses it only when the first shape does not fit, at about 75 segments or more on a
  path of 106 characters. This cost is older than measurement 20.
- (Added on 2026-10-02.) A last or only segment that lies wholly before the first audio sample
  gets no audio, because `concat` pads only a segment that another segment follows. When it is
  the only segment, an export with video fails in FFmpeg (measurement 21). (Changed on
  2026-10-02.) `apad` in the last audio chain now gives such a segment silence of its length
  (measurement 23). It does the same for a segment wholly after the last sample. Measurement 23
  also found that, without `apad`, FFmpeg can exit 0 and write a file with no audio track in this
  case.
- (Added on 2026-10-02.) A source whose audio timestamps drift from the sample count builds up an
  error. When the error passes 0.1 s, swresample drops or fills at least 0.1 s at once, in the
  middle of a segment. Timestamps that ran 2% slow gave one drop of 0.1 s in 10 s. Before
  measurement 20, every sample passed. A gap or an overlap shorter than 0.1 s stays as it is.
- (Added on 2026-10-02.) `first_pts` fills a gap inside the stream by the behaviour of the code of
  swresample, which its documentation does not state. Measurement 20 must run again for each new
  release of FFmpeg that QuipClip supports.
- (Added on 2026-10-02.) Two results of measurement 23 come from the behaviour of the code of
  FFmpeg, which its documentation does not state:
  - FFmpeg puts its resampler behind `asetpts=N`, so `apad` counts samples at the source rate.
  - `asetpts=N` changes no timestamp of a covered chain, because the fill of measurement 20
    numbers its output from 0 without a gap.

  Measurement 23 must run again for each new release of FFmpeg that QuipClip supports.

- An export cuts at the frames that the user selected, on each container that was tested.
- An export of a short part of a long source does not decode the parts that it does not
  need.
- The renderer needs the container `start_time` and the selected audio stream index, so
  `MediaProbe` gets one new field and `AudioProbe` gets one.
- The renderer re-probes the source when an export starts. It does not read these two values
  from a project file, and ADR 010 therefore needs no new field.
- The renderer needs two graph shapes, and each shape needs its own tests.
- An export of more than 100 segments fails the preflight. The interface must say so before
  the user marks them, and not after.
- The frame count comparison sees a lost video frame. It cannot see an audio boundary that
  moved. An audio fault needs its own test against a source that is not 48000 Hz.
- A container that seeks worse than MPEG-TS can still remove frames. The frame count
  comparison finds that condition and reports it.
- `SEEK_MARGIN_SECONDS` needs a test against a real capture from a content delivery
  network.
- A variable-frame-rate output mode is an addition. It is not a change to the interface.
- The plan refuses a source whose audio stream reports no usable sample rate, with
  `sourceAudioRateUnknown`. The boundary formula above needs that rate, so a missing one cannot
  be planned around. Dropping the track instead would write a file with no sound and report a
  success.
- Version 1 exports one source, so a segment without audio cannot occur between segments
  with audio. The silence generation that ADR 004 requires belongs to the multi-source work.
