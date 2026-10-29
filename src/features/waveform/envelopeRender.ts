/**
 * Draws a planned envelope on a 2D context (ADR 056).
 *
 * The scale is in dB down to -54 dBFS: a code at or below the floor has no height, and code 255
 * (0 dBFS) fills half the track on each side of the centre line. The RMS is the darker fill and
 * the peak is the lighter fill. Each column shows the highest codes of its buckets.
 *
 * The functions read no DOM, so a test passes a fake context.
 */

import type { WaveformBuffer, WaveformCodes } from "./buffer";
import type { WaveformPlan } from "./geometry";

/** The lowest level that the display shows. */
export const ENVELOPE_FLOOR_DBFS = -54;

/** The dBFS level of a code above 0: code `c` is `c / 4 - 63.75`. */
export function codeToDbfs(code: number): number {
  return code / 4 - 63.75;
}

function buildHeightTable(): Float32Array {
  const table = new Float32Array(256);
  for (let code = 1; code < 256; code++) {
    const fraction = (codeToDbfs(code) - ENVELOPE_FLOOR_DBFS) / -ENVELOPE_FLOOR_DBFS;
    table[code] = Math.min(1, Math.max(0, fraction));
  }
  return table;
}

/** The height of each code as a fraction of the half track: 0 for code 0 and code 39, 1 for 255. */
export const ENVELOPE_HEIGHT_TABLE: Float32Array = buildHeightTable();

/** The part of a 2D context that the drawing uses. */
export interface EnvelopeContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  fillRect(x: number, y: number, width: number, height: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
}

export interface EnvelopeStyle {
  /** The height of the canvas in device pixels. */
  readonly heightPx: number;
  /** The lighter fill. */
  readonly peakColor: string;
  /** The darker fill. */
  readonly rmsColor: string;
  /** The opacity of both fills, from 0 to 1. */
  readonly alpha: number;
}

/** Finds the envelope of a source. */
export type EnvelopeBuffers = (sourceId: string) => WaveformBuffer | undefined;

/**
 * Clears the canvas and draws each column of `plan`, mirrored about the vertical centre: the
 * peaks first, then the RMS over them.
 */
export function drawEnvelope(
  ctx: EnvelopeContext,
  plan: WaveformPlan,
  buffers: EnvelopeBuffers,
  style: EnvelopeStyle,
): void {
  const height = style.heightPx;
  ctx.clearRect(0, 0, plan.widthDevicePx, height);
  if (!(height > 0)) {
    return;
  }
  const half = height / 2;
  const codes: WaveformCodes = { peak: 0, rms: 0 };
  ctx.globalAlpha = style.alpha;
  for (const clip of plan.clips) {
    const buffer = buffers(clip.sourceId);
    if (buffer === undefined) {
      continue;
    }
    const count = clip.bucketStarts.length;
    const peaks = scratch(0, count);
    const rms = scratch(1, count);
    for (let i = 0; i < count; i++) {
      const b0 = clip.bucketStarts[i];
      const b1 = clip.bucketEnds[i];
      if (b1 <= b0) {
        continue;
      }
      buffer.maxRange(b0, b1, codes);
      peaks[i] = ENVELOPE_HEIGHT_TABLE[codes.peak] * half;
      rms[i] = ENVELOPE_HEIGHT_TABLE[codes.rms] * half;
    }
    // One pass for each fill keeps the changes of the fill style to two for each clip.
    ctx.fillStyle = style.peakColor;
    fillColumns(ctx, clip.firstColumn, peaks, half);
    ctx.fillStyle = style.rmsColor;
    fillColumns(ctx, clip.firstColumn, rms, half);
  }
  ctx.globalAlpha = 1;
}

/** Two arrays of heights that grow when needed, so a draw allocates nothing in the usual case. */
const scratchArrays: [Float32Array, Float32Array] = [
  new Float32Array(0),
  new Float32Array(0),
];

function scratch(index: 0 | 1, count: number): Float32Array {
  if (scratchArrays[index].length < count) {
    scratchArrays[index] = new Float32Array(
      Math.max(count, scratchArrays[index].length * 2),
    );
  }
  const array = scratchArrays[index].subarray(0, count);
  array.fill(0);
  return array;
}

function fillColumns(
  ctx: EnvelopeContext,
  firstColumn: number,
  heights: Float32Array,
  half: number,
): void {
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (h > 0) {
      ctx.fillRect(firstColumn + i, half - h, 1, 2 * h);
    }
  }
}
