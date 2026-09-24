/**
 * The narrow view of an element that the focus rules read, and the one adapter that wraps a
 * DOM element for them.
 *
 * The rules of the settings prompts and of the export dialog decide which element takes the
 * focus. They read elements only through `PromptFocusTarget`, so their tests need no document.
 */

/** The narrow view of an element that the focus rules read, so a test can pass a fake. */
export interface PromptFocusTarget {
  /** False after the element left the document. */
  readonly isConnected: boolean;
  /**
   * False while the element is not rendered. The settings panels are force-mounted, and an
   * inactive panel is `display: none`, so a control in another tab is connected but cannot
   * take the focus.
   */
  readonly isRendered: boolean;
  /** True while the element cannot take the focus, such as a disabled button. */
  readonly isDisabled: boolean;
  focus: () => void;
}

/** The members of a DOM element that `isElementRendered` reads. */
export interface RenderedElementProbe {
  checkVisibility?: () => boolean;
  readonly offsetParent: unknown;
}

/**
 * True when the element is rendered. `checkVisibility` answers directly where the web view
 * has it. An older web view falls back to `offsetParent`, which is null for an element inside
 * a `display: none` subtree. It is also null for a `position: fixed` element, such as a dialog
 * itself, so a caller does not pass one.
 */
export function isElementRendered(element: RenderedElementProbe): boolean {
  return element.checkVisibility?.() ?? element.offsetParent !== null;
}

/**
 * Wraps a DOM element for the focus rules, or returns null for no element. The members are
 * getters, because the rules read the element when the focus moves, not when it is wrapped.
 */
export function toPromptFocusTarget(
  element: HTMLElement | null,
): PromptFocusTarget | null {
  if (element === null) {
    return null;
  }
  return {
    get isConnected() {
      return element.isConnected;
    },
    get isRendered() {
      return isElementRendered(element);
    },
    get isDisabled() {
      return element.matches(":disabled");
    },
    focus: () => {
      element.focus();
    },
  };
}

/** True when the target is in the document, rendered, and enabled. */
export function canTakeFocus<T extends PromptFocusTarget>(
  target: T | null,
): target is T {
  return (
    target !== null && target.isConnected && target.isRendered && !target.isDisabled
  );
}

/**
 * Selector for a dialog or an alert dialog that is open. Radix keeps a closed dialog mounted
 * while its exit animation runs, with `data-state="closed"`, and that dialog does not count.
 */
export const OPEN_DIALOG_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]),[role="alertdialog"]:not([data-state="closed"])';

/** The member of a DOM element that `isInOpenDialog` reads. `Element` satisfies it. */
export interface DialogAncestorProbe {
  closest: (selector: string) => unknown;
}

/**
 * True when `element` is inside a dialog that is open (`OPEN_DIALOG_SELECTOR`).
 *
 * A dialog that closes gives the focus back to its opener when its content unmounts. When
 * another dialog opened meanwhile and took the focus, that dialog keeps it. The settings
 * dialog and the export dialog read this rule, because the export dialog opens again as the
 * settings dialog closes (`exportSettingsReturn.ts`). Without it, the closing dialog moves the
 * focus out of the open dialog, and the focus trap of the open dialog pulls it back.
 */
export function isInOpenDialog(element: DialogAncestorProbe | null): boolean {
  return element !== null && element.closest(OPEN_DIALOG_SELECTOR) !== null;
}
