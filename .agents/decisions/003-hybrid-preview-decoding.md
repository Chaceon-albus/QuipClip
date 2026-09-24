# 003. Preview with the native video element and infer source PTS from RVFC

- Status: Accepted
- Date: 2026-08-31
- Deciders: capric98

## Context

Tauri uses the operating system web view. WebView2 and WKWebView support different media
formats. The native `<video>` element supplies audio playback and synchronization, but it
does not expose FFmpeg's raw source PTS.

`requestVideoFrameCallback` reports that the browser presented a frame. Its `mediaTime`
belongs to the browser media timeline. The browser can normalize or linearize the source
timeline. A callback can also be late or skipped.

QuipClip needs a defined mapping from a browser-presented frame to the source video PTS.
It must also support playback when ffprobe does not report `start_pts`.

## Decision

Use the native `<video>` element when the web view can decode the source. Use an FFmpeg
proxy when the web view cannot decode it.

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

(Found on 2026-09-23.) One exception exists, and the application does not cause it. The
window config sets `dragDropEnabled`, so Tauri takes native file drops. On each drop,
Tauri 2.11 itself adds every dropped file to the asset scope, and every dropped folder
recursively, before it sends the drop event to the page (`manager/window.rs`). The scope
API can add and forbid paths, but it cannot remove an added path. A forbid rule would also
block a file that the user opens from that folder later. The application therefore
accepts this grant. The asset protocol serves files only to this web view, and the CSP
loads no remote script. The grant lasts until the application exits.

### Decode check

The ffprobe result supplies the container, video codec, profile, pixel format, and bit
depth for a native-decode preflight. `canPlayType()` and the `video.error` event check the
decision at runtime.

(Added on 2026-09-23.) A third runtime signal covers a web view that plays the sound of a file
but decodes no picture and fires no error, as WebView2 does for HEVC without the codec
extension. When the element reports a width of 0 at `loadedmetadata` while the probe reports
a picture, the pane waits before it marks the source ready. A `resize` with a width, or a
presented frame, proves a picture. After 1.5 seconds, frame data with a width of 0 fails the
source. With no frame data, the pane waits again, and at 6 seconds it takes the ready path, as
it did before this check. The failure panel names what failed: the codec, a container that
the platform does not open, or a file that could not be read.

### PTS calibration

QuipClip calibrates each preview source when it loads:

1. Load the source at its beginning.
2. Disable edit actions during calibration.
3. Register `requestVideoFrameCallback` before a user can seek.
4. Use the first presented callback as the browser calibration anchor.
5. Associate its `mediaTime` with the source's `videoStartPts`.

For a later callback, infer the source PTS with this formula:

```text
videoStartPts + round((mediaTime - calibratedMediaTime) / videoTimeBase)
```

RVFC confirms the presented browser frame and its `mediaTime`. RVFC does not confirm the
raw source PTS. QuipClip infers the source PTS through the calibrated mapping.

V1 precise PTS editing supports a source only under these assumptions:

- The browser timeline and source PTS timeline have a continuous, linear, slope-one
  mapping.
- The first calibration callback represents the frame identified by `videoStartPts`.
- Separately editable presented frames have distinguishable presentation timestamps.

If distinct RVFC `mediaTime` values infer the same source PTS, QuipClip disables precise
editing for that source. It does not synthesize a frame ordinal. An increased
`presentedFrames` counter alone does not prove that the presentation timestamp changed.

Calibration has three states: `calibrating`, `ready`, and `unavailable`. Missing RVFC
support, missing `videoStartPts`, invalid timing metadata, an unsafe numeric conversion,
or indistinguishable timestamps makes calibration unavailable. Playback remains
available. Browser `currentTime` can drive an approximate clock, but it cannot create an
edit point.

QuipClip does not use `seekable.start(0)` as a source timestamp origin.

(Changed on 2026-09-24.) While calibration is `calibrating`, no action of the playback store
moves the element. A frame step, a ruler click, a seek to a stored PTS, Home, End and the
Go to In and Go to Out keys are deferred until the first frame callback takes the anchor
(ADR 022), and play does not seek. The anchor is therefore always the first frame after the
load. The store still records a seek that reached the element before the anchor, and the
anchor guard still refuses the anchor after it, as a defence.

A deferred navigation cannot wait for ever. While one waits, the preview counts the time
that the window is visible. When no frame arrives within 8 seconds of visible time, the
preview reports frame callbacks as unavailable, calibration becomes `unavailable` for that
attachment, and the deferred request runs on the approximate clock. With nothing deferred,
calibration waits for its first frame with no limit, so a slow first frame or the first
frame of playback can still take the anchor.

### Seeking and nominal navigation

To seek to a stored PTS, QuipClip applies the inverse calibrated mapping. It requests the
browser time and waits for RVFC. The callback identifies the browser-presented frame.
QuipClip then infers the displayed source PTS.

All browser-number and PTS conversions use the checked helpers from ADR 002. A failed
conversion disables precise seeking. Code must not update an inferred PTS optimistically
after it assigns `currentTime`.

V1 does not promise exact adjacent-frame stepping. The navigation buttons request a
nominal frame interval. They use valid `avg_frame_rate` first and valid `r_frame_rate`
second. They disable the hint when neither rate is valid. RVFC then reports the frame that
the browser presented. A future frame index, WebCodecs decoder, or native decoder can add
exact neighboring-frame navigation.

### Proxy timing

A proxy is a runtime cache. Its path and generation state do not enter the project file.
The proxy must preserve the source timeline mapping or provide an explicit mapping back
to source PTS. Proxy PTS values cannot silently replace source PTS values.

FFmpeg writes a proxy under the application data proxy directory. The cache key includes
the source path, size, modification time, and generation settings. A sidecar records the
same source revision and any source-to-proxy timing map. QuipClip rejects a proxy when the
sidecar or source revision does not match.

The cache needs a size limit and a clear-cache action. Proxy generation can use H.264,
YUV 4:2:0, AAC, fast-start metadata, and a bounded keyframe interval for browser
compatibility. It must not restore the obsolete CFR project-frame-grid conversion.

### Preview modes

Source preview plays the active source. Program preview plays the ordered segments and
seeks across excluded source ranges.

## Consequences

- Most supported files play without a proxy build.
- Media without `start_pts` can play, but precise PTS editing stays unavailable.
- Browser presentation and inferred source PTS remain separate runtime concepts.
- Exact frame adjacency and final-frame boundary discovery remain future work.
- Proxy generation must preserve or explicitly map source timing.
- The UI must identify approximate playback state and disable edit actions in that state.
