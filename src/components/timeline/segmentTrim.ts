/**
 * The pure model of the drag trim of a segment edge (ADR 030, with ADR 002, ADR 003, ADR 022
 * and ADR 028).
 *
 * A press on the edge hit area of a segment that moves past the drag threshold trims that
 * edge. The drag moves the playhead as a scrub does, and the release commits a frame that the
 * browser presented.
 *
 * The trim exists only on the exact frame grid: a ready calibration, a constant rate, and a
 * grid that is exact for the time base (`hasExactFrameGrid`, ADR 022). There each nominal frame
 * names one real frame, and a presented frame rounds to its own nominal frame, so the frame of
 * the release target can be recognized when it arrives. On any other source an edge press is
 * the click of ADR 007, and the user moves a boundary with Mark In and Mark Out.
 *
 * A written boundary is always one of these values, and never a PTS from a pixel position:
 *
 * - The stored PTS of the boundary that the drag snapped to, or the PTS of the frame that was on
 *   screen at the start of the trim, when the drag snapped to the playhead there.
 * - The PTS of a presented frame that rounds to the nominal frame of the release target.
 *
 * A pixel position only chooses a seek target, and the browser chooses the frame.
 *
 * The functions take plain facts and return decisions, so the tests need no store and no
 * document. `segmentTrimSession.ts` runs them against the stores, and the timeline panel feeds
 * the samples of its pointer gesture to that session.
 */

import { isTargetOnScreen } from "@/components/layout/shortcutCommands";
import {
  getDisplayedElapsedSeconds,
  getNominalFrameRate,
  hasExactFrameGrid,
  type PlaybackState,
} from "@/features/playback";
import { findCurrentSegment } from "@/features/timeline";
import {
  assertPositiveTimeBase,
  elapsedSecondsToPts,
  isPtsString,
  isTickCountString,
  isValidSegmentRange,
  ptsElapsedSeconds,
  ptsFromBigInt,
  ptsToBigInt,
  tickCountToBigInt,
} from "@/lib/time";
import { frameIndexOfTicks, lastFrameIndexOfExtent } from "@/lib/timecode";
import type { Pts, Rational, Segment, TickCount } from "@/types/project";
import type { ScrubSeekRequest } from "./scrubSeekPlan";
import { buildSnapBoundaries, type SnapBoundary } from "./scrubSnap";
import type { SegmentEdge } from "./segmentEdges";

/**
 * How long a released trim waits for a frame of its target frame, in milliseconds of visible
 * time, counted from the release. The count starts at the release and not at the `seeked`
 * event, so a seek that never completes is bounded too. A hidden or minimized window presents
 * no frames, so the session counts only while the document is visible, as the wait for the
 * calibration anchor does (ADR 003). After it, the trim is dropped, and the timeline says so
 * (ADR 030).
 */
export const TRIM_FRAME_WAIT_MS = 3000;

/** The probe facts that a trim reads. The probe of the open media satisfies it as it is. */
export interface SegmentTrimProbe {
  readonly videoStartPts: Pts | null | undefined;
  readonly videoTimeBase: Rational | null | undefined;
  readonly videoDurationTicks?: TickCount | null;
  readonly avgFrameRate?: Rational | null;
  readonly rFrameRate?: Rational | null;
}

/** The playback facts that a trim reads. The playback store state satisfies it as it is. */
export type SegmentTrimPlayback = Pick<
  PlaybackState,
  | "calibrationStatus"
  | "presentedFrame"
  | "seekTargetSeconds"
  | "approximateBrowserTimeSeconds"
  | "attachedSourceRevisionKey"
  | "isReady"
  | "isPlaying"
>;

/** One trim of one segment edge, as it was recorded at its start. */
export interface SegmentTrim {
  readonly segmentId: string;
  readonly edge: SegmentEdge;
  /** The active source of the timeline at the start. */
  readonly sourceId: string;
  /**
   * The revision key of the playback source at the start. A different key means that the
   * source changed, and the trim is dropped.
   */
  readonly sourceRevisionKey: string;
  readonly videoStartPts: Pts;
  readonly videoTimeBase: Rational;
  /** The nominal frame rate of the exact frame grid (`resolveTrimGridRate`). */
  readonly gridRate: Rational;
  /** The stored boundary that the trim moves, at the start. */
  readonly originalPts: Pts;
  /** The stored boundary of the other edge, at the start. The preview holds it still. */
  readonly fixedPts: Pts;
  /**
   * The limit of every seek target of the trim (`calculateTrimLimitPts`). The In edge seeks at
   * or before it, the Out edge at or after it.
   */
  readonly limitPts: Pts;
  /**
   * The last nominal frame of the source extent (`calculateTrimLastFrameIndex`). For the Out
   * edge it is at least the frame of the stored Out, a frame that the browser showed, because an
   * extent can end before the end of the last frame. Only the Out edge stops at it. Null when the
   * extent is not known.
   */
  readonly lastFrameIndex: bigint | null;
  /**
   * For the Out edge, the latest seek target: the nominal start of `lastFrameIndex`.
   * An Out edge dragged to the end of the source stops on the last frame, and the result is the
   * Out that Mark Out on the last frame gives (ADR 007). Null for the In edge, and when the
   * extent is not known.
   */
  readonly maxPts: Pts | null;
  /**
   * The PTS of the playhead where it was drawn at the start (`resolveTrimStartPlayhead`): the
   * frame on screen when no seek was pending, and otherwise the drawn position. Null when the
   * position has no PTS. The drag can snap to it, and `Escape` returns the playhead there.
   */
  readonly startPlayheadPts: Pts | null;
  /**
   * True when `startPlayheadPts` is the PTS of the frame on screen. A release on it then writes
   * it at once, because the browser presented that frame. A drawn position that is not a frame
   * is only a seek target, and a release on it commits a frame as any other target does.
   */
  readonly startPlayheadIsFrame: boolean;
}

/** The inputs of `planSegmentTrimStart`. */
export interface SegmentTrimStartInput {
  readonly segmentId: string;
  readonly edge: SegmentEdge;
  /** The segments of the project, in project order. */
  readonly segments: readonly Segment[];
  /** The active source of the timeline. */
  readonly sourceId: string | null;
  /** True while media is open and its element is attached and ready (`isSourceActive`). */
  readonly hasActiveSource: boolean;
  readonly playback: SegmentTrimPlayback;
  /** The probe of the open media, or null while no media is open. */
  readonly probe: SegmentTrimProbe | null;
  /** The source extent of the ruler (ADR 007), or null when it is not known. */
  readonly totalDurationSeconds: number | null;
}

/**
 * One nominal frame in ticks of the time base, rounded up (`ceil`) or down (`floor`) to a whole
 * tick, and never less than one tick. Without a nominal frame rate (ADR 003) it is one tick.
 * Returns null for a time base that is not positive.
 */
function nominalFrameTicks(
  frameRate: Rational | null,
  timeBase: Rational,
  rounding: "ceil" | "floor",
): bigint | null {
  try {
    assertPositiveTimeBase(timeBase);
  } catch {
    return null;
  }
  if (frameRate === null) {
    return 1n;
  }
  // One nominal frame is frameRate.d / frameRate.n seconds, and one tick is
  // timeBase.n / timeBase.d seconds. The quotient is exact in BigInt.
  const numerator = BigInt(frameRate.d) * BigInt(timeBase.d);
  const denominator = BigInt(frameRate.n) * BigInt(timeBase.n);
  const ticks =
    rounding === "ceil"
      ? (numerator + denominator - 1n) / denominator
      : numerator / denominator;
  return ticks < 1n ? 1n : ticks;
}

/**
 * The limit of the seek target of a trim (ADR 030): the In edge stops one nominal frame before
 * the Out, and the Out edge stops one nominal frame after the In.
 *
 * The nominal frame is the interval of the nominal frame rate (`getNominalFrameRate`, ADR 003)
 * in ticks. For the In edge it is rounded down, and for the Out edge up, each to at least one
 * tick. A real frame start lies within one tick of its nominal start, so the frame just before
 * the Out starts at or after `outPts` minus the rounded-down interval, and the In can reach it:
 * a segment of one frame stays possible at 29.97 fps on a 1/1000 time base. The frame just after
 * the In starts at or before `inPts` plus the rounded-up interval. With no nominal frame rate
 * the limit is one tick from the other edge. The commit still refuses a result that breaks
 * `inPts < outPts` (ADR 002).
 *
 * Returns null when the segment is not a valid pair, when the time base is not positive, or
 * when the limit leaves the signed 64-bit range.
 */
export function calculateTrimLimitPts(
  edge: SegmentEdge,
  segment: Pick<Segment, "inPts" | "outPts">,
  frameRate: Rational | null,
  timeBase: Rational,
): Pts | null {
  if (!isValidSegmentRange(segment.inPts, segment.outPts)) {
    return null;
  }
  const step = nominalFrameTicks(frameRate, timeBase, edge === "in" ? "floor" : "ceil");
  if (step === null) {
    return null;
  }
  const limit =
    edge === "in"
      ? ptsToBigInt(segment.outPts) - step
      : ptsToBigInt(segment.inPts) + step;
  try {
    return ptsFromBigInt(limit);
  } catch {
    return null;
  }
}

/**
 * The nominal frame rate of a source whose frame grid is exact, or null for any other source.
 * The test is `hasExactFrameGrid`, the test of the nominal step and of `seekToFrameIndex`
 * (ADR 022): a nominal rate that is not variable, and a grid that is exact for the time base
 * (ADR 028). A trim needs it, and a ready calibration too.
 */
export function resolveTrimGridRate(probe: SegmentTrimProbe | null): Rational | null {
  if (probe === null || !probe.videoTimeBase) {
    return null;
  }
  const rate = getNominalFrameRate(probe);
  if (
    rate === null ||
    !hasExactFrameGrid({
      avgFrameRate: probe.avgFrameRate,
      rFrameRate: probe.rFrameRate,
      videoTimeBase: probe.videoTimeBase,
    })
  ) {
    return null;
  }
  return rate;
}

/**
 * The source extent in ticks: `videoDurationTicks` when the probe reports it, and otherwise the
 * extent of the ruler in the nearest ticks, the conversion that a pointer at the end of the lane
 * uses (`calculatePtsFromClientX`). Null when neither is known.
 *
 * The fallback is approximate. Without `videoDurationTicks`, as for every Matroska and WebM
 * file, the extent of the ruler comes from the container duration or from the duration of the
 * element (ADR 007), and it can disagree with the video frames in either direction:
 *
 * - It can end after the last video frame. The cap of the Out edge then names a frame that the
 *   source does not have, the browser shows the frame before it, and an Out trim to the very end
 *   of such a source fails with the notice and writes nothing. The way to that Out is End and
 *   Mark Out (ADR 026).
 * - It can end before the end of the last frame, as a Matroska Duration written as the start of
 *   the last block does. The cap then names the frame before the last one. A stored Out is a
 *   frame that the browser showed, so `planSegmentTrimStart` raises the cap of the Out edge to at
 *   least the frame of the stored Out. The drag then does not move a stored Out on the last frame
 *   back on its first move. A stored Out before the last frame can still not reach the last frame
 *   by a drag, and End and Mark Out is again the way to it.
 */
function extentTicks(
  probe: SegmentTrimProbe,
  timeBase: Rational,
  totalDurationSeconds: number | null,
): bigint | null {
  const reported = probe.videoDurationTicks;
  if (reported && isTickCountString(reported)) {
    const ticks = tickCountToBigInt(reported);
    if (ticks > 0n) {
      return ticks;
    }
  }
  if (
    typeof totalDurationSeconds !== "number" ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0
  ) {
    return null;
  }
  const end = elapsedSecondsToPts(totalDurationSeconds, "0" as Pts, timeBase);
  return end === null ? null : ptsToBigInt(end);
}

/**
 * The last nominal frame of the source extent (`lastFrameIndexOfExtent`): the frame count of the
 * extent minus one. When the extent agrees with the video frames, a frame of this index is the
 * last frame that the browser can present, so an Out edge at the end of the source waits for it,
 * and not for the frame after it, which does not exist. `extentTicks` names the cases where the
 * extent disagrees. Null when the extent is not known, or shorter than half a frame.
 */
export function calculateTrimLastFrameIndex(
  probe: SegmentTrimProbe,
  gridRate: Rational,
  totalDurationSeconds: number | null,
): bigint | null {
  const timeBase = probe.videoTimeBase;
  if (!timeBase) {
    return null;
  }
  const ticks = extentTicks(probe, timeBase, totalDurationSeconds);
  return ticks === null ? null : lastFrameIndexOfExtent(ticks, timeBase, gridRate);
}

/**
 * The PTS of the nominal start of a frame, rounded up to a whole tick. On an exact frame grid its
 * frame by the rule of the frame timecode (ADR 028) is that frame, for one of two reasons:
 *
 * - On a whole-tick grid, the nominal start lies on a tick, so the PTS is the nominal start, and
 *   the margin of one microsecond is less than an interval.
 * - On any other exact grid, the PTS lies less than one tick after the nominal start, and the
 *   margin is one tick. One tick is less than half an interval, so the PTS plus the margin stays
 *   before the start of the next frame.
 */
function nominalFrameStartPts(
  videoStartPts: Pts,
  timeBase: Rational,
  gridRate: Rational,
  frameIndex: bigint,
): Pts | null {
  const numerator = frameIndex * BigInt(gridRate.d) * BigInt(timeBase.d);
  const denominator = BigInt(gridRate.n) * BigInt(timeBase.n);
  try {
    return ptsFromBigInt(
      ptsToBigInt(videoStartPts) + (numerator + denominator - 1n) / denominator,
    );
  } catch {
    return null;
  }
}

/**
 * The nominal frame that contains a PTS, by the rule of the frame timecode (ADR 028): the
 * index of the frame that contains the elapsed time plus the frame boundary margin. Null for a
 * PTS before the start of the source. It is the frame that `seekToFrameIndex` names with the
 * same index, because frame 0 of both starts at the frame that `videoStartPts` names.
 */
export function trimFrameIndexOf(trim: SegmentTrim, pts: Pts): bigint | null {
  if (!isPtsString(pts)) {
    return null;
  }
  return frameIndexOfTicks(
    ptsToBigInt(pts) - ptsToBigInt(trim.videoStartPts),
    trim.videoTimeBase,
    trim.gridRate,
    trim.videoTimeBase,
  );
}

/**
 * The nominal frame of a presented frame, rounded to the nearest frame, with a tie away from
 * zero (ADR 002). On an exact grid a real frame start lies within one tick of its nominal
 * start, so the rounding names its own frame, as the nominal step does (ADR 022). Null for a
 * PTS before the start of the source.
 */
export function trimNearestFrameIndexOf(trim: SegmentTrim, pts: Pts): bigint | null {
  return nearestFrameIndexOf(
    trim.videoStartPts,
    trim.videoTimeBase,
    trim.gridRate,
    pts,
  );
}

/** `trimNearestFrameIndexOf` for the grid of a trim that is not planned yet. */
function nearestFrameIndexOf(
  videoStartPts: Pts,
  timeBase: Rational,
  gridRate: Rational,
  pts: Pts,
): bigint | null {
  if (!isPtsString(pts)) {
    return null;
  }
  const ticks = ptsToBigInt(pts) - ptsToBigInt(videoStartPts);
  if (ticks < 0n) {
    return null;
  }
  // frames = ticks * timeBase * rate, as the exact quotient numerator / denominator.
  const numerator = ticks * BigInt(timeBase.n) * BigInt(gridRate.n);
  const denominator = BigInt(timeBase.d) * BigInt(gridRate.d);
  return (2n * numerator + denominator) / (2n * denominator);
}

/** The playhead at the start of a trim (`resolveTrimStartPlayhead`). */
export interface TrimStartPlayhead {
  readonly pts: Pts | null;
  /** True when `pts` is the PTS of the frame on screen. */
  readonly isFrame: boolean;
}

/**
 * The playhead at the start of a trim, where it was drawn (`getDisplayedElapsedSeconds`,
 * ADR 022): the frame on screen when no seek is pending, and otherwise the display target, or
 * the approximate clock. A drawn position that is not a frame is the nearest tick to its time. It
 * is only a seek target, and never a written value.
 */
export function resolveTrimStartPlayhead(
  playback: SegmentTrimPlayback,
  videoStartPts: Pts,
  videoTimeBase: Rational,
): TrimStartPlayhead {
  const frame = playback.presentedFrame;
  if (
    frame !== null &&
    playback.seekTargetSeconds === null &&
    isPtsString(frame.inferredSourcePts)
  ) {
    return { pts: frame.inferredSourcePts, isFrame: true };
  }
  const seconds = getDisplayedElapsedSeconds(playback, videoStartPts, videoTimeBase);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return { pts: null, isFrame: false };
  }
  return {
    pts: elapsedSecondsToPts(seconds, videoStartPts, videoTimeBase),
    isFrame: false,
  };
}

/**
 * Plans the start of a trim, or returns null when the press stays a click (ADR 030, ADR 007).
 *
 * The trim needs the condition of Mark In and Mark Out, an active source and a ready
 * calibration, and an exact frame grid (`resolveTrimGridRate`). It also needs a segment of the
 * active source with a valid PTS pair, a source that reports `videoStartPts`, a limit
 * (`calculateTrimLimitPts`), and room for the edge to move: an Out edge whose limit lies after
 * the nominal start of its last frame (`SegmentTrim.lastFrameIndex`) has none.
 */
export function planSegmentTrimStart(input: SegmentTrimStartInput): SegmentTrim | null {
  const { edge, playback, probe } = input;
  const gridRate = resolveTrimGridRate(probe);
  if (
    !input.hasActiveSource ||
    playback.calibrationStatus !== "ready" ||
    playback.attachedSourceRevisionKey === null ||
    input.sourceId === null ||
    probe === null ||
    gridRate === null ||
    !probe.videoStartPts ||
    !isPtsString(probe.videoStartPts) ||
    !probe.videoTimeBase ||
    (edge !== "in" && edge !== "out")
  ) {
    return null;
  }
  const current = findCurrentSegment(input.segments, input.segmentId, input.sourceId);
  if (current === null) {
    return null;
  }
  const { segment } = current;
  const startPts = probe.videoStartPts;
  const timeBase = probe.videoTimeBase;
  const limitPts = calculateTrimLimitPts(edge, segment, gridRate, timeBase);
  if (limitPts === null) {
    return null;
  }
  const extentLastFrameIndex = calculateTrimLastFrameIndex(
    probe,
    gridRate,
    input.totalDurationSeconds,
  );
  // An extent can end before the end of the last frame (`extentTicks`). A stored Out is a frame
  // that the browser showed, so the cap of the Out edge is at least its frame.
  const storedOutFrameIndex =
    edge === "out"
      ? nearestFrameIndexOf(startPts, timeBase, gridRate, segment.outPts)
      : null;
  const lastFrameIndex =
    extentLastFrameIndex !== null &&
    storedOutFrameIndex !== null &&
    storedOutFrameIndex > extentLastFrameIndex
      ? storedOutFrameIndex
      : extentLastFrameIndex;
  const maxPts =
    edge === "out" && lastFrameIndex !== null
      ? nominalFrameStartPts(startPts, timeBase, gridRate, lastFrameIndex)
      : null;
  if (maxPts !== null && ptsToBigInt(maxPts) < ptsToBigInt(limitPts)) {
    return null;
  }
  const start = resolveTrimStartPlayhead(playback, startPts, timeBase);
  return {
    segmentId: segment.id,
    edge,
    sourceId: input.sourceId,
    sourceRevisionKey: playback.attachedSourceRevisionKey,
    videoStartPts: startPts,
    videoTimeBase: timeBase,
    gridRate,
    originalPts: edge === "in" ? segment.inPts : segment.outPts,
    fixedPts: edge === "in" ? segment.outPts : segment.inPts,
    limitPts,
    lastFrameIndex,
    maxPts,
    startPlayheadPts: start.pts,
    startPlayheadIsFrame: start.isFrame,
  };
}

/**
 * True while the trim can still commit: the calibration is ready, the element is ready, and
 * the playback source is the one of the start. A lost calibration or a new source drops the
 * trim with no change (ADR 030).
 */
export function isTrimCurrent(
  trim: SegmentTrim,
  playback: SegmentTrimPlayback,
): boolean {
  return (
    playback.calibrationStatus === "ready" &&
    playback.isReady &&
    playback.attachedSourceRevisionKey === trim.sourceRevisionKey
  );
}

/**
 * True when a PTS is inside the range of the trim: for the In edge at or before the limit, and
 * for the Out edge at or after the limit and at or before the last frame of the source.
 */
export function isWithinTrimLimit(trim: SegmentTrim, pts: Pts): boolean {
  if (!isPtsString(pts)) {
    return false;
  }
  const value = ptsToBigInt(pts);
  const limit = ptsToBigInt(trim.limitPts);
  if (trim.edge === "in") {
    return value <= limit;
  }
  return value >= limit && (trim.maxPts === null || value <= ptsToBigInt(trim.maxPts));
}

/** Moves a PTS into the range of the trim (`isWithinTrimLimit`). */
export function clampTrimPts(trim: SegmentTrim, pts: Pts): Pts {
  if (isWithinTrimLimit(trim, pts)) {
    return pts;
  }
  if (
    trim.edge === "out" &&
    trim.maxPts !== null &&
    ptsToBigInt(pts) > ptsToBigInt(trim.maxPts)
  ) {
    return trim.maxPts;
  }
  return trim.limitPts;
}

/** The inputs of `collectTrimSnapBoundaries`. */
export interface TrimSnapSource {
  readonly trim: SegmentTrim;
  /** The segments of the project, in project order. */
  readonly segments: readonly Segment[];
  readonly totalDurationSeconds: number | null;
}

/** The snap targets of a trim (`collectTrimSnapBoundaries`). */
export interface TrimSnapSet {
  /** The boundaries that the drag can snap to, for `planScrubSeek`. */
  readonly boundaries: readonly SnapBoundary[];
  /**
   * The PTS values of the boundaries whose release writes the PTS at once: the stored
   * boundaries, and the playhead at the start when it was the frame on screen.
   */
  readonly exactPts: ReadonlySet<string>;
}

/**
 * Returns the snap targets of a trim (ADR 030).
 *
 * - The other boundaries of the active source: the In and the Out of each valid segment of
 *   the source, except the edge that the trim moves. A PTS that another boundary shares, such
 *   as the Out of a neighbour after a split, stays. A release on one writes its stored PTS.
 * - The playhead where it was drawn at the start. A release on it writes its PTS at once only
 *   when it was the frame on screen. A drawn position that was a pending display target is only
 *   a seek target, and the release commits a frame of it as of any other target.
 *
 * The pending In of the scrub snap (ADR 022) is not a target: the press selects the segment,
 * and a selection clears the pending In (ADR 007). A boundary outside the range of the trim is
 * left out, because no seek of the trim can reach it, and so is a boundary outside the source
 * extent (`buildSnapBoundaries`). The list is in time order and holds each PTS once.
 */
export function collectTrimSnapBoundaries(source: TrimSnapSource): TrimSnapSet {
  const { trim } = source;
  const total = source.totalDurationSeconds;
  if (typeof total !== "number") {
    return { boundaries: [], exactPts: new Set() };
  }

  const stored: Pts[] = [];
  for (const segment of source.segments) {
    if (
      segment.sourceId !== trim.sourceId ||
      !isPtsString(segment.inPts) ||
      !isPtsString(segment.outPts) ||
      !isValidSegmentRange(segment.inPts, segment.outPts)
    ) {
      continue;
    }
    const isTrimmed = segment.id === trim.segmentId;
    if (!(isTrimmed && trim.edge === "in")) {
      stored.push(segment.inPts);
    }
    if (!(isTrimmed && trim.edge === "out")) {
      stored.push(segment.outPts);
    }
  }
  const exactPts = new Set<string>(stored);
  const candidates = [...stored];
  if (trim.startPlayheadPts !== null) {
    candidates.push(trim.startPlayheadPts);
    if (trim.startPlayheadIsFrame) {
      exactPts.add(trim.startPlayheadPts);
    }
  }
  const boundaries = buildSnapBoundaries(
    candidates,
    trim.videoStartPts,
    trim.videoTimeBase,
    total,
  ).filter((boundary) => isWithinTrimLimit(trim, boundary.pts));
  return { boundaries, exactPts };
}

/**
 * Returns a memoized `collectTrimSnapBoundaries`. It builds the list again only when a field
 * of its input changes identity, as `createSnapBoundaryCache` does, so a drag builds it once
 * and not once for each sample.
 */
export function createTrimSnapBoundaryCache(): (source: TrimSnapSource) => TrimSnapSet {
  let lastSource: TrimSnapSource | null = null;
  let lastSnaps: TrimSnapSet = { boundaries: [], exactPts: new Set() };
  return (source) => {
    if (
      lastSource === null ||
      lastSource.trim !== source.trim ||
      lastSource.segments !== source.segments ||
      lastSource.totalDurationSeconds !== source.totalDurationSeconds
    ) {
      lastSnaps = collectTrimSnapBoundaries(source);
      lastSource = source;
    }
    return lastSnaps;
  };
}

/** The seek target of one sample of a trim. */
export interface TrimTarget {
  /** The PTS that the sample seeks to. */
  readonly pts: Pts;
  /**
   * The boundary that the sample snapped to, or null for a target from the pointer position or
   * from the range of the trim.
   */
  readonly snap: SnapBoundary | null;
  /**
   * True when a release on this target writes its PTS at once: a snap to a stored boundary, or
   * to the frame that was on screen at the start (`TrimSnapSet.exactPts`).
   */
  readonly writesAtOnce: boolean;
}

/**
 * The seek target of one sample of a trim, from the seek plan of the sample
 * (`planScrubSeek`), or null for no seek.
 *
 * A trim seeks only to a PTS: it needs a ready calibration, so a request in seconds on the
 * approximate clock is no target. A snap keeps the PTS of its boundary, which
 * `collectTrimSnapBoundaries` already keeps inside the range of the trim. A target from the
 * pointer position is clamped to that range (ADR 030), and it then has no snap.
 */
export function resolveTrimTarget(
  trim: SegmentTrim,
  request: ScrubSeekRequest | null,
  snap: SnapBoundary | null,
  snaps: TrimSnapSet,
): TrimTarget | null {
  if (request === null || request.kind !== "pts" || !isPtsString(request.pts)) {
    return null;
  }
  if (snap !== null && snap.pts === request.pts && isWithinTrimLimit(trim, snap.pts)) {
    return { pts: snap.pts, snap, writesAtOnce: snaps.exactPts.has(snap.pts) };
  }
  return { pts: clampTrimPts(trim, request.pts), snap: null, writesAtOnce: false };
}

/**
 * The nominal frame of a release target, kept inside the range of the trim: for the In edge, a
 * frame before the frame of the Out, and for the Out edge, a frame after the frame of the In and
 * no later than the last frame of the source. The stored boundaries are frame starts, so their
 * nearest frame is their own frame.
 */
function releaseFrameIndex(trim: SegmentTrim, target: Pts): bigint | null {
  const index = trimFrameIndexOf(trim, target);
  const fixed = trimNearestFrameIndexOf(trim, trim.fixedPts);
  if (index === null || fixed === null) {
    return null;
  }
  if (trim.edge === "in") {
    return index < fixed ? index : fixed - 1n;
  }
  const last = trim.lastFrameIndex;
  const capped = last !== null && index > last ? last : index;
  return capped > fixed ? capped : fixed + 1n;
}

/**
 * A seek that a trim sends: `seekToPts` to a PTS, or `seekToFrameIndex` to a nominal frame of
 * the grid. `seekToFrameIndex` aims at the middle of the frame and shows the nominal start of
 * the frame as the display target, so the playhead and the preview edge do not move when the
 * frame arrives, and the browser shows that frame and not the one before it (ADR 022).
 */
export type TrimSeek =
  | { readonly kind: "pts"; readonly pts: Pts }
  | { readonly kind: "frame"; readonly frameIndex: bigint };

/** What the release of a trim does (`planTrimRelease`). */
export type TrimReleasePlan =
  /** The trim makes no change. */
  | { readonly kind: "drop" }
  /** Write `pts` at once. `seek` is the seek to send, or null when none is needed. */
  | { readonly kind: "write"; readonly pts: Pts; readonly seek: TrimSeek | null }
  /**
   * Seek to nominal frame `frameIndex`, then wait for a presented frame that rounds to it
   * (`resolveTrimAwait`).
   */
  | { readonly kind: "wait"; readonly frameIndex: bigint };

const DROP: { readonly kind: "drop" } = Object.freeze({ kind: "drop" });

/**
 * True when the frame on screen rounds to nominal frame `frameIndex` and no seek is pending, so
 * a seek to that frame is not needed, and could bring no frame callback (ADR 022).
 */
function isFrameOnScreen(
  trim: SegmentTrim,
  playback: SegmentTrimPlayback,
  frameIndex: bigint,
): boolean {
  const frame = playback.presentedFrame;
  return (
    frame !== null &&
    playback.seekTargetSeconds === null &&
    trimNearestFrameIndexOf(trim, frame.inferredSourcePts) === frameIndex
  );
}

/**
 * Plans the release of a trim (ADR 030). The playback state is the one before the release
 * sends any seek.
 *
 * - A trim that can no longer commit (`isTrimCurrent`), or a release with no target, makes no
 *   change.
 * - A snap to a stored boundary, or to the frame that was on screen at the start, writes its PTS
 *   at once. The release seeks to its frame with `seekToFrameIndex`, unless that frame is
 *   already on screen with no seek pending.
 * - Otherwise the target names nominal frame J, the frame that contains it (ADR 028), kept
 *   inside the range of the trim. When the frame on screen rounds to J, its PTS is written at
 *   once. A pending seek, such as the scrub seek of the drag, still gets the seek to frame J, so
 *   the drag does not end on another frame (ADR 022). When the frame on screen is not frame J,
 *   the release seeks to frame J and waits for a frame that rounds to J.
 */
export function planTrimRelease(
  trim: SegmentTrim,
  target: TrimTarget | null,
  playback: SegmentTrimPlayback,
): TrimReleasePlan {
  if (target === null || !isTrimCurrent(trim, playback)) {
    return DROP;
  }
  if (target.writesAtOnce) {
    const pts = target.pts;
    const frameIndex = trimNearestFrameIndexOf(trim, pts);
    let seek: TrimSeek | null;
    if (isTargetOnScreen(playback, pts)) {
      seek = null;
    } else if (frameIndex === null) {
      seek = { kind: "pts", pts };
    } else {
      seek = isFrameOnScreen(trim, playback, frameIndex)
        ? null
        : { kind: "frame", frameIndex };
    }
    return { kind: "write", pts, seek };
  }
  const frameIndex = releaseFrameIndex(trim, target.pts);
  if (frameIndex === null || frameIndex < 0n) {
    return DROP;
  }
  const frame = playback.presentedFrame;
  if (
    frame !== null &&
    trimNearestFrameIndexOf(trim, frame.inferredSourcePts) === frameIndex
  ) {
    return {
      kind: "write",
      pts: frame.inferredSourcePts,
      seek: playback.seekTargetSeconds === null ? null : { kind: "frame", frameIndex },
    };
  }
  return { kind: "wait", frameIndex };
}

/** A released trim that waits for a frame of its target frame. */
export interface TrimAwait {
  readonly trim: SegmentTrim;
  /** Nominal frame J of the release. */
  readonly frameIndex: bigint;
  /**
   * The display target that the seek of the release left in the store. A later request sets
   * another one, and the trim is then dropped.
   */
  readonly awaitedTargetSeconds: number | null;
}

/**
 * Starts the wait of a released trim, from the playback state just after the seek of the
 * release, or returns null when it cannot wait.
 */
export function beginTrimAwait(
  trim: SegmentTrim,
  plan: Extract<TrimReleasePlan, { kind: "wait" }>,
  after: SegmentTrimPlayback,
): TrimAwait | null {
  if (!isTrimCurrent(trim, after) || after.isPlaying) {
    return null;
  }
  return {
    trim,
    frameIndex: plan.frameIndex,
    awaitedTargetSeconds: after.seekTargetSeconds,
  };
}

/** What a waiting trim does for one playback state (`resolveTrimAwait`). */
export type TrimAwaitDecision =
  /** A frame commits the trim: write `pts`, the PTS of `presentedFrame`. */
  | { readonly kind: "write"; readonly pts: Pts }
  /** Keep waiting. */
  | { readonly kind: "wait" }
  /** The trim makes no change. */
  | { readonly kind: "drop" };

/**
 * Decides a waiting trim for one playback state (ADR 030). The session asks it once just after
 * the seek of the release, and again for each later state, so each frame callback checks the
 * frame on screen once more.
 *
 * - A lost calibration, an element that is not ready, a new source, or a playback that started
 *   drops the trim.
 * - A frame on screen that rounds to frame J commits, also while the display target is still
 *   set, and whichever callback put it there: the frame of the release seek, or a late callback
 *   of the drag that arrives out of order. On the exact grid a frame of index J is frame J, so
 *   its PTS is the frame that the user chose. A frame of any other index never commits: a late
 *   callback for a frame that the element composited before the seek completed, such as a
 *   keyframe of the scrub, is not that frame.
 * - A display target that changed to another value means that a later request replaced the
 *   seek of the release, so the trim is dropped. A target that cleared keeps the wait: the store
 *   can clear it on the late callback of another frame.
 * - Any other state keeps the wait. The session bounds it at `TRIM_FRAME_WAIT_MS` of visible
 *   time from the release, and the timeline then says that the trim was not applied.
 */
export function resolveTrimAwait(
  awaiting: TrimAwait,
  playback: SegmentTrimPlayback,
): TrimAwaitDecision {
  if (!isTrimCurrent(awaiting.trim, playback) || playback.isPlaying) {
    return DROP;
  }
  const frame = playback.presentedFrame;
  if (
    frame !== null &&
    trimNearestFrameIndexOf(awaiting.trim, frame.inferredSourcePts) ===
      awaiting.frameIndex
  ) {
    return { kind: "write", pts: frame.inferredSourcePts };
  }
  if (
    playback.seekTargetSeconds !== null &&
    playback.seekTargetSeconds !== awaiting.awaitedTargetSeconds
  ) {
    return DROP;
  }
  return WAIT;
}

const WAIT: { readonly kind: "wait" } = Object.freeze({ kind: "wait" });

/**
 * True when the stored segment still holds the boundaries of the start of the trim, so a write
 * from the trim keeps its meaning (ADR 030). An edit during the trim, such as an undo, can move
 * or remove the segment, and the limit and the preview of the trim would then be stale. The
 * write must also keep `inPts < outPts` (ADR 002).
 */
export function canCommitTrim(
  trim: SegmentTrim,
  segments: readonly Segment[],
  sourceId: string | null,
  pts: Pts,
): boolean {
  if (sourceId !== trim.sourceId || !isPtsString(pts)) {
    return false;
  }
  const current = findCurrentSegment(segments, trim.segmentId, sourceId);
  if (current === null) {
    return false;
  }
  const { inPts, outPts } = current.segment;
  const [original, fixed] = trim.edge === "in" ? [inPts, outPts] : [outPts, inPts];
  if (original !== trim.originalPts || fixed !== trim.fixedPts) {
    return false;
  }
  return trim.edge === "in"
    ? isValidSegmentRange(pts, outPts)
    : isValidSegmentRange(inPts, pts);
}

/**
 * The seek of `Escape` during a trim: back to where the playhead was drawn at the start
 * (ADR 030), or null for no seek.
 *
 * The seek goes to the nominal frame of that position (`seekToFrameIndex`), as the release does:
 * the frame of the frame on screen, or the ADR 028 frame of a drawn position. The playhead then
 * shows the nominal start of that frame, which is where a pending grid step drew it. No seek
 * runs when the start has no PTS, when the trim can no longer seek exactly, or when that frame is
 * still on screen with no seek pending, because a seek onto the frame on screen could bring no
 * frame callback (ADR 022).
 */
export function planTrimCancel(
  trim: SegmentTrim,
  playback: SegmentTrimPlayback,
): TrimSeek | null {
  const pts = trim.startPlayheadPts;
  if (
    pts === null ||
    !isTrimCurrent(trim, playback) ||
    isTargetOnScreen(playback, pts)
  ) {
    return null;
  }
  const frameIndex = trim.startPlayheadIsFrame
    ? trimNearestFrameIndexOf(trim, pts)
    : trimFrameIndexOf(trim, pts);
  if (frameIndex === null) {
    return { kind: "pts", pts };
  }
  return isFrameOnScreen(trim, playback, frameIndex)
    ? null
    : { kind: "frame", frameIndex };
}

/** The box of the trim preview, in percent of the lane, as `calculateSegmentLayout` gives it. */
export interface TrimPreviewLayout {
  readonly leftPercent: number;
  readonly widthPercent: number;
  readonly left: string;
  readonly width: string;
}

/**
 * The box of the preview of a trimmed segment: from the fixed edge to the displayed playhead
 * position, which follows the display target of the seek (ADR 022, ADR 030). It is display
 * only, and it never becomes an edit value. The seek targets of the trim stay inside its range,
 * so the moving edge does too: an Out edge at the end of the source shows the start of the last
 * frame.
 *
 * The moving end uses the clamp and the expression of `calculatePlayheadLayout`, so it lies
 * under the playhead. Returns null when the time axis is not usable, or when the box has no
 * width.
 */
export function calculateTrimPreviewLayout(
  edge: SegmentEdge,
  fixedPts: Pts,
  displayedElapsedSeconds: number,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  totalDurationSeconds: number | null | undefined,
): TrimPreviewLayout | null {
  if (
    !videoStartPts ||
    !videoTimeBase ||
    typeof totalDurationSeconds !== "number" ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0 ||
    !Number.isFinite(displayedElapsedSeconds)
  ) {
    return null;
  }
  const fixedSeconds = ptsElapsedSeconds(fixedPts, videoStartPts, videoTimeBase);
  if (fixedSeconds === null) {
    return null;
  }
  const clamp = (seconds: number) =>
    Math.max(0, Math.min(totalDurationSeconds, seconds));
  const fixedPercent = (clamp(fixedSeconds) / totalDurationSeconds) * 100;
  const movingPercent = (clamp(displayedElapsedSeconds) / totalDurationSeconds) * 100;
  const leftPercent = edge === "in" ? movingPercent : fixedPercent;
  const rightPercent = edge === "in" ? fixedPercent : movingPercent;
  if (!(rightPercent > leftPercent)) {
    return null;
  }
  const widthPercent = rightPercent - leftPercent;
  return {
    leftPercent,
    widthPercent,
    left: `${leftPercent}%`,
    width: `${widthPercent}%`,
  };
}
