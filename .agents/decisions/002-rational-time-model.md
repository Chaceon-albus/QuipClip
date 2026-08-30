# 002. Represent all edit time as rationals on an integer frame grid

- Status: Accepted
- Date: 2026-08-29
- Deciders: capric98

## Context

The user must step one frame at a time. The exported file must start and end on the frames
the preview showed. Frame rates are frequently not integers. NTSC video runs at 30000/1001
frames per second, which is 29.97002997... in decimal.

A 64-bit float can hold a timeline of this length without visible drift. Measurement shows
that 107 892 additions of `1001.0/30000.0`, which is one hour at that rate, produce an
error near 1.9e-9 seconds. That is 5.6e-8 of one frame. Accumulated float error is
therefore not the problem.

The real problems are these:

1. **Equality and ordering.** Two float values that name the same frame can compare
   unequal. An edit point is a key in a set and a sort key in a list, so it must compare
   exactly.
2. **The boundary is ambiguous.** The instant `k/fps` belongs to frame `k` and touches
   frame `k-1`. A float time gives no rule for which frame the user marked.
3. **Two languages must agree.** Rust and TypeScript both build strings that reach ffmpeg.
   Integer frame indices produce the same string on both sides. Float formatting does not.
4. **ffmpeg speaks rationals.** ffmpeg holds time in `AVRational`. A rational on our side
   converts with no rounding step.

## Decision

Define one canonical time type on both sides of the application.

```rust
pub struct Rational { num: i64, den: i64 }           // Rust
```

```ts
type Rational = { n: number; d: number };            // TypeScript
```

**The JSON wire format is `{"n": ..., "d": ...}`.** Rust serializes an already valid
`Rational` through a private wire type. Rust deserializes through a validated conversion.
The conversion rejects a zero denominator. It also reduces the fraction and moves the sign
to the numerator. TypeScript shares the `n` and `d` field names. Its structural type does
not validate an arbitrary object. TypeScript parsers must validate external values before
they create a `Rational`. This wire contract is part of the decision. A change to it breaks
every Tauri command that carries a time.

Rules:

1. A **project timebase** holds the output frame rate as a rational. On the first import it
   copies `avg_frame_rate` from ffprobe. The user can change it.
2. Every edit point is an **integer frame index** on the project frame grid. No edit point
   is stored in seconds.
3. **Out points are exclusive.** A segment `[in, out)` holds `out - in` frames.
4. The code converts a frame index to seconds only at a boundary. Rust computes
   `frame * den / num` as an exact rational and formats a fixed-precision decimal for
   ffmpeg. The frontend evaluates the same formula as a JavaScript number for
   `video.currentTime`, because the DOM API requires a number.
5. Rational arithmetic runs in `i128` and returns `None` on overflow. It never panics.
   Comparison uses cross-multiplication, not `to_f64`.
6. A rational can be zero or negative. A frame rate cannot. A Rust frame-rate operation
   returns `None` for a non-positive rate. A TypeScript frame-rate function throws
   `RangeError` for a non-positive rate. `parseFrameRate` returns `null` for that input.

**Timecode is non-drop-frame.** The display format is `HH:MM:SS:FF`, and `FF` counts
`ceil(fps)` frames per second. At 30000/1001 that means `FF` runs from 00 to 29. A
non-drop-frame label drifts from wall-clock time by about 3.6 seconds per hour. QuipClip
accepts that drift, because the label names a frame and does not claim to name a clock
time. Drop-frame timecode, which uses a `;` separator, is a broadcast convention that this
product does not need.

**Variable frame rate** sources have no single frame grid. If ffprobe reports
`avg_frame_rate != r_frame_rate`, mark the source as VFR. Version 1 treats it as constant
at `avg_frame_rate`. See ADR 003 and ADR 004 for how a proxy makes such a source exact.

## Consequences

- Frame arithmetic is integer arithmetic. Equality, ordering, and hashing are exact.
- Unit tests must cover the 30000/1001 timebase on both sides.
- The exclusive out point must appear in every doc comment and every user-facing label. A
  reader who assumes an inclusive out point writes an off-by-one error.
- The `{n, d}` wire shape is a contract between two languages. A test must hold it.
- Rust fields are private. Constructors and deserialization must preserve the normalized
  representation.
- A non-drop-frame label is not a clock time. The user interface must not present it as one.
