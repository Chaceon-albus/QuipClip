# 014. Cut segments with trim on raw source PTS, after a seeked input

- Status: Accepted
- Date: 2026-09-04
- Deciders: capric98

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
   stream `start_time`. The two values differ when the audio stream starts first. They
   differed in every fixture.
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

## Decision

### The boundary mechanism

The renderer cuts with `trim` and `atrim`. It gives the boundaries as integer ticks in
`start_pts` and `end_pts`.

The video boundaries are the stored source PTS values, without conversion. Measurements 1
and 3 make this correct. The audio boundaries are
`round(pts * videoTimeBase * sampleRate)`, computed as an exact rational value.

The renderer must not use the `start` and `end` options of `trim`. FFmpeg parses those
options into microseconds, and that truncation loses the precision that ADR 002 protects.

The renderer must set `-copyts` on each input.

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

```
ffmpeg -nostdin -hide_banner -loglevel error -progress pipe:1 -nostats -y \
  -copyts -ss <seek> -i <source>   (once for each segment) \
  -filter_complex "<graph>" \
  -map "[v]" -map "[a]" \
  -c:v <encoder> <quality> -c:a <encoder> [-movflags +faststart] \
  -f <mp4|mov|matroska> <temporary file in the destination directory>
```

Each segment has this chain:

```
[<i>:<videoStreamIndex>]trim=start_pts=<in>:end_pts=<out>,setpts=PTS-STARTPTS,
     fps=<rate>,scale=<w>:<h>,setsar=1,format=yuv420p[v<i>];
[<i>:<audioStreamIndex>]atrim=start_pts=<in>:end_pts=<out>,asetpts=PTS-STARTPTS,
     aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a<i>];
```

The chains end in `concat`, in project array order.

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

One input for each segment repeats the source path. The command line therefore grows with
the number of segments, and Windows limits a command line to 32767 bytes.

Measurement 13 removes the filter-graph file. The renderer therefore writes the graph
inline, and it selects between two shapes:

- One input for each segment, when the computed command line is inside the platform budget.
- One input, one seek before the first segment, and `split` and `asplit`, when it is not.

This satisfies the requirement in ADR 004 for a filter-graph file. The renderer never needs
one, because the second shape keeps the command line inside the limit.

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

## Consequences

- An export cuts at the frames that the user selected, on each container that was tested.
- An export of a short part of a long source does not decode the parts that it does not
  need.
- The renderer needs the container `start_time` and the selected audio stream index, so
  `MediaProbe` gets one new field and `AudioProbe` gets one.
- The renderer re-probes the source when an export starts. It does not read these two values
  from a project file, and ADR 010 therefore needs no new field.
- The renderer needs two graph shapes, and each shape needs its own tests.
- A container that seeks worse than MPEG-TS can still remove frames. The frame count
  comparison finds that condition and reports it.
- `SEEK_MARGIN_SECONDS` needs a test against a real capture from a content delivery
  network.
- A variable-frame-rate output mode is an addition. It is not a change to the interface.
- Version 1 exports one source, so a segment without audio cannot occur between segments
  with audio. The silence generation that ADR 004 requires belongs to the multi-source work.
