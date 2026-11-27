/**
 * The text of the dialog of a save that failed (ADR 072, "Menus, keys and permissions").
 *
 * Each kind of `ProjectSaveError` has a message, and each code of a `ProjectCommandError` of the
 * write has one. The message is one complete catalog message (ADR 011). A diagnostic text of the
 * system goes in the details of the dialog, unchanged, and never in the sentence.
 *
 * The module has no React and no DOM, so the tests need no document. It returns catalog keys and
 * values, and it does not call the i18n runtime.
 */

import type { ProjectSaveError } from "@/features/project/saveStep";
import type { ProjectCommandErrorCode } from "@/features/project/types";

/** The catalog key of the message of each code of the write (`projectSaveError.write`). */
export const PROJECT_SAVE_WRITE_MESSAGE_KEYS = {
  invalidPath: "projectSaveError.write.invalidPath",
  pathNotFound: "projectSaveError.write.pathNotFound",
  pathNotFile: "projectSaveError.write.pathNotFile",
  pathNotUnicode: "projectSaveError.write.pathNotUnicode",
  permissionDenied: "projectSaveError.write.permissionDenied",
  readFailed: "projectSaveError.write.readFailed",
  writeFailed: "projectSaveError.write.writeFailed",
  invalidJson: "projectSaveError.write.invalidJson",
  invalidProject: "projectSaveError.write.invalidProject",
  unsafeProjectValue: "projectSaveError.write.unsafeProjectValue",
  futureSchemaVersion: "projectSaveError.write.futureSchemaVersion",
  tooLarge: "projectSaveError.write.tooLarge",
  commandExecutionFailed: "projectSaveError.write.commandExecutionFailed",
  unknown: "projectSaveError.write.unknown",
} as const satisfies Record<
  ProjectCommandErrorCode,
  `projectSaveError.write.${string}`
>;

/** The catalog key of the title of the dialog. */
export const PROJECT_SAVE_ERROR_TITLE_KEY = "projectSaveError.title";

/** One catalog message, with its named values. */
export interface ProjectSaveErrorMessage {
  readonly key: string;
  readonly values?: Readonly<Record<string, string>>;
}

/** What the dialog shows for one error. */
export interface ProjectSaveErrorView {
  /** The sentence under the title. */
  readonly message: ProjectSaveErrorMessage;
  /** The diagnostic text of the system for the details of the dialog, or null for none. */
  readonly detail: string | null;
}

/** A text that is not empty, or null. */
function nonBlank(text: string | undefined): string | null {
  return text !== undefined && text.trim() !== "" ? text : null;
}

/** The diagnostic text of a thrown value: a string, or the `message` of an `Error`. */
function diagnosticOf(error: unknown): string | null {
  if (typeof error === "string") {
    return nonBlank(error);
  }
  return error instanceof Error ? nonBlank(error.message) : null;
}

/** The text of the dialog for `error`. */
export function presentProjectSaveError(error: ProjectSaveError): ProjectSaveErrorView {
  switch (error.kind) {
    case "noClip":
      return { message: { key: "projectSaveError.noClip" }, detail: null };
    case "dialogFailed":
      // The text of the dialog plugin is a diagnostic, kept as it is (ADR 011).
      return {
        message: { key: "projectSaveError.dialogFailed" },
        detail: diagnosticOf(error.error),
      };
    case "invalidName":
      return { message: { key: "projectSaveError.invalidName" }, detail: null };
    case "missingSource":
      return { message: { key: "projectSaveError.missingSource" }, detail: null };
    case "documentRefused":
      // ADR 072, Save step 2: the error names the file of the clip that has no length.
      return {
        message:
          error.problem.kind === "clipExtentUnknown" && error.fileName !== null
            ? {
                key: "projectSaveError.clipExtentUnknown",
                values: { fileName: error.fileName },
              }
            : { key: "projectSaveError.documentRefused" },
        detail: null,
      };
    case "writeFailed":
      return {
        message: { key: PROJECT_SAVE_WRITE_MESSAGE_KEYS[error.error.code] },
        detail: nonBlank(error.error.detail),
      };
  }
}
