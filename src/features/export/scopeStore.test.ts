import { describe, expect, it } from "vitest";
import { WHOLE_EXPORT_SCOPE, type ExportScope } from "./scope";
import { createExportScopeStore, scopeOfBack } from "./scopeStore";
import { ExportError } from "./types";

const LIST: ExportScope = {
  kind: "list",
  record: [{ id: "b", pieces: [] }],
};
const OTHER_LIST: ExportScope = {
  kind: "list",
  record: [{ id: "c", pieces: [] }],
};

describe("createExportScopeStore", () => {
  it("starts with the whole export as the scope of the setup step of each target", () => {
    const { setup } = createExportScopeStore().getState();
    expect(setup.export).toBe(WHOLE_EXPORT_SCOPE);
    expect(setup.compose).toBe(WHOLE_EXPORT_SCOPE);
  });

  it("sets the scope of the setup step of one target only through publishSetup", () => {
    const store = createExportScopeStore({ shownRunIds: () => [] });
    store.getState().publishSetup("export", LIST);
    expect(store.getState().setup).toStrictEqual({
      export: LIST,
      compose: WHOLE_EXPORT_SCOPE,
    });
    store.getState().publishSetup("compose", OTHER_LIST);
    expect(store.getState().setup).toStrictEqual({ export: LIST, compose: OTHER_LIST });
    // Keeping the scope of an answer does not change the scope of a setup step.
    store.getState().keepRun("run-1", WHOLE_EXPORT_SCOPE);
    store
      .getState()
      .keepFailure(
        new ExportError({ code: "outputAlreadyQueued" }),
        WHOLE_EXPORT_SCOPE,
      );
    expect(store.getState().setup).toStrictEqual({ export: LIST, compose: OTHER_LIST });
  });

  it("keeps the scope of a run by its id, for the runs that the dialog can show", () => {
    let shown: string[] = [];
    const store = createExportScopeStore({ shownRunIds: () => shown });
    store.getState().keepRun("run-1", LIST);
    expect(store.getState().runScope("run-1")).toBe(LIST);
    shown = ["run-1"];
    store.getState().keepRun("run-2", OTHER_LIST);
    expect(store.getState().runScope("run-1")).toBe(LIST);
    expect(store.getState().runScope("run-2")).toBe(OTHER_LIST);
    // The batch ended and the dialog no longer shows run-1 or run-2.
    shown = ["run-2"];
    store.getState().keepRun("run-3", WHOLE_EXPORT_SCOPE);
    expect(store.getState().runScope("run-1")).toBeUndefined();
    expect(store.getState().runScope("run-2")).toBe(OTHER_LIST);
    expect(store.getState().runScope("run-3")).toBe(WHOLE_EXPORT_SCOPE);
  });

  it("keeps the scope with the failure instance, and with no other", () => {
    const store = createExportScopeStore();
    const refusal = new ExportError({ code: "outputAlreadyQueued" });
    store.getState().keepFailure(refusal, LIST);
    expect(store.getState().failureScope(refusal)).toBe(LIST);
    expect(
      store.getState().failureScope(new ExportError({ code: "outputAlreadyQueued" })),
    ).toBeUndefined();
    expect(store.getState().failureScope(null)).toBeUndefined();
  });
});

describe("scopeOfBack", () => {
  it("reads the scope that a run kept, or the whole export for a run with none", () => {
    const store = createExportScopeStore({ shownRunIds: () => [] });
    store.getState().keepRun("run-1", LIST);
    const failed = new ExportError({ code: "ffmpegProcessFailed" });
    expect(scopeOfBack({ runId: "run-1", error: failed }, store.getState())).toBe(LIST);
    // A run from before the page loaded again (ADR 051).
    expect(scopeOfBack({ runId: "restored", error: failed }, store.getState())).toBe(
      WHOLE_EXPORT_SCOPE,
    );
  });

  it("reads the scope that a failure with no run id kept", () => {
    const store = createExportScopeStore();
    const refusal = new ExportError({ code: "outputAlreadyQueued" });
    store.getState().keepFailure(refusal, LIST);
    expect(scopeOfBack({ runId: null, error: refusal }, store.getState())).toBe(LIST);
  });

  it("keeps the scope of the setup step after the error of an open step", () => {
    const store = createExportScopeStore();
    const openError = new ExportError({ code: "noSegments" });
    expect(scopeOfBack({ runId: null, error: openError }, store.getState())).toBeNull();
  });
});
