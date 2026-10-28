/**
 * Validation and normalization utilities for export rendering payloads and errors.
 *
 * Implements defensive boundary checks matching Rust wire types, ADR 011, and ADR 014.
 */

import { isI32, isNonNegativeU32, isPositiveU32 } from "@/features/ffmpeg/validation";
import { isNonNegativeRational, isPositiveRational } from "@/features/media/validation";
import {
  BACKEND_EXPORT_ERROR_CODES,
  EXPORT_ERROR_CODES,
  EXPORT_QUEUE_RUN_PHASES,
  EXPORT_STREAMS,
  ExportError,
  type BackendExportErrorCode,
  type ExportErrorCode,
  type ExportProgressEvent,
  type ExportQueueRunError,
  type ExportQueueRunPhase,
  type ExportQueueSnapshot,
  type ExportQueueSnapshotRun,
  type ExportSubmission,
  type ExportStreams,
} from "./types";

/**
 * Checks whether an unknown value is one of the `EXPORT_STREAMS` wire strings.
 */
export function isExportStreams(value: unknown): value is ExportStreams {
  return (
    typeof value === "string" && (EXPORT_STREAMS as readonly string[]).includes(value)
  );
}

/**
 * Checks whether an unknown value is a whole number of microseconds that JavaScript holds
 * exactly: a non-negative safe integer, as `totalDurationUs` is.
 */
function isDurationUs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Checks whether an unknown value is a sequence number of an export event: a non-negative safe
 * integer.
 */
function isSequenceNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Checks whether an unknown value is a valid BackendExportErrorCode.
 */
export function isBackendExportErrorCode(
  value: unknown,
): value is BackendExportErrorCode {
  return (
    typeof value === "string" &&
    (BACKEND_EXPORT_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Checks whether an unknown value is a valid ExportErrorCode.
 */
export function isExportErrorCode(value: unknown): value is ExportErrorCode {
  return (
    typeof value === "string" &&
    (EXPORT_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Validates whether an unknown value is a valid ExportSubmission structure.
 */
export function isExportSubmission(value: unknown): value is ExportSubmission {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const s = value as Record<string, unknown>;
  return (
    typeof s.runId === "string" && s.runId.length > 0 && typeof s.queued === "boolean"
  );
}

/**
 * Validates an unknown payload against the ExportSubmission schema.
 * Throws a TypeError if the payload does not conform to the expected shape.
 */
export function validateExportSubmission(value: unknown): ExportSubmission {
  if (!isExportSubmission(value)) {
    throw new TypeError(
      "Invalid export start result: payload must match ExportSubmission schema",
    );
  }
  return value;
}

/**
 * Validates whether an unknown value is a valid ExportProgressEvent tagged union member.
 */
export function isExportProgressEvent(value: unknown): value is ExportProgressEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const e = value as Record<string, unknown>;
  if (typeof e.event !== "string" || typeof e.runId !== "string") {
    return false;
  }
  // The sequence number of the export journal. An event without one is still valid.
  if (e.seq !== undefined && !isSequenceNumber(e.seq)) {
    return false;
  }

  switch (e.event) {
    case "preparing":
      return true;
    case "started":
      return (
        typeof e.outputPath === "string" &&
        isPositiveU32(e.segmentCount) &&
        typeof e.totalDurationUs === "number" &&
        Number.isSafeInteger(e.totalDurationUs) &&
        e.totalDurationUs >= 0 &&
        (e.expectedFrames === undefined || isNonNegativeU32(e.expectedFrames))
      );
    case "progress":
      return (
        isNonNegativeU32(e.frame) &&
        (e.expectedFrames === undefined || isNonNegativeU32(e.expectedFrames)) &&
        (e.fps === undefined || isPositiveRational(e.fps)) &&
        (e.speed === undefined || isNonNegativeRational(e.speed)) &&
        (e.totalSize === undefined ||
          (typeof e.totalSize === "number" &&
            Number.isSafeInteger(e.totalSize) &&
            e.totalSize >= 0))
      );
    case "publishing":
      return true;
    case "finished":
      return typeof e.outputPath === "string" && isNonNegativeU32(e.frames);
    case "failed":
      return (
        isBackendExportErrorCode(e.code) &&
        (e.detail === undefined || typeof e.detail === "string") &&
        (e.exitCode === undefined || isI32(e.exitCode)) &&
        (e.encoder === undefined || typeof e.encoder === "string") &&
        (e.measuredDurationUs === undefined || isDurationUs(e.measuredDurationUs)) &&
        (e.expectedDurationUs === undefined || isDurationUs(e.expectedDurationUs))
      );
    default:
      return false;
  }
}

/**
 * Validates an unknown payload against the ExportProgressEvent schema.
 * Throws a TypeError if the payload does not conform to the expected shape.
 */
export function validateExportProgressEvent(value: unknown): ExportProgressEvent {
  if (!isExportProgressEvent(value)) {
    throw new TypeError(
      "Invalid export progress event: payload must match ExportProgressEvent schema",
    );
  }
  return value;
}

/**
 * Checks whether an unknown value is one of the `EXPORT_QUEUE_RUN_PHASES` wire strings.
 */
export function isExportQueueRunPhase(value: unknown): value is ExportQueueRunPhase {
  return (
    typeof value === "string" &&
    (EXPORT_QUEUE_RUN_PHASES as readonly string[]).includes(value)
  );
}

/**
 * Checks whether an unknown value is the error of a run in the snapshot.
 */
function isExportQueueRunError(value: unknown): value is ExportQueueRunError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const e = value as Record<string, unknown>;
  return (
    isBackendExportErrorCode(e.code) &&
    (e.detail === undefined || typeof e.detail === "string") &&
    (e.exitCode === undefined || isI32(e.exitCode)) &&
    (e.encoder === undefined || typeof e.encoder === "string") &&
    (e.measuredDurationUs === undefined || isDurationUs(e.measuredDurationUs)) &&
    (e.expectedDurationUs === undefined || isDurationUs(e.expectedDurationUs))
  );
}

/**
 * Checks whether an unknown value is one run of the answer of `export_queue_snapshot`.
 *
 * Besides the shape, it checks the rules of the backend: only an ended run has `endOrder`, which
 * starts at 1, only a run that failed or was canceled has `error`, and an ended run has no
 * `elapsedMs`.
 */
export function isExportQueueSnapshotRun(
  value: unknown,
): value is ExportQueueSnapshotRun {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if (
    typeof r.runId !== "string" ||
    r.runId.length === 0 ||
    typeof r.outputPath !== "string" ||
    typeof r.presetName !== "string" ||
    !isNonNegativeU32(r.segmentCount) ||
    !isExportStreams(r.streams) ||
    !isExportQueueRunPhase(r.phase) ||
    (r.frame !== undefined && !isNonNegativeU32(r.frame)) ||
    (r.expectedFrames !== undefined && !isNonNegativeU32(r.expectedFrames)) ||
    (r.elapsedMs !== undefined && !isSequenceNumber(r.elapsedMs))
  ) {
    return false;
  }
  const ended =
    r.phase === "finished" || r.phase === "failed" || r.phase === "canceled";
  const hasError = r.phase === "failed" || r.phase === "canceled";
  if (ended) {
    if (!isSequenceNumber(r.endOrder) || r.endOrder < 1 || r.elapsedMs !== undefined) {
      return false;
    }
  } else if (r.endOrder !== undefined) {
    return false;
  }
  return hasError ? isExportQueueRunError(r.error) : r.error === undefined;
}

/**
 * Checks whether an unknown value is the answer of `export_queue_snapshot`.
 */
export function isExportQueueSnapshot(value: unknown): value is ExportQueueSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const s = value as Record<string, unknown>;
  return (
    isSequenceNumber(s.seq) &&
    Array.isArray(s.runs) &&
    s.runs.every((run) => isExportQueueSnapshotRun(run))
  );
}

/**
 * Validates an unknown payload against the ExportQueueSnapshot schema.
 * Throws a TypeError if the payload does not conform to the expected shape.
 */
export function validateExportQueueSnapshot(value: unknown): ExportQueueSnapshot {
  if (!isExportQueueSnapshot(value)) {
    throw new TypeError(
      "Invalid export queue snapshot: payload must match ExportQueueSnapshot schema",
    );
  }
  return value;
}

/**
 * Validates and normalizes any rejected value or error payload into a safe ExportError instance.
 *
 * Guarantees:
 * - Never throws.
 * - Error code is always a recognized ExportErrorCode (falling back to "unknown").
 * - `detail` is preserved ONLY when it is a string from backend rejections/payloads.
 * - `exitCode` is preserved ONLY when it is a safe integer within i32 bounds.
 * - `encoder` is preserved ONLY when it is a string.
 * - `measuredDurationUs` and `expectedDurationUs` are preserved ONLY when each is a
 *   non-negative safe integer.
 * - A plain `new Error("boom")` becomes `{ code: "unknown" }` with NO detail — the local message must not leak into detail.
 */
export function normalizeExportError(error: unknown): ExportError {
  if (error instanceof ExportError) {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;

    const code: ExportErrorCode = isExportErrorCode(candidate.code)
      ? candidate.code
      : "unknown";

    const detail = typeof candidate.detail === "string" ? candidate.detail : undefined;

    const exitCode = isI32(candidate.exitCode) ? candidate.exitCode : undefined;

    const encoder =
      typeof candidate.encoder === "string" ? candidate.encoder : undefined;

    const measuredDurationUs = isDurationUs(candidate.measuredDurationUs)
      ? candidate.measuredDurationUs
      : undefined;

    const expectedDurationUs = isDurationUs(candidate.expectedDurationUs)
      ? candidate.expectedDurationUs
      : undefined;

    return new ExportError({
      code,
      detail,
      exitCode,
      encoder,
      measuredDurationUs,
      expectedDurationUs,
    });
  }

  if (typeof error === "string" && error.length > 0) {
    return new ExportError({
      code: "unknown",
      detail: error,
    });
  }

  return new ExportError({ code: "unknown" });
}
