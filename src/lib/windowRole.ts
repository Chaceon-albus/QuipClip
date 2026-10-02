/**
 * Which view this page renders.
 *
 * The main window and the Settings window load the same page from the same entry chunk (ADR
 * 032). `main.tsx` reads the role once, before the first render, and renders the editor or the
 * Settings view.
 */

import { SETTINGS_WINDOW_LABEL, getCurrentWindowLabel } from "./windowLabel";

/** The view of one window. */
export type WindowRole = "main" | "settings";

/**
 * The role of a window label. Only the label of the Settings window gives the Settings view.
 * Every other label, and no label at all, gives the editor: a page outside the Tauri shell, a
 * development server in a browser, and a later window with a label of its own all open the
 * view that existed before this one.
 */
export function resolveWindowRole(label: string | null): WindowRole {
  return label === SETTINGS_WINDOW_LABEL ? "settings" : "main";
}

/** The role of the window that runs this page. */
export function getCurrentWindowRole(): WindowRole {
  return resolveWindowRole(getCurrentWindowLabel());
}

/**
 * The attribute on <html> that names the role of the window. A CSS rule that differs by window
 * reads it, such as the height of the title bar that the page draws (`globals.css`).
 */
export const WINDOW_ROLE_ATTRIBUTE = "data-window-role";

/** The part of the document root that the role attribute writes. */
export interface WindowRoleRoot {
  setAttribute(name: string, value: string): void;
}

/**
 * Writes the role of the window on the document root. `main.tsx` calls it before the first
 * render, so no dialog draws with the layout of the other window.
 *
 * @param role The role of the window.
 * @param root The document root. Undefined uses `document.documentElement`; null does nothing.
 */
export function applyWindowRoleAttribute(
  role: WindowRole,
  root?: WindowRoleRoot | null,
): void {
  const target =
    root !== undefined
      ? root
      : typeof document !== "undefined"
        ? document.documentElement
        : null;
  target?.setAttribute(WINDOW_ROLE_ATTRIBUTE, role);
}
