/**
 * The sequence of clips (ADR 052): clip ranges, the layout of the clips on the sequence, the order
 * of edit points, the segment rules, the expansion of a segment into source pieces, and the clip
 * operations that keep the frames of each segment.
 *
 * `clipRange` is the only reader of the range of a source for a clip, and `layoutSequence` is the
 * only place that computes the extent of a clip and where it starts. Other code converts between
 * sequence time and edit points through `locate` and `toSequenceTime`, and must not assume that a
 * clip starts where the clip before it ends. ADR 052 names what a later feature changes: a trimmed
 * clip changes `clipRange`, and overlapping clips change `layoutSequence`, `locate` and
 * `expandSegment`. The edit-point rules here treat the next clip in the array as the clip after a
 * junction, which ADR 052 keeps for both features.
 *
 * Every function is pure. Raw PTS values are compared only on one clip, never across sources
 * (ADR 002).
 */

import {
  isPtsString,
  isValidApproximateDuration,
  ptsToBigInt,
  tickCountToBigInt,
} from "@/lib/time";
import type {
  Clip,
  EditPoint,
  Pts,
  Rational,
  SequenceSegment,
  TickCount,
} from "@/types/project";
import {
  addBigIntRationals,
  bigIntRationalToSeconds,
  reduceBigIntRational,
  type BigIntRational,
} from "./math";

/** The facts of a source that the sequence reads. A persisted source satisfies it. */
export type SequenceSource = {
  readonly id: string;
  readonly videoTimeBase: Rational;
  readonly videoStartPts: Pts | null;
  /** The PTS that follows the last presented frame, or null when the probe could not read it. */
  readonly videoEndPts: Pts | null;
  readonly videoDurationTicks: TickCount | null;
  readonly approximateDurationSeconds: number | null;
};

/** The sources of a sequence, by source ID. */
export type SequenceSources = ReadonlyMap<string, SequenceSource>;

/** The source range of a clip: the first PTS and the exclusive end boundary, null when unknown. */
export type ClipRange = {
  readonly startPts: Pts;
  readonly endPts: Pts | null;
};

/** The clips and the segments that one clip operation changes together. */
export type SequenceEdit = {
  readonly clips: readonly Clip[];
  readonly segments: readonly SequenceSegment[];
};

/**
 * One source interval `[inPts, outPts)` of a segment (ADR 052, ADR 053). `clipId` names the
 * placement, which two clips of one source need. The export request keeps only the source.
 */
export type SequencePiece = {
  readonly clipId: string;
  readonly sourceId: string;
  readonly inPts: Pts;
  readonly outPts: Pts;
};

const ZERO: BigIntRational = { n: 0n, d: 1n };

function isPositiveTimeBase(timeBase: Rational): boolean {
  return (
    Number.isSafeInteger(timeBase.n) &&
    Number.isSafeInteger(timeBase.d) &&
    timeBase.n > 0 &&
    timeBase.d > 0
  );
}

function ticksToRational(ticks: bigint, timeBase: Rational): BigIntRational {
  return reduceBigIntRational(ticks * BigInt(timeBase.n), BigInt(timeBase.d));
}

/**
 * The range of a clip: the whole source in ADR 052. Null when the clip names no known source, the
 * time base is not positive, or the source has no `videoStartPts`. Such a clip holds no edit point,
 * and no segment can cross it.
 *
 * An end that is not after the start, or that does not parse, is metadata that cannot be right,
 * and it reads as unknown. A start that does not parse gives no range.
 */
export function clipRange(clip: Clip, sources: SequenceSources): ClipRange | null {
  const source = sources.get(clip.sourceId);
  if (
    !source ||
    source.videoStartPts === null ||
    !isPtsString(source.videoStartPts) ||
    !isPositiveTimeBase(source.videoTimeBase)
  ) {
    return null;
  }
  const end = source.videoEndPts;
  if (
    end !== null &&
    (!isPtsString(end) || ptsToBigInt(end) <= ptsToBigInt(source.videoStartPts))
  ) {
    return { startPts: source.videoStartPts, endPts: null };
  }
  return { startPts: source.videoStartPts, endPts: end };
}

/**
 * True when `pts` lies in `[start, end]`, with no upper bound when the end is unknown. A PTS that
 * does not parse lies nowhere.
 */
function isInsideRange(pts: Pts, range: ClipRange): boolean {
  if (!isPtsString(pts)) {
    return false;
  }
  const value = ptsToBigInt(pts);
  return (
    value >= ptsToBigInt(range.startPts) &&
    (range.endPts === null || value <= ptsToBigInt(range.endPts))
  );
}

/** The place of one clip on the sequence. Times are seconds from the start of the sequence. */
export type ClipPlacement = {
  readonly clipId: string;
  readonly sourceId: string;
  readonly index: number;
  readonly start: BigIntRational;
  readonly startSeconds: number;
  /** The extent of the clip, or null when nothing gives one. Only a single clip can have none. */
  readonly duration: BigIntRational | null;
  readonly durationSeconds: number | null;
  /** True when the extent comes from the exact range of the clip, not from an estimate. */
  readonly exactDuration: boolean;
};

/** The layout of the whole sequence. */
export type SequenceLayout = {
  readonly placements: readonly ClipPlacement[];
  /** The sum of the extents, or null when a single clip has no extent. */
  readonly total: BigIntRational | null;
  readonly totalSeconds: number | null;
  /** True when every extent is exact, so every start and the total are exact. */
  readonly exact: boolean;
};

/** Seconds of a browser or probe estimate as a rational. The value is approximate anyway. */
function approximateSecondsToRational(seconds: number): BigIntRational {
  // `seconds` is finite and positive here, so `Math.round` meets no negative tie (ADR 002).
  return reduceBigIntRational(BigInt(Math.round(seconds * 1_000_000)), 1_000_000n);
}

type ClipExtent = { readonly duration: BigIntRational; readonly exact: boolean };

/**
 * The extent of one clip, in the order of ADR 052 and ADR 007: the exact range, then
 * `videoDurationTicks`, then `approximateDurationSeconds`, then a finite browser duration. A zero
 * value is no extent, as `getTimelineDurationSeconds` treats it, and the next fallback applies.
 */
function clipExtent(
  clip: Clip,
  source: SequenceSource,
  sources: SequenceSources,
  browserDurationSeconds: ReadonlyMap<string, number> | undefined,
): ClipExtent | null {
  const range = clipRange(clip, sources);
  if (range?.endPts != null) {
    const ticks = ptsToBigInt(range.endPts) - ptsToBigInt(range.startPts);
    return { duration: ticksToRational(ticks, source.videoTimeBase), exact: true };
  }
  if (
    source.videoDurationTicks !== null &&
    tickCountToBigInt(source.videoDurationTicks) > 0n &&
    isPositiveTimeBase(source.videoTimeBase)
  ) {
    return {
      duration: ticksToRational(
        tickCountToBigInt(source.videoDurationTicks),
        source.videoTimeBase,
      ),
      exact: false,
    };
  }
  if (
    isValidApproximateDuration(source.approximateDurationSeconds) &&
    source.approximateDurationSeconds > 0
  ) {
    return {
      duration: approximateSecondsToRational(source.approximateDurationSeconds),
      exact: false,
    };
  }
  const browser = browserDurationSeconds?.get(source.id);
  if (browser !== undefined && Number.isFinite(browser) && browser > 0) {
    return { duration: approximateSecondsToRational(browser), exact: false };
  }
  return null;
}

/**
 * Lay the clips out end to end, with exact rational sums (ADR 002, ADR 052).
 *
 * Returns null when a clip names an unknown source, or when the sequence has more than one clip and
 * a clip has no extent: ADR 052 refuses a source with no extent next to another clip, because the
 * start of every clip after it would be unknown. A single clip with no extent gives an unknown
 * total, the indeterminate ruler of ADR 007.
 *
 * `browserDurationSeconds` holds a finite media element duration by source ID, the last fallback
 * of ADR 007. The caller must keep each source's duration for the whole session, not only for the
 * attached source, or an attach of another clip removes an extent.
 */
export function layoutSequence(
  clips: readonly Clip[],
  sources: SequenceSources,
  browserDurationSeconds?: ReadonlyMap<string, number>,
): SequenceLayout | null {
  const placements: ClipPlacement[] = [];
  let start = ZERO;
  let exact = true;
  for (const [index, clip] of clips.entries()) {
    const source = sources.get(clip.sourceId);
    const startSeconds = bigIntRationalToSeconds(start);
    if (!source || startSeconds === null) {
      return null;
    }
    const extent = clipExtent(clip, source, sources, browserDurationSeconds);
    if (extent === null && clips.length > 1) {
      return null;
    }
    placements.push({
      clipId: clip.id,
      sourceId: clip.sourceId,
      index,
      start,
      startSeconds,
      duration: extent?.duration ?? null,
      durationSeconds: extent ? bigIntRationalToSeconds(extent.duration) : null,
      exactDuration: extent?.exact ?? false,
    });
    if (extent === null) {
      return { placements, total: null, totalSeconds: null, exact: false };
    }
    exact &&= extent.exact;
    start = addBigIntRationals(start, extent.duration);
  }
  return {
    placements,
    total: start,
    totalSeconds: bigIntRationalToSeconds(start),
    exact,
  };
}

/** A sequence time resolved to a clip. */
export type SequenceLocation = {
  readonly clipId: string;
  readonly index: number;
  /** Seconds from the start of the clip's range. */
  readonly elapsedSeconds: number;
};

/**
 * The clip that shows at `seconds` on the sequence, and the elapsed time in it. A time on a junction
 * belongs to the later clip, because each placement is half open. A time at or after the end of the
 * sequence belongs to the last clip, and the caller clamps it. Null for a negative or non-finite time
 * and for an empty sequence.
 */
export function locate(
  layout: SequenceLayout,
  seconds: number,
): SequenceLocation | null {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  let found: ClipPlacement | null = null;
  for (const placement of layout.placements) {
    if (placement.startSeconds > seconds) {
      break;
    }
    found = placement;
  }
  if (found === null) {
    return null;
  }
  return {
    clipId: found.clipId,
    index: found.index,
    elapsedSeconds: seconds - found.startSeconds,
  };
}

/** The index of each clip in the sequence, by clip ID. */
export function clipIndexes(clips: readonly Clip[]): Map<string, number> {
  return new Map(clips.map((clip, index) => [clip.id, index]));
}

/** The clip, its index and its range for an edit point, or null when any is missing. */
function resolvePoint(
  point: EditPoint,
  clips: readonly Clip[],
  indexes: ReadonlyMap<string, number>,
  sources: SequenceSources,
): { readonly index: number; readonly range: ClipRange } | null {
  const index = indexes.get(point.clipId);
  const clip = index === undefined ? undefined : clips[index];
  const range = clip === undefined ? null : clipRange(clip, sources);
  if (index === undefined || range === null || !isInsideRange(point.pts, range)) {
    return null;
  }
  return { index, range };
}

/**
 * The exact sequence time of an edit point: the start of its clip plus the elapsed time from the
 * start of the clip's range. Null when the clip is not on the layout, has no range, or does not hold
 * the PTS.
 */
export function toSequenceTime(
  layout: SequenceLayout,
  clips: readonly Clip[],
  sources: SequenceSources,
  point: EditPoint,
): BigIntRational | null {
  const placement = layout.placements.find((entry) => entry.clipId === point.clipId);
  const clip = placement === undefined ? undefined : clips[placement.index];
  if (placement === undefined || clip === undefined || clip.id !== point.clipId) {
    return null;
  }
  const range = clipRange(clip, sources);
  const source = sources.get(clip.sourceId);
  if (range === null || source === undefined || !isInsideRange(point.pts, range)) {
    return null;
  }
  const elapsed = ptsToBigInt(point.pts) - ptsToBigInt(range.startPts);
  return addBigIntRationals(
    placement.start,
    ticksToRational(elapsed, source.videoTimeBase),
  );
}

/** `toSequenceTime` in floating-point seconds, for layout and browser APIs only. */
export function toSequenceSeconds(
  layout: SequenceLayout,
  clips: readonly Clip[],
  sources: SequenceSources,
  point: EditPoint,
): number | null {
  const time = toSequenceTime(layout, clips, sources, point);
  return time === null ? null : bigIntRationalToSeconds(time);
}

type NormalizedPoint = { readonly index: number; readonly pts: bigint };

/**
 * An edit point in the form that compares: the end of a clip becomes the start of the next clip,
 * when a next clip exists and has a range (ADR 052). Null for an unknown clip, a clip with no range,
 * or a PTS outside the range.
 */
function normalizePoint(
  point: EditPoint,
  clips: readonly Clip[],
  indexes: ReadonlyMap<string, number>,
  sources: SequenceSources,
): NormalizedPoint | null {
  const resolved = resolvePoint(point, clips, indexes, sources);
  if (resolved === null) {
    return null;
  }
  const { index, range } = resolved;
  const pts = ptsToBigInt(point.pts);
  const next = clips[index + 1];
  const nextRange = next === undefined ? null : clipRange(next, sources);
  if (
    range.endPts !== null &&
    pts === ptsToBigInt(range.endPts) &&
    nextRange !== null
  ) {
    return { index: index + 1, pts: ptsToBigInt(nextRange.startPts) };
  }
  // A next clip with no range holds no edit point, so the clip index alone orders this point.
  return { index, pts };
}

/**
 * Compare two edit points in sequence order: negative when `a` comes first, zero when both name the
 * same sequence point, positive when `b` comes first. The end of a clip equals the start of the next
 * clip. Null when either point names an unknown clip, a clip with no range, or a PTS outside the
 * range of its clip.
 */
export function compareEditPoints(
  a: EditPoint,
  b: EditPoint,
  clips: readonly Clip[],
  sources: SequenceSources,
): number | null {
  const indexes = clipIndexes(clips);
  const left = normalizePoint(a, clips, indexes, sources);
  const right = normalizePoint(b, clips, indexes, sources);
  if (left === null || right === null) {
    return null;
  }
  if (left.index !== right.index) {
    return left.index - right.index;
  }
  return left.pts < right.pts ? -1 : left.pts > right.pts ? 1 : 0;
}

/**
 * The one form of an In (ADR 052): an In at the end of a clip becomes the start of the next clip.
 * Null when no next clip with a range exists, because no frame follows, and for a point that its
 * clip does not hold. A non-null result is an In that a store can write.
 */
export function canonicalIn(
  point: EditPoint,
  clips: readonly Clip[],
  sources: SequenceSources,
): EditPoint | null {
  const resolved = resolvePoint(point, clips, clipIndexes(clips), sources);
  if (resolved === null) {
    return null;
  }
  const { index, range } = resolved;
  if (range.endPts === null || ptsToBigInt(point.pts) !== ptsToBigInt(range.endPts)) {
    return point;
  }
  const next = clips[index + 1];
  const nextRange = next === undefined ? null : clipRange(next, sources);
  if (next === undefined || nextRange === null) {
    return null;
  }
  return { clipId: next.id, pts: nextRange.startPts };
}

/**
 * The one form of an Out (ADR 052): an Out on the first frame of a clip becomes the end of the clip
 * directly before it. Null when that clip has no `videoEndPts`, when the clip is the first clip,
 * because no Out can lie there, and for a point that its clip does not hold. A non-null result is
 * an Out that a store can write.
 */
export function canonicalOut(
  point: EditPoint,
  clips: readonly Clip[],
  sources: SequenceSources,
): EditPoint | null {
  const resolved = resolvePoint(point, clips, clipIndexes(clips), sources);
  if (resolved === null) {
    return null;
  }
  const { index, range } = resolved;
  if (ptsToBigInt(point.pts) !== ptsToBigInt(range.startPts)) {
    return point;
  }
  const previous = index > 0 ? clips[index - 1] : undefined;
  const previousRange = previous === undefined ? null : clipRange(previous, sources);
  if (previous === undefined || previousRange?.endPts == null) {
    return null;
  }
  return { clipId: previous.id, pts: previousRange.endPts };
}

/**
 * Check a segment against the rules of ADR 052:
 *
 * - The In lies in its clip's range, before the end: `start <= inPts < end`.
 * - The Out lies in its clip's range, after the start: `start < outPts <= end`.
 * - On one clip, `inPts < outPts`. On two clips, the In clip comes first.
 * - Every clip from the In clip up to, but not including, the Out clip has a known end, and every
 *   clip that the segment crosses has a range.
 *
 * An unknown end does not bound a boundary on that clip. A boundary that does not parse makes the
 * segment not valid.
 */
export function isValidSequenceSegment(
  segment: SequenceSegment,
  clips: readonly Clip[],
  sources: SequenceSources,
): boolean {
  if (!isPtsString(segment.inPts) || !isPtsString(segment.outPts)) {
    return false;
  }
  const indexes = clipIndexes(clips);
  const inIndex = indexes.get(segment.inClipId);
  const outIndex = indexes.get(segment.outClipId);
  if (inIndex === undefined || outIndex === undefined || inIndex > outIndex) {
    return false;
  }
  const ranges: ClipRange[] = [];
  for (let index = inIndex; index <= outIndex; index += 1) {
    const clip = clips[index];
    const range = clip === undefined ? null : clipRange(clip, sources);
    if (range === null || (index < outIndex && range.endPts === null)) {
      return false;
    }
    ranges.push(range);
  }
  const inRange = ranges[0];
  const outRange = ranges[ranges.length - 1];
  if (inRange === undefined || outRange === undefined) {
    return false;
  }
  const inPts = ptsToBigInt(segment.inPts);
  const outPts = ptsToBigInt(segment.outPts);
  if (inPts < ptsToBigInt(inRange.startPts)) {
    return false;
  }
  if (inRange.endPts !== null && inPts >= ptsToBigInt(inRange.endPts)) {
    return false;
  }
  if (outPts <= ptsToBigInt(outRange.startPts)) {
    return false;
  }
  if (outRange.endPts !== null && outPts > ptsToBigInt(outRange.endPts)) {
    return false;
  }
  return inIndex < outIndex || inPts < outPts;
}

/**
 * Expand a segment into source pieces in sequence order (ADR 052): `[inPts, end)` of the In clip,
 * the whole range of each clip between, and `[start, outPts)` of the Out clip. A segment on one clip
 * gives one piece. Null for a segment that breaks the rules of `isValidSequenceSegment`.
 */
export function expandSegment(
  segment: SequenceSegment,
  clips: readonly Clip[],
  sources: SequenceSources,
): SequencePiece[] | null {
  if (!isValidSequenceSegment(segment, clips, sources)) {
    return null;
  }
  const indexes = clipIndexes(clips);
  const inIndex = indexes.get(segment.inClipId);
  const outIndex = indexes.get(segment.outClipId);
  if (inIndex === undefined || outIndex === undefined) {
    return null;
  }
  const pieces: SequencePiece[] = [];
  for (let index = inIndex; index <= outIndex; index += 1) {
    const clip = clips[index];
    const range = clip === undefined ? null : clipRange(clip, sources);
    if (clip === undefined || range === null) {
      return null;
    }
    const inPts = index === inIndex ? segment.inPts : range.startPts;
    const outPts = index === outIndex ? segment.outPts : range.endPts;
    if (outPts === null) {
      return null;
    }
    pieces.push({ clipId: clip.id, sourceId: clip.sourceId, inPts, outPts });
  }
  return pieces;
}

/**
 * True when the segment crosses junction `junction`, the junction between clip `junction - 1` and
 * clip `junction`: its first frame lies before the junction and its last frame after it. The one
 * form of the boundaries makes this an index test.
 */
function crossesJunction(
  segment: SequenceSegment,
  junction: number,
  indexes: ReadonlyMap<string, number>,
): boolean {
  const inIndex = indexes.get(segment.inClipId);
  const outIndex = indexes.get(segment.outClipId);
  return (
    inIndex !== undefined &&
    outIndex !== undefined &&
    inIndex < junction &&
    outIndex >= junction
  );
}

/**
 * Split each segment at each listed junction that it crosses (ADR 052). The parts of a segment take
 * its place in the array, one after another, in sequence order, so the export order of the frames
 * does not change. The first part keeps the segment ID, and `generateId` names each other part.
 *
 * A junction outside `1..clips.length - 1` is no junction and is ignored. Null when an input
 * segment is not valid, because a part of it would not be valid either.
 */
export function splitSegmentsAtJunctions(
  segments: readonly SequenceSegment[],
  junctions: readonly number[],
  clips: readonly Clip[],
  sources: SequenceSources,
  generateId: () => string,
): SequenceSegment[] | null {
  if (!segments.every((segment) => isValidSequenceSegment(segment, clips, sources))) {
    return null;
  }
  const inner = [...new Set(junctions)]
    .filter((junction) => junction > 0 && junction < clips.length)
    .sort((a, b) => a - b);
  const indexes = clipIndexes(clips);
  const result: SequenceSegment[] = [];
  for (const segment of segments) {
    let rest = segment;
    for (const junction of inner) {
      if (!crossesJunction(rest, junction, indexes)) {
        continue;
      }
      const before = clips[junction - 1];
      const after = clips[junction];
      const beforeRange = before === undefined ? null : clipRange(before, sources);
      const afterRange = after === undefined ? null : clipRange(after, sources);
      if (
        before === undefined ||
        after === undefined ||
        beforeRange?.endPts == null ||
        afterRange === null
      ) {
        return null;
      }
      result.push({ ...rest, outClipId: before.id, outPts: beforeRange.endPts });
      rest = {
        ...rest,
        id: generateId(),
        inClipId: after.id,
        inPts: afterRange.startPts,
      };
    }
    result.push(rest);
  }
  return result;
}

/**
 * Insert clips at junction `index`, before the clip now at `index`, or at the end when `index` is
 * the clip count (ADR 052). A segment that crosses that junction is first split there, so no segment
 * gains frames. An empty list changes nothing, and the same `edit` object comes back. Null for an
 * index out of range, a clip ID that the sequence already holds or that the list repeats, or an
 * input segment that is not valid.
 *
 * The caller must refuse a sequence that `layoutSequence` cannot lay out.
 */
export function insertClips(
  edit: SequenceEdit,
  index: number,
  inserted: readonly Clip[],
  sources: SequenceSources,
  generateId: () => string,
): SequenceEdit | null {
  if (!Number.isInteger(index) || index < 0 || index > edit.clips.length) {
    return null;
  }
  if (inserted.length === 0) {
    return edit;
  }
  const ids = new Set(edit.clips.map((clip) => clip.id));
  for (const clip of inserted) {
    if (ids.has(clip.id)) {
      return null;
    }
    ids.add(clip.id);
  }
  const segments = splitSegmentsAtJunctions(
    edit.segments,
    [index],
    edit.clips,
    sources,
    generateId,
  );
  if (segments === null) {
    return null;
  }
  return {
    clips: [...edit.clips.slice(0, index), ...inserted, ...edit.clips.slice(index)],
    segments,
  };
}

/**
 * Move clip `from` to junction `to` of the current order: before the clip now at `to`, or to the end
 * when `to` is the clip count (ADR 052). A move to either junction of the clip itself changes
 * nothing, and the same `edit` object comes back, so the caller adds no history entry.
 *
 * Each segment that crosses a junction of the clip, or the target junction, is split there first.
 * Then each part follows the clip that holds it, and no segment changes its frames. Null for an index
 * out of range or an input segment that is not valid.
 */
export function moveClip(
  edit: SequenceEdit,
  from: number,
  to: number,
  sources: SequenceSources,
  generateId: () => string,
): SequenceEdit | null {
  const count = edit.clips.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= count) {
    return null;
  }
  if (to < 0 || to > count) {
    return null;
  }
  if (to === from || to === from + 1) {
    return edit;
  }
  const segments = splitSegmentsAtJunctions(
    edit.segments,
    [from, from + 1, to],
    edit.clips,
    sources,
    generateId,
  );
  const moved = edit.clips[from];
  if (segments === null || moved === undefined) {
    return null;
  }
  const remaining = [...edit.clips.slice(0, from), ...edit.clips.slice(from + 1)];
  const target = to > from ? to - 1 : to;
  return {
    clips: [...remaining.slice(0, target), moved, ...remaining.slice(target)],
    segments,
  };
}

/**
 * Remove clip `index` (ADR 052). A segment on that clip only is removed. A segment with one end on
 * it keeps the part outside it: its In moves to the start of the next clip, or its Out to the end
 * of the previous clip. A segment that crosses the whole clip keeps both ends, and the clips on each
 * side of the removed clip now meet. Null for an index out of range or an input segment that is not
 * valid.
 */
export function removeClip(
  edit: SequenceEdit,
  index: number,
  sources: SequenceSources,
): SequenceEdit | null {
  const removed = edit.clips[index];
  if (!Number.isInteger(index) || removed === undefined) {
    return null;
  }
  if (
    !edit.segments.every((segment) =>
      isValidSequenceSegment(segment, edit.clips, sources),
    )
  ) {
    return null;
  }
  const previous = index > 0 ? edit.clips[index - 1] : undefined;
  const next = edit.clips[index + 1];
  const segments: SequenceSegment[] = [];
  for (const segment of edit.segments) {
    const startsHere = segment.inClipId === removed.id;
    const endsHere = segment.outClipId === removed.id;
    if (startsHere && endsHere) {
      continue;
    }
    if (startsHere) {
      const nextRange = next === undefined ? null : clipRange(next, sources);
      if (next === undefined || nextRange === null) {
        return null;
      }
      segments.push({ ...segment, inClipId: next.id, inPts: nextRange.startPts });
      continue;
    }
    if (endsHere) {
      const previousRange =
        previous === undefined ? null : clipRange(previous, sources);
      if (previous === undefined || previousRange?.endPts == null) {
        return null;
      }
      segments.push({
        ...segment,
        outClipId: previous.id,
        outPts: previousRange.endPts,
      });
      continue;
    }
    segments.push(segment);
  }
  return {
    clips: [...edit.clips.slice(0, index), ...edit.clips.slice(index + 1)],
    segments,
  };
}

/** The exact duration of a segment: the sum of its pieces, each in its own time base (ADR 002). */
export function sequenceSegmentDuration(
  segment: SequenceSegment,
  clips: readonly Clip[],
  sources: SequenceSources,
): BigIntRational | null {
  const pieces = expandSegment(segment, clips, sources);
  if (pieces === null) {
    return null;
  }
  let total = ZERO;
  for (const piece of pieces) {
    const source = sources.get(piece.sourceId);
    if (source === undefined) {
      return null;
    }
    const ticks = ptsToBigInt(piece.outPts) - ptsToBigInt(piece.inPts);
    total = addBigIntRationals(total, ticksToRational(ticks, source.videoTimeBase));
  }
  return total;
}
