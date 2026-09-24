import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  createSettingsPanelStore,
  isSettingsSection,
  settingsPanelStore,
  useSettingsPanelStore,
} from "./panelStore";

describe("Settings Panel Store", () => {
  it("starts closed on the general section by default", () => {
    const store = createSettingsPanelStore();
    expect(store.getState().open).toBe(false);
    expect(store.getState().section).toBe("general");
    expect(DEFAULT_SETTINGS_SECTION).toBe("general");
  });

  it("respects initialState overrides", () => {
    const store = createSettingsPanelStore({ open: true, section: "presets" });
    expect(store.getState().open).toBe(true);
    expect(store.getState().section).toBe("presets");
  });

  it("opens and keeps the last section when show has no section", () => {
    const store = createSettingsPanelStore({ section: "ffmpeg" });

    store.getState().show();
    expect(store.getState().open).toBe(true);
    expect(store.getState().section).toBe("ffmpeg");

    // Idempotent show
    store.getState().show();
    expect(store.getState().open).toBe(true);
    expect(store.getState().section).toBe("ffmpeg");
  });

  it("opens on the requested section when show has a section", () => {
    const store = createSettingsPanelStore();

    store.getState().show("ffmpeg");
    expect(store.getState().open).toBe(true);
    expect(store.getState().section).toBe("ffmpeg");
  });

  it("switches the section of a dialog that is already open", () => {
    const store = createSettingsPanelStore({ open: true, section: "general" });

    store.getState().show("presets");
    expect(store.getState().open).toBe(true);
    expect(store.getState().section).toBe("presets");
  });

  it("closes using hide and keeps the section for the next show", () => {
    const store = createSettingsPanelStore({ open: true, section: "presets" });

    store.getState().hide();
    expect(store.getState().open).toBe(false);
    expect(store.getState().section).toBe("presets");

    // Idempotent hide
    store.getState().hide();
    expect(store.getState().open).toBe(false);

    store.getState().show();
    expect(store.getState().section).toBe("presets");
  });

  it("changes only the section using setSection", () => {
    const closed = createSettingsPanelStore();
    closed.getState().setSection("ffmpeg");
    expect(closed.getState().section).toBe("ffmpeg");
    expect(closed.getState().open).toBe(false);

    const opened = createSettingsPanelStore({ open: true });
    opened.getState().setSection("presets");
    expect(opened.getState().section).toBe("presets");
    expect(opened.getState().open).toBe(true);
  });

  it("records the unsaved preset draft without changing the open state", () => {
    const store = createSettingsPanelStore({ open: true, section: "presets" });
    expect(store.getState().unsavedPresetName).toBeNull();

    store.getState().setUnsavedPresetName("Web 1080p");
    expect(store.getState().unsavedPresetName).toBe("Web 1080p");
    expect(store.getState().open).toBe(true);
    expect(store.getState().section).toBe("presets");

    // A new preset can have no name yet. It still holds an unsaved edit.
    store.getState().setUnsavedPresetName("");
    expect(store.getState().unsavedPresetName).toBe("");

    store.getState().setUnsavedPresetName(null);
    expect(store.getState().unsavedPresetName).toBeNull();
  });

  it("starts with no return target", () => {
    expect(createSettingsPanelStore().getState().returnFocus).toBeNull();
  });

  it("records the return target that show names, with or without a section", () => {
    const target = { isConnected: true, focus: () => {} };
    const store = createSettingsPanelStore();

    store.getState().show("presets", { returnFocus: target });
    expect(store.getState().returnFocus).toBe(target);
    expect(store.getState().section).toBe("presets");

    store.getState().hide();
    store.getState().show(undefined, { returnFocus: target });
    expect(store.getState().returnFocus).toBe(target);
    expect(store.getState().section).toBe("presets");
  });

  it("clears the return target on hide and on a show that names none", () => {
    const target = { isConnected: true, focus: () => {} };
    const store = createSettingsPanelStore();

    store.getState().show("ffmpeg", { returnFocus: target });
    store.getState().hide();
    expect(store.getState().returnFocus).toBeNull();

    store.getState().show("ffmpeg", { returnFocus: target });
    store.getState().show();
    expect(store.getState().returnFocus).toBeNull();
  });

  it("starts with no opening preset, no return flow and no selection", () => {
    const state = createSettingsPanelStore().getState();
    expect(state.openingPresetId).toBeNull();
    expect(state.returnTo).toBeNull();
    expect(state.selectedPresetId).toBeNull();
  });

  it("records the opening preset and the return flow that show names", () => {
    const target = { isConnected: true, focus: () => {} };
    const store = createSettingsPanelStore();

    store.getState().show("presets", {
      returnFocus: target,
      selectPresetId: "p2",
      returnTo: "exportSetup",
    });
    expect(store.getState()).toMatchObject({
      open: true,
      section: "presets",
      returnFocus: target,
      openingPresetId: "p2",
      returnTo: "exportSetup",
    });
  });

  it("clears the opening preset and the return flow on hide", () => {
    const store = createSettingsPanelStore();
    store.getState().show("presets", { selectPresetId: "p2", returnTo: "exportSetup" });

    store.getState().hide();
    expect(store.getState().openingPresetId).toBeNull();
    expect(store.getState().returnTo).toBeNull();
  });

  it("gives a listener of the close the return flow of the dialog that closed", () => {
    const store = createSettingsPanelStore();
    const closed: unknown[] = [];
    store.subscribe((state, previous) => {
      if (previous.open && !state.open) {
        closed.push(previous.returnTo);
      }
    });

    store.getState().show("presets", { returnTo: "exportSetup" });
    store.getState().hide();
    store.getState().show("presets");
    store.getState().hide();
    expect(closed).toEqual(["exportSetup", null]);
  });

  // The status bar gear, the settings key and the menu item call `show` with no options, and
  // the ffmpeg status line calls it with a section only.
  it("clears the return flow on every show that does not name it", () => {
    const store = createSettingsPanelStore();

    store.getState().show("presets", { selectPresetId: "p2", returnTo: "exportSetup" });
    store.getState().show();
    expect(store.getState().openingPresetId).toBeNull();
    expect(store.getState().returnTo).toBeNull();

    store.getState().show("presets", { selectPresetId: "p2", returnTo: "exportSetup" });
    store.getState().show("ffmpeg");
    expect(store.getState().openingPresetId).toBeNull();
    expect(store.getState().returnTo).toBeNull();
  });

  it("keeps the selection of the Presets tab after hide, for a listener of the close", () => {
    const store = createSettingsPanelStore();
    store.getState().show("presets");
    store.getState().setSelectedPresetId("p3");
    expect(store.getState().selectedPresetId).toBe("p3");

    store.getState().hide();
    expect(store.getState().selectedPresetId).toBe("p3");

    store.getState().setSelectedPresetId(null);
    expect(store.getState().selectedPresetId).toBeNull();
  });

  it("keeps separate store instances independent", () => {
    const first = createSettingsPanelStore();
    const second = createSettingsPanelStore();

    first.getState().show("presets");
    expect(second.getState().open).toBe(false);
    expect(second.getState().section).toBe("general");
  });

  it("lists the sections in tab order", () => {
    expect(SETTINGS_SECTIONS).toEqual(["general", "ffmpeg", "presets"]);
  });

  it("narrows only the known section names", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(isSettingsSection(section)).toBe(true);
    }
    expect(isSettingsSection("General")).toBe(false);
    expect(isSettingsSection("")).toBe(false);
    expect(isSettingsSection(undefined)).toBe(false);
    expect(isSettingsSection(null)).toBe(false);
    expect(isSettingsSection(0)).toBe(false);
  });

  it("provides singleton settingsPanelStore and useSettingsPanelStore hook", () => {
    expect(settingsPanelStore.getState().open).toBe(false);
    expect(settingsPanelStore.getState().section).toBe("general");
    expect(typeof settingsPanelStore.getState().show).toBe("function");
    expect(typeof settingsPanelStore.getState().hide).toBe("function");
    expect(typeof settingsPanelStore.getState().setSection).toBe("function");
    expect(typeof useSettingsPanelStore).toBe("function");
  });
});
