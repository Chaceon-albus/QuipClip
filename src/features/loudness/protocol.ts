/**
 * Pure parsers of the replies and the channel messages of the measurement of loudness (ADR 061).
 *
 * Each parser accepts exactly the shape that Rust sends (`ffmpeg/loudness/job.rs` and
 * `commands/loudness.rs`), and refuses every other shape and every error name that it does not
 * know, with a null result. No parser throws.
 */

import { BACKEND_EXPORT_ERROR_CODES } from "@/features/export/types";
import {
  LOUDNESS_RUN_ERROR_CODES,
  LOUDNESS_START_ERROR_CODES,
  LoudnessError,
  type LoudnessEnd,
  type LoudnessEndErrorCode,
  type LoudnessProgress,
  type LoudnessStarted,
  type LoudnessStartErrorCode,
} from "./types";

const START_ERROR_CODES: ReadonlySet<string> = new Set(LOUDNESS_START_ERROR_CODES);
// A canceled measurement ends with the status `canceled`, never with the code.
const END_ERROR_CODES: ReadonlySet<string> = new Set<string>(
  [...BACKEND_EXPORT_ERROR_CODES, ...LOUDNESS_RUN_ERROR_CODES].filter(
    (code) => code !== "canceled",
  ),
);

const PROGRESS_KEYS = ["readUs", "totalUs", "type"];
const END_KEYS = ["code", "detail", "integratedLufs", "status", "truePeakDbtp", "type"];

/** One channel message, sorted by its kind. */
export type LoudnessMessage =
  | { readonly kind: "progress"; readonly progress: LoudnessProgress }
  | { readonly kind: "end"; readonly end: LoudnessEnd }
  | { readonly kind: "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `record` has exactly the keys `keys`, which are sorted. */
function hasKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A finite number, null, or undefined when the value is neither. */
function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A string, null, or undefined when the value is neither. */
function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

/** A progress message, or null when the message does not have its shape. */
export function parseLoudnessProgress(message: unknown): LoudnessProgress | null {
  if (
    !isRecord(message) ||
    !hasKeys(message, PROGRESS_KEYS) ||
    message.type !== "progress" ||
    !isCount(message.readUs) ||
    !isCount(message.totalUs)
  ) {
    return null;
  }
  return { readUs: message.readUs, totalUs: message.totalUs };
}

/**
 * An end message, or null when the message does not have its shape. Rust writes each key, with
 * null where it has no value. A failed end carries a known code and no values. A complete end
 * carries its values and no code and no diagnostic. A canceled end carries nothing.
 */
export function parseLoudnessEnd(message: unknown): LoudnessEnd | null {
  if (!isRecord(message) || !hasKeys(message, END_KEYS) || message.type !== "end") {
    return null;
  }
  const code = stringOrNull(message.code);
  const detail = stringOrNull(message.detail);
  const integratedLufs = finiteOrNull(message.integratedLufs);
  const truePeakDbtp = finiteOrNull(message.truePeakDbtp);
  if (
    code === undefined ||
    detail === undefined ||
    integratedLufs === undefined ||
    truePeakDbtp === undefined
  ) {
    return null;
  }
  const noValues = integratedLufs === null && truePeakDbtp === null;
  switch (message.status) {
    case "complete":
      return code === null && detail === null
        ? { status: "complete", integratedLufs, truePeakDbtp }
        : null;
    case "canceled":
      return code === null && detail === null && noValues
        ? { status: "canceled" }
        : null;
    case "failed":
      return code !== null && END_ERROR_CODES.has(code) && noValues
        ? { status: "failed", code: code as LoudnessEndErrorCode, detail }
        : null;
    default:
      return null;
  }
}

/** Sorts one channel message. A message of no known shape is `invalid`. */
export function parseLoudnessMessage(message: unknown): LoudnessMessage {
  const progress = parseLoudnessProgress(message);
  if (progress !== null) {
    return { kind: "progress", progress };
  }
  const end = parseLoudnessEnd(message);
  if (end !== null) {
    return { kind: "end", end };
  }
  return { kind: "invalid" };
}

/** The reply of `start_loudness_measurement`, or null when it does not have its shape. */
export function parseLoudnessStarted(reply: unknown): LoudnessStarted | null {
  if (
    !isRecord(reply) ||
    !hasKeys(reply, ["jobId"]) ||
    !isCount(reply.jobId) ||
    reply.jobId === 0
  ) {
    return null;
  }
  return { jobId: reply.jobId };
}

/**
 * The error that `start_loudness_measurement` rejected with, or null when it has no known name.
 * Rust leaves out `detail` when it has none.
 */
export function parseLoudnessStartError(
  error: unknown,
): { readonly code: LoudnessStartErrorCode; readonly detail: string | null } | null {
  if (
    !isRecord(error) ||
    typeof error.code !== "string" ||
    !START_ERROR_CODES.has(error.code)
  ) {
    return null;
  }
  const keys = Object.keys(error).sort();
  const known = keys.every((key) => key === "code" || key === "detail");
  if (!known) {
    return null;
  }
  if (!("detail" in error)) {
    return { code: error.code as LoudnessStartErrorCode, detail: null };
  }
  if (typeof error.detail !== "string") {
    return null;
  }
  return { code: error.code as LoudnessStartErrorCode, detail: error.detail };
}

/** The error of a command, as a LoudnessError. */
export function toLoudnessError(error: unknown): LoudnessError {
  if (error instanceof LoudnessError) {
    return error;
  }
  const parsed = parseLoudnessStartError(error);
  if (parsed !== null) {
    return new LoudnessError(parsed.code, parsed.detail);
  }
  return new LoudnessError(
    "commandExecutionFailed",
    error instanceof Error ? error.message : String(error),
  );
}
