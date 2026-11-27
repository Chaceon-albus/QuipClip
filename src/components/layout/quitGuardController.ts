/**
 * The quit guard of ADR 027: one path for every way to close, and the confirmation before Clear
 * Timeline (ADR 052). The save prompt of ADR 072 is one form of both dialogs.
 *
 * Every close request and every exit request that Rust held back reach `requestQuit`. When
 * nothing would be lost, it calls `confirm_quit` at once. Otherwise it opens the quit prompt.
 * When the project has changes to save, that prompt is the save prompt, with Save, Don't Save
 * and Cancel. A File > Open and a drop reach `requestOpen`, which imports the files as clips and
 * asks nothing, because an import replaces nothing (ADR 052). Clear Timeline reaches
 * `requestClear`, which asks first when the project has a file and is modified, or when the
 * sequence has segments.
 *
 * The prompt is in a store, so the one dialog in `QuitGuardDialog` shows it, and any caller
 * can raise it. The decisions themselves are the pure rules in `quitGuard.ts`.
 *
 * # The flows
 *
 * A quit and a Clear Timeline each run as one flow. A flow waits for a save step that runs
 * (ADR 072, "Save"), shows its prompt, waits for the answer, and can run a save step of its own.
 * With no save step running, the first decision is made in the same call. One flow runs at a
 * time:
 *
 * - A quit request while a quit flow runs does nothing, so a second close request never stacks a
 *   second dialog. A quit request drops a Clear Timeline flow: that flow then never clears, also
 *   when a save that it started ends later.
 * - Clear Timeline and an import do nothing while a flow runs, and after the quit started.
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
import { projectContentOf } from "@/features/project/document";
import { hasChangesToSaveNow } from "@/features/project/dropContent";
import { projectSaveStep } from "@/features/project/saveAction";
import { projectSaveErrorStore } from "@/features/project/saveErrorStore";
import type { ProjectSaveError, ProjectSaveStep } from "@/features/project/saveStep";
import { isProjectModified, projectStore } from "@/features/project/store";
import { importClips } from "@/features/sequence/importClips";
import { settingsWindowDraftStore } from "@/features/settings/settingsWindowDraft";
import { timelineStore } from "@/features/timeline";
import { BACKEND_COMMANDS, invokeCommand } from "@/lib/ipc";
import {
  countQueuedExports,
  decideClear,
  decideQuit,
  isLossListed,
  timelineWorkOf,
  type ClearPrompt,
  type QuitGuardInput,
  type QuitLoss,
} from "./quitGuard";

/** The confirmation that the dialog shows, or null when it is closed. */
export type QuitGuardPrompt =
  | { readonly kind: "quit"; readonly loss: QuitLoss }
  | { readonly kind: "clear"; readonly change: ClearPrompt };

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
   * Imports videos as clips of the sequence (ADR 052): from junction `index`, or at the end for
   * null or no index. An import replaces nothing, so it asks nothing. Does nothing while a
   * prompt is open, while a flow runs, or after the quit started.
   */
  requestOpen: (
    paths: string | readonly string[],
    index?: number | null,
  ) => Promise<unknown>;
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

type Flow = QuitFlow | ClearFlow;

export function createQuitGuard(dependencies: QuitGuardDependencies = {}): QuitGuard {
  const queueStore = dependencies.queueStore ?? exportQueueStore;
  const readInput = dependencies.readInput ?? (() => readQuitGuardInput(queueStore));
  const confirmQuit = dependencies.confirmQuit ?? invokeConfirmQuit;
  const importPaths =
    dependencies.importPaths ??
    ((paths: readonly string[], index: number | null) => importClips(paths, index));
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

    requestQuit: () => {
      if (quitting || flow?.kind === "quit") {
        return;
      }
      if (flow !== null) {
        // The user asked to quit, and the quit prompt takes the place of the clear prompt. The
        // dropped flow never clears.
        flow = null;
        store.setState({ prompt: null });
      }
      const current: QuitFlow = { kind: "quit", confirmed: null };
      flow = current;
      runQuitFlow(current);
    },

    requestOpen: (paths, index = null) => {
      // The dialog is modal, so no entry point can reach this while it is open. The test is a
      // guard, so that an import never starts under an unanswered prompt or inside a flow.
      if (quitting || flow !== null || store.getState().prompt !== null) {
        return Promise.resolve([]);
      }
      return importPaths(typeof paths === "string" ? [paths] : paths, index);
    },

    requestClear: () => {
      if (quitting || flow !== null || store.getState().prompt !== null) {
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
        (prompt.kind === "quit"
          ? prompt.loss.project !== null
          : prompt.change.form === "save");
      if (!isSavePrompt) {
        return;
      }
      const answer = takeAnswer();
      if (answer === null) {
        return;
      }
      const { prompt: shown, current } = answer;
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
      flow = null;
    },
  };
}

/** The quit guard of the application. `QuitGuardDialog` shows its prompt. */
export const quitGuard: QuitGuard = createQuitGuard();
