/**
 * Validation and normalization utilities for ffmpeg capability probing payloads and errors.
 *
 * Implements defensive boundary checks matching Rust wire types and ADR 011.
 */

import {
  BACKEND_CAPABILITY_PROBE_ERROR_CODES,
  CAPABILITY_PROBE_ERROR_CODES,
  CapabilityProbeError,
  CODEC_KINDS,
  ENCODER_STATUSES,
  EXECUTABLE_ORIGINS,
  type BackendCapabilityProbeErrorCode,
  type CapabilityProbeErrorCode,
  type CapabilityProbeEvent,
  type CapabilityProbeStart,
  type CapabilityReport,
  type CodecKind,
  type EncoderResult,
  type EncoderStatus,
  type InspectedCandidate,
  type LicenseFlags,
  type Origin,
} from "./types";

/**
 * Numeric boundaries matching Rust wire types and JavaScript safe integer limits.
 */
export const U32_MAX = 4_294_967_295;
export const I32_MIN = -2_147_483_648;
export const I32_MAX = 2_147_483_647;

/**
 * Checks whether an unknown value is a valid ExecutableOrigin.
 */
export function isOrigin(value: unknown): value is Origin {
  return (
    typeof value === "string" &&
    (EXECUTABLE_ORIGINS as readonly string[]).includes(value)
  );
}

/**
 * Checks whether an unknown value is a valid CodecKind.
 */
export function isCodecKind(value: unknown): value is CodecKind {
  return (
    typeof value === "string" && (CODEC_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Checks whether an unknown value is a valid EncoderStatus.
 */
export function isEncoderStatus(value: unknown): value is EncoderStatus {
  return (
    typeof value === "string" && (ENCODER_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Checks whether an unknown value is a valid BackendCapabilityProbeErrorCode.
 */
export function isBackendCapabilityProbeErrorCode(
  value: unknown,
): value is BackendCapabilityProbeErrorCode {
  return (
    typeof value === "string" &&
    (BACKEND_CAPABILITY_PROBE_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Checks whether an unknown value is a valid CapabilityProbeErrorCode.
 */
export function isCapabilityProbeErrorCode(
  value: unknown,
): value is CapabilityProbeErrorCode {
  return (
    typeof value === "string" &&
    (CAPABILITY_PROBE_ERROR_CODES as readonly string[]).includes(value)
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
 * Validates whether a value is a non-negative integer fitting within a Rust u32 (0..=4_294_967_295).
 */
export function isNonNegativeU32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
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
 * Validates whether an unknown value is a valid LicenseFlags structure.
 */
export function isLicenseFlags(value: unknown): value is LicenseFlags {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const f = value as Record<string, unknown>;
  return (
    typeof f.gpl === "boolean" &&
    typeof f.nonfree === "boolean" &&
    typeof f.version3 === "boolean"
  );
}

/**
 * Validates whether an unknown value is a valid InspectedCandidate structure.
 */
export function isInspectedCandidate(value: unknown): value is InspectedCandidate {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const c = value as Record<string, unknown>;
  return (
    typeof c.ffmpeg === "string" && typeof c.ffprobe === "string" && isOrigin(c.origin)
  );
}

/**
 * Validates whether an unknown value is an array of InspectedCandidate objects.
 */
export function isInspectedCandidateArray(
  value: unknown,
): value is InspectedCandidate[] {
  return Array.isArray(value) && value.every(isInspectedCandidate);
}

/**
 * Validates whether an unknown value is a valid EncoderResult structure.
 */
export function isEncoderResult(value: unknown): value is EncoderResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if (
    typeof r.name !== "string" ||
    !isCodecKind(r.kind) ||
    typeof r.listed !== "boolean" ||
    !isEncoderStatus(r.status)
  ) {
    return false;
  }
  if (r.exitCode !== undefined && !isI32(r.exitCode)) {
    return false;
  }
  if (r.detail !== undefined && typeof r.detail !== "string") {
    return false;
  }
  return true;
}

/**
 * Validates whether an unknown value is a valid CapabilityReport structure.
 */
export function isCapabilityReport(value: unknown): value is CapabilityReport {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if (typeof r.version !== "string" || !isLicenseFlags(r.license)) {
    return false;
  }
  if (!Array.isArray(r.hwaccels) || !r.hwaccels.every((h) => typeof h === "string")) {
    return false;
  }
  if (!Array.isArray(r.encoders) || !r.encoders.every(isEncoderResult)) {
    return false;
  }
  if (!isPositiveU32(r.probedAt)) {
    return false;
  }
  return true;
}

/**
 * Validates whether an unknown value is a valid CapabilityProbeStart structure.
 */
export function isCapabilityProbeStart(value: unknown): value is CapabilityProbeStart {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const s = value as Record<string, unknown>;
  return (
    typeof s.runId === "string" &&
    typeof s.ffmpeg === "string" &&
    typeof s.ffprobe === "string" &&
    isOrigin(s.origin)
  );
}

/**
 * Validates whether an unknown value is a valid CapabilityProbeEvent tagged union member.
 */
export function isCapabilityProbeEvent(value: unknown): value is CapabilityProbeEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const e = value as Record<string, unknown>;
  if (typeof e.event !== "string" || typeof e.runId !== "string") {
    return false;
  }

  switch (e.event) {
    case "located":
      return (
        typeof e.ffmpeg === "string" &&
        typeof e.ffprobe === "string" &&
        isOrigin(e.origin) &&
        typeof e.version === "string" &&
        isLicenseFlags(e.license)
      );
    case "result":
      return (
        isEncoderResult(e.result) && isPositiveU32(e.done) && isPositiveU32(e.total)
      );
    case "finished":
      return (
        isCapabilityReport(e.report) && (e.source === "probe" || e.source === "cache")
      );
    case "failed":
      return (
        isBackendCapabilityProbeErrorCode(e.code) &&
        (e.detail === undefined || typeof e.detail === "string") &&
        (e.exitCode === undefined || isI32(e.exitCode)) &&
        (e.inspected === undefined || isInspectedCandidateArray(e.inspected))
      );
    default:
      return false;
  }
}

/**
 * Validates an unknown payload against the CapabilityProbeStart schema.
 * Throws a TypeError if the payload does not conform to the expected shape.
 */
export function validateCapabilityProbeStart(value: unknown): CapabilityProbeStart {
  if (!isCapabilityProbeStart(value)) {
    throw new TypeError(
      "Invalid capability probe start result: payload must match CapabilityProbeStart schema",
    );
  }
  return value;
}

/**
 * Validates an unknown payload against the CapabilityProbeEvent schema.
 * Throws a TypeError if the payload does not conform to the expected shape.
 */
export function validateCapabilityProbeEvent(value: unknown): CapabilityProbeEvent {
  if (!isCapabilityProbeEvent(value)) {
    throw new TypeError(
      "Invalid capability probe event: payload must match CapabilityProbeEvent schema",
    );
  }
  return value;
}

/**
 * Validates and normalizes any rejected value or error payload into a safe CapabilityProbeError instance.
 *
 * Guarantees:
 * - Error code is always a recognized CapabilityProbeErrorCode (falling back to "unknown").
 * - `detail` is preserved ONLY when it is a string from backend rejections/payloads.
 * - `exitCode` is preserved ONLY when it is a safe integer within i32 bounds.
 * - `inspected` is preserved ONLY when it is a valid InspectedCandidate array.
 * - Does not invent user-facing English sentences or freeze local Error messages into detail.
 */
export function normalizeCapabilityProbeError(error: unknown): CapabilityProbeError {
  if (error instanceof CapabilityProbeError) {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;

    const code: CapabilityProbeErrorCode = isCapabilityProbeErrorCode(candidate.code)
      ? candidate.code
      : "unknown";

    const detail = typeof candidate.detail === "string" ? candidate.detail : undefined;

    const exitCode = isI32(candidate.exitCode) ? candidate.exitCode : undefined;

    const inspected = isInspectedCandidateArray(candidate.inspected)
      ? candidate.inspected
      : undefined;

    return new CapabilityProbeError({
      code,
      detail,
      exitCode,
      inspected,
    });
  }

  if (typeof error === "string" && error.length > 0) {
    return new CapabilityProbeError({
      code: "unknown",
      detail: error,
    });
  }

  return new CapabilityProbeError({ code: "unknown" });
}
