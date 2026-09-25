/**
 * The inactive state of the window on the document root.
 *
 * While the native window does not have the focus, <html> carries `data-window-inactive`. The
 * `window-inactive:` variant of `globals.css` reads it, so the title bar and the status bar go
 * one step quieter, as the chrome of a native window does.
 *
 * The focus state comes from the one focus listener of the window, in `startWindowStateSync`.
 * `useWindowState` writes it here, so no second listener exists.
 *
 * The module has no React dependency. The root is a parameter, so the tests need no document.
 */

/** The attribute on the document root that the `window-inactive:` variant reads. */
export const WINDOW_INACTIVE_ATTRIBUTE = "data-window-inactive";

/** The part of the document root that the attribute writes. `document.documentElement` has it. */
export interface WindowFocusRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Writes the focus state of the window on the root: the attribute is present while the window
 * does not have the focus, and absent while it has it. A null root does nothing.
 */
export function applyWindowFocus(root: WindowFocusRoot | null, focused: boolean): void {
  if (!root) {
    return;
  }
  if (focused) {
    root.removeAttribute(WINDOW_INACTIVE_ATTRIBUTE);
  } else {
    root.setAttribute(WINDOW_INACTIVE_ATTRIBUTE, "");
  }
}

/** Returns `document.documentElement`, or null outside a document. */
export function getWindowFocusRoot(): WindowFocusRoot | null {
  if (typeof document !== "undefined" && document.documentElement) {
    return document.documentElement;
  }
  return null;
}
