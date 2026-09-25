/**
 * The timeline height preference.
 *
 * The splitter above the timeline sets the height of the timeline area (`TimelineArea`). The
 * preference is the height that the user chose. The layout clamps it to the window each time
 * it renders (`timelineHeight.ts`), and it does not write the clamped value back, so a window
 * that becomes taller again gives the timeline back the height that the user chose.
 *
 * The preference belongs to the application, not to a project, and it is not part of the
 * settings file. It lives in web view storage, next to the language preference (ADR 011),
 * so a damaged settings file does not change it. Every read and write is guarded: storage
 * can be missing or can throw, and a missing or bad stored value reads as the default.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { PreferenceStorage } from "@/i18n/types";

/** The web view storage key of the preference. */
export const TIMELINE_HEIGHT_STORAGE_KEY = "quipclip.timeline_height";

/** The height on a fresh install, in CSS pixels. It is the fixed height of earlier versions. */
export const DEFAULT_TIMELINE_HEIGHT_PX = 180;

/**
 * The smallest height of the timeline area, in CSS pixels.
 *
 * It holds the 1px top border, the 28px ruler, the track row and the horizontal scroll bar.
 * With the thickest scroll bar, the 15px legacy scroll bar of macOS, the track row is 64px, and
 * a segment in it is 40px tall: the two lines of its label take 31px of that. The default is
 * nine keyboard steps (`TIMELINE_HEIGHT_STEP_PX`) above this value.
 */
export const MIN_TIMELINE_HEIGHT_PX = 108;

/**
 * The largest height that a stored value can hold, in CSS pixels. No window is this tall, so
 * the layout always clamps such a value further. A larger stored value is bad and reads as
 * the default.
 */
export const MAX_STORED_TIMELINE_HEIGHT_PX = 10_000;

/** A stored value is a whole number of pixels, in decimal digits and nothing else. */
const STORED_HEIGHT_PATTERN = /^[0-9]{1,5}$/;

/**
 * Returns the height as a whole number of pixels when it is a height that the preference can
 * hold, and null otherwise. A fraction rounds to the nearest pixel before the range test.
 */
export function normalizeTimelineHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  if (rounded < MIN_TIMELINE_HEIGHT_PX || rounded > MAX_STORED_TIMELINE_HEIGHT_PX) {
    return null;
  }
  return rounded;
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
 * Reads the stored height. A missing value, a value that is not a whole number of pixels, a
 * value out of range, missing storage, or a storage error reads as the default.
 *
 * @param storage The storage to read. Undefined reads `window.localStorage`; null reads
 *   nothing.
 */
export function readStoredTimelineHeight(storage?: PreferenceStorage | null): number {
  const target = storage !== undefined ? storage : getDefaultStorage();
  if (!target) {
    return DEFAULT_TIMELINE_HEIGHT_PX;
  }
  try {
    const raw = target.getItem(TIMELINE_HEIGHT_STORAGE_KEY);
    if (raw !== null && STORED_HEIGHT_PATTERN.test(raw)) {
      const height = normalizeTimelineHeight(Number(raw));
      if (height !== null) {
        return height;
      }
    }
  } catch {
    // A read error keeps the default.
  }
  return DEFAULT_TIMELINE_HEIGHT_PX;
}

/**
 * Writes the height. A write error is ignored: the preference then lasts for the session
 * only.
 *
 * @param heightPx The height to store. The caller passes a value that `normalizeTimelineHeight`
 *   accepted.
 * @param storage The storage to write. Undefined writes `window.localStorage`; null writes
 *   nothing.
 */
export function writeStoredTimelineHeight(
  heightPx: number,
  storage?: PreferenceStorage | null,
): void {
  const target = storage !== undefined ? storage : getDefaultStorage();
  if (!target) {
    return;
  }
  try {
    target.setItem(TIMELINE_HEIGHT_STORAGE_KEY, String(heightPx));
  } catch {
    // A write error keeps the in-memory value only.
  }
}

export interface TimelineHeightPreferenceState {
  /** The height that the user chose, in CSS pixels. The layout clamps it to the window. */
  readonly heightPx: number;
  /**
   * Stores the height and applies it at once. A fraction rounds to the nearest pixel. A value
   * that is not a number, or that is out of range, is ignored.
   */
  readonly setHeight: (heightPx: number) => void;
}

export interface TimelineHeightPreferenceStoreOptions {
  /** The storage to read and write. Undefined uses `window.localStorage`. */
  storage?: PreferenceStorage | null;
}

/**
 * Creates a preference store. It reads the stored height once, when it is created, so the
 * first render of the shell already has it.
 */
export function createTimelineHeightPreferenceStore(
  options?: TimelineHeightPreferenceStoreOptions,
): StoreApi<TimelineHeightPreferenceState> {
  const storage = options?.storage;
  return createStore<TimelineHeightPreferenceState>()((set, get) => ({
    heightPx: readStoredTimelineHeight(storage),
    setHeight: (heightPx: number) => {
      const height = normalizeTimelineHeight(heightPx);
      if (height === null) {
        return;
      }
      writeStoredTimelineHeight(height, storage);
      if (get().heightPx !== height) {
        set({ heightPx: height });
      }
    },
  }));
}

/** The application's preference store. */
export const timelineHeightPreferenceStore = createTimelineHeightPreferenceStore();

/** Subscribes a component to the application's preference store. */
export function useTimelineHeightPreference<T>(
  selector: (state: TimelineHeightPreferenceState) => T,
): T {
  return useStore(timelineHeightPreferenceStore, selector);
}
