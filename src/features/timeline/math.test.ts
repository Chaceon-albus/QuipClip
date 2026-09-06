import { describe, expect, it } from "vitest";
import type { Pts, Segment, TickCount } from "@/types/project";
import {
  calculatePendingInRegionLayout,
  calculatePercentFromPts,
  calculatePlayheadLayout,
  calculatePtsFromClientX,
  calculateSegmentDurationRational,
  calculateSegmentLayout,
  calculateSegmentTimelinePositions,
  calculateTotalDurationRational,
  canMarkIn,
  canMarkOut,
  canSplit,
  canSplitWithBounds,
  findSplittableSegmentIndex,
  getActiveSourceSegmentEntries,
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
  });

  it("uses the presented PTS itself as the exclusive Out boundary", () => {
    expect(canMarkOut("ready", frame("21"), pts("20"), true)).toBe(true);
    expect(canMarkOut("ready", frame("20"), pts("20"), true)).toBe(false);
    expect(canMarkOut("ready", frame("19"), pts("20"), true)).toBe(false);
  });

  it("finds and splits only strict interior PTS for the active source", () => {
    expect(findSplittableSegmentIndex(segments, pts("-50"), "source-a")).toBe(0);
    expect(findSplittableSegmentIndex(segments, pts("-100"), "source-a")).toBe(-1);
    expect(findSplittableSegmentIndex(segments, pts("0"), "source-a")).toBe(-1);
    expect(canSplit(segments, "ready", frame("75"), true, "source-a")).toBe(true);
    expect(canSplit(segments, "ready", frame("0"), true, "source-a")).toBe(false);

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
    expect(
      canSplitWithBounds(
        getSegmentBounds(malformed),
        "ready",
        frame("200"),
        true,
        "source-a",
      ),
    ).toBe(false);
  });

  it("agrees with canSplit for every case the bounds path replaces", () => {
    const bounds = getSegmentBounds(segments);
    const cases: Array<[Parameters<typeof canSplit>[1], string, boolean, string]> = [
      ["ready", "75", true, "source-a"],
      ["ready", "0", true, "source-a"],
      ["ready", "-50", true, "source-a"],
      ["ready", "-50", true, "source-b"],
      ["calibrating", "75", true, "source-a"],
      ["ready", "75", false, "source-a"],
    ];
    for (const [status, value, hasActiveSource, activeSourceId] of cases) {
      expect(
        canSplitWithBounds(
          bounds,
          status,
          frame(value),
          hasActiveSource,
          activeSourceId,
        ),
      ).toBe(canSplit(segments, status, frame(value), hasActiveSource, activeSourceId));
    }
    expect(canSplitWithBounds(bounds, "ready", null, true, "source-a")).toBe(false);
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

  it("shows a pending region only after a distinct later PTS", () => {
    expect(
      calculatePendingInRegionLayout(
        pts("-500"),
        pts("500"),
        pts("-1000"),
        timeBase,
        2,
      ),
    ).toMatchObject({ isVisible: true, leftPercent: 25, widthPercent: 50 });
    expect(
      calculatePendingInRegionLayout(
        pts("-500"),
        pts("-500"),
        pts("-1000"),
        timeBase,
        2,
      ),
    ).toMatchObject({ isVisible: false, widthPercent: 0 });
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
