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
 * 1. It selects the segment, as a click does. A selection does not seek (ADR 007). When the
 *    segment is one of several selected segments, it keeps that selection instead, and the menu
 *    acts on all of it (`resolveSegmentMenuTarget`, ADR 045).
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
 * A late item event is safe, because the item plans again when it runs, names the target of
 * its menu, and does nothing while a dialog or a menu of the page is open.
 *
 * An item runs the command that its key plans at the moment the item runs
 * (`planSegmentMenuCommand`), through the same runner as the key (`runShortcutCommand`). A
 * condition that changed while the menu was open therefore applies to the item too.
 *
 * The menu that opens does not end a program play (ADR 074). Go to In, Go to Out and Play
 * Segment take the playback: their choice first ends the run, and the item then plans against
 * the state that results (`takeOverProgramPlay`). While a run exists, Play Segment shows Play
 * Segment and not Pause (`planShortcutCommand`).
 *
 * An item that opens a dialog (`SEGMENT_MENU_DIALOG_ACTIONS`, ADR 065) runs only after the menu
 * closed: when both its choice and the end of the mark arrived, in either order
 * (`menuDialogHandoff.ts`). The end of the mark is the settled popup, or the first input after the
 * grace period of a popup that never settles. When the choice came and the end did not, a timer
 * of the hand-off ends the wait after that grace period. The item plans again at that moment, so
 * it checks its target when the dialog opens. The backend binds the event of such an item to the
 * show that it came from, and a later menu cancels the hand-off of the menu before it.
 *
 * The item event reports the choice to the mark (`NativeContextMenuMark.chosen`). A mark that
 * closes with no choice keeps a choice pending for the grace period (`isChoicePending`), so the
 * recovery prompt (ADR 073) does not show between the popup reply and a late item event:
 *
 * - Item event first: the item runs at once, or the hand-off keeps it, and the mark records the
 *   choice. At the close, the item of the hand-off runs in the close listeners, and no choice is
 *   pending.
 * - Popup reply first: the mark closes with a pending choice. The item event then runs the item,
 *   and only after that ends the pending choice. With no item event, the grace period ends it.
 */

import type { StoreApi } from "zustand/vanilla";
import {
  isModalLayerOpen,
  NATIVE_CONTEXT_MENU_GRACE_MS,
  nativeContextMenuState,
  type NativeContextMenuState,
} from "@/components/layout/nativeContextMenuState";
import { takeOverProgramPlay } from "@/components/layout/programTakeover";
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
import { sequencePlayback } from "@/features/sequence";
import {
  findCurrentSegment,
  timelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import { i18n } from "@/i18n";
import {
  createMenuDialogHandoff,
  type MenuDialogHandoff,
  type MenuDialogHandoffSchedule,
} from "./menuDialogHandoff";
import {
  createTauriSegmentMenuBackend,
  type SegmentMenuBackend,
} from "./nativeSegmentMenu";
import {
  buildSegmentMenuEntries,
  canOpenSegmentMenu,
  planSegmentMenuCommand,
  resolveSegmentMenuTarget,
  SEGMENT_MENU_DIALOG_ACTIONS,
  type SegmentMenuAction,
  type SegmentMenuEntry,
  type SegmentMenuItem,
  type SegmentMenuLabelKey,
  type SegmentMenuLabelValues,
  type SegmentMenuPosition,
  type SegmentMenuTarget,
} from "./segmentMenuModel";

/** The stores and the services that the menu reads and calls. The production values satisfy it. */
export interface SegmentContextMenuDependencies {
  readonly timeline: Pick<StoreApi<TimelineStoreState>, "getState">;
  /** One read of the stores, as the window keyboard layer takes it (`readShortcutSnapshot`). */
  readonly readSnapshot: () => ShortcutSnapshot;
  /** Runs a planned command, as the window keyboard layer does (`runShortcutCommand`). */
  readonly runCommand: (command: ShortcutCommand) => void;
  /**
   * Ends the program play that runs (`SequencePlayback.endProgramPlay`), and returns true when
   * a run ended (ADR 074). Absent means that no run exists.
   */
  readonly endProgramPlay?: () => boolean;
  /** True while a dialog, a menu or a list box of the page is open (`isModalLayerOpen`). */
  readonly isOverlayOpen: () => boolean;
  readonly menuState: NativeContextMenuState;
  readonly backend: SegmentMenuBackend;
  readonly platform: ShortcutPlatform;
  /** Reads a label or a key name from the catalog, with the values of a label. */
  readonly translate: (
    key: SegmentMenuLabelKey | ShortcutKeyNameKey,
    values?: SegmentMenuLabelValues,
  ) => string;
  /** Receives a failure of the native menu. The menu then did not show. */
  readonly onError?: (error: unknown) => void;
  /** The timer of the dialog hand-off (`MenuDialogHandoffTimer`). `setTimeout` by default. */
  readonly schedule?: MenuDialogHandoffSchedule;
}

const DEFAULT_SCHEDULE: MenuDialogHandoffSchedule = (callback, delayMs) => {
  const handle = globalThis.setTimeout(callback, delayMs);
  return () => {
    globalThis.clearTimeout(handle);
  };
};

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
  const endProgramPlay = dependencies.endProgramPlay ?? (() => false);
  const schedule = dependencies.schedule ?? DEFAULT_SCHEDULE;
  // The dialog hand-off of the latest menu.
  let latestHandoff: MenuDialogHandoff<SegmentMenuAction> | null = null;

  /**
   * Runs the item that the user chose in the menu.
   *
   * @param target The segments that the menu named.
   * @param entries The entries that the menu showed. The item runs only a command of the kind
   *   that it showed (`SegmentMenuItem.commandKind`).
   */
  const select = (
    action: SegmentMenuAction,
    target: SegmentMenuTarget,
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
    // The user takes the playback from a program play before the item plans (ADR 074). The
    // snapshot below is read after the end of the run.
    takeOverProgramPlay(action, endProgramPlay);
    const command = planSegmentMenuCommand(
      action,
      target,
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

      // A request on one of several selected segments keeps the selection, and the menu acts on
      // all of it (ADR 045). Any other request selects only its segment, as a click does.
      const target = resolveSegmentMenuTarget(segmentId, state);
      if (target.kind === "segment") {
        state.selectSegment(segmentId);
      }
      const mark = menuState.open();
      // The dialog hand-off of the menu before ends here, with its timer, so no dialog of that
      // menu opens after this one opened (ADR 026). The backend binds the event of a dialog item
      // to its own show (`nativeSegmentMenu.ts`), so a late event of that menu never reaches
      // the hand-off of this one.
      latestHandoff?.cancel();

      let shown: Promise<void>;
      try {
        const entries = buildSegmentMenuEntries({
          target,
          snapshot: readSnapshot(),
          platform,
          keyNames: resolveShortcutKeyNames(translate),
          translate,
        });
        // An item that opens a dialog waits until the menu has gone (ADR 065). The item event
        // proves that the menu is closing, so a popup reply that never comes ends the wait after
        // the grace period, and the mark closes with it.
        const handoff = createMenuDialogHandoff<SegmentMenuAction>(
          (action) => select(action, target, entries),
          {
            schedule,
            delayMs: NATIVE_CONTEXT_MENU_GRACE_MS,
            onExpire: mark.close,
          },
        );
        latestHandoff = handoff;
        mark.onClose(handoff.close);
        shown = backend.show(entries, position, {
          onSelect: (action) => {
            if (SEGMENT_MENU_DIALOG_ACTIONS.has(action)) {
              handoff.choose(action);
            } else {
              select(action, target, entries);
            }
            // The choice came: the mark keeps no choice pending after its close (ADR 073). The
            // call comes after the item ran, or after the hand-off took the choice, so nothing
            // that waits for the menu, such as the recovery prompt, shows before the item.
            mark.chosen();
          },
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
  endProgramPlay: sequencePlayback.endProgramPlay,
  isOverlayOpen: isModalLayerOpen,
  menuState: nativeContextMenuState,
  backend: tauriSegmentMenuBackend,
  platform: getShortcutPlatform(),
  translate: (key, values) => i18n.t(key, values),
  // A menu that does not show loses one right-click, and the user can do it again, so the
  // failure goes to the console only.
  onError: (error) => {
    console.error("The segment menu did not open.", error);
  },
});
