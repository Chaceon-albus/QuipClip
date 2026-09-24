# 022. Draw the playhead at the seek target, and run one seek at a time

- Status: Accepted
- Date: 2026-09-22
- Deciders: capric98
- Amends: ADR 019

## Context

The user reported two faults in the timeline.

1. The playhead does not follow a seek at once. A click on the ruler calls `seekToPts` or
   `seekApproximate` in `src/features/playback/store.ts`. The action assigns
   `currentTime` and sets `presentedFrame` to null. ADR 003 forbids an optimistic inferred
   PTS, so the store then waits for `requestVideoFrameCallback`. While it waits,
   `TimelinePanel` draws the playhead from the approximate clock, and that clock still
   holds the old position. The playhead moves only after the video presents the new
   frame. The position that the user sees therefore depends on the decoder.
2. The user cannot drag the playhead. The ruler and the track surface have only a click
   handler.

A drag gives a fast series of seek requests. A media element stops a seek that is not
complete when it receives a new `currentTime`. If each pointer move assigns
`currentTime`, no seek completes, and the picture does not change until the user releases
the pointer.

Premiere and similar editors separate two things. The playhead follows the pointer at
once. The picture samples that position as fast as the decoder permits. The user always
sees where the seek goes, even when the picture is late.

## Decision

### A display target that is not an edit position

The playback store gets one new public field, `seekTargetSeconds`. It holds the position
of the last seek request, in seconds from the start of the source. That is the same axis
as the ruler and the approximate clock.

Each seek action sets the field when it accepts a request: `seekToPts`,
`seekApproximate` and `seekNominal`. The timeline and the preview timecode draw this
field before all other positions. The order is:

1. `seekTargetSeconds`, when it is set.
2. The inferred PTS of `presentedFrame`, when calibration is `ready`.
3. The approximate clock.

The field is for display only. It is never an edit position. `canMarkIn`, `canMarkOut`
and `canSplitCurrentSegment` read their PTS from `presentedFrame` only, and they do not
read this field. Each seek action still sets `presentedFrame` to null. The edit actions
therefore stay disabled until RVFC reports the frame that the browser presented. This is
the ADR 003 rule. This decision does not change it.

The store clears the field when the seek settles:

- In the `ready` state, it clears the field on the first RVFC callback that arrives while
  the element is not seeking and no seek is queued. It does not clear the field on the
  `seeked` event. After a queued seek starts, an RVFC callback for an intermediate frame
  can still arrive, and a cleared field would move the playhead back.
- In all other states, it clears the field on the `seeked` event when no seek is queued.
  The same event updates the approximate clock.
- A scrub seek (see below) that settles does not clear the field. `fastSeek` lands on a
  keyframe, not on the target, and a cleared field would move the playhead from the
  pointer to that keyframe. The field is cleared when the exact seek at the end of the drag
  settles.
- `attach`, `detach`, `reset`, `syncUnready` and each failed seek clear the field.

### One seek at a time, and the latest request wins

The store runs one element seek at a time. When a request arrives and the element reports
`seeking`, the store does not assign `currentTime`. It keeps the request as the queued
seek, and it replaces any older queued seek. The `seeked` event starts the queued seek.
`play` starts a queued seek as an exact seek before it plays, so playback starts at the
last target and not at a keyframe.

Each seek that starts also completes. The picture therefore changes during a drag, at the
speed of the decoder.

`seekNominal` calculates its step from the queued target when one exists, and from
`currentTime` when none exists. A held arrow key therefore continues from the last
request.

(Changed on 2026-09-23.) On the frame grid, the step aims at the middle of the target
nominal frame, not at its nominal start. Containers such as Matroska store each PTS rounded
to the millisecond, so a real frame can start after its nominal start. A target on the
nominal start then lies before the real frame, and the browser shows the old frame again.
A simulation of Matroska files found that repeat in about 37% of steps at 29.97 fps and in
about 70% at 23.976 and 59.94 fps.

- **When the grid applies.** All three conditions must hold:
  - The calibration is ready, so the first video frame is known.
  - The rate is constant: the average and the real frame rate agree, by the test that ADR
    028 uses. On a variable-rate source the nominal grid does not follow the frames.
  - The grid is exact for the time base: the margin of ADR 028 is one tick or 1 µs, not a
    quarter of the interval. On a coarse time base, such as 1/24 at 23.976 fps, a real frame
    start can lie most of a frame away from its nominal start.
- **The frame the step starts from.** When no seek is pending, no display target is set and
  a frame is on screen, the step starts from the frame on screen. That is the presented
  frame's time, measured from the calibrated first frame, times the rate, rounded to the
  nearest whole frame. On the grid a real frame start lies within one tick of its nominal
  start, so the rounding is exact. Otherwise, when a seek is pending, a display target is
  set, or no frame is on screen, the step counts from the pending target, or else from
  `currentTime`, rounded down after the margin of ADR 028. The pending target of an earlier
  step is the middle of a frame, so repeated steps advance by exactly one frame each.
- **What the display shows.** The element seeks to the middle of the target frame. The
  playhead and the timecode show the nominal start of that frame, so the playhead does not
  jump back by half a frame when the frame arrives. A target that the end bound pulled back
  shows the nominal start of the frame that contains it. A target that the lower bound
  raised shows its time. While a calibration holds, on the grid or off it, the display
  target of a step counts from the calibrated first frame. `seekApproximate`, and a step
  without a calibration, still count from the start of the browser timeline.
- **The audio cue.** ADR 019 plays the cue from the same target as the element, so a step on
  the grid starts its cue at the middle of the frame, about half a frame later than before.
- **The direction of a step.** A step that starts outside the bounds never moves against its
  direction. Inside the bounds, a step from the frame on screen can aim behind `currentTime`
  during playback, when the element has run past the frame that it last reported. The step
  then goes to the frame next to the one on screen, which is the frame that the user sees.
- **Off the grid.** The step keeps the relative target: the position it steps from plus the
  step count times the frame interval. The edge no-op then tests the position only.
- **The edges.** The clamps and the edge no-op still apply to the result. On the grid, a
  clamped target that stays inside the start frame also counts as the edge. (Changed on
  2026-09-24.) When the probe gives the extent in ticks, a forward step on the grid that the
  end bound clamped is also the edge when it starts at the last frame of the extent (ADR 026)
  or later, and the display of a clamped step shows that frame at most.
- **Calibration lost during a step.** If the calibration leaves `ready` while a display
  target is set, the target moves to the axis of the browser timeline: the last accepted
  request, measured from the timeline start. After `play` there is no such request, so the
  target stays until the next `seeked` event or frame callback clears it.

On a coarse time base or a variable-rate source, the step keeps the relative target, and
the picture and the frame label can still repeat or skip a frame, as they did before this
change. Such sources are rare.

This supersedes two statements of ADR 021: that the step reads `currentTime` and adds one
nominal frame interval, and that calibration never enters that path. The step now reads the
calibration to choose the grid. ADR 021 still lets the step keys and buttons act without a
calibrated source. It also qualifies the axis that the section above gives for
`seekTargetSeconds`: while a calibration holds, the display target of a step counts from the
calibrated first frame, not from the start of the browser timeline.

A scrub seek that already started also counts as the pending target while it is the last
accepted request, because its `fastSeek` can land on a keyframe away from the target. `play`
then assigns its time as an exact seek, and `seekNominal` calculates its step from it.

### Navigation while the calibration is open

(Added on 2026-09-24.) While calibration is `calibrating`, `seekNominal`, `seekApproximate`
and `seekToPts` do not move the element (ADR 003). The store keeps one deferred request.
The flag `hasDeferredNavigation` is true while a request waits, and it is never true
outside `calibrating`.

- **Accepting a request.** A deferred request counts as accepted. It pauses the element as
  a seek does, sets `seekTargetSeconds` as its action would, keeps `presentedFrame` null,
  and requests no cue. A `seeked` event does not clear its target.
- **The latest seek wins.** `seekApproximate` and `seekToPts` replace the deferred request.
- **Steps add up.** `seekNominal` adds its frames to the deferred request, counted from the
  deferred seek or from the position of the element, one frame for each press as ADR 021
  requires. The count stays between the first frame and the frame that contains the end. A
  press past either end changes nothing and only pauses. (Changed on 2026-09-24.) When the
  probe gives the extent in ticks, the upper limit is the last frame of the extent (ADR 026),
  as it is after the anchor.
- **A frame index.** `seekToFrameIndex` defers as a seek to the first frame followed by that
  many steps.
- **When calibration becomes ready.** The request runs through the ordinary actions.
  - A ruler position becomes a `seekToPts` of the same elapsed time, with the rounding of
    the ruler, so the playhead does not move when the seek runs. A seek that carries
    `keepBrowserTimeline` stays a browser-time seek. (Changed on 2026-09-24.) The keyboard
    gives this option only to End on the approximate clock, on a source whose probe gives no
    extent in ticks (ADR 026). End then lands where it lands after the anchor.
  - A seek to the anchor frame is dropped, because that frame is on screen: a PTS at or
    before `videoStartPts`, or on the frame grid a target inside the first frame.
  - A seek followed by steps gives the element one seek. The seek target becomes the
    pending target, and one `seekNominal` with the net count replaces it.
- **When calibration becomes unavailable.** The request runs on the approximate clock. A
  PTS goes to its elapsed seconds, and then the steps run.
- **What drops it.** Attach, detach, reset, a loss of readiness, a failed seek, `play` and
  a play that the element starts by itself. `play` then plays from where the element
  stands, because a seek before the anchor would spoil the calibration.
- **The display of a deferred step** assumes the frame grid. If the calibration fails
  instead, the playhead moves by less than one frame when the step runs.

(Added on 2026-09-24.) `seekToPts` takes the option `{ extentEnd: true }`. Only End off the
frame grid gives it, and its target is then the last tick of the extent (ADR 026). With this
option, the seek does nothing when all of these conditions are true:

- The calibration is ready.
- The element does not play.
- A frame is on screen.
- No seek is pending: there is no display target, no queued seek and no scrub target, and
  the element does not report `seeking`.
- The element stands at or after the target, or at or after the duration that the element
  reports when that is earlier, within 1 µs.

The frame that holds the last tick also holds every later position, so the frame on screen
is that frame, and a seek to it may bring no frame callback. The element never stands after
its duration, and a seek past it stops there, so the duration is the latest position that
the seek can reach. The test reads the position only, as the edge no-op off the grid does.
The option changes no other seek. A request that the store defers during the calibration
runs without the option, because at the anchor the element stands on the first frame.

### Scrub mode: keyframes and sound during a drag

`seekToPts` and `seekApproximate` take the option `{ scrub: true }`. The timeline sets it
for each sample during the move of a drag. It clears it for the seek at pointer down and
for the seek at release. A click is therefore one exact seek, and it never goes through
scrub mode. A drag is an exact seek at pointer down, scrub seeks during the move, and an
exact seek at release.

A scrub seek uses `HTMLMediaElement.fastSeek` when the element has it. `fastSeek` goes to
a nearby keyframe, so a long-GOP source shows more pictures during a drag. WKWebView has
`fastSeek`. WebView2 does not, and a scrub seek there assigns `currentTime`. The final
seek always assigns `currentTime`, so the drag ends on the exact frame. The store never
drops an exact seek because a scrub seek to the same time came before it: the scrub seek
went to a keyframe, not to that time.

A scrub seek plays a burst through the ADR 019 controller. The store requests the burst
when the seek starts, and not when it queues the seek. The sound therefore has the same
cadence as the picture. The direction is the sign of the move from the last burst target,
or from the last exact seek when that came later. The exact seek at pointer down is
therefore the start point of the first burst of a drag. The store makes no request for a
zero move. It also drops a scrub request that repeats the time of the last accepted
request. The continuation rule of ADR 019 makes a slow
forward drag sound continuous.

This amends ADR 019. ADR 019 makes `seekNominal` the only action that requests a burst,
and it makes `seekToPts` and `seekApproximate` stop a burst. After this decision, both
actions request a burst in scrub mode. An exact seek, from a click or from the end of a
drag, still stops the burst.

### The pointer gesture

A primary-button pointer down on the ruler or on the uncovered track starts a gesture, and
the surface captures the pointer. The gesture sends at most one sample for each animation
frame. A move counts only after the pointer is 3 CSS pixels or more from the pointer-down
position. A click with a small jitter is therefore still one exact seek. The playhead in the track row has a narrow hit area above the segments, so the user
can drag the playhead also when it is over a segment. A segment button keeps its click, and
a click on it selects the segment without a seek.

A drag that the browser cancels, or that ends because seeking stops being possible, sends
one exact seek at the last pointer position. A drag therefore never ends on a keyframe.

(Changed on 2026-09-24.) The drag has three aids.

- **Snap.** A scrub sample, and the release or cancel of a drag, snaps to a boundary within
  6 px of the pointer: the In and Out of each segment of the active source, and the pending
  In. Only a boundary inside the visible lane and inside the source extent can snap. The
  nearest boundary wins, and a tie goes to the direction of the drag. A snap seeks with
  `seekToPts` to the stored PTS of the boundary, never to a PTS from the pointer position,
  and only while the calibration is ready. The seek at pointer down of a click never snaps.
  Holding `Alt` (`Option` on macOS) turns the snap off. A read-only listener on the window
  follows that key in the capture phase. It never cancels the event, so the one keyboard
  layer of ADR 021 stays the only owner of key presses. A change of `Alt`, of the segments,
  of the pending In or of the calibration takes a new sample at once. A line and a diamond
  show the snap while the playhead is drawn on the boundary.
- **Auto-scroll.** Within 24 px of either edge of the visible lane, or past it, the view
  scrolls. It starts only after the drag enters that zone, or after it moves toward the edge
  inside the zone where it started. The speed grows with the distance past the start of the
  zone, up to a cap. Each step writes `scrollLeft`, reads the kept value back, and takes a
  sample at the pointer position clamped to the visible lane, so the playhead stays at the
  edge. The lane ends at its true, fractional edge, so a drag can reach the exact start and
  end of the source at any display scale. The follow of the playhead does not page while a
  gesture runs.
- **Hover line.** Over the ruler and the track, a thin line and an approximate time, marked
  with ≈, follow the pointer when no drag runs. They are a display only. They are never a
  seek target or an edit position.

A blur of the window also cancels a drag, with one exact seek at the last clamped and snapped
target. The cancel and the release use the same snap as the last sample, so a drag ends
where the indicator showed.

## Consequences

- The playhead moves in the same frame as the click or the pointer move, on every
  platform.
- The picture changes during a drag. On macOS it shows keyframes. On Windows it shows
  exact frames at a lower rate.
- The preview timecode shows the target while a seek is pending. It then shows the time
  of the presented frame, which can differ from the target by less than one frame.
- The edit actions keep the ADR 003 behaviour. They are disabled while a seek is pending,
  and a mark always writes the PTS of the presented frame.
- A seek that lands on the frame that is already on screen may not cause an RVFC
  callback. In the `ready` state the target then stays until the next presented frame.
  The `presentedFrame` can be null or not null in that condition:
  - It is null when no frame arrived after the last request. The edit actions then stay
    disabled, as they did before this decision.
  - It is not null when an RVFC callback for an earlier seek arrived while the last seek
    ran. The last seek then landed on that same frame. The edit actions are enabled, and a
    mark writes the PTS of that frame, which is the frame on screen. The timecode shows the
    target, and the target is less than one frame from that frame.
- During a drag on macOS, `presentedFrame` holds a keyframe while the target holds the
  pointer position. The two can be a whole GOP apart. The exact seek at release ends that
  state.
- The `seeked` event can run after a newer seek started. `syncSeeked` therefore does
  nothing while the element reports `seeking`. The `seeked` event of the running seek
  starts the queued seek.
- A drag during playback pauses it. The playback stays paused after the release.
- The timeline does not scroll when a drag goes past the visible edge. That is a possible
  later step. (Changed on 2026-09-24: the auto-scroll above does this now.)
- The pending In region follows the same displayed position as the playhead: the seek
  target first, then the presented frame. This is a display only. Mark Out and every
  other edit action still read `presentedFrame`. (Changed on 2026-09-23. Before that,
  the region followed `presentedFrame`. Each seek sets `presentedFrame` to null until
  the next frame callback, so the region disappeared on every click and frame step, and
  it flickered while an arrow key was held.)
