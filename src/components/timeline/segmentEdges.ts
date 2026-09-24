/**
 * Pure model for the two ends of a timeline segment: the edge hit areas, their handles, the
 * anchor of the edge timecode bubble, the seek that a click on an edge makes, and the place of
 * the keyboard focus ring along the ends.
 *
 * An edge names one stored boundary of the half-open segment `[inPts, outPts)` (ADR 002). The
 * In edge names `inPts`, the first frame of the segment. The Out edge names `outPts`, the first
 * frame after the segment. A click on an edge seeks to that stored PTS. It never reads a time
 * from the pointer position, so a pixel never becomes a seek or an edit value.
 *
 * The edge is part of the segment button. It is not a separate control in the Tab order: the
 * keyboard path to a boundary is Shift+I and Shift+O (ADR 026).
 */

import {
  planBoundarySeek,
  type BoundarySeekPlayback,
} from "@/components/layout/shortcutCommands";
import { isPtsString, isValidSegmentRange, ptsElapsedSeconds } from "@/lib/time";
import type { Pts, Rational, Segment } from "@/types/project";
import type { SegmentAnchor, SegmentTooltipRow } from "./segmentLabels";

/** One end of a segment. */
export type SegmentEdge = "in" | "out";

/** The width of the hit area inside each end of a segment, in CSS pixels. */
export const SEGMENT_EDGE_HIT_WIDTH_PX = 6;

/**
 * The narrowest body that a segment keeps between its two edge hit areas, in CSS pixels. It is
 * the minimum hit area of a narrow segment, so the click target that selects the segment is
 * never smaller with handles than without them.
 */
export const SEGMENT_EDGE_MIN_BODY_WIDTH_PX = 12;

/**
 * The narrowest segment that shows its edge handles, in CSS pixels: two hit areas and the
 * body between them. Below this width the segment has no handles, so the two hit areas never
 * overlap and never cover the body.
 */
export const SEGMENT_EDGE_HANDLES_MIN_WIDTH_PX =
  2 * SEGMENT_EDGE_HIT_WIDTH_PX + SEGMENT_EDGE_MIN_BODY_WIDTH_PX;

/** The data attribute that marks an edge hit area, with the edge as its value. */
export const SEGMENT_EDGE_ATTRIBUTE = "data-segment-edge";

/**
 * True when a segment `widthPx` wide shows its edge handles. A width that is not finite shows
 * none.
 *
 * @param widthPx The width of the segment in CSS pixels.
 */
export function showsSegmentEdgeHandles(widthPx: number): boolean {
  return Number.isFinite(widthPx) && widthPx >= SEGMENT_EDGE_HANDLES_MIN_WIDTH_PX;
}

/**
 * Reads the edge from the value of `SEGMENT_EDGE_ATTRIBUTE`. Any other value, and no value,
 * names no edge: the pointer is on the body of the segment.
 *
 * @param value The attribute value, or null or undefined when the attribute is missing.
 */
export function parseSegmentEdge(value: string | null | undefined): SegmentEdge | null {
  return value === "in" || value === "out" ? value : null;
}

/** An edge that has a handle: its position and the tooltip row of its time. */
export interface SegmentEdgeEntry {
  /** The position of the boundary, as a percent of the lane. */
  readonly percent: number;
  /** The In row or the Out row of the segment tooltip. */
  readonly row: SegmentTooltipRow;
}

/** The two edges of a segment. An edge is null when it has no handle. */
export interface SegmentEdgeEntries {
  readonly in: SegmentEdgeEntry | null;
  readonly out: SegmentEdgeEntry | null;
}

/** No edge has a handle. */
export const NO_SEGMENT_EDGES: SegmentEdgeEntries = Object.freeze({
  in: null,
  out: null,
});

/**
 * Returns the edges of a segment that can have a handle, with the position of each boundary on
 * the lane and the row that its bubble shows.
 *
 * An edge has a handle only when its boundary lies inside the source extent `[0, total]`. The
 * segment layout clamps a boundary outside the extent to the end of the lane, and a handle
 * there would stand at a time that is not the time of its boundary. An edge also needs its row,
 * so the bubble always has a time to show.
 *
 * The position uses the expression of `calculateSegmentLayout`, so an In edge that is not
 * clamped is exactly at the left of the segment box.
 *
 * @param segment The PTS pair of the segment.
 * @param videoStartPts The start PTS of the source video stream.
 * @param videoTimeBase The video time base of the source.
 * @param totalDurationSeconds The source extent of the ruler (ADR 007).
 * @param rows The tooltip rows of the segment (`buildSegmentTooltipRows`).
 */
export function buildSegmentEdgeEntries(
  segment: Pick<Segment, "inPts" | "outPts">,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  totalDurationSeconds: number | null | undefined,
  rows: readonly SegmentTooltipRow[],
): SegmentEdgeEntries {
  if (
    !videoStartPts ||
    !videoTimeBase ||
    !isPtsString(segment.inPts) ||
    !isPtsString(segment.outPts) ||
    !isValidSegmentRange(segment.inPts, segment.outPts) ||
    typeof totalDurationSeconds !== "number" ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0
  ) {
    return NO_SEGMENT_EDGES;
  }
  const edge = (
    pts: Pts,
    labelKey: SegmentTooltipRow["labelKey"],
  ): SegmentEdgeEntry | null => {
    const row = rows.find((candidate) => candidate.labelKey === labelKey);
    const elapsed = ptsElapsedSeconds(pts, videoStartPts, videoTimeBase);
    if (
      row === undefined ||
      elapsed === null ||
      elapsed < 0 ||
      elapsed > totalDurationSeconds
    ) {
      return null;
    }
    return { percent: (elapsed / totalDurationSeconds) * 100, row };
  };
  const inEdge = edge(segment.inPts, "timeline.segmentTooltip.in");
  const outEdge = edge(segment.outPts, "timeline.segmentTooltip.out");
  return inEdge === null && outEdge === null
    ? NO_SEGMENT_EDGES
    : { in: inEdge, out: outEdge };
}

/**
 * Returns the edge whose bubble the tooltip shows, or null when it shows the body.
 *
 * An edge shows only while it has a handle: an entry for that edge, and a segment width that
 * shows handles (`showsSegmentEdgeHandles`). A zoom out that removes the handles while the
 * pointer rests on an edge therefore turns the bubble back into the tooltip of the body, as
 * the next pointer move over the body would.
 *
 * @param part The part that the tooltip controller names.
 * @param edges The edges of the segment (`buildSegmentEdgeEntries`).
 * @param widthPx The width of the segment in CSS pixels.
 */
export function resolveShownSegmentEdge(
  part: "body" | SegmentEdge,
  edges: SegmentEdgeEntries,
  widthPx: number,
): SegmentEdge | null {
  if (part === "body" || edges[part] === null || !showsSegmentEdgeHandles(widthPx)) {
    return null;
  }
  return part;
}

/**
 * Returns the anchor of the timecode bubble of an edge: a line of zero width, so the arrow of
 * the bubble points at a boundary.
 *
 * The anchor is the boundary while the boundary is inside the visible part of the timeline
 * viewport. The sticky gutter or the viewport edge can hide the boundary while a part of the
 * hit area stays visible, and the pointer can only be on that visible part. The anchor then
 * moves to the nearest visible point of the hit area. When no part of the hit area is visible,
 * the anchor is the boundary and is marked not visible. When the lane has no width, nothing can
 * be measured, and the anchor is the boundary, marked visible.
 *
 * All positions are client pixels, as in `calculateVisibleSegmentAnchor`.
 *
 * @param edge The edge. The In hit area lies after its boundary and the Out hit area before it.
 * @param edgePercent The position of the boundary, as a percent of the lane.
 * @param lane The left edge and the width of the lane.
 * @param visible The left and the right edge of the visible part of the timeline viewport.
 */
export function calculateVisibleEdgeAnchor(
  edge: SegmentEdge,
  edgePercent: number,
  lane: { readonly left: number; readonly width: number },
  visible: { readonly left: number; readonly right: number },
): SegmentAnchor {
  const at = (percent: number, isVisible: boolean): SegmentAnchor => ({
    left: `${percent}%`,
    width: "0%",
    visible: isVisible,
  });
  if (!Number.isFinite(lane.width) || lane.width <= 0) {
    return at(edgePercent, true);
  }
  const boundary = lane.left + (edgePercent * lane.width) / 100;
  const areaStart = edge === "in" ? boundary : boundary - SEGMENT_EDGE_HIT_WIDTH_PX;
  const areaEnd = edge === "in" ? boundary + SEGMENT_EDGE_HIT_WIDTH_PX : boundary;
  const start = Math.max(areaStart, visible.left);
  const end = Math.min(areaEnd, visible.right);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return at(edgePercent, false);
  }
  if (boundary >= start && boundary <= end) {
    return at(edgePercent, true);
  }
  const anchor = Math.min(Math.max(boundary, start), end);
  return at(((anchor - lane.left) * 100) / lane.width, true);
}

/**
 * Returns the PTS that a click on an edge seeks to, or null when the click only selects the
 * segment.
 *
 * The target is the stored boundary: `inPts` for the In edge, and `outPts` for the Out edge,
 * the first frame after the segment, as Go to the Out point does (ADR 026). The condition is
 * the one of Shift+I and Shift+O (`planBoundarySeek`): an active source, a calibration that is
 * ready or still open, and a target that is not the frame already on screen. While the
 * calibration is open, the store defers the seek until the anchor (ADR 022).
 *
 * @param edge The edge that the pointer clicked.
 * @param segment The PTS pair of the segment.
 * @param playback The playback state at the click.
 * @param hasActiveSource True while media is open and its element is attached and ready.
 */
export function planSegmentEdgeSeek(
  edge: SegmentEdge,
  segment: Pick<Segment, "inPts" | "outPts">,
  playback: BoundarySeekPlayback,
  hasActiveSource: boolean,
): Pts | null {
  const command = planBoundarySeek(
    playback,
    hasActiveSource,
    edge === "in" ? segment.inPts : segment.outPts,
  );
  return command !== null && command.kind === "seekToPts" ? command.pts : null;
}

/**
 * The narrowest segment that draws its focus ring inside its box, in CSS pixels. The ring is
 * 2px wide and 2px inside each end, so each vertical side takes 4px. Below this width the two
 * sides would meet, and the ring would not show the shape of a box.
 */
export const SEGMENT_FOCUS_RING_INSET_MIN_WIDTH_PX = 12;

/** Where the dashed focus ring of a segment goes, and its colour. */
export interface SegmentFocusRing {
  /**
   * `inset`: 2px inside the box, inside the border of both states. `outset`: on the outside of
   * the box, for a segment too narrow to hold the ring.
   */
  readonly placement: "inset" | "outset";
  /**
   * `foreground`: the text colour, which keeps 3:1 against the unselected fill, the hover fill
   * and the track in both themes. `primaryForeground`: the brand foreground, which keeps 4.5:1
   * against the selected fill in both themes.
   */
  readonly tone: "foreground" | "primaryForeground";
}

/**
 * Chooses the focus ring of a segment. An inset ring lies on the fill of the segment, so its
 * colour follows the selection. An outset ring lies on the track, so it takes the foreground
 * colour: the brand foreground has almost no contrast against the track in the light theme.
 *
 * @param widthPx The width of the segment in CSS pixels.
 * @param isCurrent True for the selected segment.
 */
export function resolveSegmentFocusRing(
  widthPx: number,
  isCurrent: boolean,
): SegmentFocusRing {
  if (!Number.isFinite(widthPx) || widthPx < SEGMENT_FOCUS_RING_INSET_MIN_WIDTH_PX) {
    return { placement: "outset", tone: "foreground" };
  }
  return {
    placement: "inset",
    tone: isCurrent ? "primaryForeground" : "foreground",
  };
}
