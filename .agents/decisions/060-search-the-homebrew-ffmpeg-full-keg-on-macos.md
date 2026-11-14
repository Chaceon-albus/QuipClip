# 060. Search the Homebrew `ffmpeg-full` keg on macOS

- Status: Accepted
- Date: 2026-11-14
- Deciders: capric98
- Amends: ADR 012

## Context

ADR 012 adds `/opt/homebrew/bin` and `/usr/local/bin` to the `PATH` lookup on macOS.
Homebrew puts links to the programs of a formula in these directories. A keg-only formula is
a formula that Homebrew installs but does not link. Its programs stay in its keg directory.

Homebrew has two formulas for FFmpeg. The `ffmpeg` formula is not keg-only. The
`ffmpeg-full` formula is keg-only, because it is an alternative version of `ffmpeg`. It holds
more libraries than `ffmpeg`. Its programs are only in `<prefix>/opt/ffmpeg-full/bin`. The
prefix is `/opt/homebrew` on Apple silicon and `/usr/local` on Intel. Homebrew tells the user
to add that directory to `PATH` in a shell startup file.

An application that starts from Finder or the Dock does not read the shell startup files
(ADR 012). When `ffmpeg-full` is the only FFmpeg on a Mac, a terminal can run its programs if
a startup file adds the keg to `PATH`. QuipClip finds no programs.

## Decision

On macOS, the `PATH` lookup uses this directory order:

1. Directories from the application process `PATH`, in their existing order.
2. `/opt/homebrew/bin`.
3. `/usr/local/bin`.
4. `/opt/homebrew/opt/ffmpeg-full/bin`.
5. `/usr/local/opt/ffmpeg-full/bin`.

Items 4 and 5 are new. They have the `Path` origin, as items 2 and 3 have.

The two new directories come after the two directories of ADR 012. When a Mac has `ffmpeg`
and `ffmpeg-full`, QuipClip uses the programs of `ffmpeg`, as it did before this record.
Stable deduplication keeps the first occurrence of a directory. Thus a keg directory that is
in the process `PATH` keeps its position from `PATH`.

The two new directories are `PATH` locations. Thus they come before `<app_data>/bin` and
`<local_data>/bin`, as ADR 005 and ADR 059 require for all `PATH` locations.

`<prefix>/opt/ffmpeg-full` is a link to the installed version in `<prefix>/Cellar`. Discovery
canonicalizes the paths that it accepts (ADR 005), so it gives a path in `<prefix>/Cellar`.
The links in `/opt/homebrew/bin` give the same type of path. Each discovery reads the link
again. After an upgrade of the formula, the next discovery finds the new version.

QuipClip does not search a different keg. A versioned formula, for example `ffmpeg@7`, is
also keg-only. It still needs a configured path. A fixed list of directories keeps discovery
deterministic, and discovery does not read the contents of the `opt` directory.

## Consequences

- QuipClip finds `ffmpeg-full` when it starts from Finder or the Dock.
- A pair in the process `PATH`, in `/opt/homebrew/bin` or in `/usr/local/bin` keeps
  priority over the keg.
- A pair in `<app_data>/bin` or `<local_data>/bin` does not keep priority over the keg. For
  example, a user with only `ffmpeg-full` used the download of ADR 059 before this record.
  After this record, QuipClip uses the keg. To use the download, the user sets its path in
  Settings.
- When a Mac has `ffmpeg` and `ffmpeg-full`, QuipClip uses `ffmpeg`. To use `ffmpeg-full`,
  the user sets the path of its keg in Settings.
- With only `ffmpeg-full` on a Mac, discovery finds a pair. Thus the Settings window does not
  offer the download of ADR 059.
- Each discovery on macOS inspects two more candidate pairs. When the keg is not there, each
  inspection is one failed `canonicalize` call.
