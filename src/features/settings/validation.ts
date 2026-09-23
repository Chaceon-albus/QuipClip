/**
 * Validation and normalization utilities for application settings payloads and errors.
 *
 * Implements defensive boundary checks matching Rust wire types and ADR 013.
 */

import type { Rational } from "@/types/project";
import {
  AUDIO_CHANNEL_SETTINGS,
  BACKEND_SETTINGS_ERROR_CODES,
  PRESET_CONTAINERS,
  QUALITY_KINDS,
  SETTINGS_ERROR_CODES,
  SETTINGS_SCHEMA_VERSION,
  SettingsError,
  type BackendSettingsErrorCode,
  type LoadSettingsResult,
  type Preset,
  type PresetAudioChannels,
  type PresetAudioSampleRate,
  type PresetContainer,
  type PresetFrameRate,
  type PresetQuality,
  type PresetResolution,
  type QualityKind,
  type Settings,
  type SettingsErrorCode,
} from "./types";

/**
 * Numeric boundaries matching Rust wire types and JavaScript safe integer limits.
 */
export const U32_MAX = 4_294_967_295;

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
 * Validates whether a value is a valid signed Rational fraction with a positive denominator.
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
 */
export function isPositiveRational(value: unknown): value is Rational {
  return isSignedRational(value) && value.n > 0;
}

/**
 * Checks whether an unknown value is a valid PresetContainer.
 */
export function isPresetContainer(value: unknown): value is PresetContainer {
  return (
    typeof value === "string" &&
    (PRESET_CONTAINERS as readonly string[]).includes(value)
  );
}

/**
 * Checks whether an unknown value is a valid QualityKind.
 */
export function isQualityKind(value: unknown): value is QualityKind {
  return (
    typeof value === "string" && (QUALITY_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Validates whether an unknown value is a valid PresetQuality structure.
 */
export function isPresetQuality(value: unknown): value is PresetQuality {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const q = value as Record<string, unknown>;
  return isQualityKind(q.kind) && isNonNegativeU32(q.value);
}

/**
 * Validates whether an unknown value is a valid PresetResolution ("source" or { w, h }).
 */
export function isPresetResolution(value: unknown): value is PresetResolution {
  if (value === "source") {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return isPositiveU32(r.w) && isPositiveU32(r.h);
}

/**
 * Validates whether an unknown value is a valid PresetFrameRate ("source" or positive Rational).
 */
export function isPresetFrameRate(value: unknown): value is PresetFrameRate {
  if (value === "source") {
    return true;
  }
  return isPositiveRational(value);
}

/**
 * Checks whether an unknown value is a valid PresetAudioChannels setting.
 */
export function isPresetAudioChannels(value: unknown): value is PresetAudioChannels {
  return (
    typeof value === "string" &&
    (AUDIO_CHANNEL_SETTINGS as readonly string[]).includes(value)
  );
}

/**
 * Checks whether an unknown value is a valid PresetAudioSampleRate setting.
 */
export function isPresetAudioSampleRate(
  value: unknown,
): value is PresetAudioSampleRate {
  return value === "source" || isNonNegativeU32(value);
}

/**
 * Validates whether an unknown value is a valid Preset structure.
 */
export function isPreset(value: unknown): value is Preset {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    p.id.trim().length > 0 &&
    typeof p.name === "string" &&
    p.name.trim().length > 0 &&
    isPresetContainer(p.container) &&
    typeof p.videoEncoder === "string" &&
    p.videoEncoder.trim().length > 0 &&
    typeof p.audioEncoder === "string" &&
    p.audioEncoder.trim().length > 0 &&
    (p.audioBitrate === undefined || isNonNegativeU32(p.audioBitrate)) &&
    isPresetAudioSampleRate(p.audioSampleRate) &&
    isPresetAudioChannels(p.audioChannels) &&
    isPresetQuality(p.quality) &&
    isPresetResolution(p.resolution) &&
    isPresetFrameRate(p.frameRate)
  );
}

/**
 * Validates whether an unknown value is a valid Settings document.
 * Tolerates a dangling activePresetId that names no preset so that hand-edited files
 * do not fail initial boundary validation; store normalization handles cleanup.
 */
export function isSettings(value: unknown): value is Settings {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const s = value as Record<string, unknown>;
  if (s.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return false;
  }
  // `revision` is REQUIRED, not optional: Rust always serializes the key, so a document
  // without it is not a document this build wrote. Accepting it as absent would let a
  // document with no compare-and-swap token through, and the save built on it would either
  // be refused or compare a revision nothing wrote (ADR 013).
  if (!isNonNegativeU32(s.revision)) {
    return false;
  }
  if (s.ffmpegPath !== undefined && typeof s.ffmpegPath !== "string") {
    return false;
  }
  if (!Array.isArray(s.presets) || !s.presets.every(isPreset)) {
    return false;
  }
  if (s.activePresetId !== undefined && typeof s.activePresetId !== "string") {
    return false;
  }
  return true;
}

/**
 * Validates whether an unknown value is a valid LoadSettingsResult structure.
 */
export function isLoadSettingsResult(value: unknown): value is LoadSettingsResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return isSettings(r.settings) && typeof r.seeded === "boolean";
}

/**
 * Checks whether an unknown value is a valid BackendSettingsErrorCode.
 */
export function isBackendSettingsErrorCode(
  value: unknown,
): value is BackendSettingsErrorCode {
  return (
    typeof value === "string" &&
    (BACKEND_SETTINGS_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Checks whether an unknown value is a valid SettingsErrorCode.
 */
export function isSettingsErrorCode(value: unknown): value is SettingsErrorCode {
  return (
    typeof value === "string" &&
    (SETTINGS_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Validates an unknown payload against the Settings schema.
 * Throws a TypeError if the payload does not conform to the expected shape.
 */
export function validateSettings(value: unknown): Settings {
  if (!isSettings(value)) {
    throw new TypeError(
      "Invalid settings document: payload must match Settings schema",
    );
  }
  return value;
}

/**
 * Validates an unknown payload against the LoadSettingsResult schema.
 * Throws a TypeError if the payload does not conform to the expected shape.
 */
export function validateLoadSettingsResult(value: unknown): LoadSettingsResult {
  if (!isLoadSettingsResult(value)) {
    throw new TypeError(
      "Invalid load settings result: payload must match LoadSettingsResult schema",
    );
  }
  return value;
}

/**
 * Validates and normalizes any rejected value or error payload into a safe SettingsError instance.
 *
 * Guarantees:
 * - The error code is always a recognized SettingsErrorCode, falling back to "unknown".
 * - `detail` survives ONLY when it is a string from backend rejections/payloads.
 * - `field` and `value` survive ONLY when they are strings.
 * - `foundSchemaVersion` / `supportedSchemaVersion` survive ONLY when they are safe non-negative integers.
 * - It NEVER invents an English sentence, and NEVER freezes a local Error's message into `detail`.
 * - A plain-string rejection becomes `{ code: "unknown", detail: <the string> }`.
 */
export function normalizeSettingsError(error: unknown): SettingsError {
  if (error instanceof SettingsError) {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;

    const code: SettingsErrorCode = isSettingsErrorCode(candidate.code)
      ? candidate.code
      : "unknown";

    const detail = typeof candidate.detail === "string" ? candidate.detail : undefined;

    const field = typeof candidate.field === "string" ? candidate.field : undefined;

    const value = typeof candidate.value === "string" ? candidate.value : undefined;

    const foundSchemaVersion =
      typeof candidate.foundSchemaVersion === "number" &&
      Number.isSafeInteger(candidate.foundSchemaVersion) &&
      candidate.foundSchemaVersion >= 0
        ? candidate.foundSchemaVersion
        : undefined;

    const supportedSchemaVersion =
      typeof candidate.supportedSchemaVersion === "number" &&
      Number.isSafeInteger(candidate.supportedSchemaVersion) &&
      candidate.supportedSchemaVersion >= 0
        ? candidate.supportedSchemaVersion
        : undefined;

    return new SettingsError({
      code,
      detail,
      field,
      value,
      foundSchemaVersion,
      supportedSchemaVersion,
    });
  }

  if (typeof error === "string" && error.length > 0) {
    return new SettingsError({
      code: "unknown",
      detail: error,
    });
  }

  return new SettingsError({ code: "unknown" });
}
