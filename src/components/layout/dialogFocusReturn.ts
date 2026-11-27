/**
 * The fallback targets of the focus when a dialog of the application shell closes and has no
 * Radix trigger: the dialog of a save that failed and the project dialog (ADR 072). Each dialog
 * notes them at its open (`createConfirmFocusReturn`): the element that held the focus when it
 * can take the focus, else the dialog that held it while that dialog is still open, else the File
 * menu trigger of the title bar while no other dialog of the page is open.
 */

import { ENCLOSING_DIALOG_SELECTOR } from "@/components/common/focusCandidate";
import { OPEN_DIALOG_SELECTOR } from "@/components/common/focusTarget";
import { TITLE_BAR_FILE_MENU_SELECTOR } from "@/lib/titleBar";

/**
 * The File menu trigger of the title bar, a stable element, while no other dialog of the page is
 * open. An action from an item of that menu opens the dialog after the item is gone, so the focus
 * goes there in place of the document body. It never goes behind a dialog that is still open.
 */
export const fileMenuTrigger = (): HTMLElement | null =>
  document.querySelector(OPEN_DIALOG_SELECTOR) === null
    ? document.querySelector<HTMLElement>(TITLE_BAR_FILE_MENU_SELECTOR)
    : null;

/**
 * The dialog that held `opener` at the open, while that dialog is still open, or null. Radix
 * keeps a closing dialog in the document during its exit animation, and that one does not count.
 */
export function openEnclosingDialog(opener: Element | null): () => HTMLElement | null {
  const enclosing = opener?.closest<HTMLElement>(ENCLOSING_DIALOG_SELECTOR) ?? null;
  return () =>
    enclosing !== null &&
    enclosing.isConnected &&
    enclosing.matches(OPEN_DIALOG_SELECTOR)
      ? enclosing
      : null;
}
