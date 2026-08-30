/**
 * Pure math and layout helpers for single-source timeline editing.
 *
 * Implements ADR 002 exclusive out-point math, BigInt overflow safety,
 * source-order segment sorting, strict interior frame splitting,
 * and layout percentage calculations for UI rendering.
 */

import type { Segment } from "@/types/project";

/**
 * Calculates the ADR-002 exclusive out frame boundary from the current rendered frame.
 * Formula: `min(currentFrame + 1, frameCount)`
 * Uses BigInt to ensure safety when frame indices approach Number.MAX_SAFE_INTEGER.
 *
 * @param currentFrame Visible rendered frame index (inclusive).
 * @param frameCount Total video stream frame count (exclusive upper bound).
 * @returns Exclusive out frame index, or 0 if inputs are invalid.
 */
export function calculateExclusiveOutFrame(
  currentFrame: number,
  frameCount: number,
): number {
  if (
    !Number.isSafeInteger(currentFrame) ||
    !Number.isSafeInteger(frameCount) ||
    currentFrame < 0 ||
    frameCount <= 0 ||
    currentFrame >= frameCount
  ) {
    return 0;
  }

  const currentBig = BigInt(currentFrame);
  const frameCountBig = BigInt(frameCount);
  const outBig = currentBig + 1n;

  const resultBig = outBig < frameCountBig ? outBig : frameCountBig;
  return Number(resultBig);
}

/**
 * Compares two segments for sorting in source order.
 * Primary sort key: inFrame ascending.
 * Secondary sort key: outFrame ascending.
 * Tertiary sort key: id localeCompare.
 */
export function compareSegmentsInSourceOrder(a: Segment, b: Segment): number {
  if (a.inFrame !== b.inFrame) {
    return a.inFrame < b.inFrame ? -1 : 1;
  }
  if (a.outFrame !== b.outFrame) {
    return a.outFrame < b.outFrame ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Inserts a new segment into an ordered Segment array while preserving source order.
 */
export function insertSegmentInSourceOrder(
  segments: readonly Segment[],
  newSegment: Segment,
): Segment[] {
  const result = [...segments, newSegment];
  result.sort(compareSegmentsInSourceOrder);
  return result;
}

/**
 * Checks whether the Mark In button/action should be enabled.
 */
export function canMarkIn(
  isAttached: boolean,
  isReady: boolean,
  frameCount: number,
  currentFrame: number,
): boolean {
  return (
    isAttached &&
    isReady &&
    Number.isSafeInteger(frameCount) &&
    frameCount > 0 &&
    Number.isSafeInteger(currentFrame) &&
    currentFrame >= 0 &&
    currentFrame < frameCount
  );
}

/**
 * Checks whether the Mark Out button/action should be enabled.
 * Enabled only when an In mark is pending and the current frame produces a valid
 * exclusive out frame strictly greater than the pending In frame.
 */
export function canMarkOut(
  isAttached: boolean,
  isReady: boolean,
  frameCount: number,
  currentFrame: number,
  pendingInFrame: number | null,
): boolean {
  if (
    !isAttached ||
    !isReady ||
    !Number.isSafeInteger(frameCount) ||
    frameCount <= 0 ||
    pendingInFrame === null ||
    !Number.isSafeInteger(pendingInFrame) ||
    pendingInFrame < 0 ||
    pendingInFrame >= frameCount ||
    !Number.isSafeInteger(currentFrame) ||
    currentFrame < 0 ||
    currentFrame < pendingInFrame ||
    currentFrame >= frameCount
  ) {
    return false;
  }

  const outFrame = calculateExclusiveOutFrame(currentFrame, frameCount);
  return outFrame > pendingInFrame;
}

/**
 * Finds the index of a completed segment that strictly contains `currentFrame` as an interior frame.
 * Formula: `seg.inFrame < currentFrame && currentFrame < seg.outFrame`
 * Returns -1 if no segment strictly contains `currentFrame`.
 */
export function findSplittableSegmentIndex(
  segments: readonly Segment[],
  currentFrame: number,
): number {
  if (!Number.isSafeInteger(currentFrame) || currentFrame < 0) {
    return -1;
  }
  return segments.findIndex(
    (seg) => currentFrame > seg.inFrame && currentFrame < seg.outFrame,
  );
}

/**
 * Checks whether the Split button/action should be enabled.
 * Requires an attached, ready, nonempty source and a current frame strictly inside one segment.
 */
export function canSplitAtFrame(
  segments: readonly Segment[],
  currentFrame: number,
  isAttached?: boolean,
  isReady?: boolean,
  frameCount?: number,
): boolean {
  if (isAttached !== undefined && !isAttached) {
    return false;
  }
  if (isReady !== undefined && !isReady) {
    return false;
  }
  if (
    frameCount !== undefined &&
    (!Number.isSafeInteger(frameCount) || frameCount <= 0 || currentFrame >= frameCount)
  ) {
    return false;
  }
  return findSplittableSegmentIndex(segments, currentFrame) !== -1;
}

/**
 * Splits a segment at an interior frame index, retaining the left ID and assigning a new right ID.
 */
export function splitSegment(
  seg: Segment,
  currentFrame: number,
  newRightId: string,
): [Segment, Segment] {
  const leftSeg: Segment = {
    id: seg.id,
    sourceId: seg.sourceId,
    inFrame: seg.inFrame,
    outFrame: currentFrame,
  };
  const rightSeg: Segment = {
    id: newRightId,
    sourceId: seg.sourceId,
    inFrame: currentFrame,
    outFrame: seg.outFrame,
  };
  return [leftSeg, rightSeg];
}

/**
 * Maps a click/scrub offset in pixels along a track to a clamped integer frame index.
 * Handles boundary conditions (0, 1, MAX_SAFE_INTEGER, and out-of-bounds offsets).
 *
 * @param offsetX Horizontal pixel offset from the left edge of the track.
 * @param width Total width of the track element in pixels.
 * @param frameCount Total frame count in the source media.
 * @returns Clamped safe integer frame index in [0, frameCount - 1].
 */
export function calculateFrameFromOffset(
  offsetX: number,
  width: number,
  frameCount: number,
): number {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    return 0;
  }
  if (frameCount === 1) {
    return 0;
  }
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
    return 0;
  }
  if (typeof offsetX !== "number" || !Number.isFinite(offsetX) || offsetX <= 0) {
    return 0;
  }
  if (offsetX >= width) {
    return frameCount - 1;
  }

  const ratio = offsetX / width;
  const rawFrame = Math.floor(ratio * frameCount);
  return Math.min(frameCount - 1, Math.max(0, rawFrame));
}

/**
 * Maps a pointer clientX coordinate within a bounding client rect to a clamped integer frame index.
 * Ensures that visible source start (clientX === rectLeft) maps to frame 0 and
 * visible source end (clientX === rectLeft + rectWidth) maps to frameCount - 1.
 *
 * @param clientX Horizontal client coordinate of the pointer event.
 * @param rectLeft Left coordinate of the target element's bounding client rect.
 * @param rectWidth Width of the target element's bounding client rect.
 * @param frameCount Total frame count in the source media.
 * @returns Clamped safe integer frame index in [0, frameCount - 1].
 */
export function calculateFrameFromClientX(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  frameCount: number,
): number {
  if (
    typeof clientX !== "number" ||
    !Number.isFinite(clientX) ||
    typeof rectLeft !== "number" ||
    !Number.isFinite(rectLeft)
  ) {
    return 0;
  }
  const offsetX = clientX - rectLeft;
  return calculateFrameFromOffset(offsetX, rectWidth, frameCount);
}

/**
 * Computes the target frame index for timeline slider keyboard navigation.
 * Supported keys (WAI-ARIA slider pattern):
 * - "ArrowLeft" / "ArrowDown": step back 1 frame (clamped to 0)
 * - "ArrowRight" / "ArrowUp": step forward 1 frame (clamped to frameCount - 1)
 * - "Home": jump to frame 0
 * - "End": jump to frame frameCount - 1
 *
 * @param key KeyboardEvent key value.
 * @param currentFrame Current frame index.
 * @param frameCount Total frame count.
 * @returns Target clamped integer frame index, or null if key is unhandled or frameCount is invalid.
 */
export function calculateKeyboardSeekTargetFrame(
  key: string,
  currentFrame: number,
  frameCount: number,
): number | null {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0 || typeof key !== "string") {
    return null;
  }

  const maxFrame = frameCount - 1;
  const clampedCurrent =
    typeof currentFrame === "number" && Number.isFinite(currentFrame)
      ? Math.max(0, Math.min(maxFrame, Math.floor(currentFrame)))
      : 0;

  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return Math.max(0, clampedCurrent - 1);
    case "ArrowRight":
    case "ArrowUp":
      return Math.min(maxFrame, clampedCurrent + 1);
    case "Home":
      return 0;
    case "End":
      return maxFrame;
    default:
      return null;
  }
}

/**
 * Converts an integer frame index to a percentage position along the source timeline.
 * Clamps result strictly to [0, 100].
 */
export function calculatePercentFromFrame(frame: number, frameCount: number): number {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    return 0;
  }
  if (typeof frame !== "number" || !Number.isFinite(frame) || frame <= 0) {
    return 0;
  }
  if (frame >= frameCount) {
    return 100;
  }
  return (frame / frameCount) * 100;
}

export interface SegmentLayout {
  leftPercent: number;
  widthPercent: number;
  left: string;
  width: string;
}

/**
 * Calculates CSS percentage layout properties for a completed timeline segment overlay.
 */
export function calculateSegmentLayout(
  segment: Segment,
  frameCount: number,
): SegmentLayout {
  if (
    !Number.isSafeInteger(frameCount) ||
    frameCount <= 0 ||
    !segment ||
    !Number.isSafeInteger(segment.inFrame) ||
    !Number.isSafeInteger(segment.outFrame) ||
    segment.outFrame <= segment.inFrame
  ) {
    return { leftPercent: 0, widthPercent: 0, left: "0%", width: "0%" };
  }

  const inClamped = Math.max(0, Math.min(frameCount, segment.inFrame));
  const outClamped = Math.max(0, Math.min(frameCount, segment.outFrame));

  if (outClamped <= inClamped) {
    return { leftPercent: 0, widthPercent: 0, left: "0%", width: "0%" };
  }

  const leftPercent = (inClamped / frameCount) * 100;
  const widthPercent = ((outClamped - inClamped) / frameCount) * 100;

  return {
    leftPercent,
    widthPercent,
    left: leftPercent === 0 ? "0%" : `${leftPercent}%`,
    width: widthPercent === 0 ? "0%" : `${widthPercent}%`,
  };
}

export interface PendingInRegionLayout {
  isVisible: boolean;
  leftPercent: number;
  widthPercent: number;
  left: string;
  width: string;
}

/**
 * Calculates CSS percentage layout properties for a pending In region / preview span.
 */
export function calculatePendingInRegionLayout(
  pendingInFrame: number | null,
  currentFrame: number,
  frameCount: number,
): PendingInRegionLayout | null {
  if (
    pendingInFrame === null ||
    !Number.isSafeInteger(pendingInFrame) ||
    !Number.isSafeInteger(frameCount) ||
    frameCount <= 0 ||
    pendingInFrame < 0 ||
    pendingInFrame >= frameCount
  ) {
    return null;
  }

  const leftPercent = (pendingInFrame / frameCount) * 100;

  if (
    !Number.isSafeInteger(currentFrame) ||
    currentFrame < 0 ||
    currentFrame < pendingInFrame ||
    currentFrame >= frameCount
  ) {
    return {
      isVisible: false,
      leftPercent,
      widthPercent: 0,
      left: `${leftPercent}%`,
      width: "0%",
    };
  }

  const outFrame = calculateExclusiveOutFrame(currentFrame, frameCount);
  if (outFrame <= pendingInFrame) {
    return {
      isVisible: false,
      leftPercent,
      widthPercent: 0,
      left: `${leftPercent}%`,
      width: "0%",
    };
  }

  const widthPercent = ((outFrame - pendingInFrame) / frameCount) * 100;

  return {
    isVisible: true,
    leftPercent,
    widthPercent,
    left: `${leftPercent}%`,
    width: `${widthPercent}%`,
  };
}

export interface PlayheadLayout {
  percent: number;
  left: string;
}

/**
 * Calculates CSS percentage position for the playback playhead indicator.
 */
export function calculatePlayheadLayout(
  currentFrame: number,
  frameCount: number,
): PlayheadLayout {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    return { percent: 0, left: "0%" };
  }

  const clamped = Math.max(0, Math.min(frameCount - 1, Math.floor(currentFrame || 0)));
  const percent = (clamped / frameCount) * 100;

  return {
    percent,
    left: percent === 0 ? "0%" : `${percent}%`,
  };
}
