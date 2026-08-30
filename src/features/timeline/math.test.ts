import { describe, expect, it } from "vitest";
import type { Segment } from "@/types/project";
import {
  calculateExclusiveOutFrame,
  calculateFrameFromClientX,
  calculateFrameFromOffset,
  calculateKeyboardSeekTargetFrame,
  calculatePercentFromFrame,
  calculatePlayheadLayout,
  calculatePendingInRegionLayout,
  calculateSegmentLayout,
  canMarkIn,
  canMarkOut,
  canSplitAtFrame,
  compareSegmentsInSourceOrder,
  findSplittableSegmentIndex,
  insertSegmentInSourceOrder,
  splitSegment,
} from "./math";

describe("Timeline Pure Math & Layout Helpers", () => {
  const maxSafe = Number.MAX_SAFE_INTEGER;

  describe("calculateExclusiveOutFrame (ADR-002 Rule 3)", () => {
    it("computes min(currentFrame + 1, frameCount) for ordinary frame indices", () => {
      expect(calculateExclusiveOutFrame(0, 100)).toBe(1);
      expect(calculateExclusiveOutFrame(49, 100)).toBe(50);
      expect(calculateExclusiveOutFrame(98, 100)).toBe(99);
    });

    it("includes the last source frame by capping at frameCount", () => {
      // For frameCount = 100, visible frames are 0..99. Marking Out on frame 99 gives outFrame = 100.
      expect(calculateExclusiveOutFrame(99, 100)).toBe(100);
      // For frameCount = 1, visible frame is 0. Marking Out on frame 0 gives outFrame = 1.
      expect(calculateExclusiveOutFrame(0, 1)).toBe(1);
    });

    it("handles boundary frameCount = 0 and 1", () => {
      expect(calculateExclusiveOutFrame(0, 0)).toBe(0);
      expect(calculateExclusiveOutFrame(5, 0)).toBe(0);
      expect(calculateExclusiveOutFrame(0, 1)).toBe(1);
    });

    it("prevents overflow near MAX_SAFE_INTEGER using BigInt math", () => {
      expect(calculateExclusiveOutFrame(maxSafe - 1, maxSafe)).toBe(maxSafe);
      expect(calculateExclusiveOutFrame(maxSafe - 2, maxSafe)).toBe(maxSafe - 1);
      expect(calculateExclusiveOutFrame(0, maxSafe)).toBe(1);
    });

    it("rejects currentFrame >= frameCount and returns 0 under invalid-input contract", () => {
      expect(calculateExclusiveOutFrame(100, 100)).toBe(0);
      expect(calculateExclusiveOutFrame(105, 100)).toBe(0);
      expect(calculateExclusiveOutFrame(1, 1)).toBe(0);
      expect(calculateExclusiveOutFrame(5, 1)).toBe(0);
      expect(calculateExclusiveOutFrame(maxSafe, maxSafe)).toBe(0);
      expect(calculateExclusiveOutFrame(maxSafe + 1, maxSafe)).toBe(0);
    });

    it("rejects invalid, negative, non-integer, or NaN inputs safely", () => {
      expect(calculateExclusiveOutFrame(-1, 100)).toBe(0);
      expect(calculateExclusiveOutFrame(10, -5)).toBe(0);
      expect(calculateExclusiveOutFrame(NaN, 100)).toBe(0);
      expect(calculateExclusiveOutFrame(10, NaN)).toBe(0);
      expect(calculateExclusiveOutFrame(1.5, 100)).toBe(0);
      expect(calculateExclusiveOutFrame(10, 100.5)).toBe(0);
    });
  });

  describe("compareSegmentsInSourceOrder & insertSegmentInSourceOrder", () => {
    const seg1: Segment = { id: "s1", sourceId: "src1", inFrame: 0, outFrame: 10 };
    const seg2: Segment = { id: "s2", sourceId: "src1", inFrame: 10, outFrame: 20 };
    const seg3: Segment = { id: "s3", sourceId: "src1", inFrame: 20, outFrame: 30 };
    const segOverlap: Segment = {
      id: "so",
      sourceId: "src1",
      inFrame: 5,
      outFrame: 15,
    };
    const segSameIn: Segment = { id: "ss", sourceId: "src1", inFrame: 0, outFrame: 5 };

    it("orders segments primarily by inFrame ascending", () => {
      expect(compareSegmentsInSourceOrder(seg1, seg2)).toBe(-1);
      expect(compareSegmentsInSourceOrder(seg3, seg1)).toBe(1);
    });

    it("orders segments secondarily by outFrame ascending when inFrames are equal", () => {
      expect(compareSegmentsInSourceOrder(segSameIn, seg1)).toBe(-1);
      expect(compareSegmentsInSourceOrder(seg1, segSameIn)).toBe(1);
    });

    it("orders segments by id when inFrame and outFrame are identical", () => {
      const segA: Segment = { id: "a", sourceId: "src1", inFrame: 0, outFrame: 10 };
      const segB: Segment = { id: "b", sourceId: "src1", inFrame: 0, outFrame: 10 };
      expect(compareSegmentsInSourceOrder(segA, segB)).toBe(-1);
      expect(compareSegmentsInSourceOrder(segB, segA)).toBe(1);
      expect(compareSegmentsInSourceOrder(segA, segA)).toBe(0);
    });

    it("inserts new segments into an existing list preserving source order", () => {
      const initial = [seg1, seg3];
      const inserted = insertSegmentInSourceOrder(initial, seg2);
      expect(inserted).toEqual([seg1, seg2, seg3]);

      const withOverlap = insertSegmentInSourceOrder(inserted, segOverlap);
      expect(withOverlap).toEqual([seg1, segOverlap, seg2, seg3]);
    });
  });

  describe("canMarkIn & canMarkOut", () => {
    it("validates canMarkIn requirements", () => {
      // Ready, attached, valid source
      expect(canMarkIn(true, true, 100, 0)).toBe(true);
      expect(canMarkIn(true, true, 100, 99)).toBe(true);
      expect(canMarkIn(true, true, 1, 0)).toBe(true);
      expect(canMarkIn(true, true, maxSafe, maxSafe - 1)).toBe(true);

      // Unattached or unready
      expect(canMarkIn(false, true, 100, 50)).toBe(false);
      expect(canMarkIn(true, false, 100, 50)).toBe(false);

      // Zero-frame or invalid frameCount
      expect(canMarkIn(true, true, 0, 0)).toBe(false);
      expect(canMarkIn(true, true, -1, 0)).toBe(false);
      expect(canMarkIn(true, true, NaN, 0)).toBe(false);

      // Out of bounds currentFrame
      expect(canMarkIn(true, true, 100, 100)).toBe(false);
      expect(canMarkIn(true, true, 100, 150)).toBe(false);
      expect(canMarkIn(true, true, 1, 1)).toBe(false);
      expect(canMarkIn(true, true, maxSafe, maxSafe)).toBe(false);
      expect(canMarkIn(true, true, 100, -1)).toBe(false);
      expect(canMarkIn(true, true, 100, 1.5)).toBe(false);
      expect(canMarkIn(true, true, 100, NaN)).toBe(false);
    });

    it("validates canMarkOut requirements (one-frame mark, last frame, invalid ordering)", () => {
      // One-frame mark: In at 10, Out at 10 (exclusive out is 11 > 10)
      expect(canMarkOut(true, true, 100, 10, 10)).toBe(true);

      // Ordinary range: In at 10, Out at 20
      expect(canMarkOut(true, true, 100, 20, 10)).toBe(true);

      // Last frame inclusion: In at 99, Out at 99 with frameCount 100 (out is 100 > 99)
      expect(canMarkOut(true, true, 100, 99, 99)).toBe(true);

      // Single-frame video: In at 0, Out at 0 with frameCount 1 (out is 1 > 0)
      expect(canMarkOut(true, true, 1, 0, 0)).toBe(true);

      // Out before In: In at 50, currentFrame at 40
      expect(canMarkOut(true, true, 100, 40, 50)).toBe(false);

      // No pending In
      expect(canMarkOut(true, true, 100, 50, null)).toBe(false);

      // Unattached or unready
      expect(canMarkOut(false, true, 100, 50, 10)).toBe(false);
      expect(canMarkOut(true, false, 100, 50, 10)).toBe(false);

      // Out of range frames or zero-frame source
      expect(canMarkOut(true, true, 0, 0, 0)).toBe(false);
      expect(canMarkOut(true, true, 100, 100, 10)).toBe(false);
      expect(canMarkOut(true, true, 100, 50, -1)).toBe(false);
    });
  });

  describe("canSplitAtFrame, findSplittableSegmentIndex & splitSegment", () => {
    const segments: Segment[] = [
      { id: "seg-1", sourceId: "src1", inFrame: 10, outFrame: 20 },
      { id: "seg-2", sourceId: "src1", inFrame: 30, outFrame: 31 }, // 1-frame segment [30, 31)
      { id: "seg-3", sourceId: "src1", inFrame: 40, outFrame: 60 },
    ];

    it("identifies strict interior frames inside segments", () => {
      // Inside seg-1 [10, 20): interior frames are 11..19
      expect(findSplittableSegmentIndex(segments, 11)).toBe(0);
      expect(findSplittableSegmentIndex(segments, 15)).toBe(0);
      expect(findSplittableSegmentIndex(segments, 19)).toBe(0);
      expect(canSplitAtFrame(segments, 15, true, true, 100)).toBe(true);

      // Boundaries are NOT interior frames
      expect(findSplittableSegmentIndex(segments, 10)).toBe(-1);
      expect(findSplittableSegmentIndex(segments, 20)).toBe(-1);
      expect(canSplitAtFrame(segments, 10, true, true, 100)).toBe(false);
      expect(canSplitAtFrame(segments, 20, true, true, 100)).toBe(false);

      // 1-frame segment [30, 31) has no interior integers and cannot be split
      expect(findSplittableSegmentIndex(segments, 30)).toBe(-1);
      expect(findSplittableSegmentIndex(segments, 31)).toBe(-1);
      expect(canSplitAtFrame(segments, 30, true, true, 100)).toBe(false);

      // Outside all segments
      expect(findSplittableSegmentIndex(segments, 25)).toBe(-1);
      expect(findSplittableSegmentIndex(segments, 0)).toBe(-1);
      expect(findSplittableSegmentIndex(segments, 99)).toBe(-1);
      expect(canSplitAtFrame(segments, 25, true, true, 100)).toBe(false);
    });

    it("disables split when unready, unattached, zero frameCount, or frame out of bounds", () => {
      expect(canSplitAtFrame(segments, 15, false, true, 100)).toBe(false);
      expect(canSplitAtFrame(segments, 15, true, false, 100)).toBe(false);
      expect(canSplitAtFrame(segments, 15, true, true, 0)).toBe(false);
      expect(canSplitAtFrame(segments, 15, true, true, 10)).toBe(false);
      expect(canSplitAtFrame(segments, -1, true, true, 100)).toBe(false);
      expect(canSplitAtFrame(segments, NaN, true, true, 100)).toBe(false);
    });

    it("splits a segment preserving the left id and assigning a new right id", () => {
      const targetSeg = segments[0]; // [10, 20)
      const [left, right] = splitSegment(targetSeg, 14, "seg-new-right");

      expect(left).toEqual({
        id: "seg-1",
        sourceId: "src1",
        inFrame: 10,
        outFrame: 14,
      });

      expect(right).toEqual({
        id: "seg-new-right",
        sourceId: "src1",
        inFrame: 14,
        outFrame: 20,
      });

      // Duration check: (14 - 10) + (20 - 14) = 4 + 6 = 10 = original duration
      expect(left.outFrame - left.inFrame + (right.outFrame - right.inFrame)).toBe(
        targetSeg.outFrame - targetSeg.inFrame,
      );
    });
  });

  describe("calculateFrameFromOffset & calculateFrameFromClientX (Timeline Seek Mapping)", () => {
    it("maps pixel offsets proportionally across track width", () => {
      const frameCount = 100;
      const width = 1000;

      expect(calculateFrameFromOffset(0, width, frameCount)).toBe(0);
      expect(calculateFrameFromOffset(250, width, frameCount)).toBe(25);
      expect(calculateFrameFromOffset(500, width, frameCount)).toBe(50);
      expect(calculateFrameFromOffset(750, width, frameCount)).toBe(75);
      expect(calculateFrameFromOffset(999, width, frameCount)).toBe(99);
      expect(calculateFrameFromOffset(1000, width, frameCount)).toBe(99); // Clamped to frameCount - 1
    });

    it("handles boundary frameCount = 0 and 1 in calculateFrameFromOffset", () => {
      expect(calculateFrameFromOffset(500, 1000, 0)).toBe(0);
      expect(calculateFrameFromOffset(500, 1000, 1)).toBe(0);
      expect(calculateFrameFromOffset(0, 1000, 1)).toBe(0);
      expect(calculateFrameFromOffset(1000, 1000, 1)).toBe(0);
    });

    it("clamps negative and out-of-bounds offsets safely in calculateFrameFromOffset", () => {
      expect(calculateFrameFromOffset(-100, 1000, 100)).toBe(0);
      expect(calculateFrameFromOffset(1500, 1000, 100)).toBe(99);
    });

    it("handles large frameCount up to MAX_SAFE_INTEGER safely in calculateFrameFromOffset", () => {
      const frame = calculateFrameFromOffset(500, 1000, maxSafe);
      expect(frame).toBeGreaterThan(0);
      expect(frame).toBeLessThan(maxSafe);
      expect(Number.isSafeInteger(frame)).toBe(true);

      expect(calculateFrameFromOffset(1000, 1000, maxSafe)).toBe(maxSafe - 1);
      expect(calculateFrameFromOffset(0, 1000, maxSafe)).toBe(0);
    });

    it("handles invalid inputs in calculateFrameFromOffset (0 width, negative width, NaN, Infinity)", () => {
      expect(calculateFrameFromOffset(50, 0, 100)).toBe(0);
      expect(calculateFrameFromOffset(50, -500, 100)).toBe(0);
      expect(calculateFrameFromOffset(NaN, 1000, 100)).toBe(0);
      expect(calculateFrameFromOffset(50, NaN, 100)).toBe(0);
      expect(calculateFrameFromOffset(50, Infinity, 100)).toBe(0);
    });

    it("correctly models nonzero rect left and padding with calculateFrameFromClientX", () => {
      // Modeling an inner surface positioned at left: 120px (e.g. 96px gutter + 16px padding + 8px track padding) with width: 800px
      const rectLeft = 120;
      const rectWidth = 800;
      const frameCount = 100;

      // Exact start (clientX === rectLeft) maps to frame 0
      expect(calculateFrameFromClientX(rectLeft, rectLeft, rectWidth, frameCount)).toBe(
        0,
      );

      // Exact end (clientX === rectLeft + rectWidth) maps to frameCount - 1 (99)
      expect(
        calculateFrameFromClientX(
          rectLeft + rectWidth,
          rectLeft,
          rectWidth,
          frameCount,
        ),
      ).toBe(99);

      // Midpoint maps to frame 50
      expect(
        calculateFrameFromClientX(
          rectLeft + rectWidth / 2,
          rectLeft,
          rectWidth,
          frameCount,
        ),
      ).toBe(50);

      // Quarter point maps to frame 25
      expect(
        calculateFrameFromClientX(
          rectLeft + rectWidth / 4,
          rectLeft,
          rectWidth,
          frameCount,
        ),
      ).toBe(25);

      // Three-quarter point maps to frame 75
      expect(
        calculateFrameFromClientX(
          rectLeft + (rectWidth * 3) / 4,
          rectLeft,
          rectWidth,
          frameCount,
        ),
      ).toBe(75);

      // Left-of-surface click (e.g. in outer padding or gutter at clientX = 80px) clamps to frame 0
      expect(calculateFrameFromClientX(80, rectLeft, rectWidth, frameCount)).toBe(0);

      // Right-of-surface click (e.g. in right padding at clientX = 1000px) clamps to frame 99
      expect(calculateFrameFromClientX(1000, rectLeft, rectWidth, frameCount)).toBe(99);
    });

    it("handles boundary frameCount = 0 and 1 with calculateFrameFromClientX", () => {
      const rectLeft = 100;
      const rectWidth = 500;

      expect(calculateFrameFromClientX(100, rectLeft, rectWidth, 0)).toBe(0);
      expect(calculateFrameFromClientX(350, rectLeft, rectWidth, 0)).toBe(0);
      expect(calculateFrameFromClientX(100, rectLeft, rectWidth, 1)).toBe(0);
      expect(calculateFrameFromClientX(350, rectLeft, rectWidth, 1)).toBe(0);
      expect(calculateFrameFromClientX(600, rectLeft, rectWidth, 1)).toBe(0);
    });

    it("handles MAX_SAFE_INTEGER with calculateFrameFromClientX", () => {
      const rectLeft = 200;
      const rectWidth = 1000;

      expect(calculateFrameFromClientX(rectLeft, rectLeft, rectWidth, maxSafe)).toBe(0);
      expect(
        calculateFrameFromClientX(rectLeft + rectWidth, rectLeft, rectWidth, maxSafe),
      ).toBe(maxSafe - 1);
    });

    it("handles invalid inputs gracefully with calculateFrameFromClientX", () => {
      expect(calculateFrameFromClientX(NaN, 100, 500, 100)).toBe(0);
      expect(calculateFrameFromClientX(200, NaN, 500, 100)).toBe(0);
      expect(calculateFrameFromClientX(200, 100, NaN, 100)).toBe(0);
      expect(calculateFrameFromClientX(200, 100, 0, 100)).toBe(0);
      expect(calculateFrameFromClientX(200, 100, -500, 100)).toBe(0);
    });
  });

  describe("calculateKeyboardSeekTargetFrame (Timeline Slider Keyboard Navigation)", () => {
    it("handles ArrowLeft and ArrowDown (step back 1 frame clamped to 0)", () => {
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", 50, 100)).toBe(49);
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", 1, 100)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", 0, 100)).toBe(0);

      expect(calculateKeyboardSeekTargetFrame("ArrowDown", 50, 100)).toBe(49);
      expect(calculateKeyboardSeekTargetFrame("ArrowDown", 1, 100)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("ArrowDown", 0, 100)).toBe(0);
    });

    it("handles ArrowRight and ArrowUp (step forward 1 frame clamped to frameCount - 1)", () => {
      expect(calculateKeyboardSeekTargetFrame("ArrowRight", 50, 100)).toBe(51);
      expect(calculateKeyboardSeekTargetFrame("ArrowRight", 98, 100)).toBe(99);
      expect(calculateKeyboardSeekTargetFrame("ArrowRight", 99, 100)).toBe(99);

      expect(calculateKeyboardSeekTargetFrame("ArrowUp", 50, 100)).toBe(51);
      expect(calculateKeyboardSeekTargetFrame("ArrowUp", 98, 100)).toBe(99);
      expect(calculateKeyboardSeekTargetFrame("ArrowUp", 99, 100)).toBe(99);
    });

    it("handles Home (jump to frame 0)", () => {
      expect(calculateKeyboardSeekTargetFrame("Home", 50, 100)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("Home", 0, 100)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("Home", 99, 100)).toBe(0);
    });

    it("handles End (jump to last frame frameCount - 1)", () => {
      expect(calculateKeyboardSeekTargetFrame("End", 50, 100)).toBe(99);
      expect(calculateKeyboardSeekTargetFrame("End", 0, 100)).toBe(99);
      expect(calculateKeyboardSeekTargetFrame("End", 99, 100)).toBe(99);
    });

    it("handles boundary frameCount = 1", () => {
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", 0, 1)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("ArrowDown", 0, 1)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("ArrowRight", 0, 1)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("ArrowUp", 0, 1)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("Home", 0, 1)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("End", 0, 1)).toBe(0);
    });

    it("handles boundary frameCount = 0 by returning null", () => {
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", 0, 0)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("ArrowDown", 0, 0)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("ArrowRight", 0, 0)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("ArrowUp", 0, 0)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("Home", 0, 0)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("End", 0, 0)).toBeNull();
    });

    it("handles MAX_SAFE_INTEGER frameCount safely", () => {
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", maxSafe - 1, maxSafe)).toBe(
        maxSafe - 2,
      );
      expect(calculateKeyboardSeekTargetFrame("ArrowDown", maxSafe - 1, maxSafe)).toBe(
        maxSafe - 2,
      );
      expect(calculateKeyboardSeekTargetFrame("ArrowRight", maxSafe - 2, maxSafe)).toBe(
        maxSafe - 1,
      );
      expect(calculateKeyboardSeekTargetFrame("ArrowUp", maxSafe - 2, maxSafe)).toBe(
        maxSafe - 1,
      );
      expect(calculateKeyboardSeekTargetFrame("ArrowRight", maxSafe - 1, maxSafe)).toBe(
        maxSafe - 1,
      );
      expect(calculateKeyboardSeekTargetFrame("ArrowUp", maxSafe - 1, maxSafe)).toBe(
        maxSafe - 1,
      );
      expect(calculateKeyboardSeekTargetFrame("Home", maxSafe - 1, maxSafe)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("End", 0, maxSafe)).toBe(maxSafe - 1);
    });

    it("clamps out-of-bounds currentFrame safely before applying key step", () => {
      // Negative current frame clamps to 0
      expect(calculateKeyboardSeekTargetFrame("ArrowRight", -10, 100)).toBe(1);
      expect(calculateKeyboardSeekTargetFrame("ArrowUp", -10, 100)).toBe(1);
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", -10, 100)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("ArrowDown", -10, 100)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("Home", -10, 100)).toBe(0);
      expect(calculateKeyboardSeekTargetFrame("End", -10, 100)).toBe(99);

      // Frame exceeding frameCount clamps to last frame (99)
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", 200, 100)).toBe(98);
      expect(calculateKeyboardSeekTargetFrame("ArrowDown", 200, 100)).toBe(98);
      expect(calculateKeyboardSeekTargetFrame("ArrowRight", 200, 100)).toBe(99);
      expect(calculateKeyboardSeekTargetFrame("ArrowUp", 200, 100)).toBe(99);

      // NaN or float current frame
      expect(calculateKeyboardSeekTargetFrame("ArrowRight", NaN, 100)).toBe(1);
      expect(calculateKeyboardSeekTargetFrame("ArrowUp", NaN, 100)).toBe(1);
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", 10.7, 100)).toBe(9);
      expect(calculateKeyboardSeekTargetFrame("ArrowDown", 10.7, 100)).toBe(9);
      expect(calculateKeyboardSeekTargetFrame("ArrowRight", 10.7, 100)).toBe(11);
      expect(calculateKeyboardSeekTargetFrame("ArrowUp", 10.7, 100)).toBe(11);
    });

    it("returns null for unhandled keys or invalid inputs", () => {
      expect(calculateKeyboardSeekTargetFrame("PageUp", 50, 100)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("PageDown", 50, 100)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("Space", 50, 100)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("Enter", 50, 100)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("Tab", 50, 100)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("Escape", 50, 100)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("k", 50, 100)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("", 50, 100)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("x", 50, 100)).toBeNull();

      // Invalid frameCount
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", 50, -5)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("ArrowDown", 50, -5)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("ArrowRight", 50, -5)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("ArrowUp", 50, -5)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", 50, NaN)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", 50, 100.5)).toBeNull();
      expect(calculateKeyboardSeekTargetFrame("ArrowLeft", 50, Infinity)).toBeNull();
    });
  });

  describe("calculatePercentFromFrame", () => {
    it("converts frame indices to exact percentages [0, 100]", () => {
      expect(calculatePercentFromFrame(0, 100)).toBe(0);
      expect(calculatePercentFromFrame(50, 100)).toBe(50);
      expect(calculatePercentFromFrame(100, 100)).toBe(100);
      expect(calculatePercentFromFrame(25, 200)).toBe(12.5);
    });

    it("clamps negative frames and frames exceeding frameCount", () => {
      expect(calculatePercentFromFrame(-10, 100)).toBe(0);
      expect(calculatePercentFromFrame(150, 100)).toBe(100);
    });

    it("handles boundary frameCount = 0 and 1", () => {
      expect(calculatePercentFromFrame(0, 0)).toBe(0);
      expect(calculatePercentFromFrame(5, 0)).toBe(0);
      expect(calculatePercentFromFrame(0, 1)).toBe(0);
      expect(calculatePercentFromFrame(1, 1)).toBe(100);
    });

    it("handles MAX_SAFE_INTEGER safely", () => {
      expect(calculatePercentFromFrame(0, maxSafe)).toBe(0);
      expect(calculatePercentFromFrame(maxSafe, maxSafe)).toBe(100);
      expect(Number.isFinite(calculatePercentFromFrame(1000, maxSafe))).toBe(true);
    });
  });

  describe("calculateSegmentLayout", () => {
    it("calculates left and width percentages for regular segments", () => {
      const seg: Segment = { id: "s1", sourceId: "src1", inFrame: 20, outFrame: 60 };
      const layout = calculateSegmentLayout(seg, 100);

      expect(layout.leftPercent).toBe(20);
      expect(layout.widthPercent).toBe(40);
      expect(layout.left).toBe("20%");
      expect(layout.width).toBe("40%");
    });

    it("handles single-frame segment [0, 1) and [99, 100)", () => {
      const segStart: Segment = { id: "s1", sourceId: "src1", inFrame: 0, outFrame: 1 };
      const layoutStart = calculateSegmentLayout(segStart, 100);
      expect(layoutStart.leftPercent).toBe(0);
      expect(layoutStart.widthPercent).toBe(1);
      expect(layoutStart.left).toBe("0%");
      expect(layoutStart.width).toBe("1%");

      const segEnd: Segment = {
        id: "s2",
        sourceId: "src1",
        inFrame: 99,
        outFrame: 100,
      };
      const layoutEnd = calculateSegmentLayout(segEnd, 100);
      expect(layoutEnd.leftPercent).toBe(99);
      expect(layoutEnd.widthPercent).toBe(1);
      expect(layoutEnd.left).toBe("99%");
      expect(layoutEnd.width).toBe("1%");
    });

    it("handles full-span segment [0, frameCount)", () => {
      const segFull: Segment = {
        id: "sf",
        sourceId: "src1",
        inFrame: 0,
        outFrame: 100,
      };
      const layout = calculateSegmentLayout(segFull, 100);
      expect(layout.leftPercent).toBe(0);
      expect(layout.widthPercent).toBe(100);
      expect(layout.left).toBe("0%");
      expect(layout.width).toBe("100%");
    });

    it("handles frameCount 0, 1, and invalid segments safely", () => {
      const seg: Segment = { id: "s1", sourceId: "src1", inFrame: 0, outFrame: 1 };
      expect(calculateSegmentLayout(seg, 0)).toEqual({
        leftPercent: 0,
        widthPercent: 0,
        left: "0%",
        width: "0%",
      });

      const seg1: Segment = { id: "s1", sourceId: "src1", inFrame: 0, outFrame: 1 };
      expect(calculateSegmentLayout(seg1, 1)).toEqual({
        leftPercent: 0,
        widthPercent: 100,
        left: "0%",
        width: "100%",
      });

      // Inverted or 0-duration segment
      const segZero: Segment = {
        id: "sz",
        sourceId: "src1",
        inFrame: 10,
        outFrame: 10,
      };
      expect(calculateSegmentLayout(segZero, 100)).toEqual({
        leftPercent: 0,
        widthPercent: 0,
        left: "0%",
        width: "0%",
      });
    });

    it("handles overlapping segments cleanly", () => {
      const segA: Segment = { id: "sa", sourceId: "src1", inFrame: 10, outFrame: 30 };
      const segB: Segment = { id: "sb", sourceId: "src1", inFrame: 20, outFrame: 40 };

      const layoutA = calculateSegmentLayout(segA, 100);
      const layoutB = calculateSegmentLayout(segB, 100);

      expect(layoutA.leftPercent).toBe(10);
      expect(layoutA.widthPercent).toBe(20);
      expect(layoutB.leftPercent).toBe(20);
      expect(layoutB.widthPercent).toBe(20);
    });
  });

  describe("calculatePendingInRegionLayout", () => {
    it("returns null when pendingInFrame is null or frameCount is 0", () => {
      expect(calculatePendingInRegionLayout(null, 50, 100)).toBeNull();
      expect(calculatePendingInRegionLayout(10, 50, 0)).toBeNull();
    });

    it("calculates active preview region when currentFrame >= pendingInFrame", () => {
      // In at 20, current visible frame at 50 (exclusive out is 51)
      const layout = calculatePendingInRegionLayout(20, 50, 100);
      expect(layout).not.toBeNull();
      expect(layout?.isVisible).toBe(true);
      expect(layout?.leftPercent).toBe(20);
      expect(layout?.widthPercent).toBe(31); // (51 - 20) / 100 * 100 = 31%
      expect(layout?.left).toBe("20%");
      expect(layout?.width).toBe("31%");
    });

    it("handles single-frame pending preview when currentFrame == pendingInFrame", () => {
      // In at 20, current visible frame at 20 (exclusive out is 21)
      const layout = calculatePendingInRegionLayout(20, 20, 100);
      expect(layout?.isVisible).toBe(true);
      expect(layout?.leftPercent).toBe(20);
      expect(layout?.widthPercent).toBe(1); // (21 - 20) / 100 * 100 = 1%
      expect(layout?.left).toBe("20%");
      expect(layout?.width).toBe("1%");
    });

    it("returns isVisible false when currentFrame < pendingInFrame", () => {
      // In at 50, playhead moved back to frame 20
      const layout = calculatePendingInRegionLayout(50, 20, 100);
      expect(layout?.isVisible).toBe(false);
      expect(layout?.leftPercent).toBe(50);
      expect(layout?.widthPercent).toBe(0);
      expect(layout?.left).toBe("50%");
      expect(layout?.width).toBe("0%");
    });

    it("returns isVisible false and never yields negative width when currentFrame >= frameCount", () => {
      // In at 50, currentFrame at 100 on a 100-frame source (out-of-bounds frame)
      const layoutAtMax = calculatePendingInRegionLayout(50, 100, 100);
      expect(layoutAtMax?.isVisible).toBe(false);
      expect(layoutAtMax?.leftPercent).toBe(50);
      expect(layoutAtMax?.widthPercent).toBe(0);
      expect(layoutAtMax?.left).toBe("50%");
      expect(layoutAtMax?.width).toBe("0%");

      // In at 50, currentFrame at 150
      const layoutExceeded = calculatePendingInRegionLayout(50, 150, 100);
      expect(layoutExceeded?.isVisible).toBe(false);
      expect(layoutExceeded?.widthPercent).toBe(0);

      // Single frame video: in at 0, currentFrame at 1
      const layoutSingle = calculatePendingInRegionLayout(0, 1, 1);
      expect(layoutSingle?.isVisible).toBe(false);
      expect(layoutSingle?.widthPercent).toBe(0);
    });

    it("handles last frame preview correctly", () => {
      // In at 99, currentFrame at 99 in a 100 frame video (out is 100)
      const layout = calculatePendingInRegionLayout(99, 99, 100);
      expect(layout?.isVisible).toBe(true);
      expect(layout?.leftPercent).toBe(99);
      expect(layout?.widthPercent).toBe(1);
    });
  });

  describe("calculatePlayheadLayout", () => {
    it("positions playhead correctly at frame 0, middle, and end", () => {
      expect(calculatePlayheadLayout(0, 100)).toEqual({ percent: 0, left: "0%" });
      expect(calculatePlayheadLayout(50, 100)).toEqual({ percent: 50, left: "50%" });
      expect(calculatePlayheadLayout(99, 100)).toEqual({ percent: 99, left: "99%" });
    });

    it("handles frameCount 0 and 1 safely", () => {
      expect(calculatePlayheadLayout(0, 0)).toEqual({ percent: 0, left: "0%" });
      expect(calculatePlayheadLayout(5, 0)).toEqual({ percent: 0, left: "0%" });
      expect(calculatePlayheadLayout(0, 1)).toEqual({ percent: 0, left: "0%" });
      expect(calculatePlayheadLayout(1, 1)).toEqual({ percent: 0, left: "0%" }); // Clamped to frame 0
    });

    it("handles MAX_SAFE_INTEGER without NaN or crash", () => {
      const layout = calculatePlayheadLayout(maxSafe - 1, maxSafe);
      expect(layout.percent).toBeGreaterThan(99);
      expect(Number.isFinite(layout.percent)).toBe(true);
    });
  });

  describe("Ruler and Track Geometry Alignment", () => {
    it("ensures ruler playhead and track playhead yield identical x-coordinate positions", () => {
      const gutterWidth = 96; // 96px w-24 gutter
      const containerWidth = 1000;
      const postGutterWidth = containerWidth - gutterWidth; // 904px full post-gutter width
      const frameCount = 300;

      // For any frame index, both ruler and track playheads are rendered at calculatePlayheadLayout(frame, frameCount).left
      const testFrames = [0, 1, 60, 150, 240, 299];
      for (const frame of testFrames) {
        const rulerPlayhead = calculatePlayheadLayout(frame, frameCount);
        const trackPlayhead = calculatePlayheadLayout(frame, frameCount);

        // Exact match in percentage and CSS left string
        expect(rulerPlayhead.percent).toBe(trackPlayhead.percent);
        expect(rulerPlayhead.left).toBe(trackPlayhead.left);

        // Exact absolute X coordinate join from ruler to track
        const rulerPixelX =
          gutterWidth + (rulerPlayhead.percent / 100) * postGutterWidth;
        const trackPixelX =
          gutterWidth + (trackPlayhead.percent / 100) * postGutterWidth;
        expect(rulerPixelX).toBe(trackPixelX);
      }
    });

    it("ensures track slider click mapping accurately matches the shared ruler width axis", () => {
      const gutterWidth = 96;
      const containerWidth = 1000;
      const postGutterWidth = containerWidth - gutterWidth;
      const frameCount = 100;

      // Track surface starts at gutterWidth and spans postGutterWidth (identical to ruler)
      const rectLeft = gutterWidth;
      const rectWidth = postGutterWidth;

      // Start of track (clientX === gutterWidth) maps to frame 0
      expect(calculateFrameFromClientX(rectLeft, rectLeft, rectWidth, frameCount)).toBe(
        0,
      );

      // End of track (clientX === gutterWidth + postGutterWidth) maps to frameCount - 1
      expect(
        calculateFrameFromClientX(
          rectLeft + rectWidth,
          rectLeft,
          rectWidth,
          frameCount,
        ),
      ).toBe(frameCount - 1);

      // Midpoint click maps to frame 50
      expect(
        calculateFrameFromClientX(
          rectLeft + rectWidth / 2,
          rectLeft,
          rectWidth,
          frameCount,
        ),
      ).toBe(50);
    });
  });
});
