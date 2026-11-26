/**
 * The wire types of the Export Frame command (ADR 069).
 *
 * The action records its facts when the user starts it, and after the save dialog it sends them
 * with the output path to `export_frame`. Rust answers with the path of the PNG file that it
 * wrote, or refuses with one of the codes below.
 */

import type { Pts } from "@/types/project";

/**
 * The codes of a failed command, as Rust sends them: the Rust `FrameExportErrorCode`, in its
 * order. `types.test.ts` reads the Rust enum and asserts that this list names the same strings.
 */
export const BACKEND_FRAME_EXPORT_ERROR_CODES = [
  "frameExportRunning",
  "appDataUnavailable",
  "workDirectoryUnavailable",
  "outputNotPng",
  "outputPathInvalid",
  "outputDirectoryMissing",
  "outputReadOnly",
  "outputEqualsSource",
  "sourceNotFound",
  "sourceRevisionMismatch",
  "ffmpegPairMissing",
  "sourceProbeFailed",
  "positionInvalid",
  "flvInputUnavailable",
  "outputNotWritable",
  "ffmpegSpawnFailed",
  "ffmpegProcessFailed",
  "ffmpegTimedOut",
  "noFrame",
  "imageCheckFailed",
  "outputRenameFailed",
  "preparationTimedOut",
  "canceled",
  "commandFailed",
] as const;

/**
 * The codes that the page itself gives: the save dialog failed, Rust answered with a value of the
 * wrong shape, or the failure has no code that this page knows.
 */
export const FRONTEND_FRAME_EXPORT_ERROR_CODES = [
  "dialogFailed",
  "invalidResponse",
  "unknown",
] as const;

/** Every code of a failed Export Frame action. Each one has a message in the catalogs. */
export const FRAME_EXPORT_ERROR_CODES = [
  ...BACKEND_FRAME_EXPORT_ERROR_CODES,
  ...FRONTEND_FRAME_EXPORT_ERROR_CODES,
] as const;

export type FrameExportErrorCode = (typeof FRAME_EXPORT_ERROR_CODES)[number];

/** The revision of a source file that the import read (ADR 010). */
export interface FrameExportSourceRevision {
  readonly size: number;
  /** Seconds since the Unix epoch. */
  readonly mtime: number;
}

/** The request of `export_frame`, matching `FrameExportRequestWire` in Rust. */
export interface FrameExportRequest {
  readonly sourcePath: string;
  readonly sourceRevision: FrameExportSourceRevision;
  /** The inferred PTS of the confirmed frame, in the time base of the source (ADR 002). */
  readonly pts: Pts;
  readonly sessionSourcePaths: readonly string[];
  /** The path of the image. It ends in `.png`. */
  readonly outputPath: string;
}

/** The answer of `export_frame`. */
export interface FrameExportDone {
  readonly outputPath: string;
}

/** A failed Export Frame action. */
export interface FrameExportFailure {
  readonly code: FrameExportErrorCode;
  /** The untranslated diagnostic of the failure, such as the end of the stderr of FFmpeg. */
  readonly detail: string | null;
}
