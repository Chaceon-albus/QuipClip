import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import capability from "../../../src-tauri/capabilities/default.json";
import {
  SEGMENT_MENU_PREPARE_TIMEOUT_MS,
  createTauriSegmentMenuBackend,
  type SegmentMenuShowHandlers,
} from "./nativeSegmentMenu";
import type {
  SegmentMenuAction,
  SegmentMenuEntry,
  SegmentMenuItem,
} from "./segmentMenuModel";

// The menu API of Tauri, replaced by fakes that record each IPC call. A fake item keeps the
// options it was created with, so a test can choose it the way the user chooses an item.
const tauri = vi.hoisted(() => {
  interface ItemOptions {
    readonly text: string;
    readonly enabled?: boolean;
    readonly accelerator?: string;
    readonly action?: (id: string) => void;
  }
  class FakeMenuItem {
    readonly options: ItemOptions;
    readonly setText = vi.fn((_text: string) => Promise.resolve());
    readonly setEnabled = vi.fn((_enabled: boolean) => Promise.resolve());
    readonly setAccelerator = vi.fn((_accelerator: string | null) => Promise.resolve());
    readonly close = vi.fn(() => Promise.resolve());
    constructor(options: ItemOptions) {
      this.options = options;
    }
  }
  class FakeSeparator {
    readonly kind = "separator";
    readonly close = vi.fn(() => Promise.resolve());
  }
  class FakeMenu {
    readonly items: readonly unknown[];
    readonly popup = vi.fn((_at?: unknown) => Promise.resolve());
    readonly close = vi.fn(() => Promise.resolve());
    constructor(items: readonly unknown[]) {
      this.items = items;
    }
  }
  class FakeLogicalPosition {
    readonly x: number;
    readonly y: number;
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  }
  const state = {
    inside: true,
    failNextMenu: false,
    /** When set, the next `Menu.new` waits for the test to call it with the result. */
    holdNextMenu: null as ((settle: (fail: boolean) => void) => void) | null,
    items: [] as FakeMenuItem[],
    menus: [] as FakeMenu[],
  };
  return {
    state,
    FakeMenuItem,
    FakeSeparator,
    FakeLogicalPosition,
    menuItemNew: vi.fn((options: ItemOptions) => {
      const item = new FakeMenuItem(options);
      state.items.push(item);
      return Promise.resolve(item);
    }),
    separatorNew: vi.fn((_options: { item: string }) =>
      Promise.resolve(new FakeSeparator()),
    ),
    menuNew: vi.fn((options: { items: readonly unknown[] }) => {
      if (state.failNextMenu) {
        state.failNextMenu = false;
        return Promise.reject(new Error("no menu"));
      }
      const hold = state.holdNextMenu;
      if (hold !== null) {
        state.holdNextMenu = null;
        return new Promise<FakeMenu>((resolve, reject) => {
          hold((fail) => {
            if (fail) {
              reject(new Error("no menu"));
              return;
            }
            const menu = new FakeMenu(options.items);
            state.menus.push(menu);
            resolve(menu);
          });
        });
      }
      const menu = new FakeMenu(options.items);
      state.menus.push(menu);
      return Promise.resolve(menu);
    }),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => tauri.state.inside,
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalPosition: tauri.FakeLogicalPosition,
}));

vi.mock("@tauri-apps/api/menu", () => ({
  MenuItem: { new: tauri.menuItemNew },
  PredefinedMenuItem: { new: tauri.separatorNew },
  Menu: { new: tauri.menuNew },
}));

function item(
  action: SegmentMenuAction,
  text: string,
  overrides: Partial<SegmentMenuItem> = {},
): SegmentMenuItem {
  return {
    kind: "item",
    action,
    label: text,
    shortcut: null,
    commandKind: null,
    text,
    accelerator: null,
    enabled: true,
    ...overrides,
  };
}

/** The handlers of one show, with a choice that does nothing unless the test passes one. */
function handlers(
  onSelect: (action: SegmentMenuAction) => void = () => {},
  onPopup: () => void = () => {},
): SegmentMenuShowHandlers {
  return { onSelect, onPopup };
}

const ENTRIES: readonly SegmentMenuEntry[] = [
  item("goToSegmentIn", "Go to In", { accelerator: "Shift+KeyI" }),
  item("goToSegmentOut", "Go to Out", { accelerator: "Shift+KeyO", enabled: false }),
  { kind: "separator" },
  item("deleteSegment", "Delete Segment", { accelerator: "Backspace" }),
];

function menuAt(index: number) {
  const menu = tauri.state.menus[index];
  if (menu === undefined) {
    throw new Error(`no menu ${index}`);
  }
  return menu;
}

function itemAt(index: number) {
  const created = tauri.state.items[index];
  if (created === undefined) {
    throw new Error(`no item ${index}`);
  }
  return created;
}

describe("createTauriSegmentMenuBackend", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    tauri.state.inside = true;
    tauri.state.failNextMenu = false;
    tauri.state.holdNextMenu = null;
    tauri.state.items = [];
    tauri.state.menus = [];
    tauri.menuItemNew.mockClear();
    tauri.separatorNew.mockClear();
    tauri.menuNew.mockClear();
  });

  it("shows nothing outside the Tauri shell, such as in a browser tab", async () => {
    tauri.state.inside = false;
    await createTauriSegmentMenuBackend().show(ENTRIES, null, handlers());
    expect(tauri.menuItemNew).not.toHaveBeenCalled();
    expect(tauri.menuNew).not.toHaveBeenCalled();
  });

  it("builds the items in order, with their texts, keys and enabled states", async () => {
    await createTauriSegmentMenuBackend().show(ENTRIES, null, handlers());
    expect(
      tauri.menuItemNew.mock.calls.map(([options]) => ({
        text: options.text,
        enabled: options.enabled,
        accelerator: options.accelerator,
      })),
    ).toStrictEqual([
      { text: "Go to In", enabled: true, accelerator: "Shift+KeyI" },
      { text: "Go to Out", enabled: false, accelerator: "Shift+KeyO" },
      { text: "Delete Segment", enabled: true, accelerator: "Backspace" },
    ]);
    expect(tauri.separatorNew).toHaveBeenCalledExactlyOnceWith({ item: "Separator" });
    const [menu] = tauri.state.menus;
    expect(menu?.items).toHaveLength(4);
    expect(menu?.items[0]).toBe(itemAt(0));
    expect(menu?.items[1]).toBe(itemAt(1));
    expect(menu?.items[2]).toBeInstanceOf(tauri.FakeSeparator);
    expect(menu?.items[3]).toBe(itemAt(2));
  });

  it("passes no accelerator for an item without one, as on Windows", async () => {
    await createTauriSegmentMenuBackend().show(
      [item("deleteSegment", "Delete Segment\tDelete")],
      null,
      handlers(),
    );
    const [options] = tauri.menuItemNew.mock.calls[0] ?? [];
    expect(options?.text).toBe("Delete Segment\tDelete");
    expect(options !== undefined && "accelerator" in options).toBe(false);
  });

  it("opens at the pointer for no position, and at a logical position for one", async () => {
    const backend = createTauriSegmentMenuBackend();
    await backend.show(ENTRIES, null, handlers());
    expect(menuAt(0).popup).toHaveBeenLastCalledWith(undefined);
    await backend.show(ENTRIES, { x: 120, y: 480 }, handlers());
    const at: unknown = menuAt(0).popup.mock.lastCall?.[0];
    expect(at).toBeInstanceOf(tauri.FakeLogicalPosition);
    expect(at).toMatchObject({ x: 120, y: 480 });
  });

  it("waits for the popup, which resolves when the native menu closes", async () => {
    const backend = createTauriSegmentMenuBackend();
    await backend.show(ENTRIES, null, handlers());
    let close = () => {};
    menuAt(0).popup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          close = resolve;
        }),
    );
    let isClosed = false;
    const shown = backend.show(ENTRIES, null, handlers()).then(() => {
      isClosed = true;
    });
    await vi.waitFor(() => expect(menuAt(0).popup).toHaveBeenCalledTimes(2));
    expect(isClosed).toBe(false);
    close();
    await shown;
    expect(isClosed).toBe(true);
  });

  it("reports the popup call just after it is sent, before the popup settles", async () => {
    const backend = createTauriSegmentMenuBackend();
    await backend.show(ENTRIES, null, handlers());
    let close = () => {};
    menuAt(0).popup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          close = resolve;
        }),
    );
    const onPopup = vi.fn(() => {
      // The popup call is already sent.
      expect(menuAt(0).popup).toHaveBeenCalledTimes(2);
    });
    const shown = backend.show(ENTRIES, null, handlers(undefined, onPopup));
    await vi.waitFor(() => expect(onPopup).toHaveBeenCalledOnce());
    close();
    await shown;
    expect(onPopup).toHaveBeenCalledOnce();
  });

  it("reports no popup call for a show that shows no menu", async () => {
    const onPopup = vi.fn();
    tauri.state.inside = false;
    await createTauriSegmentMenuBackend().show(
      ENTRIES,
      null,
      handlers(undefined, onPopup),
    );
    tauri.state.inside = true;
    tauri.state.failNextMenu = true;
    await expect(
      createTauriSegmentMenuBackend().show(ENTRIES, null, handlers(undefined, onPopup)),
    ).rejects.toThrow("no menu");
    expect(onPopup).not.toHaveBeenCalled();
  });

  it("builds the menu once, and sends only the values that changed", async () => {
    const backend = createTauriSegmentMenuBackend();
    await backend.show(ENTRIES, null, handlers());
    await backend.show(
      [
        item("goToSegmentIn", "Go to In", {
          accelerator: "Shift+KeyI",
          enabled: false,
        }),
        item("goToSegmentOut", "Go to Out", {
          accelerator: "Shift+KeyO",
          enabled: false,
        }),
        { kind: "separator" },
        item("deleteSegment", "删除片段", { accelerator: "Backspace" }),
      ],
      null,
      handlers(),
    );
    expect(tauri.menuItemNew).toHaveBeenCalledTimes(3);
    expect(tauri.menuNew).toHaveBeenCalledOnce();
    expect(itemAt(0).setEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(itemAt(0).setText).not.toHaveBeenCalled();
    expect(itemAt(1).setEnabled).not.toHaveBeenCalled();
    expect(itemAt(2).setText).toHaveBeenCalledExactlyOnceWith("删除片段");
    expect(itemAt(2).setEnabled).not.toHaveBeenCalled();
    for (const index of [0, 1, 2]) {
      expect(itemAt(index).setAccelerator).not.toHaveBeenCalled();
    }
    expect(menuAt(0).popup).toHaveBeenCalledTimes(2);
  });

  it("gives the chosen item to the handler of the latest show", async () => {
    const backend = createTauriSegmentMenuBackend();
    const first = vi.fn();
    const second = vi.fn();
    await backend.show(ENTRIES, null, handlers(first));
    itemAt(2).options.action?.("native-id");
    expect(first).toHaveBeenCalledExactlyOnceWith("deleteSegment");
    await backend.show(ENTRIES, null, handlers(second));
    itemAt(0).options.action?.("native-id");
    expect(second).toHaveBeenCalledExactlyOnceWith("goToSegmentIn");
    expect(first).toHaveBeenCalledOnce();
  });

  it("runs the choice of one show at most once", async () => {
    const backend = createTauriSegmentMenuBackend();
    const select = vi.fn();
    await backend.show(ENTRIES, null, handlers(select));
    itemAt(0).options.action?.("native-id");
    itemAt(2).options.action?.("native-id");
    expect(select).toHaveBeenCalledExactlyOnceWith("goToSegmentIn");
  });

  it("drops a late event of a show once the next show started, until its popup starts", async () => {
    const backend = createTauriSegmentMenuBackend();
    const first = vi.fn();
    const second = vi.fn();
    await backend.show(ENTRIES, null, handlers(first));

    // The next show must change an enabled state, and that call is still on its way.
    let finishUpdate = () => {};
    itemAt(0).setEnabled.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishUpdate = resolve;
        }),
    );
    const shown = backend.show(
      [
        item("goToSegmentIn", "Go to In", {
          accelerator: "Shift+KeyI",
          enabled: false,
        }),
        ...ENTRIES.slice(1),
      ],
      null,
      handlers(second),
    );
    await vi.waitFor(() => expect(itemAt(0).setEnabled).toHaveBeenCalledOnce());

    // The event of the first menu arrives late. Its show ended, and the next one started.
    itemAt(2).options.action?.("native-id");
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    finishUpdate();
    await shown;
    expect(menuAt(0).popup).toHaveBeenCalledTimes(2);
    itemAt(1).options.action?.("native-id");
    expect(second).toHaveBeenCalledExactlyOnceWith("goToSegmentOut");
    expect(first).not.toHaveBeenCalled();
  });

  it("sends a value again at the next show when its call failed", async () => {
    const backend = createTauriSegmentMenuBackend();
    await backend.show(ENTRIES, null, handlers());
    const disabled: readonly SegmentMenuEntry[] = [
      item("goToSegmentIn", "Go to In", { accelerator: "Shift+KeyI", enabled: false }),
      ...ENTRIES.slice(1),
    ];
    itemAt(0).setEnabled.mockImplementationOnce(() =>
      Promise.reject(new Error("no item")),
    );
    await expect(backend.show(disabled, null, handlers())).rejects.toThrow("no item");
    // The menu did not show, because its item may not match the entries.
    expect(menuAt(0).popup).toHaveBeenCalledOnce();

    await backend.show(disabled, null, handlers());
    expect(itemAt(0).setEnabled).toHaveBeenCalledTimes(2);
    expect(menuAt(0).popup).toHaveBeenCalledTimes(2);

    // The second call resolved, so the cache now matches the native item.
    await backend.show(disabled, null, handlers());
    expect(itemAt(0).setEnabled).toHaveBeenCalledTimes(2);
  });

  it("sends a text and an accelerator again at the next show when the call failed", async () => {
    const backend = createTauriSegmentMenuBackend();
    await backend.show(ENTRIES, null, handlers());
    const changed: readonly SegmentMenuEntry[] = [
      item("goToSegmentIn", "跳转到入点", { accelerator: null }),
      ...ENTRIES.slice(1),
    ];
    itemAt(0).setText.mockImplementationOnce(() =>
      Promise.reject(new Error("no item")),
    );
    itemAt(0).setAccelerator.mockImplementationOnce(() =>
      Promise.reject(new Error("no item")),
    );
    await expect(backend.show(changed, null, handlers())).rejects.toThrow("no item");
    await backend.show(changed, null, handlers());
    expect(itemAt(0).setText.mock.calls).toStrictEqual([
      ["跳转到入点"],
      ["跳转到入点"],
    ]);
    expect(itemAt(0).setAccelerator.mock.calls).toStrictEqual([[null], [null]]);
  });

  it("fails a show whose build does not settle in time, and builds again at the next show", async () => {
    vi.useFakeTimers();
    const backend = createTauriSegmentMenuBackend();
    let settle: (fail: boolean) => void = () => {};
    tauri.state.holdNextMenu = (next) => {
      settle = next;
    };
    const onPopup = vi.fn();
    const shown = backend.show(ENTRIES, null, handlers(undefined, onPopup));
    const failed = expect(shown).rejects.toThrow("not ready in time");
    await vi.advanceTimersByTimeAsync(SEGMENT_MENU_PREPARE_TIMEOUT_MS - 1);
    expect(tauri.menuNew).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(onPopup).not.toHaveBeenCalled();

    // The late build settles. Nothing uses its menu, so it is freed and never shows.
    settle(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(menuAt(0).popup).not.toHaveBeenCalled();
    expect(menuAt(0).close).toHaveBeenCalledOnce();

    await backend.show(ENTRIES, null, handlers(undefined, onPopup));
    expect(tauri.menuNew).toHaveBeenCalledTimes(2);
    expect(menuAt(1).popup).toHaveBeenCalledOnce();
    expect(onPopup).toHaveBeenCalledOnce();
  });

  it("fails a show whose update does not settle in time, and sends the value again", async () => {
    vi.useFakeTimers();
    const backend = createTauriSegmentMenuBackend();
    await backend.show(ENTRIES, null, handlers());
    itemAt(0).setEnabled.mockImplementationOnce(() => new Promise<void>(() => {}));
    const disabled: readonly SegmentMenuEntry[] = [
      item("goToSegmentIn", "Go to In", { accelerator: "Shift+KeyI", enabled: false }),
      ...ENTRIES.slice(1),
    ];
    const shown = backend.show(disabled, null, handlers());
    const failed = expect(shown).rejects.toThrow("not ready in time");
    await vi.advanceTimersByTimeAsync(SEGMENT_MENU_PREPARE_TIMEOUT_MS);
    await failed;
    expect(menuAt(0).popup).toHaveBeenCalledOnce();

    await backend.show(disabled, null, handlers());
    expect(itemAt(0).setEnabled).toHaveBeenCalledTimes(2);
    expect(menuAt(0).popup).toHaveBeenCalledTimes(2);
    // The built menu stays: a hung update does not build the menu again.
    expect(tauri.menuNew).toHaveBeenCalledOnce();
  });

  it("frees the native menu at dispose, and builds a new one at the next show", async () => {
    const backend = createTauriSegmentMenuBackend();
    await backend.show(ENTRIES, null, handlers());
    backend.dispose();
    await vi.waitFor(() => expect(menuAt(0).close).toHaveBeenCalledOnce());
    for (const index of [0, 1, 2]) {
      expect(itemAt(index).close).toHaveBeenCalledOnce();
    }
    const separator: unknown = menuAt(0).items[2];
    expect(separator).toBeInstanceOf(tauri.FakeSeparator);
    expect(
      (separator as InstanceType<typeof tauri.FakeSeparator>).close,
    ).toHaveBeenCalledOnce();

    await backend.show(ENTRIES, null, handlers());
    expect(tauri.menuNew).toHaveBeenCalledTimes(2);
  });

  it("shows no menu for a show that waits for its build at dispose", async () => {
    const backend = createTauriSegmentMenuBackend();
    let settle: (fail: boolean) => void = () => {};
    tauri.state.holdNextMenu = (next) => {
      settle = next;
    };
    const onPopup = vi.fn();
    const shown = backend.show(ENTRIES, null, handlers(undefined, onPopup));
    await vi.waitFor(() => expect(tauri.menuNew).toHaveBeenCalledOnce());
    backend.dispose();
    settle(false);
    await shown;
    expect(onPopup).not.toHaveBeenCalled();
    expect(menuAt(0).popup).not.toHaveBeenCalled();
    // The build settled after the dispose, so it frees its own menu.
    await vi.waitFor(() => expect(menuAt(0).close).toHaveBeenCalledOnce());
  });

  it("builds the menu again at the next show after a build fails", async () => {
    const backend = createTauriSegmentMenuBackend();
    tauri.state.failNextMenu = true;
    await expect(backend.show(ENTRIES, null, handlers())).rejects.toThrow("no menu");
    await backend.show(ENTRIES, null, handlers());
    expect(tauri.menuNew).toHaveBeenCalledTimes(2);
    expect(menuAt(0).popup).toHaveBeenCalledOnce();
  });

  it("builds a new menu for a new order of the entries", async () => {
    const backend = createTauriSegmentMenuBackend();
    await backend.show(ENTRIES, null, handlers());
    await backend.show([item("deleteSegment", "Delete Segment")], null, handlers());
    expect(tauri.menuNew).toHaveBeenCalledTimes(2);
    expect(menuAt(1).popup).toHaveBeenCalledOnce();
  });
});

describe("the capability of the main window", () => {
  it("allows the menu commands of the segment menu through core:default", () => {
    // `core:default` holds `core:menu:default`, which allows `new`, `popup`, `set_text`,
    // `set_enabled` and `set_accelerator`. The segment menu needs no other permission.
    expect(capability.windows).toContain("main");
    expect(capability.permissions).toContain("core:default");
  });
});
