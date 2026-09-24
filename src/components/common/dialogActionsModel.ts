/**
 * Pure rules for `DialogActions`: the order of the buttons of a dialog footer on each
 * platform.
 *
 * The rules have no DOM and no React, so the tests need no document.
 */

import { isMacOS } from "@/lib/platform";

/**
 * The platform whose button order a dialog follows. Everything that is not macOS takes the
 * Windows order, as the title bar does (ADR 020), so Linux gets the Windows order.
 */
export type DialogPlatform = "macos" | "windows";

/** Reads the platform of the current environment. */
export function getDialogPlatform(): DialogPlatform {
  return isMacOS() ? "macos" : "windows";
}

/**
 * What an action of a dialog footer does. The role decides where the action goes, and the
 * style of its button does not.
 *
 * - `primary`: the action that the dialog proposes, such as Save, "Export…", or Delete. It
 *   is usually the default button. A footer has one at most.
 * - `cancel`: the button that goes back, or closes the dialog when nothing is left to do, and
 *   changes nothing, such as Cancel, Close, Done, or Keep Editing. It can be the default
 *   button, as Done is after an export: a WinUI dialog also puts its Close button last and
 *   lets it be the default. A footer has one at most.
 * - `discard`: a destructive action that throws away work, such as "Don't Save", Discard
 *   Changes, or Stop Export.
 * - `alternative`: any other action, such as Re-import, or Show and Open after an export.
 */
export type DialogActionRole = "primary" | "cancel" | "discard" | "alternative";

/** The part of an action that the order reads. */
export interface DialogActionSlot {
  readonly role: DialogActionRole;
}

/** One action in the order of its platform. */
export interface DialogActionPlacement<T extends DialogActionSlot> {
  readonly action: T;
  /**
   * True for an action that stands apart from the others, at the start of the row, with a
   * wider gap after it. Only a discard on macOS stands apart.
   */
  readonly apart: boolean;
}

// The position of each role, from the start of the row to its end.
const ROLE_RANK: Readonly<
  Record<DialogPlatform, Readonly<Record<DialogActionRole, number>>>
> = {
  // The default button is rightmost, and Cancel is at its left. Any other action is at the
  // left of Cancel. A destructive action is at the far left, apart from the others, so that
  // it is far from the default button (Apple Human Interface Guidelines).
  macos: { discard: 0, alternative: 1, cancel: 2, primary: 3 },
  // The default button is first, and Cancel is last. A destructive action comes directly
  // after the default button, as "Don't Save" comes after Save. Any other action comes
  // before Cancel (Windows app design guidelines).
  windows: { primary: 0, discard: 1, alternative: 2, cancel: 3 },
};

/**
 * Orders the actions of a dialog footer for `platform`, from the start of the row to its
 * end.
 *
 * - macOS: the discard actions apart at the far left, then the alternative actions, Cancel,
 *   and the primary action rightmost.
 * - Windows: the primary action first, then the discard actions, the alternative actions,
 *   and Cancel last.
 *
 * Actions of one role keep the order in which the caller gives them. The actions that stand
 * apart always come first. The caller renders the actions in this order in the document, so
 * the Tab order is the order that the user sees.
 */
export function orderDialogActions<T extends DialogActionSlot>(
  platform: DialogPlatform,
  actions: readonly T[],
): readonly DialogActionPlacement<T>[] {
  const rank = ROLE_RANK[platform];
  // `Array.prototype.sort` is stable, so actions of one role keep their order.
  return [...actions]
    .sort((a, b) => rank[a.role] - rank[b.role])
    .map((action) => ({
      action,
      apart: platform === "macos" && action.role === "discard",
    }));
}
