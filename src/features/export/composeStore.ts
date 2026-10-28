/**
 * Export compose store: the state of the setup of a new export while another export runs or
 * waits (ADR 049).
 *
 * While the export store holds a live run, while runs wait in the queue, or while a
 * submission has no answer yet, the Export action sets up the next export, which joins the
 * queue. The OPEN and START steps of that setup can fail before a run exists:
 * `sourceNotFound`, `noSegments`, the `sourceRevisionChanged` confirmation, `presetNotFound`,
 * `dialogFailed`, `outputAlreadyQueued`, and the normalized refusal of `start_export` for a
 * run that joins the queue. This store holds those failures. The export
 * store keeps the live run, so a failure of the setup never replaces it.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ExportRunLiveState } from "./runState";
import type { ExportError } from "./types";
import { normalizeExportError } from "./validation";

/** Public state of the export compose store. */
export type ExportComposeState = {
  /** True while the export dialog sets up an export that joins the queue. */
  composing: boolean;
  /** `failed` while the setup shows a failure of its OPEN or START step. */
  status: "idle" | "failed";
  /** The failure that `status` shows, or null. */
  error: ExportError | null;
};

/** Actions of the export compose store. */
export type ExportComposeActions = {
  /** Starts the compose state. The failure of an earlier setup stays until `reset`. */
  enter: () => void;
  /** Ends the compose state and clears its failure. */
  exit: () => void;
  /** Clears the failure, so the setup step shows again. The compose state stays. */
  reset: () => void;
  /**
   * Records a failure of the OPEN or START step of the setup. It normalizes the error like
   * the `reportError` of the export store.
   *
   * It also starts the compose state. A refusal can come after the user left the compose
   * state, and the next open of the dialog must show it. The OPEN step of a new setup resets
   * the failure when it runs its checks.
   *
   * A `canceled` report changes nothing. This store has no canceled status, and a canceled
   * setup has no failure to show.
   */
  reportError: (error: unknown) => void;
};

/** Combined type of the export compose state and actions. */
export type ExportComposeStoreState = ExportComposeState & ExportComposeActions;

/** Factory function creating a vanilla Zustand store instance for the compose state. */
export function createExportComposeStore(
  initialState?: Partial<ExportComposeState>,
): StoreApi<ExportComposeStoreState> {
  return createStore<ExportComposeStoreState>()((set) => ({
    composing: initialState?.composing ?? false,
    status: initialState?.status ?? "idle",
    error: initialState?.error ?? null,
    enter: () => {
      set({ composing: true });
    },
    exit: () => {
      set({ composing: false, status: "idle", error: null });
    },
    reset: () => {
      set({ status: "idle", error: null });
    },
    reportError: (error: unknown) => {
      const normalized = normalizeExportError(error);
      if (normalized.code === "canceled") {
        return;
      }
      set({ composing: true, status: "failed", error: normalized });
    },
  }));
}

export type ExportComposeStore = ReturnType<typeof createExportComposeStore>;

/** Default singleton export compose store for production application use. */
export const exportComposeStore: ExportComposeStore = createExportComposeStore();

/**
 * The three options of the export flow controller that decide where the OPEN and START steps
 * read the state, report a failure, and reset.
 */
export type ExportFlowTarget = {
  getExportState: () => ExportRunLiveState;
  reportError: (error: unknown) => void;
  reset: () => void;
};

/**
 * Binds the three target options of the export flow controller to a compose store.
 *
 * `getExportState` answers the status of the compose store with `tracking` false. The
 * compose store never holds a run, so this state is never live (`isExportRunLive`).
 */
export function createComposeFlowTarget(
  store: ExportComposeStore = exportComposeStore,
): ExportFlowTarget {
  return {
    getExportState: () => ({ status: store.getState().status, tracking: false }),
    reportError: (error) => {
      store.getState().reportError(error);
    },
    reset: () => {
      store.getState().reset();
    },
  };
}

/** The target options bound to the production compose store. */
export const composeFlowTarget: ExportFlowTarget = createComposeFlowTarget();

const defaultSelector = (state: ExportComposeStoreState): ExportComposeStoreState =>
  state;

/** React hook for consuming the production export compose store. */
export function useExportComposeStore(): ExportComposeStoreState;
export function useExportComposeStore<T>(
  selector: (state: ExportComposeStoreState) => T,
): T;
export function useExportComposeStore<T>(
  selector?: (state: ExportComposeStoreState) => T,
): T | ExportComposeStoreState {
  return useStore(
    exportComposeStore,
    (selector ?? defaultSelector) as (state: ExportComposeStoreState) => T,
  );
}
