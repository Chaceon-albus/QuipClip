import { describe, expect, it, vi } from "vitest";
import { presentExportQueue } from "@/components/export/exportQueuePresenter";
import { decideStopClick } from "@/components/export/exportStopPresenter";
import { countQueuedExports } from "@/components/layout/quitGuard";
import { createPresetDraft } from "@/features/settings/presetDocument";
import type { Pts } from "@/types/project";
import { createExportEventFloor } from "./eventFloor";
import { createExportQueueStore, selectExportQueueRows } from "./queueStore";
import {
  createExportQueueRecoveryStarter,
  planExportQueueRestore,
  recoverExportQueue,
  type ExportQueueRecoveryDependencies,
} from "./recovery";
import { createExportRecoveryGate } from "./recoveryGate";
import { bindRunTimingToExportRun, createExportRunTimingStore } from "./runTiming";
import { createExportStore } from "./store";
import type {
  ExportProgressEvent,
  ExportQueueSnapshot,
  ExportQueueSnapshotRun,
  ExportRequest,
  ExportSubmission,
} from "./types";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function createRequest(outputPath: string): ExportRequest {
  return {
    sourcePath: "/media/source.mp4",
    outputPath,
    segments: [{ inPts: "0" as Pts, outPts: "1000" as Pts }],
    preset: createPresetDraft("mp4-h264", "New preset"),
    streams: "videoAndAudio",
    audioMode: "encode",
  };
}

function run(
  runId: string,
  phase: ExportQueueSnapshotRun["phase"],
  extra: Partial<ExportQueueSnapshotRun> = {},
): ExportQueueSnapshotRun {
  return {
    runId,
    outputPath: `/out/${runId}.mp4`,
    presetName: `Preset ${runId}`,
    segmentCount: 2,
    streams: "videoAndAudio",
    phase,
    ...extra,
  };
}

/**
 * A batch at `seq` 10: run-1 finished, run-2 runs at frame 100 for 120 seconds, and run-3 and
 * run-4 wait.
 */
function batchSnapshot(): ExportQueueSnapshot {
  return {
    seq: 10,
    runs: [
      run("run-1", "finished", { frame: 30, endOrder: 4 }),
      run("run-2", "running", { frame: 100, expectedFrames: 300, elapsedMs: 120_000 }),
      run("run-3", "waiting"),
      run("run-4", "waiting"),
    ],
  };
}

/**
 * Real stores, a fake backend, and a recovery wired to them. Every listener hears `emit`, in the
 * order of subscription. Each snapshot call takes the next deferred answer of `snapshots`.
 * With `deferSubscriptions`, each subscription resolves only when the test resolves its entry of
 * `subscriptions`. The timers of the recovery wait in `timers` until the test fires them.
 */
function createFixture(options: { deferSubscriptions?: boolean } = {}) {
  const handlers: Array<(event: ExportProgressEvent) => void> = [];
  const subscriptions: Array<ReturnType<typeof createDeferred<void>>> = [];
  const subscribe = (handler: (event: ExportProgressEvent) => void) => {
    handlers.push(handler);
    if (!options.deferSubscriptions) {
      return Promise.resolve(() => {});
    }
    const deferred = createDeferred<void>();
    subscriptions.push(deferred);
    return deferred.promise.then(() => () => {});
  };
  const timers: Array<{ callback: () => void; ms: number; canceled: boolean }> = [];
  const setTimer = (callback: () => void, ms: number) => {
    const timer = { callback, ms, canceled: false };
    timers.push(timer);
    return () => {
      timer.canceled = true;
    };
  };
  /** Fires every timer that is still set, as if its time came. */
  const fireTimers = () => {
    for (const timer of timers.splice(0)) {
      if (!timer.canceled) timer.callback();
    }
  };
  let nextRun = 50;
  const start = vi.fn((_request: ExportRequest): Promise<ExportSubmission> =>
    Promise.resolve({ runId: `run-${nextRun++}`, queued: true }),
  );
  const cancel = vi.fn((_runId: string) => Promise.resolve(true));
  const eventFloor = createExportEventFloor();
  const gate = createExportRecoveryGate();
  const exportStore = createExportStore({
    subscribeExportProgress: subscribe,
    startExport: start,
    cancelExport: cancel,
    eventFloor,
  });
  const queue = createExportQueueStore({
    exportStore,
    startExport: start,
    cancelExport: cancel,
    subscribeExportProgress: subscribe,
    eventFloor,
    recoveryGate: gate,
  });
  const clock = { now: 1_000_000 };
  const timing = createExportRunTimingStore();
  bindRunTimingToExportRun(exportStore, timing, () => clock.now);

  const snapshots: Array<ReturnType<typeof createDeferred<ExportQueueSnapshot>>> = [];
  const snapshot = vi.fn(() => {
    const deferred = createDeferred<ExportQueueSnapshot>();
    snapshots.push(deferred);
    return deferred.promise;
  });
  const dependencies: ExportQueueRecoveryDependencies = {
    exportStore,
    queueStore: queue,
    snapshot,
    subscribe,
    timing,
    now: () => clock.now,
    eventFloor,
    gate,
    timeoutMs: 10_000,
    setTimer,
  };
  const emit = (event: ExportProgressEvent) => {
    for (const handler of [...handlers]) handler(event);
  };
  return {
    exportStore,
    queue,
    start,
    cancel,
    timing,
    clock,
    snapshots,
    snapshot,
    dependencies,
    emit,
    gate,
    eventFloor,
    subscriptions,
    timers,
    fireTimers,
  };
}

/** Starts a recovery and waits until it called the snapshot. */
async function startRecovery(fixture: ReturnType<typeof createFixture>) {
  const recovery = recoverExportQueue(fixture.dependencies);
  await flush();
  expect(fixture.snapshot).toHaveBeenCalledTimes(1);
  // Wrapped, because an async function that returns a promise waits for it.
  return { recovery };
}

describe("planExportQueueRestore", () => {
  it("restores nothing when every run of the snapshot ended", () => {
    expect(
      planExportQueueRestore({
        seq: 3,
        runs: [run("a", "finished", { endOrder: 2 })],
      }),
    ).toBeNull();
    expect(planExportQueueRestore({ seq: 0, runs: [] })).toBeNull();
  });

  it("sorts the ended runs by endOrder and keeps their errors", () => {
    const plan = planExportQueueRestore({
      seq: 9,
      runs: [
        run("b", "failed", {
          endOrder: 17,
          error: { code: "ffmpegProcessFailed", exitCode: 1 },
        }),
        run("a", "canceled", { endOrder: 12, error: { code: "canceled" } }),
        run("c", "waiting"),
      ],
    });
    expect(plan?.active).toBeNull();
    expect(plan?.queue.ended.map((e) => [e.runId, e.status, e.error?.code])).toEqual([
      ["a", "canceled", "canceled"],
      ["b", "failed", "ffmpegProcessFailed"],
    ]);
    expect(plan?.queue.waiting).toEqual(["c"]);
    expect(plan?.queue.jobs.map((job) => job.runId)).toEqual(["b", "a", "c"]);
  });
});

describe("recoverExportQueue", () => {
  it("restores both stores from a batch that goes on", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.snapshots[0]?.resolve(batchSnapshot());
    await expect(recovery).resolves.toBe("restored");

    expect(fixture.exportStore.getState()).toMatchObject({
      status: "running",
      runId: "run-2",
      outputPath: "/out/run-2.mp4",
      segmentCount: 2,
      frame: 100,
      expectedFrames: 300,
      encodeStarted: true,
      tracking: true,
      error: null,
    });
    expect(fixture.queue.getState()).toMatchObject({
      order: ["run-1", "run-2", "run-3", "run-4"],
      waiting: ["run-3", "run-4"],
      ended: [{ runId: "run-1", status: "finished", error: null }],
      removing: [],
      seenEndedCount: 0,
      submitting: 0,
      enqueuing: 0,
    });
    expect(fixture.queue.getState().jobs["run-3"]).toEqual({
      runId: "run-3",
      outputPath: "/out/run-3.mp4",
      presetName: "Preset run-3",
      segmentCount: 2,
      streams: "videoAndAudio",
    });
    expect(fixture.gate.pending()).toBeNull();
  });

  it("drops the held events at or below the snapshot and replays the later ones in order", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);

    // Held while the snapshot is read. The first is in the snapshot already. The others come
    // out of order, and the end of run-2 must reach the export store before run-3 starts.
    fixture.emit({ seq: 9, event: "progress", runId: "run-2", frame: 90 });
    fixture.emit({ seq: 13, event: "progress", runId: "run-3", frame: 5 });
    fixture.emit({ seq: 12, event: "preparing", runId: "run-3" });
    fixture.emit({
      seq: 11,
      event: "finished",
      runId: "run-2",
      outputPath: "/out/run-2.mp4",
      frames: 300,
    });
    // The stores hold nothing yet, so the live handlers ignored these events.
    expect(fixture.exportStore.getState().status).toBe("idle");

    fixture.snapshots[0]?.resolve(batchSnapshot());
    await expect(recovery).resolves.toBe("restored");

    expect(fixture.exportStore.getState()).toMatchObject({
      status: "running",
      runId: "run-3",
      frame: 5,
      tracking: true,
    });
    expect(fixture.queue.getState()).toMatchObject({
      waiting: ["run-4"],
      ended: [
        { runId: "run-1", status: "finished", error: null },
        { runId: "run-2", status: "finished", error: null },
      ],
    });
    // Run-3 is known, so no second read follows.
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);
  });

  it("drops a held event at or below the snapshot", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.emit({ seq: 10, event: "progress", runId: "run-2", frame: 90 });
    fixture.snapshots[0]?.resolve(batchSnapshot());
    await recovery;
    expect(fixture.exportStore.getState().frame).toBe(100);
  });

  it("drops a late live event at or below the snapshot", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.snapshots[0]?.resolve(batchSnapshot());
    await recovery;

    fixture.emit({ seq: 8, event: "progress", runId: "run-2", frame: 50 });
    fixture.emit({ seq: 7, event: "preparing", runId: "run-3" });
    expect(fixture.exportStore.getState()).toMatchObject({
      runId: "run-2",
      frame: 100,
    });
    expect(fixture.queue.getState().waiting).toEqual(["run-3", "run-4"]);

    fixture.emit({ seq: 11, event: "progress", runId: "run-2", frame: 120 });
    expect(fixture.exportStore.getState().frame).toBe(120);
    fixture.emit({
      seq: 12,
      event: "finished",
      runId: "run-2",
      outputPath: "/out/run-2.mp4",
      frames: 300,
    });
    fixture.emit({ seq: 13, event: "preparing", runId: "run-3" });
    expect(fixture.exportStore.getState()).toMatchObject({
      status: "preparing",
      runId: "run-3",
    });
    expect(fixture.queue.getState().waiting).toEqual(["run-4"]);
  });

  it("restores nothing when no run of the snapshot waits or runs", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.snapshots[0]?.resolve({
      seq: 30,
      runs: [run("run-1", "finished", { endOrder: 1 })],
    });
    await expect(recovery).resolves.toBe("nothing");
    expect(fixture.exportStore.getState().status).toBe("idle");
    expect(fixture.queue.getState().order).toEqual([]);
    expect(fixture.eventFloor.value()).toBe(0);
    expect(fixture.gate.pending()).toBeNull();
  });

  it("restores nothing and opens the gate when the snapshot rejects", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    expect(fixture.gate.pending()).not.toBeNull();
    fixture.emit({ seq: 4, event: "preparing", runId: "run-2" });
    fixture.snapshots[0]?.reject(new Error("no backend"));
    await expect(recovery).resolves.toBe("failed");

    expect(fixture.gate.pending()).toBeNull();
    expect(fixture.exportStore.getState().status).toBe("idle");
    expect(fixture.queue.getState().order).toEqual([]);
    expect(fixture.eventFloor.value()).toBe(0);
    // A later submission starts a new batch at once.
    await expect(
      fixture.queue.getState().submit(createRequest("/out/new.mp4")),
    ).resolves.toEqual({ kind: "started", runId: "run-50" });
  });

  it("restores nothing and opens the gate when a subscription rejects", async () => {
    const fixture = createFixture();
    const recovery = recoverExportQueue({
      ...fixture.dependencies,
      subscribe: () => Promise.reject(new Error("no runtime")),
    });
    await expect(recovery).resolves.toBe("failed");
    expect(fixture.snapshot).not.toHaveBeenCalled();
    expect(fixture.gate.pending()).toBeNull();
  });

  it("holds a submission until the recovery ends, then queues it", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);

    const submitting = fixture.queue.getState().submit(createRequest("/out/new.mp4"));
    const duplicate = fixture.queue.getState().submit(createRequest("/out/run-3.mp4"));
    await flush();
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.queue.getState()).toMatchObject({ submitting: 0, enqueuing: 0 });

    // The restore sees no submission in flight.
    const atRestore: Array<{ submitting: number; enqueuing: number }> = [];
    const unsubscribe = fixture.queue.subscribe((state, previous) => {
      if (state.order !== previous.order && state.order.includes("run-2")) {
        atRestore.push({ submitting: state.submitting, enqueuing: state.enqueuing });
      }
    });
    fixture.snapshots[0]?.resolve(batchSnapshot());
    await recovery;
    unsubscribe();
    expect(atRestore[0]).toEqual({ submitting: 0, enqueuing: 0 });

    await expect(submitting).resolves.toEqual({ kind: "queued", runId: "run-50" });
    // The duplicate check ran after the restore, so it sees the waiting run-3.
    await expect(duplicate).resolves.toMatchObject({
      kind: "refused",
      error: { code: "outputAlreadyQueued" },
    });
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.start.mock.calls[0]?.[0]).not.toHaveProperty("newBatch");
    expect(fixture.queue.getState().waiting).toEqual(["run-3", "run-4", "run-50"]);
    expect(fixture.exportStore.getState().runId).toBe("run-2");
  });

  it("holds a submission until the recovery ends, then starts a new batch", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    const submitting = fixture.queue.getState().submit(createRequest("/out/new.mp4"));
    fixture.snapshots[0]?.resolve({ seq: 2, runs: [] });
    await recovery;
    await expect(submitting).resolves.toEqual({ kind: "started", runId: "run-50" });
    expect(fixture.start.mock.calls[0]?.[0]).toMatchObject({ newBatch: true });
  });

  it("runs one recovery for two starts", async () => {
    const fixture = createFixture();
    const startRecoveryOnce = createExportQueueRecoveryStarter(
      () => fixture.dependencies,
    );
    const first = startRecoveryOnce();
    const second = startRecoveryOnce();
    expect(second).toBe(first);
    await flush();
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);
    fixture.snapshots[0]?.resolve(batchSnapshot());
    await expect(first).resolves.toBe("restored");
  });

  it("needs two Stop clicks for a restored run that ran for two minutes", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.snapshots[0]?.resolve(batchSnapshot());
    await recovery;

    const { startedAt, endedAt } = fixture.timing.getState();
    expect(startedAt).toBe(1_000_000 - 120_000);
    expect(endedAt).toBeNull();

    const first = decideStopClick({ now: 1_000_100, startedAt, armedAt: null });
    expect(first).toEqual({ kind: "arm", armedAt: 1_000_100 });
    expect(decideStopClick({ now: 1_001_200, startedAt, armedAt: 1_000_100 })).toEqual({
      kind: "stop",
    });

    // A later phase of the same run keeps the start.
    fixture.clock.now = 1_005_000;
    fixture.emit({ seq: 11, event: "publishing", runId: "run-2" });
    expect(fixture.timing.getState().startedAt).toBe(880_000);
  });

  it("lets the quit guard count the restored waiting runs", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.snapshots[0]?.resolve(batchSnapshot());
    await recovery;
    expect(countQueuedExports(fixture.queue.getState())).toBe(2);
  });

  it("restores the state between two runs with an idle export store", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.snapshots[0]?.resolve({
      seq: 6,
      runs: [run("run-1", "finished", { endOrder: 1 }), run("run-2", "waiting")],
    });
    await expect(recovery).resolves.toBe("restored");
    expect(fixture.exportStore.getState().status).toBe("idle");
    expect(fixture.queue.getState()).toMatchObject({
      order: ["run-1", "run-2"],
      waiting: ["run-2"],
    });

    fixture.emit({ seq: 7, event: "preparing", runId: "run-2" });
    expect(fixture.exportStore.getState()).toMatchObject({
      status: "preparing",
      runId: "run-2",
      outputPath: "/out/run-2.mp4",
    });
  });

  it("shows the restored ended runs with Show File in the queue list", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.snapshots[0]?.resolve({
      seq: 10,
      runs: [
        run("run-1", "finished", { frame: 30, endOrder: 1 }),
        run("run-0", "failed", { endOrder: 2, error: { code: "ffmpegProcessFailed" } }),
        ...batchSnapshot().runs.slice(1),
      ],
    });
    await recovery;
    const queue = fixture.queue.getState();
    const exportState = fixture.exportStore.getState();
    const view = presentExportQueue({
      rows: selectExportQueueRows(queue, exportState),
      batchSize: queue.order.length,
      exportState,
      outputActions: { runs: {} },
    });
    expect(
      view?.rows.map((row) => [row.runId, row.statusKey, row.show !== null]),
    ).toEqual([
      ["run-1", "export.queue.status.finished", true],
      ["run-0", "export.queue.status.failed", false],
      ["run-2", "export.queue.status.current", false],
      ["run-3", "export.queue.status.waiting", false],
      ["run-4", "export.queue.status.waiting", false],
    ]);
  });

  it("reads the snapshot once more for a run that neither store knows", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.snapshots[0]?.resolve({
      seq: 10,
      runs: [
        run("run-1", "finished", { endOrder: 1 }),
        run("run-2", "running", { frame: 100, elapsedMs: 5_000 }),
      ],
    });
    await recovery;

    // A start of the page before the reload reached the backend after the snapshot, and took
    // the slot when run-2 ended.
    fixture.emit({
      seq: 11,
      event: "finished",
      runId: "run-2",
      outputPath: "/out/run-2.mp4",
      frames: 300,
    });
    fixture.emit({ seq: 12, event: "preparing", runId: "run-9" });
    expect(fixture.snapshot).toHaveBeenCalledTimes(2);
    const gate = fixture.gate.pending();
    expect(gate).not.toBeNull();

    // A submission waits for the second read too.
    const submitting = fixture.queue.getState().submit(createRequest("/out/new.mp4"));
    fixture.emit({
      seq: 13,
      event: "started",
      runId: "run-9",
      outputPath: "/out/run-9.mp4",
      segmentCount: 2,
      expectedFrames: 600,
      totalDurationUs: 20_000_000,
    });
    await flush();
    expect(fixture.start).not.toHaveBeenCalled();

    fixture.clock.now = 2_000_000;
    fixture.snapshots[1]?.resolve({
      seq: 13,
      runs: [
        run("run-1", "finished", { endOrder: 1 }),
        run("run-2", "finished", { frame: 300, endOrder: 2 }),
        run("run-9", "running", { expectedFrames: 600, elapsedMs: 120_000 }),
      ],
    });
    await gate;
    expect(fixture.gate.pending()).toBeNull();
    expect(fixture.exportStore.getState()).toMatchObject({
      status: "running",
      runId: "run-9",
      encodeStarted: true,
      tracking: true,
    });
    expect(fixture.queue.getState()).toMatchObject({
      order: ["run-1", "run-2", "run-9"],
      ended: [
        { runId: "run-1", status: "finished" },
        { runId: "run-2", status: "finished" },
      ],
    });
    expect(fixture.eventFloor.value()).toBe(13);

    const { startedAt } = fixture.timing.getState();
    expect(startedAt).toBe(2_000_000 - 120_000);
    expect(decideStopClick({ now: 2_000_100, startedAt, armedAt: null })).toEqual({
      kind: "arm",
      armedAt: 2_000_100,
    });
    expect(decideStopClick({ now: 2_001_000, startedAt, armedAt: 2_000_100 })).toEqual({
      kind: "stop",
    });

    await expect(submitting).resolves.toEqual({ kind: "queued", runId: "run-50" });

    // The second read is the last one.
    fixture.emit({ seq: 20, event: "preparing", runId: "run-77" });
    expect(fixture.snapshot).toHaveBeenCalledTimes(2);
  });

  it("checks an unknown start again when the submission of this page has its answer", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.snapshots[0]?.resolve({
      seq: 10,
      runs: [run("run-2", "running", { frame: 100, elapsedMs: 5_000 })],
    });
    await recovery;

    // The user adds X to the queue, and its answer is pending.
    const answer = createDeferred<ExportSubmission>();
    fixture.start.mockImplementationOnce(() => answer.promise);
    const submitting = fixture.queue.getState().submit(createRequest("/out/x.mp4"));
    await flush();
    expect(fixture.queue.getState().submitting).toBe(1);

    fixture.emit({
      seq: 11,
      event: "finished",
      runId: "run-2",
      outputPath: "/out/run-2.mp4",
      frames: 300,
    });
    // Run-9 could be the run of X, so the recovery does not read yet.
    fixture.emit({ seq: 12, event: "preparing", runId: "run-9" });
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);

    answer.resolve({ runId: "run-60", queued: true });
    await expect(submitting).resolves.toEqual({ kind: "queued", runId: "run-60" });
    // X is run-60, so run-9 is still unknown.
    expect(fixture.snapshot).toHaveBeenCalledTimes(2);

    fixture.snapshots[1]?.resolve({
      seq: 12,
      runs: [
        run("run-2", "finished", { frame: 300, endOrder: 1 }),
        run("run-9", "preparing", { elapsedMs: 50 }),
        run("run-60", "waiting"),
      ],
    });
    await fixture.gate.pending();
    expect(fixture.exportStore.getState()).toMatchObject({
      status: "preparing",
      runId: "run-9",
      tracking: true,
    });
    expect(fixture.queue.getState().waiting).toEqual(["run-60"]);
  });

  it("does not read again when the unknown start was the run of the submission", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.snapshots[0]?.resolve({
      seq: 10,
      runs: [run("run-2", "running", { frame: 100, elapsedMs: 5_000 })],
    });
    await recovery;

    const answer = createDeferred<ExportSubmission>();
    fixture.start.mockImplementationOnce(() => answer.promise);
    const submitting = fixture.queue.getState().submit(createRequest("/out/x.mp4"));
    await flush();
    fixture.emit({
      seq: 11,
      event: "finished",
      runId: "run-2",
      outputPath: "/out/run-2.mp4",
      frames: 300,
    });
    fixture.emit({ seq: 12, event: "preparing", runId: "run-60" });
    answer.resolve({ runId: "run-60", queued: true });
    await submitting;
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);
    expect(fixture.exportStore.getState().runId).toBe("run-60");
  });

  it("opens the gate when a restore throws", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    let thrown = false;
    fixture.exportStore.subscribe(() => {
      if (!thrown) {
        thrown = true;
        throw new Error("listener failed");
      }
    });
    fixture.snapshots[0]?.resolve(batchSnapshot());
    await expect(recovery).rejects.toThrow("listener failed");
    expect(fixture.gate.pending()).toBeNull();
    await expect(
      fixture.queue.getState().submit(createRequest("/out/new.mp4")),
    ).resolves.toBeDefined();
  });

  it("fails at the time limit and ignores a late snapshot", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    expect(fixture.timers.map((timer) => timer.ms)).toEqual([10_000]);
    fixture.emit({ seq: 11, event: "progress", runId: "run-2", frame: 110 });
    fixture.fireTimers();
    await expect(recovery).resolves.toBe("failed");
    expect(fixture.gate.pending()).toBeNull();

    fixture.snapshots[0]?.resolve(batchSnapshot());
    await flush();
    expect(fixture.exportStore.getState().status).toBe("idle");
    expect(fixture.queue.getState().order).toEqual([]);
    expect(fixture.eventFloor.value()).toBe(0);
  });

  it("fails at the time limit while the subscriptions wait, and reads no snapshot", async () => {
    const fixture = createFixture({ deferSubscriptions: true });
    const recovery = recoverExportQueue(fixture.dependencies);
    await flush();
    fixture.fireTimers();
    await expect(recovery).resolves.toBe("failed");
    expect(fixture.gate.pending()).toBeNull();
    for (const subscription of fixture.subscriptions) subscription.resolve();
    await flush();
    expect(fixture.snapshot).not.toHaveBeenCalled();
  });

  it("opens the gate when the second read passes the time limit", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.snapshots[0]?.resolve({ seq: 10, runs: [] });
    await recovery;
    fixture.emit({ seq: 11, event: "preparing", runId: "run-9" });
    expect(fixture.snapshot).toHaveBeenCalledTimes(2);
    const gate = fixture.gate.pending();
    expect(gate).not.toBeNull();
    fixture.fireTimers();
    await gate;
    expect(fixture.gate.pending()).toBeNull();

    fixture.snapshots[1]?.resolve({ seq: 11, runs: [run("run-9", "preparing")] });
    await flush();
    expect(fixture.exportStore.getState().status).toBe("idle");
  });

  it("calls the snapshot only after all three subscriptions are live", async () => {
    const fixture = createFixture({ deferSubscriptions: true });
    const recovery = recoverExportQueue(fixture.dependencies);
    await flush();
    expect(fixture.subscriptions).toHaveLength(3);
    for (const subscription of fixture.subscriptions) {
      expect(fixture.snapshot).not.toHaveBeenCalled();
      subscription.resolve();
      await flush();
    }
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);
    fixture.snapshots[0]?.resolve(batchSnapshot());
    await expect(recovery).resolves.toBe("restored");
  });

  it("keeps a removal of a run that still waits after a second restore", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.snapshots[0]?.resolve(batchSnapshot());
    await recovery;
    const cancel = createDeferred<boolean>();
    fixture.cancel.mockImplementationOnce(() => cancel.promise);
    void fixture.queue.getState().remove("run-3");
    void fixture.queue.getState().remove("run-4");
    await flush();
    expect(fixture.queue.getState().removing).toEqual(["run-3", "run-4"]);
    fixture.queue.getState().restore({
      jobs: [],
      waiting: ["run-4"],
      ended: [],
    });
    expect(fixture.queue.getState().removing).toEqual(["run-4"]);
    cancel.resolve(true);
  });

  it("reads the snapshot once more for a held event of an unknown run", async () => {
    const fixture = createFixture();
    const { recovery } = await startRecovery(fixture);
    fixture.emit({ seq: 11, event: "preparing", runId: "run-9" });
    fixture.snapshots[0]?.resolve({ seq: 10, runs: [] });
    await expect(recovery).resolves.toBe("nothing");
    expect(fixture.snapshot).toHaveBeenCalledTimes(2);
    const gate = fixture.gate.pending();
    expect(gate).not.toBeNull();

    fixture.snapshots[1]?.resolve({
      seq: 11,
      runs: [run("run-9", "preparing", { elapsedMs: 40 })],
    });
    await gate;
    expect(fixture.exportStore.getState()).toMatchObject({
      status: "preparing",
      runId: "run-9",
      encodeStarted: false,
      tracking: true,
    });
    expect(fixture.queue.getState().order).toEqual(["run-9"]);
  });
});
