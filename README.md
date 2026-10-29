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
- Put several videos one after another on the timeline.
- Preview FLV, MPEG-TS, and MKV files.
- Mark segments on the presentation timestamps (PTS) of the source videos.
- Change segments on the timeline. You can drag a segment edge, split a segment, and undo
  an edit.
- Export the segments with a preset. The output can hold the video and the audio, the
  video only, or the audio only. An export of one segment can copy the source audio.
- Add an export to a queue while another export runs.
- Find `ffmpeg`, and test which encoders work on your machine.
- Show the interface in English or Simplified Chinese, with a light or a dark theme.

QuipClip cannot do these things yet:

- Save a project file. QuipClip keeps the segments only until you quit. It asks before a
  quit that would lose segments.
- Download `ffmpeg`. You must install it yourself.
- Preview AVI or WMV files, or a video in a codec that the system web view cannot decode.
  On Windows, install the HEVC Video Extensions from the Microsoft Store to preview HEVC.

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
  **Check Again** in Settings.
- Windows, in PowerShell or Command Prompt:
  `winget install -e --id Gyan.FFmpeg --source winget`. After the install, quit QuipClip,
  and open it again from the Start menu.

QuipClip searches for the programs in this order:

1. A path you set in Settings.
2. Your `PATH`. On macOS, QuipClip also searches `/opt/homebrew/bin` and `/usr/local/bin`.
3. The `bin` folder in the application data folder:
   - Windows: `%APPDATA%\io.github.capric98.quipclip\bin`
   - macOS: `~/Library/Application Support/io.github.capric98.quipclip/bin`

## Use

1. Open a video. Press `Cmd+O` on macOS or `Ctrl+O` on Windows, or drop the file on the
   window. Open or drop more videos to add them to the timeline.
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

One export joins at most 256 parts and uses at most 85 source files. A segment that crosses
the end of a video on the timeline gives one part for each video.

Settings holds the `ffmpeg` path, the language, the theme, the timecode format, and the
export presets.

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
| `Delete` `Backspace` | Delete the selected segments                                                     |
| `Cmd+A`              | Select all segments                                                              |
| `Cmd+Z`              | Undo                                                                             |
| `Cmd+Shift+Z`        | Redo. On Windows, `Ctrl+Y` also redoes                                           |
| `=` `-`              | Zoom the timeline in or out                                                      |
| `\` or `Shift+Z`     | Zoom the timeline to fit                                                         |
| `Cmd+O` `Cmd+E`      | Open a video, export                                                             |
| `Cmd+,`              | Open Settings                                                                    |

## How it works

- The preview plays the file in the system web view. For FLV and MPEG-TS, and for MKV on
  macOS, `ffmpeg` copies the range that plays into fragmented MP4, and it does not decode
  the video. The web view then plays it through MediaSource.
- Every edit point is a presentation timestamp from the source video stream. So an edit
  point keeps the timing of a variable frame rate, and each source keeps its own
  timestamps.
- Segments use half-open `[inPts, outPts)` boundaries. The export cuts each part on the
  source PTS with `trim`. It gives the parts of different sources one frame size, frame
  rate, and audio format, and then joins them in segment order.
- The export compares the frame count of the output with the expected count. It reports a
  difference instead of writing a wrong cut.

## Build

Requirements: Node 26 or later, pnpm, and Rust 1.90 or later. See the
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
