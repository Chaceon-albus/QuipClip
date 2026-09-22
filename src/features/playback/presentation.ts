/**
 * Answers which clock the reported playback position comes from, driving the timeline
 * playhead.
 *
 * Whether the interface marks a position as approximate is a separate question answered
 * by the calibration status, because the calibration status holds for a whole session while
 * this predicate flips on every seek. See ADR 003.
 */

import { ptsElapsedSeconds } from "@/lib/time";
import type { Pts, Rational } from "@/types/project";
import type { CalibrationStatus, PlaybackState, PresentedFrame } from "./types";

/**
 * Returns true when the reported playback position comes from the browser media clock
 * instead of an inferred source PTS.
 *
 * A source that never calibrates is approximate for its whole session. A calibrated source
 * is also approximate between a seek and the RVFC callback that answers it, because the
 * store clears `presentedFrame` and never updates it optimistically (ADR 003).
 */
export function isPlaybackPositionApproximate(
  calibrationStatus: CalibrationStatus,
  presentedFrame: PresentedFrame | null,
): boolean {
  return calibrationStatus !== "ready" || presentedFrame === null;
}

/**
 * Current elapsed presentation seconds relative to videoStartPts, and the approximate
 * browser clock otherwise. A source that never calibrates has no inferred PTS for its whole
 * session, and a frozen 0 would leave the playhead at the left edge while the picture plays.
 * Both branches report seconds elapsed from the start of the source, the axis the whole
 * ruler uses: the store subtracts the origin of the browser media timeline from the
 * approximate clock, and `onApproximateSeek` adds it back (ADR 003).
 *
 * When a seek is pending, seekTargetSeconds takes precedence over all other positions so
 * the playhead tracks the target immediately (ADR 022).
 */
export function getDisplayedElapsedSeconds(
  state: Pick<
    PlaybackState,
    | "seekTargetSeconds"
    | "presentedFrame"
    | "calibrationStatus"
    | "approximateBrowserTimeSeconds"
  >,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
): number {
  if (
    typeof state.seekTargetSeconds === "number" &&
    Number.isFinite(state.seekTargetSeconds) &&
    state.seekTargetSeconds >= 0
  ) {
    return state.seekTargetSeconds;
  }

  if (
    state.calibrationStatus === "ready" &&
    state.presentedFrame !== null &&
    videoStartPts &&
    videoTimeBase
  ) {
    return (
      ptsElapsedSeconds(
        state.presentedFrame.inferredSourcePts,
        videoStartPts,
        videoTimeBase,
      ) ?? 0
    );
  }

  return state.approximateBrowserTimeSeconds ?? 0;
}
