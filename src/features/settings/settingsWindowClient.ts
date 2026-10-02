/**
 * The Settings window, from the side of the controls that open it and from the side of its
 * page.
 *
 * Settings is a window of its own (`src-tauri/src/commands/settings_window.rs`). A control
 * opens it with `openSettingsWindow`, optionally on a tab and on a preset of the Presets tab.
 * Rust stores that request and opens the window, or brings the open one forward and sends it
 * `settings-window:navigate`. The page takes the request when it mounts and on each of those
 * events (`startSettingsWindowRequestListener`), so a request is never lost while the page
 * loads.
 */

import {
  BACKEND_COMMANDS,
  BACKEND_EVENTS,
  invokeCommand,
  listenWindowEvent,
  startEventListener,
  type EventSubscribe,
  type InvokeFn,
} from "@/lib/ipc";
import { isSettingsSection, type SettingsSection } from "./panelStore";

/** What the Settings window shows when it takes a request. */
export interface SettingsWindowRequest {
  /** The tab, or null to keep the tab that shows. */
  readonly section: SettingsSection | null;
  /** The preset that the Presets tab selects, or null to keep the selection. */
  readonly presetId: string | null;
}

/** Options for the commands of the Settings window. A test passes a fake invoke. */
export interface SettingsWindowClientOptions {
  readonly invoke?: InvokeFn;
}

/**
 * Opens the Settings window, or brings it forward, on `section` and with `presetId` selected
 * on the Presets tab. Each value is optional. Resolves false when the window did not open;
 * the opening has no message of its own to show, so the failure goes to the console.
 */
export async function openSettingsWindow(
  section: SettingsSection | null = null,
  presetId: string | null = null,
  options: SettingsWindowClientOptions = {},
): Promise<boolean> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    await invoke<unknown>(BACKEND_COMMANDS.OPEN_SETTINGS_WINDOW, { section, presetId });
    return true;
  } catch (error) {
    console.error("Failed to open the Settings window:", error);
    return false;
  }
}

/**
 * Reads the result of `take_settings_window_request`: null, or a request whose fields are a
 * known tab or null, and a preset id or null. Anything else reads as no request.
 */
export function validateSettingsWindowRequest(
  value: unknown,
): SettingsWindowRequest | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const section = candidate.section;
  const presetId = candidate.presetId;
  if (section !== null && !isSettingsSection(section)) {
    return null;
  }
  if (presetId !== null && (typeof presetId !== "string" || presetId.length === 0)) {
    return null;
  }
  return { section, presetId };
}

/**
 * Takes the pending request of the Settings window, or resolves null when there is none or
 * when the command failed. Rust clears the request, so each request applies once.
 */
export async function takeSettingsWindowRequest(
  options: SettingsWindowClientOptions = {},
): Promise<SettingsWindowRequest | null> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    return validateSettingsWindowRequest(
      await invoke<unknown>(BACKEND_COMMANDS.TAKE_SETTINGS_WINDOW_REQUEST),
    );
  } catch {
    return null;
  }
}

/**
 * Closes the Settings window that calls it, with no close request (`close_settings_window`).
 * Rust closes only the calling window, and only when it is the Settings window. A failure goes
 * to the console: the window stays open, and the user can close it again.
 */
export async function closeSettingsWindow(
  options: SettingsWindowClientOptions = {},
): Promise<boolean> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    await invoke<unknown>(BACKEND_COMMANDS.CLOSE_SETTINGS_WINDOW);
    return true;
  } catch (error) {
    console.error("Failed to close the Settings window:", error);
    return false;
  }
}

/** What `startSettingsWindowRequestListener` reads and calls. A test passes fakes. */
export interface SettingsWindowRequestListenerOptions {
  /** Receives each request, in the order the page took them. */
  readonly onRequest: (request: SettingsWindowRequest) => void;
  /**
   * Subscribes to `settings-window:navigate`. Defaults to the Tauri event of the current
   * window, which Rust sends to the Settings window alone.
   */
  readonly subscribe?: EventSubscribe;
  /** Takes the pending request. Defaults to `takeSettingsWindowRequest`. */
  readonly take?: () => Promise<SettingsWindowRequest | null>;
}

/**
 * Takes the pending request once the navigate listener is in place, and again on each
 * navigate event, and returns the function that stops it. The first take reads a request
 * that Rust stored before the page listened. A request that arrives after the stop is not
 * applied.
 */
export function startSettingsWindowRequestListener({
  onRequest,
  subscribe = (handler) =>
    listenWindowEvent<unknown>(BACKEND_EVENTS.SETTINGS_WINDOW_NAVIGATE, handler),
  take = () => takeSettingsWindowRequest(),
}: SettingsWindowRequestListenerOptions): () => void {
  let active = true;
  const pull = () => {
    take().then(
      (request) => {
        if (active && request !== null) {
          onRequest(request);
        }
      },
      () => {
        // A take that failed loses one request. The user can open Settings again.
      },
    );
  };
  const release = startEventListener(subscribe, pull, pull);
  return () => {
    active = false;
    release();
  };
}
