/**
 * The wire types of the download of FFmpeg (ADR 059).
 *
 * The Settings window asks Rust whether it may offer the download, starts the install, and reads
 * its progress and its end from a channel. The download, the checks, and the move into
 * `<local_data>/bin` run in Rust.
 */

import type { LicenseFlags } from "../types";

/** What `ffmpeg_download_offer` gives when the FFmpeg tab may offer the download. */
export interface FfmpegDownloadOffer {
  readonly version: string;
  /** The host that the consent dialog names. */
  readonly source: string;
  readonly license: LicenseFlags;
  /** The total size of the archives in bytes. */
  readonly downloadSize: number;
  /** The directory that the install writes, `<local_data>/bin`. */
  readonly directory: string;
  /** True when the install replaces a pair in that directory that fails the version check. */
  readonly replaces: boolean;
}

/** What `start_ffmpeg_install` returns when it accepted the request. */
export interface FfmpegInstallStarted {
  readonly jobId: number;
}

/**
 * The stable error names of the install (ADR 059). They are the `InstallErrorCode` of Rust,
 * in the same order.
 */
export const FFMPEG_INSTALL_ERROR_CODES = [
  "unsupportedTarget",
  "busy",
  "alreadyFound",
  "appDataUnavailable",
  "workDirectoryUnavailable",
  "networkFailed",
  "httpStatus",
  "sizeMismatch",
  "hashMismatch",
  "archiveInvalid",
  "entryMissing",
  "writeFailed",
  "versionCheckFailed",
  "canceled",
  "commandExecutionFailed",
] as const;

export type FfmpegInstallRustErrorCode = (typeof FFMPEG_INSTALL_ERROR_CODES)[number];

/**
 * Every error name that the page can show for the install: the names of Rust, and
 * `invalidResponse` for a reply or a message of the wrong shape.
 */
export type FfmpegInstallErrorCode = FfmpegInstallRustErrorCode | "invalidResponse";

/** A refused command, or an install that failed. */
export class FfmpegInstallError extends Error {
  readonly code: FfmpegInstallErrorCode;
  /** Untranslated diagnostic text, such as the OS error of a failed write (ADR 011). */
  readonly detail: string | null;

  constructor(code: FfmpegInstallErrorCode, detail: string | null = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "FfmpegInstallError";
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The steps of an install, in their order. */
export const FFMPEG_INSTALL_PHASES = [
  "download",
  "extract",
  "check",
  "install",
] as const;

export type FfmpegInstallPhase = (typeof FFMPEG_INSTALL_PHASES)[number];

/** A progress message. Rust sends the download at most 4 times each second. */
export interface FfmpegInstallProgress {
  readonly phase: FfmpegInstallPhase;
  /** The bytes of all the archives so far. Null outside the download. */
  readonly received: number | null;
  /** The total size of the archives. Null outside the download. */
  readonly total: number | null;
}

/** How an install ended. */
export type FfmpegInstallEnd =
  | { readonly outcome: "installed" }
  | { readonly outcome: "canceled" }
  | {
      readonly outcome: "failed";
      readonly code: FfmpegInstallErrorCode;
      readonly detail: string | null;
    };
