/**
 * The wire types and the constants of the audio envelope of a source (ADR 056).
 *
 * Rust reads the whole source once and streams the envelope: one bucket each 10 ms, counted from
 * `videoStartPts`, with two codes each, the peak and the RMS. Code 0 is silence, and code `c` is
 * `c / 4 - 63.75` dBFS, so code 255 is 0 dBFS.
 */

import type { Pts, Rational } from "@/types/project";

/** The buckets of one second. */
export const WAVEFORM_BUCKET_RATE = 100;

/** The bytes of one bucket: the peak code, then the RMS code. */
export const WAVEFORM_BYTES_PER_BUCKET = 2;

/** The most buckets that one source can hold: 72 hours, as Rust limits them (ADR 056). */
export const WAVEFORM_MAX_BUCKETS = 72 * 3600 * WAVEFORM_BUCKET_RATE;

/** The values of a start request that the page knows. The client adds the request number. */
export interface WaveformRequest {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  /** The absolute index of the audio stream that the probe chose (`AudioProbe.index`). */
  readonly audioStreamIndex: number;
  /** The origin of bucket 0. */
  readonly videoStartPts: Pts;
  readonly videoTimeBase: Rational;
  /** `approximateDurationSeconds` of the probe, or null. */
  readonly durationSeconds: number | null;
}

/** What `start_waveform` returns when it accepted a request. */
export interface WaveformStarted {
  readonly jobId: number;
  /** True when the envelope comes from the cache. Such a job takes no slot. */
  readonly cached: boolean;
  readonly bucketRate: number;
}

/** The stable error names of `start_waveform` (ADR 011). */
export const WAVEFORM_START_ERROR_CODES = [
  "invalidRequest",
  "sourceUnreadable",
  "sourceNotAllowed",
  "sourceChanged",
  "busy",
  "superseded",
  "closed",
  "cacheUnavailable",
  "ffmpegNotFound",
  "commandExecutionFailed",
] as const;

export type WaveformStartErrorCode = (typeof WAVEFORM_START_ERROR_CODES)[number];

/** The stable error names of a failed end message (ADR 011). */
export const WAVEFORM_END_ERROR_CODES = [
  "spawnFailed",
  "readFailed",
  "decodeFailed",
  "sourceChanged",
] as const;

export type WaveformEndErrorCode = (typeof WAVEFORM_END_ERROR_CODES)[number];

/**
 * Every error name that the page can show for a job: the names of Rust, and `invalidResponse`
 * for a reply or a message of the wrong shape.
 */
export type WaveformErrorCode =
  WaveformStartErrorCode | WaveformEndErrorCode | "invalidResponse";

/** A refused command, or a job that failed. */
export class WaveformError extends Error {
  readonly code: WaveformErrorCode;
  /** Untranslated diagnostic text, such as the last lines of the FFmpeg error output. */
  readonly detail: string | null;

  constructor(code: WaveformErrorCode, detail: string | null = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "WaveformError";
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** One binary message: the codes of `count` buckets from `startBucket`. */
export interface WaveformChunk {
  readonly startBucket: number;
  readonly count: number;
  /** `count` pairs of a peak code and an RMS code. A view into the message. */
  readonly pairs: Uint8Array;
}

/** A progress message. Rust sends at most 4 each second. */
export interface WaveformProgress {
  /** The count of buckets that the job wrote so far. */
  readonly highWater: number;
  readonly bytesRead: number | null;
  readonly totalBytes: number | null;
}

/** The flags of an envelope. A cache hit gives them again. */
export interface WaveformFlags {
  /** A later FLV run replaced earlier buckets. */
  readonly timestampsDecrease: boolean;
  /** The job stopped at a damaged FLV tag. */
  readonly damaged: boolean;
  /** Rust dropped the buckets after its limit. */
  readonly truncated: boolean;
  /** The audio format changed, so the envelope after the change can be late. */
  readonly alignmentUncertain: boolean;
}

export const NO_WAVEFORM_FLAGS: WaveformFlags = {
  timestampsDecrease: false,
  damaged: false,
  truncated: false,
  alignmentUncertain: false,
};

export type WaveformEndStatus = "complete" | "canceled" | "failed";

/** The last message of a job. */
export interface WaveformEnd {
  readonly status: WaveformEndStatus;
  /** The error of a failed job. Null for a job that did not fail. */
  readonly code: WaveformEndErrorCode | "invalidResponse" | null;
  readonly detail: string | null;
  readonly bucketCount: number;
  readonly cached: boolean;
  readonly flags: WaveformFlags;
}

/** What `waveform_cache_usage` returns. */
export interface WaveformCacheUsage {
  readonly bytes: number;
  readonly entries: number;
  readonly limitBytes: number;
}

/**
 * The size limit of the cache of the backend (`LIMIT_BYTES` in `ffmpeg/waveform/cache.rs`), for
 * the text of the Settings window before the backend answers.
 */
export const WAVEFORM_CACHE_LIMIT_BYTES = 256 * 1024 * 1024;

/** What `clear_waveform_cache` returns. */
export interface WaveformCacheCleared {
  readonly removedBytes: number;
}
