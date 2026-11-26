import { describe, expect, it } from "vitest";
import { createExportOrderDialogStore } from "./exportOrderDialogStore";

describe("exportOrderDialogStore", () => {
  it("opens closed, and counts each open", () => {
    const store = createExportOrderDialogStore();
    expect(store.getState()).toMatchObject({ isOpen: false, openCount: 0 });
    store.getState().open();
    expect(store.getState()).toMatchObject({ isOpen: true, openCount: 1 });
    store.getState().close();
    expect(store.getState()).toMatchObject({ isOpen: false, openCount: 1 });
    store.getState().open();
    expect(store.getState()).toMatchObject({ isOpen: true, openCount: 2 });
  });

  it("starts no new open while it is open, and a close of a closed dialog changes nothing", () => {
    const store = createExportOrderDialogStore();
    store.getState().open();
    store.getState().open();
    expect(store.getState().openCount).toBe(1);
    store.getState().close();
    const closed = store.getState();
    store.getState().close();
    expect(store.getState()).toBe(closed);
  });
});
