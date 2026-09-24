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

### One current segment names the target of every edit

The timeline holds a `currentSegmentId`. Mark In, Mark Out, Split and Delete act on the segment
it names, and never on a segment inferred from the playhead position.

The reason is a fault the earlier model could not avoid. Split resolved to the first entry of the
array that contained the playhead, while the last such entry is the one painted on top, so with
overlapping segments Split cut a segment the user could not see. No rule for choosing between
overlapping segments fixes that. First-match and last-match are both guesses, and the user has no
way to tell which segment a guess will pick.

So the target is named rather than inferred, and overlapping segments become legal.

Mark In and Mark Out adjust the current segment's boundaries. **New Segment** (the interface now calls it Finish Segment) ends the current
segment, so the next Mark In starts a fresh one; the first segment of a session needs no press.
Clicking a segment on the timeline makes it current. **Delete Segment** removes it and leaves
nothing current, because selecting a neighbour automatically would make an unseen segment the
operand of the next Delete or Split, which is the ambiguity this rule removes.

While a current segment resolves for the active source, there is no pending In mark. The two
fields describe the same thing — the segment being built — so they never both hold a value.

A split leaves the left half current. It already keeps the segment's identifier, so a split
touches no selection field and undo restores the same target with no special case. The right half
is the one under the playhead, so making it current would move the target under the operand the
user just used.

`currentSegmentId` restores through undo and redo only while the restored array still holds that
segment and it belongs to the active source. That rule is keyed on the source alone and not on
the source revision, unlike the pending In mark: segments survive a revision change and a pending
timestamp does not.

Clicking a segment selects it and does not seek. The playhead is the operand of every edit
action, so a selection click that moved it would reintroduce the surprise this rule removes. The
ruler is the click-to-seek surface.

### Zoom and pan are view state

The zoom factor of the timeline is view state. It never enters the timeline store, the
undo and redo stacks, or the project file. A factor of 1 fits the whole source extent in
the panel. A larger factor makes the lane wider than the panel, and the panel scrolls
horizontally. The factor returns to 1 when the active source changes.

Two bounds apply. The lane is never narrower than the panel, so the minimum is 1. The
maximum is the smaller of a ceiling on lane pixels and a ceiling on pixels for each second
of source. An indeterminate source extent gives a maximum of 1, so a lane with no time axis
cannot zoom, and the panel does not take the wheel gesture away from the page.

Zoom changes the CSS width of the lane. It does not change the time axis. Every layout
value stays a percentage of the source extent, so the layout helpers do not change, and the
two inverse maps read the lane rectangle at the time of the event, so they do not change
either.

The ruler lane and the track lane must always span the same rectangle. Both are
click-to-seek surfaces, and this record requires one coordinate to map to one time. One
width on the element that holds both rows makes that true by construction, and not by
agreement between two pieces of code. A later viewport model must keep that property.

The wheel zooms, and it holds the time under the pointer in place. A gesture that is
clearly horizontal pans instead, and so does the shift key with the wheel. The panel gives
those gestures to the web view, which already scrolls the container.

### The edges of a segment

(Added on 2026-09-24.) On a segment at least 24 px wide, the 6 px at each end is its own
control area, the edge. A pointer click on the In edge selects the segment and seeks to its
stored `inPts`. A pointer click on the Out edge selects the segment and seeks to its stored
`outPts`, the first frame after the segment. The seek has the condition of Shift+I and
Shift+O (ADR 026). A click on the body, and a click from the keyboard or from assistive
technology, only selects. A press and a drag on an edge do nothing more than a click, until a
later record adds drag trimming. The edge is not a Tab stop, and the hit area of the
playhead stays above the edges. No edit value comes from the pixel position of an edge.

## Consequences

- The user can see each segment in its original source context.
- The source ruler is not an output timeline.
- Project order and source position remain separate concepts.
- Runtime caches cannot leak through generic object serialization.
- A separate ordered list can support future cross-source reordering.
- Zoom and pan need no change to the project file, the timeline store, or the layout
  math.
- A change to the way the lane takes its width must keep the two seek rectangles equal.
