/**
 * Carries the preferences that live in web view storage from one window to the other.
 *
 * The theme, the interface language and the timecode format are not part of the settings
 * file. Each window reads them from web view storage once, when it loads, and the General tab
 * of the Settings window changes them. Storage is shared, but no window hears a write of
 * another, so the setter of each preference also emits `preferences:changed` with the new
 * value and the label of its window. The other window applies the value that the event
 * carries. It does not read storage again, because a read there can still return the old
 * value, and it does not emit again, so one change makes one event.
 *
 * The preview mute and the timeline height belong to the main window alone and are not sent.
 *
 * Mount `usePreferenceSync` once in each window.
 */

import { useEffect } from "react";
import {
  LANGUAGE_PREFERENCES,
  setLanguagePreference,
  type LanguagePreference,
} from "@/i18n";
import {
  WINDOW_EVENTS,
  emitEvent,
  listenEvent,
  startEventListener,
  type EmitFn,
  type EventSubscribe,
} from "@/lib/ipc";
import { isThemePreference, type ThemePreference } from "@/lib/theme";
import type { TimecodeFormat } from "@/lib/timecode";
import { getCurrentWindowLabel, isForeignOrigin } from "@/lib/windowLabel";
import { themePreferenceStore } from "./themePreference";
import { isTimecodeFormat, timecodePreferenceStore } from "./timecodePreference";

/** One preference and its new value. */
export type PreferenceChange =
  | { readonly key: "theme"; readonly value: ThemePreference }
  | { readonly key: "language"; readonly value: LanguagePreference }
  | { readonly key: "timecodeFormat"; readonly value: TimecodeFormat };

/** The payload of `preferences:changed`. */
export type PreferenceChangedPayload = PreferenceChange & {
  /** The label of the window that changed the preference. */
  readonly origin: string;
};

function isLanguagePreferenceValue(value: unknown): value is LanguagePreference {
  return (
    typeof value === "string" &&
    (LANGUAGE_PREFERENCES as readonly string[]).includes(value)
  );
}

/**
 * Reads a `preferences:changed` payload, or returns null when it names no known preference, a
 * value that preference does not take, or no window.
 */
export function validatePreferenceChangedPayload(
  value: unknown,
): PreferenceChangedPayload | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const origin = candidate.origin;
  if (typeof origin !== "string" || origin.length === 0) {
    return null;
  }
  const raw = candidate.value;
  switch (candidate.key) {
    case "theme":
      return isThemePreference(raw) ? { key: "theme", value: raw, origin } : null;
    case "language":
      return isLanguagePreferenceValue(raw)
        ? { key: "language", value: raw, origin }
        : null;
    case "timecodeFormat":
      return isTimecodeFormat(raw)
        ? { key: "timecodeFormat", value: raw, origin }
        : null;
    default:
      return null;
  }
}

/** What a broadcast uses. A test passes fakes. */
export interface PreferenceBroadcastOptions {
  /** Emits the event. Defaults to the Tauri event. */
  readonly emit?: EmitFn;
  /** The label of this window. Defaults to the label of the current Tauri window. */
  readonly ownLabel?: string | null;
}

/**
 * Sends a change to the other windows. Outside the Tauri shell there is no other window and
 * no label, so it sends nothing. A failed emit leaves the other window on its old value until
 * it loads again, which is the state before this module existed, so the failure is ignored.
 */
export function broadcastPreferenceChange(
  change: PreferenceChange,
  options: PreferenceBroadcastOptions = {},
): void {
  const origin =
    options.ownLabel !== undefined ? options.ownLabel : getCurrentWindowLabel();
  if (origin === null) {
    return;
  }
  const payload: PreferenceChangedPayload = { ...change, origin };
  try {
    void emitEvent(WINDOW_EVENTS.PREFERENCES_CHANGED, payload, options.emit).catch(
      () => {},
    );
  } catch {
    // No Tauri runtime answered.
  }
}

/** Stores the theme, applies it in this window, and sends it to the other windows. */
export function changeThemePreference(
  preference: ThemePreference,
  options?: PreferenceBroadcastOptions,
): void {
  if (!isThemePreference(preference)) {
    return;
  }
  themePreferenceStore.getState().setPreference(preference);
  broadcastPreferenceChange({ key: "theme", value: preference }, options);
}

/** Stores the timecode format, applies it in this window, and sends it to the other windows. */
export function changeTimecodeFormat(
  format: TimecodeFormat,
  options?: PreferenceBroadcastOptions,
): void {
  if (!isTimecodeFormat(format)) {
    return;
  }
  timecodePreferenceStore.getState().setFormat(format);
  broadcastPreferenceChange({ key: "timecodeFormat", value: format }, options);
}

/**
 * Sends a language preference to the other windows. The language control stores and applies
 * it in this window first (`languageMenuController.ts`), and calls this only when that
 * succeeded.
 */
export function broadcastLanguagePreference(
  preference: LanguagePreference,
  options?: PreferenceBroadcastOptions,
): void {
  broadcastPreferenceChange({ key: "language", value: preference }, options);
}

/** How a window applies a change of another window. A test passes fakes. */
export interface PreferenceTargets {
  readonly applyTheme: (preference: ThemePreference) => void;
  readonly applyLanguage: (preference: LanguagePreference) => void;
  readonly applyTimecodeFormat: (format: TimecodeFormat) => void;
}

/**
 * The targets of the application: the two preference stores, and the default i18next
 * instance. None of them writes storage or emits.
 */
export const APPLICATION_PREFERENCE_TARGETS: PreferenceTargets = {
  applyTheme: (preference) => {
    themePreferenceStore.getState().adoptPreference(preference);
  },
  applyLanguage: (preference) => {
    // `storage: null` changes the language and writes nothing.
    setLanguagePreference(preference, { storage: null }).catch((error: unknown) => {
      console.error("Failed to apply the language of another window:", error);
    });
  },
  applyTimecodeFormat: (format) => {
    timecodePreferenceStore.getState().adoptFormat(format);
  },
};

/** Applies one change through `targets`. */
export function applyPreferenceChange(
  change: PreferenceChange,
  targets: PreferenceTargets,
): void {
  switch (change.key) {
    case "theme":
      targets.applyTheme(change.value);
      return;
    case "language":
      targets.applyLanguage(change.value);
      return;
    case "timecodeFormat":
      targets.applyTimecodeFormat(change.value);
      return;
  }
}

/** What `startPreferenceSync` reads and calls. A test passes fakes. */
export interface PreferenceSyncOptions {
  /** Subscribes to `preferences:changed`. Defaults to the Tauri event. */
  readonly subscribe?: EventSubscribe;
  /** The label of this window. Defaults to the label of the current Tauri window. */
  readonly ownLabel?: string | null;
  /** Defaults to `APPLICATION_PREFERENCE_TARGETS`. */
  readonly targets?: PreferenceTargets;
}

/**
 * Applies each valid change of another window, and returns the function that stops it. A
 * payload that fails validation, and a payload of this window, do nothing.
 */
export function startPreferenceSync(options: PreferenceSyncOptions = {}): () => void {
  const subscribe =
    options.subscribe ??
    ((handler) => listenEvent<unknown>(WINDOW_EVENTS.PREFERENCES_CHANGED, handler));
  const ownLabel =
    options.ownLabel !== undefined ? options.ownLabel : getCurrentWindowLabel();
  const targets = options.targets ?? APPLICATION_PREFERENCE_TARGETS;
  return startEventListener(subscribe, (raw) => {
    const payload = validatePreferenceChangedPayload(raw);
    if (payload !== null && isForeignOrigin(payload.origin, ownLabel)) {
      applyPreferenceChange(payload, targets);
    }
  });
}

/** Mounts `startPreferenceSync` for the life of the component. */
export function usePreferenceSync(): void {
  useEffect(() => startPreferenceSync(), []);
}
