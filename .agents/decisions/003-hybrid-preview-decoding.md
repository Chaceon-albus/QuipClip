# 003. Preview with the native video element, and use an ffmpeg proxy when it cannot decode

- Status: Accepted
- Date: 2026-08-29
- Deciders: capric98

## Context

The preview must play with audio, seek to an exact frame, and step one frame at a time.
Tauri uses the operating system web view. The two web views decode different codecs.
WebView2 decodes what Media Foundation decodes. WKWebView decodes what AVFoundation
decodes. Neither decodes ProRes, most 10-bit formats, or many camera codecs.

Three options exist:

- **The native `<video>` element only.** It is the least work. It gives audio and sound
  synchronization for free. It fails on any file the web view cannot decode.
- **Decode every frame in Rust and paint a canvas.** It is exact. The application must then
  also buffer and synchronize audio by hand.
- **A hybrid.** Play with `<video>` when the web view can decode the file. Build a
  normalized proxy with ffmpeg when it cannot.

A second problem is independent of the codec. A seek to an exact frame boundary can land on
either neighbouring frame, because the boundary instant touches both.

## Decision

Use the hybrid.

### Playback

Feed an HTML5 `<video>` element from `convertFileSrc()` over the Tauri asset protocol. The
element supplies audio and keeps sound and picture together.

The asset protocol is off by default. The application must set all of this:

- `app.security.assetProtocol.enable = true` in `tauri.conf.json`.
- A `media-src` entry in the CSP that permits `asset:` and `http://asset.localhost`.
- An empty static `scope`. The user opens an arbitrary file, so a static glob cannot cover
  it.

Rust extends the scope for each file the user opens, with
`asset_protocol_scope().allow_file(path)`, and for that file only. The application never
opens the scope to a directory.

### Decode check

After import, the ffprobe result decides whether the web view can decode the file:
container, video codec, profile, pixel format, and bit depth. `canPlayType()` and the
`video.error` event confirm the decision at run time.

### Proxy

When the web view cannot decode the file, ffmpeg writes a proxy to
`<app_data>/proxies/<hash>.mp4`:

```
-vf fps=<project timebase>,format=yuv420p
-c:v libx264 -preset veryfast -crf 20 -g <round(fps)> -sc_threshold 0
-c:a aac -movflags +faststart
```

`-g` counts frames, so `-g round(fps)` is a **one-second** keyframe interval. Measured on
ffmpeg 9.0.1 with a 600-frame 30000/1001 clip: `-g 30` gives 19 keyframes, and a seek
therefore decodes at most one second of frames. An all-intra proxy, `-g 1`, gives 599
keyframes of 600 and a file 10 times larger. The one-second interval is the better trade,
and the GOP length is the knob to turn if scrubbing feels slow.

Do not pass `-keyint_min 1`. It does nothing here, because `-sc_threshold 0` already
disables scene-cut keyframes, and `keyint_min` only constrains those.

A sidecar JSON file records the source path, size, mtime, and hash, so the cache can tell a
stale proxy from a good one.

### Frame stepping

Seek to the middle of the target frame:

```
currentTime = (frame + 0.5) * den / num
```

Frame `k` covers `[k/fps, (k+1)/fps)`. The midpoint is inside exactly one frame, so the
seek cannot land on a neighbour.

### Readback

`requestVideoFrameCallback` reports `mediaTime` for the frame the browser painted. Convert
it back with

```
frame = floor((mediaTime - startTime) * num / den)
```

computed as a rational. `startTime` is the first presentation timestamp of the source,
which is not always zero. Show the resulting index, and log a warning when it differs from
the requested index. Drift then becomes visible instead of silent.

`requestVideoFrameCallback` needs Chromium 83 or later, and Safari 15.4 or later. Safari
15.4 means **macOS 12.3**, which is therefore the minimum macOS version for QuipClip.
WKWebView follows the system WebKit, so an older macOS cannot get the callback. Guard the
call anyway. Without it, the fallback is the `seeked` event plus `video.currentTime`, which
is coarser and cannot confirm which frame was painted.

### Two preview modes

*Source* plays the whole file. *Program* plays only the segments and moves `currentTime`
across the gaps, so the user watches what the export will contain.

## Consequences

- Most files play with no wait and no disk cost.
- A file the web view cannot decode needs a proxy build before the user can edit it. The
  interface must show that state and must not block on it.
- The proxy directory grows. The application needs a size limit and a command to clear it.
- Seeking a large file over the asset protocol is a known risk in Tauri. If range requests
  prove unusable, the fallback is to serve the media from a local HTTP server that the
  application starts and binds to the loopback address.
- ADR 004 states which file the export reads. The preview and the export must read the same
  file, or the frame indices do not mean the same thing.
