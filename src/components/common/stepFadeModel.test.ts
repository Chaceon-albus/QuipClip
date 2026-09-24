import { describe, expect, it } from "vitest";
import { STEP_FADE_IN_CLASS, shouldFadeStep } from "./stepFadeModel";

describe("shouldFadeStep", () => {
  it("does not fade the step that the content opened on", () => {
    expect(shouldFadeStep("setup", "setup", false)).toBe(false);
  });

  it("fades a step that follows the first", () => {
    expect(shouldFadeStep("setup", "progress", false)).toBe(true);
  });

  it("fades a return to the first step after a change", () => {
    expect(shouldFadeStep("setup", "setup", true)).toBe(true);
  });
});

describe("STEP_FADE_IN_CLASS", () => {
  it("changes only the opacity, so reduced motion keeps it", () => {
    expect(STEP_FADE_IN_CLASS).toContain("fade-in-0");
    expect(STEP_FADE_IN_CLASS).not.toMatch(/zoom|slide|spin|translate/);
  });

  it("reads its duration from a motion token", () => {
    expect(STEP_FADE_IN_CLASS).toContain("duration-(--motion-");
  });
});
