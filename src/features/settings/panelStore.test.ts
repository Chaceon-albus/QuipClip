import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  it("starts on the general section by default", () => {
    const store = createSettingsPanelStore();
    expect(store.getState().section).toBe("general");
    expect(DEFAULT_SETTINGS_SECTION).toBe("general");
  });

  it("respects initialState overrides", () => {
    const store = createSettingsPanelStore({ section: "presets" });
    expect(store.getState().section).toBe("presets");
  });

  it("changes the section using setSection", () => {
    const store = createSettingsPanelStore();
    store.getState().setSection("ffmpeg");
    expect(store.getState().section).toBe("ffmpeg");
    store.getState().setSection("presets");
    expect(store.getState().section).toBe("presets");
  });

  it("keeps separate store instances independent", () => {
    const first = createSettingsPanelStore();
    const second = createSettingsPanelStore();

    first.getState().setSection("presets");
    expect(second.getState().section).toBe("general");
  });

  it("lists the sections in tab order", () => {
    expect(SETTINGS_SECTIONS).toEqual(["general", "ffmpeg", "presets"]);
  });

  it("lists the sections that Rust accepts in a request", () => {
    // `open_settings_window` refuses any other name, so a tab that only one side knows
    // either never opens or always fails.
    const source = readFileSync(
      fileURLToPath(
        new URL("../../../src-tauri/src/commands/settings_window.rs", import.meta.url),
      ),
      "utf8",
    );
    const parse =
      /pub fn parse\(name: &str\) -> Option<Self> \{([\s\S]*?)\n {4}\}/.exec(source);
    expect(parse).not.toBeNull();
    const names = Array.from(parse![1].matchAll(/"([a-z]+)" => Some/g), (m) => m[1]);
    expect(names).toEqual([...SETTINGS_SECTIONS]);
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
    expect(settingsPanelStore.getState().section).toBe("general");
    expect(typeof settingsPanelStore.getState().setSection).toBe("function");
    expect(typeof useSettingsPanelStore).toBe("function");
  });
});
