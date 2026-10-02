import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_WINDOW_LABEL,
  SETTINGS_WINDOW_LABEL,
  getCurrentWindowLabel,
  isForeignOrigin,
} from "./windowLabel";

// `getCurrentWindow` reads the window metadata that Tauri injects. The fake returns a label,
// or throws as the real function does outside the Tauri shell.
const tauri = vi.hoisted(() => ({
  window: null as { label: unknown } | null,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    if (tauri.window === null) {
      throw new TypeError("window.__TAURI_INTERNALS__ is undefined");
    }
    return tauri.window;
  },
}));

afterEach(() => {
  tauri.window = null;
});

describe("getCurrentWindowLabel", () => {
  it("reads the label of the current window", () => {
    tauri.window = { label: "settings" };
    expect(getCurrentWindowLabel()).toBe("settings");
    tauri.window = { label: "main" };
    expect(getCurrentWindowLabel()).toBe("main");
  });

  it("returns null outside the Tauri shell", () => {
    expect(getCurrentWindowLabel()).toBeNull();
  });

  it("returns null for a label that is empty or not a string", () => {
    tauri.window = { label: "" };
    expect(getCurrentWindowLabel()).toBeNull();
    tauri.window = { label: undefined };
    expect(getCurrentWindowLabel()).toBeNull();
  });
});

describe("isForeignOrigin", () => {
  it("is false only for the label of the current window", () => {
    expect(isForeignOrigin("main", "main")).toBe(false);
    expect(isForeignOrigin("settings", "main")).toBe(true);
    expect(isForeignOrigin("main", "settings")).toBe(true);
  });

  it("treats every origin as foreign when the window has no label", () => {
    expect(isForeignOrigin("main", null)).toBe(true);
  });
});

/** Reads the value of a `const <name>: &str = "...";` from a file under `src-tauri/src`. */
function readRustLabel(file: string, name: string): string | null {
  const source = readFileSync(
    fileURLToPath(new URL(`../../src-tauri/src/${file}`, import.meta.url)),
    "utf8",
  );
  const match = new RegExp(`const ${name}: &str = "([^"]+)";`).exec(source);
  return match === null ? null : match[1];
}

describe("the window labels", () => {
  it("are the labels that Rust gives the two windows", () => {
    // A rename on one side only makes every payload of the other window look like its own,
    // or its own look foreign.
    expect(readRustLabel("lib.rs", "MAIN_WINDOW_LABEL")).toBe(MAIN_WINDOW_LABEL);
    expect(readRustLabel("commands/settings_window.rs", "SETTINGS_WINDOW_LABEL")).toBe(
      SETTINGS_WINDOW_LABEL,
    );
    expect(MAIN_WINDOW_LABEL).not.toBe(SETTINGS_WINDOW_LABEL);
  });
});
