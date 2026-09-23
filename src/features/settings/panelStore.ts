/**
 * Settings panel store managing the open state and the visible section of the settings dialog.
 *
 * The store holds only whether the settings dialog is open and which tab it shows, so any
 * component can open it: the status bar gear today, and later a message that tells the user
 * to open Settings or the ffmpeg status line. The dialog keeps one mount, in `AppShell`.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

/** The tabs of the settings dialog, in display order. */
export const SETTINGS_SECTIONS = ["general", "ffmpeg", "presets"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The section the dialog shows before any caller has chosen one. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = "general";

/**
 * Type guard for a section value that arrives as a plain string, such as the value that a
 * Radix `Tabs` root reports from `onValueChange`.
 */
export function isSettingsSection(value: unknown): value is SettingsSection {
  return (
    typeof value === "string" &&
    (SETTINGS_SECTIONS as readonly string[]).includes(value)
  );
}

export type SettingsPanelState = { open: boolean; section: SettingsSection };

export type SettingsPanelActions = {
  /**
   * Opens the dialog. With a section, the dialog also switches to that section. Without one,
   * it keeps the section it showed last.
   */
  show: (section?: SettingsSection) => void;
  hide: () => void;
  /** Changes the visible section and does not change the open state. */
  setSection: (section: SettingsSection) => void;
};

export type SettingsPanelStoreState = SettingsPanelState & SettingsPanelActions;

export function createSettingsPanelStore(
  initialState?: Partial<SettingsPanelState>,
): StoreApi<SettingsPanelStoreState> {
  return createStore<SettingsPanelStoreState>()((set) => ({
    open: initialState?.open ?? false,
    section: initialState?.section ?? DEFAULT_SETTINGS_SECTION,
    show: (section?: SettingsSection) =>
      set(section === undefined ? { open: true } : { open: true, section }),
    hide: () => set({ open: false }),
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
