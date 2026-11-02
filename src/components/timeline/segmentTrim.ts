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
 * On a sequence of several clips with no shared frame grid (ADR 052), the trim uses the grid of
 * the clip that holds the moving edge (`TrimClipGrid`), and the edge stays inside that clip. A
 * sequence whose clips share one grid trims on that grid, across the junctions.
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
  clipAtVirtualPts,
  type VirtualClip,
  type VirtualTimeline,
} from "@/features/timeline/virtualTime";
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
import {
  frameIndexOfTicks,
  lastFrameIndexOfApproximateExtent,
  lastFrameIndexOfExtent,
} from "@/lib/timecode";
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

/**
 * The frame grid of the clip that holds the moving edge, on a sequence of several clips with no
 * shared frame grid (ADR 052). Every PTS here is on the axis of the lane, the virtual axis.
 */
export interface TrimClipGrid {
  readonly clipId: string;
  /** The PTS of frame 0 of the grid: the first frame of the source of the clip. */
  readonly originPts: Pts;
  /** The video time base of the source of the clip. It sets the frame boundary margin. */
  readonly videoTimeBase: Rational;
  /** The ticks of the lane for one tick of `videoTimeBase`. */
  readonly scale: bigint;
  /** The PTS where the clip starts. */
  readonly startPts: Pts;
  /** The PTS where the clip ends, or null when the extent of the clip is not known. */
  readonly endPts: Pts | null;
}

/**
 * The sequence facts that a trim on the grid of a clip reads: the virtual axis, and the probe of
 * each source by source ID.
 */
export interface TrimSequence {
  readonly virtual: VirtualTimeline;
  readonly sources: Readonly<Record<string, { readonly probe: SegmentTrimProbe }>>;
  /**
   * The clip that the preview shows, or null during a cold switch. A trim on the grid of a clip
   * starts only on an edge of this clip: the drag stays inside the clip, so it never attaches
   * another one, and the calibration holds to the release.
   */
  readonly attachedClipId: string | null;
}

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
  /** The start PTS of the lane. The snap targets and the playhead count from it. */
  readonly videoStartPts: Pts;
  /** The time base of the lane. */
  readonly videoTimeBase: Rational;
  /**
   * The nominal frame rate of the exact frame grid (`resolveTrimGridRate`): of the one source,
   * or of the clip of `clip`.
   */
  readonly gridRate: Rational;
  /**
   * The grid of the clip that holds the moving edge, on a sequence of several clips with no
   * shared frame grid. Absent for the one source, and for a sequence with one shared grid: the
   * frames then count from `videoStartPts`.
   */
  readonly clip?: TrimClipGrid;
  /**
   * The earliest seek target, on the grid of a clip: the start of the clip. Absent for the one
   * source and for a shared grid.
   */
  readonly minPts?: Pts;
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
   * extent can end before the end of the last frame. The Out edge stops at it, and on the grid of
   * a clip (`clip`) the In edge too. Null when the extent is not known.
   */
  readonly lastFrameIndex: bigint | null;
  /**
   * For the Out edge, the latest seek target: the nominal start of `lastFrameIndex`.
   * An Out edge dragged to the end of the source stops on the last frame, and the result is the
   * Out that Mark Out on the last frame gives (ADR 007). Null when the extent is not known. Null
   * for the In edge too, except on the grid of a clip, where the In stops on the last frame of
   * the clip.
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
  /**
   * The sequence, while it has several clips. When its probe has no exact frame grid, the trim
   * uses the grid of the clip of the moving edge (`TrimClipGrid`). Absent or null otherwise.
   */
  readonly sequence?: TrimSequence | null;
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
 *
 * @param timeBase The video time base of the source of the grid. The interval rounds to its
 *   ticks, the ticks of the real frame starts.
 * @param scale The ticks of the segment PTS for one tick of `timeBase`: 1 for the one source, and
 *   the scale of the clip on the virtual axis of a sequence (`TrimClipGrid.scale`).
 */
export function calculateTrimLimitPts(
  edge: SegmentEdge,
  segment: Pick<Segment, "inPts" | "outPts">,
  frameRate: Rational | null,
  timeBase: Rational,
  scale = 1n,
): Pts | null {
  if (!isValidSegmentRange(segment.inPts, segment.outPts)) {
    return null;
  }
  const ticks = nominalFrameTicks(
    frameRate,
    timeBase,
    edge === "in" ? "floor" : "ceil",
  );
  if (ticks === null || scale < 1n) {
    return null;
  }
  const step = ticks * scale;
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

/** The source extent in ticks, and whether the video stream reported it. */
interface TrimExtent {
  readonly ticks: bigint;
  /**
   * True for `videoDurationTicks`, false for the approximate extent of the ruler. The two take
   * different last-frame rules (`calculateTrimLastFrameIndex`).
   */
  readonly reported: boolean;
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
 * - It can end after the last video frame, usually by a few milliseconds, because the audio runs
 *   longer. The rounding of `lastFrameIndexOfApproximateExtent` absorbs an end up to half a frame
 *   late. A later end makes the cap of the Out edge name a frame that the source does not have,
 *   the browser shows the frame before it, and an Out trim to the very end of such a source fails
 *   with the notice and writes nothing. The way to that Out is End and Mark Out (ADR 026).
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
): TrimExtent | null {
  const reported = probe.videoDurationTicks;
  if (reported && isTickCountString(reported)) {
    const ticks = tickCountToBigInt(reported);
    if (ticks > 0n) {
      return { ticks, reported: true };
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
  return end === null ? null : { ticks: ptsToBigInt(end), reported: false };
}

/**
 * The last nominal frame of the source extent. When the extent agrees with the video frames, a
 * frame of this index is the last frame that the browser can present, so an Out edge at the end
 * of the source waits for it, and not for the frame after it, which does not exist.
 *
 * - For `videoDurationTicks`, the extent of the video stream, it is `lastFrameIndexOfExtent`:
 *   the last frame that starts inside the extent by more than the frame boundary margin, also a
 *   last frame shorter than an interval. End goes to the same frame (ADR 026).
 * - For the approximate extent of the ruler, it is `lastFrameIndexOfApproximateExtent`: the
 *   extent in whole frames, rounded to the nearest, minus one. That extent usually ends a few
 *   milliseconds after the video, and the rounding keeps such an end on the last frame.
 *
 * `extentTicks` names the cases where the extent disagrees with the video frames. Null when the
 * extent is not known, or holds no frame.
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
  const extent = extentTicks(probe, timeBase, totalDurationSeconds);
  if (extent === null) {
    return null;
  }
  return extent.reported
    ? lastFrameIndexOfExtent(extent.ticks, timeBase, gridRate)
    : lastFrameIndexOfApproximateExtent(extent.ticks, timeBase, gridRate);
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
  // On the grid of a clip, frame 0 is the first frame of its source, and the margin is the one
  // of its own time base, as the timecode of that source names its frames.
  return frameIndexOfTicks(
    ptsToBigInt(pts) - ptsToBigInt(trim.clip?.originPts ?? trim.videoStartPts),
    trim.videoTimeBase,
    trim.gridRate,
    trim.clip?.videoTimeBase ?? trim.videoTimeBase,
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
    trim.clip?.originPts ?? trim.videoStartPts,
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
  if (gridRate === null) {
    // The probe of a sequence has a rate only while its clips share one frame grid. Without
    // one, the trim uses the grid of the clip of the edge (ADR 052).
    const sequence = input.sequence;
    return sequence == null || sequence.virtual.clips.length < 2
      ? null
      : planClipTrimStart({
          segment,
          edge,
          sourceId: input.sourceId,
          sourceRevisionKey: playback.attachedSourceRevisionKey,
          laneStartPts: startPts,
          laneTimeBase: timeBase,
          playback,
          sequence,
        });
  }
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

/** The inputs of `planClipTrimStart`. */
interface ClipTrimStartInput {
  readonly segment: Segment;
  readonly edge: SegmentEdge;
  readonly sourceId: string;
  readonly sourceRevisionKey: string;
  /** The start PTS of the lane: the origin of the virtual axis. */
  readonly laneStartPts: Pts;
  /** The time base of the lane: the virtual time base. */
  readonly laneTimeBase: Rational;
  readonly playback: SegmentTrimPlayback;
  readonly sequence: TrimSequence;
}

/** `ptsFromBigInt`, or null for a value outside the signed 64-bit range. */
function ptsOrNull(value: bigint): Pts | null {
  try {
    return ptsFromBigInt(value);
  } catch {
    return null;
  }
}

/**
 * The clip that holds the moving edge: the clip of the In, and for the Out the clip of the last
 * frame of the segment, one tick before the Out. A junction belongs to the later clip
 * (`clipAtVirtualPts`), so an Out on a junction belongs to the clip before it. Null when that
 * position lies outside every clip.
 */
function edgeClipOf(
  virtual: VirtualTimeline,
  segment: Pick<Segment, "inPts" | "outPts">,
  edge: SegmentEdge,
): VirtualClip | null {
  const value =
    edge === "in" ? ptsToBigInt(segment.inPts) : ptsToBigInt(segment.outPts) - 1n;
  const pts = ptsOrNull(value);
  const clip = pts === null ? null : clipAtVirtualPts(virtual, pts);
  if (clip === null) {
    return null;
  }
  const start = ptsToBigInt(virtual.originPts) + clip.startTicks;
  const inside =
    value >= start &&
    (clip.durationTicks === null || value < start + clip.durationTicks);
  return inside ? clip : null;
}

/**
 * Plans a trim on the grid of the clip that holds the moving edge (ADR 052, ADR 030). The rules
 * of `planSegmentTrimStart` apply on that grid, and the edge stays inside the clip:
 *
 * - The In edge goes from the start of the clip to the limit, and no later than the start of the
 *   last frame of the clip.
 * - The Out edge goes from the limit, and no earlier than the start of the clip, to the start of
 *   the last frame of the clip. As for one source, a stored Out after that frame raises the cap
 *   to its own frame, and the cap stays before the end of the clip.
 * - A stored Out on the junction at the end of the clip is the one form of ADR 052 for a segment
 *   that ends with the clip. It is no frame of the clip, because the next clip starts there. The
 *   cap of the Out edge is then that junction, which a release writes at once
 *   (`resolveTrimTarget`). So a drag never moves that Out back by itself (ADR 030).
 *
 * The trim starts only on an edge of the clip that the preview shows (`TrimSequence`), and only a
 * frame inside the clip counts as a frame of its grid (`isClipFramePts`).
 *
 * The limit is one nominal frame of the clip from the other edge, rounded in the ticks of the
 * source of the clip (`calculateTrimLimitPts`). Returns null when the clip has no exact frame grid,
 * when the edge has no room, or when a value leaves the range of a PTS.
 */
function planClipTrimStart(input: ClipTrimStartInput): SegmentTrim | null {
  const { segment, edge, sequence, laneTimeBase } = input;
  const clip = edgeClipOf(sequence.virtual, segment, edge);
  const probe = clip === null ? undefined : sequence.sources[clip.sourceId]?.probe;
  const gridRate = probe === undefined ? null : resolveTrimGridRate(probe);
  if (
    clip === null ||
    clip.clipId !== sequence.attachedClipId ||
    probe === undefined ||
    gridRate === null ||
    clip.rangeStart === null ||
    !probe.videoStartPts ||
    !isPtsString(probe.videoStartPts) ||
    !probe.videoTimeBase
  ) {
    return null;
  }
  const clipTimeBase = probe.videoTimeBase;
  const start = ptsToBigInt(sequence.virtual.originPts) + clip.startTicks;
  const origin =
    start + (ptsToBigInt(probe.videoStartPts) - clip.rangeStart) * clip.scale;
  const end = clip.durationTicks === null ? null : start + clip.durationTicks;
  const originPts = ptsOrNull(origin);
  const startPts = ptsOrNull(start);
  const endPts = end === null ? null : ptsOrNull(end);
  const limitPts = calculateTrimLimitPts(
    edge,
    segment,
    gridRate,
    clipTimeBase,
    clip.scale,
  );
  if (
    originPts === null ||
    startPts === null ||
    (end !== null && endPts === null) ||
    limitPts === null
  ) {
    return null;
  }

  // The last frame of the clip on its grid. The extent counts from frame 0 of the grid, in ticks
  // of the source, so the rules of `calculateTrimLastFrameIndex` apply as for one source: an
  // exact extent takes the rule of a reported extent, and an estimate the rule of an approximate
  // one.
  let extentLastFrameIndex: bigint | null = null;
  if (end !== null && end > origin) {
    const extentTicks = (end - origin) / clip.scale;
    extentLastFrameIndex = clip.exactDuration
      ? lastFrameIndexOfExtent(extentTicks, clipTimeBase, gridRate)
      : lastFrameIndexOfApproximateExtent(extentTicks, clipTimeBase, gridRate);
  }
  const onJunction =
    edge === "out" && end !== null && ptsToBigInt(segment.outPts) === end;
  const storedOutFrameIndex =
    edge === "out" && !onJunction
      ? nearestFrameIndexOf(originPts, laneTimeBase, gridRate, segment.outPts)
      : null;
  const lastFrameIndex =
    extentLastFrameIndex !== null &&
    storedOutFrameIndex !== null &&
    storedOutFrameIndex > extentLastFrameIndex
      ? storedOutFrameIndex
      : extentLastFrameIndex;
  let maxPts = onJunction
    ? endPts
    : lastFrameIndex === null
      ? null
      : nominalFrameStartPts(originPts, laneTimeBase, gridRate, lastFrameIndex);
  // A cap rounds up to a tick, and a raised cap can then reach the end of the clip. The cap then
  // stops on the stored Out, a frame of the clip, or for the In on the last tick of the clip. A
  // clip too short to hold a whole frame has no last frame, and its last tick bounds both edges.
  if (!onJunction && maxPts !== null && end !== null && ptsToBigInt(maxPts) >= end) {
    maxPts = edge === "out" ? segment.outPts : ptsOrNull(end - 1n);
  } else if (maxPts === null && end !== null) {
    maxPts = ptsOrNull(end - 1n);
  }

  // The edge needs room inside the clip and inside the limit.
  const limit = ptsToBigInt(limitPts);
  const lower = edge === "in" ? start : limit > start ? limit : start;
  const cap = maxPts === null ? null : ptsToBigInt(maxPts);
  const upper = edge === "in" ? (cap !== null && cap < limit ? cap : limit) : cap;
  if (upper !== null && upper < lower) {
    return null;
  }

  const playhead = resolveTrimStartPlayhead(
    input.playback,
    input.laneStartPts,
    laneTimeBase,
  );
  return {
    segmentId: segment.id,
    edge,
    sourceId: input.sourceId,
    sourceRevisionKey: input.sourceRevisionKey,
    videoStartPts: input.laneStartPts,
    videoTimeBase: laneTimeBase,
    gridRate,
    clip: {
      clipId: clip.clipId,
      originPts,
      videoTimeBase: clipTimeBase,
      scale: clip.scale,
      startPts,
      endPts,
    },
    minPts: startPts,
    originalPts: edge === "in" ? segment.inPts : segment.outPts,
    fixedPts: edge === "in" ? segment.outPts : segment.inPts,
    limitPts,
    lastFrameIndex,
    maxPts,
    startPlayheadPts: playhead.pts,
    startPlayheadIsFrame: playhead.isFrame,
  };
}

/**
 * Where a drag on a segment edge can trim (ADR 030, ADR 052): on every edge, on the edges inside
 * one clip, or on none. The resize cursor of the edges reads it, so an edge shows that cursor only
 * when a drag on it can start a trim.
 */
export type TrimEdgeSpan =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | {
      readonly kind: "clip";
      /** The PTS where the clip starts, on the axis of the lane. */
      readonly startPts: Pts;
      /** The PTS where the clip ends, or null when its extent is not known. */
      readonly endPts: Pts | null;
    };

const EVERY_EDGE: TrimEdgeSpan = Object.freeze({ kind: "all" });
const NO_EDGE: TrimEdgeSpan = Object.freeze({ kind: "none" });

/** The inputs of `resolveTrimEdgeSpan`. */
export interface TrimEdgeSpanInput {
  /**
   * True on the exact frame grid of the one source, or of a sequence whose clips share one grid,
   * while a precise seek is possible (`resolveTrimGridRate` of the probe of the lane).
   */
  readonly hasLaneGrid: boolean;
  /** True while a precise seek is possible. */
  readonly canUsePreciseSeek: boolean;
  readonly isDecodeStalled: boolean;
  /** The sequence while it has several clips (`TrimSequence`), or null. */
  readonly sequence: TrimSequence | null;
}

/**
 * Resolves where a drag can trim (`TrimEdgeSpan`):
 *
 * - Nowhere during a decode stall, as the trim does not start then.
 * - On every edge on the exact grid of the lane.
 * - On a sequence whose clips share no grid, on the edges inside the clip on screen, while that
 *   clip has an exact frame grid (`planClipTrimStart`). An edge is inside it by the rule of the
 *   trim: the In, and the last frame of the segment for the Out (`canTrimEdgeOf`).
 * - Nowhere else.
 */
export function resolveTrimEdgeSpan(input: TrimEdgeSpanInput): TrimEdgeSpan {
  if (input.isDecodeStalled) {
    return NO_EDGE;
  }
  if (input.hasLaneGrid) {
    return EVERY_EDGE;
  }
  const sequence = input.sequence;
  if (
    !input.canUsePreciseSeek ||
    sequence === null ||
    sequence.attachedClipId === null
  ) {
    return NO_EDGE;
  }
  const clip = sequence.virtual.clips.find(
    (entry) => entry.clipId === sequence.attachedClipId,
  );
  const probe = clip === undefined ? undefined : sequence.sources[clip.sourceId]?.probe;
  // The fixed facts that `planClipTrimStart` needs, so the cursor promises no trim it refuses.
  if (
    clip === undefined ||
    probe === undefined ||
    clip.rangeStart === null ||
    !probe.videoStartPts ||
    !isPtsString(probe.videoStartPts) ||
    resolveTrimGridRate(probe) === null
  ) {
    return NO_EDGE;
  }
  const start = ptsToBigInt(sequence.virtual.originPts) + clip.startTicks;
  const startPts = ptsOrNull(start);
  const endPts =
    clip.durationTicks === null ? null : ptsOrNull(start + clip.durationTicks);
  if (startPts === null || (clip.durationTicks !== null && endPts === null)) {
    return NO_EDGE;
  }
  return { kind: "clip", startPts, endPts };
}

/**
 * True when a drag on edge `edge` of `segment` can start a trim, by `span`. Inside a clip span, the
 * In edge counts by the In, and the Out edge by the last frame of the segment, one tick before the
 * Out, as `edgeClipOf` finds the clip of a trim. So an Out on the junction at the end of the clip
 * counts, and an Out on the junction at its start does not.
 */
export function canTrimEdgeOf(
  span: TrimEdgeSpan,
  segment: Pick<Segment, "inPts" | "outPts">,
  edge: SegmentEdge,
): boolean {
  if (span.kind !== "clip") {
    return span.kind === "all";
  }
  const boundary = edge === "in" ? segment.inPts : segment.outPts;
  if (!isPtsString(boundary)) {
    return false;
  }
  const value = ptsToBigInt(boundary) - (edge === "in" ? 0n : 1n);
  return (
    value >= ptsToBigInt(span.startPts) &&
    (span.endPts === null || value < ptsToBigInt(span.endPts))
  );
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
 * The range of the seek targets of a trim, as the bounds of `isWithinTrimLimit`. A null bound is
 * open.
 *
 * - The In edge: from `minPts`, the start of the clip of a clip grid, to the limit, and on a clip
 *   grid no later than `maxPts`, the start of the last frame of the clip.
 * - The Out edge: from the limit, and on a clip grid no earlier than `minPts`, to `maxPts`, the
 *   start of the last frame.
 */
function trimRange(trim: SegmentTrim): {
  readonly lower: Pts | null;
  readonly upper: Pts | null;
} {
  const min = trim.minPts ?? null;
  const later = (a: Pts, b: Pts | null): Pts =>
    b !== null && ptsToBigInt(b) > ptsToBigInt(a) ? b : a;
  const earlier = (a: Pts, b: Pts | null): Pts =>
    b !== null && ptsToBigInt(b) < ptsToBigInt(a) ? b : a;
  if (trim.edge === "in") {
    // The one source keeps no cap for the In: `maxPts` is null there.
    return { lower: min, upper: earlier(trim.limitPts, trim.maxPts) };
  }
  return { lower: later(trim.limitPts, min), upper: trim.maxPts };
}

/**
 * True when a PTS is inside the range of the trim (`trimRange`): for the In edge at or before the
 * limit, and for the Out edge at or after the limit and at or before the last frame of the source.
 * On the grid of a clip, both edges also stay inside the clip.
 */
export function isWithinTrimLimit(trim: SegmentTrim, pts: Pts): boolean {
  if (!isPtsString(pts)) {
    return false;
  }
  const value = ptsToBigInt(pts);
  const { lower, upper } = trimRange(trim);
  return (
    (lower === null || value >= ptsToBigInt(lower)) &&
    (upper === null || value <= ptsToBigInt(upper))
  );
}

/** Moves a PTS into the range of the trim (`isWithinTrimLimit`). */
export function clampTrimPts(trim: SegmentTrim, pts: Pts): Pts {
  if (isWithinTrimLimit(trim, pts)) {
    return pts;
  }
  const { lower, upper } = trimRange(trim);
  if (upper !== null && ptsToBigInt(pts) > ptsToBigInt(upper)) {
    return upper;
  }
  return lower ?? trim.limitPts;
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
    return {
      pts: snap.pts,
      snap,
      writesAtOnce: snaps.exactPts.has(snap.pts) || isClipEndPts(trim, snap.pts),
    };
  }
  // The junction at the end of a clip is no frame of the clip, so no frame can commit it. It is
  // the canonical Out there, so a release writes it at once (`planClipTrimStart`).
  const pts = clampTrimPts(trim, request.pts);
  return { pts, snap: null, writesAtOnce: isClipEndPts(trim, pts) };
}

/**
 * The PTS that the scrub of a sample seeks to. It is the target, except for the junction at the
 * end of the clip of a clip grid: the sequence gives that junction to the next clip, and a seek
 * there would attach the next clip and end the trim. The scrub then seeks to the last tick of the
 * clip, which shows its last frame. The target keeps the junction, which the release writes.
 */
export function trimScrubPts(trim: SegmentTrim, target: TrimTarget): Pts {
  const end = trim.clip?.endPts ?? null;
  if (end === null || ptsToBigInt(target.pts) < ptsToBigInt(end)) {
    return target.pts;
  }
  return ptsOrNull(ptsToBigInt(end) - 1n) ?? target.pts;
}

/**
 * The nominal frame of a release target, kept inside the range of the trim: for the In edge, a
 * frame before the frame of the Out, and for the Out edge, a frame after the frame of the In and
 * no later than the last frame of the source. The stored boundaries are frame starts, so their
 * nearest frame is their own frame.
 *
 * On the grid of a clip, the In edge also stops at the last frame of the clip. The In of an Out
 * edge can lie in an earlier clip, before frame 0 of the grid, and it then sets no bound inside
 * the clip.
 */
function releaseFrameIndex(trim: SegmentTrim, target: Pts): bigint | null {
  const index = trimFrameIndexOf(trim, target);
  const fixed = trimNearestFrameIndexOf(trim, trim.fixedPts);
  if (index === null) {
    return null;
  }
  const last = trim.lastFrameIndex;
  if (trim.edge === "in") {
    if (fixed === null) {
      return null;
    }
    const capped =
      trim.clip !== undefined && last !== null && index > last ? last : index;
    return capped < fixed ? capped : fixed - 1n;
  }
  const capped = last !== null && index > last ? last : index;
  if (fixed === null) {
    return trim.clip === undefined ? null : capped;
  }
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
    isClipFramePts(trim, frame.inferredSourcePts) &&
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
    if (isClipEndPts(trim, pts)) {
      // The junction at the end of the clip of a clip grid starts the next clip, and a seek there
      // would attach that clip. The drag ends with the exact seek of ADR 022 to the last tick of
      // the clip instead (`trimScrubPts`), which shows its last frame. No seek runs only while
      // that frame is on screen with no seek pending.
      const last = trim.lastFrameIndex;
      seek =
        last !== null && isFrameOnScreen(trim, playback, last)
          ? null
          : { kind: "pts", pts: trimScrubPts(trim, target) };
    } else if (isTargetOnScreen(playback, pts)) {
      seek = null;
    } else if (frameIndex === null || !isClipFramePts(trim, pts)) {
      // A value outside the clip of a clip grid is no frame of that grid. The seek goes to its
      // PTS, and the sequence finds its clip.
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
    isClipFramePts(trim, frame.inferredSourcePts) &&
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
    isClipFramePts(awaiting.trim, frame.inferredSourcePts) &&
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

/** True when `pts` lies in the clip of a clip grid, from its start to before its end. */
function isInsideClip(clip: TrimClipGrid, pts: Pts): boolean {
  const value = ptsToBigInt(pts);
  return (
    value >= ptsToBigInt(clip.startPts) &&
    (clip.endPts === null || value < ptsToBigInt(clip.endPts))
  );
}

/**
 * True when a presented frame can be a frame of the grid of the trim. On the grid of a clip, only a
 * frame inside the clip can. A frame of the next clip can round to the last frame of the grid,
 * because the first frames of the next clip lie within half a frame of its end.
 */
function isClipFramePts(trim: SegmentTrim, pts: Pts): boolean {
  return trim.clip === undefined || (isPtsString(pts) && isInsideClip(trim.clip, pts));
}

/** True when `pts` is the junction at the end of the clip of a clip grid (`planClipTrimStart`). */
function isClipEndPts(trim: SegmentTrim, pts: Pts): boolean {
  const end = trim.clip?.endPts ?? null;
  return (
    trim.edge === "out" &&
    end !== null &&
    isPtsString(pts) &&
    ptsToBigInt(pts) === ptsToBigInt(end)
  );
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
  // A playhead outside the clip of a clip grid has no frame on that grid. The seek then goes to
  // its PTS, and the sequence finds its clip.
  if (trim.clip !== undefined && !isInsideClip(trim.clip, pts)) {
    return { kind: "pts", pts };
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
