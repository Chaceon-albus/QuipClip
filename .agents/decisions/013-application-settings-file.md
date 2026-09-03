# 013. Keep application settings and export presets in one JSON file

- Status: Accepted
- Date: 2026-09-03
- Deciders: capric98

## Context

QuipClip has no settings storage. ADR 005 puts an explicit path first in the ffmpeg
resolution order, and ADR 006 recorded that the path had to wait:

> No caller supplies a configured path until settings storage exists. A user whose ffmpeg is
> outside `PATH` and the application data directory cannot point the application at it.

A user whose ffmpeg lives somewhere unusual therefore sees where the application looked and
can do nothing about it.

The export presets need a home as well. Version 1 does not persist projects. See ADR 010. A
preset therefore cannot live in a project document, because there is no project document.

The language preference already persists in the web view, under the `localStorage` key that
ADR 011 defines. That mechanism cannot hold the ffmpeg path, because Rust reads that path
and Rust cannot read the web view store.

## Decision

Keep both in one file, `<app_data>/settings.json`, at schema version 1. Rust owns the file.
ADR 001 gives Rust every operation that touches the file system.

```json
{
  "schemaVersion": 1,
  "ffmpegPath": "/opt/homebrew/bin",
  "presets": [ ... ],
  "activePresetId": "default-h264-mp4"
}
```

`ffmpegPath` and `activePresetId` are absent when they hold no value. They are never `null`.
A read still accepts an explicit `null`, so the interface can clear a value either way.

**A preset** holds an identity, a container, two encoder names, one quality control, and two
output settings:

```json
{
  "id": "default-h264-mp4",
  "name": "H.264 MP4",
  "container": "mp4",
  "videoEncoder": "libx264",
  "audioEncoder": "aac",
  "quality": { "kind": "crf", "value": 20 },
  "resolution": "source",
  "frameRate": "source"
}
```

`container` is one of `mp4`, `mov`, and `mkv`. The set is closed, because the container
selects a muxer in the render layer of ADR 004.

The encoder names are free text, because the capability probe of ADR 006 discovers the
encoder set of the installed build. Each name holds 1 to 64 characters from
`0-9 A-Z a-z _ . -`, and it starts with a letter or a digit. The renderer builds
`-c:v <name>`, so a name such as `-f` would reach ffmpeg as a flag. The application starts
no shell, so this rule stops an argument, not a shell command.

`quality.kind` is `crf`, `bitrate`, or `qualityScale`. `bitrate` counts kilobits per second.
Each kind holds its own range.

**Limits.** The document holds at most 100 presets. A preset name holds at most 120
characters. A custom resolution holds 1 to 16384 in each dimension. Each quality kind holds
its own range: `crf` from 0 to 63, `bitrate` from 1 to 200000, and `qualityScale` from 1 to
100.

These bounds stop a fault in the interface from writing a document that the application
cannot use, and they give the interface one rule to check before it sends. The `crf` range
covers the widest of the encoders, because `libsvtav1` accepts 0 to 63 where `libx264`
accepts 0 to 51. The application does not narrow the range per encoder, because a preset can
name an encoder that this machine does not have.

`resolution` is the word `source` or an object of `w` and `h`. `frameRate` is the word
`source` or a rational of `n` and `d`. Each reader accepts the word or the object and
nothing else. A reader that accepted any shape would report "no variant matched" and would
name neither the field nor the expectation.

**Seeding.** A missing file loads seeded presets in memory. The load does not create the
file. The first save writes them. Every seeded identifier is a constant, so two loads of a
missing file produce the same document.

The seeds are H.264 in MP4, HEVC in MP4, and one hardware preset for the platform. The
hardware preset selects a bitrate, because every hardware encoder accepts a bitrate and only
some accept a quality scale.

**Restore.** The restore action replaces each seeded preset by identifier, or appends it
when it is absent. It keeps every other preset. It keeps `ffmpegPath`. A restore that
rebuilt the document from the seed table would delete the path the user just set.

**A damaged file is an error, and the application never writes over it.** A cache miss costs
one probe. See ADR 006. A lost preset library costs the user work that nothing can rebuild,
so this file inverts that rule.

- A corrupt file, a failed validation, or a schema version above 1 fails the read.
- A save first reads the file again. It refuses when that read fails.
- A reset renames the file to `settings.invalid.json` and then writes fresh seeds.

**Discovery reads the same file through a separate, permissive path.** That reader takes the
schema version and the ffmpeg path, and it ignores every other key. It answers "no path" for
any problem. One damaged preset must never cost the user the ffmpeg path, because the
application would then report a missing ffmpeg for a reason that has nothing to do with
ffmpeg.

**Commands.** `load_settings`, `save_settings`, `restore_default_presets`, and
`reset_settings`. Each command carries the whole document, and each returns the document
that reached the disk, so the interface renders what Rust stored instead of what it guessed.

The application holds no settings in memory between commands. Each command reads the file.
A path the user sets therefore reaches the next discovery with no restart.

**The commands do not test the path they store.** A save must not fail because a binary on
an unmounted volume did not answer. The interface writes the path and then starts the
capability probe of ADR 006. That probe already reports the origin, the version, and the
working encoders, and it already names the two file names it looked for.

## Consequences

- A user can point the application at any ffmpeg, and `ExecutableOrigin::Configured` already
  crosses the interface, so the status bar reports the configured origin with no change.
- The preset library survives a restart. The segments do not, because version 1 keeps no
  project file.
- A settings file from a later build does not load in an earlier build. The earlier build
  reports the version and writes nothing, so the later document survives the downgrade.
- The settings module never asks which encoders work. A preset can name an encoder this
  machine does not have. The interface compares the preset against the capability report and
  marks it. This keeps every settings test runnable with no ffmpeg.
- The file is the third caller of the atomic write that ADR 010 introduced. The renderer of
  ADR 004 becomes the fourth, so the helper moves to one place first.
- The seeded names are English. They are user data from the moment the file exists, so the
  interface must not translate them.
