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

(Changed on 2026-09-24.) The stop timer waits for two events of the burst. The first is the
`seeked` event that ends the seek of the burst. The second is the `playing` event. The
timer starts when the second of the two arrives, in either order. A `seeked` event that
arrives while the element still reports `seeking` ends an earlier seek, and the controller
ignores it. A new seek clears both conditions.

An assignment of `currentTime` before the metadata loads starts no seek, and no `seeked`
event follows. A `playing` event that arrives while the element does not report `seeking`
therefore also ends the wait for the seek. The second timer now covers the condition where
one of the two events never occurs.

Chromium sends `playing` after `seeked`, so the rule changes nothing there. WebKit, the web
view of macOS, keeps the ready state through the assignment of `currentTime`. It therefore
sends `playing` as soon as the controller calls `play`, while the seek still runs. QuipClip
measured this in a WKWebView with an `asset:` scheme handler that serves byte ranges. With
the timer on `playing` alone, the timer stopped the element before the seek ended in most
bursts. Seven of eight single steps played no audio, and the eighth played 13 milliseconds.
With the new rule, each single step played 41 to 75 milliseconds of audio.

(Changed on 2026-09-25.) The burst ends on the media clock of the element, not on a timer.
After the `seeked` and `playing` events of the burst, the controller reads `currentTime`
again and again. It pauses the element when the position reaches the latest target plus
`SCRUB_BURST_SECONDS`. Each read waits for the media time that remains, from 4 to 16
milliseconds. The clock of the element moves only while the element plays, so a slow start
does not shorten the burst.

A timer on the wall clock was not correct in Chrome on macOS. After a seek, the clock of
the element moved approximately 20 milliseconds and then stood almost still for 300 to 455
milliseconds before it moved at the normal rate. A timer of 50 milliseconds therefore ended
the burst while the clock stood still.

The controller also stops the burst when the element reports `ended`, because the clock of
an ended element does not move again.

The watchdog stays. It waits for the media time that the burst still has to play, at least
one burst, plus `SCRUB_WATCHDOG_EXTRA_SECONDS`, which is now 1 second. It restarts when the
clock check starts and on each continued request. A slow seek therefore does not use up its
margin. The margin is longer than the start delay of the audio output in Chrome, so the
watchdog does not end a burst that is about to sound.

The wait for `seeked` and `playing` is now a precaution. A read of the clock during the
seek gives the target of the seek, so an early read could not end the burst.

A forward request that arrives while a burst sounds, and whose target is within
`SCRUB_CONTINUATION_TOLERANCE_SECONDS` of the position of the element, does not seek. It
only moves the stop time later. A held arrow key repeats approximately 30 times each
second. That rate is near to real time at 25 to 30 frames each second, so the element is
already at the correct position. Without this rule a held key restarts the element
continuously and the result is a stutter. A backward request always seeks, because audio
does not play backwards.

(Changed on 2026-09-25.) A forward request continues the burst when three conditions are
true. Its target is at most `SCRUB_CONTINUATION_TOLERANCE_SECONDS` after the last target.
The element is behind the new target by no more than a lag limit. The element is ahead of
the new target by no more than the tolerance. While a seek runs, the position of the
element is the target of that seek. A continued request moves the stop position to its
target plus one burst.

The lag limit depends on the kind of the request. A frame step uses
`SCRUB_CONTINUATION_MAX_LAG_SECONDS`, which is 0.75 seconds. A drag of the playhead (ADR
022) uses `SCRUB_DRAG_MAX_LAG_SECONDS`, which is 0.1 seconds, so the sound of a drag stays
near the pointer as before. The playback store sends the kind `drag` with each scrub burst.

The earlier rule compared the target with the position of the element. The element starts
late, so during a held key it plays behind the target by the time of its seek and its
start. That lag was longer than the tolerance, so each step started a new seek, and each
seek started the wait again.

A held key repeats approximately 30 times each second. At 24 to 30 frames each second, the
target therefore moves at 1 to 1.26 times real time. When the clock starts, the lag is that
rate times the time of the start: up to 0.57 seconds in Chrome. The lag limit of a frame
step is longer, so the first seek of a hold is not repeated before the clock starts. A key
that steps faster than real time still seeks again when the lag passes the limit. The sound
therefore does not fall behind without end.

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

(Changed on 2026-09-24.) The cue still has no setting of its own and no volume control, but
the Mute toggle of the transport bar silences it together with the preview `<video>`. The
toggle sets the `muted` property of both elements, from the moment each element is created,
so it applies before the first play and the first burst. The choice persists in the web view
store under `quipclip.preview_muted`, not in the settings file. Mute changes only the sound.
The controller does not read it, so a muted burst still seeks, plays, starts both timers and
applies the continuation rule. The calibration of ADR 003 and the export do not change. The
toggle has no key, because `M` adds a marker in the editors that ADR 026 follows.

The application does not show an error when the cue fails. An element error, or a rejected
`play` promise that is not an `AbortError`, disables the controller for that source. The
cue helps the user find a frame. It is not an edit action, and a message about it would
report a fault that the user cannot correct.

## Consequences

- (Added on 2026-09-25.) The stop on the media clock and the new continuation rule remove
  the two limits of the entry below. A measurement with `played` ranges, in WKWebView and
  in Chrome on macOS, found these results. A single step played 50 to 55 milliseconds in
  both. In Chrome, the first step after the load also played a full burst, and the element
  paused 410 to 420 milliseconds after the step.

- (Added on 2026-09-25.) The measurement also held a forward key for 90 steps, 33
  milliseconds apart. At 30 frames each second, the sound was continuous with one seek in
  both web views. At 24 and 25 frames each second, the lag passed its limit once, after 1.7
  to 2.6 seconds, so the sound came in two pieces. In a longer hold, that gap comes back
  each time the lag passes the limit again.

- (Added on 2026-09-25.) At 60 frames each second, a held key steps slower than real time.
  The element reached the stop position between the steps, paused, and the next step
  started a new seek. That happened 5 to 10 times in 3 seconds. A resume without a seek,
  when the new target is just behind the paused position, is a possible later step.

- (Added on 2026-09-25.) During a held key, the sound follows the picture by the lag, up to
  0.75 seconds. After the release, the sound continues until the element reaches one burst
  past the last target. That took 89 to 694 milliseconds in the measurement. The lag limit
  keeps it at 0.8 seconds or less, unless the element stalls after the release.

- (Added on 2026-09-25.) In Chrome, the clock of a single step moves at the normal rate
  only 300 to 455 milliseconds after the step, so its sound starts late. The Chrome figures
  come from Chrome on macOS. WebView2 on Windows was not measured.

- (Added on 2026-09-24.) A burst in Chromium plays approximately 15 milliseconds of its 50.
  A measurement in a Chromium browser found that the audio output starts approximately 35
  milliseconds after the `playing` event. A held forward key in WebKit makes sound for
  approximately one eighth of the time. A seek there took 40 to 150 milliseconds in the
  measurement. The element therefore falls behind the steps by more than the continuation
  tolerance, and it seeks again. A stop that reads the media clock of the element, and not
  a timer, is a possible later step.

- (Added on 2026-09-24.) A frame step that the playback store deferred while the
  calibration was open (ADR 022) runs at the anchor, and it requests its one cue there. The
  hidden audio element mounts only after the calibration leaves `calibrating`, so no
  element is attached yet, and that one step is silent. Every later step sounds. Keeping a
  request that arrives before an element is attached is a possible later step.

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
