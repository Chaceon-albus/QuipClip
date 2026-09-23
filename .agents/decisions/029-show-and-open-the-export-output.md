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

## Consequences

- The web view can show or open only the file that the last export wrote.
- A file that the user moved or deleted after the export gives `outputMissing`.
- The command surface grows by two commands, and the error codes of these commands are a
  second small wire contract next to the export events.
- A new container in the export presets must also be added to the extension list of
  `open_export_output`. A compile-time check fails when a container is missing.
- A new run clears the record of the last run when it takes the export slot, so the record is
  never older than the run that the interface shows.
- This amends the finished result of ADR 025: the status bar chip gains a Show control next to
  its dismiss control.
