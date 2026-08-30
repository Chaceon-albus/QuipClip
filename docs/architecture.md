# QuipClip architecture

QuipClip is a video editor for Windows and macOS. The user opens a video, marks several
In and Out pairs on one timeline, and exports those segments joined in order. A
command-line `ffmpeg` does the export.

Two requirements shape everything below.

1. **The preview is frame accurate.** The user steps one frame at a time, and the export
   starts and ends on the frames the preview showed.
2. **The application does not bundle `ffmpeg`.** It finds the programs, or it asks the user
   and downloads them.

Version 1 edits one source. Several sources come later, and the model already carries the
source key that makes that possible. Multi-track is out of scope and stays out of scope.

## Decision records

Each record states context, decision, and consequences. They are the source of truth. This
document summarizes them and shows how the parts fit together.

| Record                                                                                                      | Subject                                                         |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`001-tauri-react-typescript-shell.md`](../.agents/decisions/001-tauri-react-typescript-shell.md)           | Tauri v2, React 19, TypeScript, Vite, Tailwind 4, shadcn/ui     |
| [`002-rational-time-model.md`](../.agents/decisions/002-rational-time-model.md)                             | Rational timebase, integer frame grid, exclusive out points     |
| [`003-hybrid-preview-decoding.md`](../.agents/decisions/003-hybrid-preview-decoding.md)                     | Native playback first, ffmpeg proxy as the fallback             |
| [`004-single-pass-filter-complex-export.md`](../.agents/decisions/004-single-pass-filter-complex-export.md) | Normalize, trim, and concatenate in one ffmpeg run              |
| [`005-ffmpeg-acquisition.md`](../.agents/decisions/005-ffmpeg-acquisition.md)                               | PATH, then app data, then a download the user agreed to         |
| [`006-encoder-capability-probing.md`](../.agents/decisions/006-encoder-capability-probing.md)               | List the encoders, then smoke-test them, then cache             |
| [`007-single-track-source-time-timeline.md`](../.agents/decisions/007-single-track-source-time-timeline.md) | One timeline in source time, segments painted on it             |
| [`008-multi-agent-development-workflow.md`](../.agents/decisions/008-multi-agent-development-workflow.md)   | Delegated writing, independent review                           |
| [`009-incremental-commit-policy.md`](../.agents/decisions/009-incremental-commit-policy.md)                 | One reviewed unit, one commit, no push                          |
| [`010-project-file-format.md`](../.agents/decisions/010-project-file-format.md)                             | A versioned JSON project file, with two stored paths per source |
| [`011-localized-interface.md`](../.agents/decisions/011-localized-interface.md)                             | English and Simplified Chinese interface with a saved setting   |

## Shape

```
+-------------------------------------------------------------+
|  React frontend                                             |
|                                                             |
|  AppShell -> TitleBar | Preview | Transport | Timeline | Bar |
|                  |          |                    |          |
|  Zustand stores: media, timeline, playback, ffmpeg, export  |
|                  |                                          |
|  lib/time.ts  (Rational, timecode)                          |
+------------------|------------------------------------------+
                   |  Tauri commands and events
+------------------|------------------------------------------+
|  Rust backend    v                                          |
|                                                             |
|  commands/   the IPC surface                                |
|  ffmpeg/     locate, download, probe, capabilities, export  |
|  project/    the .qcproj file                               |
|  time.rs     Rational, shared shape with lib/time.ts        |
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

Number, date, and list formatting must use `Intl` with the resolved locale. Media timecode,
file paths, technical identifiers, and raw `ffmpeg` output must keep their original format.

English must be the source and fallback language. New messages must use named placeholders.
Components must not assemble sentences from translated fragments. When `agy` is available,
Gemini must check and polish new or changed English and Simplified Chinese text. This
language review is additional to the independent review that ADR 008 requires.

## Time

See ADR 002. This is the foundation. Everything else depends on it.

`Rational { num, den }` is the canonical Rust time type. Its fields are private, and its
constructors keep the fraction reduced with a positive denominator. It crosses the IPC
boundary as `{"n": ..., "d": ...}`, which is what `lib/time.ts` reads. Edit points remain
integer frame indices, and stored timebases remain rationals. The frontend uses JavaScript
numbers for DOM media timestamps, media-time readbacks, and approximate UI calculations.
Rust gives ffmpeg a fixed-precision decimal string that it formats from an exact rational.

- The project timebase is the output frame rate, as a rational.
- Every edit point is an integer frame index on that grid.
- Out points are exclusive. `[in, out)` holds `out - in` frames.
- `HH:MM:SS:FF` is the display format.

A variable frame rate source has no single frame grid. QuipClip flags it and edits it as if
it ran at `avg_frame_rate`. A proxy repairs it, because the proxy resamples with the `fps`
filter. This is a known limitation of version 1.

## Preview

See ADR 003.

An HTML5 `<video>` element plays the file over the Tauri asset protocol. The element
supplies audio and keeps sound and picture together.

The asset protocol is off by default. It needs an entry in `tauri.conf.json`, a `media-src`
entry in the CSP, and a scope that Rust extends for each file the user opens, and for that
file only.

The two target web views decode different codec sets. When ffprobe reports a format the web
view cannot decode, ffmpeg writes a normalized proxy into the application data directory,
and the preview plays that instead. The proxy uses a one-second keyframe interval, so a
seek decodes at most one second of frames.

Frame stepping seeks to the middle of the target frame, because a seek to a frame boundary
can land on either side of it. `requestVideoFrameCallback` reports the frame the browser
painted, so drift is visible instead of silent. That callback needs macOS 12.3 or later,
which sets the minimum macOS version for QuipClip.

The preview has two modes. _Source_ plays the whole file. _Program_ plays only the
segments, so the user watches what the export will contain.

## Export

See ADR 004.

One ffmpeg run, with `-filter_complex`. Per input the order is normalize, split, trim, reset
the timestamps, concatenate. Normalizing first puts the trim boundaries on the output frame
grid, so no segment rounds on its own.

The `split` step is not optional. A filter output pad feeds exactly one input pad, so
without it every segment after the first would bypass the normalize block and reach
`concat` unnormalized.

Progress comes from `-progress pipe:1`. The total output frame count is `sum(out - in)`,
which is exact and known before the run starts.

The export always re-encodes. A keyframe-aligned stream copy would be faster and would move
the cut points, so QuipClip does not offer one.

The export reads the original file, never the proxy. When the user marked frames on a proxy
grid, the export applies the same `fps` resampling to the original, so a frame index means
the same frame in both.

## ffmpeg lifecycle

See ADR 005 and ADR 006.

Resolution order: the configured path, then `PATH`, then `<app_data>/bin`, then a download
the user agreed to. `app_data_dir()` from the Tauri path API already follows the Windows and
the macOS convention, so no code builds those paths by hand.

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

type PersistedSource = {
  id: string;
  path: string;
  relPath: string;
  size: number;
  mtime: number;
  timebase: Rational;
  frameCount: number;
  proxy?: never;
};

type Source = {
  id: string;
  path: string;
  relPath: string;
  size: number;
  mtime: number;
  timebase: Rational;
  frameCount: number;
  proxy?: { path: string; state: "none" | "building" | "ready" | "failed" };
};

type Segment = {
  id: string;
  sourceId: string;
  inFrame: number; // inclusive
  outFrame: number; // exclusive
};

type Project = {
  schemaVersion: number;
  timebase: Rational;
  resolution: { w: number; h: number };
  sources: PersistedSource[];
  segments: Segment[]; // export order is array order
  activeSourceId: string;
};
```

The timeline axis is source time and spans the whole active source. Segments paint on top of
it. The timeline zooms and pans. The source is never trimmed.

The project file is `.qcproj`, which is versioned JSON. See ADR 010. It stores an absolute
and a relative path per source, so a project survives a move. Any change to the schema is a
breaking change, and it needs a `schemaVersion` bump and a footer in the commit message.

## Repository layout

```
AGENTS.md              rules an agent follows here
CLAUDE.md              imports AGENTS.md
docs/architecture.md   this file
.agents/decisions/     one record per decision
.agents/skills/        dev-workflow, and two skills as git submodules
.agents/private/       exchange with the user. Never committed.
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
pnpm lint && pnpm typecheck && pnpm build && pnpm test
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

TypeScript is held at 5.9, because `typescript-eslint` caps its peer range below 6.1.
