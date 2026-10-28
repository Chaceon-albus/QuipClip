/**
 * The quit guard of ADR 027: one path for every way to close, and the confirmation before Clear
 * Timeline (ADR 052).
 *
 * Every close request and every exit request that Rust held back reach `requestQuit`. When
 * nothing would be lost, it calls `confirm_quit` at once. Otherwise it opens the quit prompt,
 * and the Quit button calls `confirm_quit`. A File > Open and a drop reach `requestOpen`, which
 * imports the files as clips and asks nothing, because an import replaces nothing (ADR 052).
 * Clear Timeline reaches `requestClear`, which asks first when the sequence has segments.
 *
 * The prompt is in a store, so the one dialog in `QuitGuardDialog` shows it, and any caller
 * can raise it. The decisions themselves are the pure rules in `quitGuard.ts`.
 *
 * The guard runs in the main window. An unsaved preset draft lives in the Settings window,
 * which reports its name to this window (`settingsWindowDraft.ts`). A quit can start while
 * the Settings window has the focus, for example from `Cmd+Q`, so the quit prompt brings the
 * main window forward first.
 *
 * Every way to close reaches the same decision: the close button of the window, `Cmd+W`, and
 * an exit request all call `requestQuit`, which reads the input once per request. The input
 * holds the queued exports, so each of them asks while exports wait (ADR 049).
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  exportQueueStore,
  exportStore,
  type ExportQueueState,
} from "@/features/export";
import { importClips } from "@/features/sequence/importClips";
import { settingsWindowDraftStore } from "@/features/settings/settingsWindowDraft";
import { timelineStore } from "@/features/timeline";
import { BACKEND_COMMANDS, invokeCommand } from "@/lib/ipc";
import {
  countQueuedExports,
  decideQuit,
  decideClear,
  type QuitGuardInput,
  type QuitLoss,
} from "./quitGuard";

/** The confirmation that the dialog shows, or null when it is closed. */
export type QuitGuardPrompt =
  | { readonly kind: "quit"; readonly loss: QuitLoss }
  | {
      readonly kind: "clear";
      readonly segments: number;
      readonly pendingIn: boolean;
    };

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
   * Reads the timeline, the export status, the queued exports, the preset draft, and the open
   * video now. Defaults to `readQuitGuardInput` over `queueStore`.
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
  /** Removes every clip and every segment, as one edit. Defaults to the timeline store. */
  clearTimeline?: () => void;
  /**
   * Brings the main window forward when the quit prompt opens. Defaults to `setFocus` of the
   * current Tauri window, best effort.
   */
  focusWindow?: () => void;
}

export interface QuitGuard {
  readonly store: StoreApi<QuitGuardState>;
  /**
   * Runs the quit decision. A request while the quit prompt is open does nothing, so a
   * second close request or a second exit request never stacks a second dialog. A request
   * after the quit started does nothing either, also after `confirm_quit` resolved.
   *
   * A quit request while the replace prompt is open drops the replacement: the user asked
   * to quit, and the quit prompt takes the place of the replace prompt.
   */
  requestQuit: () => void;
  /**
   * Imports videos as clips of the sequence (ADR 052): from junction `index`, or at the end for
   * null or no index. An import replaces nothing, so it asks nothing. Does nothing while a prompt
   * is open or the quit started.
   */
  requestOpen: (
    paths: string | readonly string[],
    index?: number | null,
  ) => Promise<unknown>;
  /**
   * Clears the timeline, or first asks when the sequence has segments (ADR 052). Does nothing
   * while a prompt is open or the quit started.
   */
  requestClear: () => void;
  /** The confirm button of the prompt: quits, or clears the timeline. */
  confirm: () => void;
  /** The Cancel button, Escape, or any other dismissal of the prompt. Changes nothing else. */
  cancel: () => void;
}

/** Reads the production stores. A test can pass another export queue store. */
export function readQuitGuardInput(
  queueStore: StoreApi<QuitGuardQueueState> = exportQueueStore,
): QuitGuardInput {
  const timeline = timelineStore.getState();
  const exportState = exportStore.getState();
  return {
    timeline: {
      sourceId: timeline.sourceId,
      segments: timeline.segments,
      pendingInPts: timeline.pendingInPts,
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

  const store = createStore<QuitGuardState>()(() => ({ prompt: null }));

  // True from the call of `confirm_quit` until it fails. A call that resolves leaves it true:
  // Rust has confirmed the quit and queued the exit, so the application is ending, and a
  // later request must not show a dialog in a window that is about to close.
  let quitting = false;

  function quit(): void {
    quitting = true;
    confirmQuit().catch(() => {
      // The application did not end, for example outside the Tauri shell. A later request
      // runs the decision again.
      quitting = false;
    });
  }

  return {
    store,

    requestQuit: () => {
      if (quitting || store.getState().prompt?.kind === "quit") {
        return;
      }
      const decision = decideQuit(readInput());
      if (!decision.ask) {
        store.setState({ prompt: null });
        quit();
        return;
      }
      store.setState({ prompt: { kind: "quit", loss: decision.loss } });
      focusWindow();
    },

    requestOpen: (paths, index = null) => {
      // The dialog is modal, so no entry point can reach this while it is open. The test is a
      // guard, so that an import never starts under an unanswered prompt.
      if (quitting || store.getState().prompt !== null) {
        return Promise.resolve([]);
      }
      return importPaths(typeof paths === "string" ? [paths] : paths, index);
    },

    requestClear: () => {
      if (quitting || store.getState().prompt !== null) {
        return;
      }
      const decision = decideClear(readInput());
      if (!decision.ask) {
        clearTimeline();
        return;
      }
      store.setState({
        prompt: {
          kind: "clear",
          segments: decision.segments,
          pendingIn: decision.pendingIn,
        },
      });
    },

    confirm: () => {
      const prompt = store.getState().prompt;
      if (prompt === null) {
        return;
      }
      store.setState({ prompt: null });
      if (prompt.kind === "quit") {
        quit();
        return;
      }
      clearTimeline();
    },

    cancel: () => {
      if (store.getState().prompt !== null) {
        store.setState({ prompt: null });
      }
    },
  };
}

/** The quit guard of the application. `QuitGuardDialog` shows its prompt. */
export const quitGuard: QuitGuard = createQuitGuard();
