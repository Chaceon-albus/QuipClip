/**
 * Wire types of the recovery commands (ADR 073): `start_recovery`, `list_recovery_offers`,
 * `write_recovery`, `clear_recovery`, `read_recovery`, `discard_recovery` and
 * `finish_restore`. The Rust side is `src-tauri/src/recovery/mod.rs`.
 */

import type { LoadProjectResult, ProjectCommandError } from "@/features/project/types";
import type { Project } from "@/types/project";

/**
 * What `current.json` holds after `write_recovery`, `clear_recovery` or `finish_restore`
 * (`CurrentFile` in Rust).
 *
 * - `written`: the state that this command wrote.
 * - `nothing`: no file.
 * - `notKnown`: a step failed and the backend cannot say, or the process is not the owner.
 */
export const RECOVERY_FILE_STATES = ["written", "nothing", "notKnown"] as const;

export type RecoveryFileState = (typeof RECOVERY_FILE_STATES)[number];

/**
 * How a recovery command ended (`RecoveryStatus` in Rust).
 *
 * - `done`: the command did its work.
 * - `notOwner`: the process is not the owner, or the data directory is not known. The command
 *   changed nothing.
 * - `staleSession`: the token is not the token of the session, or the recovery ended at a
 *   confirmed quit. The command changed nothing.
 * - `refused`: the backend refused the document, by a rule of a project file or by the size
 *   limit. Only `write_recovery` and `finish_restore` answer it.
 * - `failed`: a step failed. `error` says which.
 */
export const RECOVERY_STATUSES = [
  "done",
  "notOwner",
  "staleSession",
  "refused",
  "failed",
] as const;

export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];

/** The statuses of a command that takes no document. */
export type RecoveryStatusWithoutDocument = Exclude<RecoveryStatus, "refused">;

/** Error codes of the Rust recovery commands (`RecoveryErrorCode` in Rust). */
export const BACKEND_RECOVERY_ERROR_CODES = [
  "invalidOfferId",
  "offerNotFound",
  "renameFailed",
  "readFailed",
  "writeFailed",
  "removeFailed",
  "invalidRecoveryFile",
  "unsupportedRecoveryVersion",
  "documentRefused",
  "commandExecutionFailed",
  // `finish_restore` came with no `state` argument. Only an explicit null means "nothing".
  "missingRestoreState",
] as const;

export type BackendRecoveryErrorCode = (typeof BACKEND_RECOVERY_ERROR_CODES)[number];

/**
 * Every error code of a recovery command, with the fallback `unknown` for a rejection of the
 * command and for an answer of the wrong shape.
 */
export const RECOVERY_ERROR_CODES = [
  ...BACKEND_RECOVERY_ERROR_CODES,
  "unknown",
] as const;

export type RecoveryErrorCode = (typeof RECOVERY_ERROR_CODES)[number];

/** A failure of a recovery command, with a stable code and the untranslated facts. */
export class RecoveryCommandError extends Error {
  /** Stable semantic error code for localization and error classification. */
  readonly code: RecoveryErrorCode;
  /** Optional raw diagnostic text from the operating system. */
  readonly detail?: string;
  /**
   * The error of the document, with the codes of the project commands: for `documentRefused`,
   * and for an `invalidRecoveryFile` whose document is the cause.
   */
  readonly project?: ProjectCommandError;

  constructor(options: {
    code: RecoveryErrorCode;
    detail?: string;
    project?: ProjectCommandError;
  }) {
    super(options.detail ? `${options.code}: ${options.detail}` : options.code);
    this.name = "RecoveryCommandError";
    this.code = options.code;
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }
    if (options.project !== undefined) {
      this.project = options.project;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The answer of `start_recovery`. */
export type RecoveryStartResult = {
  /** The token of the recovery session of the page, as a decimal string. */
  token: string;
};

/**
 * The answer of `write_recovery`, `clear_recovery` and `finish_restore`. It has the two facts
 * also when the command failed.
 */
export type RecoveryChangeResult = {
  /** Whether the process is the owner of the recovery. */
  owner: boolean;
  status: RecoveryStatus;
  /** What `current.json` holds after the command. */
  current: RecoveryFileState;
  /** Present for `refused` and `failed`. */
  error?: RecoveryCommandError;
};

/** One offer of the list. */
export type RecoveryOfferSummary = {
  /** The identifier of the offer: 16 lowercase hexadecimal digits. */
  id: string;
  /** The time of the last write of the offer, in milliseconds since the Unix epoch. */
  writtenAtMs: number;
  /** The path of the project file of the work, or its proposed path, or null. */
  projectPath: string | null;
};

/** The answer of `list_recovery_offers`. */
export type RecoveryListResult = {
  owner: boolean;
  status: RecoveryStatusWithoutDocument;
  /**
   * False when the process is not the owner, or when a step failed: the directory could not be
   * read, the rename of a `current.json` failed, or an offer could not be read. It is true
   * exactly for `done`.
   */
  complete: boolean;
  /** The valid offers, the newest first. */
  offers: RecoveryOfferSummary[];
  /** Present for `failed`. */
  error?: RecoveryCommandError;
};

/**
 * The offer that `read_recovery` read. `candidates` has the type of the candidates of
 * `load_project`: one list for each source, here with one path, the `path` of the entry.
 */
export type RecoveredOffer = {
  projectPath: string | null;
  /** The validated document. It has no `relPath`. */
  project: Project;
  candidates: LoadProjectResult["candidates"];
};

/** The answer of `read_recovery`. */
export type RecoveryReadResult = {
  owner: boolean;
  status: RecoveryStatusWithoutDocument;
  /** Present exactly for `done`. */
  offer?: RecoveredOffer;
  /** Present for `failed`. */
  error?: RecoveryCommandError;
};

/** The answer of `discard_recovery`. */
export type RecoveryDiscardResult = {
  owner: boolean;
  status: RecoveryStatusWithoutDocument;
  /** Present for `failed`. */
  error?: RecoveryCommandError;
};

/**
 * The recovery state that `write_recovery` and `finish_restore` send: the document, as a save
 * makes it, and the path of the project file, or its proposed path, or null.
 */
export type RecoveryWork = {
  projectPath: string | null;
  project: Project;
};
