/**
 * Timeline ruler marker calculation and layout helpers.
 *
 * Generates an evenly spaced set of source-relative timecode markers (HH:MM:SS.mmm) across the timeline duration.
 * Spans source time [0, totalDurationSeconds] (ADR 002, ADR 003, ADR 007).
 */

import { formatMillisecondsTimecode } from "@/components/preview/previewFrame";

export interface RulerMarker {
  /** Formatted source-relative timecode (HH:MM:SS.mmm). */
  timecode: string;
  /** Percentage offset along the ruler width (0..100). */
  percent: number;
  /** CSS left percentage string (e.g. "0%", "20%"). */
  left: string;
  /** Elapsed seconds at this marker. */
  seconds: number;
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
 * Generates an evenly spaced set of source-relative timecode markers across the timeline duration.
 * Returns empty array if duration is indeterminate, null, or non-positive.
 *
 * @param totalDurationSeconds Total duration of the active source in seconds.
 * @param options Optional configuration including markerCount.
 */
export function generateRulerMarkers(
  totalDurationSeconds: number | null | undefined,
  options: GenerateRulerMarkersOptions = {},
): RulerMarker[] {
  if (
    typeof totalDurationSeconds !== "number" ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0
  ) {
    return [];
  }

  const safeCount = sanitizeMarkerCount(options.markerCount);
  const markers: RulerMarker[] = [];

  for (let i = 0; i < safeCount; i++) {
    const ratio = i / (safeCount - 1);
    const percent = ratio * 100;
    const seconds = ratio * totalDurationSeconds;
    const timecode = formatMillisecondsTimecode(seconds);
    const left = percent === 0 ? "0%" : percent === 100 ? "100%" : `${percent}%`;

    markers.push({
      timecode,
      percent,
      left,
      seconds,
    });
  }

  return markers;
}
