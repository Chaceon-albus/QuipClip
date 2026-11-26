import { describe, expect, it } from "vitest";
import {
  findPreviewRegion,
  PREVIEW_REGION_ATTRIBUTE,
  PREVIEW_REGION_SELECTOR,
} from "./previewRegion";

describe("previewRegion (ADR 063)", () => {
  it("selects the element that carries the attribute", () => {
    expect(PREVIEW_REGION_SELECTOR).toBe(`[${PREVIEW_REGION_ATTRIBUTE}]`);
    expect(PREVIEW_REGION_ATTRIBUTE).toBe("data-preview-region");
  });

  it("finds the section through the selector, and gives null without one", () => {
    const section = { tagName: "SECTION" } as unknown as Element;
    const asked: string[] = [];
    const root = {
      querySelector: (selector: string) => {
        asked.push(selector);
        return selector === PREVIEW_REGION_SELECTOR ? section : null;
      },
    };
    expect(findPreviewRegion(root)).toBe(section);
    expect(asked).toStrictEqual([PREVIEW_REGION_SELECTOR]);
    expect(findPreviewRegion({ querySelector: () => null })).toBeNull();
  });
});
