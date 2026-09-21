/**
 * Pure helper functions for video preview timecode formatting, calibration state,
 * and source lifecycle concurrency guards.
 *
 * Implements ADR 002 and ADR 003 source-relative HH:MM:SS.mmm timecode formatting
 * for calibrated source PTS presentation and approximate browser time fallback.
 */

import { ptsElapsedSeconds, ticksToSeconds } from "@/lib/time";
import type { Pts, Rational, TickCount } from "@/types/project";
import type { CalibrationStatus, PresentedFrame } from "@/features/playback";

/**
 * Formats a non-negative floating-point seconds value as `HH:MM:SS.mmm`.
 *
 * @param seconds Non-negative finite duration in seconds.
 */
export function formatMillisecondsTimecode(seconds: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "00:00:00.000";
  }

  const milliseconds = seconds * 1000;
  if (!Number.isFinite(milliseconds)) {
    return "00:00:00.000";
  }
  const totalMs = Math.round(milliseconds);
  if (!Number.isSafeInteger(totalMs)) {
    return "00:00:00.000";
  }
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const ss = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const mm = totalMin % 60;
  const hh = Math.floor(totalMin / 60);

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");

  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(ms)}`;
}

/**
 * Formats an inferred source PTS as source-relative `HH:MM:SS.mmm` elapsed time
 * relative to the source stream's `videoStartPts` (ADR 003).
 *
 * Formula:
 * `elapsedSeconds = (inferredPts - videoStartPts) * videoTimeBase`
 *
 * @param inferredPts Inferred presentation timestamp from calibrated RVFC.
 * @param videoStartPts Presentation timestamp origin of the source video stream.
 * @param videoTimeBase Rational timebase of the video stream.
 */
export function formatSourceRelativeTime(
  inferredPts: Pts,
  videoStartPts: Pts,
  videoTimeBase: Rational,
): string {
  const deltaSeconds = ptsElapsedSeconds(inferredPts, videoStartPts, videoTimeBase);
  if (deltaSeconds === null) {
    return "00:00:00.000";
  }

  const isNegative = deltaSeconds < 0;
  const absSeconds = Math.abs(deltaSeconds);
  const formatted = formatMillisecondsTimecode(absSeconds);
  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Formats approximate browser `currentTime` in seconds as `HH:MM:SS.mmm` (ADR 003).
 * Used when PTS calibration is calibrating or unavailable.
 *
 * @param seconds Raw browser `currentTime` in seconds.
 */
export function formatApproximateTime(seconds: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return "00:00:00.000";
  }

  const isNegative = seconds < 0;
  const absSeconds = Math.abs(seconds);
  const formatted = formatMillisecondsTimecode(absSeconds);
  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Formats total source extent for preview display, prioritizing reported `videoDurationTicks`
 * when available and falling back to `approximateDurationSeconds` (ADR 002, ADR 003).
 *
 * @param approximateDurationSeconds Reported approximate duration in seconds.
 * @param videoDurationTicks Optional stream duration in video time base ticks.
 * @param videoTimeBase Optional rational time base of the video stream.
 */
export function formatPreviewTotalDuration(
  approximateDurationSeconds: number | null | undefined,
  videoDurationTicks?: TickCount | null,
  videoTimeBase?: Rational | null,
): string {
  if (videoDurationTicks && videoTimeBase) {
    const sec = ticksToSeconds(videoDurationTicks, videoTimeBase);
    if (sec !== null) {
      return formatMillisecondsTimecode(sec);
    }
  }

  if (
    typeof approximateDurationSeconds === "number" &&
    Number.isFinite(approximateDurationSeconds) &&
    approximateDurationSeconds >= 0
  ) {
    return formatMillisecondsTimecode(approximateDurationSeconds);
  }

  return "00:00:00.000";
}

/**
 * Formats the current preview timecode, displaying source-relative `HH:MM:SS.mmm`
 * when calibrated and ready, and approximate browser time otherwise (ADR 003).
 *
 * @param presentedFrame Last confirmed presented frame from RVFC, or null.
 * @param calibrationStatus Calibration status of the active source.
 * @param videoStartPts Source video start PTS.
 * @param videoTimeBase Source video time base.
 * @param approximateBrowserTime Fallback browser currentTime in seconds.
 */
export function formatPreviewCurrentTime(
  presentedFrame: PresentedFrame | null,
  calibrationStatus: CalibrationStatus,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  approximateBrowserTime: number,
): string {
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
    );
  }

  return formatApproximateTime(approximateBrowserTime);
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
