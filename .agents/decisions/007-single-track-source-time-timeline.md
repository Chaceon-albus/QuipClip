# 007. Show one source-PTS timeline and keep ordered half-open segments

- Status: Accepted
- Date: 2026-08-31
- Deciders: capric98

## Context

The user marks several source intervals. QuipClip joins those intervals in project order.
The source file stays unchanged.

The project needs durable source metadata and temporary playback state. Proxy paths,
browser object URLs, and calibration state depend on one machine and one application run.
They must not enter a project file.

## Decision

Use one timeline whose horizontal axis is the active source's elapsed presentation time.
The segments for that source appear on the axis. The timeline can zoom and pan.

Each segment stores `sourceId`, inclusive `inPts`, and exclusive `outPts`. The project
segment array is the authoritative export order. `activeSourceId` is persisted and selects
the source shown on the ruler.

For the current one-source UI, timeline operations compare boundaries only within that
source. A future multi-source UI must not sort segments by raw PTS. It must preserve array
order.

Split at an inferred PTS `p` creates `[inPts, p)` and `[p, outPts)`. The split point must
be strictly inside the segment. Mark Out uses the current inferred PTS as the first
excluded frame. Exact inclusion of the final source frame needs discovery of its following
boundary.

The ruler uses source extent in this order:

1. Use `videoDurationTicks` with `videoTimeBase` when it exists.
2. Otherwise, use finite, non-negative persisted `approximateDurationSeconds`.
3. Otherwise, use a finite runtime `HTMLMediaElement.duration`.
4. Otherwise, show an indeterminate ruler and disable absolute click-to-seek.

Approximate extent can control layout and a browser seek request. It cannot create a
canonical edit boundary. An invalid approximate duration is unavailable and falls through
to the next source in the list.

The project stores `PersistedSource` objects. The runtime uses `Source` objects that can
also contain a proxy and other temporary state. Serialization must call an explicit
`toPersistedSource` projection for each runtime source. The projection constructs a new
object and lists every persisted field. TypeScript's `never` fields and structural typing
are not serialization controls.

For future multi-source output positions, calculate each segment duration with `BigInt`
and its source time base. Accumulate exact rationals or rescale exactly to a runtime common
time base. Convert to floating-point only for browser APIs and pixel layout. Do not persist
the common time base or segment timeline starts.

Multi-track editing remains out of scope.

## Consequences

- The user can see each segment in its original source context.
- The source ruler is not an output timeline.
- Project order and source position remain separate concepts.
- Runtime caches cannot leak through generic object serialization.
- A separate ordered list can support future cross-source reordering.
