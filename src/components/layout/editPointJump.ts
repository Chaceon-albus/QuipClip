/**
 * Finds the edit point that `ArrowUp` and `ArrowDown` go to: the previous or the next edit point
 * of the active source, from the frame on screen.
 *
 * The edit points are the In and the Out of every segment of the active source, and the pending
 * In mark, each PTS once. They all belong to one source, so their raw PTS values compare directly
 * (ADR 002). The caller seeks to the point with `seekToPts`, as Go to In and Go to Out do
 * (`planBoundarySeek`), so the seek needs a calibration and pauses the playback.
 *
 * - The previous point is the latest point that lies strictly before the position, and the next
 *   point is the earliest point that lies strictly after it. A point at the position is neither,
 *   so a second press goes on to the point after it.
 * - The position is the frame on screen. While a seek is pending, it is the target of that seek
 *   (ADR 022), so a held key, which repeats about 30 times each second, walks from point to point
 *   and does not lose the repeats that the store coalesces into one seek. With no frame on
 *   screen, it is the approximate clock.
 * - On the frame grid of ADR 022, a point and the position compare by their ADR 028 frame index.
 *   A point in the frame on screen is then at the position, also when its PTS lies a tick before
 *   the PTS of that frame, as two PTS values that a container rounded can. Off the grid they
 *   compare by ticks.
 *
 * The module has no React, DOM or store dependency.
 */

import type { MediaProbe } from "@/features/media";
import {
  getDisplayedElapsedSeconds,
  getNominalFrameRate,
  hasExactFrameGrid,
  type PlaybackState,
} from "@/features/playback";
import type { TimelineState } from "@/features/timeline";
import { isPtsString, isValidSegmentRange, secondsToTicks } from "@/lib/time";
import { frameBoundaryMarginSeconds, frameIndexOfTicks } from "@/lib/timecode";
import type { Pts, Rational } from "@/types/project";

/** The direction of the edit point to find. */
export type EditPointDirection = "previous" | "next";

/** One read of the state that the search needs. The store states satisfy it as they are. */
export interface EditPointSnapshot {
  /** The probe of the open media, or null while no media is open. */
  readonly probe: Pick<
    MediaProbe,
    "videoStartPts" | "videoTimeBase" | "avgFrameRate" | "rFrameRate"
  > | null;
  readonly playback: Pick<
    PlaybackState,
    | "calibrationStatus"
    | "presentedFrame"
    | "seekTargetSeconds"
    | "approximateBrowserTimeSeconds"
  >;
  readonly timeline: Pick<TimelineState, "sourceId" | "segments" | "pendingInPts">;
}

/**
 * The edit points of the active source in time order, each PTS once: the In and the Out of each
 * valid segment of that source, and the pending In mark. Two segments that meet after a split
 * share one point, and the pending In can lie on a segment boundary.
 */
export function collectEditPoints(timeline: EditPointSnapshot["timeline"]): Pts[] {
  const { segments, sourceId, pendingInPts } = timeline;
  if (sourceId === null) {
    return [];
  }
  const points = new Map<bigint, Pts>();
  const add = (pts: Pts): void => {
    if (isPtsString(pts)) {
      points.set(BigInt(pts), pts);
    }
  };
  for (const segment of segments) {
    if (
      segment.sourceId === sourceId &&
      isPtsString(segment.inPts) &&
      isPtsString(segment.outPts) &&
      isValidSegmentRange(segment.inPts, segment.outPts)
    ) {
      add(segment.inPts);
      add(segment.outPts);
    }
  }
  if (pendingInPts !== null) {
    add(pendingInPts);
  }
  return [...points.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, pts]) => pts);
}

/**
 * The rule that orders a point against the position: the ADR 028 frame index on the frame grid,
 * and the ticks from the start of the source off it. Both rise with the ticks.
 */
interface PositionScale {
  /** The order value of a point, `ticks` from the start of the source. */
  readonly ofTicks: (ticks: bigint) => bigint | null;
  /** The order value of a position in seconds from the start of the source. */
  readonly ofSeconds: (seconds: number) => bigint | null;
}

function gridScale(rate: Rational, timeBase: Rational): PositionScale {
  const margin = frameBoundaryMarginSeconds(rate, timeBase);
  return {
    // A point before the first frame lies before every frame of the grid.
    ofTicks: (ticks) =>
      ticks < 0n ? -1n : frameIndexOfTicks(ticks, timeBase, rate, timeBase),
    // The rule of the timecode and of the frame step of the store: the position plus the margin,
    // times the rate, rounded down (ADR 028).
    ofSeconds: (seconds) => {
      const index = Math.floor(((seconds + margin) * rate.n) / rate.d);
      return Number.isSafeInteger(index) ? BigInt(index) : null;
    },
  };
}

function tickScale(timeBase: Rational): PositionScale {
  return {
    ofTicks: (ticks) => ticks,
    // The tick nearest the position. A pending seek to a point names it exactly.
    ofSeconds: (seconds) => {
      const ticks = secondsToTicks(seconds, timeBase);
      return ticks === null ? null : BigInt(ticks);
    },
  };
}

/**
 * The order value of the position on the scale: the frame on screen, or the target of a pending
 * seek, or the approximate clock when no frame is on screen (`getDisplayedElapsedSeconds`).
 */
function positionOf(
  snapshot: EditPointSnapshot,
  start: Pts,
  scale: PositionScale,
): bigint | null {
  const { playback, probe } = snapshot;
  const frame = playback.presentedFrame;
  if (
    playback.seekTargetSeconds === null &&
    playback.calibrationStatus === "ready" &&
    frame !== null &&
    isPtsString(frame.inferredSourcePts)
  ) {
    // The exact PTS of the frame that the browser confirmed (ADR 003).
    return scale.ofTicks(BigInt(frame.inferredSourcePts) - BigInt(start));
  }
  const seconds = getDisplayedElapsedSeconds(playback, start, probe?.videoTimeBase);
  return Number.isFinite(seconds) ? scale.ofSeconds(seconds) : null;
}

/**
 * Returns the PTS of the previous or the next edit point, or null when there is none: no point
 * on that side, no media, or no usable position. See the module comment for the rules.
 *
 * @param direction `previous` for `ArrowUp`, `next` for `ArrowDown`.
 * @param snapshot One read of the media, playback and timeline state.
 */
export function findEditPoint(
  direction: EditPointDirection,
  snapshot: EditPointSnapshot,
): Pts | null {
  const { probe, playback } = snapshot;
  if (
    probe === null ||
    probe.videoStartPts === null ||
    !isPtsString(probe.videoStartPts)
  ) {
    return null;
  }
  const start = probe.videoStartPts;
  const points = collectEditPoints(snapshot.timeline);
  if (points.length === 0) {
    return null;
  }
  // The grid needs a ready calibration, as the frame step of the store does (ADR 022).
  const rate = getNominalFrameRate(probe);
  const scale =
    playback.calibrationStatus === "ready" && rate !== null && hasExactFrameGrid(probe)
      ? gridScale(rate, probe.videoTimeBase)
      : tickScale(probe.videoTimeBase);
  const position = positionOf(snapshot, start, scale);
  if (position === null) {
    return null;
  }

  const ordered = points.map((pts) => ({
    pts,
    order: scale.ofTicks(BigInt(pts) - BigInt(start)),
  }));
  if (direction === "previous") {
    // The order rises with the ticks, so the last point before the position is the latest.
    for (let index = ordered.length - 1; index >= 0; index--) {
      const { pts, order } = ordered[index];
      if (order !== null && order < position) {
        return pts;
      }
    }
    return null;
  }
  for (const { pts, order } of ordered) {
    if (order !== null && order > position) {
      return pts;
    }
  }
  return null;
}
