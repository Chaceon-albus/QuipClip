/**
 * The key of the media elements of the preview (ADR 003, ADR 039, ADR 052, ADR 063, ADR 072).
 *
 * React builds new media elements each time the key changes. A new element calibrates from its
 * own first frame, and it starts at the start of its source. The key changes for:
 *
 * - a new source: another revision key;
 * - a reload after a decode stall, and a recalibration: the reload counter of the playback store;
 * - a new sequence from the open of a project: the generation of the timeline store, which
 *   `loadSequence` always increases. The first clip of the new sequence can be the file that the
 *   preview showed, and the preview must then show the first frame of a new element, not the old
 *   frame and position.
 */

import type { TimelineState } from "@/features/timeline/types";

/**
 * The generation of the sequence to which the media of the preview belongs.
 *
 * While the sequence has clips, it is the generation of the timeline store. While it has none, the
 * preview shows a media only before the first clip of the session (`createAttachedMediaStore`
 * passes the import through at generation 0), and that media becomes the first clip of the next
 * generation. So the first import keeps its element when its clip joins the sequence.
 */
export function previewSequenceGeneration(
  timeline: Pick<TimelineState, "clips" | "generation">,
): number {
  return timeline.clips.length > 0 ? timeline.generation : timeline.generation + 1;
}

/**
 * The key of the media elements: the revision key of the source, the generation of the sequence
 * (`previewSequenceGeneration`) and the reload counter of the playback store.
 */
export function previewElementKey(
  sourceRevisionKey: string,
  sequenceGeneration: number,
  reloadGeneration: number,
): string {
  return `${sourceRevisionKey}:${sequenceGeneration}:${reloadGeneration}`;
}
