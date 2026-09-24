/**
 * The seek decision for one sample of the timeline pointer gesture (ADR 002, ADR 003,
 * ADR 022).
 *
 * The panel reads the DOM and the stores, passes the values here, and runs the request that
 * comes back. Every rule of the decision is in this module, so the tests need no document:
 *
 * - The pointer is clamped to the visible lane (`calculateScrubClampRange`), so a drag past an
 *   edge seeks to the time at that edge while the edge auto-scroll moves the view.
 * - Only a sample of a drag can snap: the scrub samples and the seek at release or cancel. The
 *   seek at pointer down is the seek of a click, and it never snaps (`scrubSnap.ts`).
 * - A snap needs a precise seek: the calibration gate of the panel. It then requests the stored
 *   PTS of the boundary. Without a precise seek the request is in seconds on the approximate
 *   clock, and nothing snaps (ADR 003).
 * - The pixel path requests the PTS nearest to the pixel, as before the snap existed.
 *
 * The calibration gate stays with the caller, in the one path that seeks from a pointer
 * position, so a later rule about seeks during calibration applies to that path once.
 */

import {
  calculatePtsFromClientX,
  calculateTimelineSecondsFromClientX,
} from "@/features/timeline";
import type { Pts, Rational } from "@/types/project";
import {
  calculateScrubClampRange,
  calculateVisibleLane,
  clampToVisibleLane,
  type ClientRange,
} from "./edgeAutoScroll";
import {
  resolveDragDirection,
  resolveScrubSnap,
  SCRUB_SNAP_THRESHOLD_PX,
  type SnapBoundary,
} from "./scrubSnap";
import type { TimelineScrubPhase } from "./timelineScrub";

/** The inputs of `planScrubSeek`. */
export interface ScrubSeekPlanInput {
  /** The client X of the sample, before the clamp. */
  readonly pointerX: number;
  /** The phase of the sample. A scrub sample requests a scrub seek (ADR 022). */
  readonly phase: TimelineScrubPhase;
  /**
   * True for a sample of a drag, its release and its cancel included
   * (`TimelineScrubGesture.isDragging`). False for the seek at pointer down.
   */
  readonly isDragSample: boolean;
  /** True while the timeline can seek at all. */
  readonly canSeek: boolean;
  /**
   * True while a precise seek is possible: the source is attached and ready, the calibration
   * is ready, and the source reports `videoStartPts`. This is the calibration gate.
   */
  readonly canSeekExactly: boolean;
  /** True when the panel has a seek on the approximate clock. */
  readonly canSeekApproximately: boolean;
  /** The left edge and the width of the lane rectangle, in client pixels. */
  readonly lane: { readonly left: number; readonly width: number };
  /** The rectangle of the scroll container, or null when it is not mounted. */
  readonly container: ClientRange | null;
  readonly totalDurationSeconds: number | null;
  readonly videoStartPts: Pts | null | undefined;
  readonly videoTimeBase: Rational | null | undefined;
  /** The boundaries that the drag can snap to (`collectSnapBoundaries`). */
  readonly boundaries: readonly SnapBoundary[];
  /** True while Alt, or Option on macOS, is held. */
  readonly isSnapSuppressed: boolean;
  /** The lane position of the last sample, or null at the start of a gesture. */
  readonly previousLaneX: number | null;
  /** The direction of the drag at the last sample (`resolveDragDirection`). */
  readonly previousDirection: number;
}

/** A seek that the panel runs. */
export type ScrubSeekRequest =
  /** `seekToPts` with a stored boundary or with the PTS nearest to the pixel. */
  | { readonly kind: "pts"; readonly pts: Pts }
  /** The seek on the approximate clock, in seconds from the start of the source. */
  | { readonly kind: "seconds"; readonly seconds: number };

/** The result of `planScrubSeek`. */
export interface ScrubSeekPlan {
  /** The seek to run, or null for no seek. */
  readonly request: ScrubSeekRequest | null;
  /** The `scrub` option of the seek. */
  readonly scrub: boolean;
  /** The boundary that the sample snapped to, or null. */
  readonly snap: SnapBoundary | null;
  /** The lane position of this sample, for the next one. */
  readonly laneX: number | null;
  /** The direction of the drag after this sample, for the next one. */
  readonly direction: number;
}

/** Plans the seek of one sample. See the module comment for the rules. */
export function planScrubSeek(input: ScrubSeekPlanInput): ScrubSeekPlan {
  const scrub = input.phase === "scrub";
  const total = input.totalDurationSeconds;
  if (!input.canSeek || total === null) {
    return {
      request: null,
      scrub,
      snap: null,
      laneX: input.previousLaneX,
      direction: input.previousDirection,
    };
  }

  const { lane } = input;
  const range =
    input.container === null
      ? null
      : calculateScrubClampRange(calculateVisibleLane(input.container), {
          left: lane.left,
          right: lane.left + lane.width,
        });
  const targetX =
    range === null
      ? input.pointerX
      : clampToVisibleLane(input.pointerX, range.left, range.right);

  // The pointer down of a gesture starts the direction again. Each later sample measures it on
  // the lane, so an auto-scroll under a pointer that rests also moves the drag.
  const laneX = targetX - lane.left;
  const direction = input.isDragSample
    ? resolveDragDirection(input.previousLaneX, laneX, input.previousDirection)
    : 0;

  if (input.canSeekExactly && input.videoStartPts && input.videoTimeBase) {
    if (input.isDragSample && range !== null) {
      const index = resolveScrubSnap({
        pointerX: targetX,
        boundaryXs: input.boundaries.map(
          (boundary) => lane.left + boundary.ratio * lane.width,
        ),
        visibleRange: range,
        thresholdPx: SCRUB_SNAP_THRESHOLD_PX,
        isSnapSuppressed: input.isSnapSuppressed,
        canSeekExactly: input.canSeekExactly,
        direction,
      });
      const snap = index === null ? undefined : input.boundaries[index];
      if (snap !== undefined) {
        return {
          request: { kind: "pts", pts: snap.pts },
          scrub,
          snap,
          laneX,
          direction,
        };
      }
    }
    const pts = calculatePtsFromClientX(
      targetX,
      lane.left,
      lane.width,
      total,
      input.videoStartPts,
      input.videoTimeBase,
    );
    return {
      request: pts === null ? null : { kind: "pts", pts },
      scrub,
      snap: null,
      laneX,
      direction,
    };
  }

  if (!input.canSeekApproximately) {
    return { request: null, scrub, snap: null, laneX, direction };
  }
  const seconds = calculateTimelineSecondsFromClientX(
    targetX,
    lane.left,
    lane.width,
    total,
  );
  return {
    request: seconds === null ? null : { kind: "seconds", seconds },
    scrub,
    snap: null,
    laneX,
    direction,
  };
}

/**
 * The position of the snap indicator, as a ratio of the source extent, or null to hide it.
 *
 * The indicator shows only while the playhead is drawn on the boundary. The caller passes the
 * drawn position after the seek (`getDisplayedElapsedSeconds`). Three cases decide:
 *
 * - An accepted seek sets the seek target to the elapsed time of the boundary.
 * - A refused seek clears the target, and the playhead is drawn somewhere else.
 * - The store drops a scrub seek that repeats the time of the last request (ADR 022). The
 *   drawn position is then the one before the sample. It is on the boundary when the last
 *   request went there, also after that seek settled and the presented frame is the boundary.
 */
export function resolveSnapIndicatorRatio(
  snap: SnapBoundary | null,
  displayedElapsedSeconds: number,
): number | null {
  return snap !== null && displayedElapsedSeconds === snap.elapsedSeconds
    ? snap.ratio
    : null;
}
