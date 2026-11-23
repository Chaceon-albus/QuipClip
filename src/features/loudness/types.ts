/**
 * The wire types of the measurement of loudness of an export (ADR 061).
 *
 * The setup step asks Rust for the integrated loudness and the true peak of the audio that an
 * export would write. `start_loudness_measurement` answers with the id of the job, and the job
 * sends its progress and its end through a Tauri channel.
 */

import type {
  BackendExportErrorCode,
  ExportPiece,
  ExportSource,
  ExportStreams,
} from "@/features/export/types";
import type { Preset } from "@/features/settings/types";

/**
 * The fields of an export request that decide its audio: what a measurement measures. The
 * request has no output path and no audio mode. Rust measures with the encode of the audio and a
 * gain of 0.
 */
export interface LoudnessScope {
  readonly sources: readonly ExportSource[];
  readonly pieces: readonly ExportPiece[];
  readonly segmentCount: number;
  /** The preset of the setup step, whole. Rust reads its rate, channels and frame rate. */
  readonly preset: Preset;
  /** The streams of the export. `videoOnly` writes no audio, and Rust refuses it. */
  readonly streams: ExportStreams;
}

/** The answer of `start_loudness_measurement`. */
export interface LoudnessStarted {
  readonly jobId: number;
}

/** The names of the refusals of `start_loudness_measurement`, as Rust sends them. */
export const LOUDNESS_START_ERROR_CODES = [
  "invalidRequest",
  "busy",
  "superseded",
  "closed",
] as const;

export type LoudnessStartErrorCode = (typeof LOUDNESS_START_ERROR_CODES)[number];

/**
 * The names of the failures of the run of a measurement: the Rust `RunCode`, in its order.
 * `types.test.ts` reads the Rust enum and asserts that this list names the same strings.
 */
export const LOUDNESS_RUN_ERROR_CODES = [
  "spawnFailed",
  "readFailed",
  "decodeFailed",
  "invalidAudio",
  "audioShort",
] as const;

export type LoudnessRunErrorCode = (typeof LOUDNESS_RUN_ERROR_CODES)[number];

/**
 * The code of a failed measurement: a code of the export preparation, with the meaning that it
 * has for an export, or a code of the run.
 */
export type LoudnessEndErrorCode = BackendExportErrorCode | LoudnessRunErrorCode;

/**
 * Every error name that the page can show for a measurement: the names of Rust, and
 * `invalidResponse` for a reply or a message of the wrong shape, and `commandExecutionFailed`
 * for a command that did not reach Rust.
 */
export type LoudnessErrorCode =
  | LoudnessStartErrorCode
  | LoudnessEndErrorCode
  | "invalidResponse"
  | "commandExecutionFailed";

/** A refused command, or a measurement that failed. */
export class LoudnessError extends Error {
  readonly code: LoudnessErrorCode;
  /** Untranslated diagnostic text, such as the last lines of the FFmpeg error output. */
  readonly detail: string | null;

  constructor(code: LoudnessErrorCode, detail: string | null = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "LoudnessError";
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A progress message. Rust sends at most 4 each second. */
export interface LoudnessProgress {
  /** The duration of the audio that the meter read, in microseconds. */
  readonly readUs: number;
  /** The duration of the audio of the export, in microseconds. */
  readonly totalUs: number;
}

/** The values of a measurement. A value is null where the meter gives none, as for silence. */
export interface LoudnessValues {
  /** The integrated loudness in LUFS. */
  readonly integratedLufs: number | null;
  /** The true peak in dBTP, at full precision. */
  readonly truePeakDbtp: number | null;
}

/** The last message of a measurement. */
export type LoudnessEnd =
  | ({ readonly status: "complete" } & LoudnessValues)
  | { readonly status: "canceled" }
  | {
      readonly status: "failed";
      readonly code: LoudnessEndErrorCode | "invalidResponse";
      readonly detail: string | null;
    };
