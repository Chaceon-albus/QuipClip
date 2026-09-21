/**
 * Answers which clock the reported playback position comes from, driving the timeline
 * playhead.
 *
 * Whether the interface marks a position as approximate is a separate question answered
 * by the calibration status, because the calibration status holds for a whole session while
 * this predicate flips on every seek. See ADR 003.
 */

import type { CalibrationStatus, PresentedFrame } from "./types";

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
