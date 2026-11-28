import { describe, expect, it } from "vitest";
import { isAtMediaEnd } from "./mediaEnd";

describe("isAtMediaEnd (ADR 074)", () => {
  it("is true for an element that reports its end and no seek", () => {
    expect(isAtMediaEnd({ ended: true, seeking: false })).toBe(true);
    expect(isAtMediaEnd({ ended: true })).toBe(true);
  });

  it("is false for an element that reports its end during a seek", () => {
    expect(isAtMediaEnd({ ended: true, seeking: true })).toBe(false);
  });

  it("is false for an element that does not report its end", () => {
    expect(isAtMediaEnd({ ended: false })).toBe(false);
    expect(isAtMediaEnd({})).toBe(false);
  });
});
