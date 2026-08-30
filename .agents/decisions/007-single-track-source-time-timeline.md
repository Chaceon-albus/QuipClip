# 007. Show one timeline in source time and paint the segments on it

- Status: Accepted
- Date: 2026-08-29
- Deciders: capric98

## Context

The user marks several In and Out pairs on one video, and the export joins those segments
in order. The source file is never modified and never trimmed.

Three interaction models fit that task:

- **A classic two-monitor editor.** The user marks In and Out in a source viewer, then
  inserts into a program timeline. It is familiar to editors, and it needs two preview
  surfaces and two decoders.
- **One output timeline.** The track holds the segments, and marking In and Out splits and
  trims in place. It has the fewest concepts, and it shows no relation between a segment
  and the place it came from.
- **One source timeline.** The axis is source time and spans the whole file. The segments
  paint on top of it.

The design preview in `.agents/private/design-preview.png` shows several tracks. That part
of the preview does not apply. QuipClip has one track and will keep one track.

## Decision

Use one timeline whose horizontal axis is **source time**, spanning the whole active
source. The segments paint on top of that axis. The timeline zooms and pans, so the user
can work on a small part of a long file.

This is the **in-memory** model. ADR 010 defines what reaches the disk, and the two differ:
the runtime model carries the proxy state, and the project file does not, because a proxy is
a machine-specific cache.

The data model already carries a source key on every segment:

```ts
type Segment = {
  id: string;
  sourceId: string; // present now, used when several sources arrive
  inFrame: number; // inclusive, on the project frame grid
  outFrame: number; // exclusive
};

type Project = {
  timebase: Rational;
  resolution: { w: number; h: number };
  sources: Source[];
  segments: Segment[]; // export order is array order
  activeSourceId: string; // which source the timeline shows
};
```

Export order is the array order. For one source that is source order.

When several sources arrive, `activeSourceId` selects which source the ruler shows. The
segment list stays global and keeps its order. The schema does not change.

## Consequences

- The user always sees where a segment sits inside the original file.
- The application needs one decoder and one preview surface.
- The timeline axis is not the output axis. The _Program_ preview mode from ADR 003
  answers the question "what does the result look like", so the two views together cover
  both questions.
- Reordering segments is not a drag along the timeline, because the timeline axis is fixed
  to source time. A separate ordered list is the place to reorder. Version 1 does not need
  it, because one source means source order.
- Multi-track is out of scope. No part of this model reserves room for a second track, and
  that is deliberate.
