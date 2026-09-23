import { describe, expect, it } from "vitest";
import {
  createExportPanelStore,
  exportPanelStore,
  useExportPanelStore,
} from "./panelStore";

describe("Export Panel Store", () => {
  it("starts closed by default", () => {
    const store = createExportPanelStore();
    expect(store.getState().open).toBe(false);
  });

  it("respects initialState override", () => {
    const store = createExportPanelStore({ open: true });
    expect(store.getState().open).toBe(true);
  });

  it("sets open state using setOpen", () => {
    const store = createExportPanelStore();
    expect(store.getState().open).toBe(false);

    store.getState().setOpen(true);
    expect(store.getState().open).toBe(true);

    store.getState().setOpen(false);
    expect(store.getState().open).toBe(false);
  });

  it("opens using show", () => {
    const store = createExportPanelStore();
    expect(store.getState().open).toBe(false);

    store.getState().show();
    expect(store.getState().open).toBe(true);

    // Idempotent show
    store.getState().show();
    expect(store.getState().open).toBe(true);
  });

  it("closes using hide", () => {
    const store = createExportPanelStore({ open: true });
    expect(store.getState().open).toBe(true);

    store.getState().hide();
    expect(store.getState().open).toBe(false);

    // Idempotent hide
    store.getState().hide();
    expect(store.getState().open).toBe(false);
  });

  it("provides singleton exportPanelStore and useExportPanelStore hook", () => {
    expect(exportPanelStore.getState().open).toBe(false);
    expect(typeof exportPanelStore.getState().setOpen).toBe("function");
    expect(typeof exportPanelStore.getState().show).toBe("function");
    expect(typeof exportPanelStore.getState().hide).toBe("function");
    expect(typeof useExportPanelStore).toBe("function");
  });
});
