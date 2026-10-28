import { describe, expect, it } from "vitest";
import {
  composeFlowTarget,
  createComposeFlowTarget,
  createExportComposeStore,
  exportComposeStore,
} from "./composeStore";
import { isExportRunLive } from "./runState";
import { ExportError } from "./types";

describe("Export compose store", () => {
  it("starts idle and not composing", () => {
    const store = createExportComposeStore();
    expect(store.getState()).toMatchObject({
      composing: false,
      status: "idle",
      error: null,
    });
  });

  it("enter starts the compose state and keeps a failure", () => {
    const error = new ExportError({ code: "noSegments" });
    const store = createExportComposeStore({ status: "failed", error });

    store.getState().enter();

    expect(store.getState()).toMatchObject({
      composing: true,
      status: "failed",
      error,
    });
  });

  it("exit ends the compose state and clears the failure", () => {
    const store = createExportComposeStore({
      composing: true,
      status: "failed",
      error: new ExportError({ code: "dialogFailed" }),
    });

    store.getState().exit();

    expect(store.getState()).toMatchObject({
      composing: false,
      status: "idle",
      error: null,
    });
  });

  it("reset clears the failure and keeps the compose state", () => {
    const store = createExportComposeStore({
      composing: true,
      status: "failed",
      error: new ExportError({ code: "presetNotFound" }),
    });

    store.getState().reset();

    expect(store.getState()).toMatchObject({
      composing: true,
      status: "idle",
      error: null,
    });
  });

  it("reportError records an ExportError as it is, and starts the compose state", () => {
    const store = createExportComposeStore();
    const error = new ExportError({ code: "outputAlreadyQueued" });

    store.getState().reportError(error);

    // A refusal that comes after the user left the compose state shows at the next open.
    expect(store.getState().composing).toBe(true);
    expect(store.getState().status).toBe("failed");
    expect(store.getState().error).toBe(error);
  });

  it("reportError normalizes a rejection of another shape", () => {
    const store = createExportComposeStore();

    store.getState().reportError({ code: "sourceRevisionChanged", detail: "size" });
    expect(store.getState().error).toMatchObject({
      code: "sourceRevisionChanged",
      detail: "size",
    });

    store.getState().reportError("IPC closed");
    expect(store.getState().status).toBe("failed");
    expect(store.getState().error?.code).toBe("unknown");
  });

  it("reportError ignores a canceled report", () => {
    const store = createExportComposeStore();

    store.getState().reportError(new ExportError({ code: "canceled" }));

    expect(store.getState()).toMatchObject({
      composing: false,
      status: "idle",
      error: null,
    });
  });

  it("the default store starts idle", () => {
    expect(exportComposeStore.getState().status).toBe("idle");
  });
});

describe("compose flow target", () => {
  it("reads, reports to, and resets the compose store", () => {
    const store = createExportComposeStore();
    const target = createComposeFlowTarget(store);

    expect(target.getExportState()).toEqual({ status: "idle", tracking: false });

    target.reportError(new ExportError({ code: "noSegments" }));
    expect(store.getState().status).toBe("failed");
    expect(target.getExportState()).toEqual({ status: "failed", tracking: false });
    // The compose store never holds a run, so its state is never live.
    expect(isExportRunLive(target.getExportState())).toBe(false);

    target.reset();
    expect(store.getState()).toMatchObject({ status: "idle", error: null });
  });

  it("the default target reads the default store", () => {
    expect(composeFlowTarget.getExportState()).toEqual({
      status: exportComposeStore.getState().status,
      tracking: false,
    });
  });
});
