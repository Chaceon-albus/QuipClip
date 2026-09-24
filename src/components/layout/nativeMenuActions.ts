/**
 * The command items of the macOS application menu, and the rule that decides what each one
 * does.
 *
 * `src-tauri/src/menu.rs` builds three command items: Settings, Open Media and Export. A click
 * on an item, or its key equivalent, sends `BACKEND_EVENTS.MENU_ACTION` with the name of its
 * action. The name is an action of the key table (ADR 026), and this module plans the same
 * command for it as the window keyboard layer plans for the key, from the same predicates in
 * `actionConditions.ts`.
 *
 * # One key press, one action
 *
 * The page gets a key equivalent before the menu. `WKWebView` takes it while it is the first
 * responder, and it gives it back to AppKit, and so to the menu, only when the page did not
 * cancel the `keydown`. The keyboard layer cancels every key press that it owns, and it acts
 * only on a key press that it owns. So:
 *
 * - The layer owns the key press: it cancels it, it runs the action or does nothing, and the
 *   menu never sees it.
 * - The layer does not own the key press, for example in a text field or with a dialog open:
 *   it does not cancel it, and the menu item sends its event. This module then decides.
 *
 * If a later AppKit, WebKit or wry gave the menu the key press first, the page would never get
 * it, and the menu item would run the action once. Both orders run one key press once.
 *
 * # When an item does nothing
 *
 * An item does nothing while a dialog, a menu or a list box of the page is open. The layer
 * does nothing then too, and a click on the File menu of the title bar cannot happen, because
 * the dialog is modal. An item also does nothing while the native Open Media dialog is open.
 * That dialog is modal to the window, so the page gets no key press and no click, but the
 * application menu still works.
 *
 * An item does not read the focus. The layer leaves a key press to a focused text field or
 * list, because that element can use the key. A menu command is not a key of that element, so
 * the focus does not change it.
 *
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

import type { ShortcutAction } from "./shortcutBindings";
import {
  planShortcutCommand,
  type ShortcutCommand,
  type ShortcutSnapshot,
} from "./shortcutCommands";

/** The action names that the command items of the macOS menu send. */
export const NATIVE_MENU_ACTIONS = [
  "openMedia",
  "export",
  "openSettings",
] as const satisfies readonly ShortcutAction[];

export type NativeMenuAction = (typeof NATIVE_MENU_ACTIONS)[number];

/** The state outside the stores that decides whether an item may act. */
export interface NativeMenuContext {
  /**
   * True while a dialog, an alert dialog, a menu or a list box of the page is open
   * (`MODAL_LAYER_SELECTOR`).
   */
  readonly isOverlayOpen: boolean;
  /** True while the native Open Media dialog is open (`isMediaFileDialogOpen`). */
  readonly isFileDialogOpen: boolean;
}

/** Reads the payload of a menu event, or returns null when it names no command item. */
export function parseNativeMenuAction(payload: unknown): NativeMenuAction | null {
  for (const action of NATIVE_MENU_ACTIONS) {
    if (payload === action) {
      return action;
    }
  }
  return null;
}

/**
 * Returns the command that a menu event runs, or null when it runs nothing.
 *
 * The command is the plan of the key for the same action (`planShortcutCommand`), from the
 * same snapshot, so the item and the key cannot disagree about when the action can run.
 */
export function planNativeMenuCommand(
  payload: unknown,
  context: NativeMenuContext,
  snapshot: ShortcutSnapshot,
): ShortcutCommand | null {
  const action = parseNativeMenuAction(payload);
  if (action === null || context.isOverlayOpen || context.isFileDialogOpen) {
    return null;
  }
  return planShortcutCommand(action, snapshot);
}
