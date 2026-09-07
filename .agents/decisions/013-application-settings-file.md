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

### A save compares a revision, so two processes cannot lose a preset library

The settings lock is a `Mutex` inside one process. Two QuipClip processes take two separate
locks, so the lock cannot order their writes. Before this, the second writer's document simply
replaced the first writer's, and every preset the first writer added was gone — the loss this
record says nothing can rebuild.

The document carries a `revision`, a `u32` counter. A save writes the caller's revision plus
one, and refuses with `settingsConflict` when the value on disk is not the value the caller's
edit was based on. The comparison costs no extra read: `save_locked` already re-reads the
document for the damaged-file guard above, so one read now answers both questions.

`u32`, not a timestamp. Modification time is recorded at one-second granularity on HFS+ and two
on SMB, so two saves inside one tick would be indistinguishable — which is the race being
defended against. A clock can also move backwards, and a size is blind to an edit of equal
length. `u32` rather than `u64` because the whole range fits inside the safe integer range of a
JavaScript number, so unlike a PTS it needs no string encoding.

The counter wraps rather than saturating. Neither is reachable at four billion saves, but a
saturated counter would stop changing at the ceiling, and a revision that never changes disables
the comparison silently for the rest of the file's life.

A document written before the field existed reads as revision 0, which is what the seeded
document also carries, so the first save over such a file compares 0 against 0 and succeeds. The
key is always written, so every save after the first compares a value that was really stored.

**The count continues across a reset.** A token has to be unique for the life of the file, not
only monotonic between two adjacent writes. A reset that restarted the count at 1 would make 1 a
value the file can hold twice: a process holding a document from before the reset would then be
accepted, and it would silently undo the reset. So `reset` reads the revision of the document it
is about to move aside and continues from it. That read is permissive rather than strict,
because the document a reset moves aside is usually the one the strict reader refused, and a
strict read would find no revision to continue from in exactly the case a reset exists for.

**One case a counter cannot close.** If the file is deleted outside the application, the next
process creates a new one at revision 1, and a stale holder at revision 1 is accepted. Closing
that needs a per-file instance identifier, which this decision does not add.

**The token must ride along, not be rebuilt.** Any writer that assembles a settings document
field by field drops the revision, and the next save then compares a value the file never held.
Every writer therefore copies the loaded document and changes what it means to change. Two sites
had to be corrected when this landed, and both were found by making the field required rather
than optional.

**A conflict re-reads the file.** The refusal leaves the interface holding a revision the file
has moved past, so without a re-read every later save in that session would conflict again. The
store re-reads on that code alone, keeps the error visible, and reports what is now on screen.

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
