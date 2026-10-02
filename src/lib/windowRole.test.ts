import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentWindowRole, resolveWindowRole } from "./windowRole";

// `getCurrentWindow` reads the window metadata that Tauri injects. The fake returns a label,
// or throws as the real function does outside the Tauri shell.
const tauri = vi.hoisted(() => ({
  label: null as string | null,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    if (tauri.label === null) {
      throw new TypeError("window.__TAURI_INTERNALS__ is undefined");
    }
    return { label: tauri.label };
  },
}));

afterEach(() => {
  tauri.label = null;
});

describe("resolveWindowRole", () => {
  it("gives the Settings view to the Settings window only", () => {
    expect(resolveWindowRole("settings")).toBe("settings");
    expect(resolveWindowRole("main")).toBe("main");
  });

  it("gives the editor to an unknown label and to no label", () => {
    expect(resolveWindowRole("Settings")).toBe("main");
    expect(resolveWindowRole("export")).toBe("main");
    expect(resolveWindowRole("")).toBe("main");
    expect(resolveWindowRole(null)).toBe("main");
  });
});

describe("getCurrentWindowRole", () => {
  it("reads the role of the current window", () => {
    tauri.label = "settings";
    expect(getCurrentWindowRole()).toBe("settings");
    tauri.label = "main";
    expect(getCurrentWindowRole()).toBe("main");
  });

  it("gives the editor outside the Tauri shell", () => {
    expect(getCurrentWindowRole()).toBe("main");
  });
});
