/**
 * The scopes of the export flow (ADR 067): the scope of each setup step, and the scope that each
 * answer to a request keeps.
 *
 * The dialog has two places that can show a setup step, a check error or a failure: the export
 * store, and the compose store of a new export while a run is active or waits (ADR 049). The
 * dialog switches between them, and each can hold a step while the other shows. So each of the
 * two flow targets has its own setup scope (`ExportScopeTarget`). A step writes only the scope of
 * its own target, and a reader reads only the scope of the target that it acts on.
 *
 * The scope goes with each step of the flow, and no step reads a scope that another step set
 * later:
 *
 * - An open step publishes its scope as the scope of the setup step of its target
 *   (`publishSetup`) only when it shows the setup step or the error of its checks.
 * - The confirm step reads the scope of the setup step one time, when the user confirms, and
 *   uses it for everything that it does afterward.
 * - A run that the queue takes keeps the scope of its request by the id of the run (`keepRun`).
 *   The store keeps it only for the runs that the dialog can show: the run of the export store
 *   and the runs of the batch of the queue.
 * - A failure with no run id, such as a refusal of the queue or a start that the backend refused,
 *   keeps the scope with that failure (`keepFailure`). The failure is the error instance that the
 *   export store or the compose store holds, and the scope is reachable only through that
 *   instance (`failureScope`). So the scope stays with the failure in the store that holds it,
 *   and it goes when that store drops the failure. Neither keep changes the scope of a setup step
 *   that shows.
 * - A setup step that no step opened has the whole export. When a caller that is no open step and
 *   no Back makes the dialog show the export store while that store is idle, the scope of the
 *   setup step of the target `export` becomes the whole export (`showExportStoreTarget`).
 *
 * Back reads the kept scope of the result or the failure that it leaves (`scopeOfBack`).
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { exportQueueStore } from "./queueStore";
import { WHOLE_EXPORT_SCOPE, type ExportScope } from "./scope";
import { exportStore } from "./store";
import type { ExportError } from "./types";

/**
 * A flow target of the dialog (ADR 049): `export`, the export store, or `compose`, the compose
 * store of a new export while a run is active or waits.
 */
export type ExportScopeTarget = "export" | "compose";

/** Public state of the export scope store. */
export type ExportScopeState = {
  /**
   * The scope of the setup step of each flow target. A scope stays when the dialog hides or
   * closes, and when the dialog shows the other target.
   */
  setup: Readonly<Record<ExportScopeTarget, ExportScope>>;
};

/** Actions of the export scope store. */
export type ExportScopeActions = {
  /** Sets the scope of the setup step of `target`. The scope of the other target stays. */
  publishSetup: (target: ExportScopeTarget, scope: ExportScope) => void;
  /**
   * Keeps the scope of the request of a run that the queue took. It drops the scopes of the runs
   * that the dialog can no longer show.
   */
  keepRun: (runId: string, scope: ExportScope) => void;
  /** The scope that `keepRun` kept for the run, or undefined when it kept none. */
  runScope: (runId: string) => ExportScope | undefined;
  /** Keeps the scope of a request with its failure, which has no run id. */
  keepFailure: (error: ExportError, scope: ExportScope) => void;
  /** The scope that `keepFailure` kept with the failure, or undefined when it kept none. */
  failureScope: (error: ExportError | null) => ExportScope | undefined;
};

/** Combined type of the export scope state and actions. */
export type ExportScopeStoreState = ExportScopeState & ExportScopeActions;

/** The dependencies of the export scope store. */
export interface ExportScopeStoreDependencies {
  /**
   * The ids of the runs that the dialog can show now. Defaults to the run of the export store
   * and the runs of the batch of the queue store.
   */
  shownRunIds?: () => Iterable<string>;
}

/** The ids of the runs that the production dialog can show. */
function productionShownRunIds(): string[] {
  const runId = exportStore.getState().runId;
  const order = exportQueueStore.getState().order;
  return runId === null ? [...order] : [runId, ...order];
}

/** Factory function creating a vanilla Zustand store instance for the scopes of the flow. */
export function createExportScopeStore(
  dependencies: ExportScopeStoreDependencies = {},
): StoreApi<ExportScopeStoreState> {
  const shownRunIds = dependencies.shownRunIds ?? productionShownRunIds;
  // Not in the public state: the dialog reads a kept scope only when Back runs.
  const runs = new Map<string, ExportScope>();
  const failures = new WeakMap<ExportError, ExportScope>();
  return createStore<ExportScopeStoreState>()((set) => ({
    setup: { export: WHOLE_EXPORT_SCOPE, compose: WHOLE_EXPORT_SCOPE },
    publishSetup: (target, scope) => {
      set((state) => ({ setup: { ...state.setup, [target]: scope } }));
    },
    keepRun: (runId, scope) => {
      const shown = new Set(shownRunIds());
      for (const id of [...runs.keys()]) {
        if (!shown.has(id)) {
          runs.delete(id);
        }
      }
      runs.set(runId, scope);
    },
    runScope: (runId) => runs.get(runId),
    keepFailure: (error, scope) => {
      failures.set(error, scope);
    },
    failureScope: (error) => (error === null ? undefined : failures.get(error)),
  }));
}

export type ExportScopeStore = ReturnType<typeof createExportScopeStore>;

/** Default singleton export scope store for production application use. */
export const exportScopeStore: ExportScopeStore = createExportScopeStore();

/** The failure or the result that Back leaves: the state of the target of the dialog. */
export interface BackTarget {
  /** The run of the result, or null for a failure with no run, as the compose store has. */
  readonly runId: string | null;
  readonly error: ExportError | null;
}

/**
 * The scope that the setup step takes when the user presses Back (ADR 067), or null when it
 * keeps its scope.
 *
 * - The result or the failure of a run: the scope that the run kept, or the whole export for a
 *   run with no kept scope, such as a run from before the page loaded again (ADR 051).
 * - A failure of a request with no run id: the scope that the failure kept.
 * - The error of an open step keeps no scope: that open step set the scope of the setup step of
 *   its target, which stays.
 */
export function scopeOfBack(
  target: BackTarget,
  scopes: Pick<ExportScopeActions, "runScope" | "failureScope">,
): ExportScope | null {
  if (target.runId !== null) {
    return scopes.runScope(target.runId) ?? WHOLE_EXPORT_SCOPE;
  }
  return scopes.failureScope(target.error) ?? null;
}

const defaultSelector = (state: ExportScopeStoreState): ExportScopeStoreState => state;

/** React hook for consuming the production export scope store. */
export function useExportScopeStore(): ExportScopeStoreState;
export function useExportScopeStore<T>(
  selector: (state: ExportScopeStoreState) => T,
): T;
export function useExportScopeStore<T>(
  selector?: (state: ExportScopeStoreState) => T,
): T | ExportScopeStoreState {
  return useStore(
    exportScopeStore,
    (selector ?? defaultSelector) as (state: ExportScopeStoreState) => T,
  );
}
