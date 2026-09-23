import { describe, expect, it, vi } from "vitest";
import { ExportOutputError } from "./output";
import {
  bindOutputActionsToExportRun,
  createExportOutputActionStore,
  exportOutputActionStore,
} from "./outputActionStore";
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

describe("export output action store", () => {
  it("starts with no request and no failure", () => {
    const store = createExportOutputActionStore({ perform: vi.fn() });

    expect(store.getState().pending).toBeNull();
    expect(store.getState().failure).toBeNull();
  });

  it("marks the request as pending until it answers, then reports success", async () => {
    const answer = deferred();
    const perform = vi.fn().mockReturnValue(answer.promise);
    const store = createExportOutputActionStore({ perform });

    const outcome = store.getState().run("reveal", "1-0");
    expect(store.getState().pending).toEqual({ runId: "1-0", action: "reveal" });
    expect(perform).toHaveBeenCalledWith("reveal", "1-0");

    answer.resolve();
    await expect(outcome).resolves.toBe("succeeded");
    expect(store.getState().pending).toBeNull();
    expect(store.getState().failure).toBeNull();
  });

  it("holds a failure with its run and action", async () => {
    const perform = vi
      .fn()
      .mockRejectedValue({ code: "openFailed", detail: "no application" });
    const store = createExportOutputActionStore({ perform });

    await expect(store.getState().run("open", "1-0")).resolves.toBe("failed");

    const failure = store.getState().failure;
    expect(failure?.runId).toBe("1-0");
    expect(failure?.action).toBe("open");
    expect(failure?.error).toEqual(
      new ExportOutputError("openFailed", "no application"),
    );
    expect(store.getState().pending).toBeNull();
  });

  it("ignores a second request while one is in flight", async () => {
    const answer = deferred();
    const perform = vi.fn().mockReturnValue(answer.promise);
    const store = createExportOutputActionStore({ perform });

    const first = store.getState().run("reveal", "1-0");
    await expect(store.getState().run("open", "1-0")).resolves.toBe("ignored");
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

    void store.getState().run("reveal", "1-0");
    await expect(store.getState().run("reveal", "2-1")).resolves.toBe("succeeded");
    expect(perform).toHaveBeenCalledTimes(2);
    answer.resolve();
  });

  it("removes the earlier failure when a new request starts", async () => {
    const perform = vi
      .fn()
      .mockRejectedValueOnce({ code: "revealFailed" })
      .mockResolvedValueOnce(undefined);
    const store = createExportOutputActionStore({ perform });

    await store.getState().run("reveal", "1-0");
    expect(store.getState().failure).not.toBeNull();

    await expect(store.getState().run("reveal", "1-0")).resolves.toBe("succeeded");
    expect(store.getState().failure).toBeNull();
  });

  it("discards a failure that answers after a clear", async () => {
    const answer = deferred();
    const perform = vi.fn().mockReturnValue(answer.promise);
    const store = createExportOutputActionStore({ perform });

    const outcome = store.getState().run("open", "1-0");
    store.getState().clear();
    expect(store.getState().pending).toBeNull();

    answer.reject({ code: "openFailed" });
    await expect(outcome).resolves.toBe("ignored");
    expect(store.getState().failure).toBeNull();
    expect(store.getState().pending).toBeNull();
  });

  it("clears a held failure", async () => {
    const perform = vi.fn().mockRejectedValue({ code: "outputMissing" });
    const store = createExportOutputActionStore({ perform });

    await store.getState().run("reveal", "1-0");
    store.getState().clear();

    expect(store.getState().failure).toBeNull();
  });

  describe("bindOutputActionsToExportRun", () => {
    function boundStores() {
      const exportStore = createExportStore(
        {},
        { status: "finished", runId: "1-0", outputPath: "/movies/out.mp4" },
      );
      const outputActions = createExportOutputActionStore({
        perform: vi.fn().mockRejectedValue({ code: "outputMissing" }),
      });
      const unbind = bindOutputActionsToExportRun(exportStore, outputActions);
      return { exportStore, outputActions, unbind };
    }

    it("clears the state when the export store resets", async () => {
      const { exportStore, outputActions } = boundStores();
      await outputActions.getState().run("reveal", "1-0");
      expect(outputActions.getState().failure).not.toBeNull();

      exportStore.getState().reset();

      expect(outputActions.getState().failure).toBeNull();
    });

    it("discards a request in flight when the export store resets", async () => {
      const exportStore = createExportStore({}, { status: "finished", runId: "1-0" });
      const answer = deferred();
      const outputActions = createExportOutputActionStore({
        perform: vi.fn().mockReturnValue(answer.promise),
      });
      bindOutputActionsToExportRun(exportStore, outputActions);

      const outcome = outputActions.getState().run("open", "1-0");
      exportStore.getState().reset();
      expect(outputActions.getState().pending).toBeNull();

      answer.reject({ code: "openFailed" });
      await expect(outcome).resolves.toBe("ignored");
      expect(outputActions.getState().failure).toBeNull();
    });

    it("keeps the state while the run id stays the same", async () => {
      const { exportStore, outputActions } = boundStores();
      await outputActions.getState().run("reveal", "1-0");

      exportStore.setState({ frame: 300 });

      expect(outputActions.getState().failure?.runId).toBe("1-0");
    });

    it("binds the application stores, so the reset of the export flow clears the state", () => {
      exportStore.setState({ status: "finished", runId: "9-0" });
      exportOutputActionStore.setState({
        failure: {
          runId: "9-0",
          action: "reveal",
          error: new ExportOutputError("outputMissing"),
        },
      });

      // `ExportFlowController.run` resets a final status through this call by default.
      exportStore.getState().reset();

      expect(exportOutputActionStore.getState().failure).toBeNull();
    });

    it("stops clearing after the binding ends", async () => {
      const { exportStore, outputActions, unbind } = boundStores();
      await outputActions.getState().run("reveal", "1-0");

      unbind();
      exportStore.getState().reset();

      expect(outputActions.getState().failure).not.toBeNull();
    });
  });
});
