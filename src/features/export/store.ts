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
import { cancelExport, startExport } from "./client";
import { exportEventFloor, type ExportEventFloor } from "./eventFloor";
import { subscribeExportProgress } from "./events";
import { isExportRunLive } from "./runState";
import {
  ExportError,
  type ExportProgressEvent,
  type ExportRequest,
  type ExportRestoredRun,
  type ExportRunFacts,
  type ExportSubmission,
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
  startExport?: (request: ExportRequest) => Promise<ExportSubmission>;
  /**
   * Function to cancel export via backend command. Defaults to `cancelExport`.
   */
  cancelExport?: (runId: string) => Promise<boolean>;
  /**
   * Function to subscribe to backend export progress events. Defaults to `subscribeExportProgress`.
   */
  subscribeExportProgress?: (
    handler: (event: ExportProgressEvent) => void,
  ) => Promise<UnlistenFn>;
  /**
   * The sequence floor that a restore sets (`eventFloor.ts`). The store ignores each event at
   * or below it. Defaults to `exportEventFloor`.
   */
  eventFloor?: ExportEventFloor;
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
  const subscribeExportProgressFn =
    dependencies.subscribeExportProgress ?? subscribeExportProgress;
  const eventFloor = dependencies.eventFloor ?? exportEventFloor;

  let latestRequestId = 0;
  let activeRunId: string | null = initialState?.runId ?? null;
  let subscriptionPromise: Promise<UnlistenFn> | null = null;
  let activeUnlisten: UnlistenFn | null = null;
  let pendingEvents: ExportProgressEvent[] = [];
  let awaitingRunId = false;
  /**
   * A Stop request that came while the start waited for its run id. The backend answers
   * `start_export` as soon as it accepted the run, so the wait is short. The store sends the
   * request by id when the answer arrives, and settles each caller in `settlers` with its
   * result. `requestId` names the start that it belongs to.
   */
  let deferredCancel: {
    requestId: number;
    settlers: Array<(accepted: boolean) => void>;
  } | null = null;

  /** Settles a deferred Stop request with `accepted`, and forgets it. */
  function settleDeferredCancel(accepted: boolean): void {
    const pending = deferredCancel;
    deferredCancel = null;
    for (const settle of pending?.settlers ?? []) {
      settle(accepted);
    }
  }

  /** Settles a deferred Stop request with false, because no run of its start is live. */
  function dropDeferredCancel(): void {
    settleDeferredCancel(false);
  }

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
      // A restored state already holds each event at or below the floor.
      if (!eventFloor.admits(event)) {
        return;
      }
      if (awaitingRunId && !activeRunId) {
        pendingEvents.push(event);
        return;
      }

      // MUST ignore any payload whose runId is not the active run
      if (!activeRunId || event.runId !== activeRunId) {
        return;
      }

      switch (event.event) {
        case "preparing": {
          // The first event of the run. The store shows `preparing` from the start, so the
          // event changes nothing for the run that the store tracks.
          break;
        }
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
            measuredDurationUs: event.measuredDurationUs,
            expectedDurationUs: event.expectedDurationUs,
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
      // The store no longer hears the run, so a Stop that waits for its id never gets one.
      dropDeferredCancel();
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
     * Records a Stop request that failed while the run continues: `cancel_export` rejected, at
     * the IPC layer or in the client check of the answer. The caller calls it only while the
     * store still tracks the run that the request was for.
     *
     * The status is `failed`, and the error is the failure of the request. The start or the
     * run stays tracked: the backend did not confirm a stop, so it can still prepare and
     * encode. `reportError` ignores a report while the store tracks a live run, so this is the
     * one path that writes `failed` over a tracked run. The store tracks the run to its
     * `finished` or `failed` event. A `failed` status with `tracking` true is live
     * (`isExportRunLive`), so no control resets the store in that state, and the user can ask
     * for the stop again.
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
          measuredDurationUs: normalized.measuredDurationUs,
          expectedDurationUs: normalized.expectedDurationUs,
        }),
      });
    }

    /**
     * True while the store holds no run id and its own start waits for one. A Stop request
     * then waits for the answer of `start_export` (`deferredCancel`). A `preparing` status
     * with no start in flight, as after `unsubscribe`, has no answer to wait for.
     */
    function waitsForRunId(): boolean {
      return activeRunId === null && awaitingRunId;
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
        dropDeferredCancel();
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

      adoptRun: (
        runId: string,
        facts: ExportRunFacts,
        events: readonly ExportProgressEvent[] = [],
      ): void => {
        // The queue calls this at the `preparing` event of a run that waited. The backend
        // sends the last event of a run before it releases the slot, and the next run sends
        // `preparing` only after it took the slot (ADR 049). So the run that the store
        // tracked before has ended when this event arrives, and the store already holds its
        // terminal event. Nothing of that run can arrive later, so the store can drop it.
        //
        // Precondition: no start of this store is in flight. The queue store sends its
        // submissions to the backend one after another, and a run waits only when a run was
        // live before it, so a direct start has its answer before a waiting run can take the
        // slot. The function still supersedes a start in flight, as a defense: the counter
        // makes the start discard its answer, and a Stop request that waits for the run id of
        // that start settles with false.
        latestRequestId++;
        awaitingRunId = false;
        pendingEvents = [];
        dropDeferredCancel();
        setTrackedRun(runId, {
          status: "preparing",
          runId,
          outputPath: facts.outputPath,
          segmentCount: facts.segmentCount,
          frame: null,
          expectedFrames: null,
          fps: null,
          speed: null,
          cancelRequested: false,
          encodeStarted: false,
          error: null,
        });
        // Events of the run that came before the queue knew its run id, in their order. The
        // store did not track the run when they arrived, so it applies them now.
        for (const event of events) {
          if (event.runId === runId) {
            handleEvent(event);
          }
        }
      },

      restoreRun: (run: ExportRestoredRun): void => {
        // The same reset of the start state as `adoptRun`. After a reload no start of this
        // store is in flight, because the queue store holds each submission until the
        // recovery ends. The reset is a defense.
        latestRequestId++;
        awaitingRunId = false;
        pendingEvents = [];
        dropDeferredCancel();
        setTrackedRun(run.runId, {
          status: run.status,
          runId: run.runId,
          outputPath: run.outputPath,
          segmentCount: run.segmentCount,
          frame: run.frame,
          expectedFrames: run.expectedFrames,
          fps: null,
          speed: null,
          cancelRequested: false,
          encodeStarted: run.status !== "preparing",
          error: null,
        });
      },

      replayEvent: (event: ExportProgressEvent): void => {
        handleEvent(event);
      },

      cancelExport: async (): Promise<boolean> => {
        const runId = activeRunId;
        if (!runId) {
          // A start that waits for its run id can still be stopped. The backend answers with
          // the id as soon as it accepted the run, before the run prepares. The request waits
          // for that answer and then names the run.
          // Every other status with no run id has no run to stop.
          if (!waitsForRunId()) {
            return false;
          }
          const requestId = latestRequestId;
          if (deferredCancel?.requestId !== requestId) {
            dropDeferredCancel();
            deferredCancel = { requestId, settlers: [] };
          }
          // A second click while the first waits asks for the same stop.
          const pending = deferredCancel;
          set({ cancelRequested: true });
          return new Promise<boolean>((resolve) => {
            pending.settlers.push(resolve);
          });
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

      startExport: async (request: ExportRequest): Promise<ExportSubmission | null> => {
        // A Stop request of the start that this one replaces has no run to stop any more.
        dropDeferredCancel();
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
          segmentCount: request.segmentCount,
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

          const submission = await startExportFn(request);

          if (requestId !== latestRequestId) {
            // A superseded run MUST NOT touch the buffering state: the successor
            // (or reset) already owns it.
            return null;
          }

          awaitingRunId = false;

          // The status is not written here. It stays `preparing` until the `started` event of
          // the run, or a `failed` event, which also reports a failure of preparation. The
          // output path and the segment count came from the request, and the `started` event
          // reports the facts of the plan.
          setTrackedRun(submission.runId, { runId: submission.runId });

          // Events that came before the answer, in their order. A run that failed quickly has
          // ended after this.
          const buffered = pendingEvents;
          pendingEvents = [];
          for (const e of buffered) {
            handleEvent(e);
          }

          // A Stop request that waited for the run id.
          if (deferredCancel?.requestId === requestId) {
            if (activeRunId === submission.runId) {
              const pending = deferredCancel;
              deferredCancel = null;
              void get()
                .cancelExport()
                .then(
                  (accepted) => {
                    for (const settle of pending.settlers) settle(accepted);
                  },
                  () => {
                    for (const settle of pending.settlers) settle(false);
                  },
                );
            } else {
              // The run ended before the request could reach it.
              set({ cancelRequested: false });
              dropDeferredCancel();
            }
          }

          return submission;
        } catch (err) {
          const normalized = normalizeExportError(err);

          if (requestId !== latestRequestId) {
            // A superseded run MUST NOT touch the buffering state: the successor
            // (or reset) already owns it.
            return null;
          }

          awaitingRunId = false;
          pendingEvents = [];
          // The backend refused the start, so no run exists to stop.
          dropDeferredCancel();

          setTrackedRun(null, {
            status: normalized.code === "canceled" ? "canceled" : "failed",
            runId: null,
            cancelRequested: false,
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
