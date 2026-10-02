# 035. Keep playback running across a pointer seek and a time jump

- Status: Accepted
- Date: 2026-10-02
- Deciders: capric98
- Amends: ADR 022, ADR 026

## Context

Every seek of the playback store paused the element. `dispatchSeek` in
`src/features/playback/store.ts` called `pause()`, and the seek actions set `isPlaying` to
false. ADR 022 states the result for the timeline: "A drag during playback pauses it. The
playback stays paused after the release." A click on the ruler is the exact seek of that same
gesture, so a click paused playback too.

A user reported that behaviour as a fault. A media player such as PotPlayer or mpv keeps
playing after a click on its seek bar, and the user wants the preview to behave like a player
in this respect. The user chose this rule:

- A click on the ruler or on the track during playback keeps playing from the new position.
- A drag during playback shows the picture under the pointer while it moves. After the release,
  playback continues when it played at the start of the drag.
- Navigation to an exact frame keeps pausing, as in the editors that ADR 026 follows: a frame
  step, Home, End, Go to In, Go to Out, a jump to an edit point, a typed timecode and a trim.

The store could keep playing in two ways. It could seek and then call `play`, or it could seek
without a pause. `play` starts a queued seek at once, as an exact seek (ADR 022). A fast series
of seeks, such as a held time-jump key of the keyboard, would then cancel each running seek
before it ends,
and the picture would not change until the key is released. A seek that does not pause keeps
the rule of ADR 022 that each seek that starts also completes.

## Decision

### A seek option

`seekToPts`, `seekApproximate` and `seekToFrameIndex` take the option `keepPlaying`. A seek
keeps playing when all of these conditions are true:

- The caller set `keepPlaying`.
- The seek is not a scrub seek. A scrub seek always pauses (ADR 022).
- The store reports playback.
- The element does not report that it is paused. An element that paused by itself, before its
  `pause` event arrived, gets an ordinary seek.

Such a seek does not call `pause`, keeps the current play session and keeps `isPlaying` true.
The element seeks and then continues to play from the new position. Every other effect of a
seek stays: `presentedFrame` becomes null, the display target is set, a sounding cue stops, and
the stop point of a segment playback goes. A segment playback therefore continues as normal
playback.

A `keepPlaying` seek that arrives while the element reports `seeking` is queued, as any seek
is. The `seeked` event starts it, and it does not pause. A later seek without the option
replaces it and pauses, as before.

A `keepPlaying` seek that fails pauses the element and reports `seekFailed`. A failed seek
therefore always leaves the element paused.

While the calibration is `calibrating`, the store defers the seek and pauses, as ADR 022
requires. The deferred request does not keep the option, so playback does not continue at the
anchor. This case is rare, because the first frame of a playback ends the calibration.

The `seeked` rule of ADR 022 that restores the frame on screen needs a paused element, so it
does not run during playback. The frame callbacks of the playback clear the display target.

### The pointer gesture

The exact seek at pointer down carries `keepPlaying`. A click sends no seek at its release, so
a click keeps playing.

A drag sends scrub seeks while it moves, and they pause. At the release, after the exact seek
of the release, the timeline calls the store action `resumeAfterSeek`. That action calls `play`
when all of these conditions are true:

- The store played at pointer down.
- The gesture ended in a release of a drag, by the pointer that started it.
- No navigation is deferred.
- The seek did not fail.
- The position that playback starts from is before the end of the media. That position is the
  target of the pending seek or of the running seek, or else the position of the element.
- When no seek is pending or running, the element does not report that it has ended.

A cancel, a window blur, a lost pointer capture, a trim (ADR 030), a click on a segment edge and
a click on a segment do not resume playback. The last condition exists because `play` on an
element at its end seeks to the start, in WebKit and in Chromium. A drag that ends past the right
edge of the lane would otherwise restart playback from the first frame. It stays paused at the
end, as before.

ADR 022 drops a scrub request that repeats the time of the last accepted request. That rule
now applies only while the store is paused. During playback, the first scrub sample of a drag
must pause the element, also when it lands on the time of the seek at pointer down.

### The pause event

The `pause` event of a seek can arrive after the element plays again, for example after the
seek to the In of a segment playback (ADR 026) or after the resume of a drag. When the element
does not report that it is paused, the store ignores that event. It keeps `isPlaying` and the
play session. The play button no longer shows the paused state for one frame in these cases.

### Which actions keep playing

- A pointer seek on the ruler or on the track, by this record.
- The time jumps of the keyboard, which a later record adds.

Every other navigation pauses, as before: a frame step, Home, End, Go to In, Go to Out, a jump to
an edit point, a typed timecode, a trim, and the seek back of a segment playback.

## Consequences

- During playback, a click moves playback to the new position. The sound stops for the time of
  the seek and then continues.
- ADR 022 stated that a drag during playback pauses it and that playback stays paused after the
  release. That statement no longer applies. A drag still pauses while it moves.
- A click ends a segment playback (ADR 026), and playback then continues as a normal playback.
- The resume after a drag calls `play` from a `pointerup` event. The element already played in
  this session, so the autoplay policy of the web view should accept the call. That needs a
  check in the built application, in WKWebView and in WebView2. If the call fails, the store
  reports `playbackFailed`.
- Space during a drag starts playback, because the store is paused while the drag moves. The
  next scrub sample of the drag pauses it again.
