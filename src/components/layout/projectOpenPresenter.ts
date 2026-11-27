/**
 * The text of the project dialog (ADR 072, "The open of a project", "The files that the user
 * locates").
 *
 * The dialog follows the store of the open step (`OpenProjectState`): the read of the project
 * file, the check of each file with its count, the list of the files to locate, and the error of
 * an open that failed. Each error and each reason of a row has one complete catalog message
 * (ADR 011). A diagnostic text of the system goes in the details, unchanged, and never in the
 * sentence.
 *
 * The module has no React and no DOM, so the tests need no document. It returns catalog keys and
 * values, and it does not call the i18n runtime.
 */

import type {
  OpenProjectError,
  OpenProjectState,
  OpenSourceRow,
  SourceCheckFailure,
  SourceFact,
} from "@/features/project/openStep";
import { fileNameOfPath } from "@/features/project/paths";
import type {
  ProjectCommandError,
  ProjectCommandErrorCode,
} from "@/features/project/types";
import type { SequenceLoadProblem } from "@/features/timeline/sequenceLoad";

/**
 * The catalog key of the message of each code of `load_project`. A code whose sentence of the
 * save dialog fits an open too reuses that message (`projectSaveError.write`).
 */
export const PROJECT_LOAD_MESSAGE_KEYS = {
  invalidPath: "projectSaveError.write.invalidPath",
  pathNotFound: "projectOpen.error.load.pathNotFound",
  pathNotFile: "projectSaveError.write.pathNotFile",
  pathNotUnicode: "projectSaveError.write.pathNotUnicode",
  permissionDenied: "projectOpen.error.load.permissionDenied",
  readFailed: "projectSaveError.write.readFailed",
  // `load_project` writes nothing, so it does not give this code. The message of the save fits.
  writeFailed: "projectSaveError.write.writeFailed",
  invalidJson: "projectOpen.error.load.invalidJson",
  invalidProject: "projectOpen.error.load.invalidProject",
  unsafeProjectValue: "projectSaveError.write.unsafeProjectValue",
  futureSchemaVersion: "projectOpen.error.load.futureSchemaVersion",
  tooLarge: "projectOpen.error.load.tooLarge",
  commandExecutionFailed: "projectOpen.error.load.commandExecutionFailed",
  unknown: "projectOpen.error.load.unknown",
} as const satisfies Record<ProjectCommandErrorCode, string>;

/**
 * The catalog key of each problem of a document that fails the rules of the sequence before the
 * check of its files (`documentRefused`, open step 4).
 */
export const DOCUMENT_REFUSED_MESSAGE_KEYS = {
  duplicateSource: "projectOpen.error.document.duplicateSource",
  duplicateClip: "projectOpen.error.document.duplicateClip",
  unknownSource: "projectOpen.error.document.unknownSource",
  clipExtentUnknown: "projectOpen.error.document.clipExtentUnknown",
  layoutFailed: "projectOpen.error.document.layoutFailed",
  duplicateSegment: "projectOpen.error.document.duplicateSegment",
  invalidSegmentName: "projectOpen.error.document.invalidSegmentName",
  invalidSegment: "projectOpen.error.document.invalidSegment",
} as const satisfies Record<SequenceLoadProblem["kind"], string>;

/**
 * The catalog key of each problem of the sequence that the files give as they read now
 * (`sequenceRefused`, open step 7). A new probe can give another length than the document has.
 * The identifiers of that sequence are new, and the names of its segments are those of the
 * document, so a problem of an identifier or of a name reuses the message of the document.
 */
export const SEQUENCE_REFUSED_MESSAGE_KEYS = {
  duplicateSource: "projectOpen.error.document.duplicateSource",
  duplicateClip: "projectOpen.error.document.duplicateClip",
  unknownSource: "projectOpen.error.document.unknownSource",
  clipExtentUnknown: "projectOpen.error.sequence.clipExtentUnknown",
  layoutFailed: "projectOpen.error.sequence.layoutFailed",
  duplicateSegment: "projectOpen.error.document.duplicateSegment",
  invalidSegmentName: "projectOpen.error.document.invalidSegmentName",
  invalidSegment: "projectOpen.error.sequence.invalidSegment",
} as const satisfies Record<SequenceLoadProblem["kind"], string>;

/** The catalog key of each fact of a file that does not read as the project says. */
export const SOURCE_FACT_MESSAGE_KEYS = {
  videoStreamIndex: "projectOpen.reason.fact.videoStreamIndex",
  videoTimeBase: "projectOpen.reason.fact.videoTimeBase",
  videoStartPts: "projectOpen.reason.fact.videoStartPts",
  videoEndPts: "projectOpen.reason.fact.videoEndPts",
  audioStream: "projectOpen.reason.fact.audioStream",
} as const satisfies Record<SourceFact, string>;

/** One catalog message, with its named values. */
export interface ProjectOpenMessage {
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

/** The state of one row of the list. */
export type ProjectOpenRowStatus =
  /** The row has a file. `message` says that, with the path when it is another path. */
  | { readonly kind: "found"; readonly message: ProjectOpenMessage }
  /**
   * The row has no file. `reasons` are one or two complete sentences, in this order. `detail` is
   * the diagnostic text of an import that failed, or null.
   */
  | {
      readonly kind: "missing";
      readonly reasons: readonly ProjectOpenMessage[];
      readonly detail: string | null;
    };

/** What one row of the list shows. */
export interface ProjectOpenRowView {
  /** The `id` of the entry, which `locate` of the open step takes. */
  readonly entryId: string;
  /** The name of the file, as the document has it. */
  readonly fileName: string;
  /** The line with the path that the document has. */
  readonly documentPath: ProjectOpenMessage;
  readonly status: ProjectOpenRowStatus;
  /** True when the row shows "Locate…": the row has no file. */
  readonly showsLocate: boolean;
  /** True when "Locate…" can run now: the row has no file, and the step is not busy. */
  readonly canLocate: boolean;
  /** The accessible name of "Locate…", which names the file. */
  readonly locateLabel: ProjectOpenMessage;
}

/** What the project dialog shows. */
export type ProjectOpenView =
  /** The read of the project file. */
  | {
      readonly kind: "loading";
      readonly title: ProjectOpenMessage;
      readonly message: ProjectOpenMessage;
    }
  /** The check of the files. `percent` is the part of the files that the step checked. */
  | {
      readonly kind: "checking";
      readonly title: ProjectOpenMessage;
      readonly message: ProjectOpenMessage;
      readonly percent: number;
    }
  /** The list of the files to locate, with Open and Cancel. */
  | {
      readonly kind: "locating";
      readonly title: ProjectOpenMessage;
      readonly message: ProjectOpenMessage;
      readonly rows: readonly ProjectOpenRowView[];
      /** True when the Open button is available. */
      readonly canOpen: boolean;
    }
  /** The error of the open, with one button that closes the dialog. */
  | {
      readonly kind: "failed";
      readonly title: ProjectOpenMessage;
      readonly message: ProjectOpenMessage;
      /** The diagnostic text of the system for the details, or null for none. */
      readonly detail: string | null;
    };

const TITLE: ProjectOpenMessage = { key: "projectOpen.title" };
const FAILED_TITLE: ProjectOpenMessage = { key: "projectOpen.failedTitle" };
const UNUSABLE: ProjectOpenMessage = { key: "projectOpen.reason.unusable" };

/** A text that is not empty, or null. */
function nonBlank(text: string | undefined): string | null {
  return text !== undefined && text.trim() !== "" ? text : null;
}

/**
 * The diagnostic text of a failure of `load_project`: the text of the system, and the field of
 * the document that the error names, with its value. Each part is untranslated (ADR 011).
 */
function loadDiagnostic(error: ProjectCommandError): string | null {
  const field =
    error.field === undefined
      ? null
      : error.value === undefined
        ? error.field
        : `${error.field}: ${error.value}`;
  const lines = [nonBlank(error.detail), field].filter(
    (line): line is string => line !== null,
  );
  return lines.length === 0 ? null : lines.join("\n");
}

/** The message and the details of an error of the open. */
export function presentOpenError(error: OpenProjectError): {
  readonly message: ProjectOpenMessage;
  readonly detail: string | null;
} {
  switch (error.kind) {
    case "loadFailed":
      return {
        message: { key: PROJECT_LOAD_MESSAGE_KEYS[error.error.code] },
        detail: loadDiagnostic(error.error),
      };
    case "documentRefused":
      return {
        message: { key: DOCUMENT_REFUSED_MESSAGE_KEYS[error.problem.kind] },
        detail: null,
      };
    case "sequenceRefused":
      return {
        message: { key: SEQUENCE_REFUSED_MESSAGE_KEYS[error.problem.kind] },
        detail: null,
      };
    case "entriesDiffer":
      return { message: { key: "projectOpen.error.entriesDiffer" }, detail: null };
  }
}

/** The status of a row that has no file, from its reason. */
function missingStatus(failure: SourceCheckFailure | null): ProjectOpenRowStatus {
  if (failure === null) {
    // The step lists a row with no file only with a reason. A row with neither says absent.
    return {
      kind: "missing",
      reasons: [{ key: "projectOpen.reason.absent" }],
      detail: null,
    };
  }
  switch (failure.kind) {
    case "absent":
      return {
        kind: "missing",
        reasons: [{ key: "projectOpen.reason.absent" }],
        detail: null,
      };
    case "changed":
      return {
        kind: "missing",
        reasons: [{ key: "projectOpen.reason.changed" }],
        detail: null,
      };
    case "importFailed":
      // The message of the import error is a complete sentence of the media catalog.
      return {
        kind: "missing",
        reasons: [UNUSABLE, { key: `mediaError.${failure.error.code}` }],
        detail: nonBlank(failure.error.detail),
      };
    case "readsOtherwise":
      return {
        kind: "missing",
        reasons: [UNUSABLE, { key: SOURCE_FACT_MESSAGE_KEYS[failure.fact] }],
        detail: null,
      };
  }
}

/** What one row shows. While `busy`, "Locate…" is not available. */
export function presentOpenRow(row: OpenSourceRow, busy: boolean): ProjectOpenRowView {
  const found = row.foundPath;
  const status: ProjectOpenRowStatus =
    found === null
      ? missingStatus(row.failure)
      : {
          kind: "found",
          message:
            found === row.documentPath
              ? { key: "projectOpen.row.found" }
              : { key: "projectOpen.row.foundAt", values: { path: found } },
        };
  return {
    entryId: row.entryId,
    fileName: row.fileName,
    documentPath: {
      key: "projectOpen.row.documentPath",
      values: { path: row.documentPath },
    },
    status,
    showsLocate: found === null,
    canLocate: found === null && !busy,
    locateLabel: { key: "projectOpen.row.locateLabel", values: { name: row.fileName } },
  };
}

/**
 * The view of the project dialog for the state of the open step, or null while the dialog is
 * closed. A state with no path of a project file names no file in the read.
 */
export function presentProjectOpen(state: OpenProjectState): ProjectOpenView | null {
  const phase = state.phase;
  switch (phase.kind) {
    case "idle":
      return null;
    case "loading":
      return {
        kind: "loading",
        title: TITLE,
        message:
          state.projectPath === null
            ? { key: "projectOpen.loadingNoName" }
            : {
                key: "projectOpen.loading",
                values: { name: fileNameOfPath(state.projectPath) },
              },
      };
    case "checking": {
      const total = Math.max(phase.total, 1);
      const done = Math.min(Math.max(phase.current - 1, 0), total);
      return {
        kind: "checking",
        title: TITLE,
        message: {
          key:
            phase.stage === "sources"
              ? "projectOpen.checking"
              : "projectOpen.checkingAgain",
          values: { current: phase.current, total: phase.total, name: phase.fileName },
        },
        percent: Math.round((done / total) * 100),
      };
    }
    case "locating":
      return {
        kind: "locating",
        title: TITLE,
        // The line above the list follows the rows.
        message: {
          key: phase.rows.some((row) => row.foundPath === null)
            ? "projectOpen.locateIntro"
            : "projectOpen.locateIntroAllFound",
        },
        rows: phase.rows.map((row) => presentOpenRow(row, phase.busy)),
        canOpen: phase.canOpen && !phase.busy,
      };
    case "failed": {
      const { message, detail } = presentOpenError(phase.error);
      return { kind: "failed", title: FAILED_TITLE, message, detail };
    }
  }
}
