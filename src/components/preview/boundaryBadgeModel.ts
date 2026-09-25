/**
 * Pure rules for the In and Out badges of the preview frame.
 *
 * A badge tells the user that the frame on screen is a stored boundary: the In frame of a
 * segment, the pending In mark, or the Out frame of a segment. A segment is the half-open
 * interval `[inPts, outPts)` (ADR 002), so its Out frame is the first frame after the segment.
 * The Out badge therefore says that the frame is not in the segment.
 *
 * The test is exact. The inferred PTS of the presented frame must equal the stored PTS of the
 * boundary, compared as BigInt values. No approximate time and no seek target takes part: the
 * seek target is a display position and never an edit position (ADR 022). The badges show only
 * while that PTS names the frame on screen, that is, while the calibration is ready, a frame is
 * presented, no seek is pending, and playback is paused.
 *
 * The functions return values and translation keys, and do not call the i18n runtime
 * (ADR 011).
 */

import { numberSegmentsInExportOrder } from "@/components/timeline/segmentLabels";
import type { PlaybackState } from "@/features/playback";
import { isPtsString, isValidSegmentRange } from "@/lib/time";
import type { Pts, Segment } from "@/types/project";

/**
 * How long the frame on screen must stay on a boundary before its badge shows. A held frame
 * step key passes a boundary frame in about 33 ms, so the badge does not flash on it. This is
 * the delay of the dimming of the transport edit controls, which has the same cause.
 */
export const BOUNDARY_BADGE_DELAY_MS = 150;

/** The playback facts that the badges read. The store state satisfies it as it is. */
export type BoundaryBadgePlayback = Pick<
  PlaybackState,
  | "calibrationStatus"
  | "presentedFrame"
  | "seekTargetSeconds"
  | "hasDeferredNavigation"
  | "isPlaying"
>;

/**
 * Returns the inferred PTS of the frame on screen while the badges can name it, or null.
 *
 * Null in each of these states:
 *
 * - No source is active.
 * - The calibration is not ready, so no PTS names the frame (ADR 003).
 * - No frame is presented. Each seek clears the frame until the frame callback answers.
 * - A seek is pending (`seekTargetSeconds`), or a navigation waits for the calibration. The
 *   frame on screen is then about to change.
 * - Playback runs. A boundary frame is then on screen for one frame interval only.
 *
 * A store selector can call it on each state change and settle on a string, so the preview
 * does not render again for each frame of playback.
 *
 * @param playback The playback facts.
 * @param hasActiveSource True while media is open and an attached element of it is ready.
 */
export function boundaryBadgeFramePts(
  playback: BoundaryBadgePlayback,
  hasActiveSource: boolean,
): Pts | null {
  const frame = playback.presentedFrame;
  if (
    !hasActiveSource ||
    playback.calibrationStatus !== "ready" ||
    frame === null ||
    playback.seekTargetSeconds !== null ||
    playback.hasDeferredNavigation ||
    playback.isPlaying ||
    !isPtsString(frame.inferredSourcePts)
  ) {
    return null;
  }
  return frame.inferredSourcePts;
}

/** The exact boundaries of one segment of the active source. */
interface IndexedSegment {
  /** The 1-based position in the export order, as `#N` on the timeline shows it. */
  readonly number: number;
  readonly inPts: bigint;
  readonly outPts: bigint;
}

/**
 * The stored boundaries of the active source, parsed once for each change of the segments or
 * of the pending In mark, so the test for each frame is only BigInt comparisons.
 */
export interface BoundaryIndex {
  /** The valid segments of the active source, in export order. */
  readonly segments: readonly IndexedSegment[];
  /** The pending In mark, or null when no In mark is pending or its PTS does not parse. */
  readonly pendingInPts: bigint | null;
}

/**
 * Parses the boundaries that a badge can name.
 *
 * Each segment takes the number that the timeline shows on it, which counts the segments of
 * the active source in export order (`numberSegmentsInExportOrder`). A segment that is not a
 * valid half-open interval has no In frame and no Out frame, so it is left out, and the
 * numbers of the other segments do not change.
 *
 * @param segments The project segment array, in export order.
 * @param activeSourceId The source that the timeline shows.
 * @param pendingInPts The pending In mark of the active source, or null.
 */
export function indexSegmentBoundaries(
  segments: readonly Segment[],
  activeSourceId: string | null | undefined,
  pendingInPts: Pts | null,
): BoundaryIndex {
  const indexed: IndexedSegment[] = [];
  for (const { segment, number } of numberSegmentsInExportOrder(
    segments,
    activeSourceId,
  ).entries) {
    if (isValidSegmentRange(segment.inPts, segment.outPts)) {
      indexed.push({
        number,
        inPts: BigInt(segment.inPts),
        outPts: BigInt(segment.outPts),
      });
    }
  }
  return {
    segments: indexed,
    pendingInPts:
      activeSourceId && pendingInPts !== null && isPtsString(pendingInPts)
        ? BigInt(pendingInPts)
        : null,
  };
}

/** The boundaries that the frame on screen is. At least one list or flag is set. */
export interface BoundaryBadges {
  /** The numbers of the segments whose Out frame is on screen, in export order. */
  readonly outNumbers: readonly number[];
  /** The numbers of the segments whose In frame is on screen, in export order. */
  readonly inNumbers: readonly number[];
  /** True when the frame on screen is the pending In mark. */
  readonly pendingIn: boolean;
}

/**
 * Returns the boundaries that the frame on screen is, or null when it is none.
 *
 * One frame can be several boundaries. After a split, the frame at the split point is the Out
 * frame of the left segment and the In frame of the right segment. Segments can also overlap
 * (ADR 007), so one frame can be the In frame, or the Out frame, of more than one segment.
 *
 * @param framePts The PTS from `boundaryBadgeFramePts`, or null.
 * @param index The boundaries from `indexSegmentBoundaries`.
 */
export function matchBoundaryBadges(
  framePts: Pts | null,
  index: BoundaryIndex,
): BoundaryBadges | null {
  if (framePts === null || !isPtsString(framePts)) {
    return null;
  }
  const value = BigInt(framePts);
  const outNumbers: number[] = [];
  const inNumbers: number[] = [];
  for (const segment of index.segments) {
    if (segment.outPts === value) {
      outNumbers.push(segment.number);
    }
    if (segment.inPts === value) {
      inNumbers.push(segment.number);
    }
  }
  const pendingIn = index.pendingInPts === value;
  if (outNumbers.length === 0 && inNumbers.length === 0 && !pendingIn) {
    return null;
  }
  return { outNumbers, inNumbers, pendingIn };
}

/** One line of the description of a badge: a translation key and its values. */
export type BoundaryBadgeLine =
  | {
      readonly key:
        "preview.boundaryBadge.inOfSegment" | "preview.boundaryBadge.outOfSegment";
      readonly values: { readonly index: number };
    }
  | { readonly key: "preview.boundaryBadge.inPending"; readonly values?: undefined };

/** The description lines of the two badges. An empty list means that the badge does not show. */
export interface BoundaryBadgeLines {
  readonly out: readonly BoundaryBadgeLine[];
  readonly in: readonly BoundaryBadgeLine[];
}

/**
 * Returns the lines that describe each badge, for its tooltip and for assistive technology.
 * Each segment has one line, in export order. The pending In mark comes after the segments,
 * because it is not a segment yet.
 */
export function describeBoundaryBadges(badges: BoundaryBadges): BoundaryBadgeLines {
  const inLines: BoundaryBadgeLine[] = badges.inNumbers.map((number) => ({
    key: "preview.boundaryBadge.inOfSegment",
    values: { index: number },
  }));
  if (badges.pendingIn) {
    inLines.push({ key: "preview.boundaryBadge.inPending" });
  }
  return {
    out: badges.outNumbers.map((number) => ({
      key: "preview.boundaryBadge.outOfSegment",
      values: { index: number },
    })),
    in: inLines,
  };
}
