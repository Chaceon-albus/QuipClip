/**
 * The adapters that wrap a DOM element for the focus rule of a dialog with no Radix trigger
 * (`createConfirmFocusReturn` in `confirmDialogModel.ts`). `ConfirmDialog` and the dialog of a
 * save that failed (`ProjectSaveErrorDialog`) use them.
 */

import type { FocusCandidate } from "./confirmDialogModel";

/**
 * The modal layers that can hold the opener of a dialog. The fallback focus target is the one
 * around the opener.
 */
export const ENCLOSING_DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"]';

/** Wraps an element for the focus rule, or returns null for a value that is not an element. */
export function toFocusCandidate(element: Element | null): FocusCandidate | null {
  if (!(element instanceof HTMLElement)) {
    return null;
  }
  // Getters, because the rule reads both values when the dialog closes, not when it opens.
  return {
    get isConnected() {
      return element.isConnected;
    },
    get isDisabled() {
      return element.matches(":disabled");
    },
    get isDocumentBody() {
      return element === element.ownerDocument.body;
    },
    focus: () => {
      element.focus();
    },
  };
}

/**
 * Wraps a function that names an element, so that the focus rule reads the element when the
 * dialog closes. The element can change while the dialog is open.
 */
export function toDeferredFocusCandidate(
  resolve: () => HTMLElement | null,
): FocusCandidate {
  return {
    get isConnected() {
      return toFocusCandidate(resolve())?.isConnected ?? false;
    },
    get isDisabled() {
      return toFocusCandidate(resolve())?.isDisabled ?? true;
    },
    focus: () => {
      resolve()?.focus();
    },
  };
}
