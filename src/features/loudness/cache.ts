/**
 * The results of completed measurements, kept in memory for the application run (ADR 061).
 *
 * The key holds what decides the audio of an export: the path and the revision of each source,
 * the pieces in order, the sample rate and the channels of the preset, the streams, and for an
 * export with video the frame rate of the preset. The stand-in video of ADR 043 can pad the audio
 * of a segment with silence shorter than one frame, so another frame rate can change the true
 * peak near a join. Nothing here writes to disk.
 */

import type { LoudnessScope, LoudnessValues } from "./types";

/**
 * The key of the measurement of `scope`, or null when its result must not be kept: a source has
 * no revision in the request, because the user chose to export a changed file (ADR 024). The key
 * cannot see a later change of such a file (ADR 058).
 */
export function loudnessCacheKey(scope: LoudnessScope): string | null {
  const byId = new Map<string, readonly [string, number, number]>();
  for (const source of scope.sources) {
    const revision = source.expectedRevision;
    if (revision === undefined || revision === null) {
      return null;
    }
    byId.set(source.id, [source.path, revision.size, revision.mtime]);
  }
  // The sources in the order of their first piece, and each piece by the index of its source.
  // The key keeps how the pieces group into sources, which decides the inputs of the export, and
  // not the ids, which the page can give again.
  const order = new Map<string, number>();
  const sources: (readonly [string, number, number])[] = [];
  const pieces: (readonly [number, string, string])[] = [];
  for (const piece of scope.pieces) {
    const source = byId.get(piece.sourceId);
    if (source === undefined) {
      return null;
    }
    let index = order.get(piece.sourceId);
    if (index === undefined) {
      index = sources.length;
      order.set(piece.sourceId, index);
      sources.push(source);
    }
    pieces.push([index, piece.inPts, piece.outPts]);
  }
  const { preset, streams } = scope;
  return JSON.stringify({
    sources,
    pieces,
    sampleRate: preset.audioSampleRate,
    channels: preset.audioChannels,
    streams,
    frameRate: streams === "audioOnly" ? null : reducedFrameRate(preset.frameRate),
  });
}

/** The frame rate of a preset in lowest terms, as Rust reads it, so 48/2 and 24/1 are one key. */
function reducedFrameRate(rate: LoudnessScope["preset"]["frameRate"]): unknown {
  if (typeof rate !== "object" || rate === null) {
    return rate;
  }
  const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));
  const divisor = gcd(rate.n, rate.d) || 1;
  return { n: rate.n / divisor, d: rate.d / divisor };
}

/**
 * The completed results, for the application run (ADR 061). A result is a few numbers, and a
 * user measures a few exports in a run, so the cache keeps every result.
 */
export class LoudnessCache {
  readonly #entries = new Map<string, LoudnessValues>();

  get(key: string): LoudnessValues | undefined {
    return this.#entries.get(key);
  }

  set(key: string, values: LoudnessValues): void {
    this.#entries.set(key, values);
  }

  get size(): number {
    return this.#entries.size;
  }
}
