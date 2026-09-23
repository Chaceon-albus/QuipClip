import { ProgressBarStatus, type ProgressBarState } from "@tauri-apps/api/window";
import { describe, expect, it, vi } from "vitest";
import { createExportStore, type ExportState } from "@/features/export";
import type { TaskbarProgressInput } from "./taskbarProgressSync";
import {
  resolveTaskbarProgress,
  startTaskbarProgressSync,
} from "./taskbarProgressSync";

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
    expect(resolve({ status: "failed" })).toEqual({
      status: ProgressBarStatus.Error,
      progress: 100,
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
