import { ProgressBarStatus, type ProgressBarState } from "@tauri-apps/api/window";
import { describe, expect, it, vi } from "vitest";
import {
  createExportQueueStore,
  createExportStore,
  exportBatchContinues,
  exportBatchEndsOf,
  exportBatchHasFailure,
  type ExportBatchQueueState,
  type ExportProgressEvent,
  type ExportRequest,
  type ExportSubmission,
  type ExportState,
  type ExportStoreState,
} from "@/features/export";
import type { StoreApi } from "zustand/vanilla";
import type { Pts } from "@/types/project";
import type { TaskbarProgressInput } from "./taskbarProgressSync";
import {
  resolveTaskbarProgress,
  startTaskbarProgressSync,
} from "./taskbarProgressSync";
import { createPresetDraft } from "@/features/settings/presetDocument";

function createInput(
  overrides: Partial<TaskbarProgressInput> = {},
): TaskbarProgressInput {
  return {
    status: "running",
    frame: 50,
    expectedFrames: 100,
    fps: { n: 25, d: 1 },
    speed: { n: 1, d: 1 },
    cancelRequested: false,
    tracking: true,
    encodeStarted: true,
    ...overrides,
  };
}

const KEEP = { resetIndeterminateValue: false };
const RESET = { resetIndeterminateValue: true };

function resolve(overrides: Partial<TaskbarProgressInput> = {}): ProgressBarState {
  return resolveTaskbarProgress(createInput(overrides), KEEP);
}

function createSpy() {
  return vi.fn<(state: ProgressBarState) => Promise<void>>(() => Promise.resolve());
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function callsOf(spy: ReturnType<typeof createSpy>): ProgressBarState[] {
  return spy.mock.calls.map(([state]) => state);
}

function lastCallOf(spy: ReturnType<typeof createSpy>): ProgressBarState | undefined {
  const calls = callsOf(spy);
  return calls[calls.length - 1];
}

describe("resolveTaskbarProgress", () => {
  it.each(["idle", "finished", "canceled"] as const)(
    "hides the bar for %s",
    (status) => {
      for (const options of [KEEP, RESET]) {
        expect(resolveTaskbarProgress(createInput({ status }), options)).toEqual({
          status: ProgressBarStatus.None,
        });
      }
    },
  );

  const indeterminateRows: [string, Partial<TaskbarProgressInput>][] = [
    ["preparing", { status: "preparing" }],
    ["running with a null frame goal", { expectedFrames: null }],
    ["running with a zero frame goal", { expectedFrames: 0 }],
    [
      "preparing with an outstanding cancel",
      { status: "preparing", cancelRequested: true },
    ],
  ];

  it.each(indeterminateRows)(
    "shows an indeterminate bar with no value for %s",
    (_name, overrides) => {
      expect(resolveTaskbarProgress(createInput(overrides), KEEP)).toEqual({
        status: ProgressBarStatus.Indeterminate,
      });
    },
  );

  it.each(indeterminateRows)(
    "shows an indeterminate bar with a zero value for %s when the reset is on",
    (_name, overrides) => {
      expect(resolveTaskbarProgress(createInput(overrides), RESET)).toEqual({
        status: ProgressBarStatus.Indeterminate,
        progress: 0,
      });
    },
  );

  it("shows the whole percent while running", () => {
    expect(resolve({ frame: 50 })).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 50,
    });
    expect(resolveTaskbarProgress(createInput({ frame: 50 }), RESET)).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 50,
    });
  });

  it("floors the percent", () => {
    expect(resolve({ frame: 2, expectedFrames: 3 })).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 66,
    });
    expect(resolve({ frame: 999, expectedFrames: 1000 })).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 99,
    });
  });

  it("clamps the percent to 0..100", () => {
    expect(resolve({ frame: 250 })).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 100,
    });
    expect(resolve({ frame: -5 })).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 0,
    });
    expect(resolve({ frame: null })).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 0,
    });
  });

  it("shows a full bar while publishing", () => {
    expect(resolve({ status: "publishing" })).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 100,
    });
  });

  it("shows a full error bar after a failure", () => {
    expect(resolve({ status: "failed", tracking: false })).toEqual({
      status: ProgressBarStatus.Error,
      progress: 100,
    });
  });

  it("shows the running state, not the error, for a failure that the store still tracks", () => {
    // A Stop request failed, and the backend still encodes.
    expect(resolve({ status: "failed", tracking: true, frame: 50 })).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 50,
    });
    // Before the encode started, the run is still in its preparation.
    const preparing = {
      status: "failed",
      tracking: true,
      frame: null,
      encodeStarted: false,
    } as const;
    expect(resolve(preparing)).toEqual({ status: ProgressBarStatus.Indeterminate });
    expect(resolveTaskbarProgress(createInput(preparing), RESET)).toEqual({
      status: ProgressBarStatus.Indeterminate,
      progress: 0,
    });
    // After `started` and before the first frame, the encode runs at 0 percent.
    expect(resolve({ status: "failed", tracking: true, frame: null })).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 0,
    });
  });

  it.each(["finished", "failed", "canceled", "idle"] as const)(
    "shows an indeterminate bar for %s while the batch goes on",
    (status) => {
      expect(resolve({ status, tracking: false, batchContinues: true })).toEqual({
        status: ProgressBarStatus.Indeterminate,
      });
      expect(
        resolveTaskbarProgress(
          createInput({ status, tracking: false, batchContinues: true }),
          RESET,
        ),
      ).toEqual({ status: ProgressBarStatus.Indeterminate, progress: 0 });
    },
  );

  it("shows the error state at the end of a batch with a failed run", () => {
    for (const status of ["finished", "canceled", "failed", "idle"] as const) {
      expect(resolve({ status, tracking: false, batchFailed: true })).toEqual({
        status: ProgressBarStatus.Error,
        progress: 100,
      });
    }
    // Between two runs, the bar shows no end.
    expect(
      resolve({
        status: "failed",
        tracking: false,
        batchContinues: true,
        batchFailed: true,
      }),
    ).toEqual({ status: ProgressBarStatus.Indeterminate });
  });

  it("shows the progress of a live run while the batch goes on", () => {
    expect(resolve({ frame: 50, batchContinues: true })).toEqual({
      status: ProgressBarStatus.Normal,
      progress: 50,
    });
  });

  it.each(["preparing", "running", "publishing", "idle", "failed"] as const)(
    "ignores an outstanding cancel in %s",
    (status) => {
      for (const options of [KEEP, RESET]) {
        expect(
          resolveTaskbarProgress(
            createInput({ status, cancelRequested: true }),
            options,
          ),
        ).toEqual(
          resolveTaskbarProgress(
            createInput({ status, cancelRequested: false }),
            options,
          ),
        );
      }
    },
  );
});

describe("startTaskbarProgressSync", () => {
  function setup(initialState?: Partial<ExportState>, resetIndeterminateValue = false) {
    const store = createExportStore({}, initialState);
    const setProgressBar = createSpy();
    const stop = startTaskbarProgressSync({
      store,
      setProgressBar,
      resetIndeterminateValue,
    });
    return { store, setProgressBar, stop };
  }

  it("sends None once for an idle store at start", async () => {
    const { store, setProgressBar, stop } = setup();
    expect(callsOf(setProgressBar)).toEqual([{ status: ProgressBarStatus.None }]);
    await flushPromises();
    store.setState({ status: "finished" });
    await flushPromises();
    expect(setProgressBar).toHaveBeenCalledTimes(1);
    stop();
  });

  it("sends the current state once for a store that starts running", () => {
    const { setProgressBar, stop } = setup({
      status: "running",
      frame: 25,
      expectedFrames: 100,
    });
    expect(callsOf(setProgressBar)).toEqual([
      { status: ProgressBarStatus.Normal, progress: 25 },
    ]);
    stop();
  });

  it("does not repeat a call while the whole percent stays the same", async () => {
    const { store, setProgressBar, stop } = setup({
      status: "running",
      frame: 250,
      expectedFrames: 1000,
    });
    await flushPromises();
    store.setState({ frame: 251 });
    await flushPromises();
    store.setState({ frame: 259, speed: { n: 2, d: 1 } });
    await flushPromises();
    store.setState({ cancelRequested: true });
    await flushPromises();
    expect(setProgressBar).toHaveBeenCalledTimes(1);
    stop();
  });

  it.each([false, true])(
    "calls again when the percent or the status changes (reset %s)",
    async (reset) => {
      const { store, setProgressBar, stop } = setup(undefined, reset);
      const steps: Partial<ExportState>[] = [
        { status: "preparing" },
        { status: "running", frame: 0, expectedFrames: 100 },
        { frame: 1 },
        { status: "publishing" },
        { status: "finished" },
      ];
      for (const step of steps) {
        await flushPromises();
        store.setState(step);
      }
      await flushPromises();
      expect(callsOf(setProgressBar)).toEqual([
        { status: ProgressBarStatus.None },
        reset
          ? { status: ProgressBarStatus.Indeterminate, progress: 0 }
          : { status: ProgressBarStatus.Indeterminate },
        { status: ProgressBarStatus.Normal, progress: 0 },
        { status: ProgressBarStatus.Normal, progress: 1 },
        { status: ProgressBarStatus.Normal, progress: 100 },
        { status: ProgressBarStatus.None },
      ]);
      stop();
    },
  );

  it("never shows the error state while a failed Stop leaves the run live", async () => {
    let emit!: (event: ExportProgressEvent) => void;
    let answerStart: (start: ExportSubmission) => void = () => {};
    const startFn = vi.fn(
      () =>
        new Promise<ExportSubmission>((resolve) => {
          answerStart = resolve;
        }),
    );
    const store = createExportStore({
      subscribeExportProgress: (handler) => {
        emit = handler;
        return Promise.resolve(() => {});
      },
      startExport: startFn,
      cancelExport: () => Promise.reject(new Error("IPC closed")),
    });
    const setProgressBar = createSpy();
    const stop = startTaskbarProgressSync({
      store,
      setProgressBar,
      resetIndeterminateValue: false,
    });

    const starting = store.getState().startExport({
      sourcePath: "/media/source.mp4",
      outputPath: "/media/output.mp4",
      segments: [{ inPts: "0" as Pts, outPts: "1000" as Pts }],
      preset: createPresetDraft("mp4-h264", "Test preset"),
      streams: "videoAndAudio",
      audioMode: "encode",
    });
    await vi.waitFor(() => {
      expect(startFn).toHaveBeenCalled();
    });
    // The Stop waits for the run id. The `started` event that comes before the answer waits
    // too, and the store applies it before it sends the request.
    const stopping = store.getState().cancelExport();
    emit({
      event: "started",
      runId: "run-kept",
      outputPath: "/media/output.mp4",
      segmentCount: 1,
      totalDurationUs: 4_000_000,
      expectedFrames: 100,
    });
    answerStart({ runId: "run-kept", queued: false });
    await starting;
    await expect(stopping).resolves.toBe(false);
    expect(store.getState()).toMatchObject({ status: "failed", tracking: true });
    await flushPromises();

    emit({ event: "progress", runId: "run-kept", frame: 40 });
    await flushPromises();
    emit({
      event: "finished",
      runId: "run-kept",
      outputPath: "/media/output.mp4",
      frames: 100,
    });
    await flushPromises();

    expect(callsOf(setProgressBar)).toEqual([
      { status: ProgressBarStatus.None },
      { status: ProgressBarStatus.Indeterminate },
      // The `started` event, then the progress through the failed Stop. No error state.
      { status: ProgressBarStatus.Normal, progress: 0 },
      { status: ProgressBarStatus.Normal, progress: 40 },
      { status: ProgressBarStatus.None },
    ]);
    stop();
  });

  it("clears the error bar when a failed export resets to idle", async () => {
    const { store, setProgressBar, stop } = setup({ status: "failed" });
    await flushPromises();
    store.setState({ status: "idle" });
    await flushPromises();
    expect(callsOf(setProgressBar)).toEqual([
      { status: ProgressBarStatus.Error, progress: 100 },
      { status: ProgressBarStatus.None },
    ]);
    stop();
  });

  it("keeps one call in flight and sends only the latest state after it settles", async () => {
    const store = createExportStore({}, { status: "publishing" });
    let release: () => void = () => {};
    const setProgressBar = vi.fn<(state: ProgressBarState) => Promise<void>>();
    setProgressBar.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    setProgressBar.mockImplementation(() => Promise.resolve());
    const stop = startTaskbarProgressSync({
      store,
      setProgressBar,
      resetIndeterminateValue: false,
    });

    store.setState({ status: "failed" });
    store.setState({ status: "finished" });
    await flushPromises();
    expect(setProgressBar).toHaveBeenCalledTimes(1);

    release();
    await flushPromises();
    expect(callsOf(setProgressBar)).toEqual([
      { status: ProgressBarStatus.Normal, progress: 100 },
      { status: ProgressBarStatus.None },
    ]);
    stop();
  });

  it("sends nothing more when the latest state matches the settled call", async () => {
    const store = createExportStore({}, { status: "publishing" });
    let release: () => void = () => {};
    const setProgressBar = vi.fn<(state: ProgressBarState) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = startTaskbarProgressSync({
      store,
      setProgressBar,
      resetIndeterminateValue: false,
    });
    store.setState({ status: "failed" });
    store.setState({ status: "publishing" });
    release();
    await flushPromises();
    expect(setProgressBar).toHaveBeenCalledTimes(1);
    stop();
  });

  it("swallows a rejection of the setter and sends the latest state", async () => {
    const store = createExportStore();
    const setProgressBar = vi.fn<(state: ProgressBarState) => Promise<void>>(() =>
      Promise.reject(new Error("permission denied")),
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const stop = startTaskbarProgressSync({
        store,
        setProgressBar,
        resetIndeterminateValue: false,
      });
      store.setState({ status: "preparing" });
      store.setState({ status: "failed" });
      await flushPromises();
      expect(callsOf(setProgressBar)).toEqual([
        { status: ProgressBarStatus.None },
        { status: ProgressBarStatus.Error, progress: 100 },
      ]);
      expect(unhandled).not.toHaveBeenCalled();
      stop();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("catches a synchronous throw of the setter and treats it as settled", () => {
    const store = createExportStore({}, { status: "preparing" });
    const setProgressBar = vi.fn<(state: ProgressBarState) => Promise<void>>(() => {
      throw new Error("no window");
    });
    let stop: (() => void) | undefined;
    expect(() => {
      stop = startTaskbarProgressSync({
        store,
        setProgressBar,
        resetIndeterminateValue: false,
      });
    }).not.toThrow();
    expect(() => store.setState({ status: "failed" })).not.toThrow();
    expect(setProgressBar).toHaveBeenCalledTimes(2);
    stop?.();
  });

  it("sends nothing after the unsubscribe and does not clear the bar", async () => {
    const { store, setProgressBar, stop } = setup({ status: "preparing" });
    expect(setProgressBar).toHaveBeenCalledTimes(1);
    stop();
    store.setState({ status: "running", frame: 10, expectedFrames: 100 });
    store.setState({ status: "idle" });
    await flushPromises();
    expect(setProgressBar).toHaveBeenCalledTimes(1);
  });

  it("does not send a queued state after the unsubscribe", async () => {
    const store = createExportStore({}, { status: "publishing" });
    let release: () => void = () => {};
    const setProgressBar = vi.fn<(state: ProgressBarState) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = startTaskbarProgressSync({
      store,
      setProgressBar,
      resetIndeterminateValue: false,
    });
    store.setState({ status: "finished" });
    stop();
    release();
    await flushPromises();
    expect(setProgressBar).toHaveBeenCalledTimes(1);
  });
});

describe("startTaskbarProgressSync with a batch of runs", () => {
  function request(outputPath: string): ExportRequest {
    return {
      sourcePath: "/media/source.mp4",
      outputPath,
      segments: [{ inPts: "0" as Pts, outPts: "1000" as Pts }],
      preset: createPresetDraft("mp4-h264", "Test preset"),
      streams: "videoAndAudio",
      audioMode: "encode",
    };
  }

  /** A real export store and queue store that share one fake backend. */
  async function setupBatch(outputPaths: readonly string[]) {
    const handlers: Array<(event: ExportProgressEvent) => void> = [];
    const subscribe = (handler: (event: ExportProgressEvent) => void) => {
      handlers.push(handler);
      return Promise.resolve(() => {});
    };
    let nextRun = 1;
    const start = (): Promise<ExportSubmission> => {
      const runId = `run-${nextRun++}`;
      return Promise.resolve({ runId, queued: runId !== "run-1" });
    };
    const cancel = () => Promise.resolve(true);
    const store = createExportStore({
      subscribeExportProgress: subscribe,
      startExport: start,
      cancelExport: cancel,
    });
    const queueStore = createExportQueueStore({
      exportStore: store,
      startExport: start,
      cancelExport: cancel,
      subscribeExportProgress: subscribe,
    });
    for (const path of outputPaths) {
      await queueStore.getState().submit(request(path));
    }
    const emit = (event: ExportProgressEvent) => {
      for (const handler of handlers) handler(event);
    };
    const setProgressBar = createSpy();
    const stop = startTaskbarProgressSync({
      store,
      queueStore,
      setProgressBar,
      resetIndeterminateValue: false,
    });
    return { store, queueStore, emit, setProgressBar, stop };
  }

  /**
   * The sync sends one call at a time, so it can skip a short state. This reads the resolved
   * state at each change of either store instead, as the sync resolves it.
   */
  function recordResolved(
    store: StoreApi<ExportStoreState>,
    queueStore: StoreApi<ExportBatchQueueState>,
  ) {
    const states: ProgressBarState[] = [];
    const record = () => {
      const state = store.getState();
      const queue = queueStore.getState();
      states.push(
        resolveTaskbarProgress(
          {
            ...state,
            batchContinues: exportBatchContinues(queue, state),
            batchFailed: exportBatchHasFailure(exportBatchEndsOf(queue, state)),
          },
          KEEP,
        ),
      );
    };
    const stopExport = store.subscribe(record);
    const stopQueue = queueStore.subscribe(record);
    return {
      states,
      stop: () => {
        stopExport();
        stopQueue();
      },
    };
  }

  function started(runId: string, outputPath: string): ExportProgressEvent {
    return {
      event: "started",
      runId,
      outputPath,
      segmentCount: 1,
      totalDurationUs: 4_000_000,
      expectedFrames: 100,
    };
  }

  it("shows no error between two runs after a failed run in the middle", async () => {
    const { emit, setProgressBar, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    await flushPromises();
    emit(started("run-1", "/out/a.mp4"));
    await flushPromises();
    emit({ event: "failed", runId: "run-1", code: "ffmpegProcessFailed" });
    await flushPromises();
    emit({ event: "preparing", runId: "run-2" });
    await flushPromises();
    emit(started("run-2", "/out/b.mp4"));
    await flushPromises();
    emit({ event: "progress", runId: "run-2", frame: 30 });
    await flushPromises();
    emit({ event: "finished", runId: "run-2", outputPath: "/out/b.mp4", frames: 100 });
    await flushPromises();

    expect(callsOf(setProgressBar)).toEqual([
      { status: ProgressBarStatus.Indeterminate },
      { status: ProgressBarStatus.Normal, progress: 0 },
      // The failure of run-1 while run-2 waits, and the preparation of run-2. No error.
      { status: ProgressBarStatus.Indeterminate },
      { status: ProgressBarStatus.Normal, progress: 0 },
      { status: ProgressBarStatus.Normal, progress: 30 },
      // The end of the batch: run-2 finished, but run-1 failed.
      { status: ProgressBarStatus.Error, progress: 100 },
    ]);
    stop();
  });

  it("shows None at the end of a batch with no failed run", async () => {
    const { emit, setProgressBar, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    emit({ event: "finished", runId: "run-1", outputPath: "/out/a.mp4", frames: 100 });
    emit({ event: "preparing", runId: "run-2" });
    emit({ event: "finished", runId: "run-2", outputPath: "/out/b.mp4", frames: 100 });
    await flushPromises();
    expect(lastCallOf(setProgressBar)).toEqual({ status: ProgressBarStatus.None });
    stop();
  });

  it("resolves no end state through the adoption after a reset while runs waited", async () => {
    const { store, queueStore, emit, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    emit({ event: "finished", runId: "run-1", outputPath: "/out/a.mp4", frames: 100 });
    // The Close of the dialog resets the result while run-2 waits.
    store.getState().reset();
    const resolved = recordResolved(store, queueStore);
    emit({ event: "preparing", runId: "run-2" });
    expect(resolved.states.length).toBeGreaterThan(0);
    expect(
      resolved.states.every(
        (state) => state.status === ProgressBarStatus.Indeterminate,
      ),
    ).toBe(true);
    resolved.stop();
    stop();
  });

  it("shows the error state when the last waiting run fails after a reset", async () => {
    const { store, emit, setProgressBar, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    emit({ event: "finished", runId: "run-1", outputPath: "/out/a.mp4", frames: 100 });
    store.getState().reset();
    await flushPromises();
    expect(lastCallOf(setProgressBar)).toEqual({
      status: ProgressBarStatus.Indeterminate,
    });
    emit({ event: "failed", runId: "run-2", code: "ffmpegProcessFailed" });
    await flushPromises();
    expect(lastCallOf(setProgressBar)).toEqual({
      status: ProgressBarStatus.Error,
      progress: 100,
    });
    stop();
  });

  it("resolves no end state at any change of the adoption of the next run", async () => {
    const { store, queueStore, emit, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    emit(started("run-1", "/out/a.mp4"));
    const resolved = recordResolved(store, queueStore);
    emit({ event: "failed", runId: "run-1", code: "ffmpegProcessFailed" });
    emit({ event: "preparing", runId: "run-2" });
    expect(resolved.states.length).toBeGreaterThan(2);
    expect(
      resolved.states.every(
        (state) => state.status === ProgressBarStatus.Indeterminate,
      ),
    ).toBe(true);
    resolved.stop();
    stop();
  });

  it("shows the error state when the last run of the batch fails", async () => {
    const { emit, setProgressBar, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    emit({ event: "finished", runId: "run-1", outputPath: "/out/a.mp4", frames: 100 });
    emit({ event: "preparing", runId: "run-2" });
    emit({ event: "failed", runId: "run-2", code: "ffmpegProcessFailed" });
    await flushPromises();
    expect(lastCallOf(setProgressBar)).toEqual({
      status: ProgressBarStatus.Error,
      progress: 100,
    });
    stop();
  });

  it("shows the end when the removal of the last waiting run ends the batch", async () => {
    const { emit, queueStore, setProgressBar, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    emit({ event: "failed", runId: "run-1", code: "ffmpegProcessFailed" });
    await flushPromises();
    expect(lastCallOf(setProgressBar)).toEqual({
      status: ProgressBarStatus.Indeterminate,
    });
    await queueStore.getState().remove("run-2");
    emit({ event: "failed", runId: "run-2", code: "canceled" });
    await flushPromises();
    expect(lastCallOf(setProgressBar)).toEqual({
      status: ProgressBarStatus.Error,
      progress: 100,
    });
    stop();
  });
});
