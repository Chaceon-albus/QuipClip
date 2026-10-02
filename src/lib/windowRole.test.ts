import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyWindowRoleAttribute,
  getCurrentWindowRole,
  resolveWindowRole,
  WINDOW_ROLE_ATTRIBUTE,
  type WindowRoleRoot,
} from "./windowRole";

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

describe("applyWindowRoleAttribute", () => {
  function fakeRoot(): WindowRoleRoot & { attributes: Map<string, string> } {
    const attributes = new Map<string, string>();
    return {
      attributes,
      setAttribute: (name, value) => {
        attributes.set(name, value);
      },
    };
  }

  it("writes the role on the root", () => {
    const root = fakeRoot();
    applyWindowRoleAttribute("main", root);
    expect(WINDOW_ROLE_ATTRIBUTE).toBe("data-window-role");
    expect(root.attributes.get(WINDOW_ROLE_ATTRIBUTE)).toBe("main");

    applyWindowRoleAttribute("settings", root);
    expect(root.attributes.get(WINDOW_ROLE_ATTRIBUTE)).toBe("settings");
  });

  it("does nothing with a null root or outside a document", () => {
    expect(() => applyWindowRoleAttribute("main", null)).not.toThrow();
    expect(() => applyWindowRoleAttribute("main")).not.toThrow();
  });
});
