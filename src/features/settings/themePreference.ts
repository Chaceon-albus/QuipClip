/**
 * The theme preference.
 *
 * The preference belongs to the application, not to a project, and it is not part of the
 * settings file. It lives in web view storage, next to the language preference (ADR 011),
 * so a damaged settings file does not change it. Every read and write is guarded: storage
 * can be missing or can throw, and an unknown stored value reads as the default.
 *
 * `public/theme-init.js` reads the same storage key before the first paint. A change to the
 * key or to the stored values must change that script too.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { PreferenceStorage } from "@/i18n/types";
import { isThemePreference, type ThemePreference } from "@/lib/theme";

/** The web view storage key of the preference. */
export const THEME_PREFERENCE_STORAGE_KEY = "quipclip.theme_preference";

/** The preference on a fresh install. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

/** Returns `window.localStorage`, or null when the web view does not give access to it. */
function getDefaultStorage(): PreferenceStorage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Storage access can throw in a sandboxed context.
  }
  return null;
}

/**
 * Reads the stored preference. A missing or unknown value, missing storage, or a storage
 * error reads as the default.
 *
 * @param storage The storage to read. Undefined reads `window.localStorage`; null reads
 *   nothing.
 */
export function readStoredThemePreference(
  storage?: PreferenceStorage | null,
): ThemePreference {
  const target = storage !== undefined ? storage : getDefaultStorage();
  if (!target) {
    return DEFAULT_THEME_PREFERENCE;
  }
  try {
    const raw = target.getItem(THEME_PREFERENCE_STORAGE_KEY);
    if (isThemePreference(raw)) {
      return raw;
    }
  } catch {
    // A read error keeps the default.
  }
  return DEFAULT_THEME_PREFERENCE;
}

/**
 * Writes the preference. A write error is ignored: the preference then lasts for the
 * session only.
 *
 * @param preference The preference to store.
 * @param storage The storage to write. Undefined writes `window.localStorage`; null writes
 *   nothing.
 */
export function writeStoredThemePreference(
  preference: ThemePreference,
  storage?: PreferenceStorage | null,
): void {
  const target = storage !== undefined ? storage : getDefaultStorage();
  if (!target) {
    return;
  }
  try {
    target.setItem(THEME_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // A write error keeps the in-memory value only.
  }
}

export interface ThemePreferenceState {
  /** The preference the user selected. */
  readonly preference: ThemePreference;
  /**
   * Stores the preference and applies it at once. A value that is not a preference is
   * ignored.
   */
  readonly setPreference: (preference: ThemePreference) => void;
}

export interface ThemePreferenceStoreOptions {
  /** The storage to read and write. Undefined uses `window.localStorage`. */
  storage?: PreferenceStorage | null;
}

/**
 * Creates a preference store. It reads the stored preference once, when it is created.
 */
export function createThemePreferenceStore(
  options?: ThemePreferenceStoreOptions,
): StoreApi<ThemePreferenceState> {
  const storage = options?.storage;
  return createStore<ThemePreferenceState>()((set, get) => ({
    preference: readStoredThemePreference(storage),
    setPreference: (preference: ThemePreference) => {
      if (!isThemePreference(preference)) {
        return;
      }
      writeStoredThemePreference(preference, storage);
      if (get().preference !== preference) {
        set({ preference });
      }
    },
  }));
}

/** The application's preference store. `main.tsx` connects it to the document root. */
export const themePreferenceStore = createThemePreferenceStore();

/** Subscribes a component to the application's preference store. */
export function useThemePreference<T>(selector: (state: ThemePreferenceState) => T): T {
  return useStore(themePreferenceStore, selector);
}
