import { describe, expect, it } from "vitest";
import {
  calculatePendingInRegionLayoutFromSeconds,
  calculatePlayheadLayout,
} from "@/features/timeline";
import type { Pts } from "@/types/project";
import {
  PENDING_IN_REGION_BORDER_PX,
  calculatePendingInRegionBox,
} from "./pendingInGeometry";

const pts = (value: string) => value as Pts;

/**
 * Resolves a CSS length of the forms that the geometry gives, `P%` and `calc(P% ± Npx)`,
 * against a lane width, as the layout engine does before it rounds to its layout unit.
 */
function resolveLength(value: string, laneWidthPx: number): number {
  const percent = /^(-?[\d.e+-]+)%$/.exec(value);
  if (percent) {
    return (Number(percent[1]) / 100) * laneWidthPx;
  }
  const calc = /^calc\((-?[\d.e+-]+)% ([+-]) ([\d.]+)px\)$/.exec(value);
  if (!calc) {
    throw new Error(`not a supported length: ${value}`);
  }
  const offsetPx = Number(calc[3]) * (calc[2] === "-" ? -1 : 1);
  return (Number(calc[1]) / 100) * laneWidthPx + offsetPx;
}

describe("calculatePendingInRegionBox", () => {
  it("starts one pixel before the In boundary and is two pixels wider", () => {
    expect(calculatePendingInRegionBox({ left: "25%", width: "50%" })).toEqual({
      left: "calc(25% - 1px)",
      width: "calc(50% + 2px)",
    });
  });

  it("keeps the percentages as they are, also at the lane start", () => {
    expect(calculatePendingInRegionBox({ left: "0%", width: "100%" })).toEqual({
      left: "calc(0% - 1px)",
      width: "calc(100% + 2px)",
    });
    expect(calculatePendingInRegionBox({ left: "12.5%", width: "1e-7%" })).toEqual({
      left: "calc(12.5% - 1px)",
      width: "calc(1e-7% + 2px)",
    });
  });

  describe("on a lane", () => {
    const timeBase = { n: 1, d: 1000 };
    const start = pts("-1000");
    const totalDurationSeconds = 2;
    // The In boundary at PTS -500 is 0.5 s into a 2 s source.
    const inPts = pts("-500");

    it.each([
      [1000, 1.5],
      [900, 1.25],
      [137_381, 0.5004],
    ])(
      "centres both borders on the In and on the playhead (lane %d px, playhead at %s s)",
      (laneWidthPx, displayedSeconds) => {
        const layout = calculatePendingInRegionLayoutFromSeconds(
          inPts,
          displayedSeconds,
          start,
          timeBase,
          totalDurationSeconds,
        );
        if (!layout?.isVisible) {
          throw new Error("the region must be visible");
        }
        const box = calculatePendingInRegionBox(layout);
        const boxLeft = resolveLength(box.left, laneWidthPx);
        const boxRight = boxLeft + resolveLength(box.width, laneWidthPx);

        const inPx = resolveLength(layout.left, laneWidthPx);
        // The playhead line covers one pixel on each side of its position.
        const playheadPx = resolveLength(
          calculatePlayheadLayout(displayedSeconds, totalDurationSeconds).left,
          laneWidthPx,
        );

        // The left border covers [In - 1px, In + 1px].
        expect(boxLeft).toBeCloseTo(inPx - 1, 6);
        expect(boxLeft + PENDING_IN_REGION_BORDER_PX).toBeCloseTo(inPx + 1, 6);
        // The right border covers the pixels of the playhead line.
        expect(boxRight - PENDING_IN_REGION_BORDER_PX).toBeCloseTo(playheadPx - 1, 6);
        expect(boxRight).toBeCloseTo(playheadPx + 1, 6);
      },
    );
  });
});
