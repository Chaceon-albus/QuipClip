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
- `attach`, `detach`, `reset`, `syncUnready` and each failed seek clear the field.

### One seek at a time, and the latest request wins

The store runs one element seek at a time. When a request arrives and the element reports
`seeking`, the store does not assign `currentTime`. It keeps the request as the queued
seek, and it replaces any older queued seek. The `seeked` event starts the queued seek.
`play` starts a queued seek before it plays, so playback starts at the last target.

Each seek that starts also completes. The picture therefore changes during a drag, at the
speed of the decoder.

`seekNominal` calculates its step from the queued target when one exists, and from
`currentTime` when none exists. A held arrow key therefore continues from the last
request.

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
cadence as the picture. The direction is the sign of the move from the last burst target.
The store makes no request for a zero move. The continuation rule of ADR 019 makes a slow
forward drag sound continuous.

This amends ADR 019. ADR 019 makes `seekNominal` the only action that requests a burst,
and it makes `seekToPts` and `seekApproximate` stop a burst. After this decision, both
actions request a burst in scrub mode. An exact seek, from a click or from the end of a
drag, still stops the burst.

### The pointer gesture

A primary-button pointer down on the ruler or on the uncovered track starts a gesture, and
the surface captures the pointer. The gesture sends at most one sample for each animation
frame. The playhead in the track row has a narrow hit area above the segments, so the user
can drag the playhead also when it is over a segment. A segment button keeps its click, and
a click on it selects the segment without a seek.

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
- The `seeked` event can run after a newer seek started. `syncSeeked` therefore does
  nothing while the element reports `seeking`. The `seeked` event of the running seek
  starts the queued seek.
- A drag during playback pauses it. The playback stays paused after the release.
- The timeline does not scroll when a drag goes past the visible edge. That is a possible
  later step.
- The pending In region still follows `presentedFrame`, not the target.
