/**
 * Keeps the settings document of this window current while the other window writes it.
 *
 * The main window and the Settings window each hold a settings store. After every write that
 * reaches the disk, Rust sends the stored document to every window as `settings:changed`, with
 * the label of the window that asked for the write (`src-tauri/src/commands/settings.rs`). A
 * window that did not write it hands the document to `adoptExternal` of its store, which keeps
 * only a document newer than the one it holds. The window that wrote ignores the event: its
 * command result already carries the document, and the two arrive in no fixed order.
 *
 * Mount `useSettingsChangedSync` once in each window.
 */

import { useEffect } from "react";
import {
  BACKEND_EVENTS,
  listenEvent,
  startEventListener,
  type EventSubscribe,
} from "@/lib/ipc";
import { getCurrentWindowLabel, isForeignOrigin } from "@/lib/windowLabel";
import { settingsStore } from "./store";
import type { Settings } from "./types";
import { isSettings } from "./validation";

/** The payload of `settings:changed`. */
export interface SettingsChangedPayload {
  /** The document that reached the disk. */
  readonly settings: Settings;
  /** The label of the window that asked for the write. */
  readonly origin: string;
}

/**
 * Reads a `settings:changed` payload, or returns null when it does not hold a valid document
 * and a window label. The document goes through the validator of every command result, so a
 * malformed event can never reach the store.
 */
export function validateSettingsChangedPayload(
  value: unknown,
): SettingsChangedPayload | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.origin !== "string" ||
    candidate.origin.length === 0 ||
    !isSettings(candidate.settings)
  ) {
    return null;
  }
  return { settings: candidate.settings, origin: candidate.origin };
}

/** What `startSettingsChangedSync` reads and calls. A test passes fakes. */
export interface SettingsChangedSyncOptions {
  /** Subscribes to `settings:changed`. Defaults to the Tauri event. */
  readonly subscribe?: EventSubscribe;
  /** The label of this window. Defaults to the label of the current Tauri window. */
  readonly ownLabel?: string | null;
  /** Takes a foreign document. Defaults to `adoptExternal` of the settings store. */
  readonly adopt?: (settings: Settings) => void;
}

/**
 * Hands each valid `settings:changed` document of another window to `adopt`, and returns the
 * function that stops it. A payload that fails validation, and a payload of this window, do
 * nothing.
 */
export function startSettingsChangedSync(
  options: SettingsChangedSyncOptions = {},
): () => void {
  const subscribe =
    options.subscribe ??
    ((handler) => listenEvent<unknown>(BACKEND_EVENTS.SETTINGS_CHANGED, handler));
  const ownLabel =
    options.ownLabel !== undefined ? options.ownLabel : getCurrentWindowLabel();
  const adopt =
    options.adopt ??
    ((settings: Settings) => {
      settingsStore.getState().adoptExternal(settings);
    });
  return startEventListener(subscribe, (raw) => {
    const payload = validateSettingsChangedPayload(raw);
    if (payload !== null && isForeignOrigin(payload.origin, ownLabel)) {
      adopt(payload.settings);
    }
  });
}

/** Mounts `startSettingsChangedSync` for the life of the component. */
export function useSettingsChangedSync(): void {
  useEffect(() => startSettingsChangedSync(), []);
}
