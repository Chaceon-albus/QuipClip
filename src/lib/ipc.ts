/**
 * Tauri IPC abstraction and backend command constants.
 *
 * Centralizes backend command identifiers in one place to guarantee contract parity
 * and enables dependency injection of invoke implementations for testing.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Stable backend Tauri command names implemented in Rust.
 */
export const BACKEND_COMMANDS = {
  IMPORT_MEDIA: "import_media",
  READ_SOURCE_REVISION: "read_source_revision",
  START_CAPABILITY_PROBE: "start_capability_probe",
  LOAD_SETTINGS: "load_settings",
  SAVE_SETTINGS: "save_settings",
  RESTORE_DEFAULT_PRESETS: "restore_default_presets",
  RESET_SETTINGS: "reset_settings",
  START_EXPORT: "start_export",
  CANCEL_EXPORT: "cancel_export",
  CANCEL_ACTIVE_EXPORT: "cancel_active_export",
  REVEAL_EXPORT_OUTPUT: "reveal_export_output",
  CONFIRM_QUIT: "confirm_quit",
  SET_WINDOW_BORDER_THEME: "set_window_border_theme",
  OPEN_SETTINGS_WINDOW: "open_settings_window",
  TAKE_SETTINGS_WINDOW_REQUEST: "take_settings_window_request",
  CLOSE_SETTINGS_WINDOW: "close_settings_window",
  REPORT_SETTINGS_DRAFT: "report_settings_draft",
  BROADCAST_PREFERENCE: "broadcast_preference",
} as const;

export type BackendCommand = (typeof BACKEND_COMMANDS)[keyof typeof BACKEND_COMMANDS];

/**
 * Stable backend Tauri event names emitted from Rust.
 *
 * A Tauri listener of the frontend hears an event that Rust sends to every window, so a
 * payload that one window caused names that window in `origin`, and a receiver ignores its
 * own. No page emits an event itself: the Settings window holds no emit permission, because
 * an emit could send any event to any window, such as the quit request of ADR 027. A page that
 * must reach the other window calls a command, and Rust sends the event.
 */
export const BACKEND_EVENTS = {
  CAPABILITY_PROBE: "ffmpeg:capability-probe",
  /**
   * A forced capability probe, announced to every window with the label of the window that
   * forced it (`src/features/ffmpeg/events.ts`).
   */
  CAPABILITY_PROBE_FORCED: "ffmpeg:capability-probe-forced",
  /**
   * The settings document that a write stored, with the label of the window that asked for
   * the write (`src/features/settings/settingsSync.ts`).
   */
  SETTINGS_CHANGED: "settings:changed",
  EXPORT_PROGRESS: "export:progress",
  /** An application exit that Rust held back until the frontend decides (ADR 027). */
  QUIT_REQUESTED: "app:quit-requested",
  /**
   * A command item of the macOS application menu. The payload is the name of its action, such
   * as `"openMedia"` (`src/components/layout/nativeMenuActions.ts`).
   */
  MENU_ACTION: "app:menu-action",
  /**
   * Tells the Settings window to take the request that an opening stored. The payload is
   * empty (`src/features/settings/settingsWindowClient.ts`).
   */
  SETTINGS_WINDOW_NAVIGATE: "settings-window:navigate",
  /**
   * A preference that lives in web view storage changed in one window
   * (`src/features/settings/preferenceSync.ts`). Rust sends it for `broadcast_preference`.
   */
  PREFERENCES_CHANGED: "preferences:changed",
  /**
   * The name of the unsaved preset draft of the Settings window, or null, for the quit guard
   * of the main window (`src/features/settings/settingsWindowDraft.ts`). Rust sends it for
   * `report_settings_draft`, and with null when the Settings window is destroyed.
   */
  SETTINGS_WINDOW_DRAFT: "settings-window:draft",
} as const;

export type BackendEvent = (typeof BACKEND_EVENTS)[keyof typeof BACKEND_EVENTS];

/**
 * Signature for Tauri invoke-compatible functions.
 */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Type-safe invoke wrapper around `@tauri-apps/api/core` invoke.
 *
 * @param cmd The typed backend command identifier to execute.
 * @param args Optional arguments passed to the command.
 * @param invokeFn Optional custom invoke implementation (defaults to Tauri core invoke).
 * @returns The resolved result from the backend command.
 */
export async function invokeCommand<T>(
  cmd: BackendCommand,
  args?: Record<string, unknown>,
  invokeFn: InvokeFn = tauriInvoke,
): Promise<T> {
  return await invokeFn<T>(cmd, args);
}

/**
 * Function type returned by Tauri event listeners to unsubscribe.
 */
export type UnlistenFn = () => void;

/**
 * Signature for Tauri listen-compatible functions.
 */
export type ListenFn = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<UnlistenFn>;

/**
 * Type-safe event listener wrapper around `@tauri-apps/api/event` listen.
 *
 * @param event The typed backend event identifier to subscribe to.
 * @param handler Callback receiving the unwrapped payload when the event fires.
 * @param listenFn Optional custom listen implementation (defaults to Tauri event listen).
 * @returns Promise resolving to an unlisten function.
 */
export async function listenEvent<T>(
  event: BackendEvent,
  handler: (payload: T) => void,
  listenFn: ListenFn = tauriListen,
): Promise<UnlistenFn> {
  return await listenFn<T>(event, (eventObj) => handler(eventObj.payload));
}

/**
 * The listen function of the current window: it hears an event that Rust sent to this window
 * (`emit_to`) or to every window (`emit`), and not an event that was sent to another window.
 * `listen` hears every event of every window.
 *
 * It throws outside the Tauri shell, where the window has no metadata, as `listen` fails
 * there.
 */
export const listenInCurrentWindow: ListenFn = (event, handler) =>
  getCurrentWebviewWindow().listen(event, handler);

/**
 * Type-safe event listener for an event that is sent to one window. Use it for an event that
 * only this window may act on, such as the quit request of ADR 027, so that the other window
 * never acts on it as well.
 *
 * @param event The typed backend event identifier to subscribe to.
 * @param handler Callback receiving the unwrapped payload when the event fires.
 * @param listenFn Optional custom listen implementation (defaults to the current window).
 */
export async function listenWindowEvent<T>(
  event: BackendEvent,
  handler: (payload: T) => void,
  listenFn: ListenFn = listenInCurrentWindow,
): Promise<UnlistenFn> {
  return await listenEvent<T>(event, handler, listenFn);
}

/** Subscribes a handler to one event and resolves to its release. A test passes a fake. */
export type EventSubscribe = (
  handler: (payload: unknown) => void,
) => Promise<UnlistenFn>;

/**
 * Subscribes `onPayload` with `subscribe`, and returns the function that releases the
 * subscription, for an effect of a React component.
 *
 * The subscription resolves after this returns. React StrictMode runs the release once before
 * that in development, so a subscription that resolves late is released at once, and an event
 * that arrives after the release runs nothing. A refused subscription, and a `subscribe` that
 * throws because no Tauri runtime answers, leave nothing to release.
 *
 * `onReady` runs once, when the subscription is in place or could not be put in place, and
 * not after the release. A caller reads there the state that an event before that moment
 * would have announced, so no announcement falls between the read and the subscription.
 */
export function startEventListener(
  subscribe: EventSubscribe,
  onPayload: (payload: unknown) => void,
  onReady?: () => void,
): () => void {
  let released = false;
  let unlisten: UnlistenFn | null = null;
  const ready = () => {
    if (!released) {
      onReady?.();
    }
  };
  let subscription: Promise<UnlistenFn>;
  try {
    subscription = subscribe((payload) => {
      if (!released) {
        onPayload(payload);
      }
    });
  } catch {
    // The read still runs, after this returns, as it does for a subscription that resolves.
    void Promise.resolve().then(ready);
    return () => {
      released = true;
    };
  }
  subscription.then(
    (unlistenFn) => {
      if (released) {
        unlistenFn();
      } else {
        unlisten = unlistenFn;
        ready();
      }
    },
    () => {
      // Nothing is subscribed, so nothing is released.
      ready();
    },
  );
  return () => {
    released = true;
    const unlistenFn = unlisten;
    unlisten = null;
    unlistenFn?.();
  };
}
