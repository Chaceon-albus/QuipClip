# 029. Show and open the export output through the run that wrote it

- Status: Accepted
- Date: 2026-09-23
- Deciders: capric98

## Context

After an export, the user wants to find the file or play it. Final Cut Pro offers Show after a
share, Media Encoder makes the output path a link, and DaVinci Resolve offers Reveal in
Finder. QuipClip showed one line of text and a Close button.

Tauri's opener plugin gives the web view two commands. `open_path` checks the path against a
scope that the capability file fixes. `reveal_item_in_dir` checks no scope. An export can
write to any folder that the user picks in the save dialog. A static scope that covers every
such folder would let the web view open any file on the machine, and some files run code when
they open.

## Decision

The application adds two commands of its own: `reveal_export_output` and
`open_export_output`. Each takes the identifier of an export run, not a path.

- The export worker records the path that it published, keyed by the run identifier, just
  before it sends the `finished` event (ADR 016).
- Each command acts only on that recorded path. The web view cannot name a path.
- `open_export_output` opens only a file whose extension is one of the containers that the
  export can write. Any other extension returns `outputNotVideo`. Show has no such check,
  because it runs nothing.
- The commands call the functions of the `tauri-plugin-opener` crate from Rust. The plugin is
  not registered, so its own commands and its link-click script are not exposed to the web
  view.

The finished dialog shows the file name, its folder and the time the export took, with Show in
Finder (Show in File Explorer on Windows), Open, and Done. The status bar result of a hidden
export (ADR 025) offers Show as well.

(Changed on 2026-10-02.) The application no longer opens the output. The user asked for one
file action, because three buttons were too many and the Windows label was too long.

- The finished dialog shows Show File and Done. The label of Show File is the same on both
  platforms. Its tooltip names the file manager: Show in Finder on macOS, and Show in File
  Explorer on Windows. The accessible name of the button is its visible text, and the tooltip
  is only a description.
- The command `open_export_output` is removed, together with its check of the file extension
  and the error codes `outputNotVideo` and `openFailed`. The codes that remain are
  `outputUnknown`, `outputMissing` and `revealFailed`.
- `reveal_export_output` does not change. It still acts only on the path that the run
  recorded, and the opener plugin stays unregistered.
- The status bar result keeps its icon button. Its accessible name is still the full phrase of
  the platform.

## Consequences

- The web view can show or open only the file that the last export wrote. (Changed on
  2026-10-02: it can only show that file.)
- A file that the user moved or deleted after the export gives `outputMissing`.
- The command surface grows by two commands, and the error codes of these commands are a
  second small wire contract next to the export events.
- A new container in the export presets must also be added to the extension list of
  `open_export_output`. A compile-time check fails when a container is missing. (Changed on
  2026-10-02: the command and its list are removed, so a new container needs no entry here.)
- A new run clears the record of the last run when it takes the export slot, so the record is
  never older than the run that the interface shows.
- This amends the finished result of ADR 025: the status bar chip gains a Show control next to
  its dismiss control.
