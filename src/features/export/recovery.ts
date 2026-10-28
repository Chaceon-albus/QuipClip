/**
 * The recovery of the export queue after a page reload (ADR 049).
 *
 * The backend runs the export queue. A reload of the page, or a crash of the web view, loses
 * the copy of the batch that the export store and the queue store keep, while the backend goes
 * on. Once per page, at startup, the recovery reads `export_queue_snapshot` and rebuilds both
 * stores from it.
 *
 * Tauri gives an event only to the listeners that exist when it goes out. So the order is:
 *
 * 1. Close the recovery gate (`recoveryGate.ts`). A submission waits until the recovery ends,
 *    so the restore cannot overwrite a batch that the submission starts.
 * 2. Subscribe both stores and a listener of the recovery, which holds each event back. All
 *    three are live before the snapshot call, so no event falls between them and the snapshot.
 * 3. Read the snapshot. A rejection restores nothing.
 * 4. When no run of the snapshot waits or runs, the batch is over, and nothing is restored.
 * 5. Otherwise, in one synchronous task: raise the sequence floor (`eventFloor.ts`) to the
 *    `seq` of the snapshot, so both stores ignore each event that the snapshot holds. Restore
 *    the export store, then the queue store, then the start of the run timing. Then give each
 *    held event above the floor, in the order of its number, to the export store and then to
 *    the queue store. Then stop holding events back.
 * 6. Open the gate.
 *
 * Steps 2 and 3 have a time limit of 10 seconds. At the limit nothing is restored, the gate
 * opens, and a late snapshot is ignored.
 *
 * A start of the page before the reload can reach the backend after the snapshot. Its run is
 * then in neither store. Its first event is `preparing`, with a number above the snapshot. The
 * listener of the recovery watches for such an event. While a submission of this page is in
 * flight, the run can be the run of that submission, so the recovery checks it again when no
 * submission is in flight any more. For a run that is still unknown, it closes the gate, reads
 * the snapshot again within the same time limit, and restores again as in step 5. It does this
 * at most once.
 */

import type { UnlistenFn } from "@/lib/ipc";
import { exportQueueSnapshot } from "./client";
import { exportEventFloor, type ExportEventFloor } from "./eventFloor";
import { subscribeExportProgress } from "./events";
import {
  exportQueueStore,
  type ExportQueueEndedJob,
  type ExportQueueRestore,
  type ExportQueueStore,
} from "./queueStore";
import { exportRecoveryGate, type ExportRecoveryGate } from "./recoveryGate";
import {
  exportRunTimingStore,
  seedExportRunStart,
  type ExportRunTimingStore,
} from "./runTiming";
import { exportStore, type ExportStore } from "./store";
import {
  ExportError,
  type ExportProgressEvent,
  type ExportQueueSnapshot,
  type ExportQueueSnapshotRun,
  type ExportRestoredRun,
} from "./types";

/** The dependencies of `recoverExportQueue`. A test passes fakes. */
export interface ExportQueueRecoveryDependencies {
  exportStore: ExportStore;
  queueStore: ExportQueueStore;
  /** Reads the snapshot of the export journal (`exportQueueSnapshot`). */
  snapshot: () => Promise<ExportQueueSnapshot>;
  /** Subscribes a listener to the export progress events (`subscribeExportProgress`). */
  subscribe: (handler: (event: ExportProgressEvent) => void) => Promise<UnlistenFn>;
  /** The timing of the run of `exportStore`, which the Stop rule reads. */
  timing: ExportRunTimingStore;
  /** The monotonic clock of `timing`, in milliseconds. */
  now: () => number;
  /** The sequence floor that both stores consult. */
  eventFloor: ExportEventFloor;
  /** The gate that `submit` of `queueStore` waits at. */
  gate: ExportRecoveryGate;
  /**
   * The time limit of one read: the subscriptions and the snapshot call of the first read, or
   * the snapshot call of the second read. Defaults to `EXPORT_QUEUE_RECOVERY_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /**
   * Calls `callback` after `ms` milliseconds, and returns the function that cancels the call.
   * Defaults to `setTimeout`. A test passes a fake.
   */
  setTimer?: (callback: () => void, ms: number) => () => void;
}

/** The time limit of one read of the snapshot. */
export const EXPORT_QUEUE_RECOVERY_TIMEOUT_MS = 10_000;

const defaultSetTimer = (callback: () => void, ms: number): (() => void) => {
  const id = setTimeout(callback, ms);
  return () => clearTimeout(id);
};

/**
 * The result of the first read of the snapshot.
 *
 * - `restored`: the batch was not over, and both stores now show it.
 * - `nothing`: no run of the snapshot waits or runs, so nothing was restored.
 * - `failed`: a subscription or the snapshot call failed or passed the time limit, so nothing
 *   was restored.
 */
export type ExportQueueRecoveryOutcome = "restored" | "nothing" | "failed";

/** The state that a snapshot restores, or null when its batch is over. */
export interface ExportQueueRestorePlan {
  /** The run that left `waiting` and did not end, or null between two runs. */
  active: ExportRestoredRun | null;
  /** The milliseconds since `active` sent `preparing`, or null when unknown. */
  activeElapsedMs: number | null;
  queue: ExportQueueRestore;
}

function isActive(
  phase: ExportQueueSnapshotRun["phase"],
): phase is ExportRestoredRun["status"] {
  return phase === "preparing" || phase === "running" || phase === "publishing";
}

function isEnded(
  phase: ExportQueueSnapshotRun["phase"],
): phase is ExportQueueEndedJob["status"] {
  return phase === "finished" || phase === "failed" || phase === "canceled";
}

/**
 * Gives the state that `snapshot` restores. It gives null when no run waits, prepares, runs,
 * or publishes: the batch is over, and the user chose that such a batch does not come back.
 */
export function planExportQueueRestore(
  snapshot: ExportQueueSnapshot,
): ExportQueueRestorePlan | null {
  const runs = snapshot.runs;
  if (!runs.some((run) => !isEnded(run.phase))) {
    return null;
  }
  let activeRun: ExportQueueSnapshotRun | null = null;
  let active: ExportRestoredRun | null = null;
  for (const run of runs) {
    const phase = run.phase;
    if (isActive(phase)) {
      activeRun = run;
      active = {
        runId: run.runId,
        status: phase,
        outputPath: run.outputPath,
        segmentCount: run.segmentCount,
        frame: run.frame ?? null,
        expectedFrames: run.expectedFrames ?? null,
      };
      break;
    }
  }
  const ended: ExportQueueEndedJob[] = [];
  // `endOrder` only sorts. Its values have gaps.
  const endedRuns = runs
    .filter((run) => isEnded(run.phase))
    .sort((a, b) => (a.endOrder ?? 0) - (b.endOrder ?? 0));
  for (const run of endedRuns) {
    if (isEnded(run.phase)) {
      ended.push({
        runId: run.runId,
        status: run.phase,
        error: run.error === undefined ? null : new ExportError(run.error),
      });
    }
  }
  return {
    active,
    activeElapsedMs: activeRun?.elapsedMs ?? null,
    queue: {
      jobs: runs.map((run) => ({
        runId: run.runId,
        outputPath: run.outputPath,
        presetName: run.presetName,
        segmentCount: run.segmentCount,
        streams: run.streams,
      })),
      waiting: runs.filter((run) => run.phase === "waiting").map((run) => run.runId),
      ended,
    },
  };
}

/**
 * The held events with a number above `seq`, in the order of their numbers. An event with no
 * number comes after them, in the order of arrival. The backend numbers every event, so only a
 * test sends one.
 */
function eventsAfter(
  held: readonly ExportProgressEvent[],
  seq: number,
): ExportProgressEvent[] {
  const numbered = held
    .filter((event) => event.seq !== undefined && event.seq > seq)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return [...numbered, ...held.filter((event) => event.seq === undefined)];
}

/**
 * Rebuilds the export store and the queue store from the snapshot of the backend. See the
 * module comment for the order. The promise settles when the first restore ended and the gate
 * is open. A second read, for a run that neither store knows, can come later. The gate is
 * closed while it runs.
 *
 * The gate always opens: after a failure, after the time limit, and after a restore that
 * throws. Such a throw rejects the promise.
 */
export async function recoverExportQueue(
  dependencies: ExportQueueRecoveryDependencies,
): Promise<ExportQueueRecoveryOutcome> {
  const { exportStore: exportApi, queueStore: queueApi, gate } = dependencies;
  const timeoutMs = dependencies.timeoutMs ?? EXPORT_QUEUE_RECOVERY_TIMEOUT_MS;
  const setTimer = dependencies.setTimer ?? defaultSetTimer;
  const openGate = gate.close();

  /** The events that the recovery holds back while it reads a snapshot, or null. */
  let held: ExportProgressEvent[] | null = [];
  /** The `seq` of the last snapshot. A run start at or below it is in that snapshot. */
  let snapshotSeq = 0;
  let watching = false;
  let rereadDone = false;
  /**
   * The unknown runs that started while a submission of this page was in flight. Such a run
   * can be the run of that submission, so the recovery checks it again when no submission is
   * in flight any more.
   */
  const suspects = new Set<string>();
  let stopWatchingSubmissions: (() => void) | null = null;

  /**
   * Gives the result of `work`, or rejects when it takes longer than the time limit. A late
   * result is then ignored. `onExpire` runs at the limit.
   */
  function withinLimit<T>(
    work: Promise<T>,
    onExpire: () => void = () => {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = setTimer(() => {
        onExpire();
        reject(new Error("The export queue snapshot passed its time limit."));
      }, timeoutMs);
      work.then(
        (value) => {
          cancel();
          resolve(value);
        },
        (error: unknown) => {
          cancel();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /** True for the `preparing` event of a run above the last snapshot that no store knows. */
  function isUnknownStart(event: ExportProgressEvent): boolean {
    if (event.event !== "preparing") {
      return false;
    }
    if (event.seq !== undefined && event.seq <= snapshotSeq) {
      return false;
    }
    return isUnknownRun(event.runId);
  }

  function isUnknownRun(runId: string): boolean {
    return !(runId in queueApi.getState().jobs) && exportApi.getState().runId !== runId;
  }

  /**
   * Handles an unknown start. A submission of this page has its run in a store when its
   * answer comes, and `submitting` counts it until then. So while a submission is in flight,
   * the run is only a suspect. Otherwise the snapshot is read again.
   */
  function onUnknownStart(event: ExportProgressEvent): void {
    if (queueApi.getState().submitting > 0) {
      suspects.add(event.runId);
      return;
    }
    reread(event);
  }

  /** Checks the suspects again when the last submission in flight has its answer. */
  function watchSubmissions(): void {
    stopWatchingSubmissions = queueApi.subscribe((state, previous) => {
      if (state.submitting !== 0 || previous.submitting === 0 || suspects.size === 0) {
        return;
      }
      const unknown = [...suspects].some((runId) => isUnknownRun(runId));
      suspects.clear();
      if (unknown) {
        reread(null);
      }
    });
  }

  function stopWatching(): void {
    watching = false;
    suspects.clear();
    stopWatchingSubmissions?.();
    stopWatchingSubmissions = null;
  }

  /**
   * Restores both stores from `snapshot` and replays `events` that came after it. It is
   * synchronous, so no event comes between its steps. Returns false when the batch of the
   * snapshot is over, and then changes nothing.
   */
  function restore(
    snapshot: ExportQueueSnapshot,
    events: readonly ExportProgressEvent[],
  ): boolean {
    snapshotSeq = Math.max(snapshotSeq, snapshot.seq);
    const plan = planExportQueueRestore(snapshot);
    if (plan === null) {
      return false;
    }
    dependencies.eventFloor.raise(snapshot.seq);
    // The export store first. A batch with a run in the queue store and an idle export store
    // could look over, and the queue store would drop it.
    if (plan.active !== null) {
      exportApi.getState().restoreRun(plan.active);
    } else if (exportApi.getState().status !== "idle") {
      // Only a second read finds the export store busy. Between two runs it holds no run.
      exportApi.getState().reset();
    }
    queueApi.getState().restore(plan.queue);
    if (plan.active !== null && plan.activeElapsedMs !== null) {
      seedExportRunStart(
        dependencies.timing,
        dependencies.now() - plan.activeElapsedMs,
      );
    }
    // The export store sees each event first, because an adoption of the queue store reads
    // the end of the run that the export store shows.
    for (const event of eventsAfter(events, snapshot.seq)) {
      exportApi.getState().replayEvent(event);
      queueApi.getState().replayEvent(event);
    }
    return true;
  }

  /** Takes the held events and stops holding events back. */
  function release(): ExportProgressEvent[] {
    const events = held ?? [];
    held = null;
    return events;
  }

  /**
   * Reads the snapshot a second time, for a run that neither store knows. Once only. `first`
   * is the event that showed the run. The second read holds it back with the events after it.
   */
  function reread(first: ExportProgressEvent | null): void {
    if (rereadDone) {
      return;
    }
    rereadDone = true;
    stopWatching();
    const openAgain = gate.close();
    held = first === null ? [] : [first];
    // An async wrapper turns a synchronous throw of the call into a rejection.
    const snapshotCall = (async () => await dependencies.snapshot())();
    withinLimit(snapshotCall)
      .then(
        (snapshot) => {
          restore(snapshot, release());
        },
        () => {
          release();
        },
      )
      .catch((error: unknown) => {
        console.error("Failed to restore the export queue:", error);
      })
      .finally(openAgain);
  }

  function onEvent(event: ExportProgressEvent): void {
    if (held !== null) {
      held.push(event);
      return;
    }
    if (watching && isUnknownStart(event)) {
      // The live handlers of both stores ignored this event.
      onUnknownStart(event);
    }
  }

  let expired = false;
  const firstRead = async (): Promise<ExportQueueSnapshot> => {
    await Promise.all([
      exportApi.getState().ensureSubscribed(),
      queueApi.getState().ensureSubscribed(),
      dependencies.subscribe(onEvent),
    ]);
    if (expired) {
      throw new Error("The export queue snapshot passed its time limit.");
    }
    return await dependencies.snapshot();
  };

  let snapshot: ExportQueueSnapshot;
  try {
    snapshot = await withinLimit(firstRead(), () => {
      expired = true;
    });
  } catch {
    release();
    openGate();
    return "failed";
  }

  try {
    const events = release();
    const restored = restore(snapshot, events);
    watching = true;
    watchSubmissions();
    // A held event can already name a run that neither store knows.
    const unknown = events.find((event) => isUnknownStart(event));
    if (unknown !== undefined) {
      onUnknownStart(unknown);
    }
    return restored ? "restored" : "nothing";
  } finally {
    openGate();
  }
}

/**
 * Makes a start function that runs `recoverExportQueue` once, whatever the number of calls.
 * React StrictMode runs an effect twice in development. Each call returns the same promise.
 */
export function createExportQueueRecoveryStarter(
  dependencies: () => ExportQueueRecoveryDependencies,
): () => Promise<ExportQueueRecoveryOutcome> {
  let recovery: Promise<ExportQueueRecoveryOutcome> | null = null;
  return () => {
    recovery ??= recoverExportQueue(dependencies());
    return recovery;
  };
}

/**
 * The data that the starter keeps across a hot reload of this module in development. A Fast
 * Refresh loads this module again, and the new starter takes the promise of the old one, so
 * the recovery still runs once per page.
 */
type ExportQueueRecoveryHotData = {
  recovery?: Promise<ExportQueueRecoveryOutcome>;
};

const hotData = import.meta.hot?.data as ExportQueueRecoveryHotData | undefined;

const startOnce = createExportQueueRecoveryStarter(() => ({
  exportStore,
  queueStore: exportQueueStore,
  snapshot: () => exportQueueSnapshot(),
  subscribe: (handler) => subscribeExportProgress(handler),
  timing: exportRunTimingStore,
  now: () => performance.now(),
  eventFloor: exportEventFloor,
  gate: exportRecoveryGate,
}));

function runExportQueueRecovery(): Promise<ExportQueueRecoveryOutcome> {
  if (hotData) {
    hotData.recovery ??= startOnce();
    return hotData.recovery;
  }
  return startOnce();
}

/**
 * Starts the recovery of the production stores, once per page, for an effect of the
 * application shell. The recovery lasts for the life of the page, so the returned cleanup
 * does nothing.
 */
export function startExportQueueRecovery(): () => void {
  runExportQueueRecovery().catch((error: unknown) => {
    console.error("Failed to restore the export queue:", error);
  });
  return () => {};
}
