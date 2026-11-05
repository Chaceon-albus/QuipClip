/**
 * The preview mute and volume preference.
 *
 * While mute is on, the preview `<video>` element and the hidden element of the frame step cue
 * (ADR 019) make no sound. The volume sets the level of both elements and of the Web Audio cue
 * of a MediaSource source (ADR 046). Neither changes more than what the user hears: both
 * elements still seek, play and report their events, so the timing, the calibration and the cue
 * bookkeeping do not change. The export is not affected.
 *
 * Mute and the volume are two values. Mute keeps the volume, so a second press of the toggle
 * gives back the level from before. The preview is silent while mute is on or while the volume
 * is 0 (`isPreviewSilent`), and the toggle shows that state. A change of the volume to a level
 * above 0 turns mute off, because the user moves the level to hear it. A press of the toggle
 * that ends the silence at a volume of 0 also sets the default volume, so that press always
 * gives sound.
 *
 * The preference belongs to the application, not to a project, and it is not part of the
 * settings file. It lives in web view storage, next to the language preference (ADR 011),
 * so a damaged settings file does not change it. Every read and write is guarded: storage
 * can be missing or can throw, and an unknown stored value reads as the default.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { PreferenceStorage } from "@/i18n/types";

/** The web view storage key of the mute preference. */
export const PREVIEW_MUTED_STORAGE_KEY = "quipclip.preview_muted";

/** The web view storage key of the volume preference. */
export const PREVIEW_VOLUME_STORAGE_KEY = "quipclip.preview_volume";

/** The preference on a fresh install: the preview makes sound. */
export const DEFAULT_PREVIEW_MUTED = false;

/** The volume on a fresh install, in percent: the full level of the source. */
export const DEFAULT_PREVIEW_VOLUME_PERCENT = 100;

/** The highest volume, in percent. The preview never raises the level of the source. */
export const MAX_PREVIEW_VOLUME_PERCENT = 100;

/** The stored text of each value. Any other text reads as the default. */
const STORED_MUTED = "true";
const STORED_UNMUTED = "false";

/** The stored text of a volume: a whole number of percent, with no sign and no leading zero. */
const STORED_VOLUME_PATTERN = /^(0|[1-9][0-9]{0,2})$/;

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

/**
 * Reads the stored volume, in percent. A missing value, a value that is not a whole number
 * from 0 to `MAX_PREVIEW_VOLUME_PERCENT`, missing storage, or a storage error reads as the
 * default.
 *
 * @param storage The storage to read. Undefined reads `window.localStorage`; null reads
 *   nothing.
 */
export function readStoredPreviewVolume(storage?: PreferenceStorage | null): number {
  const target = storage !== undefined ? storage : getDefaultStorage();
  if (!target) {
    return DEFAULT_PREVIEW_VOLUME_PERCENT;
  }
  try {
    const raw = target.getItem(PREVIEW_VOLUME_STORAGE_KEY);
    if (raw !== null && STORED_VOLUME_PATTERN.test(raw)) {
      const percent = Number(raw);
      if (percent <= MAX_PREVIEW_VOLUME_PERCENT) {
        return percent;
      }
    }
  } catch {
    // A read error keeps the default.
  }
  return DEFAULT_PREVIEW_VOLUME_PERCENT;
}

/**
 * Writes the volume. A write error is ignored: the volume then lasts for the session only.
 *
 * @param percent The volume to store, a whole number from 0 to `MAX_PREVIEW_VOLUME_PERCENT`.
 * @param storage The storage to write. Undefined writes `window.localStorage`; null writes
 *   nothing.
 */
export function writeStoredPreviewVolume(
  percent: number,
  storage?: PreferenceStorage | null,
): void {
  const target = storage !== undefined ? storage : getDefaultStorage();
  if (!target) {
    return;
  }
  try {
    target.setItem(PREVIEW_VOLUME_STORAGE_KEY, String(percent));
  } catch {
    // A write error keeps the in-memory value only.
  }
}

/**
 * Returns the volume as a whole number of percent from 0 to `MAX_PREVIEW_VOLUME_PERCENT`, or
 * null for a value that is not a finite number.
 */
export function normalizePreviewVolume(percent: number): number | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return null;
  }
  return Math.min(MAX_PREVIEW_VOLUME_PERCENT, Math.max(0, Math.round(percent)));
}

/** The part of the preference that decides what the user hears. */
export interface PreviewAudioLevel {
  readonly muted: boolean;
  readonly volumePercent: number;
}

/** True while the preview makes no sound: mute is on, or the volume is 0. */
export function isPreviewSilent(level: PreviewAudioLevel): boolean {
  return level.muted || level.volumePercent === 0;
}

/**
 * The `volume` property of a preview media element, from 0 to 1. The element takes mute as
 * its own `muted` property, so this value does not read it.
 */
export function previewElementVolume(volumePercent: number): number {
  return volumePercent / 100;
}

/** The gain of the Web Audio cue (ADR 046), from 0 to 1. It is 0 while mute is on. */
export function previewCueGain(level: PreviewAudioLevel): number {
  return level.muted ? 0 : previewElementVolume(level.volumePercent);
}

export interface PreviewMutePreferenceState extends PreviewAudioLevel {
  /** True while the preview and the frame step cue make no sound. */
  readonly muted: boolean;
  /** The level of the preview and of the frame step cue, as a whole number of percent. */
  readonly volumePercent: number;
  /** Stores the preference and applies it at once. A value that is not a boolean is ignored. */
  readonly setMuted: (muted: boolean) => void;
  /**
   * Ends the silence when the preview is silent (`isPreviewSilent`), and turns mute on when it
   * is not. Ending the silence at a volume of 0 also sets the default volume.
   */
  readonly toggleMuted: () => void;
  /**
   * Stores the volume and applies it at once. The value is rounded to a whole number and held
   * from 0 to `MAX_PREVIEW_VOLUME_PERCENT`, and a value that is not a finite number is ignored.
   * A level above 0 also turns mute off.
   */
  readonly setVolumePercent: (percent: number) => void;
}

export interface PreviewMutePreferenceStoreOptions {
  /** The storage to read and write. Undefined uses `window.localStorage`. */
  storage?: PreferenceStorage | null;
}

/**
 * Creates a preference store. It reads the stored preference once, when it is created, so
 * the first render of the preview already carries it and the elements are muted, and at their
 * level, before the first play.
 */
export function createPreviewMutePreferenceStore(
  options?: PreviewMutePreferenceStoreOptions,
): StoreApi<PreviewMutePreferenceState> {
  const storage = options?.storage;
  return createStore<PreviewMutePreferenceState>()((set, get) => {
    // Stores the values that an action names, and applies them in one update, so no
    // subscriber sees a state between the two values.
    const apply = (next: Partial<PreviewAudioLevel>): void => {
      if (next.muted !== undefined) {
        writeStoredPreviewMuted(next.muted, storage);
      }
      if (next.volumePercent !== undefined) {
        writeStoredPreviewVolume(next.volumePercent, storage);
      }
      const state = get();
      const muted = next.muted ?? state.muted;
      const volumePercent = next.volumePercent ?? state.volumePercent;
      if (muted !== state.muted || volumePercent !== state.volumePercent) {
        set({ muted, volumePercent });
      }
    };
    return {
      muted: readStoredPreviewMuted(storage),
      volumePercent: readStoredPreviewVolume(storage),
      setMuted: (muted) => {
        if (typeof muted === "boolean") {
          apply({ muted });
        }
      },
      toggleMuted: () => {
        const state = get();
        if (!isPreviewSilent(state)) {
          apply({ muted: true });
        } else if (state.volumePercent === 0) {
          apply({ muted: false, volumePercent: DEFAULT_PREVIEW_VOLUME_PERCENT });
        } else {
          apply({ muted: false });
        }
      },
      setVolumePercent: (percent) => {
        const volumePercent = normalizePreviewVolume(percent);
        if (volumePercent === null) {
          return;
        }
        apply(volumePercent > 0 ? { muted: false, volumePercent } : { volumePercent });
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
