# 010. Store source-PTS projects as version 1 JSON files

- Status: Accepted
- Date: 2026-08-31
- Deciders: capric98

## Context

ADR 002 defines source PTS edit points. ADR 007 separates persisted source metadata from
runtime playback state. The project file must preserve exact timestamps across Rust and
TypeScript without storing machine-specific caches.

QuipClip is not released. Backward compatibility with the old frame-grid version 1 schema
is not required.

## Decision

A project is a UTF-8 JSON file with the extension `.qcproj`. It ends with a newline. The
schema version remains 1.

```jsonc
{
  "schemaVersion": 1,
  "renderSettings": {
    "frameRate": { "n": 30000, "d": 1001 },
    "resolution": { "w": 1920, "h": 1080 }
  },
  "sources": [
    {
      "id": "s1",
      "path": "/Users/x/clips/a.mp4",
      "relPath": "clips/a.mp4",
      "size": 12345678,
      "mtime": 1787073674,
      "videoStreamIndex": 0,
      "videoTimeBase": { "n": 1, "d": 90000 },
      "videoStartPts": "-1800",
      "videoDurationTicks": "32370000",
      "approximateDurationSeconds": 359.666667,
      "avgFrameRate": { "n": 30000, "d": 1001 },
      "rFrameRate": { "n": 30000, "d": 1001 },
      "reportedFrameCount": null
    }
  ],
  "segments": [
    { "id": "g1", "sourceId": "s1", "inPts": "9000", "outPts": "27000" }
  ],
  "activeSourceId": "s1"
}
```

`videoStartPts`, `inPts`, and `outPts` are canonical signed decimal strings.
`videoDurationTicks` and `reportedFrameCount` are canonical non-negative decimal strings
when they exist.

The source keeps both `path` and `relPath`. The application creates `relPath` when the
project and source share a volume. Project loading tries `relPath` first and then `path`.
If neither path resolves, the application asks the user to locate the source. It retains
the source's segments while the source is unavailable.

The stable source `id` does not depend on either path. Size and modification time form
source revision metadata. After a path resolves, QuipClip checks the media against that
revision and warns when the file was replaced or modified. A stable source ID does not
suppress this check.

The file stores only `PersistedSource` fields. Before serialization, the frontend maps
each runtime `Source` through `toPersistedSource`. That function constructs a new object
and lists each persisted field. It must not use an object spread. Rust rejects unknown
fields as a second defense.

The file does not store proxy paths, proxy status, object URLs, browser duration,
calibration state, capability results, a project time base, or output timeline positions.

The application validates source references, unique IDs, time bases, decimal timestamp
strings, and half-open segment ranges. `activeSourceId` must reference a persisted source.
A segment source must have a positive `videoTimeBase` and a non-null `videoStartPts`.
`videoDurationTicks` and `approximateDurationSeconds` can be null and are not segment
prerequisites.

The application does not detect the old frame-grid version 1 shape specially. Such a file
fails normal JSON structure validation. The application provides no migration, adapter,
or alternate parser.

Write the file to a temporary name in the same directory, then rename. A crash then leaves
either the old file or the new file, and never a half-written one.

**Version 1 does not write a project file.** The user imports the sources in each session.

The format below stays defined, and `src-tauri/src/project/` keeps `load_project` and
`save_project` in the command surface. Nothing calls them. The decision is a scope decision,
not a defect, so the code stays ready rather than being deleted and rebuilt.

Persistence needs more than the file. It needs a source that resolves after a move, a
revision check against the file on disk, an order for restoring the media, playback, and
timeline state, a fresh asset-protocol grant for each source, and a guard that stops the
window closing over unsaved work. The first release does not need any of that to let a user
mark a video and export it.

The export settings therefore live in the application settings file. See ADR 013. A preset
belongs to the application, because no project document exists to hold one.

## Consequences

- Rust and TypeScript preserve the full signed `i64` PTS range.
- Project files remain independent of runtime proxy and browser state.
- Old frame-grid project files do not load.
- A schema change still needs a `BREAKING CHANGE:` commit footer, even though the version
  number remains 1 for this unreleased replacement.
- Future released schema changes must use a new version and a deliberate compatibility
  policy.
- Segments last for one session. A user who marks segments and then quits loses them. This
  is the price of the scope decision above, and it is the first thing to reconsider when
  the editing session stops being short.
- Two commands stay registered with no caller. A reader finds this record instead of an
  unexplained interface.
