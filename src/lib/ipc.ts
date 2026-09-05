/**
 * Tauri IPC abstraction and backend command constants.
 *
 * Centralizes backend command identifiers in one place to guarantee contract parity
 * and enables dependency injection of invoke implementations for testing.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

/**
 * Stable backend Tauri command names implemented in Rust.
 */
export const BACKEND_COMMANDS = {
  IMPORT_MEDIA: "import_media",
  START_CAPABILITY_PROBE: "start_capability_probe",
  LOAD_SETTINGS: "load_settings",
  SAVE_SETTINGS: "save_settings",
  RESTORE_DEFAULT_PRESETS: "restore_default_presets",
  RESET_SETTINGS: "reset_settings",
  START_EXPORT: "start_export",
  CANCEL_EXPORT: "cancel_export",
} as const;

export type BackendCommand = (typeof BACKEND_COMMANDS)[keyof typeof BACKEND_COMMANDS];

/**
 * Stable backend Tauri event names emitted from Rust.
 */
export const BACKEND_EVENTS = {
  CAPABILITY_PROBE: "ffmpeg:capability-probe",
  EXPORT_PROGRESS: "export:progress",
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
