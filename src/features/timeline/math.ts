/**
 * Pure math and layout helpers for single-source and multi-source timeline editing.
 *
 * Implements ADR 002 (rational time / source PTS / exclusive out points),
 * ADR 003 (calibrated RVFC PTS presentation / nominal navigation),
 * ADR 007 (single-track source-time timeline / extent precedence / multi-source duration math),
 * and ADR 010 (canonical decimal PTS string format).
 */

import {
  assertPositiveTimeBase,
  elapsedSecondsToPts,
  isPtsString,
  isValidSegmentRange,
  ptsElapsedSeconds,
  segmentDurationTicks,
  ticksToSeconds,
} from "@/lib/time";
import type { Pts, Rational, Segment, TickCount } from "@/types/project";
import type { CalibrationStatus, PresentedFrame } from "@/features/playback";

/** The current segment together with its index in the project array. */
export interface CurrentSegmentRef {
  readonly index: number;
  readonly segment: Segment;
}

/**
 * Resolves the segment every segment operation names as its target.
 *
 * Returns null for a null identifier, an unknown identifier, or a segment of another
 * source. The last case matters: Mark In and Mark Out on a foreign segment would compare
 * a PTS across time bases, which ADR 002 forbids.
 */
export function findCurrentSegment(
  segments: readonly Segment[],
  currentSegmentId: string | null,
  activeSourceId: string | null | undefined,
): CurrentSegmentRef | null {
  if (currentSegmentId === null || !activeSourceId) {
    return null;
  }
  const index = segments.findIndex((seg) => seg.id === currentSegmentId);
  if (index === -1) {
    return null;
  }
  const segment = segments[index];
  if (segment.sourceId !== activeSourceId) {
    return null;
  }
  return { index, segment };
}

/**
 * Splits a segment at an interior PTS, retaining the left ID and assigning a new right ID (ADR 002, ADR 007).
 * Produces adjacent half-open intervals [inPts, pts) and [pts, outPts).
 */
export function splitSegment(
  seg: Segment,
  pts: Pts,
  newRightId: string,
): [Segment, Segment] {
  const leftSeg: Segment = {
    id: seg.id,
    sourceId: seg.sourceId,
    inPts: seg.inPts,
    outPts: pts,
  };
  const rightSeg: Segment = {
    id: newRightId,
    sourceId: seg.sourceId,
    inPts: pts,
    outPts: seg.outPts,
  };
  return [leftSeg, rightSeg];
}

/**
 * Reads the inferred PTS of a presented frame, but only while the whole presentation
 * state can produce a canonical edit boundary.
 */
function markablePts(
  calibrationStatus: CalibrationStatus,
  presentedFrame: PresentedFrame | null,
  hasActiveSource: boolean,
): Pts | null {
  if (
    !hasActiveSource ||
    calibrationStatus !== "ready" ||
    presentedFrame === null ||
    !isPtsString(presentedFrame.inferredSourcePts)
  ) {
    return null;
  }
  return presentedFrame.inferredSourcePts;
}

/**
 * Checks whether the Mark In button/action should be enabled.
 *
 * With no current segment, Mark In creates a pending mark, so it is enabled whenever
 * calibration is ready, a presented frame with a valid inferred PTS is present, and an
 * active source exists.
 *
 * With a current segment, Mark In instead moves that segment's In boundary, so it is
 * enabled only while the move would change the segment and would still leave
 * `inPts < outPts` (ADR 002). A current segment whose stored PTS does not parse admits no
 * move, so Mark In is disabled: the store reads the same state as "adjust" and would
 * reject the mark.
 */
export function canMarkIn(
  calibrationStatus: CalibrationStatus,
  presentedFrame: PresentedFrame | null,
  hasActiveSource: boolean,
  currentTarget?: CurrentSegmentTarget | null,
): boolean {
  const pts = markablePts(calibrationStatus, presentedFrame, hasActiveSource);
  if (pts === null) {
    return false;
  }
  if (!currentTarget?.hasSegment) {
    return true;
  }
  if (currentTarget.bounds === null) {
    return false;
  }
  const value = BigInt(pts);
  return value !== currentTarget.bounds.lo && value < currentTarget.bounds.hi;
}

/**
 * Checks whether the Mark Out button/action should be enabled.
 *
 * With no current segment, Mark Out completes the pending In mark, so it needs a pending
 * mark and an inferred PTS strictly greater than it. Equal `inPts` and `outPts` stay
 * rejected (ADR 002).
 *
 * With a current segment, Mark Out instead moves that segment's Out boundary, so it is
 * enabled only while the move would change the segment and would still leave
 * `inPts < outPts`. The store invariant keeps `pendingInPts` null in this case, so the
 * pending mark is not consulted, and an unparseable segment disables the action for the
 * same reason as in `canMarkIn`.
 */
export function canMarkOut(
  calibrationStatus: CalibrationStatus,
  presentedFrame: PresentedFrame | null,
  pendingInPts: Pts | null,
  hasActiveSource: boolean,
  currentTarget?: CurrentSegmentTarget | null,
): boolean {
  const pts = markablePts(calibrationStatus, presentedFrame, hasActiveSource);
  if (pts === null) {
    return false;
  }
  if (currentTarget?.hasSegment) {
    if (currentTarget.bounds === null) {
      return false;
    }
    const value = BigInt(pts);
    return value !== currentTarget.bounds.hi && currentTarget.bounds.lo < value;
  }
  if (pendingInPts === null || !isPtsString(pendingInPts)) {
    return false;
  }
  return isValidSegmentRange(pendingInPts, pts);
}

/** Exact half-open bounds of one segment, parsed once so a per-frame test can reuse them. */
export interface SegmentBounds {
  readonly sourceId: string;
  readonly lo: bigint;
  readonly hi: bigint;
}

/**
 * Parses the segment array into exact bounds once per change of the array.
 * Drops a segment with a malformed PTS, which `isPtsInsideSegment` also never reports as
 * containing a PTS. An unordered pair is kept, because `lo < pts && pts < hi` rejects it.
 */
export function getSegmentBounds(segments: readonly Segment[]): SegmentBounds[] {
  const bounds: SegmentBounds[] = [];
  segments.forEach((seg) => {
    if (!isPtsString(seg.inPts) || !isPtsString(seg.outPts)) {
      return;
    }
    bounds.push({
      sourceId: seg.sourceId,
      lo: BigInt(seg.inPts),
      hi: BigInt(seg.outPts),
    });
  });
  return bounds;
}

/**
 * Checks whether the Split button/action should be enabled.
 * Enabled only when calibration is ready, a presented frame is present, an active source
 * exists, and the inferred PTS is strictly inside the current segment (ADR 007).
 *
 * Costs one BigInt construction and two comparisons, so it is cheap enough to run on
 * every presented frame.
 */
export function canSplitCurrentSegment(
  currentTarget: CurrentSegmentTarget | null | undefined,
  calibrationStatus: CalibrationStatus,
  presentedFrame: PresentedFrame | null,
  hasActiveSource: boolean,
): boolean {
  const pts = markablePts(calibrationStatus, presentedFrame, hasActiveSource);
  const bounds = currentTarget?.bounds ?? null;
  if (pts === null || bounds === null) {
    return false;
  }
  const value = BigInt(pts);
  return bounds.lo < value && value < bounds.hi;
}

/**
 * The target of a segment action: whether a segment is current, and its exact bounds.
 *
 * The two facts are separate fields because the predicates must tell "no current segment"
 * apart from "a current segment whose stored PTS does not parse". Both leave `bounds`
 * null, but the first enables Mark In and the second cannot enable any boundary move.
 */
export interface CurrentSegmentTarget {
  /** True while a segment of the active source is current. */
  readonly hasSegment: boolean;
  /** Exact half-open bounds, or null when a stored PTS is malformed. */
  readonly bounds: SegmentBounds | null;
}

/**
 * Resolves the target of a segment action, parsing its bounds when the stored PTS pair is
 * canonical. An unordered pair is kept, because `lo < pts && pts < hi` rejects it.
 */
export function getCurrentSegmentTarget(
  current: CurrentSegmentRef | null | undefined,
): CurrentSegmentTarget {
  if (!current) {
    return { hasSegment: false, bounds: null };
  }
  return {
    hasSegment: true,
    bounds: getSegmentBounds([current.segment])[0] ?? null,
  };
}

export interface ActiveSourceSegmentEntry {
  readonly segment: Segment;
  readonly projectIndex: number;
}

/** Selects active-source overlays without changing their project array indices or order. */
export function getActiveSourceSegmentEntries(
  segments: readonly Segment[],
  activeSourceId: string | null | undefined,
): ActiveSourceSegmentEntry[] {
  if (!activeSourceId) {
    return [];
  }
  const entries: ActiveSourceSegmentEntry[] = [];
  segments.forEach((segment, projectIndex) => {
    if (segment.sourceId === activeSourceId) {
      entries.push({ segment, projectIndex });
    }
  });
  return entries;
}

/**
 * Extent descriptor for resolving ruler extent and duration according to ADR 007.
 */
export interface SourceTimelineExtentDescriptor {
  readonly videoDurationTicks?: TickCount | null;
  readonly videoTimeBase?: Rational | null;
  readonly approximateDurationSeconds?: number | null;
  readonly runtimeBrowserDuration?: number | null;
}

/**
 * Resolves the timeline ruler extent duration in seconds according to ADR 007 precedence:
 * 1. `videoDurationTicks` through `videoTimeBase` when present and valid.
 * 2. Finite strictly positive persisted `approximateDurationSeconds`.
 * 3. Finite strictly positive runtime `runtimeBrowserDuration` (HTMLMediaElement.duration).
 * 4. Otherwise null (indeterminate ruler with click-seeking disabled).
 */
export function getTimelineDurationSeconds(
  descriptor: SourceTimelineExtentDescriptor | null | undefined,
): number | null {
  if (!descriptor) {
    return null;
  }

  // 1. videoDurationTicks with videoTimeBase
  if (descriptor.videoDurationTicks && descriptor.videoTimeBase) {
    const sec = ticksToSeconds(descriptor.videoDurationTicks, descriptor.videoTimeBase);
    if (sec !== null && Number.isFinite(sec) && sec > 0) {
      return sec;
    }
  }

  // 2. approximateDurationSeconds
  if (
    typeof descriptor.approximateDurationSeconds === "number" &&
    Number.isFinite(descriptor.approximateDurationSeconds) &&
    descriptor.approximateDurationSeconds > 0
  ) {
    return descriptor.approximateDurationSeconds;
  }

  // 3. runtimeBrowserDuration
  if (
    typeof descriptor.runtimeBrowserDuration === "number" &&
    Number.isFinite(descriptor.runtimeBrowserDuration) &&
    descriptor.runtimeBrowserDuration > 0
  ) {
    return descriptor.runtimeBrowserDuration;
  }

  // 4. Indeterminate
  return null;
}

// ---------------------------------------------------------------------------
// Exact multi-source cumulative duration helpers (BigInt rational math)
// ---------------------------------------------------------------------------

/**
 * Exact BigInt rational fraction `{ n: bigint, d: bigint }`.
 */
export type BigIntRational = {
  n: bigint;
  d: bigint;
};

/**
 * Calculates greatest common divisor of two BigInt values.
 */
export function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/**
 * Reduces a BigInt fraction and ensures positive denominator.
 */
export function reduceBigIntRational(n: bigint, d: bigint): BigIntRational {
  if (d === 0n) {
    throw new RangeError("Denominator cannot be zero in BigIntRational");
  }
  let num = n;
  let den = d;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  if (num === 0n) {
    return { n: 0n, d: 1n };
  }
  const g = gcdBigInt(num, den);
  return { n: num / g, d: den / g };
}

/**
 * Adds two BigInt rational fractions exactly.
 */
export function addBigIntRationals(
  a: BigIntRational,
  b: BigIntRational,
): BigIntRational {
  const num = a.n * b.d + b.n * a.d;
  const den = a.d * b.d;
  return reduceBigIntRational(num, den);
}

/**
 * Converts an exact BigInt rational to a JavaScript floating-point number at UI/browser boundaries.
 */
export function bigIntRationalToSeconds(r: BigIntRational): number | null {
  if (r.d === 0n) {
    return null;
  }
  const sec = Number(r.n) / Number(r.d);
  return Number.isFinite(sec) ? sec : null;
}

/**
 * Calculates the exact duration of a segment as a BigIntRational fraction in seconds:
 * `(outPts - inPts) * (timeBase.n / timeBase.d)`
 */
export function calculateSegmentDurationRational(
  inPts: Pts,
  outPts: Pts,
  videoTimeBase: Rational,
): BigIntRational | null {
  if (!isValidSegmentRange(inPts, outPts)) {
    return null;
  }
  try {
    assertPositiveTimeBase(videoTimeBase);
  } catch {
    return null;
  }
  const deltaTicks = segmentDurationTicks(inPts, outPts);
  if (deltaTicks === null) {
    return null;
  }
  const num = deltaTicks * BigInt(videoTimeBase.n);
  const den = BigInt(videoTimeBase.d);
  return reduceBigIntRational(num, den);
}

/**
 * Source timebase lookup table or resolver function for multi-source calculations.
 */
export type TimeBaseResolver =
  | ReadonlyMap<string, { videoTimeBase: Rational } | Rational>
  | ((sourceId: string) => Rational | { videoTimeBase: Rational } | null | undefined);

function resolveSourceTimeBase(
  resolver: TimeBaseResolver,
  sourceId: string,
): Rational | null {
  if (typeof resolver === "function") {
    const res = resolver(sourceId);
    if (!res) return null;
    return "videoTimeBase" in res ? res.videoTimeBase : res;
  }
  const val = resolver.get(sourceId);
  if (!val) return null;
  return "videoTimeBase" in val ? val.videoTimeBase : val;
}

/**
 * Calculates the exact cumulative total duration for an ordered array of segments across multiple sources
 * using BigInt rational arithmetic (ADR 002, ADR 007).
 * Preserves project segment array order and never compares raw PTS across sourceIds.
 */
export function calculateTotalDurationRational(
  segments: readonly Segment[],
  timeBaseResolver: TimeBaseResolver,
): BigIntRational | null {
  let total: BigIntRational = { n: 0n, d: 1n };
  for (const seg of segments) {
    const tb = resolveSourceTimeBase(timeBaseResolver, seg.sourceId);
    if (!tb) {
      return null;
    }
    const dur = calculateSegmentDurationRational(seg.inPts, seg.outPts, tb);
    if (!dur) {
      return null;
    }
    total = addBigIntRationals(total, dur);
  }
  return total;
}

export interface SegmentTimelinePosition {
  readonly segmentId: string;
  readonly sourceId: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly durationSeconds: number;
  readonly startRational: BigIntRational;
  readonly endRational: BigIntRational;
  readonly durationRational: BigIntRational;
}

/**
 * Calculates cumulative timeline positions for ordered multi-source segments using exact BigInt rational arithmetic.
 * Converts to floating-point seconds only at the final boundary.
 */
export function calculateSegmentTimelinePositions(
  segments: readonly Segment[],
  timeBaseResolver: TimeBaseResolver,
): SegmentTimelinePosition[] | null {
  let currentStart: BigIntRational = { n: 0n, d: 1n };
  const positions: SegmentTimelinePosition[] = [];

  for (const seg of segments) {
    const tb = resolveSourceTimeBase(timeBaseResolver, seg.sourceId);
    if (!tb) {
      return null;
    }
    const dur = calculateSegmentDurationRational(seg.inPts, seg.outPts, tb);
    if (!dur) {
      return null;
    }
    const nextStart = addBigIntRationals(currentStart, dur);
    const startSec = bigIntRationalToSeconds(currentStart);
    const endSec = bigIntRationalToSeconds(nextStart);
    const durSec = bigIntRationalToSeconds(dur);

    if (startSec === null || endSec === null || durSec === null) {
      return null;
    }

    positions.push({
      segmentId: seg.id,
      sourceId: seg.sourceId,
      startSeconds: startSec,
      endSeconds: endSec,
      durationSeconds: durSec,
      startRational: currentStart,
      endRational: nextStart,
      durationRational: dur,
    });

    currentStart = nextStart;
  }

  return positions;
}

// ---------------------------------------------------------------------------
// Single-source layout helpers
// ---------------------------------------------------------------------------

export interface SegmentLayout {
  leftPercent: number;
  widthPercent: number;
  left: string;
  width: string;
}

/**
 * Calculates CSS percentage layout properties for a completed timeline segment overlay on single source timeline.
 */
export function calculateSegmentLayout(
  segment: Segment,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  totalDurationSeconds: number | null | undefined,
): SegmentLayout {
  if (
    !segment ||
    !videoStartPts ||
    !videoTimeBase ||
    !isPtsString(segment.inPts) ||
    !isPtsString(segment.outPts) ||
    !isValidSegmentRange(segment.inPts, segment.outPts) ||
    typeof totalDurationSeconds !== "number" ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0
  ) {
    return { leftPercent: 0, widthPercent: 0, left: "0%", width: "0%" };
  }

  try {
    assertPositiveTimeBase(videoTimeBase);
  } catch {
    return { leftPercent: 0, widthPercent: 0, left: "0%", width: "0%" };
  }

  const inElapsed = ptsElapsedSeconds(segment.inPts, videoStartPts, videoTimeBase);
  const outElapsed = ptsElapsedSeconds(segment.outPts, videoStartPts, videoTimeBase);

  if (inElapsed === null || outElapsed === null) {
    return { leftPercent: 0, widthPercent: 0, left: "0%", width: "0%" };
  }

  const clampedIn = Math.max(0, Math.min(totalDurationSeconds, inElapsed));
  const clampedOut = Math.max(0, Math.min(totalDurationSeconds, outElapsed));

  if (clampedOut <= clampedIn) {
    return { leftPercent: 0, widthPercent: 0, left: "0%", width: "0%" };
  }

  const leftPercent = (clampedIn / totalDurationSeconds) * 100;
  const widthPercent = ((clampedOut - clampedIn) / totalDurationSeconds) * 100;

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
  pendingInPts: Pts | null | undefined,
  currentPts: Pts | null | undefined,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  totalDurationSeconds: number | null | undefined,
): PendingInRegionLayout | null {
  if (
    !pendingInPts ||
    !videoStartPts ||
    !videoTimeBase ||
    !isPtsString(pendingInPts) ||
    !isPtsString(videoStartPts) ||
    typeof totalDurationSeconds !== "number" ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0
  ) {
    return null;
  }

  try {
    assertPositiveTimeBase(videoTimeBase);
  } catch {
    return null;
  }

  const inElapsed = ptsElapsedSeconds(pendingInPts, videoStartPts, videoTimeBase);
  if (inElapsed === null) {
    return null;
  }

  const clampedIn = Math.max(0, Math.min(totalDurationSeconds, inElapsed));
  const leftPercent = (clampedIn / totalDurationSeconds) * 100;

  if (
    !currentPts ||
    !isPtsString(currentPts) ||
    !isValidSegmentRange(pendingInPts, currentPts)
  ) {
    return {
      isVisible: false,
      leftPercent,
      widthPercent: 0,
      left: `${leftPercent}%`,
      width: "0%",
    };
  }

  const outElapsed = ptsElapsedSeconds(currentPts, videoStartPts, videoTimeBase);
  if (outElapsed === null) {
    return {
      isVisible: false,
      leftPercent,
      widthPercent: 0,
      left: `${leftPercent}%`,
      width: "0%",
    };
  }

  const clampedOut = Math.max(0, Math.min(totalDurationSeconds, outElapsed));
  if (clampedOut <= clampedIn) {
    return {
      isVisible: false,
      leftPercent,
      widthPercent: 0,
      left: `${leftPercent}%`,
      width: "0%",
    };
  }

  const widthPercent = ((clampedOut - clampedIn) / totalDurationSeconds) * 100;

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
  elapsedSeconds: number | null | undefined,
  totalDurationSeconds: number | null | undefined,
): PlayheadLayout {
  if (
    typeof elapsedSeconds !== "number" ||
    !Number.isFinite(elapsedSeconds) ||
    typeof totalDurationSeconds !== "number" ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0
  ) {
    return { percent: 0, left: "0%" };
  }

  const clamped = Math.max(0, Math.min(totalDurationSeconds, elapsedSeconds));
  const percent = (clamped / totalDurationSeconds) * 100;

  return {
    percent,
    left: percent === 0 ? "0%" : `${percent}%`,
  };
}

/**
 * Converts a PTS to a percentage along the single-source timeline axis.
 */
export function calculatePercentFromPts(
  pts: Pts,
  videoStartPts: Pts,
  videoTimeBase: Rational,
  totalDurationSeconds: number,
): number {
  if (
    !isPtsString(pts) ||
    !isPtsString(videoStartPts) ||
    typeof totalDurationSeconds !== "number" ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0
  ) {
    return 0;
  }
  try {
    assertPositiveTimeBase(videoTimeBase);
  } catch {
    return 0;
  }
  const elapsed = ptsElapsedSeconds(pts, videoStartPts, videoTimeBase);
  if (elapsed === null || elapsed <= 0) {
    return 0;
  }
  if (elapsed >= totalDurationSeconds) {
    return 100;
  }
  return (elapsed / totalDurationSeconds) * 100;
}

/** Maps a finite timeline coordinate to approximate elapsed seconds for browser seeking. */
export function calculateTimelineSecondsFromClientX(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  totalDurationSeconds: number,
): number | null {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(rectLeft) ||
    !Number.isFinite(rectWidth) ||
    rectWidth <= 0 ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds < 0
  ) {
    return null;
  }
  const ratio = Math.max(0, Math.min(1, (clientX - rectLeft) / rectWidth));
  const seconds = ratio * totalDurationSeconds;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Maps a click/scrub clientX coordinate along a timeline track to a target PTS.
 */
export function calculatePtsFromClientX(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  totalDurationSeconds: number,
  videoStartPts: Pts,
  videoTimeBase: Rational,
): Pts | null {
  if (
    typeof clientX !== "number" ||
    !Number.isFinite(clientX) ||
    typeof rectLeft !== "number" ||
    !Number.isFinite(rectLeft) ||
    typeof rectWidth !== "number" ||
    !Number.isFinite(rectWidth) ||
    rectWidth <= 0 ||
    typeof totalDurationSeconds !== "number" ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0 ||
    !isPtsString(videoStartPts)
  ) {
    return null;
  }
  try {
    assertPositiveTimeBase(videoTimeBase);
  } catch {
    return null;
  }

  const targetSeconds = calculateTimelineSecondsFromClientX(
    clientX,
    rectLeft,
    rectWidth,
    totalDurationSeconds,
  );
  if (targetSeconds === null) {
    return null;
  }

  return elapsedSecondsToPts(targetSeconds, videoStartPts, videoTimeBase);
}
