/**
 * Pure helper functions for video preview frame conversion and timecode calculations.
 *
 * Implements ADR-003 preview readback math, RVFC metadata conversions, fallback currentTime conversions,
 * display frame clamping, and source lifecycle concurrency guards.
 */

import {
  formatTimecode,
  frameAtMediaTime,
  frameAtSeconds,
  rationalToNumber,
} from "@/lib/time";
import type { Rational } from "@/types/project";

/**
 * Clamps an integer frame index to the valid display frame range [0, frameCount - 1].
 * If frameCount <= 0, returns 0.
 *
 * @param rawFrame Raw frame index.
 * @param frameCount Total video frame count (exclusive upper bound).
 */
export function clampDisplayFrame(rawFrame: number, frameCount: number): number {
  const safeCount = Number.isSafeInteger(frameCount) && frameCount > 0 ? frameCount : 0;
  if (safeCount <= 0) {
    return 0;
  }
  const maxDisplayFrame = safeCount - 1;
  const truncated = Number.isFinite(rawFrame) ? Math.trunc(rawFrame) : 0;
  return Math.max(0, Math.min(maxDisplayFrame, truncated));
}

/**
 * Converts presentation timestamp readback from `requestVideoFrameCallback` to a clamped integer frame index.
 * Uses exact `probe.startTime` converted to seconds and `frameAtMediaTime` so nonzero or negative
 * source PTS is handled correctly (ADR-003).
 *
 * @param mediaTime `mediaTime` in seconds from `requestVideoFrameCallback` metadata.
 * @param startTime Exact stream `probe.startTime` as a Rational fraction.
 * @param fps Average stream frame rate as a positive Rational fraction.
 * @param frameCount Total stream frame count.
 */
export function calculateFrameFromMediaTime(
  mediaTime: number,
  startTime: Rational,
  fps: Rational,
  frameCount: number,
): number {
  const startTimeSeconds = rationalToNumber(startTime);
  const rawFrame = frameAtMediaTime(mediaTime, startTimeSeconds, fps);
  return clampDisplayFrame(rawFrame, frameCount);
}

/**
 * Converts DOM `video.currentTime` in seconds to a clamped integer frame index.
 * Used as an explicit fallback when `requestVideoFrameCallback` is unavailable (ADR-003).
 *
 * @param currentTime `video.currentTime` in seconds.
 * @param fps Average stream frame rate as a positive Rational fraction.
 * @param frameCount Total stream frame count.
 */
export function calculateFrameFromCurrentTime(
  currentTime: number,
  fps: Rational,
  frameCount: number,
): number {
  const rawFrame = frameAtSeconds(currentTime, fps);
  return clampDisplayFrame(rawFrame, frameCount);
}

/**
 * Formats a clamped display frame index into a `HH:MM:SS:FF` timecode string.
 *
 * @param frame Current display frame index.
 * @param fps Average stream frame rate as a positive Rational fraction.
 */
export function formatDisplayTimecode(frame: number, fps: Rational): string {
  return formatTimecode(frame, fps);
}

/**
 * Formats the total stream duration at exclusive `frameCount` into a `HH:MM:SS:FF` timecode string.
 *
 * @param frameCount Total stream frame count (exclusive upper bound).
 * @param fps Average stream frame rate as a positive Rational fraction.
 */
export function formatTotalTimecode(frameCount: number, fps: Rational): string {
  const safeFrameCount =
    Number.isSafeInteger(frameCount) && frameCount > 0 ? frameCount : 0;
  return formatTimecode(safeFrameCount, fps);
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
