/**
 * Timeline ruler marker calculation and layout helpers.
 *
 * Generates an evenly spaced set of timecode markers from exact frame count and frame rate.
 * Spans source time [0, frameCount] where frameCount is the exclusive total source extent (ADR 002, ADR 007).
 */

import { formatTimecode } from "@/lib/time";
import type { Rational } from "@/types/project";

export interface RulerMarker {
  /** Frame index on the source frame grid. */
  frame: number;
  /** Formatted non-drop-frame timecode (HH:MM:SS:FF). */
  timecode: string;
  /** Percentage offset along the ruler width (0..100). */
  percent: number;
  /** CSS left percentage string (e.g. "0%", "20%"). */
  left: string;
}

export interface GenerateRulerMarkersOptions {
  /** Number of markers to generate. Defaults to 6 (0%, 20%, 40%, 60%, 80%, 100%). */
  markerCount?: number;
}

/** Default number of ruler markers across the timeline width. */
export const DEFAULT_RULER_MARKER_COUNT = 6;

/** Minimum allowed ruler markers (start 0% and end 100%). */
export const MIN_RULER_MARKER_COUNT = 2;

/** Maximum allowed ruler markers to prevent excessive DOM allocations or infinite loops. */
export const MAX_RULER_MARKER_COUNT = 100;

/**
 * Sanitizes and bounds a markerCount input to a safe integer within [MIN_RULER_MARKER_COUNT, MAX_RULER_MARKER_COUNT].
 * Defaults to DEFAULT_RULER_MARKER_COUNT when undefined or NaN.
 * Clamps -Infinity and values < MIN_RULER_MARKER_COUNT to MIN_RULER_MARKER_COUNT.
 * Caps Infinity, Number.MAX_SAFE_INTEGER, and values > MAX_RULER_MARKER_COUNT to MAX_RULER_MARKER_COUNT.
 * Truncates non-integer finite numbers.
 *
 * @param markerCount Raw marker count input.
 */
export function sanitizeMarkerCount(markerCount?: number): number {
  if (markerCount === undefined || Number.isNaN(markerCount)) {
    return DEFAULT_RULER_MARKER_COUNT;
  }
  if (markerCount === Infinity || markerCount === Number.POSITIVE_INFINITY) {
    return MAX_RULER_MARKER_COUNT;
  }
  if (markerCount === -Infinity || markerCount === Number.NEGATIVE_INFINITY) {
    return MIN_RULER_MARKER_COUNT;
  }
  const truncated = Math.trunc(markerCount);
  return Math.max(MIN_RULER_MARKER_COUNT, Math.min(MAX_RULER_MARKER_COUNT, truncated));
}

/**
 * Generates a small fixed set of evenly spaced ruler markers across source extent.
 * Guarantees arithmetic safety for large values up to Number.MAX_SAFE_INTEGER.
 *
 * @param frameCount Total video stream frame count (exclusive upper bound).
 * @param avgFrameRate Average frame rate as a positive Rational fraction.
 * @param options Optional configuration including markerCount.
 */
export function generateRulerMarkers(
  frameCount: number,
  avgFrameRate: Rational,
  options: GenerateRulerMarkersOptions = {},
): RulerMarker[] {
  const safeCount = sanitizeMarkerCount(options.markerCount);
  const safeFrameCount =
    Number.isSafeInteger(frameCount) && frameCount >= 0
      ? frameCount
      : typeof frameCount === "number" && !Number.isNaN(frameCount)
        ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(frameCount)))
        : 0;

  const markers: RulerMarker[] = [];

  for (let i = 0; i < safeCount; i++) {
    const ratio = i / (safeCount - 1);
    const percent = ratio * 100;
    const rawFrame = ratio * safeFrameCount;
    const frame = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(rawFrame)));
    const timecode = formatTimecode(frame, avgFrameRate);

    const left = percent === 0 ? "0%" : percent === 100 ? "100%" : `${percent}%`;

    markers.push({
      frame,
      timecode,
      percent,
      left,
    });
  }

  return markers;
}
