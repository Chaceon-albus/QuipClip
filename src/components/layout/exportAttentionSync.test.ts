import { describe, expect, it, vi } from "vitest";
import capability from "../../../src-tauri/capabilities/default.json";
import {
  createExportQueueStore,
  createExportStore,
  EXPORT_STATUSES,
  ExportError,
  type ExportProgressEvent,
  type ExportRequest,
  type ExportSubmission,
  type ExportState,
  type ExportStatus,
} from "@/features/export";
import type { Pts } from "@/types/project";
import type { ExportAttentionInput, ExportAttentionState } from "./exportAttentionSync";
import {
  batchEndAsksForAttention,
  endsRunForAttention,
  shouldRequestExportAttention,
  startExportAttentionSync,
} from "./exportAttentionSync";
import { createPresetDraft } from "@/features/settings/presetDocument";

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function state(status: ExportStatus, tracking = false): ExportAttentionState {
  return { status, tracking };
}

function input(overrides: Partial<ExportAttentionInput> = {}): ExportAttentionInput {
  return {
    previous: state("running", true),
    next: state("finished"),
    focused: false,
    alreadyRequested: false,
    ...overrides,
  };
}

const ACTIVE: readonly ExportStatus[] = ["preparing", "running", "publishing"];
const ATTENTION_RESULTS: readonly ExportStatus[] = ["finished", "failed"];

const ALL_STATES: readonly ExportAttentionState[] = EXPORT_STATUSES.flatMap(
  (status) => [state(status, false), state(status, true)],
);

describe("endsRunForAttention", () => {
  it("is true only from a live run to finished or failed with no tracked run", () => {
    for (const previous of ALL_STATES) {
      for (const next of ALL_STATES) {
        const live =
          ACTIVE.includes(previous.status) ||
          (previous.status === "failed" && previous.tracking);
        const expected =
          live && ATTENTION_RESULTS.includes(next.status) && !next.tracking;
        expect(
          endsRunForAttention(previous, next),
          `${JSON.stringify(previous)} -> ${JSON.stringify(next)}`,
        ).toBe(expected);
      }
    }
  });

  it("is false for a failed report while the store still tracks the run", () => {
    for (const status of ACTIVE) {
      for (const tracking of [false, true]) {
        expect(
          endsRunForAttention(state(status, tracking), state("failed", true)),
        ).toBe(false);
      }
    }
  });

  it("is true when the tracked run behind a failed report really fails", () => {
    expect(endsRunForAttention(state("failed", true), state("failed", false))).toBe(
      true,
    );
  });

  it("is false once the store no longer tracks the failed run", () => {
    expect(endsRunForAttention(state("failed", false), state("failed", false))).toBe(
      false,
    );
    expect(endsRunForAttention(state("failed", false), state("finished", false))).toBe(
      false,
    );
  });

  it("is false for a run that the user stopped", () => {
    for (const previous of [...ACTIVE, "failed" as const]) {
      expect(endsRunForAttention(state(previous, true), state("canceled"))).toBe(false);
    }
  });

  it("is false for a failure of the open step, which comes from idle", () => {
    expect(endsRunForAttention(state("idle"), state("failed"))).toBe(false);
  });
});

describe("shouldRequestExportAttention", () => {
  it.each(
    ACTIVE.flatMap((previous) => ATTENTION_RESULTS.map((next) => [previous, next])),
  )(
    "requests for %s -> %s while the window does not have the focus",
    (previous, next) => {
      expect(
        shouldRequestExportAttention(
          input({ previous: state(previous, true), next: state(next) }),
        ),
      ).toBe(true);
    },
  );

  it("does not request while the window has the focus", () => {
    expect(shouldRequestExportAttention(input({ focused: true }))).toBe(false);
    expect(
      shouldRequestExportAttention(input({ next: state("failed"), focused: true })),
    ).toBe(false);
  });

  it("does not request while the batch goes on", () => {
    expect(shouldRequestExportAttention(input({ batchContinues: true }))).toBe(false);
    expect(
      shouldRequestExportAttention(
        input({ next: state("failed"), batchContinues: true }),
      ),
    ).toBe(false);
    expect(shouldRequestExportAttention(input({ batchContinues: false }))).toBe(true);
  });

  it("does not request twice for one run", () => {
    expect(shouldRequestExportAttention(input({ alreadyRequested: true }))).toBe(false);
  });

  it("does not request for a canceled run", () => {
    expect(shouldRequestExportAttention(input({ next: state("canceled") }))).toBe(
      false,
    );
  });

  it("does not request for a failed report while the run continues", () => {
    expect(shouldRequestExportAttention(input({ next: state("failed", true) }))).toBe(
      false,
    );
  });

  it("does not request for a change that ends no run", () => {
    expect(
      shouldRequestExportAttention(
        input({ previous: state("idle"), next: state("failed") }),
      ),
    ).toBe(false);
    expect(
      shouldRequestExportAttention(
        input({ previous: state("finished"), next: state("finished") }),
      ),
    ).toBe(false);
    expect(
      shouldRequestExportAttention(
        input({ previous: state("running", true), next: state("publishing", true) }),
      ),
    ).toBe(false);
  });
});

describe("startExportAttentionSync", () => {
  function setup(
    options: {
      initialState?: Partial<Omit<ExportState, "tracking">>;
      focused?: boolean;
    } = {},
  ) {
    const store = createExportStore({}, options.initialState ?? { status: "running" });
    const isFocused = vi.fn<() => Promise<boolean>>(() =>
      Promise.resolve(options.focused ?? false),
    );
    const requestAttention = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const stop = startExportAttentionSync({
      store,
      isFocused,
      requestAttention,
      enabled: true,
    });
    return { store, isFocused, requestAttention, stop };
  }

  it("requests attention once when a run finishes behind another window", async () => {
    const { store, requestAttention, stop } = setup();
    store.setState({ status: "finished" });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("requests attention when a run fails behind another window", async () => {
    const { store, requestAttention, stop } = setup({
      initialState: { status: "publishing" },
    });
    store.setState({ status: "failed" });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not request attention while the window has the focus", async () => {
    const { store, isFocused, requestAttention, stop } = setup({ focused: true });
    store.setState({ status: "finished" });
    await flushPromises();
    expect(isFocused).toHaveBeenCalledTimes(1);
    expect(requestAttention).not.toHaveBeenCalled();
    stop();
  });

  it("does not request attention for a run that the user stopped", async () => {
    const { store, isFocused, requestAttention, stop } = setup();
    store.setState({ status: "canceled" });
    await flushPromises();
    expect(isFocused).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();
    stop();
  });

  it("does not request attention for a failure of the open step", async () => {
    const { store, isFocused, requestAttention, stop } = setup({
      initialState: { status: "idle" },
    });
    store.setState({ status: "failed" });
    await flushPromises();
    expect(isFocused).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();
    stop();
  });

  it("does not read the focus for a change that ends no run", async () => {
    const { store, isFocused, stop } = setup({
      initialState: { status: "running", frame: 0, expectedFrames: 100 },
    });
    store.setState({ frame: 10 });
    store.setState({ cancelRequested: true });
    store.setState({ status: "publishing" });
    await flushPromises();
    expect(isFocused).not.toHaveBeenCalled();
    stop();
  });

  it("requests nothing for a failed report while the store still tracks the run", async () => {
    // A Stop that fails at the IPC layer reports `failed`, and the backend keeps the run.
    const { store, isFocused, requestAttention, stop } = setup({
      initialState: { status: "running", runId: "run-1" },
    });
    expect(store.getState().tracking).toBe(true);
    store.setState({ status: "failed" });
    await flushPromises();
    expect(isFocused).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();
    stop();
  });

  it("requests attention once when the tracked run behind a failed report really fails", async () => {
    const { store, requestAttention, stop } = setup({
      initialState: { status: "running", runId: "run-1" },
    });
    store.setState({ status: "failed" });
    await flushPromises();
    store.setState({ status: "failed", tracking: false });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("requests attention once when the tracked run behind a failed report finishes", async () => {
    const { store, requestAttention, stop } = setup({
      initialState: { status: "running", runId: "run-1" },
    });
    store.setState({ status: "failed" });
    await flushPromises();
    store.setState({ status: "publishing" });
    await flushPromises();
    store.setState({ status: "finished", tracking: false });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("follows a failed Stop and the real failure through the store actions", async () => {
    let emit: (event: ExportProgressEvent) => void = () => {};
    const store = createExportStore({
      startExport: () =>
        Promise.resolve({
          runId: "run-1",
          queued: false,
        }),
      cancelExport: () => Promise.reject(new Error("ipc failed")),
      subscribeExportProgress: (handler) => {
        emit = handler;
        return Promise.resolve(() => {});
      },
    });
    const isFocused = vi.fn<() => Promise<boolean>>(() => Promise.resolve(false));
    const requestAttention = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const stop = startExportAttentionSync({
      store,
      isFocused,
      requestAttention,
      enabled: true,
    });

    await store.getState().startExport({
      sources: [{ id: "source", path: "/media/source.mp4" }],
      outputPath: "/media/output.mp4",
      pieces: [{ sourceId: "source", inPts: "0" as Pts, outPts: "1000" as Pts }],
      segmentCount: 1,
      preset: createPresetDraft("mp4-h264", "Test preset"),
      streams: "videoAndAudio",
      audioMode: "encode",
    });
    emit({
      event: "started",
      runId: "run-1",
      outputPath: "/media/output.mp4",
      segmentCount: 1,
      totalDurationUs: 5_000_000,
      expectedFrames: 150,
    });
    await store.getState().cancelExport();
    expect(store.getState()).toMatchObject({ status: "failed", tracking: true });
    await flushPromises();
    expect(isFocused).not.toHaveBeenCalled();

    emit({ event: "failed", runId: "run-1", code: "ffmpegProcessFailed" });
    expect(store.getState()).toMatchObject({ status: "failed", tracking: false });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("follows a Stop that waited for the run id and failed, the kept run, and its finish through the store actions", async () => {
    let emit: (event: ExportProgressEvent) => void = () => {};
    let answerStart: (start: ExportSubmission) => void = () => {};
    const startFn = vi.fn(
      () =>
        new Promise<ExportSubmission>((resolve) => {
          answerStart = resolve;
        }),
    );
    const store = createExportStore({
      startExport: startFn,
      cancelExport: () => Promise.reject(new Error("ipc failed")),
      subscribeExportProgress: (handler) => {
        emit = handler;
        return Promise.resolve(() => {});
      },
    });
    const isFocused = vi.fn<() => Promise<boolean>>(() => Promise.resolve(false));
    const requestAttention = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const stop = startExportAttentionSync({
      store,
      isFocused,
      requestAttention,
      enabled: true,
    });

    const starting = store.getState().startExport({
      sources: [{ id: "source", path: "/media/source.mp4" }],
      outputPath: "/media/output.mp4",
      pieces: [{ sourceId: "source", inPts: "0" as Pts, outPts: "1000" as Pts }],
      segmentCount: 1,
      preset: createPresetDraft("mp4-h264", "Test preset"),
      streams: "videoAndAudio",
      audioMode: "encode",
    });
    await vi.waitFor(() => {
      expect(startFn).toHaveBeenCalled();
    });
    // The Stop waits for the run id, and its request goes out after the answer.
    const stopping = store.getState().cancelExport();
    answerStart({ runId: "run-kept", queued: false });
    await starting;
    await expect(stopping).resolves.toBe(false);
    expect(store.getState()).toMatchObject({
      status: "failed",
      runId: "run-kept",
      tracking: true,
    });
    await flushPromises();
    // The failed Stop is not an end: the run is kept.
    expect(isFocused).not.toHaveBeenCalled();

    emit({ event: "publishing", runId: "run-kept" });
    emit({
      event: "finished",
      runId: "run-kept",
      outputPath: "/media/output.mp4",
      frames: 150,
    });
    expect(store.getState()).toMatchObject({ status: "finished", tracking: false });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  describe("a refused start through the store actions", () => {
    function startRefusedWith(error: ExportError) {
      const store = createExportStore({
        startExport: () => Promise.reject(error),
        subscribeExportProgress: () => Promise.resolve(() => {}),
      });
      const isFocused = vi.fn<() => Promise<boolean>>(() => Promise.resolve(false));
      const requestAttention = vi.fn<() => Promise<void>>(() => Promise.resolve());
      const stop = startExportAttentionSync({
        store,
        isFocused,
        requestAttention,
        enabled: true,
      });
      const started = store.getState().startExport({
        sources: [{ id: "source", path: "/media/source.mp4" }],
        outputPath: "/media/output.mp4",
        pieces: [{ sourceId: "source", inPts: "0" as Pts, outPts: "1000" as Pts }],
        segmentCount: 1,
        preset: createPresetDraft("mp4-h264", "Test preset"),
        streams: "videoAndAudio",
        audioMode: "encode",
      });
      return { store, isFocused, requestAttention, stop, started };
    }

    it("requests attention once when the start fails with an ffmpeg error", async () => {
      // The prepare step can take up to 30 seconds, so the user can be in another window.
      const { store, requestAttention, stop, started } = startRefusedWith(
        new ExportError({ code: "ffmpegProcessFailed", detail: "probe failed" }),
      );
      await started;
      expect(store.getState()).toMatchObject({ status: "failed", tracking: false });
      await flushPromises();
      expect(requestAttention).toHaveBeenCalledTimes(1);
      stop();
    });

    it("requests nothing when the start ends canceled", async () => {
      const { store, isFocused, requestAttention, stop, started } = startRefusedWith(
        new ExportError({ code: "canceled" }),
      );
      await started;
      expect(store.getState()).toMatchObject({ status: "canceled", tracking: false });
      await flushPromises();
      expect(isFocused).not.toHaveBeenCalled();
      expect(requestAttention).not.toHaveBeenCalled();
      stop();
    });
  });

  it("keeps the once-per-run guard when two ends of one run query the focus together", async () => {
    // The store does not produce two ends for one run. The guard holds if it ever does.
    const { store, isFocused, requestAttention, stop } = setup();
    store.setState({ status: "failed" });
    store.setState({ status: "publishing" });
    store.setState({ status: "finished" });
    await flushPromises();
    expect(isFocused).toHaveBeenCalledTimes(2);
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("requests attention again for the next run", async () => {
    const { store, requestAttention, stop } = setup();
    store.setState({ status: "finished" });
    await flushPromises();
    store.setState({ status: "idle" });
    store.setState({ status: "preparing" });
    store.setState({ status: "running" });
    store.setState({ status: "failed" });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(2);
    stop();
  });

  it("drops a focus answer that arrives after the store reset", async () => {
    const { store, isFocused, requestAttention, stop } = setup();
    let answer: (focused: boolean) => void = () => {};
    isFocused.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    store.setState({ status: "finished" });
    store.setState({ status: "idle" });
    answer(false);
    await flushPromises();
    expect(requestAttention).not.toHaveBeenCalled();
    stop();
  });

  it("drops a focus answer that arrives after the stop", async () => {
    const { store, isFocused, requestAttention, stop } = setup();
    let answer: (focused: boolean) => void = () => {};
    isFocused.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    store.setState({ status: "finished" });
    stop();
    answer(false);
    await flushPromises();
    expect(requestAttention).not.toHaveBeenCalled();
  });

  it("sends nothing after the stop", async () => {
    const { store, isFocused, requestAttention, stop } = setup();
    stop();
    store.setState({ status: "finished" });
    await flushPromises();
    expect(isFocused).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();
  });

  it("sends no request when the focus query fails", async () => {
    const { store, isFocused, requestAttention, stop } = setup();
    isFocused.mockImplementationOnce(() => Promise.reject(new Error("no window")));
    store.setState({ status: "finished" });
    await flushPromises();
    expect(requestAttention).not.toHaveBeenCalled();
    stop();
  });

  it("sends no request when the focus query throws", async () => {
    const { store, isFocused, requestAttention, stop } = setup();
    isFocused.mockImplementationOnce(() => {
      throw new Error("no window");
    });
    store.setState({ status: "finished" });
    await flushPromises();
    expect(requestAttention).not.toHaveBeenCalled();
    stop();
  });

  it("ignores a rejected request", async () => {
    const { store, requestAttention, stop } = setup();
    requestAttention.mockImplementationOnce(() => Promise.reject(new Error("denied")));
    store.setState({ status: "finished" });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("ignores a request that throws", async () => {
    const { store, requestAttention, stop } = setup();
    requestAttention.mockImplementationOnce(() => {
      throw new Error("no window");
    });
    store.setState({ status: "finished" });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does nothing when it is not enabled", async () => {
    const store = createExportStore({}, { status: "running" });
    const isFocused = vi.fn<() => Promise<boolean>>(() => Promise.resolve(false));
    const requestAttention = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const stop = startExportAttentionSync({
      store,
      isFocused,
      requestAttention,
      enabled: false,
    });
    store.setState({ status: "finished" });
    await flushPromises();
    expect(isFocused).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();
    stop();
  });

  it("has the permission that requestUserAttention needs in the main window capability", () => {
    expect(capability.windows).toContain("main");
    expect(capability.permissions).toContain(
      "core:window:allow-request-user-attention",
    );
    // `is_focused` comes from `core:window:default`, which `core:default` holds.
    expect(capability.permissions).toContain("core:default");
  });
});

describe("batchEndAsksForAttention", () => {
  it("is true when a run of the batch finished or failed", () => {
    expect(batchEndAsksForAttention(["canceled", "finished"])).toBe(true);
    expect(batchEndAsksForAttention(["failed"])).toBe(true);
  });

  it("is false for a batch that ended only canceled, or with no end", () => {
    expect(batchEndAsksForAttention(["canceled", "canceled"])).toBe(false);
    expect(batchEndAsksForAttention([])).toBe(false);
  });
});

describe("startExportAttentionSync with a batch of runs", () => {
  function request(outputPath: string): ExportRequest {
    return {
      sources: [{ id: "source", path: "/media/source.mp4" }],
      outputPath,
      pieces: [{ sourceId: "source", inPts: "0" as Pts, outPts: "1000" as Pts }],
      segmentCount: 1,
      preset: createPresetDraft("mp4-h264", "Test preset"),
      streams: "videoAndAudio",
      audioMode: "encode",
    };
  }

  /** A real export store and queue store that share one fake backend. */
  async function setupBatch(outputPaths: readonly string[], focused = false) {
    const handlers: Array<(event: ExportProgressEvent) => void> = [];
    const subscribe = (handler: (event: ExportProgressEvent) => void) => {
      handlers.push(handler);
      return Promise.resolve(() => {});
    };
    let nextRun = 1;
    const fixture = {
      answer: null as null | (() => Promise<ExportSubmission>),
    };
    const start = (): Promise<ExportSubmission> => {
      if (fixture.answer) {
        return fixture.answer();
      }
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
    const isFocused = vi.fn<() => Promise<boolean>>(() => Promise.resolve(focused));
    const requestAttention = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const stop = startExportAttentionSync({
      store,
      queueStore,
      isFocused,
      requestAttention,
      enabled: true,
    });
    return { fixture, store, queueStore, emit, isFocused, requestAttention, stop };
  }

  function finish(runId: string): ExportProgressEvent {
    return { event: "finished", runId, outputPath: `/out/${runId}.mp4`, frames: 30 };
  }

  it("does not request between runs, and requests once when the batch ends", async () => {
    const { emit, isFocused, requestAttention, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
      "/out/c.mp4",
    ]);
    emit(finish("run-1"));
    await flushPromises();
    emit({ event: "preparing", runId: "run-2" });
    emit({ event: "failed", runId: "run-2", code: "ffmpegProcessFailed" });
    await flushPromises();
    expect(isFocused).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();

    emit({ event: "preparing", runId: "run-3" });
    emit(finish("run-3"));
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not request for a run that ends while a submission has no answer", async () => {
    const { fixture, emit, queueStore, requestAttention, stop } = await setupBatch([
      "/out/a.mp4",
    ]);
    let answer: (submission: ExportSubmission) => void = () => {};
    fixture.answer = () =>
      new Promise<ExportSubmission>((resolve) => {
        answer = resolve;
      });
    const submitting = queueStore.getState().submit(request("/out/b.mp4"));
    await flushPromises();
    expect(queueStore.getState().submitting).toBe(1);

    emit(finish("run-1"));
    await flushPromises();
    expect(requestAttention).not.toHaveBeenCalled();

    answer({ runId: "run-2", queued: true });
    await submitting;
    emit({ event: "preparing", runId: "run-2" });
    emit(finish("run-2"));
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("requests once when the last waiting run fails before it takes the slot", async () => {
    const { emit, requestAttention, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    emit(finish("run-1"));
    await flushPromises();
    expect(requestAttention).not.toHaveBeenCalled();

    emit({ event: "failed", runId: "run-2", code: "ffmpegProcessFailed" });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("requests once when the removal of the last waiting run ends the batch behind another window", async () => {
    const { emit, queueStore, requestAttention, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    emit(finish("run-1"));
    await flushPromises();
    await queueStore.getState().remove("run-2");
    emit({ event: "failed", runId: "run-2", code: "canceled" });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not request when the user removes the last waiting run at the window", async () => {
    const { emit, queueStore, isFocused, requestAttention, stop } = await setupBatch(
      ["/out/a.mp4", "/out/b.mp4"],
      true,
    );
    emit(finish("run-1"));
    await flushPromises();
    await queueStore.getState().remove("run-2");
    emit({ event: "failed", runId: "run-2", code: "canceled" });
    await flushPromises();
    expect(isFocused).toHaveBeenCalledTimes(1);
    expect(requestAttention).not.toHaveBeenCalled();
    stop();
  });

  it("requests once when the last waiting run fails after a reset while it waited", async () => {
    const { emit, store, isFocused, requestAttention, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    emit(finish("run-1"));
    await flushPromises();
    // The Close of the dialog resets the result while run-2 waits.
    store.getState().reset();
    await flushPromises();
    expect(isFocused).not.toHaveBeenCalled();

    emit({ event: "failed", runId: "run-2", code: "ffmpegProcessFailed" });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not request for the adoption after a reset, and requests at the end of the batch", async () => {
    const { emit, store, requestAttention, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    emit(finish("run-1"));
    store.getState().reset();
    emit({ event: "preparing", runId: "run-2" });
    await flushPromises();
    expect(requestAttention).not.toHaveBeenCalled();
    emit(finish("run-2"));
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not request for a batch that the user stopped and emptied", async () => {
    const { emit, queueStore, isFocused, requestAttention, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    emit({ event: "failed", runId: "run-1", code: "canceled" });
    await flushPromises();
    await queueStore.getState().remove("run-2");
    emit({ event: "failed", runId: "run-2", code: "canceled" });
    await flushPromises();
    expect(isFocused).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();
    stop();
  });

  it("requests for a stopped run when a waiting run then fails as the end of the batch", async () => {
    const { emit, requestAttention, stop } = await setupBatch([
      "/out/a.mp4",
      "/out/b.mp4",
    ]);
    emit({ event: "failed", runId: "run-1", code: "canceled" });
    emit({ event: "failed", runId: "run-2", code: "ffmpegProcessFailed" });
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });

  it("requests once for a batch of one run, as before", async () => {
    const { emit, requestAttention, stop } = await setupBatch(["/out/a.mp4"]);
    emit(finish("run-1"));
    await flushPromises();
    expect(requestAttention).toHaveBeenCalledTimes(1);
    stop();
  });
});
