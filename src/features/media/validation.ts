/**
 * Validation and normalization utilities for media import payloads and error responses.
 */

import type { Rational } from "@/types/project";
import {
  BACKEND_IMPORT_MEDIA_ERROR_CODES,
  IMPORT_MEDIA_ERROR_CODES,
  ImportMediaError,
  type AudioProbe,
  type BackendImportMediaErrorCode,
  type ImportMediaErrorCode,
  type ImportMediaResult,
  type MediaProbe,
} from "./types";

/**
 * Numeric boundaries matching Rust wire types and JavaScript safe integer limits.
 */
export const U32_MAX = 4_294_967_295;
export const I32_MIN = -2_147_483_648;
export const I32_MAX = 2_147_483_647;

/**
 * Checks whether an unknown value is a valid BackendImportMediaErrorCode.
 */
export function isBackendImportMediaErrorCode(
  value: unknown,
): value is BackendImportMediaErrorCode {
  return (
    typeof value === "string" &&
    (BACKEND_IMPORT_MEDIA_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Checks whether an unknown value is a valid ImportMediaErrorCode.
 */
export function isImportMediaErrorCode(value: unknown): value is ImportMediaErrorCode {
  return (
    typeof value === "string" &&
    (IMPORT_MEDIA_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Validates whether a value is a positive integer fitting within a Rust u32 (1..=4_294_967_295).
 */
export function isPositiveU32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= U32_MAX
  );
}

/**
 * Validates whether a value is a signed 32-bit integer fitting within a Rust i32 (-2_147_483_648..=2_147_483_647).
 */
export function isI32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= I32_MIN &&
    value <= I32_MAX
  );
}

/**
 * Validates whether a value is a valid signed Rational fraction with a positive denominator.
 * Used for timestamps like startTime which may be negative, zero, or positive.
 */
export function isSignedRational(value: unknown): value is Rational {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { n, d } = value as Record<string, unknown>;
  return (
    typeof n === "number" &&
    typeof d === "number" &&
    Number.isSafeInteger(n) &&
    Number.isSafeInteger(d) &&
    d > 0
  );
}

/**
 * Validates whether a value is a strictly positive Rational fraction (n > 0 and d > 0).
 * Required for frame rates (avgFrameRate, rFrameRate) per ADR-002.
 */
export function isPositiveRational(value: unknown): value is Rational {
  return isSignedRational(value) && value.n > 0;
}

/**
 * Validates whether a value is a non-negative Rational fraction (n >= 0 and d > 0).
 * Required for stream duration per ADR-002.
 */
export function isNonNegativeRational(value: unknown): value is Rational {
  return isSignedRational(value) && value.n >= 0;
}

/**
 * Validates and normalizes any rejected value or error payload into a safe ImportMediaError instance.
 *
 * Guarantees:
 * - Error code is always a recognized ImportMediaErrorCode (falling back to "unknown").
 * - `detail` is preserved ONLY when it is a string from backend rejections/payloads.
 * - `exitCode` is preserved ONLY when it is a safe integer within i32 bounds.
 * - Does not invent user-facing English sentences or freeze local Error messages into detail.
 */
export function normalizeImportMediaError(error: unknown): ImportMediaError {
  if (error instanceof ImportMediaError) {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;

    const code: ImportMediaErrorCode = isImportMediaErrorCode(candidate.code)
      ? candidate.code
      : "unknown";

    const detail = typeof candidate.detail === "string" ? candidate.detail : undefined;

    const exitCode = isI32(candidate.exitCode) ? candidate.exitCode : undefined;

    return new ImportMediaError({
      code,
      detail,
      exitCode,
    });
  }

  if (typeof error === "string" && error.length > 0) {
    return new ImportMediaError({
      code: "unknown",
      detail: error,
    });
  }

  return new ImportMediaError({ code: "unknown" });
}

/**
 * Validates an AudioProbe object boundary representation.
 */
export function isAudioProbe(value: unknown): value is AudioProbe {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { codec, sampleRate, channels } = value as Record<string, unknown>;

  const isCodecValid = codec === null || typeof codec === "string";
  const isSampleRateValid = sampleRate === null || isPositiveU32(sampleRate);
  const isChannelsValid = channels === null || isPositiveU32(channels);

  return isCodecValid && isSampleRateValid && isChannelsValid;
}

/**
 * Validates a MediaProbe object boundary representation.
 */
export function isMediaProbe(value: unknown): value is MediaProbe {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const p = value as Record<string, unknown>;

  if (
    !Array.isArray(p.formatNames) ||
    !p.formatNames.every((name) => typeof name === "string")
  ) {
    return false;
  }
  if (p.formatLongName !== null && typeof p.formatLongName !== "string") {
    return false;
  }
  if (typeof p.videoCodec !== "string") {
    return false;
  }
  if (p.videoProfile !== null && typeof p.videoProfile !== "string") {
    return false;
  }
  if (p.pixelFormat !== null && typeof p.pixelFormat !== "string") {
    return false;
  }
  if (p.bitDepth !== null && !isPositiveU32(p.bitDepth)) {
    return false;
  }
  if (!isPositiveU32(p.width) || !isPositiveU32(p.height)) {
    return false;
  }
  if (
    !isPositiveRational(p.avgFrameRate) ||
    !isPositiveRational(p.rFrameRate) ||
    !isSignedRational(p.startTime)
  ) {
    return false;
  }
  if (p.duration !== null && !isNonNegativeRational(p.duration)) {
    return false;
  }
  if (
    typeof p.frameCount !== "number" ||
    !Number.isSafeInteger(p.frameCount) ||
    p.frameCount < 0
  ) {
    return false;
  }
  if (p.audio !== null && !isAudioProbe(p.audio)) {
    return false;
  }
  if (typeof p.isVfr !== "boolean") {
    return false;
  }

  return true;
}

/**
 * Validates an unknown payload against the ImportMediaResult schema.
 * Throws a TypeError if the payload does not conform to the expected shape.
 */
export function validateImportMediaResult(value: unknown): ImportMediaResult {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(
      "Invalid media import result: payload must be a non-null object",
    );
  }

  const r = value as Record<string, unknown>;
  if (typeof r.path !== "string" || typeof r.fileName !== "string") {
    throw new TypeError(
      "Invalid media import result: path and fileName must be strings",
    );
  }

  if (
    typeof r.size !== "number" ||
    !Number.isSafeInteger(r.size) ||
    r.size < 0 ||
    typeof r.mtime !== "number" ||
    !Number.isSafeInteger(r.mtime)
  ) {
    throw new TypeError(
      "Invalid media import result: size and mtime must be safe integers",
    );
  }

  if (!isMediaProbe(r.probe)) {
    throw new TypeError(
      "Invalid media import result: probe payload is invalid or malformed",
    );
  }

  return value as ImportMediaResult;
}
