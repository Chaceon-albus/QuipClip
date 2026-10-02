/**
 * The test of a preset on this machine: wire types, payload validation, and the IPC client.
 *
 * Rust runs a short encode with the encoder settings of one preset, through the real muxer
 * (`src-tauri/src/ffmpeg/capabilities/preset_test.rs`), and stores the result for the current
 * FFmpeg binary (`src-tauri/src/commands/preset_test.rs`). The smoke test of ADR 006 encodes
 * with the defaults of each encoder, so a preset whose options this machine cannot take passes
 * it and then fails at export time. A result is information only: it never blocks an export.
 *
 * Every payload goes through a validator before it reaches a store, as for the other command
 * results of this feature.
 */

import { BACKEND_COMMANDS, invokeCommand, type BackendCommand } from "@/lib/ipc";
import type { Preset } from "./types";

/** How a test ended, matching the Rust `PresetTestStatus` enum, in its order. */
export const PRESET_TEST_STATUSES = [
  "passed",
  "passedWithWarnings",
  "failed",
  "timedOut",
] as const;

export type PresetTestStatus = (typeof PRESET_TEST_STATUSES)[number];

/**
 * The largest number of UTF-8 bytes Rust keeps of the reported line (`MAX_LINE_BYTES`). A
 * string of that many bytes holds at most as many UTF-16 code units, so the validator bounds
 * `line.length` with it.
 */
export const MAX_PRESET_TEST_LINE_BYTES = 512;

/** The largest `testedAt` Rust stores, the range of the `probedAt` of a capability report. */
const MAX_TESTED_AT_SECONDS = 4_294_967_295;

/** The result of one test, as `test_preset` returns it and the cache file stores it. */
export type PresetTestResult = {
  status: PresetTestStatus;
  /**
   * The line of the FFmpeg log that explains the status, with the pointer of each log prefix
   * removed, such as `[mp4] [error] Tag hvc1 incompatible with output codec id '27' (avc1)`.
   * Technical text that the interface shows as it is and never translates. Absent for a pass.
   */
  line?: string;
  /** The exit code of a failed run, when the process reported one. */
  exitCode?: number;
  /** When the test ran, in whole seconds since the Unix epoch. */
  testedAt: number;
};

/**
 * The response of `test_preset`: the result, and whether Rust stored it for the current binary.
 *
 * `stored` is false when an export began while the test ran, when the binary has no cache key,
 * and when the cache file could not be written. The window shows such a result, and it does not
 * take it for a stored one: the export setup tests the preset again at its next opening.
 */
export type PresetTestResponse = {
  result: PresetTestResult;
  stored: boolean;
};

/** The stored result of one preset of the settings document. */
export type PresetTestEntry = {
  presetId: string;
  result: PresetTestResult;
};

/** Stable error codes of the two commands, mirroring `PresetTestErrorCode` in Rust. */
export const BACKEND_PRESET_TEST_ERROR_CODES = [
  "appDataUnavailable",
  "invalidPreset",
  "exportRunning",
  "ffmpegPairMissing",
  "ffmpegSpawnFailed",
  "temporaryFileUnavailable",
  "settingsUnreadable",
  "commandExecutionFailed",
] as const;

/** Every code the frontend handles: the backend codes and the fallback `unknown`. */
export const PRESET_TEST_ERROR_CODES = [
  ...BACKEND_PRESET_TEST_ERROR_CODES,
  "unknown",
] as const;

export type PresetTestErrorCode = (typeof PRESET_TEST_ERROR_CODES)[number];

/** A rejection of a preset test command, with its stable code (ADR 011). */
export class PresetTestError extends Error {
  readonly code: PresetTestErrorCode;
  /** The validation message of an invalid preset, or an operating-system diagnostic. */
  declare readonly detail?: string;

  constructor(code: PresetTestErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PresetTestError";
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isPresetTestStatus(value: unknown): value is PresetTestStatus {
  return (
    typeof value === "string" &&
    (PRESET_TEST_STATUSES as readonly string[]).includes(value)
  );
}

function isI32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= -2_147_483_648 &&
    value <= 2_147_483_647
  );
}

function isTestedAt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_TESTED_AT_SECONDS
  );
}

/**
 * Reads one result, or returns null when the value is not one: a known status, an optional
 * non-empty line within the bound, an optional 32-bit exit code, and a valid time. A key that
 * Rust does not write makes the value invalid, as `deny_unknown_fields` does on the Rust side.
 */
export function validatePresetTestResult(value: unknown): PresetTestResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const known = new Set(["status", "line", "exitCode", "testedAt"]);
  if (Object.keys(candidate).some((key) => !known.has(key))) {
    return null;
  }
  const { status, line, exitCode, testedAt } = candidate;
  if (!isPresetTestStatus(status) || !isTestedAt(testedAt)) {
    return null;
  }
  if (
    line !== undefined &&
    (typeof line !== "string" ||
      line.length === 0 ||
      line.length > MAX_PRESET_TEST_LINE_BYTES)
  ) {
    return null;
  }
  if (exitCode !== undefined && !isI32(exitCode)) {
    return null;
  }
  const result: PresetTestResult = { status, testedAt };
  if (line !== undefined) {
    result.line = line;
  }
  if (exitCode !== undefined) {
    result.exitCode = exitCode;
  }
  return result;
}

/** Reads the response of `test_preset`, or returns null when it is not one. */
export function validatePresetTestResponse(value: unknown): PresetTestResponse | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== "result" && key !== "stored")) {
    return null;
  }
  const result = validatePresetTestResult(candidate.result);
  if (result === null || typeof candidate.stored !== "boolean") {
    return null;
  }
  return { result, stored: candidate.stored };
}

/**
 * Reads the result of `preset_test_results`, or returns null when it is not a list of entries
 * with a non-empty preset id and a valid result, each preset at most once.
 */
export function validatePresetTestResults(value: unknown): PresetTestEntry[] | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { results } = value as Record<string, unknown>;
  if (!Array.isArray(results)) {
    return null;
  }
  const entries: PresetTestEntry[] = [];
  const seen = new Set<string>();
  for (const item of results as unknown[]) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const { presetId, result } = item as Record<string, unknown>;
    const validated = validatePresetTestResult(result);
    if (
      typeof presetId !== "string" ||
      presetId.length === 0 ||
      seen.has(presetId) ||
      validated === null
    ) {
      return null;
    }
    seen.add(presetId);
    entries.push({ presetId, result: validated });
  }
  return entries;
}

/**
 * Normalizes any rejection into a `PresetTestError`. A payload with a known code keeps it and
 * its string detail. Anything else, such as the string Tauri rejects with when a command
 * argument does not deserialize, is `unknown` with that text as its detail.
 */
export function normalizePresetTestError(error: unknown): PresetTestError {
  if (error instanceof PresetTestError) {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const { code, detail } = error as Record<string, unknown>;
    const known =
      typeof code === "string" &&
      (PRESET_TEST_ERROR_CODES as readonly string[]).includes(code);
    return new PresetTestError(
      known ? (code as PresetTestErrorCode) : "unknown",
      typeof detail === "string" ? detail : undefined,
    );
  }
  if (typeof error === "string" && error.length > 0) {
    return new PresetTestError("unknown", error);
  }
  return new PresetTestError("unknown");
}

/** The payload of `ffmpeg:preset-tested`: the label of the window whose test stored a result. */
export interface PresetTestedPayload {
  readonly origin: string;
}

/** Reads a `ffmpeg:preset-tested` payload, or returns null when it names no window. */
export function validatePresetTestedPayload(
  value: unknown,
): PresetTestedPayload | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { origin } = value as Record<string, unknown>;
  return typeof origin === "string" && origin.length > 0 ? { origin } : null;
}

/**
 * The decision for each field of a preset: the function that gives the value of a field that
 * reaches the test command, in a form whose JSON does not depend on the order of object keys,
 * or null for a field that does not reach it.
 *
 * The fields that reach it are the fields `build_test_arguments` reads in Rust: the container,
 * the two encoders, the audio bitrate, the sample rate and the channels, the quality, the pixel
 * format, and the two option lists. The id, the name, the resolution and the frame rate do not,
 * so two presets that differ only in those share a result, as they share a cache entry in Rust.
 *
 * The type names every field of `Preset`, the optional ones included, so a new field fails the
 * type check until it gets a decision here, and the decision must follow the Rust command.
 */
const TEST_FIELDS: {
  readonly [Field in keyof Preset]-?: ((preset: Preset) => unknown) | null;
} = {
  id: null,
  name: null,
  container: (preset) => preset.container,
  videoEncoder: (preset) => preset.videoEncoder,
  audioEncoder: (preset) => preset.audioEncoder,
  audioBitrate: (preset) => preset.audioBitrate ?? null,
  audioSampleRate: (preset) => preset.audioSampleRate,
  audioChannels: (preset) => preset.audioChannels,
  quality: (preset) => [preset.quality.kind, preset.quality.value],
  resolution: null,
  frameRate: null,
  pixelFormat: (preset) => preset.pixelFormat,
  videoOptions: (preset) =>
    preset.videoOptions.map((option) => [option.name, option.value]),
  audioOptions: (preset) =>
    preset.audioOptions.map((option) => [option.name, option.value]),
};

/** The fields of a preset that reach the test command, in the order of `TEST_FIELDS`. */
export const PRESET_TEST_FIELDS: readonly (keyof Preset)[] = (
  Object.keys(TEST_FIELDS) as (keyof Preset)[]
).filter((field) => TEST_FIELDS[field] !== null);

/**
 * The text that identifies the test of `preset`: the values of its fields that reach the test
 * command (`TEST_FIELDS`), in a fixed order.
 */
export function presetTestFingerprint(preset: Preset): string {
  return JSON.stringify(
    PRESET_TEST_FIELDS.map((field) => {
      const value = TEST_FIELDS[field];
      return value === null ? null : value(preset);
    }),
  );
}

/** Options of the client functions. A test passes a fake `invoke`. */
export interface PresetTestClientOptions {
  invoke?: <T>(cmd: BackendCommand, args?: Record<string, unknown>) => Promise<T>;
}

/**
 * Invokes `test_preset` with the whole preset, saved or not, and returns the validated response:
 * the result, and whether Rust stored it.
 *
 * @throws PresetTestError when the backend rejects or returns a malformed response.
 */
export async function testPreset(
  preset: Preset,
  options: PresetTestClientOptions = {},
): Promise<PresetTestResponse> {
  const invoke = options.invoke ?? invokeCommand;
  let raw: unknown;
  try {
    raw = await invoke<unknown>(BACKEND_COMMANDS.TEST_PRESET, { preset });
  } catch (error) {
    throw normalizePresetTestError(error);
  }
  const response = validatePresetTestResponse(raw);
  if (response === null) {
    throw new PresetTestError("unknown", "malformed preset test response");
  }
  return response;
}

/**
 * Invokes `preset_test_results` and returns the stored results of the presets of the settings
 * document, on the current binary.
 *
 * @throws PresetTestError when the backend rejects or returns a malformed result.
 */
export async function presetTestResults(
  options: PresetTestClientOptions = {},
): Promise<PresetTestEntry[]> {
  const invoke = options.invoke ?? invokeCommand;
  let raw: unknown;
  try {
    raw = await invoke<unknown>(BACKEND_COMMANDS.PRESET_TEST_RESULTS);
  } catch (error) {
    throw normalizePresetTestError(error);
  }
  const entries = validatePresetTestResults(raw);
  if (entries === null) {
    throw new PresetTestError("unknown", "malformed preset test results");
  }
  return entries;
}
