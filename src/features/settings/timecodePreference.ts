/**
 * The timecode format preference (ADR 028).
 *
 * The preference belongs to the application, not to a project, and it is not part of the
 * settings file. It lives in web view storage, next to the language preference (ADR 011),
 * so a damaged settings file does not change it. Every read and write is guarded: storage
 * can be missing or can throw, and an unknown stored value reads as the default.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { PreferenceStorage } from "@/i18n/types";
import { TIMECODE_FORMATS, type TimecodeFormat } from "@/lib/timecode";

/** The web view storage key of the preference. */
export const TIMECODE_FORMAT_STORAGE_KEY = "quipclip.timecode_format";

/** The format on a fresh install. */
export const DEFAULT_TIMECODE_FORMAT: TimecodeFormat = "frames";

/** Type guard for a format that arrives as a plain string, such as a Select value. */
export function isTimecodeFormat(value: unknown): value is TimecodeFormat {
  return (
    typeof value === "string" && (TIMECODE_FORMATS as readonly string[]).includes(value)
  );
}

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
 * Reads the stored format. A missing or unknown value, missing storage, or a storage error
 * reads as the default.
 *
 * @param storage The storage to read. Undefined reads `window.localStorage`; null reads
 *   nothing.
 */
export function readStoredTimecodeFormat(
  storage?: PreferenceStorage | null,
): TimecodeFormat {
  const target = storage !== undefined ? storage : getDefaultStorage();
  if (!target) {
    return DEFAULT_TIMECODE_FORMAT;
  }
  try {
    const raw = target.getItem(TIMECODE_FORMAT_STORAGE_KEY);
    if (isTimecodeFormat(raw)) {
      return raw;
    }
  } catch {
    // A read error keeps the default.
  }
  return DEFAULT_TIMECODE_FORMAT;
}

/**
 * Writes the format. A write error is ignored: the preference then lasts for the session
 * only.
 *
 * @param format The format to store.
 * @param storage The storage to write. Undefined writes `window.localStorage`; null writes
 *   nothing.
 */
export function writeStoredTimecodeFormat(
  format: TimecodeFormat,
  storage?: PreferenceStorage | null,
): void {
  const target = storage !== undefined ? storage : getDefaultStorage();
  if (!target) {
    return;
  }
  try {
    target.setItem(TIMECODE_FORMAT_STORAGE_KEY, format);
  } catch {
    // A write error keeps the in-memory value only.
  }
}

export interface TimecodePreferenceState {
  /** The format the user selected. */
  readonly format: TimecodeFormat;
  /**
   * Stores the format and applies it at once. A value that is not a format is ignored.
   */
  readonly setFormat: (format: TimecodeFormat) => void;
}

export interface TimecodePreferenceStoreOptions {
  /** The storage to read and write. Undefined uses `window.localStorage`. */
  storage?: PreferenceStorage | null;
}

/**
 * Creates a preference store. It reads the stored format once, when it is created.
 */
export function createTimecodePreferenceStore(
  options?: TimecodePreferenceStoreOptions,
): StoreApi<TimecodePreferenceState> {
  const storage = options?.storage;
  return createStore<TimecodePreferenceState>()((set, get) => ({
    format: readStoredTimecodeFormat(storage),
    setFormat: (format: TimecodeFormat) => {
      if (!isTimecodeFormat(format)) {
        return;
      }
      writeStoredTimecodeFormat(format, storage);
      if (get().format !== format) {
        set({ format });
      }
    },
  }));
}

/** The application's preference store. */
export const timecodePreferenceStore = createTimecodePreferenceStore();

/** Subscribes a component to the application's preference store. */
export function useTimecodePreference<T>(
  selector: (state: TimecodePreferenceState) => T,
): T {
  return useStore(timecodePreferenceStore, selector);
}
