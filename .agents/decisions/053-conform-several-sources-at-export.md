# 053. Make the pieces of several sources fit one output

- Status: Accepted
- Date: 2026-10-28
- Deciders: capric98
- Amends: ADR 004, ADR 014, ADR 023, ADR 024, ADR 043, ADR 048, ADR 049, ADR 050

## Context

ADR 052 lets one export join pieces of several sources. A piece is one source interval
`[inPts, outPts)`. The sources can differ in frame size, sample aspect ratio (SAR), rotation,
frame rate, sample rate and channel layout. Some sources have no audio.

The `concat` filter joins the pieces. Its source code (`libavfilter/avf_concat.c`, function
`config_output`) gives three facts:

1. When the frame sizes of the video inputs differ, the filter fails with `EINVAL`. It also
   fails when the SARs differ. An input with an unknown SAR passes only when its denominator
   matches the SAR of the output. When the first input has an unknown SAR, the output takes the
   SAR of the next input.
2. When the frame rates of the video inputs differ, the output frame rate is unknown (`1/0`).
   For a constant-frame-rate output with no `-r`, the `ffmpeg` program then uses 25 frames per
   second (`fftools/ffmpeg_filter.c`, function `choose_out_timebase`). Constant frame rate is the
   automatic mode for MP4 and MOV.
3. All inputs and the output share one list of pixel formats, sample rates and channel layouts.
   The format negotiation of `ffmpeg` adds the converters. The order of the negotiation decides
   which value wins, and `ffmpeg` does not document that order.

`ffmpeg` rotates each input by its display matrix by default. It adds `transpose` at the start
of the chain of that input inside the graph. A portrait clip from a phone therefore reaches the
chain with its width and height swapped. A preset cannot change this: `autorotate`,
`noautorotate` and `display_rotation` are on the deny list of preset options.

Today each chain is `trim,setpts,fps=<rate>[,scale=<w>:<h>,setsar=1]` (ADR 014). The scale step
appears only for an explicit preset size, and it stretches a frame whose aspect ratio differs
from that size. A preset value `source` names the value of the one source: its frame size, its
frame rate (ADR 014), its sample rate and its channel layout (ADR 023).

Four methods can change the frame rate of a piece:

| Method                  | `ffmpeg`                             | Result                                                                    |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| Drop or repeat frames   | `fps`, rounding to the nearest frame | No new pictures. A higher output rate only repeats frames of a CFR source |
| Blend frames            | `framerate`                          | Smoother at ratios such as 25 to 30, with ghost images on motion          |
| Interpolate motion      | `minterpolate`, mode `mci`           | Slow, a few frames per second at 1080p, with warp artifacts               |
| Keep each piece's times | no `fps`, `-fps_mode passthrough`    | Exact, but a variable-frame-rate file that some players handle badly      |

The user chose the highest frame rate of the sources, with the first method. The user also
chose to scale each source to the size of the largest source, with a high-quality filter.

## Decision

### The request names the sources and the pieces

The export request carries a list of sources and a list of pieces:

- A source has an ID, a path and the revision that the user marked against (ADR 024), or null
  after "Export anyway".
- A piece has the ID of its source, `inPts` and `outPts`.

The pieces come in export order: each segment in array order, and the pieces of one segment in
sequence order (ADR 052). The backend does not know about clips or segments.

The limit of 100 segments in ADR 014 now counts pieces. In the shape with one input for each
segment, each piece is one chain and one input. The interface counts the pieces before the user
starts, so a message about `tooManySegments` can appear for fewer than 100 segments.

Preparation runs once for each source that a piece names: the revision check, the probe, the
audio correction, the FLV input and the gap read of ADR 014, ADR 046 and ADR 049. The plan then
times each piece with the probe of its own source: its video time base, its format start time,
its stream indices and its audio sample rate. The plan never compares a raw PTS of one source
with a raw PTS of another source (ADR 002).

### The command line

The fit step below makes each chain longer, and each extra source adds one input. The budget of
ADR 014 and ADR 046 was measured for one source with a short scale step. The export unit that
builds this record must measure the widest command again, for the encoder and for the audio
process of ADR 043, on the platform with the smallest command-line limit.

- When 100 pieces no longer fit, the unit lowers the limit of pieces to the largest count that
  fits. It records the measurement and the new limit in a dated note of ADR 014.
- A graph file is not the answer. ADR 014 found no form of a graph file that every supported
  `ffmpeg` reads (measurement 13).
- Today `choose_shape` returns the last shape when no shape fits, and no error exists for that
  case. With the measured limit, that case must not occur. A test must show this for the widest
  preset at the limit.

### One frame size for the output

The plan finds the display size of each source that a piece uses:

1. Start from the coded width and height.
2. Multiply the width by the SAR, when the SAR is known and is not 1. Round the result to the
   nearest whole pixel, and a half up. An unknown SAR counts as 1.
3. Swap the width and the height when the probe reports a rotation of 90 or 270 degrees.

The plan then picks the output size, called the canvas:

- The preset gives a size: the canvas is that size.
- The preset says `source`, and every source has the same coded size, the same SAR and the
  same rotation: no canvas. No chain scales, as today. With `source`, a single-source export
  stays as it is.
- The preset says `source`, and the sources differ: the canvas is the display size with the
  largest area. When two areas are equal, the source of the earlier piece wins. So a portrait
  clip of 1080x1920 before a landscape clip of 1920x1080 gives a portrait canvas. The setup step
  shows the canvas, and the user can choose a preset with a fixed size.

A canvas has even sides, because the 4:2:0 pixel formats need them and `pad` rounds an odd side
down. The plan rounds an odd side of a canvas down by one pixel, and a side of 1 up to 2. That
applies to a preset size too.

A piece whose display size is not the canvas, or whose SAR is not 1, gets a fit step. The plan
computes the fitted size with exact rationals:

1. Compare the display aspect ratio of the piece with the aspect ratio of the canvas. The display
   aspect ratio is exact: the coded width times the SAR, divided by the coded height, with the
   rotation applied. It is not the rounded display size. The side that limits the fit takes the
   size of the canvas on that side.
2. The other side is the exact value for the display aspect ratio, rounded to the nearest even
   number, and a tie up.
3. Each offset is half of the difference to the canvas, rounded down to an even number.

The fit step comes before `fps`, so it does not scale the frames that `fps` repeats:

```
trim=…,setpts=PTS-STARTPTS,
scale=<fw>:<fh>:flags=lanczos+accurate_rnd+full_chroma_int,setsar=1,pad=<W>:<H>:<x>:<y>,
fps=<rate>
```

- The plan computes `<fw>`, `<fh>`, `<x>` and `<y>`, so the chain does not depend on the scale
  options of one `ffmpeg` version.
- Lanczos is the high-quality scaler of every `ffmpeg` build. It needs no optional library.
- The padding is black, the default colour of `pad`.

An explicit preset size now uses the same fit step. Before this record it stretched the picture.
This is a change for a single-source export too.

A source with an odd side and no canvas still fails with a 4:2:0 pixel format, as today. This
record does not change that.

### One frame rate for the output

The preset value `source` for the frame rate now means the highest nominal frame rate among the
sources of the pieces. The nominal rate of a source is its `avg_frame_rate`, else its
`r_frame_rate`, as ADR 014 states. The plan compares the rates as exact rationals. A source with
no rate does not take part. When no source has a rate, the plan refuses the export with
`sourceFrameRateUnknown`, as today. An explicit preset rate still wins, and then no source needs
a rate.

Every video chain uses `fps` with that one rate. So `concat` always sees one rate, and the
fallback to 25 frames per second never applies.

With the highest rate, a constant-frame-rate source never loses a frame: the `fps` filter only
repeats frames of a slower source. A source with a variable frame rate can still lose a frame
where its frames come faster than its average rate. A 24 fps source in a 60 fps output repeats
its frames in a 3:2 pattern. That is what a 60 Hz screen shows for 24 fps video anyway. A source
of 29.97 fps in a 30 fps output repeats one frame about every 33 seconds.

The expected frame count of ADR 014 rounds each piece, as the plan does today: the sum, over the
pieces, of the duration of the piece multiplied by the output rate, each rounded on its own. That
product can end in exactly one half, for example an odd number of frames at 24 fps in a 60 fps
output, with one source or with several. The export unit must test that case with real `ffmpeg`,
because the end rounding of `fps` must then agree with the rounding of the count.

Frame blending and a variable-frame-rate mode stay possible later. Each one is a new value of the
timing enumeration of ADR 014. This record adds neither.

### One sample rate and one channel layout for the output

These rules apply only when the export writes audio. Below, "a source with an audio stream" is a
source of a piece that has an audio stream, with or without packets, as today.

- The export writes an audio stream when at least one source of the pieces has an audio stream.
  When none has one, the export writes no audio stream, and an audio-only export is refused with
  `sourceHasNoAudio`, as today. A single source whose audio stream holds no packets therefore
  still gets a silent audio track, as today.
- `source` for the sample rate means the highest sample rate among the sources with an audio
  stream. A source whose audio stream has no usable sample rate is refused with
  `sourceAudioRateUnknown`, as today.
- `source` for the channels means the channel layout of the source with the most channels, among
  the sources with an audio stream. When two counts are equal, the source of the earlier piece
  wins.
  - When all those sources have the same layout, no chain names a layout, as today.
  - Otherwise the final `aformat` of each audio chain names the chosen layout, so `concat` does
    not choose one. A layout with no plain name (`is_plain_layout_name` in the plan) gives the
    default layout for its channel count.
- A piece whose audio stream holds no packets gets the silence chain of ADR 014, as today, with
  its length in ticks of its own source rate.
- A piece whose source has no audio stream gets the same silence chain at the output rate and the
  output layout. Its length is the duration of the piece multiplied by the output sample rate,
  rounded to the nearest sample, and a half away from zero (ADR 002). The stand-in of ADR 043 for
  that piece counts in the same unit.

With one source, each rule gives the value of today.

The second process of ADR 043 keeps its shape. It runs when at least one piece reads audio from a
stream. The other pieces get their silence chains in that process, as a stream without packets
does today. It already builds one stand-in for each chain, and each piece is one chain.

### Audio copy needs one piece

ADR 048 copies the audio of an export of one segment. The condition is now one piece. A segment
that crosses a junction has two or more pieces, so its audio is encoded.

### The single-input shape

ADR 014 opens one input and splits it when the input-per-segment shape does not fit the command
line. With several sources, that shape opens one input for each source and splits each input into
the pieces of that source.

### What this record does not do

- It does not map high dynamic range (HDR) video to standard dynamic range (SDR). A mix of HDR
  and SDR sources gives wrong colours for one of them.
- It does not convert between colour matrices or ranges. A mix of BT.601 and BT.709 sources, or
  of full range and limited range, can give wrong colours for one of them.
- It does not handle a display matrix with a mirror or with an angle that is not a multiple of 90
  degrees. The probe rounds such an angle to the nearest quarter turn.

A later record can add a check and a conversion for each of these.

## Consequences

- `concat` always gets one frame size, one SAR and one frame rate.
- A single-source export with an explicit preset size gets black bars instead of a stretched
  picture. Its scaler changes from the default bicubic to Lanczos. An odd preset side loses one
  pixel.
- A source of 120 fps slow motion raises the whole output to 120 fps with the preset value
  `source`. The export setup step must show the rates that the plan found, so the user can choose
  a preset with a fixed rate.
- The export setup step shows the canvas, the rate and the audio format that the plan found
  (ADR 024).
- The preparation of an export of several sources takes longer, and its time limit grows with
  the number of sources (ADR 050).
- The tests of the graph, the plan and the argument list gain cases with several sources: two
  sizes, two rates, a rotated source, an anamorphic source, and a source without audio. A test
  with real `ffmpeg` checks the output size, the frame rate, the frame count and the audio length.
