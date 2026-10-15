import { describe, expect, it } from "vitest";
import {
  isSelectionTogglePress,
  type SegmentSelectionPress,
} from "./segmentSelectionPress";

function press(overrides: Partial<SegmentSelectionPress> = {}): SegmentSelectionPress {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("isSelectionTogglePress", () => {
  it("toggles on Cmd with the primary button on macOS", () => {
    expect(isSelectionTogglePress(press({ metaKey: true }), "macos")).toBe(true);
  });

  it("toggles on Ctrl with the primary button on Windows", () => {
    expect(isSelectionTogglePress(press({ ctrlKey: true }), "windows")).toBe(true);
  });

  it("does not toggle on Ctrl on macOS, where a Control click opens the context menu", () => {
    expect(isSelectionTogglePress(press({ ctrlKey: true }), "macos")).toBe(false);
    expect(
      isSelectionTogglePress(press({ ctrlKey: true, metaKey: true }), "macos"),
    ).toBe(false);
  });

  it("does not toggle on the Windows key on Windows", () => {
    expect(isSelectionTogglePress(press({ metaKey: true }), "windows")).toBe(false);
    expect(
      isSelectionTogglePress(press({ ctrlKey: true, metaKey: true }), "windows"),
    ).toBe(false);
  });

  it("does not toggle on a plain click", () => {
    expect(isSelectionTogglePress(press(), "macos")).toBe(false);
    expect(isSelectionTogglePress(press(), "windows")).toBe(false);
  });

  it("does not toggle when Shift or Alt is also held", () => {
    for (const platform of ["macos", "windows"] as const) {
      const modifier = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
      expect(
        isSelectionTogglePress(press({ ...modifier, shiftKey: true }), platform),
      ).toBe(false);
      expect(
        isSelectionTogglePress(press({ ...modifier, altKey: true }), platform),
      ).toBe(false);
    }
  });

  it("does not toggle on a button other than the primary one", () => {
    expect(isSelectionTogglePress(press({ button: 2, metaKey: true }), "macos")).toBe(
      false,
    );
    expect(isSelectionTogglePress(press({ button: 1, ctrlKey: true }), "windows")).toBe(
      false,
    );
  });
});
