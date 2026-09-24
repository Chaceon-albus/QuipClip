/**
 * The quit guard of ADR 027: one path for every way to close, and the confirmation before
 * another video replaces the open one.
 *
 * Every close request and every exit request that Rust held back reach `requestQuit`. When
 * nothing would be lost, it calls `confirm_quit` at once. Otherwise it opens the quit prompt,
 * and the Quit button calls `confirm_quit`. A File > Open and a drop reach `requestOpen`,
 * which asks first when the open source has segments.
 *
 * The prompt is in a store, so the one dialog in `QuitGuardDialog` shows it, and any caller
 * can raise it. The decisions themselves are the pure rules in `quitGuard.ts`.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import { exportStore } from "@/features/export";
import { mediaStore, type ImportMediaResult } from "@/features/media";
import { settingsPanelStore } from "@/features/settings/panelStore";
import { timelineStore } from "@/features/timeline";
import { BACKEND_COMMANDS, invokeCommand } from "@/lib/ipc";
import {
  decideQuit,
  decideReplace,
  type QuitGuardInput,
  type QuitLoss,
} from "./quitGuard";

/** The confirmation that the dialog shows, or null when it is closed. */
export type QuitGuardPrompt =
  | { readonly kind: "quit"; readonly loss: QuitLoss }
  | {
      readonly kind: "replace";
      readonly segments: number;
      readonly pendingIn: boolean;
    };

export interface QuitGuardState {
  readonly prompt: QuitGuardPrompt | null;
}

/** Dependencies that a test can inject. Each one defaults to the production value. */
export interface QuitGuardDependencies {
  /** Reads the timeline, the export status, the preset draft, and the open video now. */
  readInput?: () => QuitGuardInput;
  /**
   * Asks Rust to end the application. The promise can resolve before the application ends,
   * because Rust only queues the exit, and it can also never settle.
   */
  confirmQuit?: () => Promise<unknown>;
  /** Opens a video. Defaults to `importPath` of the media store. */
  importPath?: (path: string) => Promise<ImportMediaResult | null>;
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
   * Opens a video, or first asks to replace the open one when it has segments. The file that
   * is already open opens again with no question. Resolves with the import result, or with
   * null when the user cancels or when a prompt is already open.
   */
  requestOpen: (path: string) => Promise<ImportMediaResult | null>;
  /** The confirm button of the prompt: quits, or opens the video that the prompt is about. */
  confirm: () => void;
  /** The Cancel button, Escape, or any other dismissal of the prompt. Changes nothing else. */
  cancel: () => void;
}

/** Reads the production stores. */
export function readQuitGuardInput(): QuitGuardInput {
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
    unsavedPresetName: settingsPanelStore.getState().unsavedPresetName,
    openMediaPath: mediaStore.getState().media?.path ?? null,
  };
}

async function invokeConfirmQuit(): Promise<unknown> {
  return await invokeCommand<unknown>(BACKEND_COMMANDS.CONFIRM_QUIT);
}

export function createQuitGuard(dependencies: QuitGuardDependencies = {}): QuitGuard {
  const readInput = dependencies.readInput ?? readQuitGuardInput;
  const confirmQuit = dependencies.confirmQuit ?? invokeConfirmQuit;
  const importPath =
    dependencies.importPath ??
    ((path: string) => mediaStore.getState().importPath(path));

  const store = createStore<QuitGuardState>()(() => ({ prompt: null }));

  // The path of the replace prompt and the resolver of its `requestOpen`. Kept out of the
  // store, because the dialog does not render them.
  let pendingOpen: {
    path: string;
    resolve: (result: ImportMediaResult | null) => void;
  } | null = null;
  // True from the call of `confirm_quit` until it fails. A call that resolves leaves it true:
  // Rust has confirmed the quit and queued the exit, so the application is ending, and a
  // later request must not show a dialog in a window that is about to close.
  let quitting = false;

  function dropPendingOpen(): void {
    const open = pendingOpen;
    pendingOpen = null;
    open?.resolve(null);
  }

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
      dropPendingOpen();
      if (!decision.ask) {
        store.setState({ prompt: null });
        quit();
        return;
      }
      store.setState({ prompt: { kind: "quit", loss: decision.loss } });
    },

    requestOpen: (path: string) => {
      // The dialog is modal, so no entry point can reach this while it is open. The test is a
      // guard, so that a second request never takes the place of an unanswered one.
      if (quitting || store.getState().prompt !== null) {
        return Promise.resolve(null);
      }
      const decision = decideReplace(readInput(), path);
      if (!decision.ask) {
        return importPath(path);
      }
      store.setState({
        prompt: {
          kind: "replace",
          segments: decision.segments,
          pendingIn: decision.pendingIn,
        },
      });
      return new Promise<ImportMediaResult | null>((resolve) => {
        pendingOpen = { path, resolve };
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
      const open = pendingOpen;
      pendingOpen = null;
      if (open !== null) {
        importPath(open.path).then(open.resolve, () => {
          open.resolve(null);
        });
      }
    },

    cancel: () => {
      if (store.getState().prompt !== null) {
        store.setState({ prompt: null });
      }
      dropPendingOpen();
    },
  };
}

/** The quit guard of the application. `QuitGuardDialog` shows its prompt. */
export const quitGuard: QuitGuard = createQuitGuard();
