/**
 * The unsaved preset draft of the Settings window, mirrored in the main window.
 *
 * A quit drops an unsaved preset draft, so the quit guard of the main window names it (ADR
 * 027). The draft lives in the page of the Settings window, and the quit guard runs in the
 * main window. The Settings window therefore reports the name of the draft, or null, each time
 * it changes (`reportSettingsWindowDraft`). It reports through `report_settings_draft`, and
 * Rust sends the event to the main window: the page holds no emit permission, because an emit
 * could send any event to the main window, such as the quit request. The main window keeps the
 * last report in `settingsWindowDraftStore`. Rust reports null when it destroys the Settings
 * window, so the mirror never names a draft of a window that is gone.
 */

import { useEffect } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  BACKEND_COMMANDS,
  BACKEND_EVENTS,
  invokeCommand,
  listenWindowEvent,
  startEventListener,
  type EventSubscribe,
  type InvokeFn,
} from "@/lib/ipc";
import { getCurrentWindowLabel, isForeignOrigin } from "@/lib/windowLabel";

/** The payload of `settings-window:draft`. */
export interface SettingsWindowDraftPayload {
  /**
   * The name that the prompts show for the draft, or null when no draft holds an unsaved
   * edit. The name can be empty, for a new preset with no name yet.
   */
  readonly name: string | null;
  /** The label of the window that sent the report. */
  readonly origin: string;
}

/** Reads a `settings-window:draft` payload, or returns null when it is malformed. */
export function validateSettingsWindowDraftPayload(
  value: unknown,
): SettingsWindowDraftPayload | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const { name, origin } = candidate;
  if (typeof origin !== "string" || origin.length === 0) {
    return null;
  }
  if (name !== null && typeof name !== "string") {
    return null;
  }
  return { name, origin };
}

/** What a report uses. A test passes a fake invoke. */
export interface SettingsWindowDraftReportOptions {
  /** Calls `report_settings_draft`. Defaults to the Tauri invoke. */
  readonly invoke?: InvokeFn;
}

/**
 * Sends the draft of the Settings window to the main window through Rust
 * (`report_settings_draft`), which adds the label of the Settings window as the origin. A
 * failed call, also outside the Tauri shell, leaves the quit guard with the last report, so a
 * quit can drop a draft without naming it, which is the cost of one lost report.
 */
export function reportSettingsWindowDraft(
  name: string | null,
  options: SettingsWindowDraftReportOptions = {},
): void {
  const invoke = options.invoke ?? invokeCommand;
  try {
    void invoke<unknown>(BACKEND_COMMANDS.REPORT_SETTINGS_DRAFT, { name }).catch(
      () => {},
    );
  } catch {
    // No Tauri runtime answered.
  }
}

/** The mirror in the main window. */
export interface SettingsWindowDraftState {
  /** The last name that the Settings window reported, or null. */
  readonly unsavedPresetName: string | null;
}

export function createSettingsWindowDraftStore(): StoreApi<SettingsWindowDraftState> {
  return createStore<SettingsWindowDraftState>()(() => ({ unsavedPresetName: null }));
}

/** The mirror of the application. The quit guard reads it. */
export const settingsWindowDraftStore = createSettingsWindowDraftStore();

/** What `startSettingsWindowDraftMirror` reads and writes. A test passes fakes. */
export interface SettingsWindowDraftMirrorOptions {
  /**
   * Subscribes to `settings-window:draft`. Defaults to the Tauri event of the current window,
   * which hears the reports that were sent to this window.
   */
  readonly subscribe?: EventSubscribe;
  /** The label of this window. Defaults to the label of the current Tauri window. */
  readonly ownLabel?: string | null;
  /** Defaults to `settingsWindowDraftStore`. */
  readonly store?: StoreApi<SettingsWindowDraftState>;
}

/**
 * Keeps the mirror equal to the last report of another window, and returns the function
 * that stops it. A malformed payload and a payload of this window change nothing.
 */
export function startSettingsWindowDraftMirror(
  options: SettingsWindowDraftMirrorOptions = {},
): () => void {
  const subscribe =
    options.subscribe ??
    ((handler) =>
      listenWindowEvent<unknown>(BACKEND_EVENTS.SETTINGS_WINDOW_DRAFT, handler));
  const ownLabel =
    options.ownLabel !== undefined ? options.ownLabel : getCurrentWindowLabel();
  const store = options.store ?? settingsWindowDraftStore;
  return startEventListener(subscribe, (raw) => {
    const payload = validateSettingsWindowDraftPayload(raw);
    if (payload !== null && isForeignOrigin(payload.origin, ownLabel)) {
      store.setState({ unsavedPresetName: payload.name });
    }
  });
}

/** Mounts `startSettingsWindowDraftMirror` for the life of the component. */
export function useSettingsWindowDraftMirror(): void {
  useEffect(() => startSettingsWindowDraftMirror(), []);
}
