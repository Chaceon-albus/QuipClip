import { describe, expect, it } from "vitest";
import {
  VOLUME_LARGE_STEP_PERCENT,
  focusAfterPress,
  largeStepDirection,
} from "./volumeSlider";

describe("largeStepDirection", () => {
  it("takes ten percent for a large step", () => {
    expect(VOLUME_LARGE_STEP_PERCENT).toBe(10);
  });

  it("raises the value for Page Up, and Shift with Right or Up", () => {
    expect(largeStepDirection({ key: "PageUp", shiftKey: false })).toBe(1);
    expect(largeStepDirection({ key: "PageUp", shiftKey: true })).toBe(1);
    expect(largeStepDirection({ key: "ArrowRight", shiftKey: true })).toBe(1);
    expect(largeStepDirection({ key: "ArrowUp", shiftKey: true })).toBe(1);
  });

  it("lowers the value for Page Down, and Shift with Left or Down", () => {
    expect(largeStepDirection({ key: "PageDown", shiftKey: false })).toBe(-1);
    expect(largeStepDirection({ key: "ArrowLeft", shiftKey: true })).toBe(-1);
    expect(largeStepDirection({ key: "ArrowDown", shiftKey: true })).toBe(-1);
  });

  it("leaves a plain arrow, Home, End and every other key to Radix", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(largeStepDirection({ key, shiftKey: false })).toBeNull();
    }
    for (const key of ["Home", "End", " ", "Escape", "a"]) {
      expect(largeStepDirection({ key, shiftKey: false })).toBeNull();
      expect(largeStepDirection({ key, shiftKey: true })).toBeNull();
    }
  });
});

describe("focusAfterPress", () => {
  const button = { isConnected: true };
  const removed = { isConnected: false };

  it("gives the focus back to the element that had it before the press", () => {
    expect(focusAfterPress({ startedInside: false, previous: button }, true)).toBe(
      "restore",
    );
  });

  it("gives up the focus when no element had it, or that element left the document", () => {
    expect(focusAfterPress({ startedInside: false, previous: null }, true)).toBe(
      "blur",
    );
    expect(focusAfterPress({ startedInside: false, previous: removed }, true)).toBe(
      "blur",
    );
  });

  it("leaves the focus inside the slider for a press that began with the focus there", () => {
    expect(focusAfterPress({ startedInside: true, previous: null }, true)).toBe(
      "leave",
    );
  });

  it("leaves the focus where it is when it is no longer inside the slider", () => {
    expect(focusAfterPress({ startedInside: false, previous: button }, false)).toBe(
      "leave",
    );
  });

  it("does nothing when no press runs", () => {
    expect(focusAfterPress(null, true)).toBe("leave");
  });
});
