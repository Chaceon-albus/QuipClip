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

| Record                                                                                                      | Subject                                                       |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`001-tauri-react-typescript-shell.md`](../.agents/decisions/001-tauri-react-typescript-shell.md)           | Tauri v2, React 19, TypeScript, Vite, Tailwind 4, shadcn/ui   |
| [`002-rational-time-model.md`](../.agents/decisions/002-rational-time-model.md)                             | Source video PTS, exact time bases, half-open segments        |
| [`003-hybrid-preview-decoding.md`](../.agents/decisions/003-hybrid-preview-decoding.md)                     | Native preview, proxy fallback, calibrated PTS inference      |
| [`004-single-pass-filter-complex-export.md`](../.agents/decisions/004-single-pass-filter-complex-export.md) | Accurate source seek, timestamp resolution, normalization     |
| [`005-ffmpeg-acquisition.md`](../.agents/decisions/005-ffmpeg-acquisition.md)                               | PATH, then app data, then a download the user agreed to       |
| [`006-encoder-capability-probing.md`](../.agents/decisions/006-encoder-capability-probing.md)               | List the encoders, then smoke-test them, then cache           |
| [`007-single-track-source-time-timeline.md`](../.agents/decisions/007-single-track-source-time-timeline.md) | One source-PTS timeline with ordered half-open segments       |
| [`008-multi-agent-development-workflow.md`](../.agents/decisions/008-multi-agent-development-workflow.md)   | Delegated writing, independent review                         |
| [`009-incremental-commit-policy.md`](../.agents/decisions/009-incremental-commit-policy.md)                 | One reviewed unit, one commit, no push                        |
| [`010-project-file-format.md`](../.agents/decisions/010-project-file-format.md)                             | Version 1 JSON with exact source-PTS boundaries               |
| [`011-localized-interface.md`](../.agents/decisions/011-localized-interface.md)                             | English and Simplified Chinese interface with a saved setting |
| [`012-macos-homebrew-path-discovery.md`](../.agents/decisions/012-macos-homebrew-path-discovery.md)         | Homebrew path fallback for macOS GUI applications             |

## Shape

```
+-------------------------------------------------------------+
|  React frontend                                             |
|                                                             |
|  AppShell -> TitleBar | Preview | Transport | Timeline | Bar |
|                  |          |                    |          |
|  Zustand stores: media, timeline, playback, ffmpeg, export  |
|                  |                                          |
|  lib/time.ts  (Rational, PTS, checked browser conversions) |
+------------------|------------------------------------------+
                   |  Tauri commands and events
+------------------|------------------------------------------+
|  Rust backend    v                                          |
|                                                             |
|  commands/   the IPC surface                                |
|  ffmpeg/     locate, download, probe, capabilities, export  |
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
Components must not assemble sentences from translated fragments. When `agy` is available,
Gemini must check and polish new or changed English and Simplified Chinese text. This
language review is additional to the independent review that ADR 008 requires.

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
`HH:MM:SS.mmm`.

## Preview

See ADR 003.

An HTML5 `<video>` element plays the file over the Tauri asset protocol. The element
supplies audio and keeps sound and picture together.

The asset protocol is off by default. It needs an entry in `tauri.conf.json`, a `media-src`
entry in the CSP, and a scope that Rust extends for each file the user opens, and for that
file only.

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
explicitly approximate display and seek fallback. QuipClip does not use
`seekable.start(0)` as the source timestamp origin.

V1 navigation buttons request a nominal frame interval. They use `avg_frame_rate`, then
`r_frame_rate`. RVFC reports the frame that the browser actually presented. Exact adjacent
frame stepping needs future frame-boundary discovery or another decoder.

The current _Source_ preview plays the whole file. A future _Program_ preview will play
only the segments, so the user can watch what the export will contain.

## Future export

See ADR 004.

Export is not implemented yet. The stored model supports a future renderer with these
semantic steps for each segment:

1. Resolve `sourceId` to the original media.
2. Seek before `inPts` as an optimization.
3. Decode accurately through the selected interval.
4. Resolve source PTS boundaries into FFmpeg's actual post-seek timestamp domain.
5. Keep the half-open interval and derive the matching audio interval.
6. Reset local timestamps and normalize the streams.
7. Concatenate segments in project array order.

ADR 004 does not select a raw `trim` expression or a fixed placement for input `-ss`.
Output frame-rate conversion, scaling, codec conversion, and audio resampling belong only
to this future render layer. They never change stored source edit points.

## ffmpeg lifecycle

See ADR 005, ADR 006, and ADR 012.

Resolution order: the configured path, then `PATH`, then `<app_data>/bin`, then a download
the user agreed to. `app_data_dir()` from the Tauri path API already follows the Windows and
the macOS convention, so no code builds those paths by hand.

On macOS, the `PATH` lookup appends `/opt/homebrew/bin` and `/usr/local/bin` after the
directories from the process `PATH`. This rule lets GUI applications find a standard
Homebrew installation without starting a login shell.

The download manifest pins a URL and a SHA-256 per target. Windows and macOS need different
sources, because the Windows build server publishes no macOS asset.

After the programs resolve, a background job finds out which encoders work. It lists them,
then runs a fraction-of-a-second encode with each candidate, because a listed hardware
encoder fails on a machine without that hardware. The result caches against the binary path,
version, size, and mtime.

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

`Source.id` is stable project identity. A separate revision key uses path, size, and
modification time for runtime invalidation and replacement warnings. Source or revision
changes do not erase canonical segments.

The frontend explicitly projects each runtime `Source` into `PersistedSource`. The
projection lists each persisted field. It does not use object spread as a serialization
filter.

The project file is `.qcproj`, which is versioned JSON. See ADR 010. It stores absolute and
relative source paths. It also stores `activeSourceId`. Runtime proxy and browser state do
not enter the file.

The unreleased schema remains version 1 after this direct replacement. Old frame-grid
version 1 files fail normal structural validation. QuipClip has no migration or legacy
shape detector for them.

## Repository layout

```
AGENTS.md              rules an agent follows here
CLAUDE.md              imports AGENTS.md
docs/architecture.md   this file
.agents/decisions/     one record per decision
.agents/skills/        dev-workflow, and two skills as git submodules
.claude/skills/        symlinks into .agents/skills, so Claude Code finds them
src/                   React frontend
src-tauri/             Rust backend
```

Assets live in fixed places. The icon master is `src/assets/brand/app-icon.svg`. The
`pnpm icons` command regenerates the desktop icon files in `src-tauri/icons/` from that
SVG. The palette is `src/styles/globals.css`.

## Build and check

```bash
pnpm install
pnpm tauri dev
pnpm format:check
pnpm lint && pnpm typecheck && pnpm build && pnpm test
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

TypeScript is held at 5.9, because `typescript-eslint` caps its peer range below 6.1.
