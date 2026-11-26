# 063. Calibrate the preview again after a calibration that failed

- Status: Accepted
- Date: 2026-11-25
- Deciders: capric98
- Amends: ADR 003, ADR 022, ADR 039, ADR 052

## Context

ADR 003 gives the calibration three states. In the state `unavailable`, the preview plays, but
Mark In, Mark Out and Split are off. Before this record, nothing that happened to an element
left that state. A play and later frames changed nothing.

A review of the playback store on 2026-11-25 sorted the causes of that state into three groups.

The element showed no frame, and nothing else is known:

- The wait for the first frame ran out. ADR 003 bounds it at 8 seconds of visible time while a
  navigation waits.

The element, or the source, gave evidence against the anchor or against the mapping of ADR 003:

- The anchor guard refused the first frame callback.
- The priming play of macOS moved the element more than 1 second with no frame.
- A frame callback gave no usable media time.
- A media time had no safe conversion to a PTS.
- Two different media times gave the same PTS.
- The first frame of a `MediaSource` source did not match its first window (ADR 046).
- The timestamps of the source decrease (ADR 046).

The source or the web view cannot calibrate:

- The source has no valid `videoStartPts`, or its time base is not valid.
- The web view has no `requestVideoFrameCallback`.

A calibration that failed did not request a new element. The preview mounts a new `<video>`
element for a new source revision and after a decode stall (ADR 039). So in the first group, a
slow first frame turned the marks off for the clip until something else replaced the element.
The removal of the clip and an undo did that, but only when no other clip of the same source
kept the element. The interface showed neither way. The reports of 2026-11-19 about
"Approximate position · marking unavailable" on MP4 files had this result.

## Decision

### A recalibration is a reload without a stall

A **recalibration** replaces the elements of the preview with new ones of the same source. It
uses the reload of ADR 039: the store raises `reloadGeneration`, the pane mounts new elements,
and the store attaches the new element as a new attachment. The new element takes its anchor
from its own first frame, by the rules of ADR 003 with no change. No time of the old element
enters the PTS inference.

The store keeps one navigation request for the new element, as a reload after a stall does. The
request becomes the deferred navigation when the new element is ready, so it runs at the anchor
(ADR 022). The request is always an exact seek. A scrub request becomes an exact seek, as in a
stall (ADR 039), because the gesture that sent it can end during the reload.

### Only after a wait that ran out

The calibration is **recoverable** when all of these conditions are true:

- The calibration is `unavailable`.
- The cause is the wait for the first frame that ran out.
- The source has a valid `videoStartPts` and a valid time base.
- The store holds no denial of the source.

A recalibration then gives the source the same chance that a first attachment gives. It
discards no evidence.

The second group is not recoverable. Each of its causes is evidence that the anchor rule or the
mapping of ADR 003 can fail for the source. An anchor guard that refused a callback, and a
priming play that moved the element with no frame, show that the first callback can come late.
A new element could then accept a late frame as its anchor, inside the tolerance of the guard,
and each mark would have a wrong PTS. After a denial, a new element could go to a later part of
the file and never see the evidence again. So these causes stay as ADR 003 and ADR 046 state
them. The third group is not recoverable because a new element changes nothing.

In practice only a native source is recoverable. A `MediaSource` source knows its anchor before
its first frame (ADR 046), so no navigation waits for its first frame.

### The handoff

The start of a recalibration is one step of the store. In that step the store does all of
this:

- It ends the playback, the cue, the priming play, the queued seek, the deferred navigation and
  the stop point of a segment playback.
- It keeps the request and its display target.
- It raises `reloadGeneration`.
- It sets the new public field `isRecalibrating`.

It does not set `decodeStall`.

From that step, the old element is retired. Until the pane detaches it, the store handles it as
it handles a stalled element:

- A frame callback and the `seeked`, `play`, `pause`, `timeupdate` and `ended` events of the
  old element change nothing.
- An error of the old element changes nothing, and the pane shows no failure panel for it.
- A seek of the user replaces the request of the reload. The latest request wins (ADR 022).
- Play, Play Segment and a frame step do nothing.

The store can tell the pane whether an element is retired. The pane drops the media events of a
retired element before it calls the sequence layer or the store.

`isRecalibrating` stays true until the new element is ready. An attach of a different source, a
loss of readiness of the new element, and a reset also end it. The detach of the old element
does not end it, and neither does the detach and attach of the new element before its metadata
(ADR 039). A seek that fails drops the request, but the reload continues, as for a stall.

### The latest request wins at each report

When the new element is ready, the request of the reload becomes the deferred navigation
before the store reports the element as ready. A seek that a listener of that report sends is
then the latest request, and it replaces the request of the reload. This order also holds for
the reload of a stall.

A navigation that the store runs at once, because the calibration is not `calibrating`, drops a
deferred navigation that still waits. So a seek that a listener sends when the store reports
`ready` or `unavailable` is the latest request, and the deferred request does not run after it.

### `canRecalibrate`

The store reports a new public field, `canRecalibrate`. It is true only while all of these
conditions are true:

- The calibration is recoverable.
- The element is ready.
- No decode stall is active.
- No reload is in progress.

It permits one more attempt. It does not promise that the attempt gives a calibration.

### The automatic recalibration

When the wait for the first frame runs out, the pane reports it through its own action of the
store. When the store permits an automatic recalibration, it recalibrates. The deferred
navigation becomes the request of the reload, with its seek and its steps. Its display target
stays. The calibration stays `calibrating`. The status bar says "Preparing the preview…" also
while `isRecalibrating` is true.

The store permits one automatic recalibration for each source. These events permit one more:

- A calibration of that source becomes ready.
- A different source attaches.
- The store resets.

When the wait runs out and the store permits no automatic recalibration, the calibration
becomes `unavailable`. The deferred navigation runs on the approximate clock, as ADR 003
states. The calibration is then recoverable, so the manual recalibration is available.

### The manual recalibration

The action `recalibrate` runs while `canRecalibrate` is true. It keeps the position to go back
to, and it starts the recalibration with that position as the request. The position is the
display target when a seek is pending. Otherwise it is the position of the approximate clock.
Both count seconds from the start of the source of the attached element.

The new element goes back to that position when its calibration leaves `calibrating`. The
playback does not start again. A manual recalibration does not permit one more automatic
recalibration.

### The sequence

On a sequence of several clips (ADR 052), the facade passes `recalibrate` to the store with the
key of the attached source. The facade first ends a segment playback that crosses a junction,
and it drops a navigation that waits for an attach, as for each navigation of the user. The
store reads the position from its own state, so no sequence time enters the request.

A recalibration of the attached clip is not a cold switch, and it does not move the mapped
clip. A cold switch that is in progress stays in progress while `isRecalibrating` is true, so a
scrub or a trim that crosses a junction keeps its gesture and its exact release seek.

### The cue

The hidden `<audio>` element of ADR 019 and the PCM cue of a native source (ADR 062) do not
start while `isRecalibrating` is true. The first render of the new elements still reads the
calibration status of the old element. Without this rule, a cue could load the file together
with the new `<video>` element and delay its anchor.

### The interface

While `canRecalibrate` is true, the approximate-position item of the status bar and the `≈`
badge beside the preview timecode are buttons. A click, or Enter on the focused control, starts
the manual recalibration. Space stays the play key of the window (ADR 026).

- The item says "Approximate position · click to try again".
- The tooltip says that the mark actions are unavailable until the preview reads the exact frame
  timestamps, and that a click loads the preview of the video again.
- The reason on the disabled Mark In, Mark Out and Split buttons names the same step.

While `canRecalibrate` is false, the item, the badge and the reasons keep the text of ADR 003,
which tells the user to convert the video.

## Consequences

- A slow first frame costs one more wait. When both waits run out, the user waited two times
  8 seconds of visible time, and the load of the new element, before the approximate clock took
  the request. Each return of the window to visible starts the current wait again.
- After a wait that ran out two times, the user can get precise editing back with one click,
  and without the loss of segments.
- A recalibration loads the start of the file again.
- An anchor guard that refused the first callback, and a priming play that moved the element
  with no frame, still leave the element `unavailable`. A safe recalibration for them needs a
  test that the first callback of the new element names the frame of `videoStartPts`. ADR 003
  has no such test for a native source.
- A denial of a source still holds until the application starts again. This record does not
  change the rule that one pair of media times with the same PTS denies the source.
- This record does not start the priming play of macOS again on the same element. The new
  element of a recalibration gets its own priming play.
- A play or a segment playback that waits for the calibration of another clip (ADR 052) still
  has no bound. No navigation is deferred in that state, so no wait runs.
