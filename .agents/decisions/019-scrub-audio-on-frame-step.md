# 019. Play a short audio burst when the playhead steps one frame

- Status: Accepted
- Date: 2026-09-20
- Deciders: capric98
- Amended by: ADR 022

## Context

A user marks an In point or an Out point on a single frame. The preview shows that frame.
The picture alone is frequently not sufficient to identify the correct frame. A slow pan,
a static speaker and a dark scene all look the same across several adjacent frames. The
user must then hear the sound to find the frame where a word starts or where a transient
occurs.

PotPlayer solves this. A frame step there plays a short piece of the audio at the new
position. The user steps through the frames and hears the sound of each one.

QuipClip steps one frame through `seekNominal` in `src/features/playback/store.ts`. That
action pauses the preview element and assigns `currentTime`. A paused element makes no
sound, so a frame step in QuipClip is silent. The two callers are the arrow keys of the
focused timeline and the two step buttons of the transport bar.

Three properties of the existing application constrain the solution:

- ADR 003 makes the native `<video>` element the source of the picture and the sound. It
  anchors the PTS calibration on the first `requestVideoFrameCallback` after the load. An
  action that moves that element, or that delays its first callback, breaks the mapping
  that every precise edit uses.
- The content security policy in `src-tauri/tauri.conf.json` permits `asset:` under
  `media-src` and does not permit it under `connect-src`. The frontend can give the asset
  URL to a media element. The frontend cannot read the bytes of the file.
- The asset protocol scope holds one grant for each file the user opens. A second element
  that uses the same URL needs no new grant.

QuipClip considered two designs.

The first design decodes the audio in the web view. A second, hidden `<audio>` element
receives the same asset URL as the preview element. A frame step seeks that element and
plays it for a short time. This design adds no Rust code, no command, no cache and no
configuration.

The second design decodes the audio with `ffmpeg`. A Rust command extracts a window of
linear PCM, sends it over the IPC channel, and the frontend plays it through the Web Audio
interface. This design plays every codec, is accurate to the sample, and permits a fade at
each end of the burst. It costs a new command, a cache with an eviction rule, and one
process start for each cache miss.

## Decision

QuipClip takes the first design.

A hidden `<audio>` element carries the same asset URL as the preview `<video>` element.
`src/features/playback/scrubAudio.ts` holds one controller that owns that element. The
controller has four operations: attach, detach, request and stop.

`seekNominal` is the only action that requests a burst. It requests one after it assigns
`currentTime`. It passes the same target value it gave the preview element. Every other
action of the playback store stops a burst: `play`, `pause`, `seekToPts`,
`seekApproximate`, `detach` and `reset`. A cue and the real playback never sound together.

A burst lasts `SCRUB_BURST_SECONDS`, which is 0.05. One frame lasts 33 to 42 milliseconds
at the usual frame rates. The value is therefore near to one frame, and it is easier to
hear. The value is one constant.

The controller starts the stop timer on the `playing` event of the element, and not when
it calls `play`. A media element needs approximately 10 to 50 milliseconds to seek and to
start. That interval is as long as the burst. A timer that starts earlier therefore cuts
the burst to almost nothing. A second timer starts when the request arrives. It stops the
element 500 milliseconds after the end of the burst. That timer covers the condition where
the `playing` event never occurs.

A forward request that arrives while a burst sounds, and whose target is within
`SCRUB_CONTINUATION_TOLERANCE_SECONDS` of the position of the element, does not seek. It
only moves the stop time later. A held arrow key repeats approximately 30 times each
second. That rate is near to real time at 25 to 30 frames each second, so the element is
already at the correct position. Without this rule a held key restarts the element
continuously and the result is a stutter. A backward request always seeks, because audio
does not play backwards.

The element is mounted only when the probe reports an audio stream, only while the
playback store reports that it is attached to that same source revision, and only after
the calibration status leaves `calibrating`. The last two conditions prevent a second
request stream during the interval in which ADR 003 takes the calibration anchor.

The second condition compares the source revision key. A boolean cannot serve. The render
that first carries a new source still holds the store state of the previous source, so a
boolean is stale exactly when it decides. React assigns `src` when it constructs the node,
and a media element that is not in the document still fetches, so a node built on that
render starts a second read of the new file before the store has attached to it. The store
publishes the attached key in the same `set` as the calibration status, so no render sees
the key of one source beside the calibration state of another.

The cue is always on. There is no setting and no volume control.

The application does not show an error when the cue fails. An element error, or a rejected
`play` promise that is not an `AbortError`, disables the controller for that source. The
cue helps the user find a frame. It is not an edit action, and a message about it would
report a fault that the user cannot correct.

## Consequences

- A frame step from the arrow keys and a frame step from the transport buttons both make a
  sound. Both callers reach `seekNominal`, which is the one action that starts a burst.
- This decision changes no Rust file and no command. The content security policy does not
  change, and the asset protocol scope does not change. The second element uses the URL of
  a file that already holds a grant.
- The second element opens a second range request against the same file. The cost is one
  more decoder and one more buffer for the audio stream.
- The burst has no fade at either end. 50 milliseconds leaves no room for a ramp of the
  `volume` property, so a burst of speech can click. A fade needs the Web Audio interface,
  a `MediaElementAudioSourceNode` and a `GainNode`. That node gives silence when the
  response of the asset protocol is not clean for cross-origin use. QuipClip has not
  measured that response. The fade is therefore a later step and not a part of this
  decision.
- The web view selects its own default audio stream. The export binds the absolute stream
  index that the probe reports (ADR 014). The two can differ on a file that holds more
  than one audio stream. The cue matches the preview, which is the correct agreement for a
  monitoring sound. The difference between the preview and the export is still real. It
  existed before this decision, and this decision does not correct it.
- A source whose audio the web view cannot decode gets no cue. The picture of such a
  source frequently does not play either, and ADR 003 gives the proxy as the answer to
  that condition.
- The `ffmpeg` design stays available. A later decision can replace the element with a PCM
  window over the IPC channel. The controller interface does not change, because
  `seekNominal` requests a burst at a target time and knows nothing about the decoder.
