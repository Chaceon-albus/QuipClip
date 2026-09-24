/**
 * Settings panel store managing the open state and the visible section of the settings dialog.
 *
 * The store holds whether the settings dialog is open and which tab it shows, so any
 * component can open it: the status bar gear today, and later a message that tells the user
 * to open Settings or the ffmpeg status line. The dialog keeps one mount, in `AppShell`.
 *
 * It also holds the name of a preset draft with unsaved edits. The dialog writes it, and the
 * quit guard reads it, because a quit drops the draft (ADR 027).
 *
 * A caller can also name the element that takes the focus back when the dialog closes. See
 * `SettingsPanelState.returnFocus`.
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

/**
 * The part of an element that the settings dialog reads to give the focus back, so a test
 * can pass a fake. An `HTMLElement` satisfies it.
 */
export interface SettingsFocusReturnTarget {
  /** False after the element left the document. A detached element cannot take the focus. */
  readonly isConnected: boolean;
  focus: () => void;
}

export type SettingsPanelState = {
  open: boolean;
  section: SettingsSection;
  /**
   * The element that takes the focus back when the dialog closes, or null. When it is null,
   * the dialog gives the focus back to the element that held it when the dialog opened.
   *
   * A caller sets it when its own control leaves the document as the dialog opens. The
   * "Open Settings..." button of the export dialog is one: the export dialog closes first,
   * so the button that held the focus is gone when the settings dialog closes.
   */
  returnFocus: SettingsFocusReturnTarget | null;
  /**
   * The name that the prompts show for a preset draft with unsaved edits, or null when no
   * draft holds an unsaved edit. The name can be empty, for a new preset with no name yet.
   */
  unsavedPresetName: string | null;
};

export type SettingsPanelActions = {
  /**
   * Opens the dialog. With a section, the dialog also switches to that section. Without one,
   * it keeps the section it showed last. `returnFocus` sets `SettingsPanelState.returnFocus`,
   * and every call without it clears that field.
   */
  show: (
    section?: SettingsSection,
    returnFocus?: SettingsFocusReturnTarget | null,
  ) => void;
  hide: () => void;
  /** Changes the visible section and does not change the open state. */
  setSection: (section: SettingsSection) => void;
  /** Records the unsaved preset draft. Only the settings dialog calls it. */
  setUnsavedPresetName: (name: string | null) => void;
};

export type SettingsPanelStoreState = SettingsPanelState & SettingsPanelActions;

export function createSettingsPanelStore(
  initialState?: Partial<SettingsPanelState>,
): StoreApi<SettingsPanelStoreState> {
  return createStore<SettingsPanelStoreState>()((set) => ({
    open: initialState?.open ?? false,
    section: initialState?.section ?? DEFAULT_SETTINGS_SECTION,
    unsavedPresetName: initialState?.unsavedPresetName ?? null,
    returnFocus: initialState?.returnFocus ?? null,
    show: (section?: SettingsSection, returnFocus?: SettingsFocusReturnTarget | null) =>
      set(
        section === undefined
          ? { open: true, returnFocus: returnFocus ?? null }
          : { open: true, section, returnFocus: returnFocus ?? null },
      ),
    hide: () => set({ open: false, returnFocus: null }),
    setSection: (section: SettingsSection) => set({ section }),
    setUnsavedPresetName: (name: string | null) => set({ unsavedPresetName: name }),
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
