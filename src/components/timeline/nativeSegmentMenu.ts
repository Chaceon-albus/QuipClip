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
 * An item that opens a dialog (`SEGMENT_MENU_DIALOG_ACTIONS`, ADR 065) cannot accept that risk: a
 * late event would open the dialog for the segment of another menu. Such an item therefore gets a
 * new native item at each show, whose handler names its show (`ShowToken`). A cached show creates
 * it, inserts it at its place in the menu, removes the item of the show before, and releases that
 * item. An event of a show that a later show replaced runs nothing, and an event of the latest
 * show reaches that show, also after its popup settled. Each such show keeps one more channel, a
 * cost of one item and not of the whole menu.
 *
 * The capability of the main window needs no new permission: `core:default` holds
 * `core:menu:default`, which allows `new`, `insert`, `remove`, `popup`, `set_text`,
 * `set_enabled` and `set_accelerator`, and `core:resources:default`, which allows `close`.
 */

import { isTauri, type Resource } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import {
  SEGMENT_MENU_DIALOG_ACTIONS,
  type SegmentMenuAction,
  type SegmentMenuEntry,
  type SegmentMenuItem,
  type SegmentMenuPosition,
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

/** The options of the backend. */
export interface TauriSegmentMenuBackendOptions {
  /**
   * The actions whose item is a new native item at each show, bound to that show (see above).
   * `SEGMENT_MENU_DIALOG_ACTIONS` by default.
   */
  readonly perShowActions?: ReadonlySet<SegmentMenuAction>;
}

/** One show, as the item of a per-show action names it. */
interface ShowToken {
  /** The selection of the show, from the start of its popup. */
  selection: ShowSelection | null;
  /** True once a later show started. An event of the item of this show then runs nothing. */
  replaced: boolean;
  /**
   * True once the item of a per-show action of this show ran its choice. It is apart from
   * `ShowSelection.isDone`: a late event of an ordinary item of the show before can reach the
   * selection of this show (see above), and it must not stop the real choice of this item.
   */
  isDone: boolean;
}

/** The last values that the page gave to one native item. */
interface BuiltItem {
  readonly item: MenuItem;
  text: string;
  enabled: boolean;
  accelerator: string | null;
  /** The show that the item names, for an item of a per-show action. Null for every other item. */
  readonly token: ShowToken | null;
}

interface BuiltMenu {
  readonly menu: Menu;
  /** The items by action. A show replaces the item of a per-show action here. */
  readonly items: Map<SegmentMenuAction, BuiltItem>;
  /** The separators of the menu. */
  readonly separators: readonly Resource[];
}

/** The menu of one layout, while it is built and after. */
interface CacheEntry {
  readonly layout: string;
  readonly menu: Promise<BuiltMenu>;
  /** True once the build resolved or rejected. */
  isSettled: boolean;
  /**
   * The swaps of per-show items on this menu, one after another, so two shows never swap at
   * once. The queue belongs to its entry: a swap that never settles blocks only the menu of this
   * entry, which the show evicts when its preparation times out (`show`).
   */
  swaps: Promise<void>;
}

/**
 * Frees the native resources of a menu: the menu, its items and its separators. A resource that
 * is already gone is ignored.
 */
function closeMenu(built: BuiltMenu): void {
  const resources: Resource[] = [
    built.menu,
    ...[...built.items.values()].map((entry) => entry.item),
    ...built.separators,
  ];
  void Promise.all(resources.map((resource) => resource.close())).catch(() => {});
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
export function createTauriSegmentMenuBackend(
  options: TauriSegmentMenuBackendOptions = {},
): TauriSegmentMenuBackend {
  const perShowActions = options.perShowActions ?? SEGMENT_MENU_DIALOG_ACTIONS;
  let cache: CacheEntry | null = null;
  // The show that started last, as the item of a per-show action names it.
  let latestToken: ShowToken | null = null;
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

  /**
   * The handler of the item of a per-show action: it runs the choice of its own show, and nothing
   * once a later show started. It runs at most once for its show, by its own state
   * (`ShowToken.isDone`), so an ordinary event that the show took before does not stop it. It
   * also ends the ordinary choice of the show, which then takes no later ordinary event.
   */
  const dispatchFor = (token: ShowToken, action: SegmentMenuAction) => (): void => {
    const current = token.selection;
    if (token.replaced || token.isDone || current === null) {
      return;
    }
    token.isDone = true;
    current.isDone = true;
    current.select(action);
  };

  const buildItem = async (
    entry: SegmentMenuItem,
    token: ShowToken,
  ): Promise<BuiltItem> => {
    const perShow = perShowActions.has(entry.action);
    const item = await MenuItem.new({
      text: entry.text,
      enabled: entry.enabled,
      ...(entry.accelerator === null ? {} : { accelerator: entry.accelerator }),
      action: perShow ? dispatchFor(token, entry.action) : () => dispatch(entry.action),
    });
    return {
      item,
      text: entry.text,
      enabled: entry.enabled,
      accelerator: entry.accelerator,
      token: perShow ? token : null,
    };
  };

  /**
   * Gives each per-show action of a cached menu a new item for this show: it creates the item,
   * inserts it at the place of the item of the show before, removes that item, and releases it.
   * A swap that fails leaves the menu in a state that the page does not know, so the menu is freed
   * and the next show builds it again.
   */
  const swapPerShowItems = async (
    built: BuiltMenu,
    entries: readonly SegmentMenuEntry[],
    token: ShowToken,
    isCurrent: () => boolean,
  ): Promise<void> => {
    for (const [position, entry] of entries.entries()) {
      if (entry.kind !== "item" || !perShowActions.has(entry.action)) {
        continue;
      }
      const old = built.items.get(entry.action);
      if (old === undefined || old.token === token) {
        continue;
      }
      const fresh = await buildItem(entry, token);
      try {
        // A show that timed out evicted the entry while a call was on its way. The evicted menu
        // gets no further call: the new item goes now, and the menu, its items and its
        // separators go when this swap settles, which follows at once.
        if (!isCurrent()) {
          void fresh.item.close().catch(() => {});
          return;
        }
        await built.menu.insert(fresh.item, position);
        if (!isCurrent()) {
          void fresh.item.close().catch(() => {});
          return;
        }
        await built.menu.remove(old.item);
      } catch (error) {
        void fresh.item.close().catch(() => {});
        throw error;
      }
      built.items.set(entry.action, fresh);
      void old.item.close().catch(() => {});
    }
  };

  const build = async (
    entries: readonly SegmentMenuEntry[],
    token: ShowToken,
  ): Promise<BuiltMenu> => {
    // The items are created in parallel. `Promise.all` keeps the order of the entries.
    const parts = await Promise.all(
      entries.map(async (entry) =>
        entry.kind === "item"
          ? {
              kind: "item" as const,
              action: entry.action,
              built: await buildItem(entry, token),
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
    const separators: Resource[] = parts.flatMap((part) =>
      part.kind === "separator" ? [part.item] : [],
    );
    return { menu, items, separators };
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
      // The item of a per-show action gets the values of its show when it is created.
      if (target === undefined || perShowActions.has(entry.action)) {
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

  /**
   * The built menu for the layout of the entries, with the values of the entries.
   *
   * @param progress Records the cache entry while this show waits for its swap, so a show whose
   *   preparation times out there can evict that entry.
   */
  const prepare = async (
    entries: readonly SegmentMenuEntry[],
    token: ShowToken,
    progress: { swapping: CacheEntry | null },
  ): Promise<BuiltMenu> => {
    const layout = layoutOf(entries);
    if (cache !== null && cache.layout === layout) {
      const current = cache;
      const built = await current.menu;
      await update(built, entries);
      const swap = current.swaps.then(async () => {
        // A later show swaps for itself. The menu of an evicted entry is not used any more.
        if (token.replaced || cache !== current) {
          return;
        }
        await swapPerShowItems(built, entries, token, () => cache === current);
      });
      // When the swap settles, a menu that is no longer the cache is freed with all that it
      // holds, and a swap that failed frees its menu. It never changes another entry.
      current.swaps = swap.then(
        () => {
          if (cache !== current) {
            closeMenu(built);
          }
        },
        () => {
          if (cache === current) {
            cache = null;
          }
          closeMenu(built);
        },
      );
      progress.swapping = current;
      await swap;
      progress.swapping = null;
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
    const menu = build(entries, token);
    const entry: CacheEntry = {
      layout,
      menu,
      isSettled: false,
      swaps: Promise.resolve(),
    };
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
      // The item of a per-show action of the show before runs nothing from here on.
      if (latestToken !== null) {
        latestToken.replaced = true;
      }
      const token: ShowToken = { selection: null, replaced: false, isDone: false };
      latestToken = token;
      let built: BuiltMenu;
      const progress: { swapping: CacheEntry | null } = { swapping: null };
      try {
        // A build or an update that never settles would keep the mark of the menu open, and
        // the page without a keyboard.
        built = await withTimeout(
          prepare(entries, token, progress),
          SEGMENT_MENU_PREPARE_TIMEOUT_MS,
        );
      } catch (error) {
        // A build that did not settle is built again at the next show. A value whose call did
        // not settle is not in the cache, so the next show sends it again.
        if (cache !== null && !cache.isSettled) {
          cache = null;
        }
        // A swap that did not settle would block every later show behind it, so its entry
        // goes, and the next show builds a new menu with its own queue. The swap frees the old
        // menu when it settles.
        if (progress.swapping !== null && cache === progress.swapping) {
          cache = null;
        }
        throw error;
      }
      if (show !== showCount) {
        return;
      }
      selection = { select: onSelect, isDone: false };
      token.selection = selection;
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
      if (latestToken !== null) {
        latestToken.replaced = true;
      }
      // A build that has not settled yet frees its menu when it settles.
      const entry = cache;
      cache = null;
      if (entry !== null && entry.isSettled) {
        void entry.menu.then(closeMenu, () => {});
      }
    },
  };
}
