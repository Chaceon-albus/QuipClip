/**
 * The columns of the envelope canvas (ADR 056): which device pixels each clip covers, and which
 * buckets each of those columns shows.
 *
 * The place of a clip comes from `calculateClipBarLayouts`, as the clip bars do. The time in the
 * source comes from the clip range and the virtual timeline only (ADR 052): the source seconds at
 * lane x inside clip C are
 *
 *   (x - left of C) × total seconds / lane width + (range start of C - origin) × time base
 *
 * The range start is `VirtualClip.rangeStart`, which `buildVirtualTimeline` reads through
 * `clipRange` and through nothing else. It equals the origin today, so the second term is 0; a
 * trimmed clip later makes it positive.
 *
 * Each column covers at least one bucket. When a bucket is wider than a column, each column of
 * that bucket shows it. The columns of one clip split its buckets with no overlap: the boundary
 * between two columns maps to one bucket index, the end of the left column and the start of the
 * right column.
 */

import type { ClipBarLayout } from "@/components/timeline/clipBarLayout";
import type { VirtualClip } from "@/features/timeline/virtualTime";
import { TIMELINE_GUTTER_WIDTH_PX } from "@/features/timeline/viewport";
import { ptsToBigInt } from "@/lib/time";
import type { Pts, Rational } from "@/types/project";
import { WAVEFORM_BUCKET_RATE } from "./types";

/** A source that shows its envelope. */
export interface WaveformSourceView {
  /** The PTS of bucket 0: the `videoStartPts` of the probe. */
  readonly originPts: Pts;
  /** The video time base of the source. */
  readonly timeBase: Rational;
  /** The count of buckets that the page holds. */
  readonly length: number;
}

export interface WaveformPlanInput {
  readonly layouts: readonly ClipBarLayout[];
  readonly clips: readonly VirtualClip[];
  /** The sources that show their envelope, by source ID. */
  readonly sources: ReadonlyMap<string, WaveformSourceView>;
  /** The width of the whole lane in CSS pixels. */
  readonly laneWidthPx: number;
  readonly totalDurationSeconds: number;
  readonly scrollLeftPx: number;
  /** The width of the scroll viewport, the track gutter included. */
  readonly viewportWidthPx: number;
  /** The margin of the canvas on each side of the visible lane, in CSS pixels. */
  readonly overscanPx: number;
  readonly dpr: number;
  readonly bucketRate?: number;
}

/** The columns of one clip. Column `i` is device column `firstColumn + i` of the canvas. */
export interface WaveformClipColumns {
  readonly clipId: string;
  readonly sourceId: string;
  readonly firstColumn: number;
  /** The first bucket of each column. */
  readonly bucketStarts: Uint32Array;
  /** The bucket after the last bucket of each column. Equal to the start: no data. */
  readonly bucketEnds: Uint32Array;
}

export interface WaveformPlan {
  /** Where the canvas starts on the lane, in CSS pixels, on a device pixel. */
  readonly canvasLeftPx: number;
  /** The width of the canvas in device pixels. */
  readonly widthDevicePx: number;
  readonly dpr: number;
  readonly clips: readonly WaveformClipColumns[];
}

const EMPTY_PLAN: WaveformPlan = {
  canvasLeftPx: 0,
  widthDevicePx: 0,
  dpr: 1,
  clips: [],
};

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** The source seconds from the origin to the start of the clip range. */
function rangeOffsetSeconds(
  clip: VirtualClip,
  source: WaveformSourceView,
): number | null {
  if (
    clip.rangeStart === null ||
    !(source.timeBase.n > 0) ||
    !(source.timeBase.d > 0)
  ) {
    return null;
  }
  const ticks = clip.rangeStart - ptsToBigInt(source.originPts);
  const seconds = (Number(ticks) * source.timeBase.n) / source.timeBase.d;
  return Number.isFinite(seconds) ? seconds : null;
}

/** Plans the columns of the envelope canvas. See the module comment. */
export function planWaveformColumns(input: WaveformPlanInput): WaveformPlan {
  const { laneWidthPx, totalDurationSeconds, dpr } = input;
  const rate = input.bucketRate ?? WAVEFORM_BUCKET_RATE;
  if (
    !isPositive(laneWidthPx) ||
    !isPositive(totalDurationSeconds) ||
    !isPositive(dpr)
  ) {
    return EMPTY_PLAN;
  }
  const overscan = Math.max(0, input.overscanPx);
  const visibleStart = Math.max(0, input.scrollLeftPx);
  const visibleEnd =
    input.scrollLeftPx + Math.max(0, input.viewportWidthPx - TIMELINE_GUTTER_WIDTH_PX);
  const canvasStart = Math.max(0, visibleStart - overscan);
  const canvasEnd = Math.min(laneWidthPx, visibleEnd + overscan);
  if (!(canvasEnd > canvasStart)) {
    return { ...EMPTY_PLAN, dpr };
  }
  const leftDevice = Math.floor(canvasStart * dpr);
  const rightDevice = Math.ceil(canvasEnd * dpr);
  const secondsPerPx = totalDurationSeconds / laneWidthPx;
  const clipsById = new Map(input.clips.map((clip) => [clip.clipId, clip]));

  const planned: WaveformClipColumns[] = [];
  for (const layout of input.layouts) {
    const source = input.sources.get(layout.sourceId);
    const clip = clipsById.get(layout.clipId);
    if (
      source === undefined ||
      clip === undefined ||
      clip.sourceId !== layout.sourceId
    ) {
      continue;
    }
    const offset = rangeOffsetSeconds(clip, source);
    if (offset === null) {
      continue;
    }
    const clipLeft = (layout.leftPercent / 100) * laneWidthPx;
    const clipRight = clipLeft + (layout.widthPercent / 100) * laneWidthPx;
    // Rounded edges give a device column at a junction to one clip, so two translucent
    // envelopes never draw the same column.
    const from = Math.max(leftDevice, Math.round(clipLeft * dpr));
    const to = Math.min(rightDevice, Math.round(clipRight * dpr));
    if (!(to > from)) {
      continue;
    }
    const length = Math.max(0, Math.floor(source.length));
    // The bucket at a lane position, with the position held inside the clip. A time before the
    // origin maps to bucket 0.
    const edge = (x: number): number => {
      const inside = Math.min(clipRight, Math.max(clipLeft, x));
      const seconds = (inside - clipLeft) * secondsPerPx + offset;
      return Math.max(0, Math.floor(seconds * rate));
    };
    const count = to - from;
    const bucketStarts = new Uint32Array(count);
    const bucketEnds = new Uint32Array(count);
    let left = edge(from / dpr);
    for (let i = 0; i < count; i++) {
      const right = edge((from + i + 1) / dpr);
      const b0 = Math.min(left, length);
      const b1 = Math.min(Math.max(left + 1, right), length);
      bucketStarts[i] = b0;
      bucketEnds[i] = Math.max(b0, b1);
      left = right;
    }
    planned.push({
      clipId: layout.clipId,
      sourceId: layout.sourceId,
      firstColumn: from - leftDevice,
      bucketStarts,
      bucketEnds,
    });
  }
  return {
    canvasLeftPx: leftDevice / dpr,
    widthDevicePx: rightDevice - leftDevice,
    dpr,
    clips: planned,
  };
}
