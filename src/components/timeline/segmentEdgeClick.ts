/**
 * The click on the edge of a segment (ADR 007): it selects the segment and seeks to the stored
 * boundary that the edge names, under the condition of Shift+I and Shift+O
 * (`planSegmentEdgeSeek`). No value comes from the pointer position.
 *
 * Two paths run it. The segment layer runs it for a click event. The timeline panel runs it for
 * the release of a press that its trim gesture held and that did not move past the drag
 * threshold (ADR 030): that gesture captures the pointer, and the browser then sends its click
 * to another element, or to none. Both paths read the stores at the click, so the segment layer
 * does not subscribe to the playback state.
 */

import { isSourceActive } from "@/components/layout/actionConditions";
import { mediaStore } from "@/features/media";
import { playbackStore } from "@/features/playback";
import { findCurrentSegment, timelineStore } from "@/features/timeline";
import type { Segment } from "@/types/project";
import { planSegmentEdgeSeek, type SegmentEdge } from "./segmentEdges";

/**
 * Seeks to the stored boundary that an edge names, under the condition of Shift+I and Shift+O
 * (`planSegmentEdgeSeek`).
 */
export function seekToSegmentEdge(segment: Segment, edge: SegmentEdge): void {
  const playback = playbackStore.getState();
  const hasActiveSource = isSourceActive(
    mediaStore.getState().media !== null,
    playback.isAttached,
    playback.isReady,
  );
  const target = planSegmentEdgeSeek(edge, segment, playback, hasActiveSource);
  if (target !== null) {
    playback.seekToPts(target);
  }
}

/**
 * Selects the segment that an identifier names and seeks to its edge, as a click on that edge
 * does. Does nothing for an unknown identifier or a segment of another source.
 */
export function clickSegmentEdge(segmentId: string, edge: SegmentEdge): void {
  const timeline = timelineStore.getState();
  const current = findCurrentSegment(timeline.segments, segmentId, timeline.sourceId);
  if (current === null) {
    return;
  }
  timeline.selectSegment(segmentId);
  seekToSegmentEdge(current.segment, edge);
}
