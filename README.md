# QuipClip

<img src="src/assets/brand/app-icon.svg" alt="" width="96" align="right">

English | [简体中文](README.zh-CN.md)

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
- Give a segment a name, and change the order in which the export joins the segments.
- Export only the segments that you select.
- Choose the audio track of a video file that has two or more. This does not apply to an FLV
  file.
- Save one frame as a PNG image.
- Save your work as a project file, and open it again.
- Export the segments with a preset. The output can hold the video and the audio, the
  video only, or the audio only. An export of one segment can copy the source audio.
- Add an export to a queue while another export runs.
- Measure the loudness and the true peak of the audio of an export before it starts.
  QuipClip then fills a gain for a target true peak of -1.0 dBTP.
- Find `ffmpeg`, and test which encoders work on your machine.
- Download `ffmpeg` after you agree, when QuipClip finds none.
- Show the interface in English or Simplified Chinese, with a light or a dark theme.

QuipClip cannot do these things yet:

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

There is no bundle for a Mac with an Intel processor.

Releases 0.2.1 and earlier also have an MSI package for Windows. If you installed QuipClip
from an MSI package, the installer of a later release finds that copy and removes it
first. Windows can ask for administrator rights for this step. Your settings and the
downloaded `ffmpeg` stay.

The bundles have no signature from a developer identity. On Windows, SmartScreen shows a
warning at the first start. macOS blocks the first start. To allow it:

1. Open **System Settings**.
2. Open **Privacy & Security**.
3. Click **Open Anyway**.

## ffmpeg

QuipClip does not bundle `ffmpeg`. It needs `ffmpeg` and `ffprobe` in the same folder. It
cannot open a video without them.

When QuipClip finds no `ffmpeg`, the FFmpeg tab of Settings shows **Download FFmpeg…**. A
dialog then shows the version, the source, the license, the size, and the folder. When you
agree, QuipClip downloads a pinned build and checks its size and its SHA-256. Then it puts the
two programs in the `bin` folder in the local data folder. Each QuipClip release pins one
build for each system:

- Windows x64: the full build from [Gyan](https://github.com/GyanD/codexffmpeg), a download
  of about 250 MB.
- macOS on Apple silicon: the build from [martin-riedl.de](https://ffmpeg.martin-riedl.de).

The two builds use the GPL, version 3 or later. They do not have the `libfdk_aac` encoder.

You can also install `ffmpeg` yourself:

- macOS, with [Homebrew](https://brew.sh): `brew install ffmpeg`. After the install, click
  **Check Again** in Settings.
- Windows, in PowerShell or Command Prompt:
  `winget install -e --id Gyan.FFmpeg --source winget`. After the install, quit QuipClip,
  and open it again from the Start menu.

QuipClip searches for the programs in this order:

1. A path you set in Settings.
2. Your `PATH`. On macOS, QuipClip also searches `/opt/homebrew/bin` and `/usr/local/bin`.
   Then it searches the folders of the Homebrew `ffmpeg-full` formula:
   `/opt/homebrew/opt/ffmpeg-full/bin` and `/usr/local/opt/ffmpeg-full/bin`.
3. The `bin` folder in the application data folder:
   - Windows: `%APPDATA%\io.github.capric98.quipclip\bin`
   - macOS: `~/Library/Application Support/io.github.capric98.quipclip/bin`
4. The `bin` folder in the local data folder, where the download puts the programs:
   - Windows: `%LOCALAPPDATA%\io.github.capric98.quipclip\bin`
   - macOS: the folder of step 3

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

The "Gain" row shows when the export writes audio and **Copy audio** is off. To adjust the
gain of the audio, set **Adjust** to on before you click **Export…**. The switch is at the end
of the "Gain" row. QuipClip then measures the integrated loudness (I) and the true peak (TP) of
the audio of the export, and shows them on the "Measured" line. While **Adjust** is on,
**Copy audio** stays off.

When the measurement ends, QuipClip fills the gain in the "Gain" row. When the true peak is at
-1.0 dBTP or lower, the filled gain is 0.0 dB. Otherwise, the filled gain lowers the true peak
to -1.0 dBTP, and it is never below -20.0 dB. If the measurement fails, the row keeps the gain
of the preset.

You can change the gain. The "After gain" line adds the gain to the measured values. The
encoder of the export can raise the true peak of the file above the value on that line. You
cannot export while the measurement runs or while the gain is not valid. To export at once,
set **Adjust** to off.

QuipClip numbers the segments in the order that you mark them. A split puts the right half
directly after the left half. The export joins the segments in the order of their numbers,
not in the order of their positions on the timeline.

When the export has two or more segments, you can change that order. Click the segment count
at the left of the track, or press `Cmd+Shift+E`. The Export Order dialog lists the segments
in the order of the export. Drag a row to move it. You can also put the focus on a row and
press `Alt` (`Option` on macOS) with `↑` or `↓`. **Sort by Timeline Position** puts the rows in
the order of the timeline. Click **Apply** to keep the new order.

To give a segment a name, right-click the segment and select **Rename…**, or select the
segment and press `F2`. The name shows in the Export Order dialog. It also shows on the
segment when the segment has room for it. The export does not write the name into the file.

To export only one segment, click the segment to select only that segment. Then right-click it
and select **Export Segment…**. To export only some of the segments, click the first of them.
Then `Cmd`-click each of the others (`Ctrl`-click on Windows), right-click one of the selected
segments, and select **Export N Segments…**. The export then joins only the selected segments,
in the export order. With **Export Segment…**, the save dialog proposes a file name that has the
number of the segment. The file name can also have the name of the segment, changed where a
file name needs it. For a file for each segment, use **Export Segment…** one time for each
segment. If the export dialog shows an export in progress, click **Run in Background** before
you right-click a segment.

To save one frame as a PNG image, go to the frame and press `Cmd+Shift+S`, or click the
Export Frame button below the preview. The image is the first frame of a segment whose In is
at that position. It has the full display size of the video.

When a video file has two or more audio tracks, click the name of its clip on the timeline and
select a track in the **Audio Track** submenu. The export, the loudness measurement and the
waveform use that track. When the preview of the file can play a different track, the submenu
shows a note. An FLV file has no such submenu.

To save your work, press `Cmd+S`, or select **File** > **Save**. When the project has no file,
**Save** asks for a file name. **Save As…** asks for a file name each time. A project file has
the extension `.qcproj`. It holds the paths of the videos on the timeline, the segments with
their names and their export order, and the audio track that you chose for a video. It does not
hold the videos, so keep the video files. It holds only complete segments: an In point with no
Out point is not saved. **Save** replaces the project file, also when a second copy of QuipClip
saved the same file in the meantime.

The title bar shows the name of the project file, with a dot before the name when the project
has changes that are not saved. QuipClip asks before you quit, open a project, or clear the
timeline when a project file has changes that are not saved, or when the timeline has segments
and the project has no file. It cannot ask when the Dock of macOS, a logout, or the end of a
Windows session ends QuipClip. A recovery file can keep the work then.

To open a project, press `Cmd+O` and select the project file, or drop the file on the window.
The project replaces the timeline. If you select or drop a project file together with a video
or a second project file, QuipClip opens none of them. QuipClip looks for each video at its
saved path, and at the place that it had relative to the project file. It checks each video
against the facts that the project file holds: the size, the modification time, and the timing
of the video. If QuipClip does not find a video, or the file changed, a dialog lists it. Click
**Locate…** to select the file. When QuipClip has each video, click **Open**. QuipClip does not
open a project with a video file that changed, because the segments could then show different
frames. A video file whose size or modification time changed counts as changed, also when its
content is the same. An FLV file that a recorder wrote further still opens, with the length
that the project file holds.

If you remove all the videos from the timeline, the project closes. After that, **Save** asks
for a file name again.

While a project file has changes that are not saved, QuipClip keeps a recovery file of the
work. For a project with no file, it keeps one while the timeline has one or more segments.
QuipClip writes the recovery file about 1 second after a change, so the last edits before an
exit can be absent from it. At each start, QuipClip looks for recovery files of earlier
sessions. When it finds one, it asks whether to restore the work. That can be so after a
crash, a forced quit, the Dock Quit of macOS, a logout, or the end of a Windows session.

**Restore** opens the work as a project with no file. QuipClip looks for each video at its
saved path, and it checks each video as the open of a project does. Until you save the
restored project, **Save** and **Save As…** propose the name and the folder of the project file
that the work had. The restored work can be older than that project file. To keep both, save
it under a different name. Restored work with no segment has no recovery file, so save it
before you quit. **Discard** removes the recovery file of the work that the prompt shows.
**Not Now** closes the prompt and keeps each recovery file for a later start.

When you confirm a quit, QuipClip removes the recovery file of that session. A recovery file
does not hold an In point with no Out point, the selection, or the history of Undo. When two
copies of QuipClip run at the same time, only one of them has a recovery file: the copy that
started first, until it quits.

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
| `F2`                 | Rename the selected segment                                                      |
| `Cmd+Shift+E`        | Change the export order                                                          |
| `Cmd+S`              | Save the project                                                                 |
| `Cmd+Shift+S`        | Save one frame as a PNG image                                                    |
| `Cmd+Z`              | Undo                                                                             |
| `Cmd+Shift+Z`        | Redo. On Windows, `Ctrl+Y` also redoes                                           |
| `=` `-`              | Zoom the timeline in or out                                                      |
| `\` or `Shift+Z`     | Zoom the timeline to fit                                                         |
| `Cmd+O` `Cmd+E`      | Open a video or a project, export                                                |
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
