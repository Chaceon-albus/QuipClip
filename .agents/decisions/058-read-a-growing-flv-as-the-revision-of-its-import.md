# 058. Read an FLV that a recorder still writes as the revision of its import

- Status: Accepted
- Date: 2026-11-09
- Deciders: capric98
- Amends: ADR 010, ADR 024, ADR 046, ADR 056

## Context

The user records live streams to FLV (ADR 056). The user can open a recording while the
recorder still writes it.

The import reads the revision of the source: the path, the size and the whole-second
modification time (ADR 010). Before this record, each later step compared the file with that
revision and refused each difference:

| Step                       | When it compares                  | The result of a difference                                              |
| -------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| A preview window (ADR 046) | At the open of each window        | `sourceChanged`. The panel says that QuipClip cannot read it.           |
| The envelope (ADR 056)     | At the start and the end of a job | `sourceChanged`                                                         |
| The export (ADR 024)       | At step 1 and before the re-probe | The `sourceRevisionChanged` confirmation, then `sourceRevisionMismatch` |

A recorder writes all the time, so the size changes before the first window opens. The import
completed, but the preview, the envelope and the export failed. Only "Export anyway" worked.

The reader of ADR 046 already reads a recording that was cut. Its last tag can continue past the
end of the file. `scan::chain_holds`, the extent of `locate`, the writer of a window and the read
of the envelope accept that end.

The user chose these points:

- A recording opens as the part that was on disk at the import. The length on the timeline does
  not follow the recorder.
- To see a later part, the user opens the file again. The file then becomes a new clip of a new
  revision (ADR 052). The old clip and its segments stay.
- The change stays small. It adds no command, and no field to a command.

## Decision

### A revision of an FLV names its first `size` bytes

An FLV holds a revision when its first `size` bytes are the bytes that the import read. Each read
of an FLV source stops at the size of its revision:

- `FileSource::open_within` and `FlvSource::open_within` take a limit. The registry of the open
  sources (ADR 046) opens each source within the size of its revision.
- The writer of a window and the read of the envelope read the file through `Read::take`.
- The import reads the extent of the tags (ADR 046, "The probe") within the size that it read.
  The end of the video therefore does not pass the bytes that the preview can read.
- The FLV input of an export (ADR 055) uses the revision of the request when the request has
  one. Its slices end at the end of the last whole tag in front of the size of that revision,
  as the windows of the preview do. FFmpeg therefore does not read a part of a tag.
- The FLV input compares the file with that revision again. The preparation can take tens of
  seconds after its first check, and a file that changed in that time must not write its
  keyframes into the sidecar of the old revision. A file that changed is taken as it is now, as
  before this record.

A recording that still grows therefore reads as a recording that was cut at that size. The
keyframes, the configurations and the runs that reach the end come only from the bytes of the
revision. The keyframe sidecar of the revision therefore stays correct.

For a file that did not change, the limit is the length of the file. Nothing changes for it.

### The fingerprint

The import keeps a fingerprint of each FLV in memory, in `flv::growth`. The fingerprint is the
FNV-1a hash of the bytes in front of the size of the revision: 64 KiB at most, and no byte in
front of the first frame.

The bytes in front of the first frame are not in the fingerprint. At the end of a recording, a
recorder can write the duration, the size and a keyframe index into `onMetaData` in place. FFmpeg
does this when it can seek in its output. This changes no frame.

The import reads the fingerprint right after it reads the size, before the probe. A probe can
take seconds. A recorder that starts the file again in that time therefore cannot give its bytes
to the revision.

The process keeps 256 fingerprints. When it must keep one more, it removes the oldest one.

### The verdict

`flv::growth::verdict` compares the file with a revision:

| Verdict   | Condition                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Same`    | The size and the modification time are those of the revision.                                                                                 |
| `Grown`   | The size is not smaller. The modification time is not earlier. The process keeps a fingerprint of the revision, and its bytes did not change. |
| `Changed` | All other cases.                                                                                                                              |

Each check accepts these verdicts:

| Check                                    | Accepts                                              |
| ---------------------------------------- | ---------------------------------------------------- |
| A preview window of an FLV               | `Same` and `Grown`                                   |
| A preview window of MPEG-TS or Matroska  | `Same`                                               |
| The start and the end of an envelope job | `Same`, and `Grown` of a file with the FLV signature |
| The export, before the re-probe          | `Same` and `Grown`                                   |

A window, a job and an export of a `Grown` file use the revision of the request, not the size
that they read now. The key of the keyframe sidecar and the key of the envelope cache are
therefore the keys of the import.

Step 1 of the export (ADR 024) knows only the size and the modification time. For a source whose
probe names `flv`, it accepts a size that is not smaller and a modification time that is not
earlier. The backend then decides with the fingerprint. A file that fails there gives
`sourceRevisionMismatch`, as before.

After a run fails with `sourceRevisionMismatch`, Back runs step 1 with an exact comparison. The
`sourceRevisionChanged` confirmation then shows again and offers "Export anyway", as before this
record. Without this rule, step 1 would let the same file pass again, and Back would never show
the confirmation.

### What does not change

- An MPEG-TS or a Matroska recording that still grows fails as before. FFmpeg reads the whole
  file for its window with an input seek, and no limit applies to that read.
- The identity of a source (ADR 010) does not change. A grown file that the user opens again is
  a new revision and a new source.
- "Export anyway" sends no revision. The export then reads the file as it is at the preparation.

## Rejected alternatives

- **Accept each FLV that grew, with no fingerprint.** After a reconnect, a recorder can start the
  same file again and write other bytes at the same offsets. Later, the file is longer than the
  revision again. The segments would then name other frames, and the preview would show them.
- **A fingerprint of the start of the file.** The write of `onMetaData` at the end of a recording
  changes the start. Each recording would then fail when its recorder stops.
- **Follow the growth on the timeline.** The extent of a clip, the frame grid and the identity of
  a source use one fixed revision (ADR 007, ADR 052). This is a larger change.
- **Keep the fingerprint in the keyframe sidecar.** The sidecar is a cache. Its eviction can
  remove it while the clip is open.
- **A command that gives the verdict to the page.** Step 1 would then compare the fingerprint
  too, but the command surface would grow. The backend already decides before the re-probe. A
  wrong pass of step 1 gives an error code that exists before this record.

## Consequences

- While the recorder still writes a recording, the user can use the part that was on disk at the
  import. The preview, the envelope and the export read that part.
- Each window of a grown FLV reads up to 64 KiB more, for the fingerprint. On a network share
  this is one or two more reads for each window. A window of a file that did not change reads
  nothing more.
- Each import reads the fingerprint before the probe. For a file that is not an FLV, this is one
  more block of 64 KiB. For an FLV, it is the head and up to 64 KiB more.
- The FLV input of each export reads the end of the file once more, to find the last whole tag.
  A file that a recorder cut or still writes can need a resync over up to 4 MiB there, as for
  the extent of the import.
- The fingerprint covers the last 64 KiB in front of the size only. It does not see a change of
  other bytes that keeps the size and the bytes of the fingerprint. ADR 010 has a limit of the
  same kind: a replacement of the same size inside the same second.
- The fingerprints are in memory only. A revision that this process did not import has none, and
  only `Same` holds for it.
- The last tag in front of the size of a revision can be incomplete. The readers and the slices
  of the export stop in front of it, as for a recording that was killed (ADR 046). The slices
  of the export of a recording that was killed now also end in front of its incomplete last tag.
- When the FLV input of an export is not possible, the export keeps the input seek (ADR 046): for
  a changed configuration, for timestamps that decrease, or for another stream order. FFmpeg then
  reads the whole file, also the bytes after the size of the revision. The `trim` filters cut at
  the times of the segments. But a restart of the timestamps just after that size can put frames
  of the later part into a segment that ends at the end of the clip. This record does not limit
  that read.
- The tests of the limit, of the fingerprint and of the checks need no FFmpeg. The test of an
  envelope job of a grown file needs FFmpeg, and it returns early without it.
