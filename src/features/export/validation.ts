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
  ExportError,
  type BackendExportErrorCode,
  type ExportErrorCode,
  type ExportProgressEvent,
  type ExportStart,
} from "./types";

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
 * Validates whether an unknown value is a valid ExportStart structure.
 */
export function isExportStart(value: unknown): value is ExportStart {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const s = value as Record<string, unknown>;
  if (
    typeof s.runId !== "string" ||
    typeof s.presetId !== "string" ||
    typeof s.outputPath !== "string" ||
    !isPositiveU32(s.segmentCount) ||
    typeof s.totalDurationUs !== "number" ||
    !Number.isSafeInteger(s.totalDurationUs) ||
    s.totalDurationUs < 0
  ) {
    return false;
  }
  if (s.expectedFrames !== undefined && !isNonNegativeU32(s.expectedFrames)) {
    return false;
  }
  return true;
}

/**
 * Validates an unknown payload against the ExportStart schema.
 * Throws a TypeError if the payload does not conform to the expected shape.
 */
export function validateExportStart(value: unknown): ExportStart {
  if (!isExportStart(value)) {
    throw new TypeError(
      "Invalid export start result: payload must match ExportStart schema",
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

  switch (e.event) {
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
        (e.encoder === undefined || typeof e.encoder === "string")
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
 * Validates and normalizes any rejected value or error payload into a safe ExportError instance.
 *
 * Guarantees:
 * - Never throws.
 * - Error code is always a recognized ExportErrorCode (falling back to "unknown").
 * - `detail` is preserved ONLY when it is a string from backend rejections/payloads.
 * - `exitCode` is preserved ONLY when it is a safe integer within i32 bounds.
 * - `encoder` is preserved ONLY when it is a string.
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

    return new ExportError({
      code,
      detail,
      exitCode,
      encoder,
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
