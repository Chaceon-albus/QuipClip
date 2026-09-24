import { describe, expect, it, vi } from "vitest";
import capability from "../../../src-tauri/capabilities/default.json";
import {
  createExportStore,
  EXPORT_STATUSES,
  ExportError,
  type ExportProgressEvent,
  type ExportStart,
  type ExportState,
  type ExportStatus,
} from "@/features/export";
import type { Pts } from "@/types/project";
import type { ExportAttentionInput, ExportAttentionState } from "./exportAttentionSync";
import {
  endsRunForAttention,
  shouldRequestExportAttention,
  startExportAttentionSync,
} from "./exportAttentionSync";

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
          presetId: "mp4-h264",
          outputPath: "/media/output.mp4",
          segmentCount: 1,
          totalDurationUs: 5_000_000,
          expectedFrames: 150,
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
      sourcePath: "/media/source.mp4",
      outputPath: "/media/output.mp4",
      segments: [{ inPts: "0" as Pts, outPts: "1000" as Pts }],
      presetId: "mp4-h264",
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

  it("follows a failed slot Stop, the kept start, and its finish through the store actions", async () => {
    let emit: (event: ExportProgressEvent) => void = () => {};
    let answerStart: (start: ExportStart) => void = () => {};
    const startFn = vi.fn(
      () =>
        new Promise<ExportStart>((resolve) => {
          answerStart = resolve;
        }),
    );
    const store = createExportStore({
      startExport: startFn,
      cancelActiveExport: () => Promise.reject(new Error("ipc failed")),
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
      sourcePath: "/media/source.mp4",
      outputPath: "/media/output.mp4",
      segments: [{ inPts: "0" as Pts, outPts: "1000" as Pts }],
      presetId: "mp4-h264",
    });
    await vi.waitFor(() => {
      expect(startFn).toHaveBeenCalled();
    });
    await store.getState().cancelExport();
    expect(store.getState()).toMatchObject({ status: "failed", tracking: true });
    await flushPromises();
    // The failed Stop is not an end: the start is kept.
    expect(isFocused).not.toHaveBeenCalled();

    answerStart({
      runId: "run-kept",
      presetId: "mp4-h264",
      outputPath: "/media/output.mp4",
      segmentCount: 1,
      totalDurationUs: 5_000_000,
      expectedFrames: 150,
    });
    await starting;
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
        sourcePath: "/media/source.mp4",
        outputPath: "/media/output.mp4",
        segments: [{ inPts: "0" as Pts, outPts: "1000" as Pts }],
        presetId: "mp4-h264",
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
