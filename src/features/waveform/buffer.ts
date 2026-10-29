/**
 * The envelope of one source in the page (ADR 056): the codes of each bucket, and a pyramid of
 * maxima so that one column of the canvas reads the highest codes of many buckets in a few reads.
 *
 * Level 0 holds the pairs of the buckets, a peak code then an RMS code. Each node of level `k + 1`
 * holds the highest peak code and the highest RMS code of 16 nodes of level `k`. A write
 * recomputes the nodes above the buckets that it wrote, from their children, so a later write
 * that lowers a code also lowers the maxima above it (a later FLV run replaces earlier buckets).
 */

import { WAVEFORM_BYTES_PER_BUCKET, WAVEFORM_MAX_BUCKETS } from "./types";

/** The children of one node of the pyramid. */
export const WAVEFORM_PYRAMID_FACTOR = 16;

const INITIAL_CAPACITY_BUCKETS = 4096;

/** The highest codes of a range of buckets. */
export interface WaveformCodes {
  peak: number;
  rms: number;
}

function grow(array: Uint8Array, minimumBytes: number, limitBytes: number): Uint8Array {
  if (array.length >= minimumBytes) {
    return array;
  }
  let capacity = Math.max(
    array.length,
    INITIAL_CAPACITY_BUCKETS * WAVEFORM_BYTES_PER_BUCKET,
  );
  while (capacity < minimumBytes) {
    capacity *= 2;
  }
  const next = new Uint8Array(Math.min(capacity, Math.max(limitBytes, minimumBytes)));
  next.set(array);
  return next;
}

export class WaveformBuffer {
  /** Level 0, then each level of maxima. Each holds pairs, a peak code then an RMS code. */
  private readonly levels: Uint8Array[] = [new Uint8Array(0)];
  /** The node count of each level. */
  private readonly counts: number[] = [0];
  private readonly maxBuckets: number;

  constructor(maxBuckets: number = WAVEFORM_MAX_BUCKETS) {
    this.maxBuckets = maxBuckets;
  }

  /** The count of buckets: one more than the highest bucket that a write reached. */
  get length(): number {
    return this.counts[0] ?? 0;
  }

  /** The peak code of bucket `index`, or 0 outside the buffer. */
  peakAt(index: number): number {
    return index >= 0 && index < this.length
      ? (this.levels[0]?.[index * WAVEFORM_BYTES_PER_BUCKET] ?? 0)
      : 0;
  }

  /** The RMS code of bucket `index`, or 0 outside the buffer. */
  rmsAt(index: number): number {
    return index >= 0 && index < this.length
      ? (this.levels[0]?.[index * WAVEFORM_BYTES_PER_BUCKET + 1] ?? 0)
      : 0;
  }

  /**
   * Writes the pairs of `pairs` from bucket `startBucket`, over the buckets that are there.
   * Buckets between the old length and `startBucket` stay silent. Returns false and writes
   * nothing when the write would pass the limit of buckets, or when `pairs` holds half a pair.
   */
  write(startBucket: number, pairs: Uint8Array): boolean {
    if (
      !Number.isSafeInteger(startBucket) ||
      startBucket < 0 ||
      pairs.length % WAVEFORM_BYTES_PER_BUCKET !== 0
    ) {
      return false;
    }
    const count = pairs.length / WAVEFORM_BYTES_PER_BUCKET;
    const end = startBucket + count;
    if (end > this.maxBuckets) {
      return false;
    }
    if (count === 0) {
      return true;
    }
    const length = Math.max(this.length, end);
    this.resize(0, length);
    const base = this.levels[0];
    base.set(pairs, startBucket * WAVEFORM_BYTES_PER_BUCKET);
    this.counts[0] = length;
    this.update(startBucket, end);
    return true;
  }

  /**
   * The highest peak code and the highest RMS code of the buckets `[b0, b1)`, clamped to the
   * buffer. Both are 0 for an empty range. It reads at most about 2 × 16 nodes of each level.
   */
  maxRange(
    b0: number,
    b1: number,
    out: WaveformCodes = { peak: 0, rms: 0 },
  ): WaveformCodes {
    out.peak = 0;
    out.rms = 0;
    let lo = Math.max(0, Math.floor(b0));
    let hi = Math.min(this.length, Math.ceil(b1));
    let level = 0;
    while (lo < hi) {
      const nodes = this.levels[level];
      const top = level + 1 >= this.levels.length;
      if (top || hi - lo <= 2 * WAVEFORM_PYRAMID_FACTOR) {
        this.take(nodes, lo, hi, out);
        break;
      }
      const loUp = Math.ceil(lo / WAVEFORM_PYRAMID_FACTOR) * WAVEFORM_PYRAMID_FACTOR;
      const hiDown = Math.floor(hi / WAVEFORM_PYRAMID_FACTOR) * WAVEFORM_PYRAMID_FACTOR;
      this.take(nodes, lo, loUp, out);
      this.take(nodes, hiDown, hi, out);
      lo = loUp / WAVEFORM_PYRAMID_FACTOR;
      hi = hiDown / WAVEFORM_PYRAMID_FACTOR;
      level += 1;
    }
    return out;
  }

  private take(nodes: Uint8Array, from: number, to: number, out: WaveformCodes): void {
    for (let i = from; i < to; i++) {
      const peak = nodes[i * WAVEFORM_BYTES_PER_BUCKET] ?? 0;
      const rms = nodes[i * WAVEFORM_BYTES_PER_BUCKET + 1] ?? 0;
      if (peak > out.peak) {
        out.peak = peak;
      }
      if (rms > out.rms) {
        out.rms = rms;
      }
    }
  }

  /** Makes level `level` hold at least `count` nodes. */
  private resize(level: number, count: number): void {
    const current = this.levels[level] ?? new Uint8Array(0);
    const limit =
      Math.ceil(this.maxBuckets / WAVEFORM_PYRAMID_FACTOR ** level) *
      WAVEFORM_BYTES_PER_BUCKET;
    this.levels[level] = grow(current, count * WAVEFORM_BYTES_PER_BUCKET, limit);
  }

  /** Recomputes the nodes above the buckets `[start, end)`, level by level. */
  private update(start: number, end: number): void {
    let lo = start;
    let hi = end;
    let level = 0;
    // A level of one node is the top: no level above it is needed.
    while ((this.counts[level] ?? 0) > 1) {
      const childCount = this.counts[level];
      const children = this.levels[level];
      const parentCount = Math.ceil(childCount / WAVEFORM_PYRAMID_FACTOR);
      // A level that this write creates has no node yet, so all of it comes from its children,
      // and so does every level above it. Its first node covers buckets that an earlier write
      // can hold, far below the buckets of this write.
      const created = (this.counts[level + 1] ?? 0) === 0;
      this.resize(level + 1, parentCount);
      this.counts[level + 1] = parentCount;
      const parents = this.levels[level + 1];
      const parentLo = created ? 0 : Math.floor(lo / WAVEFORM_PYRAMID_FACTOR);
      const parentHi = Math.ceil(hi / WAVEFORM_PYRAMID_FACTOR);
      for (let p = parentLo; p < parentHi; p++) {
        let peak = 0;
        let rms = 0;
        const last = Math.min(childCount, (p + 1) * WAVEFORM_PYRAMID_FACTOR);
        for (let c = p * WAVEFORM_PYRAMID_FACTOR; c < last; c++) {
          const childPeak = children[c * WAVEFORM_BYTES_PER_BUCKET];
          const childRms = children[c * WAVEFORM_BYTES_PER_BUCKET + 1];
          if (childPeak > peak) {
            peak = childPeak;
          }
          if (childRms > rms) {
            rms = childRms;
          }
        }
        parents[p * WAVEFORM_BYTES_PER_BUCKET] = peak;
        parents[p * WAVEFORM_BYTES_PER_BUCKET + 1] = rms;
      }
      lo = parentLo;
      hi = parentHi;
      level += 1;
    }
  }
}
