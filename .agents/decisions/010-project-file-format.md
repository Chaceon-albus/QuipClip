# 010. Store a project as a versioned JSON file with the extension .qcproj

- Status: Accepted
- Date: 2026-08-29
- Deciders: capric98

## Context

ADR 007 defines the edit model in memory. It does not say how that model reaches the disk.
ADR 009 makes a change to the project schema a breaking change, so the schema must exist
and must be identified.

Two questions need an answer before any code writes a file.

1. **How does a project name its source files?** An absolute path breaks when the user
   moves the project or opens it on the other operating system. A relative path breaks when
   the source and the project live on different volumes.
2. **How does an old file open in a new build?** Without a version field the application
   must guess, and a wrong guess loses the user's work.

## Decision

A project is one JSON file with the extension `.qcproj`. It is UTF-8, and it ends with a
newline. It is written for a human to read in a diff.

**Every file carries a `schemaVersion` integer.** The first version is 1. The application
refuses to open a file whose `schemaVersion` is above the version it knows, and it says so.
It migrates a lower version forward, and it writes the file back only when the user saves.

**Source paths are stored twice.** Each source holds an absolute `path`, and a `relPath`
relative to the directory of the project file when the two share a volume. On open, the
application tries `relPath` first, then `path`. When neither resolves, it asks the user to
locate the file, and it keeps the segment list, because the segments belong to the source
identity and not to its location.

**A source identity does not depend on its path.** Each source holds `size`, `mtime`, and
the frame count from ffprobe. A file that resolves but does not match those is a different
file, and the application warns before it opens the project.

```jsonc
{
  "schemaVersion": 1,
  "timebase": { "n": 30000, "d": 1001 },
  "resolution": { "w": 1920, "h": 1080 },
  "sources": [
    {
      "id": "s1",
      "path": "/Users/x/clips/a.mp4",
      "relPath": "clips/a.mp4",
      "size": 12345678,
      "mtime": 1787073674,
      "timebase": { "n": 30000, "d": 1001 },
      "frameCount": 10790
    }
  ],
  "segments": [{ "id": "g1", "sourceId": "s1", "inFrame": 120, "outFrame": 360 }],
  "activeSourceId": "s1"
}
```

The file holds no ffprobe dump, no proxy path, and no capability result. Those are all
caches, they belong in the application data directory, and they would make the project file
machine-specific.

Write the file to a temporary name in the same directory, then rename. A crash then leaves
either the old file or the new file, and never a half-written one.

## Consequences

- A project opens after the user moves the whole folder, because `relPath` resolves.
- A project opens on the other operating system when the sources travel with it.
- The application must carry a migration for every schema version it has ever written.
  Version 1 needs none, and the code path must exist from the start anyway.
- A change to this schema needs `BREAKING CHANGE:` in the commit footer, and a bump of
  `schemaVersion`.
- The times in this file are rationals in the `{n, d}` wire shape from ADR 002.
