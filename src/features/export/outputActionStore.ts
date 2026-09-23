/**
 * State of the show and open requests for a finished export.
 *
 * The export dialog and the status bar result both offer "Show in Finder" (or "Show in File
 * Explorer"). A failure must show inline in the dialog, and the status bar has no room for
 * it, so the failure is held here where both can read it. The status bar opens the dialog on a
 * failure, and the dialog then shows the message.
 *
 * The state belongs to one run. `bindOutputActionsToExportRun` clears it each time the run id
 * of the export store changes, which covers every reset of that store and every new start.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  normalizeExportOutputError,
  performExportOutputAction,
  type ExportOutputAction,
  type ExportOutputError,
} from "./output";
import { exportStore } from "./store";
import type { ExportStoreState } from "./types";

export type ExportOutputActionPending = {
  /** The run that the request names. */
  runId: string;
  action: ExportOutputAction;
};

export type ExportOutputActionFailure = {
  /** The run that the failed request named. A view shows it only for that run. */
  runId: string;
  action: ExportOutputAction;
  error: ExportOutputError;
};

export type ExportOutputActionState = {
  /** The request in flight, or null. A view shows it as busy only for its run. */
  pending: ExportOutputActionPending | null;
  /** The last failed request, or null. A new request or `clear` removes it. */
  failure: ExportOutputActionFailure | null;
};

/**
 * - `succeeded`: the operating system accepted the request.
 * - `failed`: the request failed, and `failure` holds the error.
 * - `ignored`: a request for the same run was in flight, or `clear` ran before the answer
 *   came.
 */
export type ExportOutputActionOutcome = "succeeded" | "failed" | "ignored";

export type ExportOutputActionStoreState = ExportOutputActionState & {
  run: (
    action: ExportOutputAction,
    runId: string,
  ) => Promise<ExportOutputActionOutcome>;
  /** Removes the failure and forgets the request in flight. */
  clear: () => void;
};

export interface ExportOutputActionStoreDependencies {
  perform?: (action: ExportOutputAction, runId: string) => Promise<void>;
}

export function createExportOutputActionStore(
  dependencies: ExportOutputActionStoreDependencies = {},
): StoreApi<ExportOutputActionStoreState> {
  const perform =
    dependencies.perform ??
    ((action: ExportOutputAction, runId: string) =>
      performExportOutputAction(action, runId));
  // Each `clear` starts a new generation. An answer from an older generation changes nothing,
  // so a request that answers after its run ended cannot bring back its state.
  let generation = 0;

  return createStore<ExportOutputActionStoreState>()((set, get) => ({
    pending: null,
    failure: null,

    run: async (action, runId) => {
      // One request per run at a time. A second click while the first request is in flight
      // must not open the file twice.
      if (get().pending?.runId === runId) {
        return "ignored";
      }
      const requestGeneration = generation;
      set({ pending: { runId, action }, failure: null });
      try {
        await perform(action, runId);
        if (requestGeneration !== generation) {
          return "ignored";
        }
        set({ pending: null });
        return "succeeded";
      } catch (error) {
        if (requestGeneration !== generation) {
          return "ignored";
        }
        set({
          pending: null,
          failure: { runId, action, error: normalizeExportOutputError(error) },
        });
        return "failed";
      }
    },

    clear: () => {
      generation++;
      set({ pending: null, failure: null });
    },
  }));
}

export type ExportOutputActionStore = ReturnType<typeof createExportOutputActionStore>;

/**
 * Clears `outputActions` each time the run id of `source` changes.
 *
 * The run id changes on every reset of the export store (the dialog, the status bar dismiss,
 * and the export flow reset a final status) and on every new start. So the state of a run
 * never outlives that run. Returns the function that ends the binding.
 */
export function bindOutputActionsToExportRun(
  source: StoreApi<ExportStoreState>,
  outputActions: ExportOutputActionStore,
): () => void {
  return source.subscribe((state, previous) => {
    if (state.runId !== previous.runId) {
      outputActions.getState().clear();
    }
  });
}

export const exportOutputActionStore: ExportOutputActionStore =
  createExportOutputActionStore();

// The binding lasts for the life of the web view, the same as both stores.
bindOutputActionsToExportRun(exportStore, exportOutputActionStore);

const defaultSelector = (
  state: ExportOutputActionStoreState,
): ExportOutputActionStoreState => state;

export function useExportOutputActionStore(): ExportOutputActionStoreState;
export function useExportOutputActionStore<T>(
  selector: (state: ExportOutputActionStoreState) => T,
): T;
export function useExportOutputActionStore<T>(
  selector?: (state: ExportOutputActionStoreState) => T,
): T | ExportOutputActionStoreState {
  return useStore(
    exportOutputActionStore,
    (selector ?? defaultSelector) as (state: ExportOutputActionStoreState) => T,
  );
}
