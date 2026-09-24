import { describe, expect, it } from "vitest";
import {
  calculateAnchorRatio,
  calculateAnchoredScrollLeft,
  calculateContentWidthPx,
  calculateFollowScrollLeft,
  calculateMaxZoom,
  calculatePausedFollow,
  calculatePendingNavigation,
  calculatePlaybackFollow,
  calculateWheelZoomFactor,
  clampScrollLeftToFollowWindow,
  clampTimelineZoom,
  resolvePlayheadOrCentreAnchor,
  settleTimelineZoom,
  shouldWriteFollowScrollLeft,
  stepTimelineZoom,
  FOLLOW_WINDOW_MARGIN_PX,
  FOLLOW_WRITE_TOLERANCE_PX,
  MAX_TIMELINE_CONTENT_WIDTH_PX,
  MAX_TIMELINE_PIXELS_PER_SECOND,
  MAX_WHEEL_DELTA_PER_EVENT_PX,
  MIN_TIMELINE_ZOOM,
  PLAYHEAD_FOLLOW_LEAD_FRACTION,
  TIMELINE_GUTTER_WIDTH_PX,
  TIMELINE_MIN_CONTENT_WIDTH_PX,
  TIMELINE_WHEEL_ZOOM_BASE,
  TIMELINE_ZOOM_STEP_FACTOR,
  type PausedFollowInput,
  type PlaybackFollowInput,
  type PlayheadOrCentreAnchor,
  type TimelineZoomAnchorPoint,
} from "./viewport";

/**
 * The scrollLeft that the panel writes after it commits a zoom to `nextZoom`, measured the way
 * the panel measures it: the scroll container at client x 0, with the browser clamp of the old
 * scrollLeft to the new range already applied.
 */
function applyAnchorAfterCommit(
  point: TimelineZoomAnchorPoint,
  nextZoom: number,
  viewportWidthPx: number,
  scrollLeftBeforePx: number,
): number {
  const contentWidthPx = calculateContentWidthPx(nextZoom, viewportWidthPx);
  const maxScrollLeftPx = contentWidthPx - viewportWidthPx;
  const scrollLeftNowPx = Math.min(scrollLeftBeforePx, maxScrollLeftPx);
  return calculateAnchoredScrollLeft(
    scrollLeftNowPx,
    point.ratio,
    point.viewportOffsetPx,
    TIMELINE_GUTTER_WIDTH_PX - scrollLeftNowPx,
    contentWidthPx - TIMELINE_GUTTER_WIDTH_PX,
    maxScrollLeftPx,
  );
}

/**
 * The scrollLeft that the panel writes after a zoom from a key or a button: the anchored
 * value, and for a held playhead the clamp into the follow's window, then the scroll range.
 * The DOM geometry uses the fractional width, and the follow uses the rounded one.
 */
function zoomLikeThePanel(
  anchor: PlayheadOrCentreAnchor,
  nextZoom: number,
  fractionalWidthPx: number,
  followWidthPx: number,
  scrollLeftBeforePx: number,
): number {
  const anchored = applyAnchorAfterCommit(
    anchor,
    nextZoom,
    fractionalWidthPx,
    scrollLeftBeforePx,
  );
  if (anchor.heldPlayheadPercent === null) {
    return anchored;
  }
  const maxScrollLeftPx = Math.max(
    0,
    calculateContentWidthPx(nextZoom, fractionalWidthPx) - fractionalWidthPx,
  );
  const inFollowWindow = clampScrollLeftToFollowWindow({
    scrollLeftPx: anchored,
    playheadPercent: anchor.heldPlayheadPercent,
    zoom: nextZoom,
    followViewportWidthPx: followWidthPx,
  });
  return Math.max(0, Math.min(maxScrollLeftPx, inFollowWindow));
}

/** True when the playback follow sees the playhead, with the inputs the panel gives it. */
function followSees(
  playheadPercent: number,
  zoom: number,
  followWidthPx: number,
  scrollLeftPx: number,
): boolean {
  return (
    calculateFollowScrollLeft(
      playheadPercent,
      calculateContentWidthPx(zoom, followWidthPx) - TIMELINE_GUTTER_WIDTH_PX,
      TIMELINE_GUTTER_WIDTH_PX,
      scrollLeftPx,
      followWidthPx,
      PLAYHEAD_FOLLOW_LEAD_FRACTION,
    ) === null
  );
}

/** The distance of a ratio of the extent from the left edge of the viewport. */
function viewportOffsetOf(
  ratio: number,
  zoom: number,
  viewportWidthPx: number,
  scrollLeftPx: number,
): number {
  const laneWidthPx =
    calculateContentWidthPx(zoom, viewportWidthPx) - TIMELINE_GUTTER_WIDTH_PX;
  return TIMELINE_GUTTER_WIDTH_PX + ratio * laneWidthPx - scrollLeftPx;
}

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

  describe("calculatePendingNavigation", () => {
    it("reports no navigation and clears the record when no seek is pending", () => {
      expect(calculatePendingNavigation(null, null)).toEqual({
        isNavigationPending: false,
        nextRecordedTarget: null,
      });
      expect(calculatePendingNavigation(null, 12.5)).toEqual({
        isNavigationPending: false,
        nextRecordedTarget: null,
      });
    });

    it("reports no navigation and keeps the record while the pending target is the gesture's", () => {
      expect(calculatePendingNavigation(12.5, 12.5)).toEqual({
        isNavigationPending: false,
        nextRecordedTarget: 12.5,
      });
    });

    it("reports a navigation and clears the record when another request replaced the target", () => {
      expect(calculatePendingNavigation(12.6, 12.5)).toEqual({
        isNavigationPending: true,
        nextRecordedTarget: null,
      });
      expect(calculatePendingNavigation(12.6, null)).toEqual({
        isNavigationPending: true,
        nextRecordedTarget: null,
      });
    });
  });

  describe("calculatePlaybackFollow", () => {
    // The lane of calculatePausedFollow: 10,000 px for a 100 s source behind a 1,000 px
    // viewport and the 96 px gutter. At scrollLeft 0 the visible content range is [96, 1000].
    const base: PlaybackFollowInput = {
      isPlaying: true,
      isGestureActive: false,
      isUserScrolled: false,
      playheadPercent: 20,
      laneWidthPx: 10_000,
      laneLeftOffsetPx: 96,
      scrollLeftPx: 0,
      viewportWidthPx: 1000,
      leadFraction: 0.1,
    };

    it("pages when playback moves the playhead out of view", () => {
      expect(calculatePlaybackFollow(base)).toEqual({
        kind: "page",
        scrollLeftPx: 96 + 2000 - 100,
      });
    });

    it("does not page during a drag, which owns the view", () => {
      expect(calculatePlaybackFollow({ ...base, isGestureActive: true })).toEqual({
        kind: "idle",
      });
      // Not even to end a pan suspension for a playhead in view.
      expect(
        calculatePlaybackFollow({ ...base, isGestureActive: true, playheadPercent: 5 }),
      ).toEqual({ kind: "idle" });
    });

    it("does nothing while playback is stopped or the view has no width", () => {
      expect(calculatePlaybackFollow({ ...base, isPlaying: false })).toEqual({
        kind: "idle",
      });
      expect(calculatePlaybackFollow({ ...base, viewportWidthPx: 0 })).toEqual({
        kind: "idle",
      });
      expect(calculatePlaybackFollow({ ...base, viewportWidthPx: Number.NaN })).toEqual(
        {
          kind: "idle",
        },
      );
    });

    it("reports a playhead in view, which ends a pan suspension", () => {
      expect(
        calculatePlaybackFollow({ ...base, playheadPercent: 5, isUserScrolled: true }),
      ).toEqual({ kind: "visible" });
    });

    it("leaves a view that the user panned", () => {
      expect(calculatePlaybackFollow({ ...base, isUserScrolled: true })).toEqual({
        kind: "suspended",
      });
    });
  });

  describe("calculatePausedFollow", () => {
    // A zoomed lane: 10,000 px of lane for a 100 s source, behind a 1,000 px viewport and the
    // 96 px gutter. At 100 px/s the position in seconds equals the percent. At scrollLeft 0
    // the visible content range is [96, 1000].
    const base: PausedFollowInput = {
      playheadPercent: 9,
      elapsedSeconds: 9,
      previousElapsedSeconds: 9,
      isNavigationPending: true,
      isGestureActive: false,
      laneWidthPx: 10_000,
      laneLeftOffsetPx: 96,
      scrollLeftPx: 0,
      viewportWidthPx: 1000,
      leadFraction: 0.1,
    };

    /** A move from `from` to `to` seconds on the 100 s source of `base`. */
    const move = (from: number, to: number) => ({
      playheadPercent: to,
      elapsedSeconds: to,
      previousElapsedSeconds: from,
    });

    it("pages when a navigation moves the playhead out of view while paused", () => {
      // previous: 96 + 900 = 996 (visible). Now: 96 + 910 = 1006 > 1000 (past the right edge).
      const decision = calculatePausedFollow({ ...base, ...move(9, 9.1) });

      expect(decision.isNavigation).toBe(true);
      // The paging of playback: the playhead lands max(96, 0.1 * 1000) = 100 px from the left.
      expect(decision.scrollLeftPx).not.toBeNull();
      expect(decision.scrollLeftPx!).toBeCloseTo(906, 9);
      expect(decision.scrollLeftPx).toBe(
        calculateFollowScrollLeft(9.1, 10_000, 96, 0, 1000, 0.1),
      );
    });

    it("reports a navigation that stays in view, and leaves the view where it is", () => {
      const decision = calculatePausedFollow({ ...base, ...move(5, 5.1) });
      expect(decision).toEqual({ isNavigation: true, scrollLeftPx: null });
    });

    it("does not page after a zoom that changed only the geometry", () => {
      // The playhead at 50% is at 96 + 5000 = 5096 after the zoom, far past the right edge,
      // and a seek is still pending. The position did not change, so the view stays.
      expect(calculateFollowScrollLeft(50, 10_000, 96, 0, 1000, 0.1)).not.toBeNull();
      expect(calculatePausedFollow({ ...base, ...move(50, 50) })).toEqual({
        isNavigation: false,
        scrollLeftPx: null,
      });
    });

    it("does not page when only the source extent changed while a seek is pending", () => {
      // The runtime duration arrives and the percent of the playhead changes from 9 to 45,
      // which is out of view. The position in seconds is still 9, so it is not a move.
      expect(calculateFollowScrollLeft(45, 10_000, 96, 0, 1000, 0.1)).not.toBeNull();
      const decision = calculatePausedFollow({
        ...base,
        playheadPercent: 45,
        elapsedSeconds: 9,
        previousElapsedSeconds: 9,
      });
      expect(decision).toEqual({ isNavigation: false, scrollLeftPx: null });
    });

    it("does not page while a pointer gesture is active", () => {
      const decision = calculatePausedFollow({
        ...base,
        ...move(9, 20),
        isGestureActive: true,
      });
      expect(decision).toEqual({ isNavigation: false, scrollLeftPx: null });
    });

    it("does not undo a manual scroll when the position did not change", () => {
      // The user scrolled to 3000, so the visible range is [3096, 4000], and the playhead at
      // 96 + 500 = 596 is out of view. No position change, so the view stays where it is,
      // with or without a pending seek.
      for (const isNavigationPending of [false, true]) {
        const decision = calculatePausedFollow({
          ...base,
          ...move(5, 5),
          scrollLeftPx: 3000,
          isNavigationPending,
        });
        expect(decision).toEqual({ isNavigation: false, scrollLeftPx: null });
      }
    });

    it("does not page for a position change with no pending navigation", () => {
      // A seek that settles, or the last frame after a pause, moves the displayed position with
      // no pending seek target. That is not a navigation, so a pan by the user survives it.
      const decision = calculatePausedFollow({
        ...base,
        ...move(9, 9.1),
        isNavigationPending: false,
      });
      expect(decision).toEqual({ isNavigation: false, scrollLeftPx: null });
    });

    it("does not page for a non-finite position", () => {
      const cases: Array<[number, number]> = [
        [Number.NaN, 9.1],
        [9, Number.NaN],
        [9, Infinity],
      ];
      for (const [from, to] of cases) {
        const decision = calculatePausedFollow({
          ...base,
          playheadPercent: 9.1,
          elapsedSeconds: to,
          previousElapsedSeconds: from,
        });
        expect(decision).toEqual({ isNavigation: false, scrollLeftPx: null });
      }
    });

    it("brings the playhead back after a manual scroll when a navigation moves it", () => {
      // The user scrolled to 3000 (visible range [3096, 4000]). A step moves the playhead from
      // 596 to 606, still out of view, so the view pages to it.
      const decision = calculatePausedFollow({
        ...base,
        ...move(5, 5.1),
        scrollLeftPx: 3000,
      });
      expect(decision.isNavigation).toBe(true);
      expect(decision.scrollLeftPx!).toBeCloseTo(606 - 100, 9);
    });

    it("mirrors the lead for a backward move, so the frames before the playhead are in view", () => {
      // Visible range at scrollLeft 2000: [2096, 3000]. A step back moves the playhead from
      // 96 + 2005 = 2101 to 96 + 1995 = 2091, behind the gutter. The playhead lands
      // max(96, 0.9 * 1000) = 900 px from the left edge of the viewport.
      const decision = calculatePausedFollow({
        ...base,
        ...move(20.05, 19.95),
        scrollLeftPx: 2000,
      });
      expect(decision.isNavigation).toBe(true);
      expect(decision.scrollLeftPx!).toBeCloseTo(2091 - 900, 9);
      expect(decision.scrollLeftPx).toBe(
        calculateFollowScrollLeft(19.95, 10_000, 96, 2000, 1000, 0.9),
      );
    });

    describe("with the gesture filter of calculatePendingNavigation", () => {
      // One render of the timeline: the pending-navigation filter, then the paused follow.
      // `recorded` is the gesture target that the component holds. Each render returns the
      // record for the next render, as the component writes it back.
      const render = (
        recorded: number | null,
        seekTargetSeconds: number | null,
        from: number,
        to: number,
        isGestureActive: boolean,
      ) => {
        const pending = calculatePendingNavigation(seekTargetSeconds, recorded);
        const decision = calculatePausedFollow({
          ...base,
          ...move(from, to),
          isNavigationPending: pending.isNavigationPending,
          isGestureActive,
        });
        return { recorded: pending.nextRecordedTarget, decision };
      };
      const noPage = { isNavigation: false, scrollLeftPx: null };

      it("does not page for a drag released past the edge or for the settle of its seek", () => {
        // The drag moves to 9.5 s, past the edge: the playhead is at 1046 and the visible
        // range is [96, 1000].
        let step = render(9.5, 9.5, 5, 9.5, true);
        expect(step.decision).toEqual(noPage);
        // Release: the exact seek goes to 9.6 s. The gesture has ended, and the recorded
        // target (9.6) is the one that seekFromClientX wrote for that seek.
        step = render(9.6, 9.6, 9.5, 9.6, false);
        expect(step.decision).toEqual(noPage);
        expect(step.recorded).toBe(9.6);
        // The seek settles: the target clears, and the playhead moves to the presented frame.
        step = render(step.recorded, null, 9.6, 9.58, false);
        expect(step.decision).toEqual(noPage);
        expect(step.recorded).toBeNull();
      });

      it("pages for a frame step while the seek of the drag is still pending", () => {
        // The release left 9.6 s recorded, and the step replaces the pending target.
        const step = render(9.6, 9.65, 9.6, 9.65, false);
        expect(step.decision.isNavigation).toBe(true);
        expect(step.decision.scrollLeftPx).not.toBeNull();
        expect(step.recorded).toBeNull();
      });

      it("pages for a later request that lands on the value of a cleared gesture target", () => {
        // The drag released at 9.6 s, and its seek settled on 9.58 s, which cleared the record.
        const settled = render(9.6, null, 9.6, 9.58, false);
        expect(settled.recorded).toBeNull();
        // A later request lands exactly on 9.6 s again. It is a navigation.
        const step = render(settled.recorded, 9.6, 9.58, 9.6, false);
        expect(step.decision.isNavigation).toBe(true);
        expect(step.decision.scrollLeftPx).not.toBeNull();
      });
    });

    it("pages once per window, and not once per step, for held frame steps in both directions", () => {
      // 200 px/s at 24 fps: a frame is 200 / 24 px wide. The lane holds 60 s of source.
      const fps = 24;
      const durationSeconds = 60;
      const laneWidthPx = 200 * durationSeconds;
      const viewportWidthPx = 1000;
      const laneLeftOffsetPx = 96;
      const maxScrollLeftPx = laneLeftOffsetPx + laneWidthPx - viewportWidthPx;
      const frameCount = fps * durationSeconds;
      const secondsOf = (frame: number) => frame / fps;
      const percentOf = (frame: number) => (frame / frameCount) * 100;

      const run = (frames: number[], initialScrollLeftPx: number) => {
        let scrollLeftPx = initialScrollLeftPx;
        let pages = 0;
        for (let i = 1; i < frames.length; i++) {
          const decision = calculatePausedFollow({
            playheadPercent: percentOf(frames[i]),
            elapsedSeconds: secondsOf(frames[i]),
            previousElapsedSeconds: secondsOf(frames[i - 1]),
            isNavigationPending: true,
            isGestureActive: false,
            laneWidthPx,
            laneLeftOffsetPx,
            scrollLeftPx,
            viewportWidthPx,
            leadFraction: 0.1,
          });
          if (decision.scrollLeftPx !== null) {
            pages++;
            scrollLeftPx = Math.min(decision.scrollLeftPx, maxScrollLeftPx);
          }
          // The playhead is in view after every step.
          const x = laneLeftOffsetPx + (percentOf(frames[i]) / 100) * laneWidthPx;
          expect(x).toBeGreaterThanOrEqual(scrollLeftPx + laneLeftOffsetPx);
          expect(x).toBeLessThanOrEqual(scrollLeftPx + viewportWidthPx);
        }
        return pages;
      };

      const forward = Array.from({ length: frameCount + 1 }, (_, i) => i);
      const backward = [...forward].reverse();

      // One window shows roughly (1000 - 96) / (200 / 24) = 108 frames, and a page puts the
      // playhead 10% from the leading edge, so a page covers roughly 96 frames or more.
      const forwardPages = run(forward, 0);
      const backwardPages = run(backward, maxScrollLeftPx);
      expect(forwardPages).toBeGreaterThan(0);
      expect(backwardPages).toBeGreaterThan(0);
      expect(forwardPages).toBeLessThanOrEqual(Math.ceil(frameCount / 90));
      expect(backwardPages).toBeLessThanOrEqual(Math.ceil(frameCount / 90));
    });
  });

  describe("settleTimelineZoom and stepTimelineZoom", () => {
    it("steps by the zoom of one 100px wheel notch", () => {
      expect(TIMELINE_ZOOM_STEP_FACTOR).toBe(TIMELINE_WHEEL_ZOOM_BASE);
      expect(TIMELINE_ZOOM_STEP_FACTOR).toBe(1 / calculateWheelZoomFactor(100, 0));
      expect(stepTimelineZoom(1, "in", 8)).toBe(1.25);
      expect(stepTimelineZoom(2, "out", 8)).toBe(1.6);
    });

    it("clamps a step to 1 and to the maximum", () => {
      expect(stepTimelineZoom(1, "out", 8)).toBe(1);
      expect(stepTimelineZoom(1.1, "out", 8)).toBe(1);
      expect(stepTimelineZoom(7, "in", 8)).toBe(8);
      expect(stepTimelineZoom(8, "in", 8)).toBe(8);
      // An indeterminate extent has a ceiling of 1.
      expect(stepTimelineZoom(1, "in", 1)).toBe(1);
    });

    it("snaps a rounding error next to a bound to that bound", () => {
      expect(settleTimelineZoom(1 + 1e-12, 8)).toBe(1);
      expect(settleTimelineZoom(8 - 1e-12, 8)).toBe(8);
      expect(settleTimelineZoom(1.001, 8)).toBe(1.001);
      // Wheel factors that are not powers of the step return to exactly 1.
      let zoom = 1;
      for (const factor of [1.07, 1.3, 1.11, 1.02]) {
        zoom = settleTimelineZoom(zoom * factor, 8);
      }
      for (const factor of [1.02, 1.11, 1.3, 1.07]) {
        zoom = settleTimelineZoom(zoom / factor, 8);
      }
      expect(zoom).toBe(1);
    });

    it("returns to exactly 1 after the same number of steps in and out", () => {
      let zoom = 1;
      for (let i = 0; i < 12; i++) zoom = stepTimelineZoom(zoom, "in", 1000);
      for (let i = 0; i < 12; i++) zoom = stepTimelineZoom(zoom, "out", 1000);
      expect(zoom).toBe(1);
    });

    it("treats a zoom that is not finite as 1, and an invalid maximum as 1", () => {
      expect(stepTimelineZoom(Number.NaN, "in", 8)).toBe(1.25);
      expect(settleTimelineZoom(Number.NaN, 8)).toBe(1);
      expect(settleTimelineZoom(4, Number.NaN)).toBe(1);
    });
  });

  describe("resolvePlayheadOrCentreAnchor", () => {
    const viewportWidthPx = 1096;
    // At zoom 4 the lane is 4 * 1000 = 4000px wide. scrollLeft 1000 shows content x 1096 to
    // 2096, which is lane x 1000 to 2000, or 25% to 50% of the lane.
    const zoom = 4;
    const scrollLeftPx = 1000;
    const centre = { ratio: 0.375, viewportOffsetPx: 596 };
    // A whole-pixel width, where the drawn lane and the lane of the follow are the same.
    const whole = { zoom, viewportWidthPx, followViewportWidthPx: viewportWidthPx };

    it("anchors on the playhead when it is in the visible lane", () => {
      const point = resolvePlayheadOrCentreAnchor({
        ...whole,
        scrollLeftPx,
        playheadPercent: 30,
      });
      expect(point.ratio).toBe(0.3);
      expect(point.viewportOffsetPx).toBeCloseTo(296, 9);
    });

    it("anchors on the centre of the visible lane when the playhead is outside it", () => {
      // The visible lane runs from offset 96 to 1096, so its centre is 596. That offset shows
      // lane x 1500, or 37.5% of the lane.
      for (const playheadPercent of [10, 90, null]) {
        const point = resolvePlayheadOrCentreAnchor({
          ...whole,
          scrollLeftPx,
          playheadPercent,
        });
        expect(point.viewportOffsetPx).toBe(centre.viewportOffsetPx);
        expect(point.ratio).toBeCloseTo(centre.ratio, 12);
      }
    });

    it("takes a playhead on either edge of the visible lane as visible", () => {
      // The left edge of the visible lane is the right edge of the gutter.
      expect(
        resolvePlayheadOrCentreAnchor({ ...whole, scrollLeftPx, playheadPercent: 25 }),
      ).toEqual({ ratio: 0.25, viewportOffsetPx: 96, heldPlayheadPercent: 25 });
      expect(
        resolvePlayheadOrCentreAnchor({ ...whole, scrollLeftPx, playheadPercent: 50 }),
      ).toEqual({ ratio: 0.5, viewportOffsetPx: 1096, heldPlayheadPercent: 50 });
    });

    it("agrees with the follow about a visible playhead", () => {
      const laneWidthPx = calculateContentWidthPx(zoom, viewportWidthPx) - 96;
      for (let percent = 0; percent <= 100; percent += 0.5) {
        const point = resolvePlayheadOrCentreAnchor({
          ...whole,
          scrollLeftPx,
          playheadPercent: percent,
        });
        const isVisible =
          calculateFollowScrollLeft(
            percent,
            laneWidthPx,
            96,
            scrollLeftPx,
            viewportWidthPx,
            0.1,
          ) === null;
        if (isVisible) {
          expect(point.ratio).toBe(percent / 100);
        } else {
          expect(point.viewportOffsetPx).toBe(centre.viewportOffsetPx);
          expect(point.ratio).toBeCloseTo(centre.ratio, 12);
        }
      }
    });

    describe("the 0.5 px edge band of a fractional width", () => {
      // The panel passes the fractional width of the container and the rounded width that the
      // follow reads. The follow places the playhead on a lane of the rounded width and tests
      // it against the rounded bound, so both differ from the drawn lane in this band.
      const followViewportWidthPx = 1096;
      const followLaneWidthPx =
        calculateContentWidthPx(zoom, followViewportWidthPx) - 96;
      const isFollowVisible = (percent: number): boolean =>
        calculateFollowScrollLeft(
          percent,
          followLaneWidthPx,
          96,
          scrollLeftPx,
          followViewportWidthPx,
          PLAYHEAD_FOLLOW_LEAD_FRACTION,
        ) === null;

      it("anchors on the centre when the follow places the playhead past the rounded edge", () => {
        // Width 1095.6: the drawn lane is 3998.4px, so 50.01% is drawn at offset 1095.59984,
        // inside the fractional edge. The follow places it at 96 + 2000.4 - 1000 = 1096.4,
        // past its bound of 1096, so it would page. The zoom must not hold it.
        expect(isFollowVisible(50.01)).toBe(false);
        const point = resolvePlayheadOrCentreAnchor({
          zoom,
          viewportWidthPx: 1095.6,
          followViewportWidthPx,
          scrollLeftPx,
          playheadPercent: 50.01,
        });
        expect(point.viewportOffsetPx).toBe((96 + 1095.6) / 2);
      });

      it("anchors on the playhead when the follow sees it, past the fractional edge", () => {
        // Width 1096.4: the drawn lane is 4001.6px, so 50% is drawn at offset 1096.8, past the
        // fractional edge. The follow places it at 1096, on its bound, so it sees it.
        expect(isFollowVisible(50)).toBe(true);
        const point = resolvePlayheadOrCentreAnchor({
          zoom,
          viewportWidthPx: 1096.4,
          followViewportWidthPx,
          scrollLeftPx,
          playheadPercent: 50,
        });
        expect(point.ratio).toBe(0.5);
        // The point to hold is where the lane draws the playhead.
        expect(point.viewportOffsetPx).toBeCloseTo(1096.8, 9);
      });

      it("agrees with the follow at every percent, for both roundings", () => {
        for (const fractionalWidthPx of [1095.6, 1096.4]) {
          for (let step = 0; step <= 10_000; step++) {
            const percent = step / 100;
            const point = resolvePlayheadOrCentreAnchor({
              zoom,
              viewportWidthPx: fractionalWidthPx,
              followViewportWidthPx,
              scrollLeftPx,
              playheadPercent: percent,
            });
            if (isFollowVisible(percent)) {
              expect(point.ratio).toBe(percent / 100);
            } else {
              expect(point.viewportOffsetPx).toBe((96 + fractionalWidthPx) / 2);
            }
          }
        }
      });
    });

    it("anchors on the centre when the rounded width is not usable", () => {
      // The follow returns null for inputs it cannot use, which must not read as visible.
      for (const followViewportWidthPx of [0, Number.NaN]) {
        expect(
          resolvePlayheadOrCentreAnchor({
            zoom: 1,
            viewportWidthPx,
            followViewportWidthPx,
            scrollLeftPx: 0,
            playheadPercent: 80,
          }),
        ).toEqual({ ratio: 0.5, viewportOffsetPx: 596, heldPlayheadPercent: null });
      }
    });

    it("anchors on the playhead at zoom 1, where the whole lane is visible", () => {
      expect(
        resolvePlayheadOrCentreAnchor({
          ...whole,
          zoom: 1,
          scrollLeftPx: 0,
          playheadPercent: 80,
        }),
      ).toEqual({ ratio: 0.8, viewportOffsetPx: 96 + 800, heldPlayheadPercent: 80 });
    });

    it("anchors on the end of the extent, and clamps a playhead past it to the end", () => {
      // calculatePlayheadLayout never gives more than 100. The follow places 150 past the end
      // of the view, but at zoom 1 the view cannot scroll, so its page moves nothing and the
      // anchor holds the playhead, with the ratio clamped to the extent.
      expect(
        resolvePlayheadOrCentreAnchor({
          ...whole,
          zoom: 1,
          scrollLeftPx: 0,
          playheadPercent: 100,
        }),
      ).toEqual({ ratio: 1, viewportOffsetPx: 1096, heldPlayheadPercent: 100 });
      expect(
        resolvePlayheadOrCentreAnchor({
          ...whole,
          zoom: 1,
          scrollLeftPx: 0,
          playheadPercent: 150,
        }),
      ).toEqual({ ratio: 1, viewportOffsetPx: 1096, heldPlayheadPercent: 150 });
      // Where the view can scroll to it, the follow would page, so the zoom holds the centre.
      expect(
        resolvePlayheadOrCentreAnchor({
          ...whole,
          zoom: 4,
          scrollLeftPx: 1000,
          playheadPercent: 150,
        }),
      ).toEqual({ ...centre, heldPlayheadPercent: null });
    });

    it("falls back to the start of the lane for inputs that are not usable", () => {
      const fallback = { ratio: 0, viewportOffsetPx: 96, heldPlayheadPercent: null };
      expect(
        resolvePlayheadOrCentreAnchor({
          ...whole,
          zoom: Number.NaN,
          scrollLeftPx: 0,
          playheadPercent: 50,
        }),
      ).toEqual(fallback);
      expect(
        resolvePlayheadOrCentreAnchor({
          zoom: 2,
          viewportWidthPx: 50,
          followViewportWidthPx: 50,
          scrollLeftPx: 0,
          playheadPercent: 50,
        }),
      ).toEqual(fallback);
      expect(
        resolvePlayheadOrCentreAnchor({
          ...whole,
          zoom: 2,
          scrollLeftPx: Number.POSITIVE_INFINITY,
          playheadPercent: 50,
        }),
      ).toEqual(fallback);
    });
  });

  describe("a zoom from a key or a button, applied after the commit", () => {
    const viewportWidthPx = 1096;

    it("holds a visible playhead at its place in the viewport", () => {
      const scrollLeftPx = 1000;
      const point = resolvePlayheadOrCentreAnchor({
        zoom: 4,
        viewportWidthPx,
        followViewportWidthPx: viewportWidthPx,
        scrollLeftPx,
        playheadPercent: 30,
      });
      const before = viewportOffsetOf(0.3, 4, viewportWidthPx, scrollLeftPx);
      for (const nextZoom of [5, 3.2]) {
        const next = applyAnchorAfterCommit(
          point,
          nextZoom,
          viewportWidthPx,
          scrollLeftPx,
        );
        expect(viewportOffsetOf(0.3, nextZoom, viewportWidthPx, next)).toBeCloseTo(
          before,
          9,
        );
      }
    });

    it("holds the time at the centre of the visible lane", () => {
      const scrollLeftPx = 1000;
      const point = resolvePlayheadOrCentreAnchor({
        zoom: 4,
        viewportWidthPx,
        followViewportWidthPx: viewportWidthPx,
        scrollLeftPx,
        playheadPercent: 90,
      });
      const next = applyAnchorAfterCommit(point, 5, viewportWidthPx, scrollLeftPx);
      expect(viewportOffsetOf(0.375, 5, viewportWidthPx, next)).toBeCloseTo(596, 9);
    });

    it("keeps a visible playhead visible when the scroll range clamps the anchor", () => {
      // Near the end of the source, a zoom out cannot hold the playhead in place, because the
      // view cannot scroll past the end. The clamp moves the playhead within the view.
      const scrollLeftPx = 4000 + 96 - viewportWidthPx;
      const point = resolvePlayheadOrCentreAnchor({
        zoom: 4,
        viewportWidthPx,
        followViewportWidthPx: viewportWidthPx,
        scrollLeftPx,
        playheadPercent: 98,
      });
      expect(point.ratio).toBe(0.98);
      for (const nextZoom of [1, 1.25, 3.2]) {
        const next = applyAnchorAfterCommit(
          point,
          nextZoom,
          viewportWidthPx,
          scrollLeftPx,
        );
        const nextLaneWidthPx =
          calculateContentWidthPx(nextZoom, viewportWidthPx) - TIMELINE_GUTTER_WIDTH_PX;
        expect(
          calculateFollowScrollLeft(
            98,
            nextLaneWidthPx,
            96,
            next,
            viewportWidthPx,
            0.1,
          ),
        ).toBeNull();
      }
    });

    it("does not make the follow page, paused or playing (the E4 rule)", () => {
      const scrollLeftPx = 1000;
      const zoomBefore = 4;
      const playheadPercent = 30;
      const elapsedSeconds = 30;
      // A whole-pixel width, and the two roundings of a fractional one. The follow reads the
      // rounded width, 1096, for all three.
      for (const fractionalWidthPx of [1096, 1095.6, 1096.4]) {
        const followWidthPx = Math.round(fractionalWidthPx);
        let zoom = zoomBefore;
        let scroll = scrollLeftPx;
        // Five steps in, then five steps out, each anchored on the playhead.
        const steps: ("in" | "out")[] = ["in", "in", "in", "in", "in"];
        steps.push("out", "out", "out", "out", "out");
        for (const direction of steps) {
          const anchor = resolvePlayheadOrCentreAnchor({
            zoom,
            viewportWidthPx: fractionalWidthPx,
            followViewportWidthPx: followWidthPx,
            scrollLeftPx: scroll,
            playheadPercent,
          });
          expect(anchor.heldPlayheadPercent).toBe(playheadPercent);
          const nextZoom = stepTimelineZoom(zoom, direction, 50);
          scroll = zoomLikeThePanel(
            anchor,
            nextZoom,
            fractionalWidthPx,
            followWidthPx,
            scroll,
          );
          zoom = nextZoom;
          const laneWidthPx =
            calculateContentWidthPx(zoom, followWidthPx) - TIMELINE_GUTTER_WIDTH_PX;

          // Playing: the playhead is in the window of the follow, so it does not page.
          expect(followSees(playheadPercent, zoom, followWidthPx, scroll)).toBe(true);

          // Paused: a zoom does not move the playhead in seconds, so it is not a navigation,
          // even while a seek that another control sent is pending.
          const decision = calculatePausedFollow({
            playheadPercent,
            elapsedSeconds,
            previousElapsedSeconds: elapsedSeconds,
            isNavigationPending: true,
            isGestureActive: false,
            laneWidthPx,
            laneLeftOffsetPx: TIMELINE_GUTTER_WIDTH_PX,
            scrollLeftPx: scroll,
            viewportWidthPx: followWidthPx,
            leadFraction: PLAYHEAD_FOLLOW_LEAD_FRACTION,
          });
          expect(decision).toEqual({ isNavigation: false, scrollLeftPx: null });
        }
        expect(zoom).toBe(zoomBefore);
        if (fractionalWidthPx === followWidthPx) {
          expect(scroll).toBeCloseTo(scrollLeftPx, 6);
        }
      }
    });

    describe("at a fractional width, where the drawn lane and the follow's lane differ", () => {
      const followWidthPx = 1096;

      it("keeps the playhead in the follow's window: width 1095.6, zoom 40 to 50 at 50%", () => {
        // The reviewer's case. Before the zoom, the follow places the playhead at offset
        // 96 + 20000 - 19001 = 1095, inside its window. The anchor holds the drawn offset,
        // 96 + 19992 - 19001 = 1087. At zoom 50 the anchored scrollLeft is 23999, and the
        // follow places the playhead at 25096 - 23999 = 1097, past its bound of 1096.
        const anchor = resolvePlayheadOrCentreAnchor({
          zoom: 40,
          viewportWidthPx: 1095.6,
          followViewportWidthPx: followWidthPx,
          scrollLeftPx: 19001,
          playheadPercent: 50,
        });
        expect(anchor.heldPlayheadPercent).toBe(50);
        const anchored = applyAnchorAfterCommit(anchor, 50, 1095.6, 19001);
        expect(anchored).toBeCloseTo(23999, 6);
        expect(followSees(50, 50, followWidthPx, anchored)).toBe(false);

        // The clamp moves it into the window, one margin inside the bound.
        const next = zoomLikeThePanel(anchor, 50, 1095.6, followWidthPx, 19001);
        expect(next).toBeCloseTo(25096 - followWidthPx + FOLLOW_WINDOW_MARGIN_PX, 6);
        expect(followSees(50, 50, followWidthPx, next)).toBe(true);
      });

      it("keeps the playhead in the follow's window: width 1096.4, near the gutter", () => {
        // The drawn lane is wider than the follow's lane here, so the follow places the
        // playhead to the left of the drawn one. At scrollLeft 19999 and zoom 40 the follow
        // places 50% at offset 97. At zoom 50 the anchored scrollLeft is 25001, and the
        // follow places the playhead at 95, behind the gutter.
        const anchor = resolvePlayheadOrCentreAnchor({
          zoom: 40,
          viewportWidthPx: 1096.4,
          followViewportWidthPx: followWidthPx,
          scrollLeftPx: 19999,
          playheadPercent: 50,
        });
        expect(anchor.heldPlayheadPercent).toBe(50);
        const anchored = applyAnchorAfterCommit(anchor, 50, 1096.4, 19999);
        expect(anchored).toBeCloseTo(25001, 6);
        expect(followSees(50, 50, followWidthPx, anchored)).toBe(false);

        const next = zoomLikeThePanel(anchor, 50, 1096.4, followWidthPx, 19999);
        expect(next).toBeCloseTo(
          25096 - TIMELINE_GUTTER_WIDTH_PX - FOLLOW_WINDOW_MARGIN_PX,
          6,
        );
        expect(followSees(50, 50, followWidthPx, next)).toBe(true);
      });

      it("keeps every held playhead in the follow's window, also after the pixel snap", () => {
        // The panel reads scrollLeft back, and the browser snaps it to the device pixel grid:
        // half a CSS pixel at a device pixel ratio of 2, and one CSS pixel at a ratio of 1.
        const snaps = [
          (value: number) => value,
          (value: number) => Math.round(value * 2) / 2,
          (value: number) => Math.round(value),
        ];
        for (const fractionalWidthPx of [1095.6, 1096.4]) {
          for (const scrollLeftPx of [19001, 19500, 19999]) {
            for (let step = 4700; step <= 5300; step++) {
              const percent = step / 100;
              const anchor = resolvePlayheadOrCentreAnchor({
                zoom: 40,
                viewportWidthPx: fractionalWidthPx,
                followViewportWidthPx: followWidthPx,
                scrollLeftPx,
                playheadPercent: percent,
              });
              if (anchor.heldPlayheadPercent === null) {
                continue;
              }
              for (const nextZoom of [50, 32]) {
                const next = zoomLikeThePanel(
                  anchor,
                  nextZoom,
                  fractionalWidthPx,
                  followWidthPx,
                  scrollLeftPx,
                );
                for (const snap of snaps) {
                  expect(followSees(percent, nextZoom, followWidthPx, snap(next))).toBe(
                    true,
                  );
                }
              }
            }
          }
        }
      });
    });
  });

  describe("clampScrollLeftToFollowWindow", () => {
    // At zoom 4 and width 1096 the follow's lane is 4000px, so 50% is at content x 2096. The
    // follow sees it for scrollLeft from 2096 - 1096 = 1000 to 2096 - 96 = 2000.
    const base = { playheadPercent: 50, zoom: 4, followViewportWidthPx: 1096 };

    it("keeps a scrollLeft inside the window", () => {
      expect(clampScrollLeftToFollowWindow({ ...base, scrollLeftPx: 1500 })).toBe(1500);
    });

    it("moves a scrollLeft outside the window to its edge, one margin inside", () => {
      expect(clampScrollLeftToFollowWindow({ ...base, scrollLeftPx: 900 })).toBe(
        1000 + FOLLOW_WINDOW_MARGIN_PX,
      );
      expect(clampScrollLeftToFollowWindow({ ...base, scrollLeftPx: 2100 })).toBe(
        2000 - FOLLOW_WINDOW_MARGIN_PX,
      );
    });

    it("returns the input for inputs that are not usable or an empty window", () => {
      expect(
        clampScrollLeftToFollowWindow({ ...base, scrollLeftPx: 900, zoom: Number.NaN }),
      ).toBe(900);
      expect(
        clampScrollLeftToFollowWindow({
          ...base,
          scrollLeftPx: 900,
          playheadPercent: Number.NaN,
        }),
      ).toBe(900);
      expect(
        clampScrollLeftToFollowWindow({
          ...base,
          scrollLeftPx: 900,
          followViewportWidthPx: 97,
        }),
      ).toBe(900);
    });
  });

  describe("the follow-window clamp at the ends of the lane", () => {
    const followWidthPx = 1096;
    const widths = [1096, 1095.6, 1096.4];
    // The panel reads scrollLeft back, and the browser snaps it to the device pixel grid.
    const snaps = [
      (value: number) => value,
      (value: number) => Math.round(value * 2) / 2,
      (value: number) => Math.round(value),
    ];

    /** The playback follow's page after the zoom, clamped to the scroll range, moves nothing. */
    const expectNoPage = (
      percent: number,
      zoom: number,
      fractionalWidthPx: number,
      scrollLeftPx: number,
    ) => {
      const target = calculateFollowScrollLeft(
        percent,
        calculateContentWidthPx(zoom, followWidthPx) - TIMELINE_GUTTER_WIDTH_PX,
        TIMELINE_GUTTER_WIDTH_PX,
        scrollLeftPx,
        followWidthPx,
        PLAYHEAD_FOLLOW_LEAD_FRACTION,
      );
      if (target === null) {
        return;
      }
      const maxScrollLeftPx = Math.max(
        0,
        calculateContentWidthPx(zoom, fractionalWidthPx) - fractionalWidthPx,
      );
      expect(
        shouldWriteFollowScrollLeft(scrollLeftPx, Math.min(target, maxScrollLeftPx)),
      ).toBe(false);
    };

    it("at 0%: the range clamp wins at scrollLeft 0, and the follow sees the playhead", () => {
      for (const widthPx of widths) {
        const anchor = resolvePlayheadOrCentreAnchor({
          zoom: 4,
          viewportWidthPx: widthPx,
          followViewportWidthPx: followWidthPx,
          scrollLeftPx: 0,
          playheadPercent: 0,
        });
        expect(anchor.heldPlayheadPercent).toBe(0);
        for (const nextZoom of [5, 3.2, 1]) {
          // The follow's window for 0% ends one margin before scrollLeft 0.
          expect(
            clampScrollLeftToFollowWindow({
              scrollLeftPx: 0,
              playheadPercent: 0,
              zoom: nextZoom,
              followViewportWidthPx: followWidthPx,
            }),
          ).toBe(-FOLLOW_WINDOW_MARGIN_PX);
          const next = zoomLikeThePanel(anchor, nextZoom, widthPx, followWidthPx, 0);
          expect(next).toBe(0);
          expect(followSees(0, nextZoom, followWidthPx, next)).toBe(true);
          expectNoPage(0, nextZoom, widthPx, next);
        }
      }
    });

    it("at 100%: the range clamp wins at the maximum scrollLeft, and no page follows", () => {
      for (const widthPx of widths) {
        const maxBeforePx = calculateContentWidthPx(4, widthPx) - widthPx;
        const anchor = resolvePlayheadOrCentreAnchor({
          zoom: 4,
          viewportWidthPx: widthPx,
          followViewportWidthPx: followWidthPx,
          scrollLeftPx: maxBeforePx,
          playheadPercent: 100,
        });
        // Held at every width. At 1095.6 the follow never sees 100%, but at the maximum
        // scrollLeft its page is a no-op, so the zoom must not move the view to the centre.
        expect(anchor.heldPlayheadPercent).toBe(100);
        for (const nextZoom of [5, 1.25, 1]) {
          const maxAfterPx = Math.max(
            0,
            calculateContentWidthPx(nextZoom, widthPx) - widthPx,
          );
          if (widthPx === 1095.6) {
            // The follow's window lies past the end of the scroll range, so the range wins.
            expect(
              clampScrollLeftToFollowWindow({
                scrollLeftPx: maxAfterPx,
                playheadPercent: 100,
                zoom: nextZoom,
                followViewportWidthPx: followWidthPx,
              }),
            ).toBeGreaterThan(maxAfterPx);
          }
          const next = zoomLikeThePanel(
            anchor,
            nextZoom,
            widthPx,
            followWidthPx,
            maxBeforePx,
          );
          // The end of the lane stays at the right edge of the view.
          expect(next).toBeCloseTo(maxAfterPx, 6);
          for (const snap of snaps) {
            expectNoPage(100, nextZoom, widthPx, snap(next));
          }
        }
      }
    });

    it("for a zoom out to 1: the whole lane fits, the range wins at 0, and no page follows", () => {
      for (const widthPx of widths) {
        const cases: readonly [zoom: number, percent: number, scrollLeftPx: number][] =
          [
            // The last key step, 1.25 to 1, and a larger zoom out from 4.
            [1.25, 30, 100],
            [4, 30, 1000],
            // The end of the lane at the maximum scrollLeft of zoom 1.25.
            [1.25, 100, calculateContentWidthPx(1.25, widthPx) - widthPx],
          ];
        for (const [zoom, percent, scrollLeftPx] of cases) {
          const anchor = resolvePlayheadOrCentreAnchor({
            zoom,
            viewportWidthPx: widthPx,
            followViewportWidthPx: followWidthPx,
            scrollLeftPx,
            playheadPercent: percent,
          });
          expect(anchor.heldPlayheadPercent).toBe(percent);
          const next = zoomLikeThePanel(
            anchor,
            1,
            widthPx,
            followWidthPx,
            scrollLeftPx,
          );
          // At zoom 1 the lane fits the view, so the scroll range is 0 and it wins. The
          // fractional widths leave a rounding error of the range at most.
          expect(next).toBeCloseTo(0, 9);
          expect(followSees(percent, 1, followWidthPx, next)).toBe(true);
          expectNoPage(percent, 1, widthPx, next);
        }
      }
    });
  });

  describe("shouldWriteFollowScrollLeft", () => {
    it("skips a snap residual at the maximum scrollLeft", () => {
      // At width 1095.6 and zoom 4 the maximum scrollLeft is 2998.8, and the follow's target
      // at the end of the lane clamps to it on every frame. The browser keeps 2999, or 2998.5
      // at a device pixel ratio of 2.
      const maxScrollLeftPx = calculateContentWidthPx(4, 1095.6) - 1095.6;
      expect(maxScrollLeftPx).toBeCloseTo(2998.8, 9);
      for (const mirror of [2999, 2998.5, maxScrollLeftPx]) {
        expect(shouldWriteFollowScrollLeft(mirror, maxScrollLeftPx)).toBe(false);
      }
    });

    it("writes 0 from a snap residual such as 0.5, and not 0 from 0", () => {
      expect(shouldWriteFollowScrollLeft(0.5, 0)).toBe(true);
      expect(shouldWriteFollowScrollLeft(0.25, 0)).toBe(true);
      expect(shouldWriteFollowScrollLeft(0, 0)).toBe(false);
      // A residual next to a target that is not 0 stays.
      expect(shouldWriteFollowScrollLeft(0.5, 0.2)).toBe(false);
      expect(FOLLOW_WRITE_TOLERANCE_PX).toBe(1);
    });

    it("always writes a real page, on the left and on the right", () => {
      const scrollLeftPx = 1000;
      // 1024 is the narrowest window, where the lead is 102.4px.
      for (const widthPx of [1024, 1096, 1920]) {
        const laneWidthPx = 4 * (widthPx - TIMELINE_GUTTER_WIDTH_PX);
        const leadPx = Math.max(
          TIMELINE_GUTTER_WIDTH_PX,
          PLAYHEAD_FOLLOW_LEAD_FRACTION * widthPx,
        );
        const pageFor = (contentX: number): number => {
          const percent = ((contentX - TIMELINE_GUTTER_WIDTH_PX) / laneWidthPx) * 100;
          const target = calculateFollowScrollLeft(
            percent,
            laneWidthPx,
            TIMELINE_GUTTER_WIDTH_PX,
            scrollLeftPx,
            widthPx,
            PLAYHEAD_FOLLOW_LEAD_FRACTION,
          );
          if (target === null) {
            throw new Error("the follow sees the playhead, so it does not page");
          }
          return target;
        };

        // Left: the playhead just behind the gutter. The page moves by the lead minus the
        // gutter, which is the smallest page: 13.6px at 1096, and 6.4px at 1024.
        const left = pageFor(scrollLeftPx + TIMELINE_GUTTER_WIDTH_PX - 0.01);
        expect(scrollLeftPx - left).toBeCloseTo(
          leadPx - TIMELINE_GUTTER_WIDTH_PX + 0.01,
          6,
        );
        // Right: the playhead just past the right edge. The page moves by the width minus the
        // lead: 986.4px at 1096.
        const right = pageFor(scrollLeftPx + widthPx + 0.01);
        expect(right - scrollLeftPx).toBeCloseTo(widthPx - leadPx + 0.01, 6);

        for (const mirror of [scrollLeftPx, scrollLeftPx + 0.5, scrollLeftPx - 0.5]) {
          expect(shouldWriteFollowScrollLeft(mirror, left)).toBe(true);
          expect(shouldWriteFollowScrollLeft(mirror, right)).toBe(true);
        }
      }
    });

    it("does not write a target that is not a number", () => {
      expect(shouldWriteFollowScrollLeft(1000, Number.NaN)).toBe(false);
    });
  });
});
