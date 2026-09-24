/**
 * The preview mute preference.
 *
 * While it is on, the preview `<video>` element and the hidden element of the frame step cue
 * (ADR 019) make no sound. It changes only what the user hears: both elements still seek,
 * play and report their events, so the timing, the calibration and the cue bookkeeping do not
 * change. The export is not affected.
 *
 * The preference belongs to the application, not to a project, and it is not part of the
 * settings file. It lives in web view storage, next to the language preference (ADR 011),
 * so a damaged settings file does not change it. Every read and write is guarded: storage
 * can be missing or can throw, and an unknown stored value reads as the default.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { PreferenceStorage } from "@/i18n/types";

/** The web view storage key of the preference. */
export const PREVIEW_MUTED_STORAGE_KEY = "quipclip.preview_muted";

/** The preference on a fresh install: the preview makes sound. */
export const DEFAULT_PREVIEW_MUTED = false;

/** The stored text of each value. Any other text reads as the default. */
const STORED_MUTED = "true";
const STORED_UNMUTED = "false";

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
export function readStoredPreviewMuted(storage?: PreferenceStorage | null): boolean {
  const target = storage !== undefined ? storage : getDefaultStorage();
  if (!target) {
    return DEFAULT_PREVIEW_MUTED;
  }
  try {
    const raw = target.getItem(PREVIEW_MUTED_STORAGE_KEY);
    if (raw === STORED_MUTED) {
      return true;
    }
    if (raw === STORED_UNMUTED) {
      return false;
    }
  } catch {
    // A read error keeps the default.
  }
  return DEFAULT_PREVIEW_MUTED;
}

/**
 * Writes the preference. A write error is ignored: the preference then lasts for the
 * session only.
 *
 * @param muted The preference to store.
 * @param storage The storage to write. Undefined writes `window.localStorage`; null writes
 *   nothing.
 */
export function writeStoredPreviewMuted(
  muted: boolean,
  storage?: PreferenceStorage | null,
): void {
  const target = storage !== undefined ? storage : getDefaultStorage();
  if (!target) {
    return;
  }
  try {
    target.setItem(PREVIEW_MUTED_STORAGE_KEY, muted ? STORED_MUTED : STORED_UNMUTED);
  } catch {
    // A write error keeps the in-memory value only.
  }
}

export interface PreviewMutePreferenceState {
  /** True while the preview and the frame step cue make no sound. */
  readonly muted: boolean;
  /** Stores the preference and applies it at once. A value that is not a boolean is ignored. */
  readonly setMuted: (muted: boolean) => void;
  /** Stores and applies the opposite of the current preference. */
  readonly toggleMuted: () => void;
}

export interface PreviewMutePreferenceStoreOptions {
  /** The storage to read and write. Undefined uses `window.localStorage`. */
  storage?: PreferenceStorage | null;
}

/**
 * Creates a preference store. It reads the stored preference once, when it is created, so
 * the first render of the preview already carries it and the elements are muted before
 * the first play.
 */
export function createPreviewMutePreferenceStore(
  options?: PreviewMutePreferenceStoreOptions,
): StoreApi<PreviewMutePreferenceState> {
  const storage = options?.storage;
  return createStore<PreviewMutePreferenceState>()((set, get) => {
    const setMuted = (muted: boolean): void => {
      if (typeof muted !== "boolean") {
        return;
      }
      writeStoredPreviewMuted(muted, storage);
      if (get().muted !== muted) {
        set({ muted });
      }
    };
    return {
      muted: readStoredPreviewMuted(storage),
      setMuted,
      toggleMuted: () => {
        setMuted(!get().muted);
      },
    };
  });
}

/** The application's preference store. */
export const previewMutePreferenceStore = createPreviewMutePreferenceStore();

/** Subscribes a component to the application's preference store. */
export function usePreviewMutePreference<T>(
  selector: (state: PreviewMutePreferenceState) => T,
): T {
  return useStore(previewMutePreferenceStore, selector);
}
