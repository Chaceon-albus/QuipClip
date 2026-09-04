/**
 * Typed IPC client for application settings and presets operations.
 *
 * Implements wire contract for settings commands matching Rust signatures (ADR 011, ADR 013).
 */

import { BACKEND_COMMANDS, invokeCommand, type BackendCommand } from "@/lib/ipc";
import type { LoadSettingsResult, Settings } from "./types";
import {
  normalizeSettingsError,
  validateLoadSettingsResult,
  validateSettings,
} from "./validation";

/**
 * Options for configuring settings client operations.
 */
export interface SettingsClientOptions {
  /**
   * Optional custom invoke function (useful for dependency injection in tests).
   */
  invoke?: <T>(cmd: BackendCommand, args?: Record<string, unknown>) => Promise<T>;
}

/**
 * Invokes the backend `load_settings` command.
 *
 * Validates the response payload on success and normalizes any rejection into a `SettingsError`.
 *
 * @param options Optional client configuration containing custom invoke.
 * @returns The validated LoadSettingsResult.
 * @throws SettingsError if the backend rejects or returns malformed data.
 */
export async function loadSettings(
  options: SettingsClientOptions = {},
): Promise<LoadSettingsResult> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.LOAD_SETTINGS);
    return validateLoadSettingsResult(rawResult);
  } catch (error) {
    throw normalizeSettingsError(error);
  }
}

/**
 * Invokes the backend `save_settings` command with `{ settings }`.
 *
 * Validates the response payload on success and normalizes any rejection into a `SettingsError`.
 *
 * @param settings The full settings document to persist.
 * @param options Optional client configuration containing custom invoke.
 * @returns The validated Settings document returned from disk.
 * @throws SettingsError if the backend rejects or returns malformed data.
 */
export async function saveSettings(
  settings: Settings,
  options: SettingsClientOptions = {},
): Promise<Settings> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.SAVE_SETTINGS, {
      settings,
    });
    return validateSettings(rawResult);
  } catch (error) {
    throw normalizeSettingsError(error);
  }
}

/**
 * Invokes the backend `restore_default_presets` command.
 *
 * Validates the response payload on success and normalizes any rejection into a `SettingsError`.
 *
 * @param options Optional client configuration containing custom invoke.
 * @returns The validated Settings document returned from disk.
 * @throws SettingsError if the backend rejects or returns malformed data.
 */
export async function restoreDefaultPresets(
  options: SettingsClientOptions = {},
): Promise<Settings> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.RESTORE_DEFAULT_PRESETS);
    return validateSettings(rawResult);
  } catch (error) {
    throw normalizeSettingsError(error);
  }
}

/**
 * Invokes the backend `reset_settings` command.
 *
 * Validates the response payload on success and normalizes any rejection into a `SettingsError`.
 *
 * @param options Optional client configuration containing custom invoke.
 * @returns The validated Settings document returned from disk.
 * @throws SettingsError if the backend rejects or returns malformed data.
 */
export async function resetSettings(
  options: SettingsClientOptions = {},
): Promise<Settings> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.RESET_SETTINGS);
    return validateSettings(rawResult);
  } catch (error) {
    throw normalizeSettingsError(error);
  }
}
