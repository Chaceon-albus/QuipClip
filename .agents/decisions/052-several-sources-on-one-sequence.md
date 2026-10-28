# 052. Put several sources on one sequence

- Status: Accepted
- Date: 2026-10-28
- Deciders: capric98
- Amends: ADR 002, ADR 003, ADR 007, ADR 010, ADR 022, ADR 024, ADR 026, ADR 027, ADR 028,
  ADR 030, ADR 037, ADR 045, ADR 048

## Context

Version 1 edits one source (ADR 007). A second import replaces the first. The timeline shows
the elapsed time of that one source, and each segment names its source with `sourceId`.

The user asked for several sources on one timeline:

- The sources play one after another. By default the end of one source touches the start of
  the next.
- A file drop on the timeline inserts the file where the pointer is released. An import
  through the dialog adds the file at the end.
- The user can change the order of the sources later.
- One segment can cross from one source into the next.

The user also named two later features. This record does not add them, but the model must
not block them:

1. Sources that overlap on the timeline.
2. A trimmed clip: a part of a source that goes on the timeline. The same source can then show
   more than once on the timeline.

Multi-track editing stays out of scope.

The exact end of a source is a problem today. ADR 002 stores the PTS of the first excluded
frame as the Out. After the last frame of a source, no frame exists, so no Out can include the
last frame. A segment that crosses into the next source must include that frame.

## Decision

### A clip places a source on the sequence

The project gets a third list, `clips`, between `sources` and `segments`.

```ts
type Clip = {
  id: string; // stable, unique in the project
  sourceId: string;
};

type Segment = {
  id: string;
  inClipId: string;
  inPts: Pts; // inclusive, in the video time base of the source of inClipId
  outClipId: string;
  outPts: Pts; // exclusive, in the video time base of the source of outClipId
};
```

- A **source** is one revision of one file, as before (ADR 010). QuipClip generates the source
  ID from the revision key, so two imports of the same unchanged file give one source.
- A **clip** is one placement of a source on the sequence. Two imports of the same file give
  one source and two clips.
- The **sequence** is the list of clips in array order. The first clip starts at sequence time
  zero. Each later clip starts where the clip before it ends.
- `activeSourceId` is gone. The preview shows the clip under the playhead (see below).

The sequence time of a clip is a derived value for display, seeks and layout only. The project
does not store it, as ADR 007 requires for timeline starts.

### Edit points stay source PTS, anchored on a clip

An edit point is a clip and a PTS of the video stream of that clip's source. ADR 002 still
applies to the PTS: it is exact, it is in the source time base, and it is never compared raw
with a PTS of another source. Only the owner of the boundary changes, from the source to the
clip.

An edit point names a clip for two reasons:

- A sequence time depends on the extent of every clip before it. That extent can be
  approximate. An anchor on a clip stays exact when an earlier extent is wrong.
- After clips overlap (a later feature), one sequence time can show two clips. An anchor on a
  clip still names one frame.

### Each clip has a range

`clipRange(clip, source)` gives the first PTS of the clip and its end boundary. In this record
the range is the whole source:

- The start is `videoStartPts`.
- The end is `videoEndPts`, a new field of the source. It is the PTS that follows the last
  presented frame. The probe reads the last video packets of the file. For each packet it adds
  the PTS and the duration, and it keeps the largest sum. A packet with no duration, or with a
  duration of zero, uses the nominal frame interval instead, rounded up to a whole tick. The
  value is null when the probe cannot read the last packets, or when it needs the nominal
  interval and the source has no nominal rate.

A clip whose source has a null `videoStartPts` has no range. It holds no edit point, and no
segment can cross it.

`videoEndPts` is file metadata, as `videoDurationTicks` is. The project persists it with the
source. It is exact as a frame boundary: it includes the last frame and nothing after it. When
the probe used the nominal interval, it is not exact as a time, and it can be wrong by a part
of one frame. The extent of the clip, the layout and the export use it as the end of the clip.
It is the first end boundary of a source that can be an Out.

Only `clipRange` reads the range of a source for a clip. Only `layoutSequence` computes the
extent of each clip and where it starts on the sequence. Other code converts between sequence
time and edit points through `locate` and `toSequenceTime`, and through nothing else. No other
code may assume that the start of a clip is the end of the clip before it.

`layoutSequence` adds the extents with exact rationals (ADR 002). The extent of a clip comes
from its range when `videoEndPts` exists. Otherwise it comes from the list in ADR 007:
`videoDurationTicks`, then `approximateDurationSeconds`, then a finite browser duration. Such
an extent is approximate, and every clip after it then has an approximate start. An
approximate start affects the display and the seeks, but no edit point depends on it. While a
clip is attached, the playhead stays inside the placement of that clip, so it never shows the
frames of one clip at the position of another.

A source with no extent at all cannot share the sequence with another clip. Without it, the
start of every later clip is unknown. The import refuses that combination.

### Segment rules

A segment is a half-open interval on the sequence, from its In point to its Out point.

- The In is on the clip that holds the first included frame:
  `start ≤ inPts`, and `inPts < end` when the end exists.
- The Out is on the clip that holds the last included frame:
  `start < outPts`, and `outPts ≤ end` when the end exists.
- When both are on one clip, `inPts < outPts`.
- When they are on two clips, the In clip comes before the Out clip in the sequence.

These rules give each boundary one form. An Out at the junction of clips A and B is
`(A, A.end)`, and never `(B, B.start)`. So a segment that ends at the end of A stays a segment
of A only, and it moves with A.

A segment can cross a junction only when the clip before the junction has a non-null
`videoEndPts`. Without it, QuipClip cannot name the last frame of that clip.

The end of a clip and the start of the next clip are the same sequence point. To compare two
edit points:

1. For the comparison only, treat an edit point at the end of a clip as the start of the next
   clip, when a next clip exists and has a range.
2. Compare the index of the two clips in the sequence.
3. When the index is the same, compare the two PTS values on that clip.

Validation refuses a segment whose boundaries do not have the one form above: an In at the end
of a clip, or an Out at the start of a clip.

### Edits on the sequence

Mark In, Mark Out, Finish Segment, Split and an edge drag (ADR 030) write an edit point from
the frame on screen, as before (ADR 003, ADR 022). The frame now has a clip as well as a PTS.
Each of these actions writes the one form of the segment rules:

- An Out on the first frame of clip B is the end of clip A, when A is directly before B. When A
  has no `videoEndPts`, the action that would write that Out is disabled there: Mark Out, and
  Finish Segment with a pending In. When B is the first clip, no Out can be there, and the same
  actions are disabled, as today on the first frame of a source.
- Split of a segment that crosses a junction, on the first frame of the later clip, gives two
  segments that meet at the junction.
- An edge drag can cross a junction into the next or previous clip. The junction is a snap
  target. A release on a junction writes the one form.

An action that would make a segment cross a junction after a clip with no `videoEndPts` is
disabled. Mark Out and Finish Segment with a pending In on such a clip are disabled while the
frame on screen is on a later clip. An edge drag stops on the last frame before such a
junction.

No edit action writes an Out at the end of the last clip. The End key and an edge drag still
stop on the last frame of the last clip (ADR 026, ADR 030). A Remove or a Move can leave an Out
at the end of the clip that becomes the last clip. That Out is valid.

The current segment, the pending In mark and the selection keep their rules from ADR 007 and
ADR 045. A pending In is an edit point. QuipClip clears it when its clip leaves the sequence.

### Export order stays array order

The segment array is the export order, as ADR 007 says. A change to the clip order does not
reorder the segments. The user chose this over an order by sequence position.

### Clip operations keep the frames of each segment

One rule covers every operation on clips: **an operation on clips never changes the frames
that a segment includes.** Only the removal of a clip removes frames, the frames of that clip.

- **Insert.** An import through the dialog adds its clips at the end, in the order of the
  selection. A file drop on the track lane inserts its clips at the junction closest to the
  pointer:
  - The pointer is on the left half of a clip: the clips go before that clip.
  - The pointer is on the right half of a clip: the clips go after that clip.

  During the drag, a vertical line shows that junction. A drop anywhere else adds the clips at
  the end. One drop can carry several video files. When the junction is inside a segment,
  QuipClip first splits that segment at the junction.
- **Move.** The user can move a clip to another junction. A move to either junction of the
  clip itself does nothing and adds no history entry. Another move has three steps:
  1. QuipClip splits each segment that crosses the junction before the clip.
  2. QuipClip splits each segment that crosses the junction after the clip, and each segment
     that crosses the target junction.
  3. The clip moves. Each part of a split segment follows the clip that holds it.
- **Remove.** A segment that lies on the removed clip only is removed. A segment with one end
  on the removed clip keeps the part outside it: its In moves to the start of the next clip,
  or its Out moves to the end of the previous clip. A segment that crosses the whole removed
  clip keeps both ends. The clips on each side of the removed clip now meet.

The parts of a split segment take its place in the array, one after another, in sequence
order. So the export order of the frames does not change. The first part keeps the ID of the
segment, as ADR 007 requires for Split.

Each clip operation adds one history entry, together with the splits that it causes. A
history entry now holds the clips as well as the segments. The pending In of an entry is an
edit point. Undo and Redo restore it only when the restored clips still hold its clip. Clip IDs
are never used again, and a changed file gives a new source and a new clip, so this check
replaces the check on the source and its revision.

After a clip operation, an Undo, a Redo or Clear Timeline, the playhead stays on its frame,
the same clip and PTS, while that clip is still on the sequence. When its clip leaves, the
playhead goes to the start of the clip that took its place, else to the last frame of the
clip before it. On an empty sequence nothing is attached.

The media store keeps each imported source for the whole session, also after its last clip
leaves the sequence. So an Undo of a Remove finds the source again. The project file holds only
the sources that a clip names.

The import no longer replaces the open video, so the replace dialog of ADR 027 goes away. A new
action, Clear Timeline, removes every clip and every segment. It adds one history entry, so Undo
brings the clips and the segments back. It asks first when segments exist, with the rule of
ADR 027.

### The preview switches clips

The playback store attaches one source at a time, as before. A new sequence layer above it
chooses the clip.

- A seek to a sequence time finds the clip with `locate`. When that clip is not attached, the
  layer attaches its source and seeks to the local time after the attach. When both clips
  have the same source, the seek needs no attach.
- At the end of the attached clip, playback continues at the first frame of the next clip.
  The end is the `ended` event of the media element, not the end of an extent that can be
  approximate. Play Segment continues across a junction in the same way.
- A frame step past the last frame of a clip goes to the first frame of the next clip. A step
  back from the first frame goes to the last frame of the previous clip.
- Each switch is a cold start. It loads and calibrates the next source, so the preview pauses
  briefly at a junction. The user accepted this for the first version.

The playhead shows sequence time: the start of the attached clip plus the elapsed time in it.
An attach does not run the fade of ADR 007 again. The baseline of the fade is the first list
after the sequence gets its first clip.

### Display rules

- The ruler spans the sequence.
- The track lane shows each clip, with its file name and a line at each junction.
- A segment that crosses a junction is one block. Its number counts the segment, not its
  parts.
- The timecode shows `HH:MM:SS:FF` only when all of these are true. Otherwise it shows
  `HH:MM:SS.mmm`. This extends the rule of ADR 028 for a sequence with no single nominal rate.
  - Each clip shows the frame format by the rules of ADR 028. A clip with a variable frame
    rate does not.
  - Every clip has the same nominal frame rate.
  - Every clip before the last has an exact extent that is a whole number of frames at that
    rate, within one tick of its time base. So each clip starts on a frame of the sequence
    count. A millisecond time base at 29.97 fps passes, because its frames are within one
    tick of the nominal grid.
- The zoom limit uses the highest nominal frame rate of the clips. The frame band of ADR 028
  uses the frame grid of each clip.

### A segment expands to pieces for the export

`expandSegment` turns one segment into source intervals, called pieces, in sequence order:

- A segment on one clip gives one piece, `[inPts, outPts)` of that clip's source.
- A segment across clips gives `[inPts, end)` of the In clip, the whole range of each clip
  between, and `[start, outPts)` of the Out clip.

The export request carries the pieces of all segments in array order. The backend sees an
ordered list of source intervals, the model of ADR 004, and knows nothing of clips. ADR 053
states how the export makes sources of different size, rate and audio fit together.

### What replaces the active source

Older records name "the active source". On the sequence, the general rule is this:

- A rule about the segments of the active source applies to the segments of the sequence.
- A rule about the frame on screen, the extent or the frame rate of the active source applies
  to the attached clip.
- A condition "an active source exists" becomes "the sequence has at least one clip".

| Record  | Rule                                                                           | On the sequence                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR 003 | Source preview plays the active source                                         | The preview plays the sequence, one clip at a time. Program preview stays unbuilt.                                                                                                                                                  |
| ADR 007 | Operations compare boundaries within one source                                | Operations compare edit points by the rule of this record.                                                                                                                                                                          |
| ADR 007 | Undo restores the current segment while it belongs to the active source        | Undo restores it while the restored array holds it.                                                                                                                                                                                 |
| ADR 007 | The zoom returns to 1 when the active source changes                           | The zoom returns to 1 when the sequence gets its first clip and at Clear Timeline. An attach does not change it.                                                                                                                    |
| ADR 007 | The menu does not open for a segment of another source                         | The menu opens for every segment of the sequence.                                                                                                                                                                                   |
| ADR 007 | The fade baseline is the first list after a source loads                       | See "The preview switches clips".                                                                                                                                                                                                   |
| ADR 022 | A scrub snaps to the segments of the active source, inside the source extent   | A scrub snaps to the segments of the sequence, the pending In and each junction, inside the sequence extent.                                                                                                                       |
| ADR 024 | No segment for the active source reports `noSegments`                          | No segment on the sequence reports `noSegments`.                                                                                                                                                                                    |
| ADR 026 | `primary` with `A`, and the segment that holds the frame on screen             | Every segment of the sequence. The segment that holds the edit point of the frame on screen, by the comparison rule.                                                                                                               |
| ADR 030 | A trim needs the active source, snaps to its boundaries and ends when it changes | A trim belongs to its segment. A change of the attached clip during the drag does not end it. It snaps as a scrub does. The frame under the edge uses the frame grid and the nominal rate of the clip under the edge.             |
| ADR 037 | The edit points of the segments of the active source                          | The edit points of the segments of the sequence, in sequence order.                                                                                                                                                                 |
| ADR 045 | Select All, Delete and the restored selection use the active source            | They use the segments of the sequence. Undo restores the selected segments that the restored array holds.                                                                                                                          |
| ADR 048 | The active source has one segment                                              | The export has one piece (ADR 053).                                                                                                                                                                                                 |

### Room for the later features

These later changes must stay small. The code that implements this record must not make
them larger.

- **A trimmed clip.** `Clip` gets an optional range `{ inPts, outPts }`. Only `clipRange`
  changes, and a trim moves each edit point of that clip into the new range. Two clips of one
  source already work. One source keeps one probe, one revision check, one asset grant and one
  set of preview caches. Clip IDs keep the edit points of the two placements apart. A copy of
  the source entry for each placement would duplicate all of that, and it would break the rule
  that a source ID names one file revision.
- **Overlapping clips.** `Clip` gets an optional placement field, for example an offset from
  the end of the previous clip, negative for an overlap. A rule names the clip that shows at a
  time in an overlap. Only `layoutSequence` and `locate` change. Edit points need no change,
  because they name a clip. `expandSegment` gets one more kind of piece for an overlap.
- **A preview with no pause.** A second media element can load the next clip in advance. This
  needs a preview lane for each source in Rust (ADR 046) and a calibration for an element that
  is hidden.

## Consequences

- A segment can include the last frame of a clip for the first time. An edit action can do
  that only when another clip follows that clip.
- Every place that filters segments to one source must change to the clip model. The change
  first keeps one clip and the current behaviour, then adds several clips.
- The probe reads the tail of the file at import. That costs one more read of the file.
- A clip whose end is unknown can hold segments, but no segment can cross its end.
- The replace dialog of ADR 027 goes away. Clear Timeline asks instead.
- A junction pauses the preview until the next source is ready.
- The project file gets `clips` and the new segment fields, and loses `activeSourceId`
  (ADR 010). Nothing writes the file in version 1, so no file needs a migration. The commit
  that changes the schema still needs a `BREAKING CHANGE:` footer, as ADR 010 requires.
- An MP4 edit list can cut the tail of a stream. The probe change must measure how the read of
  the last packets sees such a file.
