import { describe, expect, it } from "vitest";
import type { Pts, Segment, TickCount } from "@/types/project";
import { getDisplayedElapsedSeconds } from "@/features/playback/presentation";
import {
  calculatePendingInRegionLayoutFromSeconds,
  calculatePercentFromPts,
  calculatePlayheadLayout,
  calculatePtsFromClientX,
  calculateSegmentDurationRational,
  calculateSegmentLayout,
  calculateSegmentTimelinePositions,
  calculateTotalDurationRational,
  canMarkIn,
  canMarkOut,
  canSplitCurrentSegment,
  findCurrentSegment,
  getActiveSourceSegmentEntries,
  getCurrentSegmentTarget,
  getSegmentBounds,
  getTimelineDurationSeconds,
  splitSegment,
} from "./math";

const pts = (value: string) => value as Pts;
const ticks = (value: string) => value as TickCount;
const frame = (value: string) => ({
  mediaTime: 1,
  inferredSourcePts: pts(value),
});

describe("timeline PTS editing", () => {
  const segments: Segment[] = [
    { id: "a", sourceId: "source-a", inPts: pts("-100"), outPts: pts("0") },
    { id: "b", sourceId: "source-a", inPts: pts("50"), outPts: pts("100") },
    { id: "c", sourceId: "source-b", inPts: pts("-100"), outPts: pts("100") },
  ];

  it("enables marks only for ready calibrated presentation state", () => {
    expect(canMarkIn("ready", frame("20"), true)).toBe(true);
    expect(canMarkIn("calibrating", frame("20"), true)).toBe(false);
    expect(canMarkIn("unavailable", frame("20"), true)).toBe(false);
    expect(canMarkIn("ready", null, true)).toBe(false);
    // No current segment: Mark In starts a pending mark, so it stays enabled.
    expect(canMarkIn("ready", frame("20"), true, getCurrentSegmentTarget(null))).toBe(
      true,
    );
  });

  it("uses the presented PTS itself as the exclusive Out boundary", () => {
    expect(canMarkOut("ready", frame("21"), pts("20"), true)).toBe(true);
    expect(canMarkOut("ready", frame("20"), pts("20"), true)).toBe(false);
    expect(canMarkOut("ready", frame("19"), pts("20"), true)).toBe(false);
  });

  it("resolves the current segment only for a known ID of the active source", () => {
    expect(findCurrentSegment(segments, "b", "source-a")).toEqual({
      index: 1,
      segment: segments[1],
    });
    expect(findCurrentSegment(segments, null, "source-a")).toBeNull();
    expect(findCurrentSegment(segments, "missing", "source-a")).toBeNull();
    // Segment "c" belongs to source-b. ADR 002 forbids reading its PTS on this timeline.
    expect(findCurrentSegment(segments, "c", "source-a")).toBeNull();
    expect(findCurrentSegment(segments, "b", null)).toBeNull();
  });

  it("parses the current segment bounds and rejects a malformed PTS", () => {
    const target = getCurrentSegmentTarget(
      findCurrentSegment(segments, "b", "source-a"),
    );
    expect(target).toEqual({
      hasSegment: true,
      bounds: { sourceId: "source-a", lo: 50n, hi: 100n },
    });
    expect(getCurrentSegmentTarget(null)).toEqual({ hasSegment: false, bounds: null });
    // A current segment that cannot be parsed is still a current segment.
    expect(
      getCurrentSegmentTarget({
        index: 0,
        segment: {
          id: "bad",
          sourceId: "source-a",
          inPts: pts("01"),
          outPts: pts("100"),
        },
      }),
    ).toEqual({ hasSegment: true, bounds: null });
  });

  it("disables every boundary action on a current segment that cannot be parsed", () => {
    // The store reads this state as "adjust the current segment" and rejects the mark,
    // so an enabled button here would do nothing.
    const target = getCurrentSegmentTarget({
      index: 0,
      segment: {
        id: "bad",
        sourceId: "source-a",
        inPts: pts("01"),
        outPts: pts("100"),
      },
    });

    expect(canMarkIn("ready", frame("60"), true, target)).toBe(false);
    expect(canMarkOut("ready", frame("60"), null, true, target)).toBe(false);
    // A pending mark cannot rescue it either: the store never holds both at once.
    expect(canMarkOut("ready", frame("60"), pts("20"), true, target)).toBe(false);
    expect(canSplitCurrentSegment(target, "ready", frame("60"), true)).toBe(false);
  });

  it("moves a boundary only while it changes the segment and keeps inPts < outPts", () => {
    // The current segment is "b", the half-open interval [50, 100).
    const target = getCurrentSegmentTarget(
      findCurrentSegment(segments, "b", "source-a"),
    );

    expect(canMarkIn("ready", frame("60"), true, target)).toBe(true);
    // An earlier In point is a legal move; only an empty result is forbidden.
    expect(canMarkIn("ready", frame("-5"), true, target)).toBe(true);
    expect(canMarkIn("ready", frame("50"), true, target)).toBe(false);
    expect(canMarkIn("ready", frame("100"), true, target)).toBe(false);
    expect(canMarkIn("ready", frame("120"), true, target)).toBe(false);

    // The store invariant keeps the pending mark null while a segment is current.
    expect(canMarkOut("ready", frame("90"), null, true, target)).toBe(true);
    expect(canMarkOut("ready", frame("200"), null, true, target)).toBe(true);
    expect(canMarkOut("ready", frame("100"), null, true, target)).toBe(false);
    expect(canMarkOut("ready", frame("50"), null, true, target)).toBe(false);
    expect(canMarkOut("ready", frame("20"), null, true, target)).toBe(false);
  });

  it("splits only a strict interior PTS of the current segment", () => {
    // The current segment is "a", the half-open interval [-100, 0).
    const target = getCurrentSegmentTarget(
      findCurrentSegment(segments, "a", "source-a"),
    );

    expect(canSplitCurrentSegment(target, "ready", frame("-50"), true)).toBe(true);
    expect(canSplitCurrentSegment(target, "ready", frame("-100"), true)).toBe(false);
    expect(canSplitCurrentSegment(target, "ready", frame("0"), true)).toBe(false);
    // A PTS inside a different segment is not a split point of the current one.
    expect(canSplitCurrentSegment(target, "ready", frame("75"), true)).toBe(false);
    expect(canSplitCurrentSegment(null, "ready", frame("-50"), true)).toBe(false);
    expect(canSplitCurrentSegment(target, "calibrating", frame("-50"), true)).toBe(
      false,
    );
    expect(canSplitCurrentSegment(target, "ready", null, true)).toBe(false);
    expect(canSplitCurrentSegment(target, "ready", frame("-50"), false)).toBe(false);

    const [left, right] = splitSegment(segments[0], pts("-25"), "right");
    expect(left).toEqual({
      id: "a",
      sourceId: "source-a",
      inPts: pts("-100"),
      outPts: pts("-25"),
    });
    expect(right).toEqual({
      id: "right",
      sourceId: "source-a",
      inPts: pts("-25"),
      outPts: pts("0"),
    });
  });

  it("models one presented frame using the following distinct PTS", () => {
    const [left] = splitSegment(
      { id: "one", sourceId: "source-a", inPts: pts("9000"), outPts: pts("12000") },
      pts("9001"),
      "rest",
    );
    expect(left).toMatchObject({ inPts: "9000", outPts: "9001" });
  });

  it("selects only active-source overlays without changing project indices", () => {
    expect(getActiveSourceSegmentEntries(segments, "source-a")).toEqual([
      { segment: segments[0], projectIndex: 0 },
      { segment: segments[1], projectIndex: 1 },
    ]);
    expect(getActiveSourceSegmentEntries(segments, "source-b")).toEqual([
      { segment: segments[2], projectIndex: 2 },
    ]);
  });

  it("drops a malformed or unordered segment from the precomputed bounds", () => {
    const malformed: Segment[] = [
      ...segments,
      { id: "bad", sourceId: "source-a", inPts: pts("01"), outPts: pts("100") },
      { id: "empty", sourceId: "source-a", inPts: pts("200"), outPts: pts("200") },
    ];
    expect(getSegmentBounds(malformed)).toEqual([
      { sourceId: "source-a", lo: -100n, hi: 0n },
      { sourceId: "source-a", lo: 50n, hi: 100n },
      { sourceId: "source-b", lo: -100n, hi: 100n },
      { sourceId: "source-a", lo: 200n, hi: 200n },
    ]);
    // An unordered pair survives the parse but can never contain a PTS.
    const unordered = getCurrentSegmentTarget(
      findCurrentSegment(malformed, "empty", "source-a"),
    );
    expect(unordered.bounds).toEqual({ sourceId: "source-a", lo: 200n, hi: 200n });
    expect(canSplitCurrentSegment(unordered, "ready", frame("200"), true)).toBe(false);
  });
});

describe("timeline extent precedence", () => {
  it("prefers reported duration ticks", () => {
    expect(
      getTimelineDurationSeconds({
        videoDurationTicks: ticks("90000"),
        videoTimeBase: { n: 1, d: 90000 },
        approximateDurationSeconds: 10,
        runtimeBrowserDuration: 20,
      }),
    ).toBe(1);
  });

  it("uses approximate metadata when duration ticks are null", () => {
    expect(
      getTimelineDurationSeconds({
        videoDurationTicks: null,
        videoTimeBase: { n: 1, d: 90000 },
        approximateDurationSeconds: 12.5,
        runtimeBrowserDuration: 20,
      }),
    ).toBe(12.5);
  });

  it("uses finite browser duration after unavailable persisted extents", () => {
    expect(
      getTimelineDurationSeconds({
        videoDurationTicks: null,
        approximateDurationSeconds: Number.NaN,
        runtimeBrowserDuration: 8.25,
      }),
    ).toBe(8.25);
  });

  it("falls through from zero approximate duration to runtime browser duration", () => {
    expect(
      getTimelineDurationSeconds({
        videoDurationTicks: null,
        approximateDurationSeconds: 0,
        runtimeBrowserDuration: 300,
      }),
    ).toBe(300);
  });

  it("returns null when runtime browser duration is zero", () => {
    expect(
      getTimelineDurationSeconds({
        videoDurationTicks: null,
        approximateDurationSeconds: 0,
        runtimeBrowserDuration: 0,
      }),
    ).toBeNull();
  });

  it("returns null for a fully indeterminate ruler", () => {
    expect(
      getTimelineDurationSeconds({
        videoDurationTicks: null,
        approximateDurationSeconds: null,
        runtimeBrowserDuration: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
  });
});

describe("exact duration math", () => {
  it("calculates exact duration from signed PTS", () => {
    expect(
      calculateSegmentDurationRational(pts("-10"), pts("20"), { n: 1, d: 6 }),
    ).toEqual({ n: 5n, d: 1n });
  });

  it("accumulates different source time bases exactly in array order", () => {
    const ordered: Segment[] = [
      { id: "b", sourceId: "b", inPts: pts("1000"), outPts: pts("1001") },
      { id: "a", sourceId: "a", inPts: pts("-20"), outPts: pts("10") },
    ];
    const bases = new Map([
      ["a", { n: 1, d: 30 }],
      ["b", { n: 1001, d: 30000 }],
    ]);

    expect(calculateTotalDurationRational(ordered, bases)).toEqual({
      n: 31001n,
      d: 30000n,
    });
    const positions = calculateSegmentTimelinePositions(ordered, bases);
    expect(positions?.map((position) => position.segmentId)).toEqual(["b", "a"]);
    expect(positions?.[0].endRational).toEqual({ n: 1001n, d: 30000n });
    expect(positions?.[1].endRational).toEqual({ n: 31001n, d: 30000n });
  });
});

describe("single-source ruler layout", () => {
  const timeBase = { n: 1, d: 1000 };

  it("lays out signed source PTS relative to videoStartPts", () => {
    const segment: Segment = {
      id: "segment",
      sourceId: "source",
      inPts: pts("-500"),
      outPts: pts("500"),
    };
    expect(calculateSegmentLayout(segment, pts("-1000"), timeBase, 2)).toEqual({
      leftPercent: 25,
      widthPercent: 50,
      left: "25%",
      width: "50%",
    });
    expect(calculatePercentFromPts(pts("0"), pts("-1000"), timeBase, 2)).toBe(50);
  });

  it("maps finite clicks to seek-request PTS and rejects unsafe conversions", () => {
    expect(calculatePtsFromClientX(50, 0, 100, 2, pts("-1000"), timeBase)).toBe("0");
    expect(
      calculatePtsFromClientX(50, 0, 100, Number.MAX_VALUE, pts("-1000"), timeBase),
    ).toBeNull();
    expect(
      calculatePtsFromClientX(Number.NaN, 0, 100, 2, pts("0"), timeBase),
    ).toBeNull();
  });

  it("clamps the playhead to the finite UI extent", () => {
    expect(calculatePlayheadLayout(1, 2)).toEqual({ percent: 50, left: "50%" });
    expect(calculatePlayheadLayout(3, 2)).toEqual({ percent: 100, left: "100%" });
    expect(calculatePlayheadLayout(Number.NaN, 2)).toEqual({ percent: 0, left: "0%" });
  });
});

describe("pending In region from the displayed position", () => {
  const timeBase = { n: 1, d: 1000 };
  const start = pts("-1000");
  // The In boundary at PTS -500 is 0.5 s into a 2 s source, so the region starts at 25%.
  const inPts = pts("-500");
  const layout = (
    pendingInPts: Pts | null | undefined,
    displayedSeconds: number | null | undefined,
  ) =>
    calculatePendingInRegionLayoutFromSeconds(
      pendingInPts,
      displayedSeconds,
      start,
      timeBase,
      2,
    );
  const hiddenAtIn = {
    isVisible: false,
    leftPercent: 25,
    widthPercent: 0,
    left: "25%",
    width: "0%",
  };

  it("spans from the In boundary to a later displayed position", () => {
    expect(layout(inPts, 1.5)).toEqual({
      isVisible: true,
      leftPercent: 25,
      widthPercent: 50,
      left: "25%",
      width: "50%",
    });
  });

  it.each([0.6, 1, 1.2345, 1.999, 2, 5])(
    "ends on the playhead for a displayed position of %s",
    (displayedSeconds) => {
      const region = layout(inPts, displayedSeconds);
      const playhead = calculatePlayheadLayout(displayedSeconds, 2);
      expect(region).toMatchObject({ isVisible: true });
      expect(
        (region?.leftPercent ?? Number.NaN) + (region?.widthPercent ?? Number.NaN),
      ).toBeCloseTo(playhead.percent, 10);
    },
  );

  it("hides the region when the displayed position is exactly at the In boundary", () => {
    expect(layout(inPts, 0.5)).toEqual(hiddenAtIn);
  });

  it("shows the region one tick after the In boundary", () => {
    const region = layout(inPts, 0.501);
    expect(region).toMatchObject({ isVisible: true, leftPercent: 25, left: "25%" });
    expect(region?.widthPercent).toBeCloseTo(0.05, 10);
  });

  it.each([0.499, 0.25, 0, -1])(
    "hides the region when the displayed position %s is before the In boundary",
    (displayedSeconds) => {
      expect(layout(inPts, displayedSeconds)).toEqual(hiddenAtIn);
    },
  );

  it.each([
    null,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("hides the region for a displayed position of %s", (displayedSeconds) => {
    expect(layout(inPts, displayedSeconds)).toEqual(hiddenAtIn);
  });

  it("clamps the right edge to the ruler extent", () => {
    expect(layout(inPts, 3)).toEqual({
      isVisible: true,
      leftPercent: 25,
      widthPercent: 75,
      left: "25%",
      width: "75%",
    });
  });

  it("starts at the left edge for an In boundary at the start of the source", () => {
    expect(layout(start, 0)).toEqual({
      isVisible: false,
      leftPercent: 0,
      widthPercent: 0,
      left: "0%",
      width: "0%",
    });
    expect(layout(start, 0.5)).toEqual({
      isVisible: true,
      leftPercent: 0,
      widthPercent: 25,
      left: "0%",
      width: "25%",
    });
  });

  it("clamps an In boundary outside the ruler extent", () => {
    // Before the start of the source, the region starts at the left edge.
    expect(layout(pts("-2000"), 0)).toMatchObject({ isVisible: false, leftPercent: 0 });
    expect(layout(pts("-2000"), 1)).toEqual({
      isVisible: true,
      leftPercent: 0,
      widthPercent: 50,
      left: "0%",
      width: "50%",
    });
    // After the end of the source, no clamped displayed position lies after it.
    expect(layout(pts("1500"), 5)).toEqual({
      isVisible: false,
      leftPercent: 100,
      widthPercent: 0,
      left: "100%",
      width: "0%",
    });
  });

  it("returns null with no pending In", () => {
    expect(layout(null, 1.5)).toBeNull();
    expect(layout(undefined, 1.5)).toBeNull();
    expect(layout(pts("1.5"), 1.5)).toBeNull();
  });

  it("returns null with no media timing", () => {
    expect(
      calculatePendingInRegionLayoutFromSeconds(inPts, 1.5, null, timeBase, 2),
    ).toBeNull();
    expect(
      calculatePendingInRegionLayoutFromSeconds(inPts, 1.5, undefined, timeBase, 2),
    ).toBeNull();
    expect(
      calculatePendingInRegionLayoutFromSeconds(inPts, 1.5, start, null, 2),
    ).toBeNull();
    expect(
      calculatePendingInRegionLayoutFromSeconds(
        inPts,
        1.5,
        start,
        { n: 0, d: 1000 },
        2,
      ),
    ).toBeNull();
  });

  it.each([null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns null for a ruler extent of %s",
    (totalDurationSeconds) => {
      expect(
        calculatePendingInRegionLayoutFromSeconds(
          inPts,
          1.5,
          start,
          timeBase,
          totalDurationSeconds,
        ),
      ).toBeNull();
    },
  );

  it("stays visible while a seek waits for its RVFC callback", () => {
    // Each seek clears presentedFrame and sets the seek target (ADR 022). The region follows
    // the target, as the playhead does, so it does not disappear until the next frame.
    const displayedSeconds = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: 1.25,
        presentedFrame: null,
        calibrationStatus: "ready",
        approximateBrowserTimeSeconds: 0.25,
      },
      start,
      timeBase,
    );
    expect(layout(inPts, displayedSeconds)).toEqual({
      isVisible: true,
      leftPercent: 25,
      widthPercent: 37.5,
      left: "25%",
      width: "37.5%",
    });
  });

  it("follows the presented frame when no seek is pending", () => {
    const displayedSeconds = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: null,
        presentedFrame: frame("500"),
        calibrationStatus: "ready",
        approximateBrowserTimeSeconds: 0.25,
      },
      start,
      timeBase,
    );
    expect(layout(inPts, displayedSeconds)).toMatchObject({
      isVisible: true,
      leftPercent: 25,
      widthPercent: 50,
    });

    // Mark In writes the PTS of the presented frame, so the region is hidden directly after it.
    const atIn = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: null,
        presentedFrame: frame("-500"),
        calibrationStatus: "ready",
        approximateBrowserTimeSeconds: 0.25,
      },
      start,
      timeBase,
    );
    expect(layout(inPts, atIn)).toEqual(hiddenAtIn);
  });
});
