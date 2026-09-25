# 030. Trim a segment edge by dragging it, and commit the frame that the browser shows

- Status: Accepted
- Date: 2026-09-24
- Deciders: capric98
- Amends: ADR 007

## Context

ADR 007 gives each segment an edge area at each end. A click on an edge seeks to the stored
boundary, and a drag on it does nothing. To move a boundary, the user must seek to the new
frame and press Mark In or Mark Out. Premiere Pro, DaVinci Resolve and Final Cut Pro let the
user drag the edge of a clip to trim it. The user asked for drag trimming after the click
version.

A drag gives pixel positions. ADR 002 and ADR 003 forbid an edit boundary that comes from a
pixel position or from an approximate clock. A boundary must be the PTS of a frame that the
browser presented, or a PTS that the project already stores.

## Decision

A drag on an edge trims that edge. The drag moves the playhead as a scrub does, and the
release commits the frame that the browser presents at the end of the drag.

### During the drag

1. The press on an edge selects the segment and starts a trim of that edge. The trim needs
   the condition of Mark In and Mark Out: an active source and a ready calibration. Without
   it, the press does what a click does.
2. Each pointer move sends a scrub seek, with the rules of ADR 022. The playhead follows the
   pointer. The snap of ADR 022 applies: the pointer snaps to the other boundaries of the
   active source, to the pending In, and to the playhead position at the start of the drag.
   A snap seeks to the stored PTS of its target.
3. The auto-scroll of ADR 022 applies at the edges of the view.
4. A preview of the new edge follows the display target of the playhead. The stored segment
   does not change during the drag, and no history entry is made.
5. The trim cannot cross the other edge of the same segment. The In edge stops one nominal
   frame before the Out, and the Out edge stops one nominal frame after the In. The limit
   applies to the seek target, so the browser never presents a frame outside it.
6. `Escape` cancels the trim. The segment keeps its boundaries, and the playhead returns to
   the position that it had at the start of the drag.

### At the release

1. The release sends the exact seek of ADR 022 for the last target, or no seek when the last
   target was a snap that the element already shows.
2. The trim waits for the frame callback that answers that seek. It then writes the PTS of
   `presentedFrame`: `inPts` for the In edge, `outPts` for the Out edge. The write is one
   history entry, so one undo restores the old boundary.
3. A seek onto the frame already on screen can bring no frame callback (ADR 022). When the
   target is on screen and no seek is pending, the trim writes the PTS of the frame on screen
   at once.
4. A snap to a stored boundary writes that stored PTS, because it is already an exact
   boundary.
5. The write must keep `inPts < outPts`. A result that breaks this makes no change and no
   history entry.
6. If the calibration becomes unavailable before the frame arrives, or the source changes,
   the trim is dropped and makes no change.

### What does not change

- Overlap with a neighbouring segment stays allowed, as ADR 007 allows it. The export order
  is the order of the segment array.
- The keyboard path to a boundary stays Shift+I and Shift+O, then Mark In or Mark Out.
- A click on an edge, with no movement past the drag threshold, still only seeks, as ADR 007
  says.

### What the implementation settled

(Changed on 2026-09-24.) Review of the first implementation changed these points.

- **The frame grid.** A drag trim needs an exact frame grid: a ready calibration, a constant
  rate and a time base fine enough for a real frame start to round to its own frame (ADR 022).
  On any other source, such as a variable-rate source or a coarse time base, a press on an
  edge is the click of ADR 007, and the user moves a boundary with Mark In and Mark Out. Off
  the grid, only the timing of the browser events could tell which frame answers the release
  seek, and WebView2 presents that frame before it sends `seeked`, so that rule is not
  reliable.
- **The committed frame.** `J` is the ADR 028 index of the release target, kept inside the
  limit. If the frame on screen is `J`, its PTS is written at once. Otherwise the release
  calls `seekToFrameIndex(J)`, and the first frame on screen that is `J` is written. A frame
  with any other index is never written. A later request for another target drops the trim.
- **The end of the source.** An Out edge dragged to the end stops on the last frame of the
  extent, the same result as Mark Out on the last frame. (Changed on 2026-09-24.) When the
  probe gives the video duration in ticks, the last frame is the frame that End goes to
  (ADR 026): the last nominal frame whose start lies more than the margin of ADR 028 inside
  that extent. When the probe gives no video duration in ticks, the extent comes from the
  container duration, and the last frame is that extent rounded to the nearest frame, minus
  one. A container duration usually ends a few milliseconds after the last video frame,
  because the audio runs longer, and the rounding allows up to half a frame of that. It can
  still pass the last video frame by more. An Out trim to the very end of such a source can
  then fail with the notice below, and End followed by Mark Out is the path to that boundary.
  A container duration can also end before the last frame. The cap for an Out edge is
  therefore never earlier than the frame of its stored Out, which the browser already
  showed, so a drag never moves a stored Out back by itself. When the reported extent ends at
  the start of the real last frame, or within one tick of it, the cap is the frame before,
  as End is (ADR 026). A stored Out on the real last frame then keeps the cap there, but a
  release that must seek to it can stop one frame early and fail with the notice.
- **The snaps.** The press selects the segment, and a selection clears the pending In (ADR
  007), so the pending In is not a snap target. The snap targets are the other boundaries of
  the active source and the playhead at the start of the drag. A stored boundary writes its
  PTS, and the release seeks with `seekToFrameIndex` to the frame of that boundary. The start
  playhead is the frame on screen only when no seek was pending; it then writes its PTS. When
  a seek was pending, it is only a seek target, and the trim commits its frame `J` as above.
- **Escape** returns through `seekToFrameIndex` to the frame of the start playhead.
- (Added on 2026-09-24.) **A secondary press** on an edge, and a Control press on macOS,
  opens the context menu of the segment (ADR 007) and never starts a trim.
- **A trim that cannot finish.** If no frame `J` arrives within 3 seconds of visible time
  after the release, counted as the anchor wait of ADR 003 counts it, or if the calibration,
  the source or the segment changes before it arrives, the trim is dropped, and a short
  notice says "The trim was not applied." Escape and a cancel by the browser drop the trim
  with no notice. While a trim drags, Mark In, Mark Out, Delete, Undo and Redo do nothing,
  and Escape cancels the trim instead of finishing the segment (ADR 026).

## Consequences

- A boundary always comes from a presented frame or from a stored boundary, never from a
  pixel position.
- The commit of a trim can wait for one decoder answer after the release. The preview of the
  edge shows the target in the meantime.
- The edge area gets the resize cursor again.
- One trim is one undo step.
