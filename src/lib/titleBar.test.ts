import { describe, expect, it } from "vitest";
import { isInTitleBar, TITLE_BAR_MARKER, TITLE_BAR_SELECTOR } from "./titleBar";

/** An element whose nearest title bar ancestor is `bar`, or that has none. */
function inside(bar: object | null) {
  const selectors: string[] = [];
  return {
    selectors,
    closest: (selector: string) => {
      selectors.push(selector);
      return bar;
    },
  };
}

describe("TITLE_BAR_SELECTOR", () => {
  it("selects the attribute of the marker", () => {
    // The bar spreads the marker, and the dialogs look for the selector. If the two named
    // different attributes, no press would count as a press on the bar.
    expect(Object.keys(TITLE_BAR_MARKER)).toEqual(["data-title-bar"]);
    expect(TITLE_BAR_SELECTOR).toBe(`[${Object.keys(TITLE_BAR_MARKER)[0]}]`);
  });
});

describe("isInTitleBar", () => {
  it("answers true inside the title bar, and asks with the title bar selector", () => {
    const element = inside({});
    expect(isInTitleBar(element)).toBe(true);
    expect(element.selectors).toEqual([TITLE_BAR_SELECTOR]);
  });

  it("answers false outside the title bar", () => {
    expect(isInTitleBar(inside(null))).toBe(false);
  });

  it("answers false for a target that is not an element", () => {
    // The target of an outside interaction can be the document or the window, which have no
    // `closest`.
    expect(isInTitleBar(null)).toBe(false);
    expect(isInTitleBar(undefined)).toBe(false);
    expect(isInTitleBar({})).toBe(false);
    expect(isInTitleBar({ closest: "[data-title-bar]" })).toBe(false);
    expect(isInTitleBar("[data-title-bar]")).toBe(false);
  });
});
