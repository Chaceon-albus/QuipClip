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
