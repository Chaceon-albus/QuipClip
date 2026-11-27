/**
 * Wire types of the project file commands `load_project` and `save_project` (ADR 010, ADR 072).
 */

import type { Project } from "@/types/project";

/**
 * Error codes returned by the Rust project commands (`ProjectCommandErrorCode` in
 * `src-tauri/src/commands/project.rs`).
 */
export const BACKEND_PROJECT_COMMAND_ERROR_CODES = [
  "invalidPath",
  "pathNotFound",
  "pathNotFile",
  "pathNotUnicode",
  "permissionDenied",
  "readFailed",
  "writeFailed",
  "invalidJson",
  "invalidProject",
  "unsafeProjectValue",
  "futureSchemaVersion",
  "tooLarge",
  "commandExecutionFailed",
] as const;

export type BackendProjectCommandErrorCode =
  (typeof BACKEND_PROJECT_COMMAND_ERROR_CODES)[number];

/**
 * Every error code of a project command, with the fallback `unknown` for a rejection that names
 * no known code and for an answer of the wrong shape, as the media client does.
 */
export const PROJECT_COMMAND_ERROR_CODES = [
  ...BACKEND_PROJECT_COMMAND_ERROR_CODES,
  "unknown",
] as const;

export type ProjectCommandErrorCode = (typeof PROJECT_COMMAND_ERROR_CODES)[number];

/**
 * A failure of `load_project` or `save_project`, with a stable code and the untranslated facts
 * of the backend.
 */
export class ProjectCommandError extends Error {
  /** Stable semantic error code for localization and error classification. */
  readonly code: ProjectCommandErrorCode;
  /** Optional raw diagnostic text from the operating system. */
  readonly detail?: string;
  /** The field of the document that the error names, such as `sources[0].fingerprint`. */
  readonly field?: string;
  /** The value of that field, for an unsafe integer. */
  readonly value?: string;
  /** The schema version of the file, for a schema that is newer than this build reads. */
  readonly foundSchemaVersion?: number;
  /** The schema version that this build reads. */
  readonly supportedSchemaVersion?: number;

  constructor(options: {
    code: ProjectCommandErrorCode;
    detail?: string;
    field?: string;
    value?: string;
    foundSchemaVersion?: number;
    supportedSchemaVersion?: number;
  }) {
    super(options.detail ? `${options.code}: ${options.detail}` : options.code);
    this.name = "ProjectCommandError";
    this.code = options.code;
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }
    if (options.field !== undefined) {
      this.field = options.field;
    }
    if (options.value !== undefined) {
      this.value = options.value;
    }
    if (options.foundSchemaVersion !== undefined) {
      this.foundSchemaVersion = options.foundSchemaVersion;
    }
    if (options.supportedSchemaVersion !== undefined) {
      this.supportedSchemaVersion = options.supportedSchemaVersion;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The answer of `load_project` (ADR 072). */
export type LoadProjectResult = {
  /** The canonical path of the project file. */
  path: string;
  /** The validated document. */
  project: Project;
  /**
   * The candidate paths of each source, in the order of `project.sources`: the `relPath`
   * resolved against the directory of the project file when the entry has one, and then the
   * `path`. Equal paths appear once.
   */
  candidates: string[][];
};

/** The answer of `save_project` (ADR 072). */
export type SaveProjectResult = {
  /** The canonical path of the written project file. */
  path: string;
};
