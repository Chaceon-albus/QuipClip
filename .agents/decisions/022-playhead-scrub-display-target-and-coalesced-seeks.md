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
  the element is not seeking and no seek is queued. After a queued seek starts, an RVFC
  callback for an intermediate frame can still arrive, and a cleared field would move the
  playhead back. (Changed on 2026-09-24. Before, the `ready` state never cleared the field
  on the `seeked` event.) The `seeked` event also clears the field when no seek is queued,
  the last seek was not a scrub seek, no navigation is deferred, and the frame of
  `presentedFrame` holds the position of the element. The HTML specification does not
  order the frame callback of a seek against the end of that seek, so the only callback of
  a paused seek can arrive while the element still reports `seeking`. That callback sets
  `presentedFrame` and keeps the field, and a paused element may present no later frame.
  The frame holds the position when it starts no more than 2 µs after the position, and:
  - on the frame grid, its ADR 028 index is the index of the position by the rule of the
    frame step, with 2 µs more margin, or it is the last frame of the extent in ticks
    (ADR 026) and the position has the next index. A step that the end clamped, Go to Out at
    the end of the extent, and a click at the right end of the ruler land on the index of
    the last frame or on the next one;
  - off the grid, it starts less than one tick of the video time base, minus 2 µs, before
    the position. Every frame starts on a tick, and no two frames start less than one tick
    apart, so no other frame starts between that frame and the position.

  A tick of 4 µs or less is too fine for the tolerance, on the grid or off it, and the
  target is kept.

  The tolerance of 2 µs covers the rounding of the three values that the test compares: the
  frame time, the calibrated origin, which is itself a frame time, and the position that the
  element reports. A web view can round each of them to a whole microsecond, or truncate
  them. The extra margin of
  the index on the grid covers a clock that truncates: it can only raise the index of the
  position, so it never names an earlier frame, and the start test still refuses a later
  one.

  Without a nominal rate, the `seeked` event does not clear the field. On the grid the test
  does not use seconds alone: a container that rounds each PTS can start the next frame
  less than one interval after a frame start, so the late callback of the frame before a
  stored PTS would clear the field.
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

### The stop point of a segment playback

(Added on 2026-09-24.) The playback store has one more public field, `playbackStop`. It holds
`inPts`, `outPts` and a phase, `playing` or `stopped`, or it is null. In the `stopped` phase
it also holds `restPts`, the PTS of the frame that the stop rested on, and
`windowEndSeconds`, the end of the seek-back window. `playSegment` sets it after it seeks to
`inPts` and plays (ADR 026). It is not a display target. The playhead and the timecode never
read it, and the other rules of this record do not change.

**The last frame.** On the frame grid, the last frame is the last nominal frame whose start
lies before `outPts` by more than the margin of ADR 028. This is `lastFrameIndexOfExtent` of
the ticks from `videoStartPts` to `outPts`, the rule of End (ADR 026). For an Out that a
frame presented, it is the ADR 028 index of the Out minus one. For an Out at the end of the
extent, it is the frame that End goes to, also when that frame is shorter than an interval.
An Out after the extent stops on the last frame of the extent. Off the grid, the last frame
is the frame that holds `outPts − 1`.

A segment cannot play in these cases:

- Its In lies at or after its Out, or its Out lies at or before `videoStartPts`.
- On the grid, its last frame lies before the ADR 028 frame of its In. Examples are a
  segment after the end of the extent, and a segment of one tick on a grid whose margin is
  one tick.
- When the probe gives the extent in ticks, its In lies at or after
  `videoStartPts + videoDurationTicks`, on the grid or off it.

**When the stop is reached.** The store tests each frame callback that arrives while no seek
runs or waits. This is the condition under which a frame callback clears the display target,
so a frame from before the seek to `inPts` is never tested. The `seeked` event does not test
the stop: a frame that arrives while the seek to `inPts` runs is not tested, and the next
frame of the playback is. The stop is reached at the first frame that meets one
of these conditions:

- On the grid, its ADR 028 index is the index of the last frame, or a later index.
- Off the grid, it starts at or after the last tick before the Out, `outPts − 1`, or
  `outPts` lies less than 1.5 nominal intervals after it. Without a nominal rate, only the
  first test applies.

**What the stop does.** The store pauses the element. When the frame is the last frame, the
pause is the whole stop, and the phase becomes `stopped`, with that frame and the end of the
seek-back window. On the grid, the last frame has the index of the last frame. Off the grid,
it is any frame that starts before `outPts`: the frame at `outPts − 1`, which proves the
last frame, or a frame that the prediction names. That frame can start before `inPts` when
it is the frame that holds `inPts`. When the prediction is right, which is the usual case,
the frame already holds `outPts − 1`, so a seek to that tick would land on the frame on
screen.

The position of the element does not decide whether the frame is the last frame. A frame
callback runs after the browser presented the frame, and the pause runs later still, so the
paused position can lie some frames past the last frame while the picture still shows it.
At 50 or 60 fps the delay is close to one frame. When the frame lies past the last frame,
because a callback came late or was skipped, the store clears the field and seeks back from
it: on the grid with the absolute frame step that `seekToFrameIndex` uses, off the grid with
`seekToPts(outPts − 1)`. That seek starts from another frame than the last frame, so it
brings a frame callback. Neither seek requests a cue.

**After the pause.** In the `stopped` phase, the element is paused. The seek-back window
ends 0.1 s after `outPts`, or one nominal interval after it when that is longer. When the
element paused after `outPts`, as after a stall of the page or with a decoder that lags, the
window ends at least one such distance after the position where the element paused, on the
calibrated mapping, so the frame at that position lies in it. The store reads that position
right after the pause; the margin covers an engine that reports it early. On the grid, the
window holds the indices after the last frame up to the index of the frame that holds its
end. Off the grid, it holds the frames that start at or after `outPts` and at or before its
end.

A frame in the window is a frame that the browser presented from a position that the element
reached before the pause took effect. It gets one seek back to the last frame, and the field
goes. That seek starts from a frame after the last frame, so it does not land on the frame on
screen. A frame of the stop keeps the field: on the grid, the last frame shown again; off the
grid, a frame that starts at or after `restPts` and before `outPts`. After an early
prediction, such a later frame lies in the segment at or before the real last frame, and it
can still lie before it. Any other frame, before the frame of the stop or past the window,
clears the field with no seek.

Every seek of the store clears the field before it starts. A `seeking` event in the `stopped`
phase therefore comes from a seek that the store did not make, such as one from the media
controls of the system, and it clears the field. In the `playing` phase a `seeking` event
does not clear it, because the late event of the seek to `inPts` arrives there. A seek from
the system while the segment plays therefore keeps the stop, and a frame past the last frame
is pulled back. So does a frame callback that finds the
element playing before its `play` event arrived.

**A window that presents no frames.** A hidden or minimized window presents no frames, so no
frame callback stops the playback. Each `timeupdate` in the `playing` phase, while no seek
runs or waits, therefore compares the position with `outPts` on the calibrated mapping. When
the position lies 0.1 s or more past `outPts`, and also one nominal interval or more past it,
the store pauses. When the last frame of the segment is the last frame of the video, the
pause ends the segment playback and the field goes, with no seek. On the grid, that is the
last frame of the extent by the rule of End. Off the grid, `outPts` lies at or after
`videoStartPts + videoDurationTicks`. Otherwise the store seeks to the last frame, counted
from the position.

On a visible window, the frame callbacks stop the playback first, because at the usual rates
two or more of them come between the Out and that distance. While the decoder keeps up, the
picture follows the element clock, so a backstop that still acts seeks to another frame than
the one on screen. A decoder that lags, as with a heavy file that a web view decodes in
software, can leave the last frame on screen, and the seek can then land on it. The backstop
acts at the next `timeupdate`, which can come up to 250 ms later, and later still in a
hidden window, where the engine can slow its timers.

**The end of the media.** When the element reaches its end, it sends `pause` and then
`ended`. In the `playing` phase, the first of the two ends the segment playback, and only
while the element reports `ended`. A late `ended` event of an earlier end therefore does not
end a segment playback that started after it. The field goes. The store does not seek in two
cases: when the last frame of the segment is the last frame of the video, by the rule of the
previous paragraph, because the element ends with the audio, which can last longer than the
video, and the picture keeps the last frame of the video; and when `outPts` lies at or after
the position where the element ended, within 1 µs. In every other case the playback passed the Out with
no frame callback, and the store seeks back to the last frame.

**What clears it.**

- `play`, `pause`, `seekToPts`, `seekApproximate`, `seekNominal` and `seekToFrameIndex`. So a
  click, a scrub, a trim, a step, Home, End, Go to In, Go to Out and a typed timecode all
  clear it when they call the store, also when the store then moves nothing.
- A `playSegment` that passes its checks, also when its seek or its play then fails. A
  refused call changes nothing.
- A detach, a reset, `syncUnready`, and an attach of another element or source.
- A failed play, and a loss of the calibration.
- A `pause` event in the `playing` phase, while the element reports `paused` and not
  `ended`. This is a pause from the system. A `pause` event that finds the element playing
  again is the late event of the seek to `inPts`, and it does not clear the field.
- A `play` event in the `stopped` phase, or a frame callback in that phase that finds the
  element playing.
- A `seeking` event in the `stopped` phase. In the `playing` phase it keeps the field.
- The end of the media in the `playing` phase.
- The seek back of the stop itself, and the pause of the backstop.
- A frame callback that finds that the segment no longer holds a frame.
- In the `stopped` phase, a settled frame that is neither a frame of the stop nor in the
  seek-back window.

An edit of the timeline does not clear it. Mark Out, Delete, Undo and Redo change a segment
with no seek, so a segment playback keeps the Out that it started with when one of them moves
or removes that Out while the segment plays. A trim seeks, so it ends the playback.

**What the user sees.**

- On the grid, the playback normally stops on the last frame with no seek. When a frame
  callback comes late or is skipped, or when the browser presents a frame in the window after
  the pause, the browser shows that frame briefly, and the store then seeks back. The
  playhead does not draw a frame that the store seeks back from, because the display target
  of the seek is set in the same call.
- Off the grid, the playback also stops with no seek on a proven or predicted last frame. A
  late prediction lets the Out frame show briefly, and the store seeks back from it. An early
  prediction pauses one frame or more before the last frame. When the element had moved on,
  the browser presents a later frame, which lies in the segment when it lies before the Out
  and is pulled back when it lies in the window. When the element had not moved on, the
  playback rests one frame or more early. The seek to `outPts − 1` after a frame at or after
  the Out starts from another frame, so it brings a frame callback. End keeps its own limit
  off the grid (ADR 026).
- On a hidden window, the sound can play past the Out by 0.1 s, or by one nominal interval
  when that is longer, and up to one `timeupdate` interval more.
- If the calibration becomes unavailable while the segment plays, the field goes, and the
  playback continues as a normal playback.
- Three rules need a check in the built application, in WKWebView and in WebView2: that a
  paused element whose picture moves past the last frame always brings a later frame
  callback, that the position read right after the pause is within the margin of the real
  paused position, and that the engine never sends a `seeking` event of its own on a paused
  element.

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

(Changed on 2026-09-25.) The store sends each scrub burst with the kind `drag`. The
controller of ADR 019 then continues a drag burst only while the element is at most 0.1
seconds behind the target, so the sound of a drag stays near the pointer. A frame step has
a longer lag limit, so a held key near real time stays continuous. A drag in Chrome was not
measured. After a seek, the clock of Chrome stands still longer than the drag limit allows,
so a drag there starts a new seek on most requests, as it did before this change.

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
  callback. In the `ready` state the target then stays until the next presented frame, or
  (changed on 2026-09-24) until the `seeked` event finds that `presentedFrame` holds the
  position of the element.
  The `presentedFrame` can be null or not null in that condition:
  - It is null when no frame arrived after the last request. The edit actions then stay
    disabled, as they did before this decision.
  - It is not null when an RVFC callback for an earlier seek arrived while the last seek
    ran. The last seek then landed on that same frame. The edit actions are enabled, and a
    mark writes the PTS of that frame, which is the frame on screen. (Changed on
    2026-09-24.) The `seeked` event of the last seek clears the target when that frame
    holds the position of the element. Otherwise the timecode shows the target, and the
    target is less than one frame from that frame.
- (Added on 2026-09-24.) When the only callback of a seek arrived while the element
  reported `seeking`, the `seeked` rule still keeps the target in these cases, until the
  next presented frame, as before:
  - Off the grid, a seek to a position one tick minus 2 µs or more after the start of its
    frame: a frame step, End with `extentEnd` (so the no-op of a second End does not
    apply), a click inside a frame, and the seek back of a segment playback to
    `outPts − 1` (the stop point above). Only a seek to a position from 2 µs before the PTS
    of a frame to less than one tick minus 2 µs after it clears the target there.
  - With a tick of 4 µs or less, on the grid or off it, no seek.
  - On the grid, with no `videoDurationTicks`: End on the approximate clock (ADR 026), and
    a step that the end position clamped. The element then usually stands one interval or
    more after the start of the last frame. This is mostly Matroska and WebM.
  - On the grid, a position more than one index past the last frame of the extent, and an
    extent that ends more than the margin after the last real frame (ADR 026).
  - On the grid, a position just before a frame start that lies at or after its nominal
    start, or less than about 2 µs before it, within the margin of ADR 028. For example, on
    a Matroska file at 29.97 fps with millisecond timestamps, a click at 1000 ms gives index
    30 while frame 29 is on screen, because frame 30 starts at 1001 ms. On that grid this is
    the last tick before about half of all frame starts.
  - No nominal rate.

  Wrong clears remain only in rare cases, and each one lasts until the callback of the frame
  that the seek shows, which is a different frame:
  - On the grid, when the extent leaves out a real frame, a seek into the index just after
    the extent, with a late callback of the last frame of the extent. The bound allows that
    index for the three seeks named above, and at the `seeked` event nothing tells a missing
    frame from a real one.
  - A position up to 2 µs before the start of the frame that a late callback reports, when
    the web view shows the frame before it. A seek on a time base whose ticks are not whole
    microseconds, such as 1/90000, can land there when the web view truncates the seek
    time, and so can a frame step off the grid.
- (Added on 2026-09-24.) The `seeked` rule reads `currentTime` at the `seeked` event. The
  HTML specification sets the position before that event. If WebView2 truncates positions
  instead of rounding them, a position can read up to 1 µs low, which the 2 µs tolerance
  still covers. This needs a check in the built application, in WKWebView and in WebView2.
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
- (Added on 2026-09-24.) Two more displays read the pending-seek state. The In and Out
  badges of the preview show only while `seekTargetSeconds` is null, a frame is on screen,
  playback is paused and the calibration is ready, and they compare the exact PTS of
  `presentedFrame` with the stored boundaries. The segment duration of the transport bar
  reads `presentedFrame` for a pending In, as Mark Out does. Neither display reads the
  target itself, so neither can name a frame that is not on screen.
