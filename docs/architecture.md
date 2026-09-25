# QuipClip architecture

QuipClip is a video editor for Windows and macOS. The user opens a video, marks several
In and Out pairs on one timeline, and exports those segments joined in order. A
command-line `ffmpeg` does the export.

Two requirements shape everything below.

1. **Edit boundaries preserve source presentation timing.** The project stores source
   video PTS values instead of positions on a generated frame grid.
2. **The application does not bundle `ffmpeg`.** It finds the programs, or it asks the user
   and downloads them.

Version 1 edits one source. Several sources come later, and the model already carries the
source key that makes that possible. Multi-track is out of scope and stays out of scope.

## Decision records

Each record states context, decision, and consequences. They are the source of truth. This
document summarizes them and shows how the parts fit together.

| Record                                                                                                                                      | Subject                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`001-tauri-react-typescript-shell.md`](../.agents/decisions/001-tauri-react-typescript-shell.md)                                           | Tauri v2, React 19, TypeScript, Vite, Tailwind 4, shadcn/ui     |
| [`002-rational-time-model.md`](../.agents/decisions/002-rational-time-model.md)                                                             | Source video PTS, exact time bases, half-open segments          |
| [`003-hybrid-preview-decoding.md`](../.agents/decisions/003-hybrid-preview-decoding.md)                                                     | Native preview, proxy fallback, calibrated PTS inference        |
| [`004-single-pass-filter-complex-export.md`](../.agents/decisions/004-single-pass-filter-complex-export.md)                                 | Accurate source seek, timestamp resolution, normalization       |
| [`005-ffmpeg-acquisition.md`](../.agents/decisions/005-ffmpeg-acquisition.md)                                                               | PATH, then app data, then a download the user agreed to         |
| [`006-encoder-capability-probing.md`](../.agents/decisions/006-encoder-capability-probing.md)                                               | List the encoders, then smoke-test them, then cache             |
| [`007-single-track-source-time-timeline.md`](../.agents/decisions/007-single-track-source-time-timeline.md)                                 | One source-PTS timeline with ordered half-open segments         |
| [`008-multi-agent-development-workflow.md`](../.agents/decisions/008-multi-agent-development-workflow.md)                                   | Superseded by ADR 033                                           |
| [`009-incremental-commit-policy.md`](../.agents/decisions/009-incremental-commit-policy.md)                                                 | One reviewed unit, one commit, no push                          |
| [`010-project-file-format.md`](../.agents/decisions/010-project-file-format.md)                                                             | Version 1 JSON with exact source-PTS boundaries                 |
| [`011-localized-interface.md`](../.agents/decisions/011-localized-interface.md)                                                             | English and Simplified Chinese interface with a saved setting   |
| [`012-macos-homebrew-path-discovery.md`](../.agents/decisions/012-macos-homebrew-path-discovery.md)                                         | Homebrew path fallback for macOS GUI applications               |
| [`013-application-settings-file.md`](../.agents/decisions/013-application-settings-file.md)                                                 | One settings file for the ffmpeg path and the export presets    |
| [`014-export-cut-with-trim-after-seek.md`](../.agents/decisions/014-export-cut-with-trim-after-seek.md)                                     | Seeked input, trim on raw source PTS, one process, one output   |
| [`015-windows-atomic-replace-retry.md`](../.agents/decisions/015-windows-atomic-replace-retry.md)                                           | Layered Windows rename with a bounded retry                     |
| [`016-export-orchestration.md`](../.agents/decisions/016-export-orchestration.md)                                                           | One export at a time, one event, a 30-second publication wait   |
| [`017-export-lifetime-across-application-exit.md`](../.agents/decisions/017-export-lifetime-across-application-exit.md)                     | A quit cancels a running export and waits a bounded time        |
| [`018-windows-child-processes-without-a-console.md`](../.agents/decisions/018-windows-child-processes-without-a-console.md)                 | Every child process starts with no Windows console window       |
| [`019-scrub-audio-on-frame-step.md`](../.agents/decisions/019-scrub-audio-on-frame-step.md)                                                 | A frame step plays a short audio burst at the new position      |
| [`020-platform-title-bar-and-export-action.md`](../.agents/decisions/020-platform-title-bar-and-export-action.md)                           | One title bar per platform, with the export action inside it    |
| [`021-window-level-keyboard-shortcuts.md`](../.agents/decisions/021-window-level-keyboard-shortcuts.md)                                     | One window keyboard layer for play and the frame step           |
| [`022-playhead-scrub-display-target-and-coalesced-seeks.md`](../.agents/decisions/022-playhead-scrub-display-target-and-coalesced-seeks.md) | The playhead draws the seek target, and one seek runs at a time |
| [`023-audio-output-controls-in-presets.md`](../.agents/decisions/023-audio-output-controls-in-presets.md)                                   | Audio bitrate, sample rate, and channels in each preset         |
| [`024-export-setup-step.md`](../.agents/decisions/024-export-setup-step.md)                                                                 | The export dialog selects the preset before the save dialog     |
| [`025-background-export-and-progress-display.md`](../.agents/decisions/025-background-export-and-progress-display.md)                       | A hidden export continues, and three places show its progress   |
| [`026-editing-keys-in-the-window-keyboard-layer.md`](../.agents/decisions/026-editing-keys-in-the-window-keyboard-layer.md)                 | The window keyboard layer takes the editing keys                |
| [`027-confirm-a-quit-that-loses-work.md`](../.agents/decisions/027-confirm-a-quit-that-loses-work.md)                                       | A close or a quit that would lose work asks first               |
| [`028-frame-timecode-display.md`](../.agents/decisions/028-frame-timecode-display.md)                                                       | Elapsed time shows as HH:MM:SS:FF by default                    |
| [`029-show-and-open-the-export-output.md`](../.agents/decisions/029-show-and-open-the-export-output.md)                                     | Show and open the export output through its run                 |
| [`030-trim-a-segment-edge-by-dragging.md`](../.agents/decisions/030-trim-a-segment-edge-by-dragging.md)                                     | Trim a segment edge by dragging it                              |
| [`031-order-dialog-buttons-by-platform.md`](../.agents/decisions/031-order-dialog-buttons-by-platform.md)                                   | Order dialog buttons by platform                                |
| [`032-one-frontend-chunk-and-its-size-limit.md`](../.agents/decisions/032-one-frontend-chunk-and-its-size-limit.md)                         | One frontend chunk, with a size warning above 1200 kB           |
| [`033-main-agent-writes-the-code.md`](../.agents/decisions/033-main-agent-writes-the-code.md)                                               | The main agent writes, and another tool runs only on request    |
| [`034-one-application-version-and-its-release-tag.md`](../.agents/decisions/034-one-application-version-and-its-release-tag.md)             | One version in `Cargo.toml`, and one `v` tag for each release   |

## Shape

```
+-------------------------------------------------------------+
|  React frontend                                             |
|                                                             |
|  AppShell -> TitleBar | Preview | Transport | Timeline | Bar |
|                  |          |                    |          |
|  Zustand stores: media, timeline, playback, ffmpeg,         |
|                  settings, export, timeline viewport        |
|                  |                                          |
|  lib/time.ts  (Rational, PTS, checked browser conversions) |
+------------------|------------------------------------------+
                   |  Tauri commands and events
+------------------|------------------------------------------+
|  Rust backend    v                                          |
|                                                             |
|  commands/   the IPC surface                                |
|  ffmpeg/     locate, probe, capabilities, export            |
|  settings/   the settings file                              |
|  fsutil.rs   atomic file replacement                        |
|  procutil.rs child processes without a console window       |
|  project/    the .qcproj file                               |
|  time.rs     Rational and decimal-string timestamp types    |
+------------------|------------------------------------------+
                   |  process
                   v
              ffmpeg / ffprobe
```

Rust owns every operation that touches the file system, starts a process, or downloads a
file. The frontend owns presentation and the edit state.

## Localization

See ADR 011.

ADR 011 requires the localization feature to support English and Simplified Chinese. The
feature must bundle `en` and `zh-CN` message catalogs with the application. It must use
`i18next` for message lookup and formatting, and `react-i18next` for React integration.

The feature must persist an application setting with the value `system`, `en`, or
`zh-CN`. The setting must not be part of a `.qcproj` file. The default value is `system`.
When the setting is `system`, the frontend must examine `navigator.languages` in order. It
must select `zh-CN` when the first supported primary subtag is `zh`. It must select `en`
when that subtag is `en`. It must use `en` when no entry matches. A change to the language
setting must update the interface without an application restart.

React must translate application text from stable semantic keys. Rust and Tauri commands
must return stable error codes and named values instead of user-facing sentences. The
frontend must translate these application errors. It may append unchanged operating-system
or `ffmpeg` diagnostic text to a localized error.

Number, date, and list formatting must use `Intl` with the resolved locale. Media elapsed
time, file paths, technical identifiers, and raw `ffmpeg` output keep their defined format.

English must be the source and fallback language. New messages must use named placeholders.
Components must not assemble sentences from translated fragments. The independent review
that ADR 033 requires must also check new or changed English and Simplified Chinese text.

## Time

See ADR 002. This is the foundation. Everything else depends on it.

`Rational { num, den }` is the canonical Rust rational type. It crosses the IPC boundary
as `{"n": ..., "d": ...}`. A video time base gives seconds per stream tick.

Rust defines distinct `Pts`, `TickCount`, and `FrameCount` types. TypeScript defines the
corresponding branded types. These integer values cross JSON as canonical decimal strings.
This rule preserves the full signed `i64` PTS range.

Each segment stores `[inPts, outPts)` in the video stream named by `sourceId`. `inPts` is
inclusive. `outPts` is the PTS of the first excluded presented frame. The exact duration is
`(outPts - inPts) * videoTimeBase`.

`videoDurationTicks` is source-extent metadata. It is not the end boundary of the final
presented frame. `approximateDurationSeconds` can support UI layout and browser seek
requests only. Neither duration value can create an edit boundary.

TypeScript uses `BigInt` and exact rationals for canonical calculations. It converts to a
JavaScript number only for browser APIs and pixel layout. Checked conversion helpers reject
non-finite values, unsafe integer conversions, and invalid media times.

Raw PTS values from different sources are unrelated. Multi-source cumulative output
positions use exact rational durations or exact rescaling to a runtime common time base.
QuipClip does not persist a project timeline time base or segment timeline starts.

The output frame rate is `renderSettings.frameRate`. It is a future render setting. It
does not define edit positions. The UI shows source-relative elapsed time as
`HH:MM:SS:FF` by default, with frames from the nominal rate for display and for typed
timecode navigation only, and as `HH:MM:SS.mmm` when the user chooses it or the source has no
single nominal rate (ADR 028).

## Preview

See ADR 003.

An HTML5 `<video>` element plays the file over the Tauri asset protocol. The element
supplies audio and keeps sound and picture together.

The asset protocol is off by default. It needs an entry in `tauri.conf.json`, a `media-src`
entry in the CSP, and a scope that Rust extends for each file the user opens, and for that
file only. A file drop is the exception: Tauri itself adds every dropped file and
folder to the scope. ADR 003 records why the application accepts that.

The two target web views decode different codec sets. The planned proxy fallback will use
probe metadata, `canPlayType()`, and the media error event to detect unsupported native
decoding. FFmpeg will then create a compatible proxy in the application data directory.

A proxy must preserve the source timing mapping or supply an explicit map to source PTS.
Proxy state and paths are runtime cache data. They do not enter the project file.

The first `requestVideoFrameCallback` after source load supplies a browser `mediaTime`
anchor. QuipClip associates that value with `videoStartPts`. Later callbacks confirm the
browser-presented frame and its `mediaTime`. QuipClip infers source PTS through the
calibrated mapping. RVFC does not report raw FFmpeg PTS.

Version 1 precise editing assumes a continuous, linear, slope-one mapping between the
browser timeline and source PTS. It also assumes that separately editable presented frames
have distinguishable timestamps. A detected duplicate inferred PTS disables precise
editing for that source.

Media without `start_pts` can still play. Missing `start_pts`, missing RVFC support, or an
invalid conversion disables precise edit actions. Browser `currentTime` then supplies an
explicitly approximate display and seek fallback, for the preview timecode and for the timeline
playhead alike. The status bar and a badge beside the preview timecode name the position as
approximate. Their tooltips, and the tooltips of the disabled mark buttons, explain why the
mark actions are unavailable.

Two questions look like one, and one predicate must not answer both. Which clock supplies
the number is answered by `isPlaybackPositionApproximate`, which is also true for the one
frame interval between a seek and the callback that answers it, because the store never
updates the inferred PTS optimistically. Whether the interface marks the position for the
user is answered by the calibration status alone. The preview badge and the status bar both
take the second answer. A mark that took the first appeared and disappeared on every frame
step, at the rate of the key repeat, and reported a condition that was over before the user
could read it. Only `unavailable` shows the approximate warning. While the calibration is
still open, the status bar shows a neutral "Preparing the preview…" chip after a short
delay, and a navigation in that time is deferred until the first frame (ADR 022).

The browser clock is a position on the browser media timeline, which does not always start at
zero, while every other value on the ruler is elapsed time from the start of the source. The
playback store therefore subtracts the timeline origin it reads at `loadedmetadata` before it
publishes the value, and adds it back for an approximate seek, so both axes agree. That origin
is the same reading the calibration anchor guard already trusts. QuipClip does not use
`seekable.start(0)` as the source timestamp origin.

V1 navigation buttons step by a nominal frame interval. They use `avg_frame_rate`, then
`r_frame_rate`. On a calibrated source with a constant rate and a fine time base, a step aims
at the middle of the next nominal frame, because a container can round the real frame start
past its nominal start (ADR 022). RVFC reports the frame that the browser actually presented.
Exact adjacent frame stepping needs future frame-boundary discovery or another decoder.

A frame step also plays a short piece of the sound at the new position, because the picture
alone frequently does not identify the correct frame. A second, hidden `<audio>` element
carries the same asset URL as the preview element. One controller in
`src/features/playback/scrubAudio.ts` seeks that element and plays 50 milliseconds of its
media. `seekNominal` starts a burst, and so does a scrub seek during a drag of the playhead
(ADR 022). Every other playback action stops one, so a cue and the real playback never
sound together.

The controller stops the element when its media clock reaches one burst past the latest
target. A timer is not correct, because the clock of Chrome can stand almost still for 300
to 455 milliseconds after a seek. The controller reads the clock only after the `seeked`
event of the burst and the `playing` event, in either order. A held key that steps forward
extends the current burst instead of a restart, while the element plays no more than 0.75
seconds behind the target, so a hold near real time sounds continuous. A drag keeps the
sound within 0.1 seconds of the pointer.

The element is mounted only for a source that has an audio stream, only while the playback
store reports that it is attached to that same source revision, and only after the
calibration status leaves `calibrating`. The identity test is what makes the gate correct:
the render that first carries a new source still holds the store state of the previous one,
so a boolean is stale exactly when it decides. The element therefore cannot delay the
calibration anchor. See ADR 019.

The playhead draws the target of the last seek request at once, before the video presents
the frame. That target is for display only. The edit actions still wait for RVFC, so a mark
always writes the PTS of the presented frame. The playback store runs one element seek at a
time: a request that arrives while the element seeks replaces the queued request, and the
`seeked` event starts it. Each seek therefore completes, and the picture changes during a
drag. A drag uses `fastSeek` where the web view has it, and the release always ends with an
exact seek. See ADR 022.

The current _Source_ preview plays the whole file. A future _Program_ preview will play
only the segments, so the user can watch what the export will contain.

## Export

See ADR 004 and ADR 014.

ADR 004 gives the semantic steps. ADR 014 selects the command shape from measurements on
ffmpeg 9.0.1. ADR 016 adds the orchestration. The renderer is written, and `start_export`,
`cancel_export`, and `cancel_active_export` are registered commands. After a run finishes,
`reveal_export_output` and `open_export_output` show or open the file that the run wrote.
They take the run identifier, never a path (ADR 029).

One `ffmpeg` process writes one output. One `-copyts`, placed once before the first input,
keeps the raw source PTS visible to the filter graph on every input. The renderer seeks each
input to `inPts * videoTimeBase - formatStartTime - SEEK_MARGIN_SECONDS`, clamps that value
at zero, and omits `-ss` when the result is zero. Each segment chain cuts with `trim` and
`atrim` on those raw PTS values. Each audio chain pins its input link to the source sample
rate with an `aformat` before `atrim`. Under the second shape below, that pin is emitted once,
in front of `asplit`, because the chains share one input link. Each chain then resets the timestamps and normalizes
the streams. The chains end in `concat`, in project array order.

The renderer has two graph shapes. It opens one input for each segment while the assembled
command line stays inside the platform budget. It otherwise opens one input, seeks once, and
divides that input with `split` and `asplit`.

The final `aformat` of each audio chain takes its sample rate and its channel layout from the
preset (ADR 023). The value `source` selects the rate of the source stream, or omits the
layout option. The leading `aformat` still pins the input link at the source rate. When an
encoder cannot accept the requested format, ffmpeg converts the samples in front of it.

The export action opens the export dialog at a setup step (ADR 024). The flow controller
first examines the running export, the media, the segments, and the source revision. The
setup step then shows the presets, with the active preset selected, and a summary of the
selected preset. "Export…" opens the native save dialog with the extension of that preset's
container. A cancel there returns to the setup step. An export with a preset that is not
active saves that preset as the active preset, and a failed save does not stop the export.

One export runs at a time, and a second request is refused. A cancel that arrives during the
encode kills the child at the next poll. A cancel is also tested twice where it decides
publication: once before `ffmpeg` starts, and once after the process exits and before the
rename. See ADR 016.

An application exit cancels a running export and waits a bounded time for it to end, so a quit
does not leave `ffmpeg` encoding into a temporary file that nothing will remove. See ADR 017.

A close or a quit that would lose work asks first (ADR 027). The window close and the
custom macOS Quit item both reach one frontend decision. It asks when segments, a pending In
point, an active export or an unsaved preset draft would be lost, and otherwise it quits at
once through the `confirm_quit` command. Opening another video over one with segments also
asks. Exits that cannot be prevented, such as the Dock Quit or a logout, still cancel the
export and wait.

A dismissal of the export dialog during an active run hides the dialog. It does not cancel
the run (ADR 025). Only the Stop Export button cancels, and a run of 30 seconds or more
needs a second click to confirm. While the dialog is hidden, the status bar
shows the progress of the run, and then its result until the user dismisses it. The Dock on
macOS and the task bar on Windows also show the progress. The percent and the time estimate
come from the frame count and the `fps` value of `-progress`, and one presenter computes them
for every display. One `ProgressBar` component in `src/components/common/` draws every bar.

The seek supplies the speed. The trim supplies the exactness. An input seek alone is not
frame-exact: on MPEG-TS a seek lands only on key frames, and it can land after the target.
A seek that lands before the target lets `trim` cut the selected frames.

Boundaries stay integer ticks. `trim` takes `start_pts` and `end_pts`, which match the
half-open interval of ADR 002 exactly. The `start` and `end` options are not used, because
FFmpeg truncates them to microseconds.

Progress reads the `frame` field of `-progress pipe:1`. `out_time_us` is wrong when the
command sets `-copyts`. The renderer compares the final frame count against an exact
expected count, and it reports a mismatch instead of writing an incorrect cut.

Version 1 writes constant-frame-rate output. Output frame-rate conversion, scaling, codec
conversion, and audio resampling belong only to this render layer. They never change stored
source edit points.

## ffmpeg lifecycle

See ADR 005, ADR 006, and ADR 012.

Resolution order: the configured path, then `PATH`, then `<app_data>/bin`. ADR 005 adds a
fourth step, a download the user agreed to. That step is not implemented.
`app_data_dir()` from the Tauri path API already follows the Windows and the macOS
convention, so no code builds those paths by hand.

On macOS, the `PATH` lookup appends `/opt/homebrew/bin` and `/usr/local/bin` after the
directories from the process `PATH`. This rule lets GUI applications find a standard
Homebrew installation without starting a login shell.

ADR 005 specifies a download manifest that pins a URL and a SHA-256 per target, because the
Windows build server publishes no macOS asset. Neither the manifest nor the installer exists
yet.

After the programs resolve, a background job finds out which encoders work. It lists them,
then runs a fraction-of-a-second encode with each candidate, because a listed hardware
encoder fails on a machine without that hardware. The tests run one after another, because
two hardware tests that run together compete for the same encoder hardware. One lock holds
one test at a time for the whole application, so two runs never test an encoder at the same
time. The lock is not a phase lock: two runs interleave their tests, and each test still runs
alone.

The job reports through one Tauri event named `ffmpeg:capability-probe`. Each payload
carries the `runId` that the starting command returned. The backend does not cancel a
superseded run. The frontend discards each event that carries a stale `runId`.

The result caches in `<app_data>/capabilities.json`. That file holds a list of entries, and
each entry holds one cache key, one probe time, and one report. The key is the binary path,
version, size, and mtime. The list holds at most eight entries. The application removes the
oldest by probe time. Each writer merges its own entry into the current file under a lock,
then renames a temporary file into place, so a late write keeps the entries that another
run wrote.

Discovery reads the configured path from the settings file first, and then it falls back to
`PATH` and the application data directory. The failure payload names each inspected
`ffmpeg` and `ffprobe` candidate with
its origin class, so the user sees where the application looked. The job runs two of the
four listings. `-decoders` and `-filters` have parsers and tests, and they gain their
command when the preview proxy and the export renderer need them.

## Settings

See ADR 013.

`<app_data>/settings.json` holds the configured ffmpeg path, the export preset library, and
the identifier of the active preset. Rust owns the file, because Rust reads the path during
discovery and ADR 001 gives Rust the file system.

A preset names a container, a video encoder, an audio encoder, one quality control, and an
output resolution and frame rate. Each output setting is the word `source` or an explicit
value. The container set is closed. The encoder names are free text, because the capability
probe discovers what the installed build offers, but each name must read as a name and not
as an ffmpeg flag.

ADR 023 adds three audio settings to a preset: a bitrate in kilobits per second, a sample
rate, and a channel setting. The bitrate is optional, and without it the encoder uses its own
default. The sample rate is `source` or a value in hertz. The channel setting is `source`,
`stereo`, or `mono`. A file from before ADR 023 reads as 48000 Hz stereo with no bitrate,
which is the output that export wrote before. The editor disables the bitrate for the
lossless encoders `flac` and `alac`. It refuses a preset that pairs `mov` with `flac` or
`libopus`, because the `mov` muxer refuses both.

A missing file seeds presets in memory and writes them on the first save. The seeded
identifiers are constants. The restore action replaces a seeded preset by identifier and
keeps everything else, including the ffmpeg path.

A damaged file fails the read, and a save refuses to write over a file it could not read.
Losing a preset library is not the same as losing a cache entry. A separate permissive
reader takes only the ffmpeg path, so one damaged preset never makes the application report
a missing ffmpeg.

The language preference stays in the web view store that ADR 011 defines. It is interface
state, and Rust never reads it.

## Edit model

See ADR 007.

The types below show the runtime source and the persisted project document. ADR 010 omits
the proxy state from the persisted source. A proxy is a machine-specific cache.

```ts
type Rational = { n: number; d: number };
type Pts = string & { readonly __brand: "Pts" };
type TickCount = string & { readonly __brand: "TickCount" };
type FrameCount = string & { readonly __brand: "FrameCount" };

type PersistedSource = {
  id: string;
  path: string;
  relPath: string;
  size: number;
  mtime: number;
  videoStreamIndex: number;
  videoTimeBase: Rational;
  videoStartPts: Pts | null;
  videoDurationTicks: TickCount | null;
  approximateDurationSeconds: number | null;
  avgFrameRate: Rational | null;
  rFrameRate: Rational | null;
  reportedFrameCount: FrameCount | null;
  proxy?: never;
};

type Source = Omit<PersistedSource, "proxy"> & {
  proxy?: { path: string; state: "none" | "building" | "ready" | "failed" };
};

type Segment = {
  id: string;
  sourceId: string;
  inPts: Pts; // inclusive
  outPts: Pts; // exclusive
};

type Project = {
  schemaVersion: 1;
  renderSettings: {
    frameRate: Rational;
    resolution: { w: number; h: number };
  };
  sources: PersistedSource[];
  segments: Segment[]; // export order is array order
  activeSourceId: string;
};
```

The timeline axis is the active source's elapsed presentation time. It paints only segments
that reference that source. The global segment array keeps the future export order.

The ruler uses `videoDurationTicks` first. It then uses a valid approximate probe duration,
then a finite browser duration. If none exists, the ruler is indeterminate and disables
absolute click seeking. Approximate seeking never creates project state.

Mark In stores the inferred PTS of the displayed frame. Mark Out stores the current PTS as
the first excluded frame. Split creates adjacent half-open segments. Exact inclusion of the
final source frame needs discovery of its following boundary.

One segment is current, and every edit action names it rather than inferring a target from the
playhead. Mark In and Mark Out adjust its boundaries; Finish Segment ends it so the next Mark In
starts a fresh one; clicking a segment makes it current; Delete Segment removes it and leaves
nothing current. Segments may therefore overlap without ambiguity. While a current segment
resolves, there is no pending In mark. See ADR 007.

`Source.id` is stable project identity. A separate revision key of path, size, and
modification time drives runtime invalidation and the replacement warning. The generated
source id is keyed by that revision key, so a file changed in place becomes a new source and
the segments marked against the old one stop matching it. Source or revision changes do not
erase canonical segments: they stay in the project array, and they stop belonging to the
active source.

Before an export, the frontend re-reads the file's size and modification time through a
stat-only command that runs no `ffprobe`, and compares them against the revision the segments
were marked against. A mismatch raises a confirmation the user can override, because a change
that altered no frame timing is possible and only the user knows. A read that fails is not a
mismatch: a deleted file, a path that is no longer a regular file, and a share that stopped
answering are each already reported by the export preflight with their own codes.

The frontend explicitly projects each runtime `Source` into `PersistedSource`. The
projection lists each persisted field. It does not use object spread as a serialization
filter.

The project file is `.qcproj`, which is versioned JSON. See ADR 010. The document stores
absolute and relative source paths, and it stores `activeSourceId`. Runtime proxy and browser
state do not enter the file.

Version 1 writes no project file. The user imports the sources in each session, so the
segments last for one session, and the export presets live in the settings file instead. Rust
keeps `load_project` and `save_project` registered, and nothing calls them.

The unreleased schema remains version 1 after this direct replacement. Old frame-grid
version 1 files fail normal structural validation. QuipClip has no migration or legacy
shape detector for them.

## Repository layout

```
AGENTS.md              rules an agent follows here
CLAUDE.md              imports AGENTS.md
docs/architecture.md   this file
docs/releasing.md      the steps of a release
.agents/decisions/     one record per decision
.agents/skills/        dev-workflow, and two skills as git submodules
.claude/skills/        symlinks into .agents/skills, so Claude Code finds them
scripts/               the version script and the release asset list
src/                   React frontend
src-tauri/             Rust backend
```

Assets live in fixed places. The icon master is `src/assets/brand/app-icon.svg`. The
`pnpm icons` command regenerates the desktop icon files in `src-tauri/icons/` from that
SVG. The palette is `src/styles/globals.css`.

The theme preference (System Default, Light, Dark) lives in the web view store beside the
language. `public/theme-init.js` is a plain script in the `<head>` that applies it before the
first paint, so a dark theme never flashes light. It must stay a same-origin file loaded
before the stylesheet: the CSP allows no inline script. It repeats the resolve rule of
`src/lib/theme.ts`, and a test runs both and compares them.

The shadcn output in `src/components/ui/` is generated code, but some of its files carry
hand edits. Each edit has a `QuipClip: hand-edited` comment that gives the reason. A
regeneration overwrites these edits, so merge them back by hand after one. The shadcn
registry now emits an import of an extra npm package, so a new primitive is built on the
`radix-ui` package in `src/components/common/` and is not generated.

## Build and check

```bash
pnpm install
pnpm tauri dev
pnpm format:check
pnpm lint && pnpm typecheck && pnpm build && pnpm test
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

The `dev-workflow` skill states the commit gate, in section 5, and it is the only
normative copy. `cargo test` is part of that gate when a unit changed any file under
`src-tauri/`. Continuous integration runs every command above on `windows-latest` and
`macos-latest`, for every push to `main` and every pull request. The release workflow runs
the same checks on each release tag.

TypeScript is held at 5.9, because `typescript-eslint` caps its peer range below 6.1.

## Version and release

See ADR 034.

`src-tauri/Cargo.toml` holds the only copy of the application version. `tauri.conf.json`
and `package.json` have no `version` field, so Tauri reads the version from `Cargo.toml`.
`scripts/version.mjs` shows, checks, and bumps the version, and a Vitest test runs its check
on the repository. The release tag is `v` and the version.

The push of a release tag starts `.github/workflows/release.yml`. It checks the tag, runs
`ci.yml` on the tagged commit, and builds the macOS and Windows bundles with a token that
can only read. A second job attaches the bundles to a draft release. It checks the asset
names and their SHA-256 digests against `scripts/release-assets.mjs`. The last job runs
in the `release` environment. It checks the draft and the tag again, and publishes the
draft as an immutable release. `tauri.macos.conf.json` gives the macOS bundle an ad-hoc
signature. `docs/releasing.md` gives the setup, the steps of a release, and what to do
when a job fails.
