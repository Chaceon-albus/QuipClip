/**
 * The snap of the playhead drag to an edit boundary (ADR 002, ADR 003, ADR 022).
 *
 * While the user drags the playhead, a pointer that comes near an In or an Out of a segment,
 * or near the pending In, pulls the seek onto that boundary. The seek then goes to the stored
 * PTS of the boundary, and never to a PTS that a pixel position gives. A pixel is a range of
 * times, and a PTS from a pixel is only the nearest tick to the middle of that range.
 *
 * Three rules keep the snap exact:
 *
 * - The snap applies only while a precise seek is possible: the calibration is ready and the
 *   source reports `videoStartPts`. Only then can `seekToPts` reach a stored PTS. Without a
 *   calibration the timeline seeks on the approximate clock (ADR 003), which counts from the
 *   start of the browser timeline and not from the calibrated first frame, and `seekToPts`
 *   refuses the request. A snap there would draw the playhead on the boundary while the
 *   picture shows another frame.
 * - The snap applies only during a drag, not to the seek of a click. A click is one exact seek
 *   at pointer down (ADR 022), and nothing shows the user a snap before it. A click 5 px
 *   before a boundary at a low zoom can mean a frame many frames before it, and a snap would
 *   move the playhead to a place that the user did not point at.
 * - The Alt key (Option on macOS) turns the snap off while it is held.
 *
 * The functions in this module are pure. They have no DOM and no React dependency.
 */

import {
  isPtsString,
  isValidSegmentRange,
  ptsElapsedSeconds,
  ptsToBigInt,
} from "@/lib/time";
import type { Pts, Rational, Segment } from "@/types/project";

/** The distance from a boundary, in CSS pixels, at which the drag snaps to it. */
export const SCRUB_SNAP_THRESHOLD_PX = 6;

/** One edit boundary that the drag can snap to. */
export interface SnapBoundary {
  /** The stored PTS of the boundary. A snap seeks to this value. */
  readonly pts: Pts;
  /**
   * The seconds from the start of the source to the boundary, from `ptsElapsedSeconds`. It is
   * the value that the playhead is drawn at when it stands on the boundary: `seekToPts` gives
   * it as the seek target, and a presented frame with this PTS gives it too. The snap indicator
   * compares the drawn position with it.
   */
  readonly elapsedSeconds: number;
  /**
   * The position of the boundary on the time axis, as a ratio from 0 to 1 of the source
   * extent. The segment layer draws the boundary at this ratio, so the snap indicator uses it
   * too. It is for layout only.
   */
  readonly ratio: number;
}

/** The inputs of `collectSnapBoundaries`. */
export interface SnapBoundarySource {
  /** The segments of the project, in project order. */
  readonly segments: readonly Segment[];
  /** The active source. Only its segments give boundaries (ADR 002). */
  readonly sourceId: string | null;
  /** The pending In mark, or null. */
  readonly pendingInPts: Pts | null;
  readonly videoStartPts: Pts | null | undefined;
  readonly videoTimeBase: Rational | null | undefined;
  readonly totalDurationSeconds: number | null;
}

/**
 * Returns the boundaries that a drag can snap to: the In and the Out of each valid segment of
 * the active source, and the pending In.
 *
 * The list holds each PTS once, in time order. Two segments that meet after a split share one
 * boundary, and the pending In can lie on a segment boundary. All the boundaries belong to one
 * source, so their raw PTS values compare directly (ADR 002).
 *
 * A boundary outside the source extent is left out. The layout clamps it to an end of the
 * lane, so its drawn position would not be its time.
 *
 * Returns an empty list when the time axis is not usable: no active source, no
 * `videoStartPts`, an invalid time base or an invalid extent.
 */
export function collectSnapBoundaries(source: SnapBoundarySource): SnapBoundary[] {
  const { segments, sourceId, pendingInPts, videoStartPts, videoTimeBase } = source;
  const total = source.totalDurationSeconds;
  if (
    !sourceId ||
    !videoStartPts ||
    !videoTimeBase ||
    !isPtsString(videoStartPts) ||
    typeof total !== "number" ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return [];
  }

  const candidates: Pts[] = [];
  for (const segment of segments) {
    if (
      segment.sourceId === sourceId &&
      isPtsString(segment.inPts) &&
      isPtsString(segment.outPts) &&
      isValidSegmentRange(segment.inPts, segment.outPts)
    ) {
      candidates.push(segment.inPts, segment.outPts);
    }
  }
  if (pendingInPts !== null && isPtsString(pendingInPts)) {
    candidates.push(pendingInPts);
  }

  return buildSnapBoundaries(candidates, videoStartPts, videoTimeBase, total);
}

/**
 * Turns candidate PTS values of one source into snap boundaries: each PTS once, in time
 * order, and only inside the source extent `[0, total]`. `collectSnapBoundaries` and the snap
 * of a segment trim (`segmentTrim.ts`) share it.
 *
 * All the candidates belong to one source, so their raw PTS values compare directly (ADR 002).
 * A candidate that is not a canonical PTS, or that has no safe elapsed time, is left out. An
 * extent that is not finite and positive gives an empty list.
 */
export function buildSnapBoundaries(
  candidates: readonly Pts[],
  videoStartPts: Pts,
  videoTimeBase: Rational,
  total: number,
): SnapBoundary[] {
  if (!Number.isFinite(total) || total <= 0) {
    return [];
  }
  const seen = new Set<string>();
  const boundaries: { boundary: SnapBoundary; order: bigint }[] = [];
  for (const pts of candidates) {
    // A PTS is a canonical decimal string (ADR 002), so equal strings are equal values.
    if (!isPtsString(pts) || seen.has(pts)) {
      continue;
    }
    seen.add(pts);
    const elapsed = ptsElapsedSeconds(pts, videoStartPts, videoTimeBase);
    if (elapsed === null || elapsed < 0 || elapsed > total) {
      continue;
    }
    boundaries.push({
      boundary: { pts, elapsedSeconds: elapsed, ratio: elapsed / total },
      order: ptsToBigInt(pts),
    });
  }

  boundaries.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  return boundaries.map(({ boundary }) => boundary);
}

/**
 * Returns a memoized `collectSnapBoundaries`. It builds the list again only when a field of
 * its input changes identity: the segment array, the pending In, the source, the start PTS,
 * the time base or the extent. The timeline store gives a new segment array for each edit,
 * so a drag builds the list once, and not once for each sample.
 */
export function createSnapBoundaryCache(): (
  source: SnapBoundarySource,
) => SnapBoundary[] {
  let lastSource: SnapBoundarySource | null = null;
  let lastBoundaries: SnapBoundary[] = [];
  return (source) => {
    if (
      lastSource === null ||
      lastSource.segments !== source.segments ||
      lastSource.sourceId !== source.sourceId ||
      lastSource.pendingInPts !== source.pendingInPts ||
      lastSource.videoStartPts !== source.videoStartPts ||
      lastSource.videoTimeBase !== source.videoTimeBase ||
      lastSource.totalDurationSeconds !== source.totalDurationSeconds
    ) {
      lastBoundaries = collectSnapBoundaries(source);
      lastSource = source;
    }
    return lastBoundaries;
  };
}

/** The inputs of `resolveScrubSnap`. */
export interface ScrubSnapInput {
  /** The pointer position, in CSS pixels. */
  readonly pointerX: number;
  /** The position of each boundary, in the same pixel axis as `pointerX`. */
  readonly boundaryXs: readonly number[];
  /**
   * The part of the lane that the user sees (`calculateScrubClampRange`). A boundary outside
   * it never snaps: under the sticky gutter or past the right edge, the indicator of the snap
   * and the playhead on the boundary would be hidden.
   */
  readonly visibleRange: { readonly left: number; readonly right: number };
  /** The largest distance at which a boundary snaps (`SCRUB_SNAP_THRESHOLD_PX`). */
  readonly thresholdPx: number;
  /** True while the modifier that turns the snap off is held: Alt, or Option on macOS. */
  readonly isSnapSuppressed: boolean;
  /**
   * True when a precise seek is possible: the calibration is ready and the source reports
   * `videoStartPts`. Without it no stored PTS can be reached exactly, so nothing snaps.
   */
  readonly canSeekExactly: boolean;
  /**
   * The direction of the drag on the time axis: 1 toward the end, -1 toward the start, 0 when
   * it is not known (`resolveDragDirection`).
   */
  readonly direction: number;
}

/**
 * Decides the boundary that a drag sample snaps to. Returns the index of that boundary in
 * `boundaryXs`, or null for no snap.
 *
 * - Nothing snaps while the snap is suppressed, or while no precise seek is possible.
 * - Only a boundary inside the visible range can snap, the two ends included.
 * - A boundary snaps when its distance from the pointer is `thresholdPx` or less.
 * - The nearest boundary wins.
 * - When two boundaries are at the same distance on the two sides of the pointer, the one in
 *   the direction of the drag wins, because the pointer moves toward it. With no direction,
 *   or for two boundaries at the same position, the first in the list wins.
 *
 * A position that is not finite never snaps.
 */
export function resolveScrubSnap(input: ScrubSnapInput): number | null {
  const { pointerX, boundaryXs, thresholdPx, direction, visibleRange } = input;
  if (
    input.isSnapSuppressed ||
    !input.canSeekExactly ||
    !Number.isFinite(pointerX) ||
    !Number.isFinite(thresholdPx) ||
    thresholdPx < 0
  ) {
    return null;
  }

  let bestIndex: number | null = null;
  let bestDistance = Infinity;
  let bestOffset = 0;
  for (let index = 0; index < boundaryXs.length; index++) {
    const x = boundaryXs[index];
    // A bound that is NaN makes the comparison false, so no boundary snaps.
    if (!Number.isFinite(x) || !(x >= visibleRange.left && x <= visibleRange.right)) {
      continue;
    }
    const offset = x - pointerX;
    const distance = Math.abs(offset);
    if (distance > thresholdPx) {
      continue;
    }
    const isNearer = distance < bestDistance;
    // Equal distances on opposite sides: the boundary ahead of the drag wins.
    const winsTie =
      distance === bestDistance &&
      direction !== 0 &&
      Math.sign(offset) === Math.sign(direction) &&
      Math.sign(bestOffset) !== Math.sign(direction);
    if (isNearer || winsTie) {
      bestIndex = index;
      bestDistance = distance;
      bestOffset = offset;
    }
  }
  return bestIndex;
}

/**
 * The direction of a drag on the time axis, from two positions of the pointer on the lane:
 * 1 toward the end, -1 toward the start. A sample that does not move keeps the previous
 * direction, so a pointer that rests does not lose it.
 *
 * The positions are lane positions and not client positions: an auto-scroll moves the lane
 * under a pointer that rests, and that also moves the drag on the time axis.
 */
export function resolveDragDirection(
  previousLaneX: number | null,
  laneX: number,
  previousDirection: number,
): number {
  if (
    previousLaneX === null ||
    !Number.isFinite(previousLaneX) ||
    !Number.isFinite(laneX)
  ) {
    return previousDirection;
  }
  if (laneX > previousLaneX) {
    return 1;
  }
  if (laneX < previousLaneX) {
    return -1;
  }
  return previousDirection;
}
