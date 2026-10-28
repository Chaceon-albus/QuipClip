/**
 * State of the show request for the runs that the export interface lists.
 *
 * The export dialog and the status bar result both show the file in Finder (or in File
 * Explorer). A failure must show inline in the dialog, and the status bar has no room for it,
 * so the failure is held here where both can read it. The status bar opens the dialog on a
 * failure, and the dialog then shows the message.
 *
 * The state is kept per run id, because the dialog lists the runs of a queue that ended, and
 * each of them has Show File (ADR 049). A view reads the state of its run through
 * `selectExportOutputAction`. `bindOutputActionsToExportRun` drops the state of the runs that
 * the interface no longer lists.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  normalizeExportOutputError,
  revealExportOutput,
  type ExportOutputError,
} from "./output";
import { exportQueueStore, type ExportQueueState } from "./queueStore";
import { exportStore } from "./store";
import type { ExportStoreState } from "./types";

/** The state of the show request of one run. */
export type ExportOutputActionRunState = {
  /** True while a request for the run is in flight. */
  pending: boolean;
  /** The error of the last failed request for the run, or null. A new request removes it. */
  error: ExportOutputError | null;
};

/** The state of a run with no request in flight and no failure. */
export const NO_EXPORT_OUTPUT_ACTION: ExportOutputActionRunState = {
  pending: false,
  error: null,
};

export type ExportOutputActionState = {
  /**
   * The state of each run that has one, by run id. A run with no entry has no request in
   * flight and no failure. Read it through `selectExportOutputAction`.
   */
  runs: Record<string, ExportOutputActionRunState>;
};

/**
 * - `succeeded`: the operating system accepted the request.
 * - `failed`: the request failed, and the state of the run holds the error.
 * - `ignored`: a request for the same run was in flight, or the state of the run was dropped
 *   before the answer came.
 */
export type ExportOutputActionOutcome = "succeeded" | "failed" | "ignored";

export type ExportOutputActionStoreState = ExportOutputActionState & {
  /** Shows the published file of the run `runId` in Finder or in File Explorer. */
  reveal: (runId: string) => Promise<ExportOutputActionOutcome>;
  /** Drops the state of every run that `runIds` does not hold. */
  retain: (runIds: Iterable<string>) => void;
  /** Drops the state of every run. */
  clear: () => void;
};

export interface ExportOutputActionStoreDependencies {
  perform?: (runId: string) => Promise<void>;
}

/**
 * Gives the state of the show request of the run `runId`.
 *
 * The result is the object that the store holds, or `NO_EXPORT_OUTPUT_ACTION`. So it stays
 * the same object until the state of that run changes, and a React selector can return it.
 */
export function selectExportOutputAction(
  state: ExportOutputActionState,
  runId: string | null,
): ExportOutputActionRunState {
  return (runId !== null ? state.runs[runId] : undefined) ?? NO_EXPORT_OUTPUT_ACTION;
}

export function createExportOutputActionStore(
  dependencies: ExportOutputActionStoreDependencies = {},
): StoreApi<ExportOutputActionStoreState> {
  const perform =
    dependencies.perform ?? ((runId: string) => revealExportOutput(runId));
  // The token of the request in flight for each run. A drop of the run removes its token, so
  // an answer that comes after the drop changes nothing and cannot bring back its state.
  const inFlight = new Map<string, number>();
  let nextToken = 0;

  return createStore<ExportOutputActionStoreState>()((set, get) => ({
    runs: {},

    reveal: async (runId) => {
      // One request per run at a time. A second click while the first request is in flight
      // must not ask the file manager twice.
      if (inFlight.has(runId)) {
        return "ignored";
      }
      const token = ++nextToken;
      inFlight.set(runId, token);
      set((state) => ({
        runs: { ...state.runs, [runId]: { pending: true, error: null } },
      }));
      const settle = (error: ExportOutputError | null): boolean => {
        if (inFlight.get(runId) !== token) {
          return false;
        }
        inFlight.delete(runId);
        set((state) => {
          const runs = { ...state.runs };
          if (error === null) {
            delete runs[runId];
          } else {
            runs[runId] = { pending: false, error };
          }
          return { runs };
        });
        return true;
      };
      try {
        await perform(runId);
      } catch (error) {
        return settle(normalizeExportOutputError(error)) ? "failed" : "ignored";
      }
      return settle(null) ? "succeeded" : "ignored";
    },

    retain: (runIds) => {
      const kept = new Set(runIds);
      for (const runId of [...inFlight.keys()]) {
        if (!kept.has(runId)) {
          inFlight.delete(runId);
        }
      }
      const runs = get().runs;
      const dropped = Object.keys(runs).filter((runId) => !kept.has(runId));
      if (dropped.length === 0) {
        return;
      }
      const next = { ...runs };
      for (const runId of dropped) {
        delete next[runId];
      }
      set({ runs: next });
    },

    clear: () => {
      inFlight.clear();
      set({ runs: {} });
    },
  }));
}

export type ExportOutputActionStore = ReturnType<typeof createExportOutputActionStore>;

/** The part of the export queue store that tells which runs belong to the batch. */
export type ExportOutputActionQueueSource = Pick<
  StoreApi<Pick<ExportQueueState, "order">>,
  "getState" | "subscribe"
>;

/**
 * Drops the state of the runs that the interface no longer lists.
 *
 * The interface lists the run of the export store and the runs of the batch of the queue,
 * which `order` holds. The state of those runs stays. So a queued run that takes the slot
 * does not remove the pending request or the failure of a run that ended before it.
 *
 * The binding applies this rule each time the run id of `source` changes and each time the
 * `order` of `queue` changes. So the result does not depend on the order of the listeners:
 *
 * - An adoption, or a reset while runs wait, leaves the run before in `order`. The queue
 *   store keeps it there whether or not it archived the run yet.
 * - A new batch empties `order` (`emptyBatch` in the queue store) before its start changes
 *   the run id of the export store.
 * - A reset that ends the batch empties `order` from a listener of the export store. When
 *   that listener runs after this binding, the change of `order` applies the rule again.
 *
 * Returns the function that ends the binding.
 */
export function bindOutputActionsToExportRun(
  source: StoreApi<ExportStoreState>,
  outputActions: ExportOutputActionStore,
  queue: ExportOutputActionQueueSource = exportQueueStore,
): () => void {
  const apply = () => {
    const shown = [...queue.getState().order];
    const runId = source.getState().runId;
    if (runId !== null) {
      shown.push(runId);
    }
    outputActions.getState().retain(shown);
  };
  const unsubscribeSource = source.subscribe((state, previous) => {
    if (state.runId !== previous.runId) {
      apply();
    }
  });
  const unsubscribeQueue = queue.subscribe((state, previous) => {
    if (state.order !== previous.order) {
      apply();
    }
  });
  return () => {
    unsubscribeSource();
    unsubscribeQueue();
  };
}

export const exportOutputActionStore: ExportOutputActionStore =
  createExportOutputActionStore();

// The binding lasts for the life of the web view, the same as the stores. A hot reload of
// this module in development makes a new store and a new binding, and the dispose callback
// below ends the old binding.
const unbindOutputActions = bindOutputActionsToExportRun(
  exportStore,
  exportOutputActionStore,
);
import.meta.hot?.dispose(() => {
  unbindOutputActions();
});

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
