/**
 * Pure model of the frame bands of the timeline at a high zoom: the band of the frame on screen
 * at the playhead, and the band of the Out frame of the current segment.
 *
 * Premiere Pro and DaVinci Resolve show the width of one frame at the playhead when one frame is
 * wide enough on screen. QuipClip does the same, only on the exact frame grid of ADR 022: a ready
 * calibration, a constant rate, and a grid that is exact for the time base (`hasExactFrameGrid`).
 * There each nominal frame names one real frame. Off the grid a nominal frame does not name a
 * real frame, so no band shows.
 *
 * - The playhead band runs from the nominal start of the frame that the timecode names to the
 *   nominal start of the next frame. The frame index is the one of the frame timecode (ADR 028),
 *   with the rule of the preview timecode for the displayed position (ADR 022): the seek target
 *   first, then the tick delta of the presented frame.
 * - The Out band runs from the Out of the current segment to the nominal start of the frame
 *   after the Out frame. The Out is the first frame after the segment (ADR 002), so the band
 *   shows the one frame that the Out names and that the export leaves out.
 *
 * A band is display only. No seek, snap, trim or edit reads it, and it takes no pointer event.
 * Its edges are frame starts, and never a width from seconds alone.
 */

import type { PlaybackState } from "@/features/playback";
import { FRAME_BAND_MIN_WIDTH_PX } from "@/features/timeline";
import { isPtsString, isValidSegmentRange, ptsElapsedSeconds } from "@/lib/time";
import { frameBoundaryMarginSeconds, frameIndexOfTicks } from "@/lib/timecode";
import type { Pts, Rational, Segment } from "@/types/project";

/**
 * The part of a pixel that the width test forgives. At its ceiling the zoom makes one frame
 * exactly `FRAME_BAND_MIN_WIDTH_PX` wide at 25 fps and above (`calculateMaxPixelsPerSecond`),
 * and the product of the lane width and the frame interval can round to a value just below it.
 */
const FRAME_BAND_WIDTH_TOLERANCE_PX = 1e-6;

/** The left and the width of a band, as percentages of the lane and as CSS values. */
export interface FrameBandLayout {
  readonly leftPercent: number;
  readonly widthPercent: number;
  readonly left: string;
  readonly width: string;
}

/** The playback facts of the displayed position that the playhead band reads. */
export type FrameBandPlayback = Pick<
  PlaybackState,
  "seekTargetSeconds" | "presentedFrame" | "calibrationStatus"
>;

function isValidRate(rate: Rational | null | undefined): rate is Rational {
  return (
    rate !== null &&
    rate !== undefined &&
    Number.isSafeInteger(rate.n) &&
    Number.isSafeInteger(rate.d) &&
    rate.n > 0 &&
    rate.d > 0
  );
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The width of one nominal frame on screen, in CSS pixels: the lane width times the frame
 * interval, divided by the source extent. Returns null when the rate, the extent or the lane
 * width is not usable.
 *
 * @param rate The nominal frame rate.
 * @param totalDurationSeconds The source extent of the ruler (ADR 007).
 * @param laneWidthPx The width of the lane in CSS pixels.
 */
export function calculateFrameWidthPx(
  rate: Rational | null | undefined,
  totalDurationSeconds: number | null | undefined,
  laneWidthPx: number,
): number | null {
  if (
    !isValidRate(rate) ||
    !isPositiveFinite(totalDurationSeconds) ||
    !isPositiveFinite(laneWidthPx)
  ) {
    return null;
  }
  // The multiplications come first, as in `calculateSegmentWidthPx`.
  return (laneWidthPx * rate.d) / (rate.n * totalDurationSeconds);
}

/**
 * The rate of the frame bands, or null when no band shows. A band shows only on the exact frame
 * grid and only while one frame is at least `FRAME_BAND_MIN_WIDTH_PX` wide.
 *
 * @param gridRate The nominal frame rate of the exact frame grid while a precise seek is
 *   possible, or null off the grid or without a ready calibration.
 * @param totalDurationSeconds The source extent of the ruler (ADR 007).
 * @param laneWidthPx The width of the lane in CSS pixels.
 */
export function resolveFrameBandRate(
  gridRate: Rational | null,
  totalDurationSeconds: number | null,
  laneWidthPx: number,
): Rational | null {
  const widthPx = calculateFrameWidthPx(gridRate, totalDurationSeconds, laneWidthPx);
  return widthPx !== null &&
    widthPx >= FRAME_BAND_MIN_WIDTH_PX - FRAME_BAND_WIDTH_TOLERANCE_PX
    ? gridRate
    : null;
}

/** The nominal start of frame `frameIndex`, in seconds from the first frame. */
function nominalFrameStartSeconds(frameIndex: bigint, rate: Rational): number {
  return (Number(frameIndex) * rate.d) / rate.n;
}

/**
 * The layout of the span `[startSeconds, endSeconds)` on the lane, clamped to the source extent,
 * with the percent rule of `calculatePlayheadLayout`. Returns null when no part of the span lies
 * inside the extent.
 */
function layoutSpan(
  startSeconds: number,
  endSeconds: number,
  totalDurationSeconds: number,
): FrameBandLayout | null {
  const start = Math.max(0, Math.min(totalDurationSeconds, startSeconds));
  const end = Math.max(0, Math.min(totalDurationSeconds, endSeconds));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  const leftPercent = (start / totalDurationSeconds) * 100;
  const widthPercent = (end / totalDurationSeconds) * 100 - leftPercent;
  if (!(widthPercent > 0)) {
    return null;
  }
  return {
    leftPercent,
    widthPercent,
    left: `${leftPercent}%`,
    width: `${widthPercent}%`,
  };
}

/**
 * The frame index `J` of the frame timecode (ADR 028) for a tick delta from the first frame, or
 * null for a negative delta or invalid timing.
 */
function frameIndexOfPts(
  pts: Pts,
  videoStartPts: Pts,
  videoTimeBase: Rational,
  rate: Rational,
): bigint | null {
  if (!isPtsString(pts) || !isPtsString(videoStartPts)) {
    return null;
  }
  return frameIndexOfTicks(
    BigInt(pts) - BigInt(videoStartPts),
    videoTimeBase,
    rate,
    videoTimeBase,
  );
}

/**
 * Returns the frame index `J` that the preview timecode names for the displayed position, with
 * the order of `formatPreviewCurrentTime` (ADR 022, ADR 028):
 *
 * 1. A pending seek target: `floor((target + margin) * rate)`, the rule of `formatFrameTimecode`
 *    for seconds.
 * 2. The presented frame: `frameIndexOfTicks` of its tick delta from the first frame, the rule of
 *    `formatSourceRelativeTime`.
 *
 * Returns null without a ready calibration, because the grid needs the calibrated first frame,
 * and for a position before the first frame or with invalid timing.
 *
 * @param playback The playback facts of the displayed position.
 * @param videoStartPts The start PTS of the source video stream.
 * @param videoTimeBase The video time base of the source.
 * @param rate The nominal frame rate of the exact frame grid.
 */
export function resolveDisplayedFrameIndex(
  playback: FrameBandPlayback,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  rate: Rational,
): bigint | null {
  if (
    playback.calibrationStatus !== "ready" ||
    !isValidRate(rate) ||
    !isValidRate(videoTimeBase) ||
    !videoStartPts
  ) {
    return null;
  }
  const target = playback.seekTargetSeconds;
  if (typeof target === "number" && Number.isFinite(target) && target >= 0) {
    const shifted = target + frameBoundaryMarginSeconds(rate, videoTimeBase);
    const frame = Math.floor((shifted * rate.n) / rate.d);
    return Number.isSafeInteger(frame) && frame >= 0 ? BigInt(frame) : null;
  }
  if (playback.presentedFrame === null) {
    return null;
  }
  return frameIndexOfPts(
    playback.presentedFrame.inferredSourcePts,
    videoStartPts,
    videoTimeBase,
    rate,
  );
}

/**
 * The band of the frame on screen at the playhead: from the nominal start of the displayed frame
 * (`resolveDisplayedFrameIndex`) to the nominal start of the next frame, clamped to the source
 * extent. Returns null when no frame index is known or the frame lies outside the extent.
 *
 * @param playback The playback facts of the displayed position.
 * @param videoStartPts The start PTS of the source video stream.
 * @param videoTimeBase The video time base of the source.
 * @param rate The nominal frame rate of the exact frame grid (`resolveFrameBandRate`).
 * @param totalDurationSeconds The source extent of the ruler (ADR 007).
 */
export function calculatePlayheadFrameBand(
  playback: FrameBandPlayback,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  rate: Rational,
  totalDurationSeconds: number | null,
): FrameBandLayout | null {
  if (!isPositiveFinite(totalDurationSeconds)) {
    return null;
  }
  const frame = resolveDisplayedFrameIndex(
    playback,
    videoStartPts,
    videoTimeBase,
    rate,
  );
  if (frame === null) {
    return null;
  }
  return layoutSpan(
    nominalFrameStartSeconds(frame, rate),
    nominalFrameStartSeconds(frame + 1n, rate),
    totalDurationSeconds,
  );
}

/**
 * The band of the Out frame of a segment: from the Out, where the box of the segment ends, to
 * the nominal start of the frame after the Out frame, clamped to the source extent. The Out frame
 * is the frame that the Out PTS names by the rule of the frame timecode (ADR 028).
 *
 * The left edge is the elapsed time of the Out PTS, converted as `calculateSegmentLayout`
 * converts it, so the band meets the right edge of the segment with no gap. On the exact grid the
 * Out lies within one tick of the nominal start of its frame.
 *
 * Returns null for a segment that is not a valid pair, invalid timing, or an Out at or after the
 * end of the extent, where no Out frame is on the lane.
 *
 * @param segment The PTS pair of the segment.
 * @param videoStartPts The start PTS of the source video stream.
 * @param videoTimeBase The video time base of the source.
 * @param rate The nominal frame rate of the exact frame grid (`resolveFrameBandRate`).
 * @param totalDurationSeconds The source extent of the ruler (ADR 007).
 */
export function calculateOutFrameBand(
  segment: Pick<Segment, "inPts" | "outPts">,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  rate: Rational,
  totalDurationSeconds: number | null,
): FrameBandLayout | null {
  if (
    !isPositiveFinite(totalDurationSeconds) ||
    !isValidRate(rate) ||
    !isValidRate(videoTimeBase) ||
    !videoStartPts ||
    !isValidSegmentRange(segment.inPts, segment.outPts)
  ) {
    return null;
  }
  const frame = frameIndexOfPts(segment.outPts, videoStartPts, videoTimeBase, rate);
  if (frame === null) {
    return null;
  }
  // The conversion of `calculateSegmentLayout`, so the band starts where the segment ends.
  const outSeconds = ptsElapsedSeconds(segment.outPts, videoStartPts, videoTimeBase);
  if (outSeconds === null || outSeconds >= totalDurationSeconds) {
    return null;
  }
  return layoutSpan(
    outSeconds,
    nominalFrameStartSeconds(frame + 1n, rate),
    totalDurationSeconds,
  );
}
