import { describe, expect, it } from "vitest";
import { closesFieldOnPress, type PressContainer } from "./timecodeFieldPress";

/** A node tree of names: the field holds the input and the error. */
const insideField = new Set(["field", "input", "error"]);
const field: PressContainer<string> = {
  contains: (other) => other !== null && insideField.has(other),
};

describe("closesFieldOnPress", () => {
  it("keeps the field open for a press on the field or its error", () => {
    expect(closesFieldOnPress(field, "input")).toBe(false);
    expect(closesFieldOnPress(field, "error")).toBe(false);
    expect(closesFieldOnPress(field, "field")).toBe(false);
  });

  it("closes the field for a press anywhere else, also on a control that keeps no focus", () => {
    for (const target of [
      "playButton",
      "markInButton",
      "zoomIn",
      "ruler",
      "video",
      "body",
    ]) {
      expect(closesFieldOnPress(field, target), target).toBe(true);
    }
  });

  it("closes the field for a press without a target node", () => {
    expect(closesFieldOnPress(field, null)).toBe(true);
  });

  it("closes nothing when no field is open", () => {
    expect(closesFieldOnPress<string>(null, "playButton")).toBe(false);
    expect(closesFieldOnPress<string>(null, null)).toBe(false);
  });
});
