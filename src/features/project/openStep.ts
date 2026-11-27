/**
 * The open of a project (ADR 072, "The open of a project", "The check of a source", "The files
 * that the user locates" and "What the open changes").
 *
 * The step shows nothing itself. Its store (`OpenProjectState`) holds what the project dialog
 * shows: the progress, the files to locate, and the error. The dialog calls `locate`, `confirm`
 * and `cancel` of the step.
 *
 * Until step 8 the step changes nothing of the sequence, of the project, of the media store and of
 * the audio overrides. Step 8 changes them as one synchronous block. A cancel stops the step at
 * each moment before step 8, and an answer of a command that arrives after it changes nothing.
 * The permission of the web view and the kept fingerprint of a checked file stay after a cancel,
 * as after each import.
 *
 * Only one open step runs at a time: each request takes a turn in the line of the imports (step
 * 1), so a second request waits for the end of the first one, and each import waits too.
 *
 * The restore (ADR 073, "The restore") is the same step with two differences. Step 4 reads the
 * document from an offer through the read function of the request, not with `load_project`, and
 * each source then has one candidate path. Step 8 leaves the project with no file and with the
 * `projectPath` of the offer as its proposed path, and then calls `onRestored` of the request in
 * the same call. The store says that the step is a restore (`mode`).
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  audioOverrideStore,
  type AudioOverrideStore,
} from "@/features/media/audioOverrideStore";
import {
  choosableAudioStreamOf,
  overrideOfStream,
  type AudioStreamOverride,
} from "@/features/media/audioStream";
import {
  importMedia as importMediaCommand,
  readSourceRevision as readSourceRevisionCommand,
} from "@/features/media/client";
import { getGeneratedSourceId } from "@/features/media/sourceIdentity";
import type { MediaSourceRevisionDescriptor } from "@/features/media/sourceIdentity";
import { mediaStore, type MediaStore } from "@/features/media/store";
import type {
  ExpectedRevision,
  ImportMediaError,
  ImportMediaResult,
} from "@/features/media/types";
import { normalizeImportMediaError } from "@/features/media/validation";
import type {
  RecoveryCommandError,
  RecoveryOfferSummary,
  RecoveryReadResult,
} from "@/features/recovery/types";
import { normalizeRecoveryCommandError } from "@/features/recovery/validation";
import { generateClipId, runInImportLine } from "@/features/sequence/importClips";
import { sequencePlayback } from "@/features/sequence/playback";
import type { SequenceSource } from "@/features/timeline/sequence";
import {
  checkSequenceLoad,
  type SequenceLoadProblem,
} from "@/features/timeline/sequenceLoad";
import {
  generateSegmentId,
  timelineStore,
  type TimelineStore,
} from "@/features/timeline/store";
import type { Clip, PersistedSource, Project, SequenceSegment } from "@/types/project";
import { loadProject as loadProjectCommand } from "./client";
import { checkProjectDocument, projectContentOf } from "./document";
import {
  confirmDropContent,
  hasChangesToSaveNow,
  type DropContentAnswer,
} from "./dropContent";
import { directoryOfPath, fileNameOfPath, siblingPath } from "./paths";
import type { ProjectSaveError, ProjectSaveStep } from "./saveStep";
import { projectStore, type ProjectStore } from "./store";
import type { LoadProjectResult, ProjectCommandError } from "./types";
import { normalizeProjectCommandError } from "./validation";

/** A fact of a file that does not read as its entry says (ADR 072, "The check of a source"). */
export type SourceFact =
  | "videoStreamIndex"
  | "videoTimeBase"
  | "videoStartPts"
  | "videoEndPts"
  | "audioStream";

/** Why a candidate file is not the file of its source. */
export type SourceCheckFailure =
  /** The path names no file: `pathNotFound`, `pathNotFile` or `invalidPath`. */
  | { readonly kind: "absent" }
  /** The file is another revision: `revisionMismatch`. The dialog says that the file changed. */
  | { readonly kind: "changed" }
  /** The import failed with another error. The file cannot be used. */
  | { readonly kind: "importFailed"; readonly error: ImportMediaError }
  /** The file does not read as the entry says. The file cannot be used. */
  | { readonly kind: "readsOtherwise"; readonly fact: SourceFact };

/** One row of the list of the project dialog: a source that was not found at its first check. */
export interface OpenSourceRow {
  /** The `id` of the entry in the document, which `locate` takes. */
  readonly entryId: string;
  /** The name of the file of the entry: the last part of its `path`. */
  readonly fileName: string;
  /** The `path` of the entry in the document. */
  readonly documentPath: string;
  /** The path of the file that holds, or null while the row is not found. */
  readonly foundPath: string | null;
  /** The reason while the row is not found, or null when it is found. */
  readonly failure: SourceCheckFailure | null;
}

/** Why an open step does not change the session. */
export type OpenProjectError =
  /** `load_project` failed. */
  | { readonly kind: "loadFailed"; readonly error: ProjectCommandError }
  /**
   * The read of the offer of a restore did not give a document (ADR 073, restore step 4).
   * `error` is the error of the answer, or null for `notOwner` and `staleSession`.
   */
  | {
      readonly kind: "recoveryReadFailed";
      readonly status: "notOwner" | "staleSession" | "failed";
      readonly error: RecoveryCommandError | null;
    }
  /** The document fails the rules of the sequence (step 4, `checkProjectDocument`). */
  | { readonly kind: "documentRefused"; readonly problem: SequenceLoadProblem }
  /**
   * Two entries give the same revision, and they differ in a field other than `id`, `path` and
   * `relPath` ("The check of a source").
   */
  | { readonly kind: "entriesDiffer"; readonly entryIds: readonly [string, string] }
  /** The sequence with the facts of the sources of this session fails its test (step 7). */
  | { readonly kind: "sequenceRefused"; readonly problem: SequenceLoadProblem };

/** What the project dialog shows. */
export type OpenProjectPhase =
  /** No dialog. */
  | { readonly kind: "idle" }
  /** `load_project`, or the read of the offer of a restore, runs. */
  | { readonly kind: "loading" }
  /**
   * The step checks a source: `sources` in step 5, `revisions` in step 7. `current` counts from 1
   * to `total`, and `fileName` names the file of that source.
   */
  | {
      readonly kind: "checking";
      readonly stage: "sources" | "revisions";
      readonly current: number;
      readonly total: number;
      readonly fileName: string;
    }
  /**
   * The list of the files to locate (step 6). `busy` is true while the step checks a located file,
   * and Locate and Open do nothing then. `canOpen` is true when each row is found and nothing is
   * busy: the Open button.
   */
  | {
      readonly kind: "locating";
      readonly rows: readonly OpenSourceRow[];
      readonly busy: boolean;
      readonly canOpen: boolean;
    }
  /** The step stopped with an error. Close of the dialog is `cancel`. */
  | { readonly kind: "failed"; readonly error: OpenProjectError };

/** `open` for the open of a project file, `restore` for the restore of an offer (ADR 073). */
export type OpenProjectMode = "open" | "restore";

/** Public state of the open step store. */
export interface OpenProjectState {
  readonly phase: OpenProjectPhase;
  /**
   * While the dialog shows: the path that the open step received, or the `projectPath` of the
   * offer of a restore. Null otherwise, and for an offer with no path.
   */
  readonly projectPath: string | null;
  /** Whether the step that the dialog shows is an open or a restore. `open` while idle. */
  readonly mode: OpenProjectMode;
}

/** The store of what the project dialog shows. */
export type OpenProjectStore = StoreApi<OpenProjectState>;

const IDLE: OpenProjectState = {
  phase: { kind: "idle" },
  projectPath: null,
  mode: "open",
};

/** Creates a store of what the project dialog shows, in its idle state. */
export function createOpenProjectStore(): OpenProjectStore {
  return createStore<OpenProjectState>()(() => IDLE);
}

/** The result of an open step. */
export type OpenProjectResult =
  /** Step 8 changed the session. */
  | { readonly status: "opened"; readonly path: string }
  /** The user or the quit canceled the step before step 8. */
  | { readonly status: "canceled" }
  /**
   * Another dialog of the window was open at step 2, before the save prompt or after a save that
   * the prompt ran, so the step changed nothing.
   */
  | { readonly status: "blocked" }
  /**
   * The save prompt of step 2 stopped the step. `saveError` is the error of the save that the
   * prompt ran, for the caller to show, or null.
   */
  | { readonly status: "stopped"; readonly saveError: ProjectSaveError | null }
  /** The step failed, and the user closed the dialog that showed the error. */
  | { readonly status: "failed"; readonly error: OpenProjectError };

/** Who canceled an open step or a restore: Cancel of the user, or a request to quit. */
export type OpenCancelReason = "user" | "quit";

/** The result of a restore (ADR 073, "The restore"). */
export type RestoreProjectResult =
  /** Step 8 changed the session, and `onRestored` ran. */
  | { readonly status: "restored" }
  /**
   * A cancel stopped the restore before step 8, or a quit closed its error view. `by` says who
   * canceled it.
   */
  | { readonly status: "canceled"; readonly by: OpenCancelReason }
  /** Another dialog of the window was open at step 2, as for an open. */
  | { readonly status: "blocked" }
  /** The save prompt of step 2 stopped the restore, as for an open. */
  | { readonly status: "stopped"; readonly saveError: ProjectSaveError | null }
  /** The restore failed, and the user closed the dialog that showed the error. */
  | { readonly status: "failed"; readonly error: OpenProjectError };

/** The offer that a restore reads: its `<id>` and its `projectPath` from the list. */
export type RestoreOffer = Pick<RecoveryOfferSummary, "id" | "projectPath">;

/** The functions of the recovery that one restore calls. */
export interface RestoreHooks {
  /**
   * Reads the offer `id` with `read_recovery` and the token of the session (step 4). The recovery
   * controller sends it in its line.
   */
  readonly readRecovery: (id: string) => Promise<RecoveryReadResult>;
  /**
   * Called in step 8, in the same call, after the session changed, with the `<id>` of the offer.
   * The recovery controller puts `finish_restore` in its line there. Never called before step 8.
   */
  readonly onRestored: (id: string) => void;
}

/** The dependencies of the open step. */
export interface ProjectOpenDependencies {
  /** The save step of the page, for step 2 and its save prompt. */
  readonly saveStep: Pick<ProjectSaveStep, "save" | "whenIdle">;
  /** Shows the save prompt (ADR 072, "Before the content is dropped"). */
  readonly ask: () => Promise<DropContentAnswer>;
  /**
   * True while another dialog of the window is open (step 2). The step tests it before the save
   * prompt, and again after a save that the prompt ran.
   */
  readonly isOtherDialogOpen: () => boolean;
  /** The file dialog of the system for "Locate…": one file, or null when the user cancels. */
  readonly pickFile: (defaultDirectory: string | null) => Promise<string | null>;
  /**
   * Makes a waiting open step of the export stale (`staleExportOpenStep`, step 2). The step calls
   * it before the save prompt, and again directly before the project dialog shows.
   */
  readonly staleExportOpenStep: () => void;
  readonly loadProject?: (path: string) => Promise<LoadProjectResult>;
  readonly importMedia?: (
    path: string,
    expected: ExpectedRevision,
  ) => Promise<ImportMediaResult>;
  readonly readSourceRevision?: (
    path: string,
    expected: ExpectedRevision,
  ) => Promise<MediaSourceRevisionDescriptor>;
  readonly timeline?: TimelineStore;
  readonly media?: MediaStore;
  readonly audioOverrides?: AudioOverrideStore;
  readonly project?: ProjectStore;
  /** True when the project has changes to save now. Defaults to `hasChangesToSaveNow`. */
  readonly hasChangesToSave?: () => boolean;
  /** Stops the playback. Defaults to the pause of the sequence playback. */
  readonly pausePlayback?: () => void;
  /** Drops each seek that waits. Defaults to `sequencePlayback.dropNavigation`. */
  readonly dropNavigation?: () => void;
  /**
   * Resets the playback store: a seek that waits, the destination of a pending seek, the target
   * of a replacement of the element and a play intent go, and the element detaches. Defaults to
   * the reset of the sequence playback.
   */
  readonly resetPlayback?: () => void;
  /** Runs a task as one turn in the line of the imports. Defaults to `runInImportLine`. */
  readonly runInImportLine?: <T>(task: () => Promise<T>) => Promise<T>;
  readonly generateClipId?: () => string;
  readonly generateSegmentId?: () => string;
  /** The store of the dialog. Defaults to a new store. */
  readonly store?: OpenProjectStore;
}

/** The open step of a page. */
export interface ProjectOpenStep {
  /** The store of what the project dialog shows. */
  readonly store: OpenProjectStore;
  /** Opens the project file at `path` (steps 1 to 8). */
  readonly open: (path: string) => Promise<OpenProjectResult>;
  /**
   * Restores `offer` (ADR 073, "The restore"): the steps of an open, with the read of the offer
   * through `hooks.readRecovery` in step 4. Step 8 leaves the project with no file and with the
   * `projectPath` of the offer that the read gave as its proposed path, and then calls
   * `hooks.onRestored` with the `<id>` of the offer.
   */
  readonly restore: (
    offer: RestoreOffer,
    hooks: RestoreHooks,
  ) => Promise<RestoreProjectResult>;
  /**
   * "Locate…" of a row: shows the file dialog, and checks the chosen file (`locateFile`). It holds
   * the locate operation from before the dialog until the end of the checks, so another `locate`,
   * `locateFile` or `confirm` does nothing and answers false meanwhile. A dialog that the user
   * cancels, or that fails, releases the hold, and the row stays. Answers true when the row is
   * found afterward, and false when it did nothing or the row is not found.
   */
  readonly locate: (entryId: string) => Promise<boolean>;
  /**
   * Checks `path` as a candidate of the row of `entryId` (step 6). When the file holds, the row is
   * found, and the step tries, for each other row that is not found, the file with the name of
   * that row in the directory of the file. When it does not hold, the row shows the result of that
   * file. Answers true when the row is found afterward, and false when another locate operation
   * holds the step, outside the locating phase, or when the row is not found.
   */
  readonly locateFile: (entryId: string, path: string) => Promise<boolean>;
  /**
   * The Open button: continues with step 7 while `canOpen` is true. Answers false, and does
   * nothing, otherwise, as while a locate operation holds the step.
   */
  readonly confirm: () => boolean;
  /**
   * Cancel of the dialog, and close of the error view. It stops the open step that runs and each
   * request that waits for its turn, before step 8. The quit calls it before it tests the project.
   * `reason` is `user` when absent. A restore that a cancel stopped answers it in its result; an
   * open does not. In the error view of a restore, `quit` gives `canceled` by a quit, and `user`
   * gives `failed`.
   */
  readonly cancel: (reason?: OpenCancelReason) => void;
  /** True while an open step runs before step 8, or a request waits for its turn. */
  readonly isOpening: () => boolean;
}

/** The import errors that say that the path names no file. */
const ABSENT_CODES: ReadonlySet<string> = new Set([
  "pathNotFound",
  "pathNotFile",
  "invalidPath",
]);

/** The result of a failed import or revision read as the failure of a candidate. */
function failureOfError(error: unknown): SourceCheckFailure {
  const normalized = normalizeImportMediaError(error);
  if (ABSENT_CODES.has(normalized.code)) {
    return { kind: "absent" };
  }
  if (normalized.code === "revisionMismatch") {
    return { kind: "changed" };
  }
  return { kind: "importFailed", error: normalized };
}

/** The revision that the entry expects: its size, its time and its fingerprint. */
function expectedOf(entry: PersistedSource): ExpectedRevision {
  const expected: ExpectedRevision = { size: entry.size, mtime: entry.mtime };
  if (entry.fingerprint !== undefined) {
    expected.fingerprint = {
      start: entry.fingerprint.start,
      fnv1a64: entry.fingerprint.fnv1a64,
    };
  }
  return expected;
}

/** A file that holds for its entry: the media of the session and the override of the entry. */
interface HeldSource {
  readonly media: ImportMediaResult;
  readonly override: AudioStreamOverride | undefined;
}

/**
 * Tests whether `media` reads as `entry` says ("The check of a source"), and gives the media that
 * the session takes. For an entry with a fingerprint, the session takes the `videoEndPts` of the
 * entry, and the value of the new probe has no effect.
 */
function readAsEntry(
  entry: PersistedSource,
  media: ImportMediaResult,
): HeldSource | SourceFact {
  const probe = media.probe;
  if (probe.videoStreamIndex !== entry.videoStreamIndex) {
    return "videoStreamIndex";
  }
  if (
    probe.videoTimeBase.n !== entry.videoTimeBase.n ||
    probe.videoTimeBase.d !== entry.videoTimeBase.d
  ) {
    return "videoTimeBase";
  }
  if (probe.videoStartPts !== entry.videoStartPts) {
    return "videoStartPts";
  }
  if (entry.fingerprint === undefined && probe.videoEndPts !== entry.videoEndPts) {
    return "videoEndPts";
  }
  let override: AudioStreamOverride | undefined;
  if (entry.audioStreamIndex !== undefined) {
    const stream = choosableAudioStreamOf(probe, entry.audioStreamIndex);
    if (stream === null) {
      return "audioStream";
    }
    override = overrideOfStream(stream);
  }
  return {
    media:
      entry.fingerprint === undefined
        ? media
        : { ...media, probe: { ...probe, videoEndPts: entry.videoEndPts } },
    override,
  };
}

/** True when two fingerprints, or their absence, are equal. */
function sameFingerprint(a: PersistedSource, b: PersistedSource): boolean {
  return a.fingerprint === undefined || b.fingerprint === undefined
    ? a.fingerprint === b.fingerprint
    : a.fingerprint.start === b.fingerprint.start &&
        a.fingerprint.fnv1a64 === b.fingerprint.fnv1a64;
}

function sameRational(
  a: PersistedSource["avgFrameRate"],
  b: PersistedSource["avgFrameRate"],
): boolean {
  return a === null || b === null ? a === b : a.n === b.n && a.d === b.d;
}

/**
 * True when two entries are equal in each field but `id`, `path` and `relPath` ("The check of a
 * source"): two entries that give one revision must say the same of it.
 */
export function entriesAgree(a: PersistedSource, b: PersistedSource): boolean {
  return (
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.videoStreamIndex === b.videoStreamIndex &&
    sameRational(a.videoTimeBase, b.videoTimeBase) &&
    a.videoStartPts === b.videoStartPts &&
    a.videoEndPts === b.videoEndPts &&
    a.videoDurationTicks === b.videoDurationTicks &&
    a.approximateDurationSeconds === b.approximateDurationSeconds &&
    sameRational(a.avgFrameRate, b.avgFrameRate) &&
    sameRational(a.rFrameRate, b.rFrameRate) &&
    a.reportedFrameCount === b.reportedFrameCount &&
    a.audioStreamIndex === b.audioStreamIndex &&
    sameFingerprint(a, b)
  );
}

/** The sequence source of the media of the session, with its session id. */
function sequenceSourceOf(id: string, media: ImportMediaResult): SequenceSource {
  return {
    id,
    videoTimeBase: { n: media.probe.videoTimeBase.n, d: media.probe.videoTimeBase.d },
    videoStartPts: media.probe.videoStartPts,
    videoEndPts: media.probe.videoEndPts,
    videoDurationTicks: media.probe.videoDurationTicks,
    approximateDurationSeconds: media.probe.approximateDurationSeconds,
  };
}

/** The state of one source of the document that a clip names. */
interface Row {
  readonly entry: PersistedSource;
  readonly candidates: readonly string[];
  /** The file that holds, with the id of the session for its revision, or null. */
  found: (HeldSource & { readonly sourceId: string; readonly located: boolean }) | null;
  failure: SourceCheckFailure | null;
  /** True from the first time the row was not found: the list of the dialog shows it. */
  listed: boolean;
}

/** True when the row has a file. A call, so a check after an await reads the row again. */
function isFound(row: Row): boolean {
  return row.found !== null;
}

/** What the main flow of a step waits for in the locating phase. */
type Action =
  | { readonly kind: "confirm" }
  | { readonly kind: "cancel" }
  | { readonly kind: "failed"; readonly error: OpenProjectError };

/** What a step opens: a project file, or the offer of a restore. */
type OpenSource =
  | { readonly kind: "file"; readonly path: string }
  | {
      readonly kind: "restore";
      readonly offer: RestoreOffer;
      readonly hooks: RestoreHooks;
    };

/** The document of step 4 and the candidate paths of each of its sources. */
interface ReadDocument {
  readonly project: Project;
  readonly candidates: readonly (readonly string[])[];
}

/** The result of step 4: the document, or the error that the dialog shows. */
type ReadOutcome =
  | {
      readonly ok: true;
      readonly document: ReadDocument;
      /** The canonical path of the project file, or the `projectPath` of the offer. */
      readonly path: string | null;
    }
  | { readonly ok: false; readonly error: OpenProjectError };

/** How one step ended. `open` and `restore` give the result of their entry from it. */
type StepOutcome =
  /**
   * Step 8 changed the session. `path` is the canonical path of the project file of an open, and
   * null for a restore.
   */
  | { readonly status: "changed"; readonly path: string | null }
  | { readonly status: "canceled"; readonly by: OpenCancelReason }
  | { readonly status: "blocked" }
  | { readonly status: "stopped"; readonly saveError: ProjectSaveError | null }
  /** `closedBy` says who closed the error view: a cancel of the user, or of a quit. */
  | {
      readonly status: "failed";
      readonly error: OpenProjectError;
      readonly closedBy: OpenCancelReason;
    };

/** One open step from its turn to its end. */
interface Session {
  canceled: boolean;
  /** Who canceled the step, or null while it was not canceled. */
  cancelReason: OpenCancelReason | null;
  busy: boolean;
  rows: Row[];
  /** Settles the wait of the main flow, or null while it does not wait. */
  settle: ((action: Action) => void) | null;
  /** An action that came while the main flow did not wait. */
  queued: Action | null;
  /** Ends the turn of the session at once, for a cancel. */
  stop: (() => void) | null;
}

/** An open request that waits for its turn in the line. */
interface WaitingRequest {
  readonly cancel: (by: OpenCancelReason) => void;
}

/** The canceled outcome of `current`, with the reason of its cancel. */
function canceledOf(current: Session): StepOutcome {
  return { status: "canceled", by: current.cancelReason ?? "user" };
}

/** Creates an open step over the commands and the stores of `dependencies`. */
export function createProjectOpenStep(
  dependencies: ProjectOpenDependencies,
): ProjectOpenStep {
  const store = dependencies.store ?? createOpenProjectStore();
  const timeline = dependencies.timeline ?? timelineStore;
  const media = dependencies.media ?? mediaStore;
  const audioOverrides = dependencies.audioOverrides ?? audioOverrideStore;
  const project = dependencies.project ?? projectStore;
  const loadProject = dependencies.loadProject ?? ((path) => loadProjectCommand(path));
  const importMedia =
    dependencies.importMedia ??
    ((path, expected) => importMediaCommand(path, expected));
  const readSourceRevision =
    dependencies.readSourceRevision ??
    ((path, expected) => readSourceRevisionCommand(path, expected));
  const hasChangesToSave =
    dependencies.hasChangesToSave ??
    (() => hasChangesToSaveNow({ timeline, audioOverrides, project }));
  const pausePlayback =
    dependencies.pausePlayback ?? (() => sequencePlayback.store.getState().pause());
  const dropNavigation =
    dependencies.dropNavigation ?? (() => sequencePlayback.dropNavigation());
  const resetPlayback =
    dependencies.resetPlayback ?? (() => sequencePlayback.store.getState().reset());
  const runTurn = dependencies.runInImportLine ?? runInImportLine;
  const nextClipId = dependencies.generateClipId ?? generateClipId;
  const nextSegmentId = dependencies.generateSegmentId ?? generateSegmentId;

  /** Counts the cancels, so a request that waits for its turn sees a cancel. */
  let epoch = 0;
  const waiting = new Set<WaitingRequest>();
  let session: Session | null = null;

  const alive = (current: Session): boolean => !current.canceled && session === current;

  const publishRows = (current: Session): void => {
    const rows = current.rows
      .filter((row) => row.listed)
      .map((row): OpenSourceRow => ({
        entryId: row.entry.id,
        fileName: fileNameOfPath(row.entry.path),
        documentPath: row.entry.path,
        foundPath: row.found === null ? null : row.found.media.path,
        failure: row.found === null ? row.failure : null,
      }));
    store.setState({
      phase: {
        kind: "locating",
        rows,
        busy: current.busy,
        canOpen: !current.busy && current.rows.every((row) => row.found !== null),
      },
    });
  };

  const signal = (current: Session, action: Action): void => {
    if (current.settle !== null) {
      const settle = current.settle;
      current.settle = null;
      settle(action);
    } else {
      current.queued = action;
    }
  };

  const waitForAction = (current: Session): Promise<Action> => {
    if (current.queued !== null) {
      const action = current.queued;
      current.queued = null;
      return Promise.resolve(action);
    }
    return new Promise((resolve) => {
      current.settle = resolve;
    });
  };

  /** Checks one candidate path of a row. */
  const checkCandidate = async (
    entry: PersistedSource,
    path: string,
  ): Promise<HeldSource | SourceCheckFailure> => {
    let imported: ImportMediaResult;
    try {
      imported = await importMedia(path, expectedOf(entry));
    } catch (error) {
      return failureOfError(error);
    }
    const read = readAsEntry(entry, imported);
    return typeof read === "string" ? { kind: "readsOtherwise", fact: read } : read;
  };

  /**
   * Records the file that holds for `row`. Answers the error when another found row gives the same
   * revision and its entry says another thing of it.
   */
  const recordFound = (
    current: Session,
    row: Row,
    held: HeldSource,
    located: boolean,
  ): OpenProjectError | null => {
    const sourceId = getGeneratedSourceId(held.media);
    if (sourceId === null) {
      row.found = null;
      row.failure = {
        kind: "importFailed",
        error: normalizeImportMediaError(new Error("no revision")),
      };
      return null;
    }
    for (const other of current.rows) {
      if (
        other !== row &&
        other.found !== null &&
        other.found.sourceId === sourceId &&
        !entriesAgree(other.entry, row.entry)
      ) {
        return { kind: "entriesDiffer", entryIds: [other.entry.id, row.entry.id] };
      }
    }
    row.found = {
      media: held.media,
      override: held.override,
      sourceId,
      // A file that the user located at another path makes the project modified.
      located: located && held.media.path !== row.entry.path,
    };
    row.failure = null;
    return null;
  };

  /** Shows the error, and waits for the close of the dialog. */
  const fail = async (
    current: Session,
    error: OpenProjectError,
  ): Promise<StepOutcome> => {
    if (!alive(current)) {
      return canceledOf(current);
    }
    store.setState({ phase: { kind: "failed", error } });
    await waitForAction(current);
    // `cancel` notes its reason before it closes the error view.
    return { status: "failed", error, closedBy: current.cancelReason ?? "user" };
  };

  /** Step 7, first part: each file is its revision again. False when one is not. */
  const verifyRevisions = async (current: Session): Promise<boolean> => {
    let ok = true;
    for (const [index, row] of current.rows.entries()) {
      const found = row.found;
      if (found === null) {
        ok = false;
        continue;
      }
      store.setState({
        phase: {
          kind: "checking",
          stage: "revisions",
          current: index + 1,
          total: current.rows.length,
          fileName: fileNameOfPath(row.entry.path),
        },
      });
      let revision: MediaSourceRevisionDescriptor;
      try {
        revision = await readSourceRevision(found.media.path, expectedOf(row.entry));
      } catch (error) {
        if (!alive(current)) {
          return false;
        }
        row.found = null;
        row.failure = failureOfError(error);
        row.listed = true;
        ok = false;
        continue;
      }
      if (!alive(current)) {
        return false;
      }
      // The canonical path of another file, as a link that names another file now with the same
      // size and time: the file changed.
      if (revision.path !== found.media.path) {
        row.found = null;
        row.failure = { kind: "changed" };
        row.listed = true;
        ok = false;
      }
    }
    return ok;
  };

  /** The sequence that step 8 makes, with new identifiers. */
  const buildSession = (current: Session, loaded: ReadDocument) => {
    const byEntry = new Map(current.rows.map((row) => [row.entry.id, row]));
    const sourceOf = (entryId: string): string =>
      byEntry.get(entryId)?.found?.sourceId ?? "";
    const clipIds = new Map<string, string>();
    const clips: Clip[] = loaded.project.clips.map((clip) => {
      const id = nextClipId();
      clipIds.set(clip.id, id);
      return { id, sourceId: sourceOf(clip.sourceId) };
    });
    const segments: SequenceSegment[] = loaded.project.segments.map((segment) => {
      const copy: SequenceSegment = {
        id: nextSegmentId(),
        inClipId: clipIds.get(segment.inClipId) ?? "",
        inPts: segment.inPts,
        outClipId: clipIds.get(segment.outClipId) ?? "",
        outPts: segment.outPts,
      };
      if (segment.name !== undefined) {
        copy.name = segment.name;
      }
      return copy;
    });
    const mediaSources: Record<string, ImportMediaResult> = {};
    const overrides: Record<string, AudioStreamOverride> = {};
    const sources: SequenceSource[] = [];
    let located = false;
    for (const row of current.rows) {
      const found = row.found;
      if (found === null) {
        continue;
      }
      located ||= found.located;
      if (mediaSources[found.sourceId] === undefined) {
        mediaSources[found.sourceId] = found.media;
        sources.push(sequenceSourceOf(found.sourceId, found.media));
        if (found.override !== undefined) {
          overrides[found.sourceId] = found.override;
        }
      }
    }
    const first = clips[0];
    return {
      clips,
      segments,
      sources,
      mediaSources,
      overrides,
      firstMedia: first === undefined ? null : (mediaSources[first.sourceId] ?? null),
      located,
    };
  };

  /**
   * Step 4 before the tests of the document: `load_project` for a project file, and the read of
   * the offer for a restore (ADR 073). Neither function rejects.
   */
  const readDocument = async (source: OpenSource): Promise<ReadOutcome> => {
    if (source.kind === "file") {
      try {
        const loaded = await loadProject(source.path);
        return {
          ok: true,
          document: { project: loaded.project, candidates: loaded.candidates },
          path: loaded.path,
        };
      } catch (error) {
        return {
          ok: false,
          error: { kind: "loadFailed", error: normalizeProjectCommandError(error) },
        };
      }
    }
    let read: RecoveryReadResult;
    try {
      read = await source.hooks.readRecovery(source.offer.id);
    } catch (error) {
      read = {
        owner: false,
        status: "failed",
        error: normalizeRecoveryCommandError(error),
      };
    }
    if (read.status === "done" && read.offer !== undefined) {
      return {
        ok: true,
        document: { project: read.offer.project, candidates: read.offer.candidates },
        path: read.offer.projectPath,
      };
    }
    // A `done` with no offer does not pass the validation of the client. It counts as a failure.
    const status = read.status === "done" ? "failed" : read.status;
    return {
      ok: false,
      error: {
        kind: "recoveryReadFailed",
        status,
        error:
          status === "failed"
            ? (read.error ?? normalizeRecoveryCommandError(null))
            : null,
      },
    };
  };

  /** Steps 2 to 8 of one session. */
  const steps = async (current: Session, source: OpenSource): Promise<StepOutcome> => {
    // Step 2.
    await dependencies.saveStep.whenIdle();
    if (!alive(current)) {
      return canceledOf(current);
    }
    if (dependencies.isOtherDialogOpen()) {
      return { status: "blocked" };
    }
    dependencies.staleExportOpenStep();
    // True when Save of the save prompt started a save step.
    let saveStarted = false;
    const question = await confirmDropContent({
      ask: dependencies.ask,
      saveStep: {
        whenIdle: () => dependencies.saveStep.whenIdle(),
        save: (mode) => {
          saveStarted = true;
          return dependencies.saveStep.save(mode);
        },
      },
      hasChangesToSave,
      // A canceled open starts no save, whatever the prompt answers.
      isCanceled: () => !alive(current),
    });
    if (!alive(current)) {
      return canceledOf(current);
    }
    if (question.kind === "stop") {
      return { status: "stopped", saveError: question.saveError };
    }
    // A save of the prompt waits for the file and can wait for the save dialog of the system.
    // Another dialog, or a trim of a segment edge, can start in that time, so the step tests
    // again before it shows the project dialog, and it changes nothing when one is open. With
    // no save, the time after the first test held only the modal save prompt, which the user
    // answered, and the closed prompt can still be in the document then, so the step does not
    // test again.
    if (saveStarted && dependencies.isOtherDialogOpen()) {
      return { status: "blocked" };
    }

    // Steps 3 and 4. An Export request that started during the save prompt or its write can
    // still wait for its turn, and it would open its dialog over the project dialog. So the step
    // makes a waiting open step of the export stale again, directly before the project dialog
    // shows, in each path: with no prompt, after Don't Save, and after a save.
    dependencies.staleExportOpenStep();
    store.setState({
      phase: { kind: "loading" },
      projectPath: source.kind === "file" ? source.path : source.offer.projectPath,
      mode: source.kind === "file" ? "open" : "restore",
    });
    const read = await readDocument(source);
    if (!read.ok) {
      return fail(current, read.error);
    }
    if (!alive(current)) {
      return canceledOf(current);
    }
    const loaded = read.document;
    const document = checkProjectDocument(loaded.project);
    if (!document.ok) {
      return fail(current, { kind: "documentRefused", problem: document.problem });
    }

    // Step 5: each source that a clip names, in the order of the document.
    const named = new Set(loaded.project.clips.map((clip) => clip.sourceId));
    current.rows = loaded.project.sources.flatMap((entry, index) =>
      named.has(entry.id)
        ? [
            {
              entry,
              candidates: loaded.candidates[index] ?? [entry.path],
              found: null,
              failure: null,
              listed: false,
            },
          ]
        : [],
    );
    for (const [index, row] of current.rows.entries()) {
      store.setState({
        phase: {
          kind: "checking",
          stage: "sources",
          current: index + 1,
          total: current.rows.length,
          fileName: fileNameOfPath(row.entry.path),
        },
      });
      let reason: SourceCheckFailure | null = null;
      for (const candidate of row.candidates) {
        const result = await checkCandidate(row.entry, candidate);
        if (!alive(current)) {
          return canceledOf(current);
        }
        if ("media" in result) {
          const differ = recordFound(current, row, result, false);
          if (differ !== null) {
            return fail(current, differ);
          }
          break;
        }
        // The reason is the result of the first candidate that is not absent.
        if (reason === null && result.kind !== "absent") {
          reason = result;
        }
      }
      if (row.found === null) {
        row.failure ??= reason ?? { kind: "absent" };
        row.listed = true;
      }
    }

    // Steps 6 and 7.
    let needsConfirm = false;
    for (;;) {
      if (needsConfirm || current.rows.some((row) => row.found === null)) {
        publishRows(current);
        const action = await waitForAction(current);
        if (action.kind === "failed") {
          return fail(current, action.error);
        }
        if (action.kind === "cancel" || !alive(current)) {
          return canceledOf(current);
        }
      }
      const verified = await verifyRevisions(current);
      if (!alive(current)) {
        return canceledOf(current);
      }
      if (!verified) {
        needsConfirm = true;
        continue;
      }
      const next = buildSession(current, loaded);
      const check = checkSequenceLoad(next.clips, next.sources, next.segments);
      if (!check.ok) {
        return fail(current, { kind: "sequenceRefused", problem: check.problem });
      }

      // Step 8: one synchronous block. The playback stops, and nothing that waited can carry a
      // position or a play intent into the element of the new sequence: no seek, no destination of
      // a seek, no replacement of the element and no play. The overrides change after the load, so
      // the preview takes them as the choice of a new attachment, with no reload that keeps a
      // position (`audioStreamChangeEffect`).
      session = null;
      pausePlayback();
      dropNavigation();
      resetPlayback();
      media.getState().replaceSources(next.mediaSources, next.firstMedia);
      timeline.getState().loadSequence(next.clips, next.sources, next.segments);
      audioOverrides.getState().replaceOverrides(next.overrides);
      if (source.kind === "restore") {
        // ADR 073: the restored project has no file, and keeps the path of the offer as its
        // proposed path. The recovery puts `finish_restore` in its line in this same call.
        project.getState().completeRestore({ proposedPath: read.path });
        store.setState(IDLE);
        source.hooks.onRestored(source.offer.id);
        return { status: "changed", path: null };
      }
      // `load_project` always gives the canonical path of the file.
      const path = read.path ?? source.path;
      project.getState().completeOpen({
        file: next.clips.length === 0 ? null : { path, name: fileNameOfPath(path) },
        savedContent: projectContentOf(
          timeline.getState(),
          audioOverrides.getState().overrides,
        ),
        located: next.located,
      });
      store.setState(IDLE);
      return { status: "changed", path };
    }
  };

  /**
   * Reserves the locate operation for the row of `entryId`, or answers null when the step cannot
   * locate it now: no locating phase, another locate operation holds it, or the row is found.
   */
  const reserveLocate = (entryId: string): { current: Session; row: Row } | null => {
    const current = session;
    if (current === null || !alive(current) || current.busy) {
      return null;
    }
    const row = current.rows.find((entry) => entry.entry.id === entryId);
    if (
      store.getState().phase.kind !== "locating" ||
      row === undefined ||
      row.found !== null
    ) {
      return null;
    }
    current.busy = true;
    publishRows(current);
    return { current, row };
  };

  /** Releases the locate operation, and shows the rows. */
  const releaseLocate = (current: Session): void => {
    current.busy = false;
    if (alive(current)) {
      publishRows(current);
    }
  };

  /**
   * The checks of a located file while the operation is reserved: the file, and then the files
   * with the names of the other rows in its directory. Answers whether the row is found, or
   * `failed` when the step goes to its error view.
   */
  const checkLocated = async (
    current: Session,
    row: Row,
    path: string,
  ): Promise<boolean | "failed"> => {
    const result = await checkCandidate(row.entry, path);
    if (!alive(current)) {
      return false;
    }
    if (!("media" in result)) {
      row.failure = result;
      return false;
    }
    const differ = recordFound(current, row, result, true);
    if (differ !== null) {
      signal(current, { kind: "failed", error: differ });
      return "failed";
    }
    const located = result.media.path;
    for (const other of current.rows) {
      if (other.found !== null) {
        continue;
      }
      const sibling = siblingPath(located, fileNameOfPath(other.entry.path));
      if (sibling === null) {
        continue;
      }
      const tried = await checkCandidate(other.entry, sibling);
      if (!alive(current)) {
        return false;
      }
      if ("media" in tried) {
        const otherDiffer = recordFound(current, other, tried, true);
        if (otherDiffer !== null) {
          signal(current, { kind: "failed", error: otherDiffer });
          return "failed";
        }
      }
    }
    return isFound(row);
  };

  /** Ends a reserved locate operation with the result of its checks. */
  const finishLocate = (current: Session, result: boolean | "failed"): boolean => {
    if (result === "failed") {
      // The error view replaces the list, so the rows do not show again.
      current.busy = false;
      return false;
    }
    releaseLocate(current);
    return result;
  };

  const locateFile = async (entryId: string, path: string): Promise<boolean> => {
    const reserved = reserveLocate(entryId);
    if (reserved === null) {
      return false;
    }
    return finishLocate(
      reserved.current,
      await checkLocated(reserved.current, reserved.row, path),
    );
  };

  /** One request of an open or of a restore, from its turn in the line to its end (step 1). */
  const run = (source: OpenSource): Promise<StepOutcome> => {
    const requested = epoch;
    // A request that waits for its turn ends at once at a cancel, also while the line is held.
    let endWaiting: (result: StepOutcome) => void = () => undefined;
    const canceledWhileWaiting = new Promise<StepOutcome>((resolve) => {
      endWaiting = resolve;
    });
    const request: WaitingRequest = {
      cancel: (by) => endWaiting({ status: "canceled", by }),
    };
    waiting.add(request);
    const turn = runTurn(async (): Promise<StepOutcome> => {
      if (!waiting.delete(request) || epoch !== requested) {
        // A cancel ended the request already: `canceledWhileWaiting` gave its result.
        return { status: "canceled", by: "user" };
      }
      const current: Session = {
        canceled: false,
        cancelReason: null,
        busy: false,
        rows: [],
        settle: null,
        queued: null,
        stop: null,
      };
      // A cancel ends the turn at once, also while a command does not answer. The answer that
      // comes later changes nothing, because the session is not alive then.
      const stopped = new Promise<StepOutcome>((resolve) => {
        current.stop = () => resolve(canceledOf(current));
      });
      session = current;
      const running = steps(current, source);
      running.catch(() => undefined);
      try {
        return await Promise.race([running, stopped]);
      } finally {
        if (session === current) {
          session = null;
          store.setState(IDLE);
        }
      }
    });
    return Promise.race([turn, canceledWhileWaiting]);
  };

  return {
    store,
    open: async (path) => {
      const outcome = await run({ kind: "file", path });
      switch (outcome.status) {
        case "changed":
          return { status: "opened", path: outcome.path ?? path };
        case "canceled":
          // An open does not say who canceled it.
          return { status: "canceled" };
        case "failed":
          // An open answers its error, whoever closed the error view.
          return { status: "failed", error: outcome.error };
        default:
          return outcome;
      }
    },
    restore: async (offer, hooks) => {
      const outcome = await run({ kind: "restore", offer, hooks });
      switch (outcome.status) {
        case "changed":
          return { status: "restored" };
        case "failed":
          // A quit that closes the error view stops the restore (ADR 073): the caller then does
          // not offer the work again in this life of the page. A close by the user is the end
          // of a restore that failed.
          return outcome.closedBy === "quit"
            ? { status: "canceled", by: "quit" }
            : { status: "failed", error: outcome.error };
        default:
          return outcome;
      }
    },
    locate: async (entryId) => {
      // The operation is held from before the file dialog until the end of the checks.
      const reserved = reserveLocate(entryId);
      if (reserved === null) {
        return false;
      }
      const { current, row } = reserved;
      let picked: string | null;
      try {
        picked = await dependencies.pickFile(directoryOfPath(row.entry.path));
      } catch {
        releaseLocate(current);
        return false;
      }
      if (picked === null || !alive(current)) {
        releaseLocate(current);
        return false;
      }
      return finishLocate(current, await checkLocated(current, row, picked));
    },
    locateFile,
    confirm: () => {
      const current = session;
      const phase = store.getState().phase;
      if (current === null || phase.kind !== "locating" || !phase.canOpen) {
        return false;
      }
      signal(current, { kind: "confirm" });
      return true;
    },
    cancel: (reason = "user") => {
      epoch += 1;
      for (const request of waiting) {
        request.cancel(reason);
      }
      waiting.clear();
      const current = session;
      if (current !== null) {
        const showsError = store.getState().phase.kind === "failed";
        current.canceled = true;
        current.cancelReason = reason;
        session = null;
        signal(current, { kind: "cancel" });
        // The close of the error view ends the step with its error; no command waits then.
        if (!showsError) {
          current.stop?.();
        }
      }
      store.setState(IDLE);
    },
    isOpening: () => waiting.size > 0 || session !== null,
  };
}

/** The store of the project dialog of this page. */
export const openProjectStore: OpenProjectStore = createOpenProjectStore();

const defaultSelector = (state: OpenProjectState): OpenProjectState => state;

/** React hook for the store of the project dialog of this page. */
export function useOpenProjectStore(): OpenProjectState;
export function useOpenProjectStore<T>(selector: (state: OpenProjectState) => T): T;
export function useOpenProjectStore<T>(
  selector?: (state: OpenProjectState) => T,
): T | OpenProjectState {
  return useStore(
    openProjectStore,
    (selector ?? defaultSelector) as (state: OpenProjectState) => T,
  );
}
