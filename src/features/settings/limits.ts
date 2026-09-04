/**
 * Frontend preset limits and per-field validation rules matching Rust settings bounds.
 *
 * Implements defensive checks for preset creation and editing per ADR 013.
 * Authoritative backend source: src-tauri/src/settings/mod.rs.
 */

import type { Preset, QualityKind } from "./types";

/**
 * Maximum number of export presets allowed in settings.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_PRESETS).
 */
export const MAX_PRESETS = 100;

/**
 * Maximum preset display name length in Unicode code points.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_PRESET_NAME_CHARS).
 */
export const MAX_PRESET_NAME_CHARS = 120;

/**
 * Minimum resolution dimension in pixels for custom resolution width or height.
 * Authoritative source: src-tauri/src/settings/mod.rs.
 */
export const MIN_RESOLUTION_DIMENSION = 1;

/**
 * Maximum resolution dimension in pixels for custom resolution width or height.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_RESOLUTION_DIMENSION).
 */
export const MAX_RESOLUTION_DIMENSION = 16_384;

/**
 * Maximum encoder name length in Unicode code points.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_ENCODER_NAME_CHARS).
 */
export const MAX_ENCODER_NAME_CHARS = 64;

/**
 * Minimum encoder name length in Unicode code points.
 * Authoritative source: src-tauri/src/settings/mod.rs.
 */
export const MIN_ENCODER_NAME_CHARS = 1;

/**
 * Regular expression validating encoder name character set and start pattern.
 * Encoder names must start with an alphanumeric character and contain only [0-9A-Za-z_.-].
 * Authoritative source: src-tauri/src/settings/mod.rs (is_valid_encoder_name).
 */
export const ENCODER_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z_.-]*$/;

/**
 * Permissible numeric ranges for preset quality configurations by QualityKind.
 * Authoritative source: src-tauri/src/settings/mod.rs (is_valid_quality).
 */
export const QUALITY_RANGES: Record<QualityKind, { min: number; max: number }> = {
  crf: { min: 0, max: 63 },
  bitrate: { min: 1, max: 200_000 }, // kilobits per second
  qualityScale: { min: 1, max: 100 },
};

/**
 * Default numeric value written when the user switches the quality kind to a given kind.
 * Each value sits inside its own `QUALITY_RANGES` entry (see limits.test.ts), so switching
 * kind never carries a stale number out of range: a crf of 20 read as a bitrate would mean
 * 20 kbit/s, and a bitrate of 8000 read as a crf would be out of range and need clearing by
 * hand.
 */
const DEFAULT_QUALITY_VALUES: Record<QualityKind, number> = {
  crf: 20,
  bitrate: 8000,
  qualityScale: 50,
};

/**
 * Returns the default numeric value for the given quality kind.
 */
export function defaultQualityValue(kind: QualityKind): number {
  return DEFAULT_QUALITY_VALUES[kind];
}

export type PresetFieldName =
  "name" | "videoEncoder" | "audioEncoder" | "quality" | "resolution" | "frameRate";

export type PresetFieldIssueCode =
  "required" | "tooLong" | "charset" | "outOfRange" | "notInteger" | "positive";

export type PresetFieldIssue = {
  field: PresetFieldName;
  code: PresetFieldIssueCode;
  values?: Record<string, string | number>;
};

/**
 * Checks whether an encoder name satisfies character set, starting character, and length constraints.
 *
 * Counts Unicode code points rather than UTF-16 code units to match Rust chars().count().
 * Does not trim whitespace: leading or trailing spaces are invalid characters.
 * Authoritative source: src-tauri/src/settings/mod.rs (is_valid_encoder_name).
 */
export function isValidEncoderName(name: string): boolean {
  const codePointCount = [...name].length;
  if (
    codePointCount < MIN_ENCODER_NAME_CHARS ||
    codePointCount > MAX_ENCODER_NAME_CHARS
  ) {
    return false;
  }
  return ENCODER_NAME_PATTERN.test(name);
}

/**
 * Checks whether another preset can be added without exceeding MAX_PRESETS.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_PRESETS).
 */
export function canAddPreset(presetCount: number): boolean {
  return presetCount < MAX_PRESETS;
}

/**
 * Validates the fields of an individual export preset, returning issues in fixed field order.
 *
 * Order: name, videoEncoder, audioEncoder, quality, resolution, frameRate.
 * Reports at most one issue per field. Returns [] when all fields are valid.
 * Authoritative source: src-tauri/src/settings/mod.rs (validate_settings).
 */
export function validatePresetFields(preset: Preset): PresetFieldIssue[] {
  const issues: PresetFieldIssue[] = [];

  // 1. name: blank after trim -> required; over MAX_PRESET_NAME_CHARS code points -> tooLong
  const trimmedName = preset.name.trim();
  if (trimmedName.length === 0) {
    issues.push({ field: "name", code: "required" });
  } else if ([...trimmedName].length > MAX_PRESET_NAME_CHARS) {
    issues.push({
      field: "name",
      code: "tooLong",
      values: { max: MAX_PRESET_NAME_CHARS },
    });
  }

  // 2. videoEncoder: blank after trim -> required; !isValidEncoderName(untrimmed) -> charset
  if (preset.videoEncoder.trim().length === 0) {
    issues.push({ field: "videoEncoder", code: "required" });
  } else if (!isValidEncoderName(preset.videoEncoder)) {
    issues.push({ field: "videoEncoder", code: "charset" });
  }

  // 3. audioEncoder: blank after trim -> required; !isValidEncoderName(untrimmed) -> charset
  if (preset.audioEncoder.trim().length === 0) {
    issues.push({ field: "audioEncoder", code: "required" });
  } else if (!isValidEncoderName(preset.audioEncoder)) {
    issues.push({ field: "audioEncoder", code: "charset" });
  }

  // 4. quality: not safe integer -> notInteger; outside range -> outOfRange
  if (!Number.isSafeInteger(preset.quality.value)) {
    issues.push({ field: "quality", code: "notInteger" });
  } else {
    const range = QUALITY_RANGES[preset.quality.kind];
    if (preset.quality.value < range.min || preset.quality.value > range.max) {
      issues.push({
        field: "quality",
        code: "outOfRange",
        values: {
          kind: preset.quality.kind,
          min: range.min,
          max: range.max,
        },
      });
    }
  }

  // 5. resolution: skip "source"; { w, h }: not safe integer -> notInteger; outside bounds -> outOfRange
  if (preset.resolution !== "source") {
    if (
      !Number.isSafeInteger(preset.resolution.w) ||
      !Number.isSafeInteger(preset.resolution.h)
    ) {
      issues.push({ field: "resolution", code: "notInteger" });
    } else if (
      preset.resolution.w < MIN_RESOLUTION_DIMENSION ||
      preset.resolution.w > MAX_RESOLUTION_DIMENSION ||
      preset.resolution.h < MIN_RESOLUTION_DIMENSION ||
      preset.resolution.h > MAX_RESOLUTION_DIMENSION
    ) {
      issues.push({
        field: "resolution",
        code: "outOfRange",
        values: {
          min: MIN_RESOLUTION_DIMENSION,
          max: MAX_RESOLUTION_DIMENSION,
        },
      });
    }
  }

  // 6. frameRate: skip "source"; { n, d }: not safe integer -> notInteger; n <= 0 || d <= 0 -> positive
  if (preset.frameRate !== "source") {
    if (
      !Number.isSafeInteger(preset.frameRate.n) ||
      !Number.isSafeInteger(preset.frameRate.d)
    ) {
      issues.push({ field: "frameRate", code: "notInteger" });
    } else if (preset.frameRate.n <= 0 || preset.frameRate.d <= 0) {
      issues.push({ field: "frameRate", code: "positive" });
    }
  }

  return issues;
}
