import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { ExportOutputError } from "./output";
import {
  NO_EXPORT_OUTPUT_ACTION,
  bindOutputActionsToExportRun,
  createExportOutputActionStore,
  exportOutputActionStore,
  selectExportOutputAction,
  type ExportOutputActionStore,
} from "./outputActionStore";
import { exportQueueStore } from "./queueStore";
import { createExportStore, exportStore } from "./store";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

/** A promise and the functions that settle it. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The state of the run `runId` in `store`. */
function runState(store: ExportOutputActionStore, runId: string) {
  return selectExportOutputAction(store.getState(), runId);
}

describe("export output action store", () => {
  it("starts with no request and no failure", () => {
    const store = createExportOutputActionStore({ perform: vi.fn() });

    expect(store.getState().runs).toEqual({});
    expect(runState(store, "1-0")).toBe(NO_EXPORT_OUTPUT_ACTION);
  });

  it("gives no state for no run", () => {
    const store = createExportOutputActionStore({ perform: vi.fn() });

    expect(selectExportOutputAction(store.getState(), null)).toBe(
      NO_EXPORT_OUTPUT_ACTION,
    );
  });

  it("marks the request as pending until it answers, then reports success", async () => {
    const answer = deferred();
    const perform = vi.fn().mockReturnValue(answer.promise);
    const store = createExportOutputActionStore({ perform });

    const outcome = store.getState().reveal("1-0");
    expect(runState(store, "1-0")).toEqual({ pending: true, error: null });
    expect(perform).toHaveBeenCalledWith("1-0");

    answer.resolve();
    await expect(outcome).resolves.toBe("succeeded");
    expect(runState(store, "1-0")).toBe(NO_EXPORT_OUTPUT_ACTION);
  });

  it("holds a failure with its run", async () => {
    const perform = vi.fn().mockRejectedValue({
      code: "revealFailed",
      detail: "the file manager did not answer",
    });
    const store = createExportOutputActionStore({ perform });

    await expect(store.getState().reveal("1-0")).resolves.toBe("failed");

    expect(runState(store, "1-0")).toEqual({
      pending: false,
      error: new ExportOutputError("revealFailed", "the file manager did not answer"),
    });
    expect(runState(store, "2-1")).toBe(NO_EXPORT_OUTPUT_ACTION);
  });

  it("keeps the selected state the same object until its run changes", async () => {
    const perform = vi
      .fn()
      .mockRejectedValueOnce({ code: "outputMissing" })
      .mockResolvedValueOnce(undefined);
    const store = createExportOutputActionStore({ perform });
    await store.getState().reveal("1-0");
    const held = runState(store, "1-0");

    await store.getState().reveal("2-1");

    expect(runState(store, "1-0")).toBe(held);
  });

  it("ignores a second request while one is in flight", async () => {
    const answer = deferred();
    const perform = vi.fn().mockReturnValue(answer.promise);
    const store = createExportOutputActionStore({ perform });

    const first = store.getState().reveal("1-0");
    await expect(store.getState().reveal("1-0")).resolves.toBe("ignored");
    expect(perform).toHaveBeenCalledTimes(1);

    answer.resolve();
    await expect(first).resolves.toBe("succeeded");
  });

  it("accepts a request for another run while one is in flight", async () => {
    const answer = deferred();
    const perform = vi
      .fn()
      .mockReturnValueOnce(answer.promise)
      .mockResolvedValueOnce(undefined);
    const store = createExportOutputActionStore({ perform });

    const first = store.getState().reveal("1-0");
    await expect(store.getState().reveal("2-1")).resolves.toBe("succeeded");
    expect(perform).toHaveBeenCalledTimes(2);
    // The answer of the second run does not end the request of the first run.
    expect(runState(store, "1-0").pending).toBe(true);

    answer.resolve();
    await expect(first).resolves.toBe("succeeded");
    expect(runState(store, "1-0").pending).toBe(false);
  });

  it("keeps the failure of one run when another run fails or succeeds", async () => {
    const perform = vi
      .fn()
      .mockRejectedValueOnce({ code: "outputMissing" })
      .mockRejectedValueOnce({ code: "revealFailed" })
      .mockResolvedValueOnce(undefined);
    const store = createExportOutputActionStore({ perform });

    await store.getState().reveal("1-0");
    await store.getState().reveal("2-1");
    await store.getState().reveal("3-2");

    expect(runState(store, "1-0").error).toEqual(
      new ExportOutputError("outputMissing"),
    );
    expect(runState(store, "2-1").error).toEqual(new ExportOutputError("revealFailed"));
    expect(runState(store, "3-2")).toBe(NO_EXPORT_OUTPUT_ACTION);
  });

  it("removes the earlier failure when a new request for its run starts", async () => {
    const answer = deferred();
    const perform = vi
      .fn()
      .mockRejectedValueOnce({ code: "revealFailed" })
      .mockReturnValueOnce(answer.promise);
    const store = createExportOutputActionStore({ perform });

    await store.getState().reveal("1-0");
    expect(runState(store, "1-0").error).not.toBeNull();

    const second = store.getState().reveal("1-0");
    expect(runState(store, "1-0")).toEqual({ pending: true, error: null });
    answer.resolve();
    await expect(second).resolves.toBe("succeeded");
    expect(runState(store, "1-0")).toBe(NO_EXPORT_OUTPUT_ACTION);
  });

  it("discards a failure that answers after a clear", async () => {
    const answer = deferred();
    const perform = vi.fn().mockReturnValue(answer.promise);
    const store = createExportOutputActionStore({ perform });

    const outcome = store.getState().reveal("1-0");
    store.getState().clear();
    expect(runState(store, "1-0")).toBe(NO_EXPORT_OUTPUT_ACTION);

    answer.reject({ code: "revealFailed" });
    await expect(outcome).resolves.toBe("ignored");
    expect(store.getState().runs).toEqual({});
  });

  it("clears a held failure", async () => {
    const perform = vi.fn().mockRejectedValue({ code: "outputMissing" });
    const store = createExportOutputActionStore({ perform });

    await store.getState().reveal("1-0");
    store.getState().clear();

    expect(store.getState().runs).toEqual({});
  });

  it("retains the listed runs and drops the rest", async () => {
    const answer = deferred();
    const perform = vi
      .fn()
      .mockRejectedValueOnce({ code: "outputMissing" })
      .mockReturnValueOnce(answer.promise);
    const store = createExportOutputActionStore({ perform });
    await store.getState().reveal("1-0");
    const dropped = store.getState().reveal("2-1");

    store.getState().retain(["1-0"]);

    expect(runState(store, "1-0").error).not.toBeNull();
    expect(runState(store, "2-1")).toBe(NO_EXPORT_OUTPUT_ACTION);

    // The answer for a dropped run cannot bring back its state.
    answer.reject({ code: "revealFailed" });
    await expect(dropped).resolves.toBe("ignored");
    expect(runState(store, "2-1")).toBe(NO_EXPORT_OUTPUT_ACTION);
    expect(runState(store, "1-0").error).not.toBeNull();
  });

  it("does not notify when retain drops nothing", async () => {
    const perform = vi.fn().mockRejectedValue({ code: "outputMissing" });
    const store = createExportOutputActionStore({ perform });
    await store.getState().reveal("1-0");
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().retain(["1-0", "2-1"]);

    expect(listener).not.toHaveBeenCalled();
  });

  describe("bindOutputActionsToExportRun", () => {
    /** A queue source whose `order` list the test sets. */
    function queueSource(order: string[] = []) {
      return createStore<{ order: string[] }>()(() => ({ order }));
    }

    function boundStores(order: string[] = []) {
      const exportStore = createExportStore(
        {},
        { status: "finished", runId: "1-0", outputPath: "/movies/out.mp4" },
      );
      const outputActions = createExportOutputActionStore({
        perform: vi.fn().mockRejectedValue({ code: "outputMissing" }),
      });
      const queue = queueSource(order);
      const unbind = bindOutputActionsToExportRun(exportStore, outputActions, queue);
      return { exportStore, outputActions, queue, unbind };
    }

    function adoptNext(store: ReturnType<typeof createExportStore>): void {
      store
        .getState()
        .adoptRun("2-1", { outputPath: "/movies/next.mp4", segmentCount: 1 });
    }

    it("clears the state when the export store resets outside a batch", async () => {
      const { exportStore, outputActions } = boundStores();
      await outputActions.getState().reveal("1-0");
      expect(runState(outputActions, "1-0").error).not.toBeNull();

      exportStore.getState().reset();

      expect(outputActions.getState().runs).toEqual({});
    });

    it("discards a request in flight when the export store resets", async () => {
      const exportStore = createExportStore({}, { status: "finished", runId: "1-0" });
      const answer = deferred();
      const outputActions = createExportOutputActionStore({
        perform: vi.fn().mockReturnValue(answer.promise),
      });
      bindOutputActionsToExportRun(exportStore, outputActions, queueSource());

      const outcome = outputActions.getState().reveal("1-0");
      exportStore.getState().reset();
      expect(runState(outputActions, "1-0")).toBe(NO_EXPORT_OUTPUT_ACTION);

      answer.reject({ code: "revealFailed" });
      await expect(outcome).resolves.toBe("ignored");
      expect(outputActions.getState().runs).toEqual({});
    });

    it("keeps the state of a run of the batch when the next run is adopted", async () => {
      const { exportStore, outputActions } = boundStores(["1-0", "2-1"]);
      await outputActions.getState().reveal("1-0");

      adoptNext(exportStore);

      expect(exportStore.getState().runId).toBe("2-1");
      expect(runState(outputActions, "1-0").error).toEqual(
        new ExportOutputError("outputMissing"),
      );
    });

    it("keeps a request in flight for a run of the batch across an adoption", async () => {
      const exportStore = createExportStore({}, { status: "finished", runId: "1-0" });
      const answer = deferred();
      const outputActions = createExportOutputActionStore({
        perform: vi.fn().mockReturnValue(answer.promise),
      });
      bindOutputActionsToExportRun(
        exportStore,
        outputActions,
        queueSource(["1-0", "2-1"]),
      );

      const outcome = outputActions.getState().reveal("1-0");
      adoptNext(exportStore);
      expect(runState(outputActions, "1-0").pending).toBe(true);

      answer.reject({ code: "revealFailed" });
      await expect(outcome).resolves.toBe("failed");
      expect(runState(outputActions, "1-0").error).not.toBeNull();
    });

    it("keeps the state of the dropped run when a reset comes while runs wait", async () => {
      const { exportStore, outputActions } = boundStores(["1-0", "2-1"]);
      await outputActions.getState().reveal("1-0");

      exportStore.getState().reset();

      expect(runState(outputActions, "1-0").error).not.toBeNull();
    });

    it("drops the state of a run when the queue ends its batch", async () => {
      const { exportStore, outputActions, queue } = boundStores(["1-0", "2-1"]);
      await outputActions.getState().reveal("1-0");
      adoptNext(exportStore);
      expect(runState(outputActions, "1-0").error).not.toBeNull();

      // The batch ends after the run id changed, as when the queue store hears the reset
      // after this binding. The change of `order` drops the state all the same.
      exportStore.getState().reset();
      expect(runState(outputActions, "1-0").error).not.toBeNull();
      queue.setState({ order: [] });

      expect(outputActions.getState().runs).toEqual({});
    });

    it("keeps the state of the run that the export store shows", async () => {
      const { exportStore, outputActions, queue } = boundStores();
      const answer = deferred();
      const second = createExportOutputActionStore({
        perform: vi.fn().mockReturnValue(answer.promise),
      });
      bindOutputActionsToExportRun(exportStore, second, queue);
      void second.getState().reveal("2-1");
      await outputActions.getState().reveal("1-0");

      adoptNext(exportStore);

      expect(runState(second, "2-1").pending).toBe(true);
      expect(outputActions.getState().runs).toEqual({});
      answer.resolve();
    });

    it("keeps the state while the run id stays the same", async () => {
      const { exportStore, outputActions } = boundStores();
      await outputActions.getState().reveal("1-0");

      exportStore.setState({ frame: 300 });

      expect(runState(outputActions, "1-0").error).not.toBeNull();
    });

    it("stops dropping after the binding ends", async () => {
      const { exportStore, outputActions, queue, unbind } = boundStores(["1-0"]);
      await outputActions.getState().reveal("1-0");

      unbind();
      exportStore.getState().reset();
      queue.setState({ order: [] });

      expect(runState(outputActions, "1-0").error).not.toBeNull();
    });

    describe("the application stores", () => {
      afterEach(() => {
        exportStore.getState().reset();
        exportQueueStore.setState({
          jobs: {},
          order: [],
          waiting: [],
          ended: [],
          removing: [],
        });
        exportOutputActionStore.getState().clear();
      });

      it("drops the state when the export flow resets a final status", () => {
        exportStore.setState({ status: "finished", runId: "9-0" });
        exportOutputActionStore.setState({
          runs: {
            "9-0": { pending: false, error: new ExportOutputError("outputMissing") },
          },
        });

        // `ExportFlowController.run` resets a final status through this call by default.
        exportStore.getState().reset();

        expect(exportOutputActionStore.getState().runs).toEqual({});
      });

      it("keeps the state of the dropped run when a reset comes while runs wait", () => {
        exportQueueStore.setState({
          order: ["8-0", "8-1"],
          waiting: ["8-1"],
          ended: [],
        });
        exportStore.setState({ status: "finished", runId: "8-0" });
        exportOutputActionStore.setState({
          runs: {
            "8-0": { pending: false, error: new ExportOutputError("outputMissing") },
          },
        });

        exportStore.getState().reset();

        expect(
          selectExportOutputAction(exportOutputActionStore.getState(), "8-0").error,
        ).not.toBeNull();
      });
    });
  });
});
