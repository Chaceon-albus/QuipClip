/**
 * Pure parsers of the replies and the channel messages of the download of FFmpeg (ADR 059).
 *
 * Each parser refuses a value of the wrong shape and an error name that it does not know, with a
 * null result. No parser throws.
 */

import { isLicenseFlags } from "../validation";
import {
  FFMPEG_INSTALL_ERROR_CODES,
  FFMPEG_INSTALL_PHASES,
  FfmpegInstallError,
  type FfmpegDownloadOffer,
  type FfmpegInstallEnd,
  type FfmpegInstallProgress,
  type FfmpegInstallRustErrorCode,
  type FfmpegInstallStarted,
} from "./types";

const ERROR_CODES: ReadonlySet<string> = new Set(FFMPEG_INSTALL_ERROR_CODES);
const PHASES: ReadonlySet<string> = new Set(FFMPEG_INSTALL_PHASES);

/** One channel message, sorted by its kind. */
export type FfmpegInstallMessage =
  | { readonly kind: "progress"; readonly progress: FfmpegInstallProgress }
  | { readonly kind: "end"; readonly end: FfmpegInstallEnd }
  | { readonly kind: "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The error object of Rust, or null when it has no known name. */
export function parseFfmpegInstallErrorObject(error: unknown): {
  readonly code: FfmpegInstallRustErrorCode;
  readonly detail: string | null;
} | null {
  if (
    !isRecord(error) ||
    typeof error.code !== "string" ||
    !ERROR_CODES.has(error.code)
  ) {
    return null;
  }
  const { detail } = error;
  if (detail !== undefined && detail !== null && typeof detail !== "string") {
    return null;
  }
  return {
    code: error.code as FfmpegInstallRustErrorCode,
    detail: detail ?? null,
  };
}

/**
 * The offer of `ffmpeg_download_offer`, or null when the value does not have its shape. The
 * reply null, which means "no offer", is the caller's to test first.
 */
export function parseFfmpegDownloadOffer(reply: unknown): FfmpegDownloadOffer | null {
  if (
    !isRecord(reply) ||
    typeof reply.version !== "string" ||
    reply.version === "" ||
    typeof reply.source !== "string" ||
    reply.source === "" ||
    !isLicenseFlags(reply.license) ||
    !isCount(reply.downloadSize) ||
    reply.downloadSize === 0 ||
    typeof reply.directory !== "string" ||
    reply.directory === "" ||
    typeof reply.replaces !== "boolean"
  ) {
    return null;
  }
  const { gpl, nonfree, version3 } = reply.license;
  return {
    version: reply.version,
    source: reply.source,
    license: { gpl, nonfree, version3 },
    downloadSize: reply.downloadSize,
    directory: reply.directory,
    replaces: reply.replaces,
  };
}

/** The reply of `start_ffmpeg_install`, or null when it does not have its shape. */
export function parseFfmpegInstallStarted(reply: unknown): FfmpegInstallStarted | null {
  if (!isRecord(reply) || !isCount(reply.jobId) || reply.jobId === 0) {
    return null;
  }
  return { jobId: reply.jobId };
}

/**
 * A progress message, or null when the message does not have its shape. The download carries
 * its byte counts, and each other step carries none.
 */
export function parseFfmpegInstallProgress(
  message: unknown,
): FfmpegInstallProgress | null {
  if (
    !isRecord(message) ||
    message.type !== "progress" ||
    typeof message.phase !== "string" ||
    !PHASES.has(message.phase)
  ) {
    return null;
  }
  const phase = message.phase as FfmpegInstallProgress["phase"];
  const { received, total } = message;
  if (phase === "download") {
    if (!isCount(received) || !isCount(total) || received > total) {
      return null;
    }
    return { phase, received, total };
  }
  if (received !== undefined || total !== undefined) {
    return null;
  }
  return { phase, received: null, total: null };
}

/**
 * An end message, or null when the message does not have its shape. A failed end must carry a
 * known error, and an end that did not fail must carry none.
 */
export function parseFfmpegInstallEnd(message: unknown): FfmpegInstallEnd | null {
  if (!isRecord(message) || message.type !== "end") {
    return null;
  }
  switch (message.outcome) {
    case "installed":
    case "canceled":
      return message.error === undefined ? { outcome: message.outcome } : null;
    case "failed": {
      const error = parseFfmpegInstallErrorObject(message.error);
      return error === null ? null : { outcome: "failed", ...error };
    }
    default:
      return null;
  }
}

/** Sorts one channel message. A message of no known shape is `invalid`. */
export function parseFfmpegInstallMessage(message: unknown): FfmpegInstallMessage {
  const progress = parseFfmpegInstallProgress(message);
  if (progress !== null) {
    return { kind: "progress", progress };
  }
  const end = parseFfmpegInstallEnd(message);
  if (end !== null) {
    return { kind: "end", end };
  }
  return { kind: "invalid" };
}

/**
 * The error of a rejected command, as an FfmpegInstallError. A rejection with no known name
 * becomes `commandExecutionFailed`, with its text as the detail.
 */
export function toFfmpegInstallError(error: unknown): FfmpegInstallError {
  if (error instanceof FfmpegInstallError) {
    return error;
  }
  const parsed = parseFfmpegInstallErrorObject(error);
  if (parsed !== null) {
    return new FfmpegInstallError(parsed.code, parsed.detail);
  }
  return new FfmpegInstallError(
    "commandExecutionFailed",
    error instanceof Error ? error.message : String(error),
  );
}
