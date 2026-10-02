# 039. Recover the preview after a decode error in the middle of a file

- Status: Accepted
- Date: 2026-10-02
- Deciders: capric98
- Amends: ADR 003, ADR 022, ADR 026

## Context

A user opened a file that FFmpeg had joined from parts with different picture sizes. Playback
reached the join, and the preview showed "QuipClip cannot preview this video". After that the
preview never came back, also when the user moved the playhead to a good part.

The `error` event of the `<video>` element replaced the element with the decode failure panel.
The unmount detached the playback store, so the timeline could not seek, and only the import of
a new file cleared the panel. An element that reported a decode error is dead in Chromium: a
seek back fires no `seeked`, and `play` never resolves. A new element of the same file shows the
good parts again.

## Decision

### A stall, not a failure

A media error is a stall when the source decoded in part. That is true when an element of the
source showed a second frame, or started a seek after its first frame. The codes are
`MEDIA_ERR_DECODE` and `MEDIA_ERR_SRC_NOT_SUPPORTED`. Every other case keeps the decode failure
panel of ADR 003: an error before the first frame, `MEDIA_ERR_NETWORK`, `MEDIA_ERR_ABORTED`, an
error with no code, and a failed picture check. The record of a source that decoded in part
clears when a new media object arrives, also for a new import of the same file.

The seek clause covers the fault of the user. The user opened the file, the first frame showed,
and the user clicked straight into the bad part. That element showed one frame and failed, and
without the clause it would show the permanent panel again. The cost is one case: a decoder that
decodes only the first frame, and then fails after every seek, shows the stall notice after each
click and never the panel with its codec hint.

### During a stall

`syncDecodeStall` pauses the element, stops the cue (ADR 019), and drops the queued seek, the
deferred navigation and the stop point of a segment playback. `presentedFrame` becomes null. The
store keeps `isAttached` and `isReady`, so the timeline still seeks. The approximate clock takes
the position where the stall happened, so the playhead and the notice agree.

- `seekToPts`, `seekApproximate` and `seekToFrameIndex` never touch the dead element. The
  latest request becomes the reload request, and it sets the display target. A scrub request
  is kept as an exact seek. The first request of a stall raises `reloadGeneration` once.
- `play`, Play Segment and the frame step do nothing, and their controls are disabled with a
  reason. Home, End, Go to In and Go to Out still seek, so they reload.
- A trim of a segment edge does not start. The press on an edge is a plain click, which seeks to
  the boundary and reloads.
- Late frame callbacks and the `seeked`, `play` and `timeupdate` events of the dead element
  change nothing.

### The reload

The preview keys the `<video>`, the hidden `<audio>` of the cue and the buffering indicator on
the source revision and `reloadGeneration`. A raised generation mounts new elements. The detach
of the dead element keeps the reload request and its target. The attach of the new element of the
same source starts the calibration again, and it clears the stall. The new element anchors its
own first frame, as ADR 003 requires, and no time of the dead element enters the PTS inference.
When the store becomes ready, the request moves into the deferred navigation of ADR 022, so it
runs at the anchor. A target inside the anchor frame is dropped, as before. When the calibration
is unavailable, the request runs at once on the approximate clock.

React in development detaches and attaches the ref of a new element a second time. A detach of the
reloaded element before its metadata therefore keeps the reload and its target, and the next
attach of the same source takes them again. An attach of another source, `syncUnready` and
`reset` drop them.

Only a seek of the user reloads. Seeking into the bad part again stalls again, and the next seek
reloads once more. There is no loop.

### The notice

An amber notice shows while the stall lasts: "Preview stopped at about {{time}}. The preview
cannot decode this part of the file (the picture size or the codec may change here). Move the
playhead to another part to continue." The time uses the timecode format of the playhead. The
close button hides the notice for that stall only. The export does not use the preview decoder,
and the notice does not speak about it.

A new import of the same file during a stall raises the generation once, and the new element
loads at the start of the file.

## Consequences

- The timeline and the edit actions work again after a stall, and the user can mark segments
  in the good parts.
- A measurement in headless Chrome on macOS joined a 1280×720 part and a 640×360 part, with and
  without the parameter sets in the stream. One file played through and resized at the join.
  The other gave `MEDIA_ERR_DECODE` at the join. The real store recovered from it: a seek to a
  good part loaded a new element that calibrated and showed the frame, a seek into the bad part
  stalled again, and a seek after the bad part played.
- AVFoundation, which WKWebView uses on macOS, raised no `error` for the same files. It stopped
  the frames at the join and kept the clock and the sound running. This record does not detect
  that state, so the macOS preview can show a frozen picture with no notice. A seek to a good part
  showed frames again in that measurement. A watchdog for missing frame callbacks during playback
  is a possible later step. The run in WKWebView itself needs a visible window and is still
  open.
- A drag that starts during a stall ends when the new element is attached, because `isReady` is
  false until its metadata loads. A click works. A release during that short window seeks to an
  earlier sample.
- `Space` pressed while the new element calibrates plays from the start, by the rule of ADR 022
  that `play` drops a deferred request.
