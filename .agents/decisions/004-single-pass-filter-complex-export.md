# 004. Export every segment in one ffmpeg pass with filter_complex

- Status: Accepted
- Date: 2026-08-29
- Deciders: capric98

## Context

The export must join several segments in order, and each cut must land on the frame the
preview showed. Three methods can do this:

- **Stream copy with the concat demuxer.** It is the fastest method. It cuts only on
  keyframes. A cut between keyframes moves by up to several seconds, so it cannot meet the
  accuracy requirement.
- **One `ffmpeg` run per segment, then a concat demuxer pass.** It is accurate. It writes
  temporary files, runs the encoder N+1 times, and must delete those files after a failure.
- **One run with `-filter_complex`.** It is accurate, it writes no temporary file, and it
  runs the encoder once.

A second question is filter order. `trim` cuts on the timestamps of its input. If the code
trims first and resamples afterwards, each segment rounds on its own and the lengths drift.
If it resamples first, the trim boundaries already sit on the output frame grid.

## Decision

Run ffmpeg once, with `-filter_complex`. Per input the order is **normalize, split, trim,
reset the timestamps, concatenate**.

```
[0:v]fps=OUT_FPS,scale=W:H:force_original_aspect_ratio=decrease,
     pad=W:H:-1:-1,setsar=1,format=yuv420p,split=N[n0v0][n0v1]...;
[0:a]aresample=OUT_RATE:async=1:first_pts=0,aformat=...,asplit=N[n0a0][n0a1]...;
[n0v0]trim=start=S0:end=E0,setpts=PTS-STARTPTS[v0];
[n0a0]atrim=start=S0:end=E0,asetpts=PTS-STARTPTS[a0];
[n0v1]trim=start=S1:end=E1,setpts=PTS-STARTPTS[v1];
[n0a1]atrim=start=S1:end=E1,asetpts=PTS-STARTPTS[a1];
...
[v0][a0][v1][a1]...concat=n=N:v=1:a=1[vout][aout]
```

**`split=N` and `asplit=N` are mandatory.** A filter output pad connects to exactly one
input pad. Without the split, the second and later references to `[n0v]` are unmatched
graph inputs, and ffmpeg binds them to the raw `0:v` stream instead. Every segment after
the first then bypasses the whole normalize block.

This was measured on ffmpeg 9.0.1. A two-segment graph that reuses the label fails with
`Input link parameters do not match the corresponding output link parameters` when the
normalize block scales. When it does not scale, the run succeeds and produces the wrong
frame count at the wrong rate. The same graph with `split=2` produces exactly the expected
frame count, rate, and size. Every `split` output must be consumed, or ffmpeg reports an
unconnected output.

Rules:

1. `S` and `E` come from the frame indices, through the exact rational conversion in
   ADR 002. `E` is the exclusive out point.

   `trim=end=T` rescales `T` into the timebase of its input link and drops the first frame
   at or after it. After `fps` the timebase is the frame grid itself, which gives a
   tolerance of half a frame. Measured at 3, 4, 6, 9, and 12 decimal places, the printed
   value gives the identical frame count. Print 9 decimal places.
2. Add `-fps_mode cfr`, so the output frame count is deterministic.
3. Always emit the normalize filters, even when they are the identity. Version 1 has one
   source at the project timebase, so they do nothing. Emitting them anyway means the
   multi-source path runs the same code, not a second code path.
4. A segment with no audio gets a generated silent stream, so `concat` always sees the same
   stream count on every input.
5. Read progress from `-progress pipe:1 -nostats`. The parser reads `out_time_us` and
   `frame`. Total output frames is `sum(out - in)`, which is exact and known before the run
   starts, so the percentage needs no estimate.
6. Pick the encoder from the probed capability set (ADR 006). `libx264` and `aac` are the
   fallback, because every build has them.
7. **Pass `-nostdin`.** Otherwise ffmpeg reads standard input for interactive keys and
   corrupts a piped child process.
8. Write to a temporary name in the destination directory, then rename. Pass `-y` for the
   temporary path only, so that a leftover file from an earlier crash does not make ffmpeg
   ask `Overwrite? [y/N]` and wait for an answer that never arrives. The rename is the only
   step that touches the path the user chose.
9. **The export reads the same file the preview read.** For a source the web view can
   decode, that is the original. For a source that needed a proxy, the frame grid the user
   marked on belongs to the proxy, so the export re-runs `fps=OUT_FPS` on the **original**
   with the same rounding the proxy used. Frame `k` then means the same frame in both. The
   export never encodes from the proxy, because the proxy is a `-crf 20` preview copy.
10. If the graph is too long for the platform command-line limit, write it to a file and
    pass `-/filter_complex <path>`. The older `-filter_complex_script` spelling was removed
    and fails on ffmpeg 9 with `Unrecognized option`.

## Consequences

- Every cut is frame-exact, and the export always re-encodes. A user who wants a fast
  keyframe-aligned cut does not get one. That trade is deliberate.
- One process means one progress stream, one cancel path, and one error path.
- The filter graph grows with the segment count, because each segment needs its own split
  branch. A test must cover a graph with many segments.
- Multi-source export needs no new pipeline. It needs one more input and one more normalize
  block per source.
- Rule 9 needs a test on a VFR source: mark a frame in the preview, export, and check that
  the first exported frame is the frame that was marked.
