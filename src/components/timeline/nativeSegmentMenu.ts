/**
 * The native menu of a timeline segment, on the menu API of Tauri (`@tauri-apps/api/menu`).
 *
 * The menu is built once, on its first use, and kept for the life of the page. Each later show
 * changes only the texts, the accelerators and the enabled states that differ from the last
 * show, so a show usually costs the IPC calls of the changed enabled states and one popup.
 * Tauri keeps the channel of each menu item for the life of the application, so a menu that
 * the page built for each show would keep one more channel for each item at each show.
 *
 * `Menu.popup` resolves when the menu closes: on macOS the popup runs the menu tracking of
 * AppKit, and on Windows it runs `TrackPopupMenu`, and the command waits for both. The item
 * that the user chooses sends its event on its own channel, so the event can come before or
 * after that promise resolves.
 *
 * The items are the same for every show, so an item event does not name its show. Each show
 * therefore has its own selection (`ShowSelection`), which runs at most once. An event goes to
 * the selection of the show whose popup started last. A new show clears that selection when it
 * starts, so a late event of the show before it, which arrives while the new show builds or
 * updates its menu, runs nothing. An event can reach the wrong show only if it arrives after the
 * popup of the next show started. That needs a new right-click inside the delay of one IPC
 * message.
 *
 * The capability of the main window needs no new permission: `core:default` holds
 * `core:menu:default`, which allows `new`, `popup`, `set_text`, `set_enabled` and
 * `set_accelerator`.
 */

import { isTauri, type Resource } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import type {
  SegmentMenuAction,
  SegmentMenuEntry,
  SegmentMenuItem,
  SegmentMenuPosition,
} from "./segmentMenuModel";

/** The handlers of one show of the menu. */
export interface SegmentMenuShowHandlers {
  /**
   * Runs at most once, for the item that the user chooses. It can run before or after the
   * promise of the show resolves. It never runs after the next show starts.
   */
  readonly onSelect: (action: SegmentMenuAction) => void;
  /**
   * Runs once, just after the popup call is sent, while the menu is on its way to the screen or
   * shows. It does not run for a show that shows no menu.
   */
  readonly onPopup: () => void;
}

/**
 * The longest time that a show waits for its menu to be built or updated, in milliseconds. A
 * show that waits longer fails, so the mark of the menu closes (`nativeContextMenuState`) and
 * the page does not stay without a keyboard.
 */
export const SEGMENT_MENU_PREPARE_TIMEOUT_MS = 2_000;

/** Shows the menu of a segment. The session takes it as a dependency, so a test passes a fake. */
export interface SegmentMenuBackend {
  /**
   * Shows the menu with these entries and waits until it closes.
   *
   * @param entries The entries of the menu (`buildSegmentMenuEntries`).
   * @param position The position in client CSS pixels, or null to open the menu at the pointer.
   * @param handlers The handlers of this show.
   * @returns A promise that resolves when the menu closes. It resolves at once where no native
   *   menu exists, such as in a browser tab.
   */
  readonly show: (
    entries: readonly SegmentMenuEntry[],
    position: SegmentMenuPosition | null,
    handlers: SegmentMenuShowHandlers,
  ) => Promise<void>;
}

/** The backend on the menu API of Tauri. */
export interface TauriSegmentMenuBackend extends SegmentMenuBackend {
  /**
   * Frees the native menu and ends the show that waits for it, for a hot reload in development.
   * A show on its way then shows no menu.
   */
  readonly dispose: () => void;
}

/** The last values that the page gave to one native item. */
interface BuiltItem {
  readonly item: MenuItem;
  text: string;
  enabled: boolean;
  accelerator: string | null;
}

interface BuiltMenu {
  readonly menu: Menu;
  readonly items: ReadonlyMap<SegmentMenuAction, BuiltItem>;
  /** Every native resource of the menu: the menu, its items and its separators. */
  readonly resources: readonly Resource[];
}

/** The menu of one layout, while it is built and after. */
interface CacheEntry {
  readonly layout: string;
  readonly menu: Promise<BuiltMenu>;
  /** True once the build resolved or rejected. */
  isSettled: boolean;
}

/** Frees the native resources of a menu. A resource that is already gone is ignored. */
function closeMenu(built: BuiltMenu): void {
  void Promise.all(built.resources.map((resource) => resource.close())).catch(() => {});
}

/**
 * Rejects when the promise does not settle within the time, and settles as it does otherwise.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error("The segment menu was not ready in time."));
    }, timeoutMs);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** The choice of one show. A native menu closes after one choice, so it runs at most once. */
interface ShowSelection {
  readonly select: (action: SegmentMenuAction) => void;
  isDone: boolean;
}

/** The order of the items and the separators. A menu with another order is built again. */
function layoutOf(entries: readonly SegmentMenuEntry[]): string {
  return entries.map((entry) => (entry.kind === "item" ? entry.action : "|")).join(",");
}

/** Creates the backend on the menu API of Tauri. */
export function createTauriSegmentMenuBackend(): TauriSegmentMenuBackend {
  let cache: CacheEntry | null = null;
  // The number of shows that started. A show that a newer show replaced before its popup shows
  // nothing.
  let showCount = 0;
  // The selection of the show whose popup started last, or null from the start of a show until
  // its popup starts. Each item passes its action to it (`dispatch`).
  let selection: ShowSelection | null = null;

  const dispatch = (action: SegmentMenuAction): void => {
    const current = selection;
    if (current === null || current.isDone) {
      return;
    }
    current.isDone = true;
    current.select(action);
  };

  const buildItem = async (entry: SegmentMenuItem): Promise<BuiltItem> => {
    const item = await MenuItem.new({
      text: entry.text,
      enabled: entry.enabled,
      ...(entry.accelerator === null ? {} : { accelerator: entry.accelerator }),
      action: () => dispatch(entry.action),
    });
    return {
      item,
      text: entry.text,
      enabled: entry.enabled,
      accelerator: entry.accelerator,
    };
  };

  const build = async (entries: readonly SegmentMenuEntry[]): Promise<BuiltMenu> => {
    // The items are created in parallel. `Promise.all` keeps the order of the entries.
    const parts = await Promise.all(
      entries.map(async (entry) =>
        entry.kind === "item"
          ? {
              kind: "item" as const,
              action: entry.action,
              built: await buildItem(entry),
            }
          : {
              kind: "separator" as const,
              item: await PredefinedMenuItem.new({ item: "Separator" }),
            },
      ),
    );
    const items = new Map<SegmentMenuAction, BuiltItem>();
    const menu = await Menu.new({
      items: parts.map((part) => {
        if (part.kind === "separator") {
          return part.item;
        }
        items.set(part.action, part.built);
        return part.built.item;
      }),
    });
    const resources: Resource[] = [
      menu,
      ...parts.map((part) => (part.kind === "separator" ? part.item : part.built.item)),
    ];
    return { menu, items, resources };
  };

  /**
   * Sends the values of the entries that differ from the last values of the native items. A
   * value enters the cache only when its call resolves, so a call that fails is sent again at
   * the next show.
   */
  const update = async (
    built: BuiltMenu,
    entries: readonly SegmentMenuEntry[],
  ): Promise<void> => {
    const calls: Promise<void>[] = [];
    for (const entry of entries) {
      if (entry.kind !== "item") {
        continue;
      }
      const target = built.items.get(entry.action);
      if (target === undefined) {
        continue;
      }
      const { text, enabled, accelerator } = entry;
      if (target.text !== text) {
        calls.push(
          target.item.setText(text).then(() => {
            target.text = text;
          }),
        );
      }
      if (target.enabled !== enabled) {
        calls.push(
          target.item.setEnabled(enabled).then(() => {
            target.enabled = enabled;
          }),
        );
      }
      if (target.accelerator !== accelerator) {
        calls.push(
          target.item.setAccelerator(accelerator).then(() => {
            target.accelerator = accelerator;
          }),
        );
      }
    }
    await Promise.all(calls);
  };

  /** The built menu for the layout of the entries, with the values of the entries. */
  const prepare = async (entries: readonly SegmentMenuEntry[]): Promise<BuiltMenu> => {
    const layout = layoutOf(entries);
    if (cache !== null && cache.layout === layout) {
      const built = await cache.menu;
      await update(built, entries);
      return built;
    }
    // The code fixes the layout (`SEGMENT_MENU_LAYOUT`), so a backend builds one layout for the
    // life of its module. A caller that passes another layout gets a new menu, and the menu of
    // the old layout is freed.
    // A build that has not settled yet frees its menu when it settles (see below).
    const old = cache;
    if (old !== null && old.isSettled) {
      void old.menu.then(closeMenu, () => {});
    }
    const menu = build(entries);
    const entry: CacheEntry = { layout, menu, isSettled: false };
    cache = entry;
    menu.then(
      (built) => {
        entry.isSettled = true;
        // A show gave up on this build, or a newer layout replaced it. Nothing uses the menu.
        if (cache !== entry) {
          closeMenu(built);
        }
      },
      () => {
        entry.isSettled = true;
        // A build that fails is built again at the next show.
        if (cache === entry) {
          cache = null;
        }
      },
    );
    return menu;
  };

  return {
    show: async (entries, position, { onSelect, onPopup }) => {
      if (!isTauri()) {
        return;
      }
      // This show ends the show before it. A late event of that show runs nothing from here on.
      showCount += 1;
      const show = showCount;
      selection = null;
      let built: BuiltMenu;
      try {
        // A build or an update that never settles would keep the mark of the menu open, and
        // the page without a keyboard.
        built = await withTimeout(prepare(entries), SEGMENT_MENU_PREPARE_TIMEOUT_MS);
      } catch (error) {
        // A build that did not settle is built again at the next show. A value whose call did
        // not settle is not in the cache, so the next show sends it again.
        if (cache !== null && !cache.isSettled) {
          cache = null;
        }
        throw error;
      }
      if (show !== showCount) {
        return;
      }
      selection = { select: onSelect, isDone: false };
      // The selection stays after the popup resolves, because the event of the chosen item can
      // arrive later.
      const popup = built.menu.popup(
        position === null ? undefined : new LogicalPosition(position.x, position.y),
      );
      onPopup();
      await popup;
    },

    dispose: () => {
      showCount += 1;
      selection = null;
      // A build that has not settled yet frees its menu when it settles.
      const entry = cache;
      cache = null;
      if (entry !== null && entry.isSettled) {
        void entry.menu.then(closeMenu, () => {});
      }
    },
  };
}
