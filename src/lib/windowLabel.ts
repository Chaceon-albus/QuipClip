/**
 * The label of the Tauri window that runs this page.
 *
 * The main window and the Settings window load the same page. An event that one window emits
 * reaches the listeners of every window, its own included, so each cross-window payload names
 * the window that sent it, and a receiver compares that name with its own label.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";

/** The label of the main window, as `src-tauri/src/lib.rs` names it. */
export const MAIN_WINDOW_LABEL = "main";

/** The label of the Settings window, as `src-tauri/src/commands/settings_window.rs` names it. */
export const SETTINGS_WINDOW_LABEL = "settings";

/**
 * Returns the label of the current window, or null outside the Tauri shell, for example in a
 * plain browser or a test, where no window metadata exists.
 */
export function getCurrentWindowLabel(): string | null {
  try {
    const label = getCurrentWindow().label;
    return typeof label === "string" && label.length > 0 ? label : null;
  } catch {
    return null;
  }
}

/**
 * True when a payload with this `origin` came from another window. With no label of its own,
 * the page cannot tell, and it treats every payload as foreign: outside the Tauri shell no
 * window sends one.
 */
export function isForeignOrigin(origin: string, ownLabel: string | null): boolean {
  return ownLabel === null || origin !== ownLabel;
}
