/**
 * Export queue store: the copy of the export queue of the backend that the interface shows
 * (ADR 049).
 *
 * The backend holds the queue and is the authority. This store only submits runs, removes
 * waiting runs, and keeps the facts that the interface shows for each run of the batch. It
 * builds its copy from the answers of `start_export` and from the `export:progress` events,
 * and it matches each event to its run by run id.
 *
 * The export store (`store.ts`) tracks the run that holds the slot. This store hands a run to
 * the export store when the run starts: through `startExport` when the slot is free, and
 * through `adoptRun` when a run that waited sends `preparing`.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { UnlistenFn } from "@/lib/ipc";
import { isSameFilePath } from "@/lib/filePath";
import { cancelExport, startExport } from "./client";
import { exportEventFloor, type ExportEventFloor } from "./eventFloor";
import { subscribeExportProgress } from "./events";
import { exportRecoveryGate, type ExportRecoveryGate } from "./recoveryGate";
import { isExportRunLive } from "./runState";
import { exportStore, type ExportStore } from "./store";
import {
  ExportError,
  type ExportProgressEvent,
  type ExportRequest,
  type ExportState,
  type ExportStreams,
  type ExportSubmission,
} from "./types";
import { normalizeExportError } from "./validation";

/**
 * The facts of one run of the batch, as the user submitted it. The store records them at
 * submission and never changes them. The preset name is the name of the submitted preset, so a
 * later edit in Settings does not change the row.
 */
export type ExportQueueJob = {
  runId: string;
  outputPath: string;
  presetName: string;
  segmentCount: number;
  streams: ExportStreams;
};

/** The end of a run of the batch that no longer holds the slot. */
export type ExportQueueEndedJob = {
  runId: string;
  status: "finished" | "failed" | "canceled";
  error: ExportError | null;
};

/**
 * The batch that a page restores after a reload, from the answer of `export_queue_snapshot`
 * (`recovery.ts`).
 */
export type ExportQueueRestore = {
  /**
   * The facts of each run of the batch, in the order of the snapshot: the ended runs by their
   * end order, then the active run, then the waiting runs. It becomes `order`.
   */
  jobs: readonly ExportQueueJob[];
  /** The runs that wait, in the order of the queue of the backend. */
  waiting: readonly string[];
  /** The runs that ended, in the order that they ended. */
  ended: readonly ExportQueueEndedJob[];
};

/** Public state of the export queue store. */
export type ExportQueueState = {
  /** The facts of each run of the batch, by run id. */
  jobs: Record<string, ExportQueueJob>;
  /**
   * The run ids of the batch, in the order of submission. After a restore (`restore`) it is
   * the order of the snapshot: the ended runs by their end order, then the active run, then
   * the waiting runs.
   */
  order: string[];
  /** The run ids that wait in the queue of the backend, in their order. */
  waiting: string[];
  /**
   * The runs of the batch that ended and no longer show in the export store. The store adds
   * the run of the export store when the next run takes the slot or when a reset drops it
   * while the batch goes on, and a waiting run that failed. The last run of the batch keeps
   * its end in the export store.
   */
  ended: ExportQueueEndedJob[];
  /**
   * The waiting runs that the user asked to remove: the cancel request is in flight, or the
   * backend agreed to cancel the run and its deciding event has not come yet. A refused or
   * failed request takes the run out again. A run stays in `waiting` until that event: `failed` with `canceled` when the backend
   * withdrew it from the queue, or `preparing` when it took the slot first. In that case the
   * backend stops it as the run that holds the slot, and it ends `canceled` in the export
   * store. The cancel answer and the event can come in either order.
   */
  removing: string[];
  /**
   * The number of entries of `ended` that the user saw before a reset of the export store
   * while the batch went on, such as the Close of the dialog. The status bar shows the end of
   * a batch that ended while the export store is idle only when `ended` holds more entries,
   * so it never shows again a result that the user dismissed. A new batch clears it.
   */
  seenEndedCount: number;
  /**
   * The number of submissions that have no answer yet. Such a submission can still start a
   * run or add one to the queue. A new batch does not clear it.
   */
  submitting: number;
  /**
   * The part of `submitting` that goes to the queue of the backend (`enqueue`). It leaves out
   * a submission that starts a new batch: the export store shows that run as `preparing` at
   * once, so it is the live run and not a queued one. The quit guard counts this number. A new
   * batch does not clear it.
   */
  enqueuing: number;
};

/** The part of the queue state that belongs to one batch. A new batch clears it. */
type ExportQueueBatch = Omit<ExportQueueState, "submitting" | "enqueuing">;

/**
 * The result of `submit`.
 *
 * - `started`: the slot was free. The export store tracks the run from its start.
 * - `queued`: the run waits in the queue of the backend, or started at once while the export
 *   store still showed the run before it. The store adopts it at its `preparing` event.
 * - `refused`: no run exists. `error` tells why: `outputAlreadyQueued`, or the normalized
 *   rejection of `start_export` or of the event subscription.
 * - `failed`: the export store started the run and recorded its failure itself.
 * - `superseded`: a reset or an adoption replaced the start in the export store before its
 *   answer came. The export store records no error for it.
 */
export type ExportQueueSubmitResult =
  | { kind: "started"; runId: string }
  | { kind: "queued"; runId: string }
  | { kind: "refused"; error: ExportError }
  | { kind: "failed" }
  | { kind: "superseded" };

/** Actions of the export queue store. */
export type ExportQueueActions = {
  /**
   * Submits an export. It starts the export at once when the export store holds no live run
   * and nothing waits. Otherwise it adds the export to the queue of the backend.
   *
   * It refuses an output path that names the file of the live run or of a waiting run, with
   * `outputAlreadyQueued`.
   *
   * The submissions reach the backend one after another. A `start_export` that never answers
   * therefore blocks every later submission, and its output path stays taken. The backend
   * answers before the run prepares, so the answer is quick in normal use.
   */
  submit: (request: ExportRequest) => Promise<ExportQueueSubmitResult>;
  /**
   * Withdraws a waiting run from the queue of the backend.
   *
   * The run goes to `removing` before the request, so a second call while the request is in
   * flight does nothing and returns false. On a true answer the run stays in `removing`, and its
   * next event decides what happens to it: see `ExportQueueState.removing`. On a false answer
   * or a rejection, the run leaves `removing`, and the user can remove it again.
   *
   * @returns True when the backend accepted the cancel, false otherwise.
   */
  remove: (runId: string) => Promise<boolean>;
  /**
   * Drops the rows of a batch that is over while the export store is idle. A reset of the
   * export store while runs wait keeps the batch, so its end can still show in the status
   * bar. The dismissal of that end calls this. It does nothing while the export store is not
   * idle or while the batch goes on (`exportBatchContinues`).
   */
  dismissEndedBatch: () => void;
  /**
   * Subscribes the store to the export progress events, once. The store also subscribes at
   * its first submission. The recovery after a reload calls it before it reads the snapshot,
   * so the store hears every event after the snapshot.
   */
  ensureSubscribed: () => Promise<void>;
  /**
   * Replaces the batch with the batch that a page restores after a reload. `removing` keeps
   * only the runs that still wait in `batch`, so a second read during a removal keeps the
   * Remove button disabled. `seenEndedCount` becomes zero. `submitting` and `enqueuing` do not change: the
   * submissions wait at the recovery gate, so none is in flight.
   *
   * The recovery calls `restoreRun` of the export store first, so the batch that this sets
   * never looks over while the export store is still idle.
   */
  restore: (batch: ExportQueueRestore) => void;
  /**
   * Applies an event that the recovery held back while it read the snapshot. The recovery
   * gives each event to the export store first, because an adoption reads the end of the run
   * that the export store shows.
   */
  replayEvent: (event: ExportProgressEvent) => void;
};

/** Combined type of the export queue state and actions. */
export type ExportQueueStoreState = ExportQueueState & ExportQueueActions;

/** Dependencies that can be injected into the export queue store factory for testing. */
export interface ExportQueueStoreDependencies {
  /** The export store that tracks the run that holds the slot. Defaults to `exportStore`. */
  exportStore?: ExportStore;
  /** Function to start an export via the backend command. Defaults to `startExport`. */
  startExport?: (request: ExportRequest) => Promise<ExportSubmission>;
  /** Function to cancel a run via the backend command. Defaults to `cancelExport`. */
  cancelExport?: (runId: string) => Promise<boolean>;
  /** Function to subscribe to the export progress events. Defaults to `subscribeExportProgress`. */
  subscribeExportProgress?: (
    handler: (event: ExportProgressEvent) => void,
  ) => Promise<UnlistenFn>;
  /**
   * The sequence floor that a restore sets (`eventFloor.ts`). The store ignores each event at
   * or below it. Defaults to `exportEventFloor`.
   */
  eventFloor?: ExportEventFloor;
  /**
   * The gate that holds submissions while the queue recovers after a reload. Defaults to
   * `exportRecoveryGate`.
   */
  recoveryGate?: ExportRecoveryGate;
}

const TERMINAL_STATUSES: ReadonlySet<ExportState["status"]> = new Set([
  "finished",
  "failed",
  "canceled",
]);

function emptyBatch(): ExportQueueBatch {
  return {
    jobs: {},
    order: [],
    waiting: [],
    ended: [],
    removing: [],
    seenEndedCount: 0,
  };
}

function noop(): void {}

/**
 * Factory function creating a vanilla Zustand store instance for the export queue.
 *
 * Non-serializable state (the subscription, the event buffer, the chain of submissions, the
 * submissions in flight) lives in the factory closure, so the public state stays serializable.
 */
export function createExportQueueStore(
  dependencies: ExportQueueStoreDependencies = {},
): StoreApi<ExportQueueStoreState> {
  const exportStoreApi = dependencies.exportStore ?? exportStore;
  const startExportFn = dependencies.startExport ?? startExport;
  const cancelExportFn = dependencies.cancelExport ?? cancelExport;
  const subscribeExportProgressFn =
    dependencies.subscribeExportProgress ?? subscribeExportProgress;
  const eventFloor = dependencies.eventFloor ?? exportEventFloor;
  const recoveryGate = dependencies.recoveryGate ?? exportRecoveryGate;

  let subscriptionPromise: Promise<UnlistenFn> | null = null;
  /**
   * The output paths of the submissions that have no answer yet. The duplicate test reads
   * them too, so two quick submissions to one file cannot both pass.
   */
  const pendingOutputPaths: string[] = [];
  /**
   * The last submission that reaches the backend. Each submission invokes `start_export` only
   * after the one before it has its answer. So the backend receives the runs in the order of
   * submission. Without this, a queued run could reach the backend before the start that the
   * export store waits for, take the slot first, and leave that start untracked.
   */
  let invokeChain: Promise<unknown> = Promise.resolve();
  /**
   * True while this store waits for the answer of its own `start_export`. Events of a run id
   * that the store does not know wait in `pendingEvents` meanwhile, because the run id comes
   * with the answer. A run that started at once can send `preparing` before the answer.
   */
  let awaitingRunId = false;
  let pendingEvents: ExportProgressEvent[] = [];

  const store = createStore<ExportQueueStoreState>()((set, get) => {
    function removeFrom(list: string[], runId: string): string[] {
      return list.filter((id) => id !== runId);
    }

    /** Drops a run from the batch: its facts, its row, and its place in the queue. */
    function forgetRun(runId: string): void {
      set((state) => {
        const jobs = { ...state.jobs };
        delete jobs[runId];
        return {
          jobs,
          order: removeFrom(state.order, runId),
          waiting: removeFrom(state.waiting, runId),
          removing: removeFrom(state.removing, runId),
        };
      });
    }

    /**
     * Adds the run of the export store to `ended`, when it belongs to the batch and has ended.
     * The adoption of the next run replaces that run in the export store, so this is the last
     * moment to keep its end. A reset of the export store while runs wait is another such
     * moment, and its subscriber passes the state before the reset.
     *
     * A run that is still live (`isExportRunLive`) when it leaves the export store lost its
     * terminal event, because the backend sends that event before the next run takes the
     * slot. Its real end is unknown. A record with the code `unknown` keeps the row visible
     * and claims no cause. A live `failed` holds the failure of a Stop request, not of the
     * run, so it gets the same record.
     */
    function archiveRun(
      snapshot: Pick<ExportState, "runId" | "status" | "tracking" | "error">,
    ): void {
      const runId = snapshot.runId;
      if (runId === null) {
        return;
      }
      const state = get();
      if (!state.order.includes(runId) || state.ended.some((e) => e.runId === runId)) {
        return;
      }
      let entry: ExportQueueEndedJob;
      if (isExportRunLive(snapshot)) {
        entry = {
          runId,
          status: "failed",
          error: new ExportError({ code: "unknown" }),
        };
      } else if (TERMINAL_STATUSES.has(snapshot.status)) {
        entry = {
          runId,
          status: snapshot.status as ExportQueueEndedJob["status"],
          error: snapshot.error,
        };
      } else {
        return;
      }
      set({ ended: [...state.ended, entry] });
    }

    /**
     * Hands a waiting run that took the slot to the export store. `laterEvents` are events of
     * the run that came after its `preparing` event, while the queue did not know its run
     * id yet. The export store did not track the run then, so it applies them now.
     */
    function adoptWaitingRun(
      runId: string,
      laterEvents: readonly ExportProgressEvent[],
    ): void {
      // The backend sent the last event of the run before this one first, so the export
      // store already shows the end of that run (ADR 049).
      const job = get().jobs[runId];
      archiveRun(exportStoreApi.getState());
      set((state) => ({
        waiting: removeFrom(state.waiting, runId),
        removing: removeFrom(state.removing, runId),
      }));
      if (job) {
        exportStoreApi
          .getState()
          .adoptRun(
            runId,
            { outputPath: job.outputPath, segmentCount: job.segmentCount },
            laterEvents,
          );
      }
    }

    function handleWaitingRunEvent(event: ExportProgressEvent): void {
      switch (event.event) {
        case "preparing": {
          adoptWaitingRun(event.runId, []);
          break;
        }
        case "failed": {
          if (event.code === "canceled") {
            // A cancel withdrew the run from the queue. The user asked for it, through
            // `remove` or elsewhere, so the run leaves the batch.
            forgetRun(event.runId);
            break;
          }
          // The system refused the thread of the run, or another failure came before the run
          // took the slot. This is a real failure, so the run stays in the batch with it.
          const error = new ExportError({
            code: event.code,
            detail: event.detail,
            exitCode: event.exitCode,
            encoder: event.encoder,
            measuredDurationUs: event.measuredDurationUs,
            expectedDurationUs: event.expectedDurationUs,
          });
          set((state) => ({
            waiting: removeFrom(state.waiting, event.runId),
            removing: removeFrom(state.removing, event.runId),
            ended: [...state.ended, { runId: event.runId, status: "failed", error }],
          }));
          break;
        }
        default: {
          // A run that waits sends `preparing` or `failed` first. Every later event of the
          // run comes after its adoption, and the export store handles it.
          break;
        }
      }
    }

    function handleEvent(event: ExportProgressEvent): void {
      // A restored state already holds each event at or below the floor.
      if (!eventFloor.admits(event)) {
        return;
      }
      const state = get();
      if (state.waiting.includes(event.runId)) {
        handleWaitingRunEvent(event);
        return;
      }
      if (awaitingRunId && !(event.runId in state.jobs)) {
        pendingEvents.push(event);
      }
      // Every other event belongs to the run of the export store, or to a run that left the
      // batch, such as the `failed` event of a run that `remove` withdrew.
    }

    async function ensureSubscribed(): Promise<void> {
      if (!subscriptionPromise) {
        const currentPromise = subscribeExportProgressFn((event) => {
          handleEvent(event);
        }).catch((e: unknown) => {
          if (subscriptionPromise === currentPromise) {
            subscriptionPromise = null;
          }
          throw e;
        });
        subscriptionPromise = currentPromise;
      }
      await subscriptionPromise;
    }

    function recordJob(runId: string, request: ExportRequest, waits: boolean): void {
      const job: ExportQueueJob = {
        runId,
        outputPath: request.outputPath,
        presetName: request.preset.name,
        segmentCount: request.segmentCount,
        streams: request.streams,
      };
      set((state) => ({
        jobs: { ...state.jobs, [runId]: job },
        order: state.order.includes(runId) ? state.order : [...state.order, runId],
        waiting: waits ? [...state.waiting, runId] : state.waiting,
      }));
    }

    /** True when `outputPath` names the file of the live run, a waiting run, or a submission. */
    function isOutputTaken(outputPath: string): boolean {
      const same = (other: string | null) =>
        other !== null && isSameFilePath(outputPath, other, { ignoreCase: true });
      const current = exportStoreApi.getState();
      const state = get();
      // The path of the request when the run belongs to the batch. The export store shows the
      // path of the `started` event once it came, and the request path is the one the user
      // chose.
      const currentPath =
        (current.runId !== null ? state.jobs[current.runId]?.outputPath : undefined) ??
        current.outputPath;
      if (isExportRunLive(current) && same(currentPath)) {
        return true;
      }
      if (state.waiting.some((runId) => same(state.jobs[runId]?.outputPath ?? null))) {
        return true;
      }
      return pendingOutputPaths.some(same);
    }

    /** Starts a new batch through the export store, which shows `preparing` at once. */
    async function startDirectly(
      request: ExportRequest,
    ): Promise<ExportQueueSubmitResult> {
      // The export store is idle, and nothing waits. The rows of a batch before go.
      set(emptyBatch());
      // The queue hears the events from here on, for the runs that the user adds later. A
      // failed subscription does not stop this start: the export store has its own, and the
      // next submission tries again.
      ensureSubscribed().catch(noop);
      // The backend journal drops the ended runs of the batch before (`newBatch`), so a page
      // that loads again lists only this batch.
      const starting = exportStoreApi
        .getState()
        .startExport({ ...request, newBatch: true });
      invokeChain = starting.then(noop, noop);
      const submission = await starting;
      if (submission === null) {
        // The export store answers null when it recorded a failure, and when a reset or an
        // adoption replaced the start. Only a failure leaves an error with no tracked run.
        const after = exportStoreApi.getState();
        const failed =
          !after.tracking &&
          after.error !== null &&
          (after.status === "failed" || after.status === "canceled");
        return failed ? { kind: "failed" } : { kind: "superseded" };
      }
      recordJob(submission.runId, request, false);
      return { kind: "started", runId: submission.runId };
    }

    /** Adds a run to the queue of the backend. The export store adopts it when it starts. */
    async function enqueue(request: ExportRequest): Promise<ExportQueueSubmitResult> {
      // A run of the queue joins the batch, so it never asks the backend to start a new one.
      const { newBatch: _newBatch, ...queuedRequest } = request;
      const invoke = async (): Promise<ExportSubmission> => {
        await ensureSubscribed();
        awaitingRunId = true;
        try {
          return await startExportFn(queuedRequest);
        } finally {
          awaitingRunId = false;
        }
      };
      const invoking = invokeChain.then(invoke, invoke);
      invokeChain = invoking.then(noop, noop);

      let submission: ExportSubmission;
      try {
        submission = await invoking;
      } catch (err) {
        pendingEvents = [];
        return { kind: "refused", error: normalizeExportError(err) };
      }

      // The run waits until its `preparing` event, also when the backend started it at once:
      // that event comes all the same, and the adoption handles it.
      recordJob(submission.runId, request, true);

      // Events that came before the answer, in their order. Only events of this run can be
      // in the buffer and matter: no other submission was in flight. A run that took the slot
      // at once can send more than `preparing` before the answer, up to its end. The events
      // after `preparing` go to the export store with the adoption, because the export store
      // ignored them when they arrived.
      const own = pendingEvents.filter((event) => event.runId === submission.runId);
      pendingEvents = [];
      for (let index = 0; index < own.length; index++) {
        const event = own[index];
        if (event === undefined || !get().waiting.includes(submission.runId)) {
          break;
        }
        if (event.event === "preparing") {
          adoptWaitingRun(submission.runId, own.slice(index + 1));
          break;
        }
        handleEvent(event);
      }
      return { kind: "queued", runId: submission.runId };
    }

    // A dismissed result moves the export store to `idle`. When nothing waits and no
    // submission is in flight, the batch is over, and its rows go. Otherwise the batch stays,
    // and the run that the reset dropped from the export store keeps its row in `ended`.
    exportStoreApi.subscribe((current, previous) => {
      if (current.status !== "idle" || previous.status === "idle") {
        return;
      }
      if (get().waiting.length === 0 && pendingOutputPaths.length === 0) {
        set(emptyBatch());
      } else {
        archiveRun(previous);
        // The user saw the result that the reset dropped, and every end before it.
        set({ seenEndedCount: get().ended.length });
      }
    });

    return {
      ...emptyBatch(),
      submitting: 0,
      enqueuing: 0,

      submit: async (request: ExportRequest): Promise<ExportQueueSubmitResult> => {
        // A recovery after a reload replaces the batch. A submission waits until it ended,
        // so the restore cannot overwrite the batch that the submission starts. The gate is
        // open in normal use, and the submission then starts at once.
        const recovering = recoveryGate.pending();
        if (recovering !== null) {
          await recovering;
        }
        if (isOutputTaken(request.outputPath)) {
          return {
            kind: "refused",
            error: new ExportError({ code: "outputAlreadyQueued" }),
          };
        }
        // A new batch starts only from an idle export store. A run that ended and that the
        // export store still shows keeps its result: the submission goes to the queue of the
        // backend, which starts it at once when the slot is free. The adoption of its
        // `preparing` event then keeps the run before as an ended row, with its Show File. A
        // refusal of that submission answers `refused`, so the caller shows it and the export
        // store keeps the result. The Export action resets a result that it does not compose
        // beside, so its submission still starts a new batch (ADR 049).
        const startsBatch =
          exportStoreApi.getState().status === "idle" &&
          get().waiting.length === 0 &&
          pendingOutputPaths.length === 0;

        pendingOutputPaths.push(request.outputPath);
        const enqueues = !startsBatch;
        set((state) => ({
          submitting: state.submitting + 1,
          enqueuing: state.enqueuing + (enqueues ? 1 : 0),
        }));
        try {
          return enqueues ? await enqueue(request) : await startDirectly(request);
        } finally {
          pendingOutputPaths.splice(pendingOutputPaths.indexOf(request.outputPath), 1);
          set((state) => ({
            submitting: state.submitting - 1,
            enqueuing: state.enqueuing - (enqueues ? 1 : 0),
          }));
        }
      },

      ensureSubscribed,

      restore: (batch: ExportQueueRestore): void => {
        pendingEvents = [];
        const jobs: Record<string, ExportQueueJob> = {};
        for (const job of batch.jobs) {
          jobs[job.runId] = job;
        }
        set((state) => ({
          jobs,
          order: batch.jobs.map((job) => job.runId),
          waiting: [...batch.waiting],
          ended: [...batch.ended],
          removing: state.removing.filter((runId) => batch.waiting.includes(runId)),
          seenEndedCount: 0,
        }));
      },

      replayEvent: (event: ExportProgressEvent): void => {
        handleEvent(event);
      },

      dismissEndedBatch: (): void => {
        const current = exportStoreApi.getState();
        if (current.status !== "idle" || exportBatchContinues(get(), current)) {
          return;
        }
        set(emptyBatch());
      },

      remove: async (runId: string): Promise<boolean> => {
        const before = get();
        if (!before.waiting.includes(runId) || before.removing.includes(runId)) {
          return false;
        }
        // The run goes to `removing` before the request. So the Remove button of the run is
        // disabled at once, and a second click cannot send a second cancel request.
        set((state) => ({ removing: [...state.removing, runId] }));
        // Takes the run out of `removing` after a refused or failed request. The deciding
        // event, or a new batch, can have taken it out already.
        const clearRemoving = () => {
          if (get().removing.includes(runId)) {
            set((state) => ({ removing: removeFrom(state.removing, runId) }));
          }
        };
        let withdrawn: boolean;
        try {
          withdrawn = await cancelExportFn(runId);
        } catch {
          clearRemoving();
          return false;
        }
        // A true answer does not tell whether the backend withdrew the run from the queue or
        // stopped it after it took the slot, and the deciding event can come before or after
        // the answer. So the run stays in `removing`, and its event decides: `failed` with
        // `canceled` forgets it, and `preparing` adopts it, after which it ends canceled in
        // the export store. Both events take the run out of `removing`.
        if (!withdrawn) {
          clearRemoving();
        }
        return withdrawn;
      },
    };
  });

  // A batch can end while the export store is idle, after a reset while runs waited. When it
  // ends with no end that the user did not see, such as by the removal of the last waiting
  // run or a refused submission, the status bar has nothing to show, and the rows go.
  store.subscribe((state) => {
    const current = exportStoreApi.getState();
    if (
      current.status === "idle" &&
      state.order.length > 0 &&
      state.ended.length <= state.seenEndedCount &&
      !exportBatchContinues(state, current)
    ) {
      store.setState(emptyBatch());
    }
  });

  return store;
}

export type ExportQueueStore = ReturnType<typeof createExportQueueStore>;

/**
 * True while runs wait in the queue of the backend, or while a submission has no answer yet.
 * The run that holds the slot is not part of this test: the export store holds it
 * (`isExportRunLive`).
 *
 * The Export action reads this rule with `isExportRunLive`. While either one is true, a new
 * export joins the queue, so the action sets it up in the compose state (ADR 049).
 */
export function hasPendingExportWork(
  state: Pick<ExportQueueState, "waiting" | "submitting">,
): boolean {
  return state.waiting.length > 0 || state.submitting > 0;
}

/** The fields of the export queue state that the rules of a batch read. */
export type ExportBatchQueueState = Pick<
  ExportQueueState,
  "order" | "waiting" | "submitting" | "ended"
>;

/**
 * True while the batch goes on after the run of the export store: runs wait, a submission has
 * no answer yet (`hasPendingExportWork`), the queue archived the run of the export store, or
 * the export store is idle while a run of the batch has not ended.
 *
 * The third test covers the adoption of the next run. The queue first adds the run of the
 * export store to `ended`, then takes the next run out of `waiting`, and only then does the
 * export store move to `preparing`. Between those changes nothing waits, but the batch goes
 * on. The status views read this rule, so they show no end of the batch in that gap.
 *
 * The last test covers the same gap after a reset of the export store while runs waited, such
 * as the Close of the dialog: the export store is idle and has no run, and the next run left
 * `waiting` but has not ended.
 */
export function exportBatchContinues(
  queue: ExportBatchQueueState,
  exportState: Pick<ExportState, "runId">,
): boolean {
  if (hasPendingExportWork(queue)) {
    return true;
  }
  const runId = exportState.runId;
  const endedIds = new Set(queue.ended.map((entry) => entry.runId));
  if (runId !== null) {
    return endedIds.has(runId);
  }
  return (
    queue.order.length > 0 &&
    queue.ended.length > 0 &&
    queue.order.some((id) => !endedIds.has(id))
  );
}

/** The end of one run of a batch. */
export type ExportBatchEnd = ExportQueueEndedJob["status"];

/**
 * The ends of the runs of the batch, in the order that they ended: the runs in `ended`, and
 * then the run of the export store when it ended (not `isExportRunLive`). A run of the export
 * store that the queue archived counts once.
 */
export function exportBatchEndsOf(
  queue: Pick<ExportQueueState, "ended">,
  exportState: Pick<ExportState, "runId" | "status" | "tracking">,
): ExportBatchEnd[] {
  const ends = queue.ended
    .filter((entry) => entry.runId !== exportState.runId)
    .map((entry) => entry.status);
  const status = exportState.status;
  if (
    !isExportRunLive(exportState) &&
    (status === "finished" || status === "failed" || status === "canceled")
  ) {
    ends.push(status);
  }
  return ends;
}

/**
 * True when a batch of more than one run has a failed run. The status views then show the end
 * of the batch as a failure, also when its last run finished. A batch of one run gives false,
 * so its views keep the rules of one run.
 */
export function exportBatchHasFailure(ends: readonly ExportBatchEnd[]): boolean {
  return ends.length > 1 && ends.includes("failed");
}

/** The phase of a row of the queue list. */
export type ExportQueueRowPhase = "ended" | "current" | "waiting";

/** One row of the queue list, for display. */
export type ExportQueueRow = {
  runId: string;
  job: ExportQueueJob;
  phase: ExportQueueRowPhase;
  /** The end of the run when `phase` is `ended`, otherwise null. */
  ended: ExportQueueEndedJob | null;
  /** True while the backend cancels the waiting run (`ExportQueueState.removing`). */
  removing: boolean;
};

/**
 * The rows of the batch in the order of submission. The run of the export store is `current`
 * while it belongs to the batch, also after it ended: the export store keeps the end of the
 * last run. A run with no phase is left out.
 *
 * The function returns a new array on each call. A React caller must memoize the result, for
 * example with `useMemo` over the two states. It must not pass this function as the selector
 * of `useStore`, because a new array on each render makes the hook render again and again.
 */
export function selectExportQueueRows(
  queue: Pick<ExportQueueState, "jobs" | "order" | "waiting" | "ended" | "removing">,
  exportState: Pick<ExportState, "runId">,
): ExportQueueRow[] {
  const rows: ExportQueueRow[] = [];
  for (const runId of queue.order) {
    const job = queue.jobs[runId];
    if (!job) {
      continue;
    }
    if (exportState.runId === runId) {
      rows.push({ runId, job, phase: "current", ended: null, removing: false });
      continue;
    }
    const ended = queue.ended.find((entry) => entry.runId === runId);
    if (ended) {
      rows.push({ runId, job, phase: "ended", ended, removing: false });
      continue;
    }
    if (queue.waiting.includes(runId)) {
      rows.push({
        runId,
        job,
        phase: "waiting",
        ended: null,
        removing: queue.removing.includes(runId),
      });
    }
  }
  return rows;
}

/** Default singleton export queue store for production application use. */
export const exportQueueStore: ExportQueueStore = createExportQueueStore();

const defaultSelector = (state: ExportQueueStoreState): ExportQueueStoreState => state;

/** React hook for consuming the production export queue store. */
export function useExportQueueStore(): ExportQueueStoreState;
export function useExportQueueStore<T>(
  selector: (state: ExportQueueStoreState) => T,
): T;
export function useExportQueueStore<T>(
  selector?: (state: ExportQueueStoreState) => T,
): T | ExportQueueStoreState {
  return useStore(
    exportQueueStore,
    (selector ?? defaultSelector) as (state: ExportQueueStoreState) => T,
  );
}
