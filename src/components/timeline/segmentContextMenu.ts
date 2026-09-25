/**
 * The runtime of the context menu of a timeline segment: it opens the menu for a request of the
 * segment layer, and it runs the item that the user chooses.
 *
 * Every rule is a pure function of `segmentMenuModel.ts`. This module runs those rules against
 * the stores, which it takes as dependencies, so the tests drive it with a fake menu. It has no
 * DOM and no React dependency.
 *
 * A request that opens the menu does these steps, in this order:
 *
 * 1. It selects the segment, as a click does. A selection does not seek (ADR 007).
 * 2. It marks a native context menu as open (`nativeContextMenuState`), so the window keyboard
 *    layer, the timeline presses and the command items of the macOS menu do nothing until the
 *    menu closes (ADR 021).
 * 3. It builds the entries from one read of the stores, taken after the selection, and shows
 *    the menu. The mark stays until the menu closes, or until the menu fails to show.
 *
 * If the popup never settles, the first trusted press or key press after the popup call and its
 * grace period closes the mark (`NativeContextMenuMark.showing`), because a native menu takes
 * all input while it shows. The menu keeps its pending choice until the next show starts: a lost
 * popup reply is the likeliest cause, and the item event can still arrive on its own channel.
 * A late item event is safe, because the item plans again when it runs, names the segment of
 * its menu, and does nothing while a dialog or a menu of the page is open.
 *
 * An item runs the command that its key plans at the moment the item runs
 * (`planSegmentMenuCommand`), through the same runner as the key (`runShortcutCommand`). A
 * condition that changed while the menu was open therefore applies to the item too.
 */

import type { StoreApi } from "zustand/vanilla";
import {
  isModalLayerOpen,
  nativeContextMenuState,
  type NativeContextMenuState,
} from "@/components/layout/nativeContextMenuState";
import {
  getShortcutPlatform,
  type ShortcutPlatform,
} from "@/components/layout/shortcutBindings";
import type {
  ShortcutCommand,
  ShortcutSnapshot,
} from "@/components/layout/shortcutCommands";
import {
  resolveShortcutKeyNames,
  type ShortcutKeyNameKey,
} from "@/components/layout/shortcutLabels";
import {
  readShortcutSnapshot,
  runShortcutCommand,
} from "@/components/layout/useKeyboardShortcuts";
import {
  findCurrentSegment,
  timelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import { i18n } from "@/i18n";
import {
  createTauriSegmentMenuBackend,
  type SegmentMenuBackend,
} from "./nativeSegmentMenu";
import {
  buildSegmentMenuEntries,
  canOpenSegmentMenu,
  planSegmentMenuCommand,
  type SegmentMenuAction,
  type SegmentMenuEntry,
  type SegmentMenuItem,
  type SegmentMenuLabelKey,
  type SegmentMenuPosition,
} from "./segmentMenuModel";

/** The stores and the services that the menu reads and calls. The production values satisfy it. */
export interface SegmentContextMenuDependencies {
  readonly timeline: Pick<StoreApi<TimelineStoreState>, "getState">;
  /** One read of the stores, as the window keyboard layer takes it (`readShortcutSnapshot`). */
  readonly readSnapshot: () => ShortcutSnapshot;
  /** Runs a planned command, as the window keyboard layer does (`runShortcutCommand`). */
  readonly runCommand: (command: ShortcutCommand) => void;
  /** True while a dialog, a menu or a list box of the page is open (`isModalLayerOpen`). */
  readonly isOverlayOpen: () => boolean;
  readonly menuState: NativeContextMenuState;
  readonly backend: SegmentMenuBackend;
  readonly platform: ShortcutPlatform;
  /** Reads a label or a key name from the catalog. */
  readonly translate: (key: SegmentMenuLabelKey | ShortcutKeyNameKey) => string;
  /** Receives a failure of the native menu. The menu then did not show. */
  readonly onError?: (error: unknown) => void;
}

/** A request of the segment layer to open the menu. */
export interface SegmentContextMenuRequest {
  readonly segmentId: string;
  /** The position of the menu in client CSS pixels, or null to open it at the pointer. */
  readonly position: SegmentMenuPosition | null;
  /** True while the pointer gesture of the timeline runs (`SegmentMenuOpenInput`). */
  readonly isPointerGestureActive: boolean;
}

export interface SegmentContextMenu {
  /**
   * Opens the menu for the request, or does nothing when the request cannot open it
   * (`canOpenSegmentMenu`).
   *
   * @returns A promise that resolves when the menu closes, or null when the request did
   *   nothing. The promise never rejects.
   */
  readonly open: (request: SegmentContextMenuRequest) => Promise<void> | null;
}

/** Creates a menu on the given dependencies. */
export function createSegmentContextMenu(
  dependencies: SegmentContextMenuDependencies,
): SegmentContextMenu {
  const {
    timeline,
    readSnapshot,
    runCommand,
    isOverlayOpen,
    menuState,
    backend,
    platform,
    translate,
  } = dependencies;
  const onError = dependencies.onError ?? (() => {});

  /**
   * Runs the item that the user chose in the menu of the segment.
   *
   * @param entries The entries that the menu showed. The item runs only a command of the kind
   *   that it showed (`SegmentMenuItem.commandKind`).
   */
  const select = (
    action: SegmentMenuAction,
    segmentId: string,
    entries: readonly SegmentMenuEntry[],
  ): void => {
    // The layer does nothing while a dialog or a menu of the page is open, and the item does
    // the same. The native menu has closed when its item runs, so its own mark does not count.
    if (isOverlayOpen()) {
      return;
    }
    const shown = entries.find(
      (entry): entry is SegmentMenuItem =>
        entry.kind === "item" && entry.action === action,
    );
    if (shown === undefined) {
      return;
    }
    const command = planSegmentMenuCommand(
      action,
      segmentId,
      readSnapshot(),
      shown.commandKind,
    );
    if (command !== null) {
      runCommand(command);
    }
  };

  return {
    open: ({ segmentId, position, isPointerGestureActive }) => {
      const state = timeline.getState();
      if (
        !canOpenSegmentMenu({
          isSegmentOfActiveSource:
            findCurrentSegment(state.segments, segmentId, state.sourceId) !== null,
          isPointerGestureActive,
          isTrimDragging: readSnapshot().isTrimDragging === true,
          isOverlayOpen: isOverlayOpen(),
          isMenuOpen: menuState.isOpen(),
        })
      ) {
        return null;
      }

      state.selectSegment(segmentId);
      const mark = menuState.open();

      let shown: Promise<void>;
      try {
        const entries = buildSegmentMenuEntries({
          segmentId,
          snapshot: readSnapshot(),
          platform,
          keyNames: resolveShortcutKeyNames(translate),
          translate,
        });
        shown = backend.show(entries, position, {
          onSelect: (action) => select(action, segmentId, entries),
          onPopup: mark.showing,
        });
      } catch (error) {
        shown = Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return shown.catch(onError).finally(mark.close);
    },
  };
}

/** The native menu of the application. */
const tauriSegmentMenuBackend = createTauriSegmentMenuBackend();

// A hot reload of this module in development makes a new backend with a new native menu. The
// old one frees its native menu.
import.meta.hot?.dispose(() => {
  tauriSegmentMenuBackend.dispose();
});

/** The menu of the application, on the production stores and the native menu of Tauri. */
export const segmentContextMenu: SegmentContextMenu = createSegmentContextMenu({
  timeline: timelineStore,
  readSnapshot: readShortcutSnapshot,
  runCommand: runShortcutCommand,
  isOverlayOpen: isModalLayerOpen,
  menuState: nativeContextMenuState,
  backend: tauriSegmentMenuBackend,
  platform: getShortcutPlatform(),
  translate: (key) => i18n.t(key),
  // A menu that does not show loses one right-click, and the user can do it again, so the
  // failure goes to the console only.
  onError: (error) => {
    console.error("The segment menu did not open.", error);
  },
});
