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
import { isExportRunLive } from "./runState";
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
 * @param initialState Optional initial state overrides. `tracking` is not one of them: it
 *   follows from `runId`, because a store created with a run id tracks that run, and a new
 *   store has no start in flight.
 */
export function createExportStore(
  dependencies: ExportStoreDependencies = {},
  initialState?: Partial<Omit<ExportState, "tracking">>,
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
    /**
     * Writes `patch` with the public `tracking` field. The store tracks a start that waits
     * for its run id, and then the run that the id names. Every change of `activeRunId` or
     * `awaitingRunId` after creation is followed by a call of this function or of
     * `setTrackedRun`, and the initial `tracking` comes from the initial `activeRunId`, so
     * `tracking` always equals `activeRunId !== null || awaitingRunId`.
     */
    function publish(patch: Partial<ExportState>): void {
      set({ ...patch, tracking: activeRunId !== null || awaitingRunId });
    }

    /** Changes the tracked run, and writes `patch` with the `tracking` that follows. */
    function setTrackedRun(runId: string | null, patch: Partial<ExportState>): void {
      activeRunId = runId;
      publish(patch);
    }

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
          // `started` moves the run into `running`, a phase of its own. A Stop request that
          // failed in an earlier phase no longer describes the run, so its error clears.
          set({
            status: "running",
            encodeStarted: true,
            outputPath: event.outputPath,
            segmentCount: event.segmentCount,
            expectedFrames: event.expectedFrames ?? null,
            error: null,
          });
          break;
        }
        case "progress": {
          set((state) => ({
            status: state.status === "preparing" ? "running" : state.status,
            encodeStarted: true,
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
          // A Stop request that failed during the encode leaves `failed` until here. The
          // publication shows as its own phase, so that failure no longer shows either.
          set({
            status: "publishing",
            error: null,
          });
          break;
        }
        case "finished": {
          setTrackedRun(null, {
            status: "finished",
            outputPath: event.outputPath,
            frame: event.frames,
            error: null,
          });
          break;
        }
        case "failed": {
          const normalizedError = new ExportError({
            code: event.code,
            detail: event.detail,
            exitCode: event.exitCode,
            encoder: event.encoder,
          });
          setTrackedRun(null, {
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
      publish({});
    }

    function reportError(error: unknown): void {
      // A frontend error never replaces a live run that the store tracks (`isExportRunLive`):
      // a start that waits for its run id, or a run that the backend still prepares or
      // encodes. A `failed` status over that run would read as its end, and a reset from that
      // state would drop the only record of it. Invalidating the start would discard the
      // `start_export` answer. The store therefore ignores the report. A failed Stop request
      // has its own path, `reportStopFailure`, which keeps the tracking.
      //
      // With this test, the store holds no run id and no start in flight when it records the
      // error, so nothing is left to invalidate.
      const state = get();
      if (state.tracking && isExportRunLive(state)) {
        return;
      }
      const normalized = normalizeExportError(error);
      publish({
        status: normalized.code === "canceled" ? "canceled" : "failed",
        error: normalized,
      });
    }

    /**
     * Records a Stop request that failed while the run continues: `cancel_export` or
     * `cancel_active_export` rejected, at the IPC layer or in the client check of the answer.
     * The caller calls it only while the store still tracks the start or the run that the
     * request was for.
     *
     * The status is `failed`, and the error is the failure of the request. The start or the
     * run stays tracked: the backend did not confirm a stop, so it can still prepare and
     * encode. `reportError` ignores a report while the store tracks a live run, so this is the
     * one path that writes `failed` over a tracked run. A start that waits for its run id
     * keeps its request id, so the store takes the `start_export` answer and then tracks the
     * run to its `finished` or `failed` event. A `failed` status with `tracking` true is
     * live (`isExportRunLive`), so no control resets the store in that state, and the user
     * can ask for the stop again: by run id, or by slot while the start still waits.
     *
     * A failure in `publishing` changes nothing. The backend ran its last cancel test before
     * it sent that event (ADR 016), so no stop can prevent the rename any more, and a live
     * `failed` would offer Stop again during the rename. `publishing` therefore stays, with
     * no error. So a live `failed` never follows `publishing`.
     *
     * Each failure gets an error instance of its own, also when the rejection repeats one
     * object. The interface tells two failures apart by the instance, to announce each one.
     *
     * The status is never `canceled`. A request that failed did not stop the run. The
     * `started` and `publishing` events clear the error, because the run is then in a phase
     * of its own again.
     */
    function reportStopFailure(error: unknown): void {
      if (get().status === "publishing") {
        return;
      }
      const normalized = normalizeExportError(error);
      publish({
        status: "failed",
        error: new ExportError({
          code: normalized.code,
          detail: normalized.detail,
          exitCode: normalized.exitCode,
          encoder: normalized.encoder,
        }),
      });
    }

    /**
     * True in the window in which the store cancels by slot: it holds no run id, and its own
     * start waits for one. That start is in `preparing`, or in the `failed` of a Stop request
     * that failed while it waited (`reportStopFailure`).
     */
    function waitsForRunId(): boolean {
      return activeRunId === null && (awaitingRunId || get().status === "preparing");
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
      encodeStarted: initialState?.encodeStarted ?? false,
      // The initial value of `activeRunId`, which comes from the initial run id. No start is
      // in flight yet. Every later change goes through `publish`.
      tracking: activeRunId !== null,
      error: initialState?.error ?? null,

      ensureSubscribed,
      unsubscribe,
      reportError,

      reset: () => {
        latestRequestId++;
        awaitingRunId = false;
        pendingEvents = [];
        setTrackedRun(null, {
          status: "idle",
          runId: null,
          outputPath: null,
          segmentCount: 0,
          frame: null,
          expectedFrames: null,
          fps: null,
          speed: null,
          cancelRequested: false,
          encodeStarted: false,
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
          //
          // The same window stays open after a Stop request that failed in it. The status
          // is then `failed`, and the start still waits for its run id (`awaitingRunId`), so
          // the run that holds the slot is still the one this store started, and the user
          // can ask again.
          if (!waitsForRunId()) {
            return false;
          }
          // The identity of a start that has no run id yet is its request id. Snapshot it
          // here, the way the by-id path below snapshots the run id, so the rejection is
          // matched against the start it was made for. "preparing" alone is not an identity:
          // every start passes through it, so a store that was reset AND started again would
          // take a stale rejection into a run this call knows nothing about.
          const requestId = latestRequestId;
          // True while the store still tracks the same start, or the run that its answer
          // named, and that run is live (`isExportRunLive`): an active status, or the
          // `failed` of a Stop request that failed. An answer that arrives later belongs to
          // that run, so the store writes it.
          const isSameActiveStart = (): boolean =>
            requestId === latestRequestId && isExportRunLive(get());
          set({ cancelRequested: true });
          try {
            const accepted = await cancelActiveExportFn();
            if (isSameActiveStart()) {
              set({ cancelRequested: accepted });
            }
            return accepted;
          } catch (err) {
            // Report while the store still tracks the same start, or the run that its answer
            // named in the meantime, and that run is live. A store that was reset or started
            // again has moved on, a run that ended has its own result, and a start that
            // failed on its own already shows the better error. `reportStopFailure` keeps a
            // `publishing` status.
            //
            // The report keeps the start. The backend did not confirm the stop, so it can
            // still prepare and encode, and only the `start_export` answer names that run.
            // `reportError` ignores a report while the store tracks a live run, so the failure
            // of a Stop request takes this path.
            if (isSameActiveStart()) {
              set({ cancelRequested: false });
              reportStopFailure(err);
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
          // A rejection that lands after the run changed belongs to nobody. A rejection that
          // lands in `publishing` only clears the request (`reportStopFailure`).
          if (activeRunId === runId) {
            set({ cancelRequested: false });
            reportStopFailure(err);
          }
          return false;
        }
      },

      startExport: async (request: ExportRequest): Promise<ExportStart | null> => {
        const requestId = ++latestRequestId;
        awaitingRunId = true;
        pendingEvents = [];

        // The store tracks the start from here, before it has a run id. The backend claims
        // the export slot before it answers, so a reset from now on can drop a run that it
        // prepares or encodes.
        setTrackedRun(null, {
          status: "preparing",
          runId: null,
          outputPath: request.outputPath,
          segmentCount: request.segments.length,
          frame: null,
          expectedFrames: null,
          fps: null,
          speed: null,
          cancelRequested: false,
          encodeStarted: false,
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

          awaitingRunId = false;

          // The status is not written here. It is `preparing`, or `failed` after a Stop
          // request that failed while the start waited (`reportStopFailure`). Either way the
          // `started` event of the run changes it to `running` and clears the error.
          setTrackedRun(start.runId, {
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

          awaitingRunId = false;
          pendingEvents = [];

          setTrackedRun(null, {
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
