/**
 * The sequence as one virtual source (ADR 052, ADR 002).
 *
 * The timeline, the transport and the keyboard layer were written for one source: they read one
 * video time base, one start PTS and one extent, and they compare PTS values on one axis. ADR 002
 * lets QuipClip rescale exact values to a runtime common time base when every rescale is exact.
 * This module builds that time base for the clips of a sequence, so the interface can keep its
 * one axis:
 *
 * - The virtual time base `T` divides the video time base of every clip, and every start of a
 *   clip on the sequence, so each rescale is an exact integer product.
 * - A virtual PTS is `origin + start of the clip in T + (pts - range start) * (time base / T)`.
 * - With one clip, `T` is the time base of that clip and the origin is its start PTS, so the
 *   virtual PTS of a frame is its source PTS. A sequence of one clip therefore behaves as the
 *   one source did before ADR 052.
 *
 * The project never stores a virtual value (ADR 007). Edit points stay a clip and a source PTS;
 * a virtual PTS goes back to an edit point only on a named clip (`fromVirtualPts`), never by a
 * guess between two clips.
 */

import { I64_MAX, I64_MIN, ptsFromBigInt, ptsToBigInt } from "@/lib/time";
import type { Clip, EditPoint, Pts, Rational } from "@/types/project";
import { clipRange, layoutSequence, type SequenceSources } from "./sequence";
import { gcdBigInt, type BigIntRational } from "./math";

/** The place of one clip on the virtual axis. All values are in ticks of the virtual time base. */
export type VirtualClip = {
  readonly clipId: string;
  readonly sourceId: string;
  readonly index: number;
  /** Ticks from the virtual origin to the start of the clip. */
  readonly startTicks: bigint;
  /** The extent of the clip, or null when nothing gives one. */
  readonly durationTicks: bigint | null;
  /** Virtual ticks for one tick of the clip's video time base. */
  readonly scale: bigint;
  /** The first PTS of the clip range, or null when the clip has no range (no edit point). */
  readonly rangeStart: bigint | null;
  /** True when the extent comes from the exact range of the clip. */
  readonly exactDuration: boolean;
};

/** The sequence on one virtual axis. */
export type VirtualTimeline = {
  readonly timeBase: Rational;
  /** The virtual PTS of sequence time zero. */
  readonly originPts: Pts;
  readonly clips: readonly VirtualClip[];
  /** The ticks of the whole sequence, or null when the last clip has no extent. */
  readonly totalTicks: bigint | null;
  /** True when every extent is exact. */
  readonly exact: boolean;
};

function reduce(n: bigint, d: bigint): BigIntRational {
  const g = gcdBigInt(n, d);
  return g === 0n ? { n, d } : { n: n / g, d: d / g };
}

/** The largest rational that divides both values exactly: gcd of the numerators over lcm of the denominators. */
function gcdRational(a: BigIntRational, b: BigIntRational): BigIntRational {
  const left = reduce(a.n, a.d);
  const right = reduce(b.n, b.d);
  const numerator = gcdBigInt(left.n, right.n);
  const denominator = (left.d / gcdBigInt(left.d, right.d)) * right.d;
  return reduce(numerator, denominator);
}

/** `value / unit` when it is a whole number, else null. */
function exactTicks(value: BigIntRational, unit: BigIntRational): bigint | null {
  const numerator = value.n * unit.d;
  const denominator = value.d * unit.n;
  if (denominator === 0n || numerator % denominator !== 0n) {
    return null;
  }
  return numerator / denominator;
}

function isSafePositiveRational(value: Rational): boolean {
  return (
    Number.isSafeInteger(value.n) &&
    Number.isSafeInteger(value.d) &&
    value.n > 0 &&
    value.d > 0
  );
}

function fitsI64(value: bigint): boolean {
  return value >= I64_MIN && value <= I64_MAX;
}

/**
 * Build the virtual axis of a sequence. Null for an empty sequence, for a sequence that
 * `layoutSequence` refuses, for a time base that is not a safe positive rational, and when a
 * virtual value would leave the signed 64-bit range of a PTS (ADR 002).
 *
 * The extent of a clip before the last one sets the start of the next clip. When such an extent
 * is an estimate in microseconds, the time base divides one microsecond too. The extent of the
 * last clip sets no start, so it never changes the time base: one clip keeps its own time base.
 */
export function buildVirtualTimeline(
  clips: readonly Clip[],
  sources: SequenceSources,
  browserDurationSeconds?: ReadonlyMap<string, number>,
): VirtualTimeline | null {
  if (clips.length === 0) {
    return null;
  }
  const layout = layoutSequence(clips, sources, browserDurationSeconds);
  if (layout === null) {
    return null;
  }
  let unit: BigIntRational | null = null;
  for (const [index, clip] of clips.entries()) {
    const source = sources.get(clip.sourceId);
    if (source === undefined || !isSafePositiveRational(source.videoTimeBase)) {
      return null;
    }
    const timeBase: BigIntRational = {
      n: BigInt(source.videoTimeBase.n),
      d: BigInt(source.videoTimeBase.d),
    };
    // One clip keeps its time base exactly as the probe gave it, reduced or not, so a virtual
    // PTS is its source PTS. Several clips need the largest common divisor.
    unit =
      unit === null
        ? clips.length === 1
          ? timeBase
          : reduce(timeBase.n, timeBase.d)
        : gcdRational(unit, timeBase);
    const placement = layout.placements[index];
    if (
      index < clips.length - 1 &&
      placement?.duration != null &&
      !placement.exactDuration
    ) {
      unit = gcdRational(unit, placement.duration);
    }
  }
  if (unit === null || unit.n <= 0n) {
    return null;
  }

  const virtualClips: VirtualClip[] = [];
  for (const [index, clip] of clips.entries()) {
    const source = sources.get(clip.sourceId);
    const placement = layout.placements[index];
    if (source === undefined || placement === undefined) {
      return null;
    }
    const scale = exactTicks(
      { n: BigInt(source.videoTimeBase.n), d: BigInt(source.videoTimeBase.d) },
      unit,
    );
    const startTicks = exactTicks(placement.start, unit);
    const durationTicks =
      placement.duration === null ? null : exactTicks(placement.duration, unit);
    if (scale === null || startTicks === null) {
      return null;
    }
    // A duration from the last estimate need not divide the time base; round it, as it only
    // sizes the end of the axis.
    const lastDuration =
      durationTicks ??
      (placement.duration === null
        ? null
        : (placement.duration.n * unit.d + (placement.duration.d * unit.n) / 2n) /
          (placement.duration.d * unit.n));
    const range = clipRange(clip, sources);
    virtualClips.push({
      clipId: clip.id,
      sourceId: clip.sourceId,
      index,
      startTicks,
      durationTicks: lastDuration,
      scale,
      rangeStart: range === null ? null : ptsToBigInt(range.startPts),
      exactDuration: placement.exactDuration,
    });
  }

  const first = virtualClips[0];
  if (first === undefined) {
    return null;
  }
  const origin = (first.rangeStart ?? 0n) * first.scale;
  const last = virtualClips[virtualClips.length - 1];
  const lastEnd =
    last === undefined || last.durationTicks === null
      ? null
      : last.startTicks + last.durationTicks;
  if (!fitsI64(origin) || (last !== undefined && !fitsI64(origin + last.startTicks))) {
    return null;
  }
  // The extent of the last clip only sizes the end of the axis. An estimate too large for a PTS
  // leaves the total unknown and keeps the axis, so a file with a wrong estimate stays editable.
  const totalTicks = lastEnd !== null && fitsI64(origin + lastEnd) ? lastEnd : null;
  // The time base crosses the interface as a `Rational` of JavaScript numbers.
  const timeBase = { n: Number(unit.n), d: Number(unit.d) };
  if (!Number.isSafeInteger(timeBase.n) || !Number.isSafeInteger(timeBase.d)) {
    return null;
  }
  return {
    timeBase,
    originPts: ptsFromBigInt(origin),
    clips: virtualClips,
    totalTicks,
    exact: layout.exact,
  };
}

function findClip(timeline: VirtualTimeline, clipId: string): VirtualClip | null {
  return timeline.clips.find((clip) => clip.clipId === clipId) ?? null;
}

/** The virtual PTS of an edit point, or null when its clip is not on the axis or has no range. */
export function toVirtualPts(timeline: VirtualTimeline, point: EditPoint): Pts | null {
  const clip = findClip(timeline, point.clipId);
  if (clip === null || clip.rangeStart === null) {
    return null;
  }
  const value =
    ptsToBigInt(timeline.originPts) +
    clip.startTicks +
    (ptsToBigInt(point.pts) - clip.rangeStart) * clip.scale;
  return fitsI64(value) ? ptsFromBigInt(value) : null;
}

/**
 * The edit point on clip `clipId` that has the virtual PTS `pts`. Null when the clip is not on the
 * axis, has no range, or when `pts` is not on the tick grid of that clip. A frame that the preview
 * presents is always on that grid.
 */
export function fromVirtualPts(
  timeline: VirtualTimeline,
  pts: Pts,
  clipId: string,
): EditPoint | null {
  const clip = findClip(timeline, clipId);
  if (clip === null || clip.rangeStart === null) {
    return null;
  }
  const offset = ptsToBigInt(pts) - ptsToBigInt(timeline.originPts) - clip.startTicks;
  if (offset % clip.scale !== 0n) {
    return null;
  }
  const value = clip.rangeStart + offset / clip.scale;
  return fitsI64(value) ? { clipId, pts: ptsFromBigInt(value) } : null;
}

/**
 * The clip that holds the virtual PTS `pts`: the last clip that starts at or before it, so a
 * junction belongs to the later clip. A PTS before the start belongs to the first clip, and one
 * after the end to the last clip. Null for an empty axis.
 */
export function clipAtVirtualPts(
  timeline: VirtualTimeline,
  pts: Pts,
): VirtualClip | null {
  const ticks = ptsToBigInt(pts) - ptsToBigInt(timeline.originPts);
  let found: VirtualClip | null = timeline.clips[0] ?? null;
  for (const clip of timeline.clips) {
    if (clip.startTicks > ticks) {
      break;
    }
    found = clip;
  }
  return found;
}

/** The sequence seconds where clip `clipId` starts, for browser and layout values only. */
export function clipStartSeconds(
  timeline: VirtualTimeline,
  clipId: string,
): number | null {
  const clip = findClip(timeline, clipId);
  if (clip === null) {
    return null;
  }
  const seconds = (Number(clip.startTicks) * timeline.timeBase.n) / timeline.timeBase.d;
  return Number.isFinite(seconds) ? seconds : null;
}
