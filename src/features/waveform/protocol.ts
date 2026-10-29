/**
 * Pure parsers of the replies and the channel messages of the envelope jobs (ADR 056).
 *
 * Each parser refuses a value of the wrong shape and an error name that it does not know, with a
 * null result. No parser throws.
 */

import {
  WAVEFORM_BYTES_PER_BUCKET,
  WAVEFORM_END_ERROR_CODES,
  WAVEFORM_START_ERROR_CODES,
  WaveformError,
  type WaveformCacheCleared,
  type WaveformCacheUsage,
  type WaveformChunk,
  type WaveformEnd,
  type WaveformEndErrorCode,
  type WaveformProgress,
  type WaveformStarted,
  type WaveformStartErrorCode,
} from "./types";

/** The bytes in front of the pairs of a binary message: the start bucket and the count. */
export const WAVEFORM_CHUNK_HEADER_BYTES = 8;

const START_ERROR_CODES: ReadonlySet<string> = new Set(WAVEFORM_START_ERROR_CODES);
const END_ERROR_CODES: ReadonlySet<string> = new Set(WAVEFORM_END_ERROR_CODES);

/** One channel message, sorted by its kind. */
export type WaveformMessage =
  | { readonly kind: "chunk"; readonly chunk: WaveformChunk }
  | { readonly kind: "progress"; readonly progress: WaveformProgress }
  | { readonly kind: "end"; readonly end: WaveformEnd }
  | { readonly kind: "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A count, null, or undefined when the value is neither. */
function optionalCount(value: unknown): number | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return isCount(value) ? value : undefined;
}

/** A string, null, or undefined when the value is neither. */
function optionalString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

/** The bytes of a raw channel message, or null for a JSON message. */
export function rawMessageBytes(message: unknown): Uint8Array | null {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return null;
}

/**
 * A binary message: a little-endian `u32` start bucket, a little-endian `u32` count, then the
 * pairs. Null when the length does not agree with the count.
 */
export function parseWaveformChunk(bytes: Uint8Array): WaveformChunk | null {
  if (bytes.byteLength < WAVEFORM_CHUNK_HEADER_BYTES) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const startBucket = view.getUint32(0, true);
  const count = view.getUint32(4, true);
  if (
    bytes.byteLength !==
    WAVEFORM_CHUNK_HEADER_BYTES + count * WAVEFORM_BYTES_PER_BUCKET
  ) {
    return null;
  }
  return {
    startBucket,
    count,
    pairs: bytes.subarray(WAVEFORM_CHUNK_HEADER_BYTES),
  };
}

/** A progress message, or null when the message does not have its shape. */
export function parseWaveformProgress(message: unknown): WaveformProgress | null {
  if (
    !isRecord(message) ||
    message.type !== "progress" ||
    !isCount(message.highWater)
  ) {
    return null;
  }
  const bytesRead = optionalCount(message.bytesRead);
  const totalBytes = optionalCount(message.totalBytes);
  if (bytesRead === undefined || totalBytes === undefined) {
    return null;
  }
  return { highWater: message.highWater, bytesRead, totalBytes };
}

/**
 * An end message, or null when the message does not have its shape. A failed end must carry a
 * known error name, and an end that did not fail must carry none.
 */
export function parseWaveformEnd(message: unknown): WaveformEnd | null {
  if (!isRecord(message) || message.type !== "end") {
    return null;
  }
  const { status, bucketCount, cached, timestampsDecrease, damaged, truncated } =
    message;
  const { alignmentUncertain } = message;
  if (status !== "complete" && status !== "canceled" && status !== "failed") {
    return null;
  }
  if (
    !isCount(bucketCount) ||
    typeof cached !== "boolean" ||
    typeof timestampsDecrease !== "boolean" ||
    typeof damaged !== "boolean" ||
    typeof truncated !== "boolean" ||
    typeof alignmentUncertain !== "boolean"
  ) {
    return null;
  }
  const code = optionalString(message.code);
  const detail = optionalString(message.detail);
  if (code === undefined || detail === undefined) {
    return null;
  }
  if (
    status === "failed" ? code === null || !END_ERROR_CODES.has(code) : code !== null
  ) {
    return null;
  }
  return {
    status,
    code: code as WaveformEndErrorCode | null,
    detail,
    bucketCount,
    cached,
    flags: { timestampsDecrease, damaged, truncated, alignmentUncertain },
  };
}

/** Sorts one channel message. A message of no known shape is `invalid`. */
export function parseWaveformMessage(message: unknown): WaveformMessage {
  const bytes = rawMessageBytes(message);
  if (bytes !== null) {
    const chunk = parseWaveformChunk(bytes);
    return chunk === null ? { kind: "invalid" } : { kind: "chunk", chunk };
  }
  const progress = parseWaveformProgress(message);
  if (progress !== null) {
    return { kind: "progress", progress };
  }
  const end = parseWaveformEnd(message);
  if (end !== null) {
    return { kind: "end", end };
  }
  return { kind: "invalid" };
}

/** The reply of `start_waveform`, or null when it does not have its shape. */
export function parseWaveformStarted(reply: unknown): WaveformStarted | null {
  if (
    !isRecord(reply) ||
    !isCount(reply.jobId) ||
    typeof reply.cached !== "boolean" ||
    !isCount(reply.bucketRate) ||
    reply.bucketRate === 0
  ) {
    return null;
  }
  return { jobId: reply.jobId, cached: reply.cached, bucketRate: reply.bucketRate };
}

/** The error that `start_waveform` rejected with, or null when it has no known name. */
export function parseWaveformStartError(
  error: unknown,
): { readonly code: WaveformStartErrorCode; readonly detail: string | null } | null {
  if (
    !isRecord(error) ||
    typeof error.code !== "string" ||
    !START_ERROR_CODES.has(error.code)
  ) {
    return null;
  }
  const detail = optionalString(error.detail);
  return {
    code: error.code as WaveformStartErrorCode,
    detail: detail ?? null,
  };
}

/**
 * The error of a rejected command, as a WaveformError. A rejection with no known name becomes
 * `commandExecutionFailed`, with its text as the detail.
 */
export function toWaveformError(error: unknown): WaveformError {
  if (error instanceof WaveformError) {
    return error;
  }
  const parsed = parseWaveformStartError(error);
  if (parsed !== null) {
    return new WaveformError(parsed.code, parsed.detail);
  }
  return new WaveformError(
    "commandExecutionFailed",
    error instanceof Error ? error.message : String(error),
  );
}

/** The reply of `waveform_cache_usage`, or null when it does not have its shape. */
export function parseWaveformCacheUsage(reply: unknown): WaveformCacheUsage | null {
  if (
    !isRecord(reply) ||
    !isCount(reply.bytes) ||
    !isCount(reply.entries) ||
    !isCount(reply.limitBytes)
  ) {
    return null;
  }
  return { bytes: reply.bytes, entries: reply.entries, limitBytes: reply.limitBytes };
}

/** The reply of `clear_waveform_cache`, or null when it does not have its shape. */
export function parseWaveformCacheCleared(reply: unknown): WaveformCacheCleared | null {
  if (!isRecord(reply) || !isCount(reply.removedBytes)) {
    return null;
  }
  return { removedBytes: reply.removedBytes };
}
