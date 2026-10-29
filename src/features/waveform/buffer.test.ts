import { describe, expect, it } from "vitest";
import { WaveformBuffer } from "./buffer";
import { parseWaveformChunk } from "./protocol";
import { chunkBytes } from "./testSupport";
import { WAVEFORM_MAX_BUCKETS } from "./types";

/** A small deterministic generator, so a failure repeats. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function bruteMax(peaks: number[], rms: number[], b0: number, b1: number) {
  let peak = 0;
  let r = 0;
  for (let i = Math.max(0, b0); i < Math.min(peaks.length, b1); i++) {
    peak = Math.max(peak, peaks[i] ?? 0);
    r = Math.max(r, rms[i] ?? 0);
  }
  return { peak, rms: r };
}

function pairsOf(peaks: readonly number[], rms: readonly number[]): Uint8Array {
  const pairs = new Uint8Array(peaks.length * 2);
  peaks.forEach((peak, i) => {
    pairs[2 * i] = peak;
    pairs[2 * i + 1] = rms[i] ?? 0;
  });
  return pairs;
}

describe("WaveformBuffer", () => {
  it("starts empty", () => {
    const buffer = new WaveformBuffer();
    expect(buffer.length).toBe(0);
    expect(buffer.maxRange(0, 100)).toEqual({ peak: 0, rms: 0 });
  });

  it("writes pairs and raises the length to the high water", () => {
    const buffer = new WaveformBuffer();
    expect(buffer.write(2, pairsOf([200, 100], [150, 50]))).toBe(true);
    expect(buffer.length).toBe(4);
    expect(buffer.peakAt(0)).toBe(0);
    expect(buffer.peakAt(2)).toBe(200);
    expect(buffer.rmsAt(3)).toBe(50);
    expect(buffer.peakAt(4)).toBe(0);
    expect(buffer.peakAt(-1)).toBe(0);
  });

  it("writes a binary message split across overlapping writes", () => {
    const peaks = Array.from({ length: 40 }, (_, i) => (i * 7) % 256);
    const rms = Array.from({ length: 40 }, (_, i) => (i * 3) % 256);
    const pairs = [...pairsOf(peaks, rms)];
    const buffer = new WaveformBuffer();
    // Buckets 0..24, then 16..40: the second message overlaps the first.
    const first = parseWaveformChunk(chunkBytes(0, pairs.slice(0, 48)));
    const second = parseWaveformChunk(chunkBytes(16, pairs.slice(32)));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    buffer.write(first?.startBucket ?? 0, first?.pairs ?? new Uint8Array());
    buffer.write(second?.startBucket ?? 0, second?.pairs ?? new Uint8Array());
    expect(buffer.length).toBe(40);
    for (let i = 0; i < 40; i++) {
      expect(buffer.peakAt(i)).toBe(peaks[i]);
      expect(buffer.rmsAt(i)).toBe(rms[i]);
    }
    expect(buffer.maxRange(0, 40)).toEqual(bruteMax(peaks, rms, 0, 40));
  });

  it("lowers the maxima when a later write replaces loud buckets", () => {
    const buffer = new WaveformBuffer();
    const loud = Array.from({ length: 5000 }, () => 250);
    buffer.write(0, pairsOf(loud, loud));
    expect(buffer.maxRange(0, 5000)).toEqual({ peak: 250, rms: 250 });
    const quiet = Array.from({ length: 5000 }, () => 40);
    buffer.write(0, pairsOf(quiet, quiet));
    expect(buffer.maxRange(0, 5000)).toEqual({ peak: 40, rms: 40 });
    expect(buffer.maxRange(1234, 4321)).toEqual({ peak: 40, rms: 40 });
  });

  it("agrees with a brute-force max on random data and random writes", () => {
    const next = random(42);
    const size = 70_000;
    const peaks = new Array<number>(size).fill(0);
    const rms = new Array<number>(size).fill(0);
    const buffer = new WaveformBuffer();
    let length = 0;
    for (let w = 0; w < 60; w++) {
      const start = Math.floor(next() * (size - 1));
      const count = Math.min(size - start, 1 + Math.floor(next() * 6000));
      const p = Array.from({ length: count }, () => Math.floor(next() * 256));
      const r = Array.from({ length: count }, () => Math.floor(next() * 256));
      buffer.write(start, pairsOf(p, r));
      for (let i = 0; i < count; i++) {
        peaks[start + i] = p[i] ?? 0;
        rms[start + i] = r[i] ?? 0;
      }
      length = Math.max(length, start + count);
    }
    expect(buffer.length).toBe(length);
    const prefixPeaks = peaks.slice(0, length);
    const prefixRms = rms.slice(0, length);
    for (let q = 0; q < 400; q++) {
      const a = Math.floor(next() * (length + 10));
      const span = Math.floor(next() * (q % 4 === 0 ? length : 300));
      const b0 = Math.min(a, a + span);
      const b1 = a + span + 1;
      expect(buffer.maxRange(b0, b1)).toEqual(bruteMax(prefixPeaks, prefixRms, b0, b1));
    }
  });

  it("keeps the maxima of a short head when a far write adds levels", () => {
    // A head of 40 s at code 200, then a run far on, as after an FLV that jumps forward. The
    // levels that the far write creates must cover the head too.
    const buffer = new WaveformBuffer();
    buffer.write(
      0,
      pairsOf(new Array<number>(4000).fill(200), new Array<number>(4000).fill(150)),
    );
    buffer.write(120_000, pairsOf([50, 50], [40, 40]));
    expect(buffer.maxRange(0, 240_000)).toEqual({ peak: 200, rms: 150 });
    expect(buffer.maxRange(5000, 240_000)).toEqual({ peak: 50, rms: 40 });

    const small = new WaveformBuffer();
    small.write(0, pairsOf([200], [100]));
    small.write(19, pairsOf([10], [5]));
    small.write(40, pairsOf([10], [5]));
    const peaks = new Array<number>(41).fill(0);
    const rms = new Array<number>(41).fill(0);
    peaks[0] = 200;
    rms[0] = 100;
    peaks[19] = peaks[40] = 10;
    rms[19] = rms[40] = 5;
    for (const [b0, b1] of [
      [0, 41],
      [0, 20],
      [1, 41],
      [17, 41],
    ]) {
      expect(small.maxRange(b0, b1)).toEqual(bruteMax(peaks, rms, b0, b1));
    }
  });

  it("refuses a write past the limit and half a pair", () => {
    const buffer = new WaveformBuffer();
    expect(buffer.write(WAVEFORM_MAX_BUCKETS - 1, pairsOf([1, 2], [1, 2]))).toBe(false);
    expect(buffer.length).toBe(0);
    expect(buffer.write(WAVEFORM_MAX_BUCKETS - 1, pairsOf([1], [1]))).toBe(true);
    expect(buffer.length).toBe(WAVEFORM_MAX_BUCKETS);
    expect(buffer.write(0, new Uint8Array(3))).toBe(false);
    expect(buffer.write(-1, new Uint8Array(2))).toBe(false);
  });

  it("honours a smaller limit", () => {
    const buffer = new WaveformBuffer(10);
    expect(buffer.write(8, pairsOf([1, 1, 1], [1, 1, 1]))).toBe(false);
    expect(buffer.write(8, pairsOf([1, 1], [1, 1]))).toBe(true);
  });
});
