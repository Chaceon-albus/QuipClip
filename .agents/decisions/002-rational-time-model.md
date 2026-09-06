# 002. Store edit points as source video presentation timestamps

- Status: Accepted
- Date: 2026-08-31
- Deciders: capric98

## Context

The old model stored edit points as integer indices on a synthetic frame grid. It built
that grid from `avg_frame_rate`. This model cannot represent the actual presentation times
of variable-frame-rate video. It also does not match FFmpeg's timestamp model.

Each video stream has a `time_base`. A presentation timestamp, or PTS, is an integer in
that time base. A source can start at a positive or negative PTS. Two sources can use
different time bases and unrelated PTS origins.

JavaScript cannot represent every signed 64-bit integer as a `number`. The project format
and the Tauri interface must not lose timestamp precision.

## Decision

Store each edit boundary as a source video PTS. The boundary belongs to the video stream
named by the segment's `sourceId`.

```rust
pub struct Pts(i64);
pub struct TickCount(i64);
```

```ts
type Pts = string & { readonly __brand: "Pts" }
type TickCount = string & { readonly __brand: "TickCount" }
```

The JSON representation is a canonical decimal string. `Pts` accepts the full signed
`i64` range. `TickCount` accepts the non-negative `i64` range. Parsers reject whitespace,
leading plus signs, non-decimal text, and values outside these ranges.

Each persisted source stores this timing metadata:

- `videoTimeBase`, as the rational number of seconds per video tick
- `videoStartPts`, which can be null when ffprobe does not report `start_pts`
- `videoDurationTicks`, which can be null when ffprobe does not report `duration_ts`
- `approximateDurationSeconds`, for UI layout and browser seek estimates only
- optional reported frame-rate and frame-count metadata

`videoDurationTicks` describes the reported source extent. It is not an edit boundary. It
does not identify the end of the final presented frame.

`approximateDurationSeconds` must be finite and non-negative when it exists. An invalid
value is unavailable metadata. It cannot affect canonical project state.

A segment is a half-open source interval `[inPts, outPts)`. `inPts` is inclusive.
`outPts` is the PTS of the first excluded presented frame. A valid segment has
`inPts < outPts`.

The exact segment duration is `(outPts - inPts) * videoTimeBase`.

QuipClip uses `BigInt` and exact rational arithmetic for internal duration calculations.
It can instead rescale values to a runtime common time base when the rescaling is exact.
QuipClip converts exact values to floating-point seconds only at browser and UI
boundaries. It does not persist a project time base or timeline start.

Raw PTS values from different sources are not comparable. Code must first apply each
source's time base and compare exact durations or elapsed times.

V1 precise editing requires separately editable presented frames to have distinguishable
presentation timestamps. QuipClip does not add a frame ordinal to disambiguate equal PTS
values.

Every conversion that rounds a time value breaks a tie away from zero. `round(-0.5)` is
`-1` and `round(0.5)` is `1`. Both languages follow this one rule. TypeScript must not use
`Math.round` on a value that can be negative, because the ECMAScript specification breaks
that tie toward positive infinity, and an inferred PTS behind the calibration anchor is
negative. A tie that rounds two ways gives a different edit point for the same distance
forward and backward.

All conversions between browser numbers and PTS ticks use checked helpers. A conversion
rejects non-finite input and output. A number-to-tick conversion also rejects an unsafe
integer result. A tick-to-number conversion subtracts the source origin with `BigInt`
before it checks the safe-integer range. It also rejects a result that is not a valid media
element time. An approximate conversion cannot create project state.

The project keeps output frame rate in `renderSettings.frameRate`. This rate is a render
setting. It does not define edit positions.

## Consequences

- VFR edit boundaries preserve the source stream's presentation timing.
- The project and Tauri interface carry timestamps without JavaScript integer loss.
- Split at PTS `p` produces adjacent intervals `[inPts, p)` and `[p, outPts)`.
- Exact inclusion of the final source frame needs discovery of its following boundary.
- Frame-rate metadata can support diagnostics and nominal navigation only.
- Tests must cover signed `i64` PTS values, checked browser conversions, and time bases
  that differ between sources.
