/**
 * Tauri IPC abstraction and backend command constants.
 *
 * Centralizes backend command identifiers in one place to guarantee contract parity
 * and enables dependency injection of invoke implementations for testing.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/**
 * Stable backend Tauri command names implemented in Rust.
 */
export const BACKEND_COMMANDS = {
  IMPORT_MEDIA: "import_media",
} as const;

export type BackendCommand = (typeof BACKEND_COMMANDS)[keyof typeof BACKEND_COMMANDS];

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
