import { describe, expect, it } from "vitest";
import {
  calculateAnchorRatio,
  calculateAnchoredScrollLeft,
  calculateContentWidthPx,
  calculateFollowScrollLeft,
  calculateMaxZoom,
  calculateWheelZoomFactor,
  clampTimelineZoom,
  MAX_TIMELINE_CONTENT_WIDTH_PX,
  MAX_TIMELINE_PIXELS_PER_SECOND,
  MAX_WHEEL_DELTA_PER_EVENT_PX,
  MIN_TIMELINE_ZOOM,
  PLAYHEAD_FOLLOW_LEAD_FRACTION,
  TIMELINE_GUTTER_WIDTH_PX,
  TIMELINE_MIN_CONTENT_WIDTH_PX,
  TIMELINE_WHEEL_ZOOM_BASE,
} from "./viewport";

describe("timeline viewport module", () => {
  describe("exported constants", () => {
    it("exports expected layout and constraint constants", () => {
      expect(TIMELINE_GUTTER_WIDTH_PX).toBe(96);
      expect(TIMELINE_MIN_CONTENT_WIDTH_PX).toBe(900);
      expect(MIN_TIMELINE_ZOOM).toBe(1);
      expect(MAX_TIMELINE_CONTENT_WIDTH_PX).toBe(100_000);
      expect(MAX_TIMELINE_PIXELS_PER_SECOND).toBe(200);
      expect(TIMELINE_WHEEL_ZOOM_BASE).toBe(1.25);
      expect(MAX_WHEEL_DELTA_PER_EVENT_PX).toBe(400);
      expect(PLAYHEAD_FOLLOW_LEAD_FRACTION).toBe(0.1);
    });
  });

  describe("calculateAnchorRatio", () => {
    it("maps lane left to 0", () => {
      expect(calculateAnchorRatio(100, 100, 500)).toBe(0);
    });

    it("maps lane right to 1", () => {
      expect(calculateAnchorRatio(600, 100, 500)).toBe(1);
    });

    it("maps midpoint to 0.5", () => {
      expect(calculateAnchorRatio(350, 100, 500)).toBe(0.5);
    });

    it("clamps coordinates to the left of the lane to 0", () => {
      expect(calculateAnchorRatio(50, 100, 500)).toBe(0);
      expect(calculateAnchorRatio(0, 100, 500)).toBe(0);
    });

    it("clamps coordinates to the right of the lane to 1", () => {
      expect(calculateAnchorRatio(700, 100, 500)).toBe(1);
    });

    it("returns 0 when laneWidthPx <= 0", () => {
      expect(calculateAnchorRatio(150, 100, 0)).toBe(0);
      expect(calculateAnchorRatio(150, 100, -100)).toBe(0);
    });

    it("returns 0 on non-finite arguments", () => {
      expect(calculateAnchorRatio(Number.NaN, 100, 500)).toBe(0);
      expect(calculateAnchorRatio(150, Number.NaN, 500)).toBe(0);
      expect(calculateAnchorRatio(150, 100, Number.NaN)).toBe(0);
      expect(calculateAnchorRatio(Infinity, 100, 500)).toBe(0);
      expect(calculateAnchorRatio(150, -Infinity, 500)).toBe(0);
      expect(calculateAnchorRatio(150, 100, Infinity)).toBe(0);
    });
  });

  describe("calculateAnchoredScrollLeft", () => {
    it("leaves scrollLeft unchanged when lane rectangle and anchor are unchanged", () => {
      const scrollLeft = 200;
      const ratio = 0.5;
      const laneLeft = 96;
      const laneWidth = 1000;
      const anchorX = laneLeft + ratio * laneWidth; // 596
      const maxScrollLeft = 1500;

      const result = calculateAnchoredScrollLeft(
        scrollLeft,
        ratio,
        anchorX,
        laneLeft,
        laneWidth,
        maxScrollLeft,
      );
      expect(result).toBe(scrollLeft);
    });

    it("adds half the width when doubling lane width at ratio 0.5 with fixed lane left", () => {
      const scrollLeft = 100;
      const ratio = 0.5;
      const laneLeft = 96;
      const laneWidthBefore = 1000;
      const anchorX = laneLeft + ratio * laneWidthBefore; // 596
      const laneWidthAfter = 2000;
      const maxScrollLeft = 3000;

      const result = calculateAnchoredScrollLeft(
        scrollLeft,
        ratio,
        anchorX,
        laneLeft,
        laneWidthAfter,
        maxScrollLeft,
      );
      // Target = 100 + (96 + 0.5 * 2000) - 596 = 100 + 1096 - 596 = 600
      // That is scrollLeft (100) + half of original width (500) = 600
      expect(result).toBe(scrollLeft + 0.5 * laneWidthBefore);
    });

    it("clamps at 0 when target scrollLeft is negative", () => {
      const result = calculateAnchoredScrollLeft(10, 0.1, 800, 96, 500, 1000);
      expect(result).toBe(0);
    });

    it("clamps at maxScrollLeftPx when target exceeds maximum", () => {
      const result = calculateAnchoredScrollLeft(900, 0.9, 100, 96, 2000, 1000);
      expect(result).toBe(1000);
    });

    it("returns 0 when maxScrollLeftPx <= 0", () => {
      expect(calculateAnchoredScrollLeft(100, 0.5, 200, 96, 500, 0)).toBe(0);
      expect(calculateAnchoredScrollLeft(100, 0.5, 200, 96, 500, -50)).toBe(0);
    });

    it("returns input scrollLeft unchanged on any non-finite argument, or 0 when scrollLeft itself is non-finite", () => {
      const valid = [100, 0.5, 200, 96, 500, 1000] as const;
      expect(
        calculateAnchoredScrollLeft(
          Number.NaN,
          valid[1],
          valid[2],
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBe(0);
      expect(
        calculateAnchoredScrollLeft(
          valid[0],
          Number.NaN,
          valid[2],
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBe(100);
      expect(
        calculateAnchoredScrollLeft(
          valid[0],
          valid[1],
          Number.NaN,
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBe(100);
      expect(
        calculateAnchoredScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          Number.NaN,
          valid[4],
          valid[5],
        ),
      ).toBe(100);
      expect(
        calculateAnchoredScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          valid[3],
          Number.NaN,
          valid[5],
        ),
      ).toBe(100);
      expect(
        calculateAnchoredScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          valid[3],
          valid[4],
          Number.NaN,
        ),
      ).toBe(100);
      expect(
        calculateAnchoredScrollLeft(
          valid[0],
          Infinity,
          valid[2],
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBe(100);
    });
  });

  describe("calculateContentWidthPx", () => {
    it("calculates 1440 for zoom 1 and viewport 1440", () => {
      expect(calculateContentWidthPx(1, 1440)).toBe(1440);
    });

    it("applies the 900 floor for zoom 1 and viewport 600", () => {
      expect(calculateContentWidthPx(1, 600)).toBe(900);
    });

    it("calculates 2784 for zoom 2 and viewport 1440", () => {
      // 96 + 2 * (1440 - 96) = 96 + 2688 = 2784
      expect(calculateContentWidthPx(2, 1440)).toBe(2784);
    });

    it("is monotonically increasing in zoom", () => {
      const viewport = 1200;
      let prevWidth = calculateContentWidthPx(1, viewport);
      for (let z = 1.25; z <= 10; z += 0.25) {
        const nextWidth = calculateContentWidthPx(z, viewport);
        expect(nextWidth).toBeGreaterThan(prevWidth);
        prevWidth = nextWidth;
      }
    });

    it("handles non-finite inputs gracefully", () => {
      expect(calculateContentWidthPx(Number.NaN, 1440)).toBe(1440);
      expect(calculateContentWidthPx(1, Number.NaN)).toBe(900);
    });
  });

  describe("calculateMaxZoom", () => {
    it("returns 1 for null, undefined, NaN, 0, or negative duration", () => {
      expect(calculateMaxZoom(null, 1440)).toBe(1);
      expect(calculateMaxZoom(undefined, 1440)).toBe(1);
      expect(calculateMaxZoom(Number.NaN, 1440)).toBe(1);
      expect(calculateMaxZoom(Infinity, 1440)).toBe(1);
      expect(calculateMaxZoom(0, 1440)).toBe(1);
      expect(calculateMaxZoom(-10, 1440)).toBe(1);
    });

    it("bounds a 30-second source at 1440 by the pixels-per-second ceiling (~4.46)", () => {
      const zoom = calculateMaxZoom(30, 1440);
      // base = 1440, lane = 1344
      // ppsZoom = (200 * 30) / 1344 = 6000 / 1344 = 125 / 28 ≈ 4.4643
      // widthZoom = (100_000 - 96) / 1344 = 99_904 / 1344 ≈ 74.3333
      expect(zoom).toBeCloseTo(4.4643, 3);
    });

    it("bounds a 3-hour source at 1440 by the width ceiling (~74.33)", () => {
      const zoom = calculateMaxZoom(3 * 3600, 1440);
      // base = 1440, lane = 1344
      // ppsZoom = (200 * 10800) / 1344 ≈ 1607.14
      // widthCeiling = (100_000 - 96) / 1344 = 99_904 / 1344 ≈ 74.3333
      expect(zoom).toBeCloseTo(74.3333, 2);
    });

    it("is never below 1 even for a tiny viewport", () => {
      expect(calculateMaxZoom(0.01, 100)).toBe(1);
      expect(calculateMaxZoom(10, 50)).toBeGreaterThanOrEqual(1);
      expect(calculateMaxZoom(100, 0)).toBeGreaterThanOrEqual(1);
    });
  });

  describe("clampTimelineZoom", () => {
    it("clamps values below 1 to 1", () => {
      expect(clampTimelineZoom(0.5, 10)).toBe(1);
      expect(clampTimelineZoom(0, 10)).toBe(1);
      expect(clampTimelineZoom(-5, 10)).toBe(1);
    });

    it("clamps values above maxZoom to maxZoom", () => {
      expect(clampTimelineZoom(15, 10)).toBe(10);
      expect(clampTimelineZoom(100, 4.5)).toBe(4.5);
    });

    it("returns 1 for NaN", () => {
      expect(clampTimelineZoom(Number.NaN, 10)).toBe(1);
    });

    it("returns maxZoom for Infinity", () => {
      expect(clampTimelineZoom(Infinity, 12)).toBe(12);
    });

    it("preserves valid in-range zoom values", () => {
      expect(clampTimelineZoom(2.5, 10)).toBe(2.5);
      expect(clampTimelineZoom(1, 10)).toBe(1);
      expect(clampTimelineZoom(10, 10)).toBe(10);
    });
  });

  describe("calculateWheelZoomFactor", () => {
    it("returns 1.25 for deltaY -100 and 0.8 for deltaY +100 in pixel mode", () => {
      expect(calculateWheelZoomFactor(-100, 0)).toBeCloseTo(1.25, 6);
      expect(calculateWheelZoomFactor(100, 0)).toBeCloseTo(0.8, 6);
    });

    it("behaves as +-48 px for line mode +-3", () => {
      const factorMinus3 = calculateWheelZoomFactor(-3, 1);
      const factorMinus48Px = calculateWheelZoomFactor(-48, 0);
      expect(factorMinus3).toBeCloseTo(factorMinus48Px, 6);

      const factorPlus3 = calculateWheelZoomFactor(3, 1);
      const factorPlus48Px = calculateWheelZoomFactor(48, 0);
      expect(factorPlus3).toBeCloseTo(factorPlus48Px, 6);
    });

    it("clamps page mode +-1 to +-400", () => {
      const factorMinus1Page = calculateWheelZoomFactor(-1, 2);
      const factorMinus400Px = calculateWheelZoomFactor(-400, 0);
      expect(factorMinus1Page).toBeCloseTo(factorMinus400Px, 6);

      const factorPlus1Page = calculateWheelZoomFactor(1, 2);
      const factorPlus400Px = calculateWheelZoomFactor(400, 0);
      expect(factorPlus1Page).toBeCloseTo(factorPlus400Px, 6);
    });

    it("returns 1 for deltaY 0", () => {
      expect(calculateWheelZoomFactor(0, 0)).toBe(1);
      expect(calculateWheelZoomFactor(0, 1)).toBe(1);
    });

    it("returns 1 for NaN or non-finite deltaY", () => {
      expect(calculateWheelZoomFactor(Number.NaN, 0)).toBe(1);
      expect(calculateWheelZoomFactor(Infinity, 0)).toBe(1);
      expect(calculateWheelZoomFactor(-Infinity, 0)).toBe(1);
    });

    it("gives the same factor for a 5000 px momentum burst as 400", () => {
      const burstFactor = calculateWheelZoomFactor(-5000, 0);
      const maxFactor = calculateWheelZoomFactor(-400, 0);
      expect(burstFactor).toBe(maxFactor);
    });
  });

  describe("round-trip property test", () => {
    it("preserves the recovered anchor ratio to within 1e-9 across a sequence of zoom steps", () => {
      const viewportWidth = 1440;
      const testRatios = [0.1, 0.25, 0.5, 0.75, 0.9];
      const zoomSteps = [1.0, 1.25, 1.5625, 2.0, 2.5, 3.125, 4.0, 2.5, 1.5, 1.0];

      for (const targetRatio of testRatios) {
        let currentZoom = 1.0;
        let currentScrollLeft = 0;

        for (let i = 1; i < zoomSteps.length; i++) {
          const nextZoom = zoomSteps[i];

          // Content width and lane width before step
          const contentWidthBefore = calculateContentWidthPx(
            currentZoom,
            viewportWidth,
          );
          const laneWidthBefore = contentWidthBefore - TIMELINE_GUTTER_WIDTH_PX;
          const laneClientLeftBefore = TIMELINE_GUTTER_WIDTH_PX - currentScrollLeft;
          const anchorClientX = laneClientLeftBefore + targetRatio * laneWidthBefore;

          // React commits the new width to DOM
          const contentWidthAfter = calculateContentWidthPx(nextZoom, viewportWidth);
          const laneWidthAfter = contentWidthAfter - TIMELINE_GUTTER_WIDTH_PX;
          const maxScrollLeft = contentWidthAfter - viewportWidth;

          // laneClientLeft measured before scrollLeft write is unchanged from laneClientLeftBefore
          const laneClientLeftAfter = laneClientLeftBefore;

          // Calculate new scrollLeft
          const nextScrollLeft = calculateAnchoredScrollLeft(
            currentScrollLeft,
            targetRatio,
            anchorClientX,
            laneClientLeftAfter,
            laneWidthAfter,
            maxScrollLeft,
          );

          // Apply new scrollLeft
          currentScrollLeft = nextScrollLeft;
          currentZoom = nextZoom;

          // New lane client position after scrollLeft update
          const laneClientLeftNew = TIMELINE_GUTTER_WIDTH_PX - currentScrollLeft;
          const recoveredRatio = calculateAnchorRatio(
            anchorClientX,
            laneClientLeftNew,
            laneWidthAfter,
          );

          expect(Math.abs(recoveredRatio - targetRatio)).toBeLessThan(1e-9);
        }
      }
    });
  });

  describe("calculateFollowScrollLeft", () => {
    it("returns null when the playhead is in the middle of the visible window", () => {
      // laneLeftOffsetPx = 96, laneWidthPx = 1000
      // playheadContentX = 96 + 0.5 * 1000 = 596
      // scrollLeftPx = 200, viewportWidthPx = 1000 -> visible range [296, 1200]
      expect(calculateFollowScrollLeft(50, 1000, 96, 200, 1000, 0.1)).toBeNull();
    });

    it("returns null when the playhead is exactly at the left edge or exactly at the right edge (inclusive)", () => {
      // laneLeftOffsetPx = 100, laneWidthPx = 1000, scrollLeftPx = 300, viewportWidthPx = 500
      // Visible range: [scrollLeft + laneLeftOffset, scrollLeft + viewportWidth] = [400, 800]
      // Exactly at left edge (playheadContentX = 400):
      // 100 + (percent / 100) * 1000 = 400 => percent = 30
      expect(calculateFollowScrollLeft(30, 1000, 100, 300, 500, 0.1)).toBeNull();

      // Exactly at right edge (playheadContentX = 800):
      // 100 + (percent / 100) * 1000 = 800 => percent = 70
      expect(calculateFollowScrollLeft(70, 1000, 100, 300, 500, 0.1)).toBeNull();

      // Behind the sticky gutter (playheadContentX = 300 < 400): occluded, so follow is needed
      expect(calculateFollowScrollLeft(20, 1000, 100, 300, 500, 0.1)).not.toBeNull();
    });

    it("returns a scrollLeft that puts the playhead at the lead fraction when past the right edge", () => {
      // laneLeftOffsetPx = 100, laneWidthPx = 1000, playheadPercent = 80
      // playheadContentX = 100 + 0.8 * 1000 = 900
      // scrollLeftPx = 200, viewportWidthPx = 500 -> visible range [300, 700]
      // Past right edge: 900 > 700
      // leadOffset = Math.max(laneLeftOffsetPx, leadFraction * viewportWidthPx) = Math.max(100, 50) = 100
      // targetScrollLeft = 900 - 100 = 800 (gutter clamp ensures playhead clears 100px gutter)
      const result = calculateFollowScrollLeft(80, 1000, 100, 200, 500, 0.1);
      expect(result).toBe(800);
      expect(900 - result!).toBe(Math.max(100, 0.1 * 500));

      // When leadFraction * viewportWidthPx > laneLeftOffsetPx:
      // laneWidthPx = 2000, playheadPercent = 90 -> playheadContentX = 100 + 0.9 * 2000 = 1900
      // scrollLeftPx = 200, viewportWidthPx = 1500 -> visible range [300, 1700]
      // Past right edge: 1900 > 1700
      // leadOffset = Math.max(100, 0.1 * 1500) = 150
      // targetScrollLeft = 1900 - 150 = 1750
      const wideResult = calculateFollowScrollLeft(90, 2000, 100, 200, 1500, 0.1);
      expect(wideResult).toBe(1750);
      expect(1900 - wideResult!).toBe(0.1 * 1500);
    });

    it("returns a scrollLeft that puts the playhead at the lead fraction when before the left edge", () => {
      // laneLeftOffsetPx = 100, laneWidthPx = 1000, playheadPercent = 10
      // playheadContentX = 100 + 0.1 * 1000 = 200
      // scrollLeftPx = 500, viewportWidthPx = 500 -> visible range [600, 1000]
      // Before left edge: 200 < 600
      // leadOffset = Math.max(100, 0.1 * 500) = 100
      // targetScrollLeft = 200 - 100 = 100
      const result = calculateFollowScrollLeft(10, 1000, 100, 500, 500, 0.1);
      expect(result).toBe(100);
      expect(200 - result!).toBe(Math.max(100, 0.1 * 500));

      // When leadFraction * viewportWidthPx > laneLeftOffsetPx:
      // viewportWidthPx = 1500, scrollLeftPx = 1500 -> visible range [1600, 3000]
      // Before left edge: 200 < 1600
      // leadOffset = Math.max(100, 0.1 * 1500) = 150
      // targetScrollLeft = 200 - 150 = 50
      const wideResult = calculateFollowScrollLeft(10, 1000, 100, 1500, 1500, 0.1);
      expect(wideResult).toBe(50);
      expect(200 - wideResult!).toBe(0.1 * 1500);
    });

    it("clamps the returned scrollLeft so it never goes below 0", () => {
      // laneLeftOffsetPx = 0, laneWidthPx = 1000, playheadPercent = 1
      // playheadContentX = 10
      // scrollLeftPx = 100, viewportWidthPx = 500 -> visible range [100, 600]
      // Before left edge: 10 < 100
      // targetScrollLeft before clamp: 10 - 0.1 * 500 = -40 -> clamped to 0
      const result = calculateFollowScrollLeft(1, 1000, 0, 100, 500, 0.1);
      expect(result).toBe(0);
    });

    it("returns null for playhead at percent 0 with scrollLeft 0", () => {
      // laneLeftOffsetPx = 96, laneWidthPx = 1000, viewportWidthPx = 1000
      // playheadContentX = 96, scrollLeftPx = 0 -> visible range [96, 1000]
      expect(calculateFollowScrollLeft(0, 1000, 96, 0, 1000, 0.1)).toBeNull();

      // Also when laneLeftOffsetPx is 0: playheadContentX = 0, exactly at left edge of [0, 1000]
      expect(calculateFollowScrollLeft(0, 1000, 0, 0, 1000, 0.1)).toBeNull();
    });

    it("returns null for every invalid input", () => {
      const valid = [50, 1000, 96, 0, 500, 0.1] as const;

      // Non-finite playheadPercent
      expect(
        calculateFollowScrollLeft(
          Number.NaN,
          valid[1],
          valid[2],
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          Infinity,
          valid[1],
          valid[2],
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          -Infinity,
          valid[1],
          valid[2],
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBeNull();

      // Non-finite or non-positive laneWidthPx
      expect(
        calculateFollowScrollLeft(
          valid[0],
          Number.NaN,
          valid[2],
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          Infinity,
          valid[2],
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          -Infinity,
          valid[2],
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(valid[0], 0, valid[2], valid[3], valid[4], valid[5]),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          -100,
          valid[2],
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBeNull();

      // Non-finite laneLeftOffsetPx
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          Number.NaN,
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          Infinity,
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          -Infinity,
          valid[3],
          valid[4],
          valid[5],
        ),
      ).toBeNull();

      // Non-finite scrollLeftPx
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          Number.NaN,
          valid[4],
          valid[5],
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          Infinity,
          valid[4],
          valid[5],
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          -Infinity,
          valid[4],
          valid[5],
        ),
      ).toBeNull();

      // Non-finite or non-positive viewportWidthPx
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          valid[3],
          Number.NaN,
          valid[5],
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          valid[3],
          Infinity,
          valid[5],
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          valid[3],
          -Infinity,
          valid[5],
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(valid[0], valid[1], valid[2], valid[3], 0, valid[5]),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          valid[3],
          -500,
          valid[5],
        ),
      ).toBeNull();

      // Non-finite or out-of-range leadFraction
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          valid[3],
          valid[4],
          Number.NaN,
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          valid[3],
          valid[4],
          Infinity,
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          valid[3],
          valid[4],
          -Infinity,
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          valid[3],
          valid[4],
          -0.01,
        ),
      ).toBeNull();
      expect(
        calculateFollowScrollLeft(
          valid[0],
          valid[1],
          valid[2],
          valid[3],
          valid[4],
          1.01,
        ),
      ).toBeNull();
    });

    it("accepts valid boundary values 0 and 1 for leadFraction", () => {
      // Playhead outside visible window:
      // laneLeftOffsetPx = 96, laneWidthPx = 1000, playheadPercent = 80
      // playheadContentX = 96 + 0.8 * 1000 = 896
      // scrollLeftPx = 0, viewportWidthPx = 500 -> visible range [96, 500]
      // 896 > 500 (past right edge)

      // leadFraction = 0: leadPx = Math.max(96, 0 * 500) = 96 -> target = 896 - 96 = 800
      expect(calculateFollowScrollLeft(80, 1000, 96, 0, 500, 0)).toBe(800);

      // leadFraction = 1: leadPx = Math.max(96, 1 * 500) = 500 -> target = 896 - 500 = 396
      expect(calculateFollowScrollLeft(80, 1000, 96, 0, 500, 1)).toBe(396);
    });

    it("satisfies round trip: applying the returned scrollLeft places the playhead inside the window at the lead fraction or gutter offset within 1e-9", () => {
      const cases = [
        // Past right edge cases
        {
          percent: 80,
          laneWidth: 3000,
          laneOffset: 96,
          scrollLeft: 0,
          viewportWidth: 1000,
          leadFraction: 0.1,
        },
        {
          percent: 95,
          laneWidth: 5000,
          laneOffset: 96,
          scrollLeft: 1000,
          viewportWidth: 1200,
          leadFraction: 0.15,
        },
        // Before left edge cases
        {
          percent: 15,
          laneWidth: 4000,
          laneOffset: 96,
          scrollLeft: 2000,
          viewportWidth: 800,
          leadFraction: 0.1,
        },
        {
          percent: 5,
          laneWidth: 10000,
          laneOffset: 96,
          scrollLeft: 3000,
          viewportWidth: 1440,
          leadFraction: 0.2,
        },
      ];

      for (const tc of cases) {
        const playheadContentX = tc.laneOffset + (tc.percent / 100) * tc.laneWidth;
        const newScrollLeft = calculateFollowScrollLeft(
          tc.percent,
          tc.laneWidth,
          tc.laneOffset,
          tc.scrollLeft,
          tc.viewportWidth,
          tc.leadFraction,
        );

        expect(newScrollLeft).not.toBeNull();
        const scrollLeft = newScrollLeft!;

        // The playhead is inside the visible window (accounting for sticky gutter occlusion)
        expect(playheadContentX).toBeGreaterThanOrEqual(scrollLeft + tc.laneOffset);
        expect(playheadContentX).toBeLessThanOrEqual(scrollLeft + tc.viewportWidth);

        // The playhead lands at Math.max(laneOffset, leadFraction * viewportWidth) within 1e-9
        const expectedLeadPx = Math.max(
          tc.laneOffset,
          tc.leadFraction * tc.viewportWidth,
        );
        const actualLeadPx = playheadContentX - scrollLeft;
        expect(Math.abs(actualLeadPx - expectedLeadPx)).toBeLessThan(1e-9);
      }
    });
  });
});
