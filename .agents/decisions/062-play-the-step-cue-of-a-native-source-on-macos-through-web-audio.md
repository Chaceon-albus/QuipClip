# 062. Play the frame step cue of a native source on macOS through Web Audio

- Status: Accepted
- Date: 2026-11-24
- Deciders: capric98
- Amends: ADR 019, ADR 046

## Context

ADR 019 plays the frame step cue of a native source with a hidden `<audio>` element. The
element seeks to the target and plays. The controller pauses it when its `currentTime` reaches
the target plus 50 ms.

On macOS a user reported that a single frame step of an MP4 makes no sound. A held forward key
makes sound after a short time. The unified log of the release application shows the cause.
The measurements come from one session on 2026-11-24. The source was a 1080p60 H.264 MP4 with
AAC. The output was a USB audio interface with an I/O buffer of 4096 frames. The session had
80 single steps and 7 held keys.

1. The seek of the hidden element ended 200 to 380 ms after the step. The controller paused the
   element 50 to 120 ms after the end of the seek.
2. In the GPU process, AVFoundation anchors the timebase of the element. The first sample after
   the seek plays 250 to 265 ms after the end of the seek. The log line is
   `Will reach preroll time 136.108s in 0.264s`.
3. The `currentTime` of the page moves from the end of the seek at the rate of the wall clock.
   The controller therefore saw 50 ms of media time pass before any sample played, and it
   paused the element. No single step made a sound. A held forward key continues the burst for
   more than 250 ms, so its sound started late.
4. A diagnostic session earlier on the same day showed the same timings, so the fault is not
   new.
5. WebKit runs `play()` before the seek task of the element. AVFoundation therefore starts at
   the old position first, and then it seeks.
6. The hidden element loads the whole file. For each exact seek, AVFoundation also prerolls and
   decodes the video track. In 54 s the hidden element made 26,666 `asset:` range requests, 150
   MB in total. The video element made 12,676 requests, 121 MB in total. WebKit writes about six
   lines into the unified log of the application for each request.

The measurement of ADR 019 on 2026-09-25 counted the `played` ranges of the element. Those
ranges follow the same clock, so that measurement could not find this fault.

Chromium moves the clock of an element only when its audio output plays. In Chrome on macOS,
the clock stood almost still for 300 to 455 ms after a seek (ADR 019). The stop rule of ADR 019
therefore counts audible time in Chromium. A single step sounds late, but for its full length.
WebView2 on Windows is Chromium. Nobody measured it.

The PCM cue of ADR 046 plays the bursts of a MediaSource source through Web Audio. The
`AudioContext` runs all the time, so a scheduled buffer plays all its samples after the output
latency of the context. On MPEG-TS and Matroska, that cue reads PCM windows of the audio lane.
Each window is an FFmpeg process with an input `-ss` that decodes 20 s of audio.

## Decision

On macOS, a native source with an audio stream plays its frame step cue through the PCM cue of
ADR 046. Windows keeps the hidden element of ADR 019.

### The cue

- The page creates the cue when the calibration of ADR 003 becomes ready. The cue needs the
  source time of media time 0 of the element. The page calculates it from the calibration
  anchor: the source time of `videoStartPts`, less the media time of the anchor. The playback
  store gives the anchor through `calibrationAnchorMediaTime`, which reads it and changes
  nothing. The page does not use the frame on screen. A navigation that waited for the anchor
  (ADR 022) clears that frame in the same update that makes the calibration ready.
- The cue opens PCM windows of the audio lane with the container value `native`. Such a window
  is the window of MPEG-TS and Matroska. It uses `-copyts` and an input `-ss` relative to the
  container start. Its `aresample` filters put sample 0 at the start of the window.
- The cue requests the PCM at the position of the element when the cue starts. It also requests
  the PCM at each `seeking` event and at each `pause` event of the element. A step that finds no
  PCM waits for it, as in ADR 046.
- The cue starts its `AudioContext` in a pointer gesture or a key gesture. The Mute toggle and
  the volume slider set its gain. Both rules are the rules of ADR 046.
- The page does not mount the hidden `<audio>` element while the Web Audio cue applies. It
  mounts the element in each other case. A calibration that is unavailable gives no source time
  for media time 0, so it keeps the element cue.
- The page reads the media and the anchor when the cue starts. A new import of the open file
  keeps the revision key of the source, so the cue that runs stays.
- The page stops the cue when the element, the source, or the calibration changes. The owner of
  the cue removes it from the router of ADR 046 only while it is the active cue. The owner stops
  its cue in an effect, and the owner of the next source can install its own cue before that
  effect runs.

### The backend

- `open_preview_window` accepts the container value `native` only for the audio lane. A video
  window of a native source is an invalid request.
- A window of a native source needs a file with the size and the modification time of its
  import, as every seek window of ADR 058 does.

## Measurements

1. The test file is an MP4 that FFmpeg made. It holds H.264 at 60 fps with two B-frames, and AAC
   at 44.1 kHz with a tone that starts at 3.0 s. A decode of the whole file put the tone onset at
   3.000083 s. Windows that start at 1.5, 1.9, 2.9 and 3.0 s put it at the same source time,
   with a difference of less than one sample. A Rust test keeps a looser form of this check: it
   makes the same file, and it requires windows that start at 1.5 and 2.9 s to put the onset
   within 1 ms of the onset in the decode of the whole file.

## Rejected alternatives

- **A longer element burst on macOS.** The controller could wait for a fixed start delay after
  the seek before it counts the 50 ms. The delay depends on the output device, and it was 250
  ms on the measured device. A wrong value plays too long or too short. The element also still
  loads and decodes the file a second time.
- **The hidden element through `createMediaElementSource`.** This keeps the second load and the
  second decode of the file. Nobody measured its start delay.
- **The PCM cue on Windows too.** Chromium plays the full burst of the element cue, only late.
  Nobody measured WebView2, and the development machine cannot run it.

## Consequences

- For a single frame step of a native source on macOS, the cue schedules 50 ms of the source
  audio. The sound starts after the output latency of the `AudioContext`. The first step after
  a jump can wait for its PCM window.
- While the calibration is ready, the hidden element does not load the file on macOS. In the
  measured session, the hidden element made about two thirds of the `asset:` requests and of
  the log lines of WebKit. AVFoundation also does not decode the video a second time.
- A native source on macOS runs one FFmpeg process for each PCM window. The page keeps up to
  240 s of PCM, about 23 MB, as ADR 046 does.
- A failed PCM window disables the cue for that source, as in ADR 046. Examples are a file that
  changed after its import (ADR 058) and an FFmpeg that QuipClip no longer finds. The element
  cue does not come back for that source. On macOS that element makes no sound for a single
  step, so a return to it gives little.
- The cue plays the first audio stream of the file (`0:a:0`). The element plays the stream that
  WebKit chooses. Both are the same stream in a file with one audio stream.
- The change has no measurement in the real application yet. A measurement of a single step
  must observe the sound card output or the log of the GPU process. The clock of an element is
  not sufficient.
- Windows keeps the element cue, and its sound starts late in Chromium. Nobody measured
  WebView2.
