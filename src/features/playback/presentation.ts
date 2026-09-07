/**
 * The single definition of "the reported playback position is approximate".
 *
 * The preview timecode, the timeline playhead, and the status bar hint all answer that
 * question, and they must answer it identically. See ADR 003.
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
