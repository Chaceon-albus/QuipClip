/**
 * Pure helper functions for video preview timecode formatting, calibration state,
 * and source lifecycle concurrency guards.
 *
 * Implements the ADR 002 and ADR 003 source-relative timecode for calibrated source PTS
 * presentation and for the approximate browser time fallback. The format is `HH:MM:SS:FF`
 * or `HH:MM:SS.mmm`, as the display of the source selects (ADR 028).
 */

import { isPositiveRational } from "@/features/media/validation";
import { isTickCountString } from "@/lib/time";
import {
  formatElapsedTimecode,
  formatSignedElapsedTicks,
  formatSourceRelativeTime,
  MILLISECONDS_TIMECODE_DISPLAY,
  timecodePlaceholder,
  type TimecodeDisplay,
} from "@/lib/timecode";
import type { Pts, Rational, TickCount } from "@/types/project";
import type { CalibrationStatus, PresentedFrame } from "@/features/playback";

// The elapsed-time formatter of a PTS lives in the timecode library, so the timeline can use
// it without an import from the preview. The preview keeps its name for its callers.
export { formatSourceRelativeTime } from "@/lib/timecode";

/**
 * Formats approximate browser `currentTime` in seconds (ADR 003).
 * Used when PTS calibration is calibrating or unavailable.
 *
 * @param seconds Raw browser `currentTime` in seconds.
 * @param display The timecode format of the source. Defaults to milliseconds.
 */
export function formatApproximateTime(
  seconds: number,
  display: TimecodeDisplay = MILLISECONDS_TIMECODE_DISPLAY,
): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return formatElapsedTimecode(0, display);
  }

  const isNegative = seconds < 0;
  const formatted = formatElapsedTimecode(Math.abs(seconds), display);
  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Formats total source extent for preview display, prioritizing reported `videoDurationTicks`
 * when available and falling back to `approximateDurationSeconds` (ADR 002, ADR 003).
 * Returns the placeholder of the display when neither is valid: the extent is then unknown,
 * not zero.
 *
 * @param approximateDurationSeconds Reported approximate duration in seconds.
 * @param videoDurationTicks Optional stream duration in video time base ticks.
 * @param videoTimeBase Optional rational time base of the video stream.
 * @param display The timecode format of the source. Defaults to milliseconds.
 */
export function formatPreviewTotalDuration(
  approximateDurationSeconds: number | null | undefined,
  videoDurationTicks?: TickCount | null,
  videoTimeBase?: Rational | null,
  display: TimecodeDisplay = MILLISECONDS_TIMECODE_DISPLAY,
): string {
  if (
    videoDurationTicks &&
    isTickCountString(videoDurationTicks) &&
    isPositiveRational(videoTimeBase)
  ) {
    const formatted = formatSignedElapsedTicks(
      BigInt(videoDurationTicks),
      videoTimeBase,
      display,
    );
    if (formatted !== null) {
      return formatted;
    }
  }

  if (
    typeof approximateDurationSeconds === "number" &&
    Number.isFinite(approximateDurationSeconds) &&
    approximateDurationSeconds >= 0
  ) {
    return formatElapsedTimecode(approximateDurationSeconds, display);
  }

  return timecodePlaceholder(display);
}

/**
 * Formats the current preview timecode: the pending seek target first, then the
 * source-relative time of the presented frame when calibration is ready, and the approximate
 * browser time otherwise (ADR 003, ADR 022).
 *
 * @param presentedFrame Last confirmed presented frame from RVFC, or null.
 * @param calibrationStatus Calibration status of the active source.
 * @param videoStartPts Source video start PTS.
 * @param videoTimeBase Source video time base.
 * @param approximateBrowserTime Fallback browser currentTime in seconds.
 * @param seekTargetSeconds Pending seek target in seconds from the start of the source, or null (ADR 022).
 * @param display The timecode format of the source. Defaults to milliseconds.
 */
export function formatPreviewCurrentTime(
  presentedFrame: PresentedFrame | null,
  calibrationStatus: CalibrationStatus,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  approximateBrowserTime: number,
  seekTargetSeconds: number | null = null,
  display: TimecodeDisplay = MILLISECONDS_TIMECODE_DISPLAY,
): string {
  if (
    typeof seekTargetSeconds === "number" &&
    Number.isFinite(seekTargetSeconds) &&
    seekTargetSeconds >= 0
  ) {
    return formatElapsedTimecode(seekTargetSeconds, display);
  }

  if (
    calibrationStatus === "ready" &&
    presentedFrame !== null &&
    videoStartPts &&
    videoTimeBase
  ) {
    return formatSourceRelativeTime(
      presentedFrame.inferredSourcePts,
      videoStartPts,
      videoTimeBase,
      display,
    );
  }

  return formatApproximateTime(approximateBrowserTime, display);
}

/**
 * Returns true when the preview timecode badge should display the approximate marker.
 *
 * Reports a source that has no exact position for as long as its calibration is not ready (`calibrationStatus !== "ready"`).
 * Deliberately does NOT use `isPlaybackPositionApproximate`, because that predicate is also
 * true for the moment between a seek and the frame callback that answers it, which would make
 * the badge flicker on every frame step.
 *
 * @param calibrationStatus Calibration status of the active source.
 */
export function isPreviewTimeApproximate(
  calibrationStatus: CalibrationStatus,
): boolean {
  return calibrationStatus !== "ready";
}

/**
 * Reports whether the preview shows the approximate badge beside the timecode.
 *
 * While the decode-failure panel replaces the picture, the source plays nothing, so there is
 * no position for the badge to qualify. The calibration status is `unavailable` then, and
 * the badge would otherwise show.
 *
 * @param calibrationStatus Calibration status of the active source.
 * @param decodeFailed True while the decode-failure panel replaces the picture.
 */
export function showsApproximateBadge(
  calibrationStatus: CalibrationStatus,
  decodeFailed: boolean,
): boolean {
  return !decodeFailed && isPreviewTimeApproximate(calibrationStatus);
}

/**
 * Interface for tracking and guarding active media source identity across React commit
 * and layout-effect boundaries.
 */
export interface SourceLifecycleGuard {
  activate: (sourceId: string | null | undefined) => void;
  deactivate: (sourceId?: string | null) => void;
  isActive: (sourceId: string | null | undefined) => boolean;
  getActiveId: () => string;
}

/**
 * Controller tracking the active media source lifecycle across React commit and layout-effect boundaries.
 * Prevents stale requestVideoFrameCallback executions, synthetic timeupdates, and DOM decode errors
 * from older media sources from corrupting the currently active media preview state.
 */
export class SourceLifecycleController implements SourceLifecycleGuard {
  private activeId: string;

  constructor(initialSourceId?: string | null) {
    this.activeId =
      typeof initialSourceId === "string" && initialSourceId.length > 0
        ? initialSourceId
        : "";
  }

  /**
   * Activates a source identity. Passing an empty string, null, or undefined deactivates the guard.
   */
  activate(sourceId: string | null | undefined): void {
    this.activeId = typeof sourceId === "string" && sourceId.length > 0 ? sourceId : "";
  }

  /**
   * Deactivates the guard if the currently active source matches the specified sourceId.
   * If a newer source identity is already active, this call is a no-op to prevent accidental deactivation.
   * Calling with undefined or null deactivates unconditionally.
   */
  deactivate(sourceId?: string | null): void {
    if (sourceId === undefined || sourceId === null) {
      this.activeId = "";
      return;
    }
    if (this.activeId === sourceId) {
      this.activeId = "";
    }
  }

  /**
   * Returns true if the provided sourceId matches the currently active source identity.
   * Returns false if sourceId is null, undefined, empty string, or does not match the active source.
   */
  isActive(sourceId: string | null | undefined): boolean {
    if (typeof sourceId !== "string" || sourceId.length === 0) {
      return false;
    }
    return this.activeId === sourceId;
  }

  /**
   * Returns the currently active source identity string, or empty string if inactive.
   */
  getActiveId(): string {
    return this.activeId;
  }
}

/**
 * Factory creating a new SourceLifecycleController instance.
 *
 * @param initialSourceId Optional initial source identity.
 */
export function createSourceLifecycleGuard(
  initialSourceId?: string | null,
): SourceLifecycleController {
  return new SourceLifecycleController(initialSourceId);
}
