import { describe, expect, it } from "vitest";
import type { ClipBarLayout } from "@/components/timeline/clipBarLayout";
import { junctionAt } from "./fileDropTarget";

const layouts: ClipBarLayout[] = [
  { clipId: "a", sourceId: "A", index: 0, leftPercent: 0, widthPercent: 50 },
  { clipId: "b", sourceId: "B", index: 1, leftPercent: 50, widthPercent: 30 },
  { clipId: "c", sourceId: "C", index: 2, leftPercent: 80, widthPercent: 20 },
];

describe("junctionAt", () => {
  it("goes before a clip on its left half and after it on its right half", () => {
    expect(junctionAt(10, layouts)).toEqual({ junction: 0, leftPercent: 0 });
    expect(junctionAt(30, layouts)).toEqual({ junction: 1, leftPercent: 50 });
    expect(junctionAt(60, layouts)).toEqual({ junction: 1, leftPercent: 50 });
    expect(junctionAt(70, layouts)).toEqual({ junction: 2, leftPercent: 80 });
    expect(junctionAt(95, layouts)).toEqual({ junction: 3, leftPercent: 100 });
  });

  it("gives the last junction past the end, and nothing without clips", () => {
    expect(junctionAt(120, layouts)).toEqual({ junction: 3, leftPercent: 100 });
    expect(junctionAt(10, [])).toBeNull();
    expect(junctionAt(Number.NaN, layouts)).toBeNull();
  });
});
