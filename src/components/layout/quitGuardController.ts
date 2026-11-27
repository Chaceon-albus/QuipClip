/**
 * The quit guard of ADR 027: one path for every way to close, and the confirmation before Clear
 * Timeline (ADR 052). The save prompt of ADR 072 is one form of both dialogs.
 *
 * Every close request and every exit request that Rust held back reach `requestQuit`. When
 * nothing would be lost, it calls `confirm_quit` at once. Otherwise it opens the quit prompt.
 * When the project has changes to save, that prompt is the save prompt, with Save, Don't Save
 * and Cancel. The Open action and a drop reach `requestOpen` with all the files of one request
 * (ADR 072, "One Open action"). Videos join the sequence as clips, and an import asks nothing,
 * because it replaces nothing (ADR 052). One project file goes to the open step of the page,
 * which asks with the save prompt of the open when the project has changes to save. A project
 * file with other videos or project files opens nothing, and a message says why. Clear Timeline
 * reaches `requestClear`, which asks first when the project has a file and is modified, or when
 * the sequence has segments.
 *
 * The prompt is in a store, so the one dialog in `QuitGuardDialog` shows it, and any caller
 * can raise it. The decisions themselves are the pure rules in `quitGuard.ts`.
 *
 * # The flows
 *
 * A quit and a Clear Timeline each run as one flow. A flow waits for a save step that runs
 * (ADR 072, "Save"), shows its prompt, waits for the answer, and can run a save step of its own.
 * With no save step running, the first decision is made in the same call. The open of a project
 * is a flow too, from the moment `requestOpen` gives the project file to the open step until the
 * open ends. Its save prompt is a part of that flow, and the open step runs the save of its Save
 * button itself (`confirmDropContent`). One flow runs at a time:
 *
 * - A quit request while a quit flow runs does nothing, so a second close request never stacks a
 *   second dialog. A quit request drops a Clear Timeline flow: that flow then never clears, also
 *   when a save that it started ends later.
 * - A quit request first stops an open of a project that is before its step 8, as Cancel of the
 *   project dialog does, and it drops the save prompt of an open, which then answers Cancel
 *   (ADR 072, "The open of a project"). Then it tests the project. So the quit dialog and the
 *   open never hold two different projects.
 * - Clear Timeline, an import and the open of a project do nothing while a flow runs, and after
 *   the quit started. The save prompt of an open answers Cancel at once outside its own open.
 *   The Open action reads `canOpen` before it shows its file dialog.
 *
 * When the user confirms a quit dialog, the quit reads the losses again. It quits when the
 * dialog listed each loss (`isLossListed`), and it shows the dialog again otherwise. A loss can
 * appear while the dialog shows or while Save writes: an import that ended, or a preset draft of
 * the Settings window.
 *
 * The guard runs in the main window. An unsaved preset draft lives in the Settings window,
 * which reports its name to this window (`settingsWindowDraft.ts`). A quit can start while
 * the Settings window has the focus, for example from `Cmd+Q`, so the quit prompt brings the
 * main window forward first.
 *
 * Every way to close reaches the same decision: the close button of the window, `Cmd+W`, and
 * an exit request all call `requestQuit`, which reads the input at each decision. The input
 * holds the queued exports, so each of them asks while exports wait (ADR 049).
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  exportQueueStore,
  exportStore,
  type ExportQueueState,
} from "@/features/export";
import { audioOverrideStore } from "@/features/media/audioOverrideStore";
import { mediaStore } from "@/features/media/store";
import { ImportMediaError } from "@/features/media/types";
import { projectContentOf } from "@/features/project/document";
import {
  hasChangesToSaveNow,
  type DropContentAnswer,
} from "@/features/project/dropContent";
import { classifyOpenPaths } from "@/features/project/openPaths";
import { hasProjectExtension } from "@/features/project/paths";
import type { OpenProjectResult, ProjectOpenStep } from "@/features/project/openStep";
import { projectSaveStep } from "@/features/project/saveAction";
import { projectSaveErrorStore } from "@/features/project/saveErrorStore";
import type { ProjectSaveError, ProjectSaveStep } from "@/features/project/saveStep";
import { isProjectModified, projectStore } from "@/features/project/store";
import { importClips, runInImportLine } from "@/features/sequence/importClips";
import { settingsWindowDraftStore } from "@/features/settings/settingsWindowDraft";
import { timelineStore } from "@/features/timeline";
import { BACKEND_COMMANDS, invokeCommand } from "@/lib/ipc";
import { createPageOpenStep, whenTrimSettled } from "./projectOpenStep";
import {
  countQueuedExports,
  decideClear,
  decideQuit,
  isLossListed,
  timelineWorkOf,
  type ClearPrompt,
  type ProjectLoss,
  type QuitGuardInput,
  type QuitLoss,
} from "./quitGuard";

/** The confirmation that the dialog shows, or null when it is closed. */
export type QuitGuardPrompt =
  | { readonly kind: "quit"; readonly loss: QuitLoss }
  | { readonly kind: "clear"; readonly change: ClearPrompt }
  /** The save prompt of the open of a project (ADR 072). */
  | { readonly kind: "open"; readonly project: ProjectLoss };

export interface QuitGuardState {
  readonly prompt: QuitGuardPrompt | null;
}

/** The fields of the export queue store that the quit guard reads. */
export type QuitGuardQueueState = Pick<
  ExportQueueState,
  "waiting" | "removing" | "enqueuing"
>;

/** Dependencies that a test can inject. Each one defaults to the production value. */
export interface QuitGuardDependencies {
  /**
   * Reads the timeline, the project, the export status, the queued exports and the preset draft
   * now. Defaults to `readQuitGuardInput` over `queueStore`.
   */
  readInput?: () => QuitGuardInput;
  /** The export queue store that the default `readInput` reads. Defaults to `exportQueueStore`. */
  queueStore?: StoreApi<QuitGuardQueueState>;
  /**
   * Asks Rust to end the application. The promise can resolve before the application ends,
   * because Rust only queues the exit, and it can also never settle.
   */
  confirmQuit?: () => Promise<unknown>;
  /**
   * Imports files as clips from a junction of the sequence, or at the end for null. Defaults to
   * `importClips` (ADR 052).
   */
  importPaths?: (paths: readonly string[], index: number | null) => Promise<unknown>;
  /**
   * Makes the open step of the page (ADR 072). The guard calls it one time, and passes the
   * function that shows the save prompt of the open. Defaults to `createPageOpenStep`.
   */
  createOpenStep?: (ask: () => Promise<DropContentAnswer>) => ProjectOpenStep;
  /**
   * Waits until no released trim of a segment edge waits for its commit (ADR 030). The open of a
   * project waits for it, as a part of its flow, before it starts the open step, so the trim is
   * not taken for another dialog and the open is not dropped. Null means that no trim waits, and
   * the open starts in the same call. Defaults to `whenTrimSettled`.
   */
  waitForTrimCommit?: () => Promise<void> | null;
  /**
   * Shows the error of an Open action that opened nothing: a project file with other files.
   * Defaults to the error of the media store, the place of the error of an import. The guard
   * calls it in a turn of its own in the line of the imports, after each import that runs or
   * waits, because the report of the media store drops an import in progress.
   */
  reportOpenError?: (error: ImportMediaError) => void;
  /**
   * Removes every clip and every segment, as one edit. Defaults to the timeline store. The rule
   * of the project store then closes the project (`installProjectSequenceRule`).
   */
  clearTimeline?: () => void;
  /**
   * Brings the main window forward when the quit prompt opens. Defaults to `setFocus` of the
   * current Tauri window, best effort.
   */
  focusWindow?: () => void;
  /**
   * The save step of the page (ADR 072). The flows wait for the step that runs, and Save of the
   * save prompt runs it. Defaults to `projectSaveStep`.
   */
  saveStep?: Pick<ProjectSaveStep, "save" | "isRunning" | "whenIdle">;
  /** Shows the error of a save that failed. Defaults to the save error store. */
  reportSaveError?: (error: ProjectSaveError) => void;
  /**
   * Reads the save error that shows now, or null. The quit flow compares it before and after it
   * waits for a save step, so a save error that came during the wait ends the quit. Defaults to
   * the error of the save error store.
   */
  readSaveError?: () => unknown;
}

export interface QuitGuard {
  readonly store: StoreApi<QuitGuardState>;
  /**
   * Starts the quit flow. A request while a quit flow runs does nothing, so a second close
   * request or a second exit request never stacks a second dialog. A request after the quit
   * started does nothing either, also after `confirm_quit` resolved.
   *
   * A quit request drops a Clear Timeline flow: its prompt closes, and it never clears.
   */
  requestQuit: () => void;
  /**
   * The open step of the page (ADR 072). The project dialog shows its store, and its buttons
   * call `locate`, `confirm` and `cancel` of the step.
   */
  readonly openStep: ProjectOpenStep;
  /**
   * True when `requestOpen` would take a request now: no prompt shows, no flow runs, and the
   * quit did not start. It changes nothing. The Open action reads it before it shows its file
   * dialog, and `requestOpen` tests the same again after the dialog.
   */
  canOpen: () => boolean;
  /**
   * The files of one Open action or one drop, as one request (ADR 072, "One Open action"):
   *
   * - No project file: it imports the files as clips of the sequence (ADR 052), from junction
   *   `index`, or at the end for null or no index. An import replaces nothing, so it asks
   *   nothing.
   * - One project file and no video: it opens that project with the open step, and the step
   *   asks first when the project has changes to save. The index has no effect. The error of a
   *   save that the save prompt ran shows in the save error dialog. The project dialog shows the
   *   other errors.
   * - Each other set with a project file: it opens nothing, and it reports `projectNotAlone`.
   *
   * Does nothing while a prompt is open, while a flow runs, or after the quit started. The open
   * of a project is a flow until it ends.
   */
  requestOpen: (
    paths: string | readonly string[],
    index?: number | null,
  ) => Promise<unknown>;
  /**
   * The files of the dialog that adds a video from the export dialog (ADR 024): videos only. A
   * request with a project file opens nothing and imports nothing, and it reports
   * `projectNotAlone`. Otherwise it imports the files at the end of the sequence, as
   * `requestOpen` does. It does nothing in the same cases as `requestOpen`.
   */
  requestVideos: (paths: readonly string[]) => Promise<unknown>;
  /**
   * Starts the Clear Timeline flow: it clears the timeline, or first asks when the project has a
   * file and is modified, or when the sequence has segments (ADR 052, ADR 072). Does nothing
   * while a prompt is open, while a flow runs, or after the quit started.
   */
  requestClear: () => void;
  /**
   * The primary button of the prompt: Quit or Clear, or Save of the save prompt. Save runs the
   * save step with no test of the conditions of the Save action.
   */
  confirm: () => void;
  /** "Don't Save" of the save prompt: the quit or the clear continues. */
  discard: () => void;
  /**
   * The Cancel button, Escape, or any other dismissal of the prompt. It ends the flow and
   * changes nothing else. With `shown`, it acts only while that prompt is still the prompt of
   * the store: the dialog passes the prompt that it rendered, so the dismissal that Radix sends
   * after a button does not cancel a prompt that the button showed in its place.
   */
  cancel: (shown?: QuitGuardPrompt) => void;
}

/** Reads the production stores. A test can pass another export queue store. */
export function readQuitGuardInput(
  queueStore: StoreApi<QuitGuardQueueState> = exportQueueStore,
): QuitGuardInput {
  const timeline = timelineStore.getState();
  const exportState = exportStore.getState();
  const project = projectStore.getState();
  return {
    // The stored marks, so a mark that the sequence cannot project still counts.
    timeline: timelineWorkOf(timeline),
    project: {
      hasChangesToSave: hasChangesToSaveNow(),
      isModifiedFile:
        project.file !== null &&
        isProjectModified(
          project,
          projectContentOf(timeline, audioOverrideStore.getState().overrides),
        ),
      fileName: project.file?.name ?? null,
    },
    exportStatus: exportState.status,
    exportTracking: exportState.tracking,
    unsavedPresetName: settingsWindowDraftStore.getState().unsavedPresetName,
    queuedExports: countQueuedExports(queueStore.getState()),
  };
}

async function invokeConfirmQuit(): Promise<unknown> {
  return await invokeCommand<unknown>(BACKEND_COMMANDS.CONFIRM_QUIT);
}

/**
 * Gives the focus to the current window. A window that does not come forward still shows the
 * prompt, so a failure, and the missing Tauri shell of a test, change nothing.
 */
function focusCurrentWindow(): void {
  try {
    void getCurrentWindow()
      .setFocus()
      .catch(() => {});
  } catch {
    // No Tauri window exists.
  }
}

/** The quit flow. `confirmed` is the loss list of the last dialog that the user confirmed. */
interface QuitFlow {
  readonly kind: "quit";
  confirmed: QuitLoss | null;
}

/**
 * The Clear Timeline flow. `saved` is true after Save of its save prompt ended with `saved` or
 * `busy`.
 */
interface ClearFlow {
  readonly kind: "clear";
  saved: boolean;
}

/**
 * The open of a project, from the request until the open step ends. `answer` settles the
 * question of the save prompt while it shows (`confirmDropContent` acts on the answer itself),
 * and it is null otherwise.
 */
interface OpenFlow {
  readonly kind: "open";
  answer: ((answer: DropContentAnswer) => void) | null;
}

type Flow = QuitFlow | ClearFlow | OpenFlow;

export function createQuitGuard(dependencies: QuitGuardDependencies = {}): QuitGuard {
  const queueStore = dependencies.queueStore ?? exportQueueStore;
  const readInput = dependencies.readInput ?? (() => readQuitGuardInput(queueStore));
  const confirmQuit = dependencies.confirmQuit ?? invokeConfirmQuit;
  const importPaths =
    dependencies.importPaths ??
    ((paths: readonly string[], index: number | null) => importClips(paths, index));
  const waitForTrimCommit = dependencies.waitForTrimCommit ?? (() => whenTrimSettled());
  const reportOpenError =
    dependencies.reportOpenError ??
    ((error: ImportMediaError) => {
      mediaStore.getState().reportError(error);
    });
  const clearTimeline =
    dependencies.clearTimeline ?? (() => timelineStore.getState().clearTimeline());
  const focusWindow = dependencies.focusWindow ?? focusCurrentWindow;
  const saveStep = dependencies.saveStep ?? projectSaveStep;
  const reportSaveError =
    dependencies.reportSaveError ??
    ((error: ProjectSaveError) => {
      projectSaveErrorStore.getState().report(error);
    });

  const readSaveError =
    dependencies.readSaveError ?? (() => projectSaveErrorStore.getState().error);

  const store = createStore<QuitGuardState>()(() => ({ prompt: null }));

  // True from the call of `confirm_quit` until it fails. A call that resolves leaves it true:
  // Rust has confirmed the quit and queued the exit, so the application is ending, and a
  // later request must not show a dialog in a window that is about to close.
  let quitting = false;

  // The flow that runs, or null. A step that waits goes on only while its flow is still this
  // value, so a flow that ended or that a quit dropped does nothing more.
  let flow: Flow | null = null;

  /** Settles the save prompt of an open flow with `answer`, when it shows. */
  function answerOpen(current: OpenFlow, answer: DropContentAnswer): void {
    const settle = current.answer;
    current.answer = null;
    settle?.(answer);
  }

  /**
   * Ends the flow that runs, with no other change. The save prompt of an open answers Cancel, so
   * the open step stops.
   */
  function dropFlow(): void {
    const dropped = flow;
    flow = null;
    if (dropped?.kind === "open") {
      answerOpen(dropped, "cancel");
    }
  }

  /** True when no prompt shows, no flow runs, and the quit did not start. */
  function isFree(): boolean {
    return !quitting && flow === null && store.getState().prompt === null;
  }

  /**
   * The save prompt of the open of a project (ADR 072, "Before the content is dropped"). It
   * shows only inside the open flow that runs, while no prompt shows and the quit did not start.
   * Otherwise it answers Cancel at once. It answers the button of the user. The prompt names the
   * file of the project, or says that the project has no file, at the moment it shows.
   */
  function askBeforeOpen(): Promise<DropContentAnswer> {
    const current = flow;
    if (
      quitting ||
      current?.kind !== "open" ||
      current.answer !== null ||
      store.getState().prompt !== null
    ) {
      return Promise.resolve("cancel");
    }
    return new Promise<DropContentAnswer>((resolve) => {
      current.answer = resolve;
      store.setState({
        prompt: { kind: "open", project: { fileName: readInput().project.fileName } },
      });
    });
  }

  const openStep = (dependencies.createOpenStep ?? createPageOpenStep)(askBeforeOpen);

  /**
   * Opens one project file with the open step, as an open flow until the step ends. The flow
   * first waits for a released trim that waits for its commit (`waitForTrimCommit`). The save
   * step of the page reports a save of the save prompt that failed itself
   * (`createPageOpenStep`), so a `stopped` result shows nothing more here. The project dialog
   * shows each other error.
   */
  async function openProject(path: string): Promise<OpenProjectResult> {
    const current: OpenFlow = { kind: "open", answer: null };
    flow = current;
    try {
      // A released trim that waits for its frame delays the open, and does not drop it. The
      // wait is a part of the flow, so a quit during it drops the flow, and the open does not
      // start.
      const trim = waitForTrimCommit();
      if (trim !== null) {
        await trim;
        if (flow !== current) {
          return { status: "canceled" };
        }
      }
      return await openStep.open(path);
    } finally {
      if (flow === current) {
        flow = null;
      }
    }
  }

  /**
   * Reports `projectNotAlone` in a turn of its own in the line of the imports, so the report
   * comes after each import that runs or waits and does not drop it.
   */
  function reportNotAlone(): Promise<unknown[]> {
    return runInImportLine(() => {
      reportOpenError(new ImportMediaError({ code: "projectNotAlone" }));
      return Promise.resolve([]);
    });
  }

  function quit(): void {
    flow = null;
    quitting = true;
    confirmQuit().catch(() => {
      // The application did not end, for example outside the Tauri shell. A later request
      // runs the decision again.
      quitting = false;
    });
  }

  /**
   * Runs `next` now when no save step runs. Otherwise it runs `next` after the step, while
   * `current` is still the flow (ADR 072: the quit and Clear Timeline wait for the save step
   * that runs, and then they test the project). `next` gets true when a save error was reported
   * during the wait.
   */
  function afterSaveStep(
    current: Flow,
    next: (errorDuringWait: boolean) => void,
  ): void {
    if (!saveStep.isRunning()) {
      next(false);
      return;
    }
    const errorBefore = readSaveError();
    void saveStep.whenIdle().then(() => {
      if (flow === current) {
        const errorAfter = readSaveError();
        next(errorAfter !== null && errorAfter !== errorBefore);
      }
    });
  }

  /**
   * Save of the save prompt. It runs the save step itself, with no test of the conditions of the
   * Save action. A save dialog that the user canceled ends the flow. A failed save ends the flow
   * and shows its error. After `saved`, or `busy` when another step started meanwhile, the flow
   * goes on with `next`, which waits for the step that runs.
   *
   * The error of a failed save shows also when a quit dropped the flow meanwhile: the user asked
   * for that save. A dropped flow does nothing else, so it never goes on and never clears.
   */
  function saveFromPrompt(current: Flow, next: () => void): void {
    const ended = () => flow !== current;
    void saveStep.save("save").then(
      (result) => {
        if (result.status === "failed") {
          if (!ended()) {
            flow = null;
          }
          reportSaveError(result.error);
          return;
        }
        if (ended()) {
          return;
        }
        if (result.status === "canceled") {
          flow = null;
          return;
        }
        next();
      },
      () => {
        // The save step does not reject. A rejection ends the flow with no change.
        if (!ended()) {
          flow = null;
        }
      },
    );
  }

  /**
   * Steps 1 to 3 of the quit flow: wait for the save step, read the losses, and quit or ask. The
   * quit continues when nothing would be lost, or when the last dialog that the user confirmed
   * listed each loss. A save error that was reported while the flow waited ends the flow.
   */
  function runQuitFlow(current: QuitFlow): void {
    afterSaveStep(current, (errorDuringWait) => {
      if (errorDuringWait) {
        // The save that the quit waited for failed, and its error shows. A quit now would hide
        // it, so the flow ends with no quit and no prompt. The user can quit again after it.
        flow = null;
        return;
      }
      const decision = decideQuit(readInput());
      if (
        !decision.ask ||
        (current.confirmed !== null && isLossListed(decision.loss, current.confirmed))
      ) {
        store.setState({ prompt: null });
        quit();
        return;
      }
      store.setState({ prompt: { kind: "quit", loss: decision.loss } });
      focusWindow();
    });
  }

  /**
   * Steps 1 and 2 of the Clear Timeline flow: wait for the save step, and clear or ask.
   *
   * After Save of its save prompt, a project with no changes to save clears with no second
   * question. Otherwise the flow decides again and shows the form that the decision gives. The
   * project can close during the write, as when the last clip goes and an Undo brings it back,
   * and the sequence then holds segments that the file does not have: the plain form asks for
   * them.
   */
  function runClearFlow(current: ClearFlow): void {
    afterSaveStep(current, () => {
      const input = readInput();
      if (current.saved && !input.project.hasChangesToSave) {
        flow = null;
        clearTimeline();
        return;
      }
      const decision = decideClear(input);
      if (decision.form === "none") {
        flow = null;
        clearTimeline();
        return;
      }
      store.setState({ prompt: { kind: "clear", change: decision } });
    });
  }

  /** Closes the prompt that shows, and returns it with its flow, or null when none shows. */
  function takeAnswer(): { prompt: QuitGuardPrompt; current: Flow } | null {
    const prompt = store.getState().prompt;
    const current = flow;
    if (prompt === null || current === null) {
      return null;
    }
    store.setState({ prompt: null });
    return { prompt, current };
  }

  return {
    store,
    openStep,
    canOpen: isFree,

    requestQuit: () => {
      if (quitting) {
        return;
      }
      // ADR 072: a quit stops an open that is before step 8 first, as Cancel does. The project
      // dialog closes, and nothing of the session changes.
      if (openStep.isOpening()) {
        openStep.cancel();
      }
      if (flow?.kind === "quit") {
        return;
      }
      if (flow !== null) {
        // The user asked to quit, and the quit prompt takes the place of the clear prompt or of
        // the save prompt of an open. The dropped flow never clears, and the open stops.
        dropFlow();
        store.setState({ prompt: null });
      }
      const current: QuitFlow = { kind: "quit", confirmed: null };
      flow = current;
      runQuitFlow(current);
    },

    requestOpen: (paths, index = null) => {
      // The dialog is modal, so no entry point can reach this while it is open. The test is a
      // guard, so that an import never starts under an unanswered prompt or inside a flow.
      if (!isFree()) {
        return Promise.resolve([]);
      }
      const request = classifyOpenPaths(typeof paths === "string" ? [paths] : paths);
      switch (request.kind) {
        case "videos":
          return importPaths(request.paths, index);
        case "project":
          // A project replaces the sequence, so the place of a drop has no effect.
          return openProject(request.path);
        case "projectNotAlone":
          return reportNotAlone();
      }
    },

    requestVideos: (paths) => {
      if (!isFree()) {
        return Promise.resolve([]);
      }
      // The dialog lists only videos. A project file typed into it opens nothing.
      if (paths.some((path) => path.trim().length > 0 && hasProjectExtension(path))) {
        return reportNotAlone();
      }
      return importPaths(paths, null);
    },

    requestClear: () => {
      if (!isFree()) {
        return;
      }
      const current: ClearFlow = { kind: "clear", saved: false };
      flow = current;
      runClearFlow(current);
    },

    confirm: () => {
      const answer = takeAnswer();
      if (answer === null) {
        return;
      }
      const { prompt, current } = answer;
      if (prompt.kind === "open" && current.kind === "open") {
        // Save of the save prompt of an open. The open step runs the save itself, and the open
        // flow goes on during the write.
        answerOpen(current, "save");
        return;
      }
      if (prompt.kind === "quit" && current.kind === "quit") {
        if (prompt.loss.project === null) {
          // Quit of the plain dialog.
          current.confirmed = prompt.loss;
          runQuitFlow(current);
          return;
        }
        // Save of the save prompt. The project is listed no more, so a project that still has
        // changes to save after the write shows the prompt again.
        saveFromPrompt(current, () => {
          current.confirmed = { ...prompt.loss, project: null };
          runQuitFlow(current);
        });
        return;
      }
      if (prompt.kind === "clear" && current.kind === "clear") {
        if (prompt.change.form === "plain") {
          flow = null;
          clearTimeline();
          return;
        }
        saveFromPrompt(current, () => {
          current.saved = true;
          runClearFlow(current);
        });
      }
    },

    discard: () => {
      const prompt = store.getState().prompt;
      // Only the save prompt has a discard button.
      const isSavePrompt =
        prompt !== null &&
        (prompt.kind === "open" ||
          (prompt.kind === "quit"
            ? prompt.loss.project !== null
            : prompt.change.form === "save"));
      if (!isSavePrompt) {
        return;
      }
      const answer = takeAnswer();
      if (answer === null) {
        return;
      }
      const { prompt: shown, current } = answer;
      if (shown.kind === "open" && current.kind === "open") {
        answerOpen(current, "dontSave");
        return;
      }
      if (shown.kind === "quit" && current.kind === "quit") {
        current.confirmed = shown.loss;
        runQuitFlow(current);
        return;
      }
      if (shown.kind === "clear" && current.kind === "clear") {
        flow = null;
        clearTimeline();
      }
    },

    cancel: (shown) => {
      const prompt = store.getState().prompt;
      if (prompt === null || (shown !== undefined && shown !== prompt)) {
        return;
      }
      store.setState({ prompt: null });
      if (flow?.kind === "open") {
        // Cancel of the save prompt of an open: the open step stops, and its flow ends with it.
        answerOpen(flow, "cancel");
        return;
      }
      flow = null;
    },
  };
}

/** The quit guard of the application. `QuitGuardDialog` shows its prompt. */
export const quitGuard: QuitGuard = createQuitGuard();
