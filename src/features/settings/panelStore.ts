/**
 * The tabs of the Settings window, and the store of the tab that shows.
 *
 * Settings is a window of its own. A control opens it on a tab through
 * `openSettingsWindow` (`settingsWindowClient.ts`), and the page of that window keeps the tab
 * that shows in this store. The main window never reads the store.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

/** The tabs of the Settings window, in display order. */
export const SETTINGS_SECTIONS = ["general", "ffmpeg", "presets"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The section the window shows before any caller has chosen one. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = "general";

/**
 * Type guard for a section value that arrives as a plain string, such as the value that a
 * Radix `Tabs` root reports from `onValueChange`, or the request that Rust stores.
 */
export function isSettingsSection(value: unknown): value is SettingsSection {
  return (
    typeof value === "string" &&
    (SETTINGS_SECTIONS as readonly string[]).includes(value)
  );
}

export type SettingsPanelState = {
  /** The tab that the Settings window shows. */
  section: SettingsSection;
};

export type SettingsPanelActions = {
  /** Changes the tab that shows. */
  setSection: (section: SettingsSection) => void;
};

export type SettingsPanelStoreState = SettingsPanelState & SettingsPanelActions;

export function createSettingsPanelStore(
  initialState?: Partial<SettingsPanelState>,
): StoreApi<SettingsPanelStoreState> {
  return createStore<SettingsPanelStoreState>()((set) => ({
    section: initialState?.section ?? DEFAULT_SETTINGS_SECTION,
    setSection: (section: SettingsSection) => set({ section }),
  }));
}

export type SettingsPanelStore = ReturnType<typeof createSettingsPanelStore>;

export const settingsPanelStore: SettingsPanelStore = createSettingsPanelStore();

const defaultSelector = (state: SettingsPanelStoreState): SettingsPanelStoreState =>
  state;

export function useSettingsPanelStore(): SettingsPanelStoreState;
export function useSettingsPanelStore<T>(
  selector: (state: SettingsPanelStoreState) => T,
): T;
export function useSettingsPanelStore<T>(
  selector?: (state: SettingsPanelStoreState) => T,
): T | SettingsPanelStoreState {
  return useStore(
    settingsPanelStore,
    (selector ?? defaultSelector) as (state: SettingsPanelStoreState) => T,
  );
}
