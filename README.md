# QuipClip

<img src="src/assets/brand/app-icon.svg" alt="" width="96" align="right">

Mark in and out points on a video, then export the marked segments joined in order.

QuipClip is a small video editor for Windows and macOS. It does one job. You open a video,
you mark the parts you want, and you export them as one file. There is one track and there
are no effects.

## Status

QuipClip is at an early stage.

QuipClip can do these things:

- Open a video, play it, and move one frame forward or back.
- Mark segments on the presentation timestamps (PTS) of the source video.
- Change segments on the timeline. You can drag a segment edge, split a segment, and undo
  an edit.
- Export the segments with a preset. The output can hold the video and the audio, the
  video only, or the audio only.
- Find `ffmpeg`, and test which encoders work on your machine.
- Show the interface in English or Simplified Chinese, with a light or a dark theme.

QuipClip cannot do these things yet:

- Save a project file. QuipClip keeps the segments only until you quit. It asks before a
  quit that would lose segments.
- Download `ffmpeg`. You must install it yourself.
- Preview a video that the system web view cannot decode. On Windows, install the HEVC
  Video Extensions from the Microsoft Store to preview HEVC.
- Edit more than one source video.

## Install

Download QuipClip from the
[releases page](https://github.com/Chaceon-albus/QuipClip/releases).

This file describes the `main` branch. The newest release can be older than `main`, and
then some features and keys in this file are missing from it.

| System                 | Bundle                             |
| ---------------------- | ---------------------------------- |
| macOS on Apple silicon | `QuipClip_<version>_aarch64.dmg`   |
| Windows x64, installer | `QuipClip_<version>_x64-setup.exe` |
| Windows x64, MSI       | `QuipClip_<version>_x64_en-US.msi` |

There is no bundle for a Mac with an Intel processor.

The bundles have no signature from a developer identity. On Windows, SmartScreen shows a
warning at the first start. macOS blocks the first start. To allow it:

1. Open **System Settings**.
2. Open **Privacy & Security**.
3. Click **Open Anyway**.

## ffmpeg

QuipClip does not bundle `ffmpeg`. It needs `ffmpeg` and `ffprobe` in the same folder. It
cannot open a video without them.

- macOS, with [Homebrew](https://brew.sh): `brew install ffmpeg`. After the install, click
  **Check Again** in Settings. You do not have to restart QuipClip.
- Windows, in PowerShell or Command Prompt:
  `winget install -e --id Gyan.FFmpeg --source winget`. After the install, quit QuipClip,
  and open it again from the Start menu. QuipClip gets `PATH` when it starts.

QuipClip searches for the programs in this order:

1. A path you set in Settings.
2. Your `PATH`. On macOS, QuipClip also searches `/opt/homebrew/bin` and `/usr/local/bin`,
   the standard Homebrew folders.
3. The `bin` folder in the application data folder:
   - Windows: `%APPDATA%\io.github.capric98.quipclip\bin`
   - macOS: `~/Library/Application Support/io.github.capric98.quipclip/bin`

After it finds the programs, it tests which encoders work on your machine, and marks the
ones that do not work. Settings shows which `ffmpeg` QuipClip uses, and where it found it.

## Use

1. Open a video. Press `Cmd+O` on macOS or `Ctrl+O` on Windows, or drop the file on the
   window.
2. Go to the first frame that you want to keep. Press `I`.
3. Go to the frame after the last frame that you want to keep. Press `O`. The Out frame is
   not in the segment.
4. Press `Esc` to finish the segment. Then mark the next segment.
5. Press `Cmd+E` or `Ctrl+E`.
6. Select a preset and the streams.
7. Click **Export…**, and select where to save the file.

QuipClip numbers the segments in the order that you mark them. A split puts the right half
directly after the left half. The export joins the segments in the order of their numbers,
not in the order of their positions on the timeline.

The export dialog shows the progress. Click **Run in Background** to hide the dialog. The
status bar then shows the progress.

Settings holds the `ffmpeg` path, the language, the **Appearance** (the theme), the
timecode format, and the export presets. A preset sets the container (MP4, MOV, or MKV),
the encoders, the quality, and the output size, frame rate, and audio format. You can test
a preset on your machine before you use it.

When a control has a key, its tooltip names the key. The table gives the main keys. `Cmd`
is the macOS key. On Windows, use `Ctrl`.

| Key                  | Action                                                                           |
| -------------------- | -------------------------------------------------------------------------------- |
| `Space`              | Play or pause                                                                    |
| `/`                  | Play the current segment, or the segment at the playhead. Stop at its last frame |
| `←` `→`              | Paused: step one frame. Playing: jump 5 s. With `Shift`, 1 s. With `Cmd`, 30 s   |
| `,` `.` or `D` `F`   | Step one frame. With `Shift`, ten frames                                         |
| `↑` `↓`              | Go to the previous or the next edit point                                        |
| `Home` `End`         | Go to the start or the end                                                       |
| `I` `O`              | Mark In, Mark Out. `O` on the Out of the current segment finishes the segment    |
| `Shift+I` `Shift+O`  | Go to the In or the Out of the current segment                                   |
| `Esc`                | Finish the current segment. After an In, end a segment at the playhead           |
| `Delete` `Backspace` | Delete the current segment                                                       |
| `Cmd+Z`              | Undo                                                                             |
| `Cmd+Shift+Z`        | Redo. On Windows, `Ctrl+Y` also redoes                                           |
| `=` `-`              | Zoom the timeline in or out                                                      |
| `\` or `Shift+Z`     | Zoom the timeline to fit                                                         |
| `Cmd+O` `Cmd+E`      | Open a video, export                                                             |
| `Cmd+,`              | Open Settings                                                                    |

## How it works

- The preview plays the file in the system web view. A planned fallback will build an
  ffmpeg proxy when the web view cannot decode the source.
- Every edit point is a presentation timestamp from the source video stream. This model
  preserves variable-frame-rate timing and keeps each source in its own timestamp domain.
- The preview infers source PTS from browser-presented frames through a calibrated linear
  mapping. When precise mapping is unavailable, playback remains available and edit actions
  are disabled.
- Segments use half-open `[inPts, outPts)` boundaries. The renderer seeks each input, cuts
  on the raw source PTS with `trim`, then normalizes and joins the segments in project
  order. It compares the frame count of the output with the expected count, and reports a
  difference instead of writing a wrong cut.

## Build

Requirements: Node 22 or later, pnpm, and Rust 1.85 or later. See the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the platform
libraries.

```bash
pnpm install
pnpm tauri dev      # run
pnpm tauri build    # package
```

[`AGENTS.md`](AGENTS.md) lists the commands that check the code.

## Documents

- [`docs/architecture.md`](docs/architecture.md) — the architecture, and the index of
  decision records.
- [`docs/releasing.md`](docs/releasing.md) — the steps of a release.
- [`.agents/decisions/`](.agents/decisions) — one record per decision.
- [`AGENTS.md`](AGENTS.md) — the rules an agent follows in this repository.

## License

MIT. See [LICENSE](LICENSE).
