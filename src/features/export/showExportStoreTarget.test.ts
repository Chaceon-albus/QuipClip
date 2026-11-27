import { describe, expect, it } from "vitest";
import { createExportComposeStore } from "./composeStore";
import { WHOLE_EXPORT_SCOPE, type ExportScope } from "./scope";
import { createExportScopeStore } from "./scopeStore";
import { showExportStoreTarget } from "./showExportStoreTarget";
import { createExportStore } from "./store";
import { EXPORT_STATUSES, ExportError, type ExportStatus } from "./types";

const LIST_A: ExportScope = { kind: "list", record: [{ id: "a", pieces: [] }] };
const LIST_B: ExportScope = { kind: "list", record: [{ id: "b", pieces: [] }] };

/** Stores with list A as the scope of the export store, and list B as the compose scope. */
function stores(status: ExportStatus, composing: boolean) {
  const exportStore = createExportStore();
  exportStore.setState({
    status,
    error: status === "failed" ? new ExportError({ code: "noSegments" }) : null,
  });
  const composeStore = createExportComposeStore({ composing });
  const scopeStore = createExportScopeStore({ shownRunIds: () => [] });
  scopeStore.getState().publishSetup("export", LIST_A);
  scopeStore.getState().publishSetup("compose", LIST_B);
  return { exportStore, composeStore, scopeStore };
}

describe("showExportStoreTarget (ADR 067)", () => {
  it("gives the setup step of an idle export store the whole export when the dialog was closed", () => {
    const deps = stores("idle", false);
    showExportStoreTarget({ dialogOpen: false }, deps);
    expect(deps.scopeStore.getState().setup).toStrictEqual({
      export: WHOLE_EXPORT_SCOPE,
      compose: LIST_B,
    });
  });

  it("gives it the whole export when the dialog was open in the compose state", () => {
    const deps = stores("idle", true);
    showExportStoreTarget({ dialogOpen: true }, deps);
    expect(deps.scopeStore.getState().setup.export).toBe(WHOLE_EXPORT_SCOPE);
    expect(deps.scopeStore.getState().setup.compose).toBe(LIST_B);
    // A closed dialog in the compose state changes to the export store too.
    const closed = stores("idle", true);
    showExportStoreTarget({ dialogOpen: false }, closed);
    expect(closed.scopeStore.getState().setup.export).toBe(WHOLE_EXPORT_SCOPE);
  });

  it("publishes nothing while the dialog already shows the export store", () => {
    const deps = stores("idle", false);
    showExportStoreTarget({ dialogOpen: true }, deps);
    expect(deps.scopeStore.getState().setup).toStrictEqual({
      export: LIST_A,
      compose: LIST_B,
    });
  });

  it("publishes nothing for each status that is not idle", () => {
    for (const status of EXPORT_STATUSES.filter((value) => value !== "idle")) {
      for (const [dialogOpen, composing] of [
        [false, false],
        [true, true],
        [false, true],
      ] as const) {
        const deps = stores(status, composing);
        showExportStoreTarget({ dialogOpen }, deps);
        expect(deps.scopeStore.getState().setup.export, status).toBe(LIST_A);
      }
    }
  });

  it("always ends the compose state", () => {
    for (const status of EXPORT_STATUSES) {
      for (const dialogOpen of [false, true]) {
        const deps = stores(status, true);
        deps.composeStore
          .getState()
          .reportError(new ExportError({ code: "outputAlreadyQueued" }));
        showExportStoreTarget({ dialogOpen }, deps);
        expect(deps.composeStore.getState()).toMatchObject({
          composing: false,
          status: "idle",
          error: null,
        });
      }
    }
  });
});
