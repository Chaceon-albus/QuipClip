/**
 * Export store managing export rendering lifecycle, active runId, and progress events.
 *
 * Implements:
 * - Pre-invocation subscription to prevent losing early started/progress events.
 * - Monotonic counter & active runId matching for latest-request-wins semantics.
 * - Idempotent, memoized event subscription holding a Tauri listener for the process lifetime.
 * - ADR 002, ADR 007, ADR 011, and ADR 014.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { UnlistenFn } from "@/lib/ipc";
import { cancelActiveExport, cancelExport, startExport } from "./client";
import { subscribeExportProgress } from "./events";
import {
  ExportError,
  type ExportProgressEvent,
  type ExportRequest,
  type ExportStart,
  type ExportState,
  type ExportStoreState,
} from "./types";
import { normalizeExportError } from "./validation";

/**
 * Dependencies that can be injected into the export store factory for testing.
 */
export interface ExportStoreDependencies {
  /**
   * Function to start export via backend command. Defaults to `startExport`.
   */
  startExport?: (request: ExportRequest) => Promise<ExportStart>;
  /**
   * Function to cancel export via backend command. Defaults to `cancelExport`.
   */
  cancelExport?: (runId: string) => Promise<boolean>;
  /**
   * Function to cancel whichever run holds the backend export slot, for the window in which
   * this store holds no run id. Defaults to `cancelActiveExport`.
   */
  cancelActiveExport?: () => Promise<boolean>;
  /**
   * Function to subscribe to backend export progress events. Defaults to `subscribeExportProgress`.
   */
  subscribeExportProgress?: (
    handler: (event: ExportProgressEvent) => void,
  ) => Promise<UnlistenFn>;
}

/**
 * Factory function creating a vanilla Zustand store instance for export state.
 *
 * Non-serializable state (request counter, active run id, unlisten function, pending event buffer)
 * lives strictly in the factory closure to ensure public store state remains serializable.
 *
 * @param dependencies Injected dependencies for testability.
 * @param initialState Optional initial state overrides.
 */
export function createExportStore(
  dependencies: ExportStoreDependencies = {},
  initialState?: Partial<ExportState>,
): StoreApi<ExportStoreState> {
  const startExportFn = dependencies.startExport ?? startExport;
  const cancelExportFn = dependencies.cancelExport ?? cancelExport;
  const cancelActiveExportFn = dependencies.cancelActiveExport ?? cancelActiveExport;
  const subscribeExportProgressFn =
    dependencies.subscribeExportProgress ?? subscribeExportProgress;

  let latestRequestId = 0;
  let activeRunId: string | null = initialState?.runId ?? null;
  let subscriptionPromise: Promise<UnlistenFn> | null = null;
  let activeUnlisten: UnlistenFn | null = null;
  let pendingEvents: ExportProgressEvent[] = [];
  let awaitingRunId = false;

  return createStore<ExportStoreState>()((set, get) => {
    function handleEvent(event: ExportProgressEvent): void {
      if (awaitingRunId && !activeRunId) {
        pendingEvents.push(event);
        return;
      }

      // MUST ignore any payload whose runId is not the active run
      if (!activeRunId || event.runId !== activeRunId) {
        return;
      }

      switch (event.event) {
        case "started": {
          set({
            status: "running",
            outputPath: event.outputPath,
            segmentCount: event.segmentCount,
            expectedFrames: event.expectedFrames ?? null,
          });
          break;
        }
        case "progress": {
          set((state) => ({
            status: state.status === "preparing" ? "running" : state.status,
            frame: event.frame,
            expectedFrames:
              event.expectedFrames !== undefined
                ? event.expectedFrames
                : state.expectedFrames,
            fps: event.fps !== undefined ? event.fps : state.fps,
            speed: event.speed !== undefined ? event.speed : state.speed,
          }));
          break;
        }
        case "publishing": {
          set({
            status: "publishing",
          });
          break;
        }
        case "finished": {
          activeRunId = null;
          set({
            status: "finished",
            outputPath: event.outputPath,
            frame: event.frames,
            error: null,
          });
          break;
        }
        case "failed": {
          activeRunId = null;
          const normalizedError = new ExportError({
            code: event.code,
            detail: event.detail,
            exitCode: event.exitCode,
            encoder: event.encoder,
          });
          set({
            status: event.code === "canceled" ? "canceled" : "failed",
            error: normalizedError,
          });
          break;
        }
      }
    }

    async function ensureSubscribed(): Promise<void> {
      if (!subscriptionPromise) {
        const currentPromise = subscribeExportProgressFn((event) => {
          handleEvent(event);
        })
          .then((unlisten) => {
            if (subscriptionPromise !== currentPromise) {
              unlisten();
              return unlisten;
            }
            activeUnlisten = unlisten;
            return unlisten;
          })
          .catch((e) => {
            if (subscriptionPromise === currentPromise) {
              subscriptionPromise = null;
              activeUnlisten = null;
            }
            throw e;
          });
        subscriptionPromise = currentPromise;
      }
      await subscriptionPromise;
    }

    function unsubscribe(): void {
      if (activeUnlisten) {
        activeUnlisten();
        activeUnlisten = null;
      }
      subscriptionPromise = null;
      latestRequestId++;
      awaitingRunId = false;
      pendingEvents = [];
    }

    function reportError(error: unknown): void {
      const normalized = normalizeExportError(error);
      if (!activeRunId) {
        // Invalidate only a start that has not yet learned its run id. A run that reported one
        // keeps its tracking: the backend is still writing, and the user must still be able to
        // cancel it.
        latestRequestId++;
        awaitingRunId = false;
        pendingEvents = [];
      }
      set({
        status: normalized.code === "canceled" ? "canceled" : "failed",
        error: normalized,
      });
    }

    return {
      status: initialState?.status ?? "idle",
      runId: initialState?.runId ?? null,
      outputPath: initialState?.outputPath ?? null,
      segmentCount: initialState?.segmentCount ?? 0,
      frame: initialState?.frame ?? null,
      expectedFrames: initialState?.expectedFrames ?? null,
      fps: initialState?.fps ?? null,
      speed: initialState?.speed ?? null,
      cancelRequested: initialState?.cancelRequested ?? false,
      error: initialState?.error ?? null,

      ensureSubscribed,
      unsubscribe,
      reportError,

      reset: () => {
        latestRequestId++;
        activeRunId = null;
        awaitingRunId = false;
        pendingEvents = [];
        set({
          status: "idle",
          runId: null,
          outputPath: null,
          segmentCount: 0,
          frame: null,
          expectedFrames: null,
          fps: null,
          speed: null,
          cancelRequested: false,
          error: null,
        });
      },

      cancelExport: async (): Promise<boolean> => {
        const runId = activeRunId;
        if (!runId) {
          // "preparing" with no run id is the one phase where a cancel is still meaningful
          // without one. `start_export` claims the single export slot, prepares -- a re-probe
          // alone is bounded at 30 seconds -- and answers with the run id only afterward, so
          // there is nothing to name yet and the run is already holding the slot. The backend
          // cancels by slot instead; `cancel_active_export` carries the argument for why the
          // run holding the slot in this window is the one this store just started. Every
          // other status with no run id has no run to stop.
          if (get().status !== "preparing") {
            return false;
          }
          // The identity of a start that has no run id yet is its request id. Snapshot it
          // here, the way the by-id path below snapshots the run id, so the rejection is
          // matched against the start it was made for. "preparing" alone is not an identity:
          // every start passes through it, so a store that was reset AND started again would
          // take a stale rejection into a run this call knows nothing about.
          const requestId = latestRequestId;
          const isSameActiveStart = (): boolean => {
            const currentStatus = get().status;
            return (
              requestId === latestRequestId &&
              (currentStatus === "preparing" ||
                currentStatus === "running" ||
                currentStatus === "publishing")
            );
          };
          set({ cancelRequested: true });
          try {
            const accepted = await cancelActiveExportFn();
            if (isSameActiveStart()) {
              set({ cancelRequested: accepted });
            }
            return accepted;
          } catch (err) {
            if (isSameActiveStart()) {
              set({ cancelRequested: false });
            }
            // Report only while the store is still waiting on the same start. A run that
            // reported its id in the meantime is tracked and can be cancelled again, a store
            // that was reset or started again has moved on, and a start that failed on its
            // own already shows the better error.
            if (
              requestId === latestRequestId &&
              !activeRunId &&
              get().status === "preparing"
            ) {
              reportError(err);
            }
            return false;
          }
        }
        set({ cancelRequested: true });
        try {
          const accepted = await cancelExportFn(runId);
          if (activeRunId === runId) {
            set({ cancelRequested: accepted });
          }
          return accepted;
        } catch (err) {
          // A rejection that lands after the run changed belongs to nobody.
          if (activeRunId === runId) {
            set({ cancelRequested: false });
            reportError(err);
          }
          return false;
        }
      },

      startExport: async (request: ExportRequest): Promise<ExportStart | null> => {
        const requestId = ++latestRequestId;
        activeRunId = null;
        awaitingRunId = true;
        pendingEvents = [];

        set({
          status: "preparing",
          runId: null,
          outputPath: request.outputPath,
          segmentCount: request.segments.length,
          frame: null,
          expectedFrames: null,
          fps: null,
          speed: null,
          cancelRequested: false,
          error: null,
        });

        try {
          // Acceptance criterion: subscribe BEFORE invoking the command
          await ensureSubscribed();

          if (requestId !== latestRequestId) {
            // A superseded run MUST NOT touch the buffering state: the successor
            // (or reset) already owns it.
            return null;
          }

          const start = await startExportFn(request);

          if (requestId !== latestRequestId) {
            // A superseded run MUST NOT touch the buffering state: the successor
            // (or reset) already owns it.
            return null;
          }

          activeRunId = start.runId;
          awaitingRunId = false;

          set({
            runId: start.runId,
            outputPath: start.outputPath,
            segmentCount: start.segmentCount,
            expectedFrames: start.expectedFrames ?? null,
          });

          const buffered = pendingEvents;
          pendingEvents = [];
          for (const e of buffered) {
            handleEvent(e);
          }

          return start;
        } catch (err) {
          const normalized = normalizeExportError(err);

          if (requestId !== latestRequestId) {
            // A superseded run MUST NOT touch the buffering state: the successor
            // (or reset) already owns it.
            return null;
          }

          activeRunId = null;
          awaitingRunId = false;
          pendingEvents = [];

          set({
            status: normalized.code === "canceled" ? "canceled" : "failed",
            runId: null,
            error: normalized,
          });

          return null;
        }
      },
    };
  });
}

export type ExportStore = ReturnType<typeof createExportStore>;

/**
 * Default singleton export store for production application use.
 */
export const exportStore: ExportStore = createExportStore();

const defaultSelector = (state: ExportStoreState): ExportStoreState => state;

/**
 * React hook for consuming the production export store.
 */
export function useExportStore(): ExportStoreState;
export function useExportStore<T>(selector: (state: ExportStoreState) => T): T;
export function useExportStore<T>(
  selector?: (state: ExportStoreState) => T,
): T | ExportStoreState {
  return useStore(
    exportStore,
    (selector ?? defaultSelector) as (state: ExportStoreState) => T,
  );
}
