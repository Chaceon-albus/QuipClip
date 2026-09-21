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

/**
 * Smallest gap in pixels between two ruler labels before they crowd.
 *
 * formatMillisecondsTimecode always emits the 12 characters of HH:MM:SS.mmm,
 * which is roughly 72 pixels at text-[10px] in the mono font, and each label
 * is centred with -translate-x-1/2.
 */
export const MIN_RULER_TICK_SPACING_PX = 120;

/** Upper bound on generated ticks, so a very wide lane cannot flood the DOM. */
export const MAX_QUANTIZED_RULER_TICK_COUNT = 400;

/** The ladder of human-readable tick intervals, in seconds. */
export const RULER_TICK_LADDER_SECONDS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400,
] as const;

/**
 * Chooses the tick interval for a lane of the given pixel width.
 * Returns null when the duration or the width cannot produce ticks.
 */
export function calculateRulerTickStepSeconds(
  totalDurationSeconds: number | null | undefined,
  laneWidthPx: number,
): number | null {
  if (
    typeof totalDurationSeconds !== "number" ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0 ||
    typeof laneWidthPx !== "number" ||
    !Number.isFinite(laneWidthPx) ||
    laneWidthPx <= 0
  ) {
    return null;
  }

  for (const step of RULER_TICK_LADDER_SECONDS) {
    const spacingPx = (step * laneWidthPx) / totalDurationSeconds;
    const tickCount = totalDurationSeconds / step + 1;
    if (
      spacingPx >= MIN_RULER_TICK_SPACING_PX &&
      tickCount <= MAX_QUANTIZED_RULER_TICK_COUNT
    ) {
      return step;
    }
  }

  // For a duration beyond roughly 66 days (400 ticks * 14,400s ≈ 66.6 days), this
  // fallback cannot cover the lane: the generator stops at 400 ticks and the ruler
  // ends part-way across. No real video source reaches that, so this limit is left alone.
  return RULER_TICK_LADDER_SECONDS[RULER_TICK_LADDER_SECONDS.length - 1];
}

/**
 * Generates ruler markers on whole multiples of the chosen interval.
 * Returns an empty array when the duration or the width is unusable.
 */
export function generateQuantizedRulerMarkers(
  totalDurationSeconds: number | null | undefined,
  laneWidthPx: number,
): RulerMarker[] {
  const step = calculateRulerTickStepSeconds(totalDurationSeconds, laneWidthPx);
  if (
    step === null ||
    typeof totalDurationSeconds !== "number" ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0
  ) {
    return [];
  }

  const markers: RulerMarker[] = [];
  let index = 0;

  while (true) {
    const seconds = index * step;
    if (seconds > totalDurationSeconds) {
      break;
    }

    const percent =
      seconds === totalDurationSeconds ? 100 : (seconds / totalDurationSeconds) * 100;
    const roundedPercent = Math.round(percent * 10_000) / 10_000;
    const left =
      roundedPercent === 0
        ? "0%"
        : roundedPercent === 100
          ? "100%"
          : `${roundedPercent}%`;
    const timecode = formatMillisecondsTimecode(seconds);

    markers.push({
      timecode,
      percent,
      left,
      seconds,
    });

    if (markers.length >= MAX_QUANTIZED_RULER_TICK_COUNT) {
      break;
    }

    index++;
  }

  return markers;
}
