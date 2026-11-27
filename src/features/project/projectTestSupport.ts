/**
 * Test support of the save step and the open step: imports, entries and held promises.
 */

import type { ImportMediaResult, MediaProbe } from "@/features/media/types";
import type { FrameCount, PersistedSource, Pts, TickCount } from "@/types/project";

/** A promise that the test settles. */
export interface Held<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

/** A promise that the test settles with `resolve` or `reject`. */
export function held<T>(): Held<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets each pending promise callback run. */
export async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

/** A probe of 10 s in milliseconds, with every field of the answer of the backend. */
export function probeOf(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    formatNames: ["mov", "mp4"],
    formatLongName: "QuickTime / MOV",
    formatStartTime: null,
    videoCodec: "h264",
    videoProfile: "High",
    pixelFormat: "yuv420p",
    bitDepth: 8,
    width: 1920,
    height: 1080,
    videoStreamIndex: 0,
    videoTimeBase: { n: 1, d: 1000 },
    videoStartPts: "0" as Pts,
    videoDurationTicks: "10000" as TickCount,
    approximateDurationSeconds: 10,
    avgFrameRate: { n: 30, d: 1 },
    rFrameRate: { n: 30, d: 1 },
    reportedFrameCount: "300" as FrameCount,
    sampleAspectRatio: null,
    rotation: 0,
    videoEndPts: "10000" as Pts,
    audio: null,
    audioStreams: [],
    ...overrides,
  };
}

/** An import of the file at `path`. */
export function mediaAt(
  path: string,
  overrides: Partial<Omit<ImportMediaResult, "probe">> = {},
  probe: Partial<MediaProbe> = {},
): ImportMediaResult {
  return {
    path,
    fileName: path.split(/[/\\]/).pop() ?? path,
    size: 1000,
    mtime: 1_787_000_000,
    probe: probeOf(probe),
    ...overrides,
  };
}

/** The import that a file gives for `entry` at `path`: its revision, and the probe facts. */
export function mediaForEntry(
  entry: PersistedSource,
  path: string,
  probe: Partial<MediaProbe> = {},
): ImportMediaResult {
  const result: ImportMediaResult = {
    path,
    fileName: path.split(/[/\\]/).pop() ?? path,
    size: entry.size,
    mtime: entry.mtime,
    probe: probeOf({
      videoStreamIndex: entry.videoStreamIndex,
      videoTimeBase: entry.videoTimeBase,
      videoStartPts: entry.videoStartPts,
      videoEndPts: entry.videoEndPts,
      videoDurationTicks: entry.videoDurationTicks,
      approximateDurationSeconds: entry.approximateDurationSeconds,
      ...probe,
    }),
  };
  if (entry.fingerprint !== undefined) {
    result.fingerprint = {
      start: entry.fingerprint.start,
      fnv1a64: entry.fingerprint.fnv1a64,
    };
  }
  return result;
}

/** A persisted entry of 10 s in milliseconds. */
export function entryOf(
  id: string,
  path: string,
  overrides: Partial<PersistedSource> = {},
): PersistedSource {
  return {
    id,
    path,
    size: 1000,
    mtime: 1_787_000_000,
    videoStreamIndex: 0,
    videoTimeBase: { n: 1, d: 1000 },
    videoStartPts: "0" as Pts,
    videoEndPts: "10000" as Pts,
    videoDurationTicks: "10000" as TickCount,
    approximateDurationSeconds: 10,
    avgFrameRate: { n: 30, d: 1 },
    rFrameRate: { n: 30, d: 1 },
    reportedFrameCount: "300" as FrameCount,
    ...overrides,
  };
}
