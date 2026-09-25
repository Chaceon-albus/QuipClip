import { describe, expect, it } from "vitest";
import type { PresentedFrame } from "@/features/playback";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import type { Pts, Segment } from "@/types/project";
import {
  boundaryBadgeFramePts,
  describeBoundaryBadges,
  indexSegmentBoundaries,
  matchBoundaryBadges,
  type BoundaryBadgePlayback,
  type BoundaryIndex,
} from "./boundaryBadgeModel";

const pts = (value: string | number) => String(value) as Pts;

const frameAt = (value: string | number): PresentedFrame => ({
  mediaTime: Number(value) / 1000,
  inferredSourcePts: pts(value),
});

const segment = (
  id: string,
  inPts: string | number,
  outPts: string | number,
  sourceId = "s",
): Segment => ({ id, sourceId, inPts: pts(inPts), outPts: pts(outPts) });

/** A paused, calibrated source that shows the frame at `value`, with no seek pending. */
function pausedAt(
  value: string | number | null,
  overrides: Partial<BoundaryBadgePlayback> = {},
): BoundaryBadgePlayback {
  return {
    calibrationStatus: "ready",
    presentedFrame: value === null ? null : frameAt(value),
    seekTargetSeconds: null,
    hasDeferredNavigation: false,
    isPlaying: false,
    ...overrides,
  };
}

// Segment 1 is [1000, 2000), and segment 2 is [2000, 3000), as after a split at 2000.
const splitIndex: BoundaryIndex = indexSegmentBoundaries(
  [segment("a", 1000, 2000), segment("b", 2000, 3000)],
  "s",
  null,
);

describe("boundaryBadgeFramePts", () => {
  it("names the presented frame while it is paused, calibrated and settled", () => {
    expect(boundaryBadgeFramePts(pausedAt(1000), true)).toBe("1000");
  });

  it("names no frame while the calibration is not ready", () => {
    expect(
      boundaryBadgeFramePts(pausedAt(1000, { calibrationStatus: "calibrating" }), true),
    ).toBeNull();
    expect(
      boundaryBadgeFramePts(pausedAt(1000, { calibrationStatus: "unavailable" }), true),
    ).toBeNull();
  });

  it("names no frame while a seek is pending, also when an earlier frame is presented", () => {
    // ADR 022: a frame callback of an earlier seek can arrive while the last seek runs.
    expect(
      boundaryBadgeFramePts(pausedAt(1000, { seekTargetSeconds: 0 }), true),
    ).toBeNull();
    expect(
      boundaryBadgeFramePts(pausedAt(1000, { seekTargetSeconds: 1.5 }), true),
    ).toBeNull();
    expect(boundaryBadgeFramePts(pausedAt(null), true)).toBeNull();
  });

  it("names no frame while a navigation waits for the calibration anchor", () => {
    expect(
      boundaryBadgeFramePts(pausedAt(1000, { hasDeferredNavigation: true }), true),
    ).toBeNull();
  });

  it("names no frame during playback", () => {
    expect(boundaryBadgeFramePts(pausedAt(1000, { isPlaying: true }), true)).toBeNull();
  });

  it("names no frame without an active source", () => {
    expect(boundaryBadgeFramePts(pausedAt(1000), false)).toBeNull();
  });

  it("names no frame for a PTS that is not canonical", () => {
    expect(
      boundaryBadgeFramePts(
        pausedAt(null, {
          presentedFrame: { mediaTime: 1, inferredSourcePts: "01000" as Pts },
        }),
        true,
      ),
    ).toBeNull();
  });
});

describe("matchBoundaryBadges", () => {
  it("shows In on the In frame of a segment", () => {
    expect(matchBoundaryBadges(pts(1000), splitIndex)).toStrictEqual({
      outNumbers: [],
      inNumbers: [1],
      pendingIn: false,
    });
  });

  it("shows Out on the Out frame, the first frame after the segment", () => {
    expect(matchBoundaryBadges(pts(3000), splitIndex)).toStrictEqual({
      outNumbers: [2],
      inNumbers: [],
      pendingIn: false,
    });
  });

  it("matches only the exact PTS, never a neighbouring tick", () => {
    expect(matchBoundaryBadges(pts(999), splitIndex)).toBeNull();
    expect(matchBoundaryBadges(pts(1001), splitIndex)).toBeNull();
    expect(matchBoundaryBadges(pts(2999), splitIndex)).toBeNull();
    expect(matchBoundaryBadges(pts(1500), splitIndex)).toBeNull();
  });

  it("shows both badges on a shared frame: the Out of one segment and the In of the next", () => {
    expect(matchBoundaryBadges(pts(2000), splitIndex)).toStrictEqual({
      outNumbers: [1],
      inNumbers: [2],
      pendingIn: false,
    });
  });

  it("lists every segment that shares a boundary, in export order", () => {
    // Overlapping segments are legal (ADR 007). The project order is the export order.
    const index = indexSegmentBoundaries(
      [segment("late", 5000, 9000), segment("a", 1000, 9000), segment("b", 1000, 4000)],
      "s",
      null,
    );
    expect(matchBoundaryBadges(pts(1000), index)).toStrictEqual({
      outNumbers: [],
      inNumbers: [2, 3],
      pendingIn: false,
    });
    expect(matchBoundaryBadges(pts(9000), index)).toStrictEqual({
      outNumbers: [1, 2],
      inNumbers: [],
      pendingIn: false,
    });
  });

  it("shows In on the pending In mark", () => {
    const index = indexSegmentBoundaries([segment("a", 1000, 2000)], "s", pts(4000));
    expect(matchBoundaryBadges(pts(4000), index)).toStrictEqual({
      outNumbers: [],
      inNumbers: [],
      pendingIn: true,
    });
  });

  it("shows the pending In mark with a segment Out on the same frame", () => {
    // Mark In on the Out frame of a finished segment starts the next segment there.
    const index = indexSegmentBoundaries([segment("a", 1000, 2000)], "s", pts(2000));
    expect(matchBoundaryBadges(pts(2000), index)).toStrictEqual({
      outNumbers: [1],
      inNumbers: [],
      pendingIn: true,
    });
  });

  it("shows nothing with no frame", () => {
    expect(matchBoundaryBadges(null, splitIndex)).toBeNull();
  });

  it("compares signed i64 PTS values exactly", () => {
    // Both values are beyond the safe integer range of a double, one tick apart.
    const big = "9223372036854775806";
    const index = indexSegmentBoundaries(
      [segment("neg", "-9223372036854775808", "-5"), segment("big", "-5", big)],
      "s",
      null,
    );
    expect(matchBoundaryBadges(pts(big), index)?.outNumbers).toStrictEqual([2]);
    expect(matchBoundaryBadges(pts("9223372036854775807"), index)).toBeNull();
    expect(matchBoundaryBadges(pts("9223372036854775805"), index)).toBeNull();
    expect(matchBoundaryBadges(pts(-5), index)).toStrictEqual({
      outNumbers: [1],
      inNumbers: [2],
      pendingIn: false,
    });
    expect(matchBoundaryBadges(pts("-9223372036854775808"), index)?.inNumbers).toEqual([
      1,
    ]);
  });
});

describe("indexSegmentBoundaries", () => {
  it("numbers the segments of the active source in export order, as the timeline does", () => {
    const index = indexSegmentBoundaries(
      [segment("old", 1000, 2000, "other"), segment("a", 3000, 4000)],
      "s",
      null,
    );
    // The segment of the other source does not count, and its PTS values are not
    // comparable with those of the active source (ADR 002).
    expect(matchBoundaryBadges(pts(1000), index)).toBeNull();
    expect(matchBoundaryBadges(pts(3000), index)?.inNumbers).toStrictEqual([1]);
  });

  it("skips a segment that is not a valid half-open interval and keeps the numbers", () => {
    const index = indexSegmentBoundaries(
      [
        segment("empty", 1000, 1000),
        segment("bad", "x", 2000),
        segment("a", 3000, 4000),
      ],
      "s",
      null,
    );
    expect(matchBoundaryBadges(pts(1000), index)).toBeNull();
    expect(matchBoundaryBadges(pts(2000), index)).toBeNull();
    expect(matchBoundaryBadges(pts(3000), index)?.inNumbers).toStrictEqual([3]);
  });

  it("has no boundary without an active source", () => {
    const index = indexSegmentBoundaries([segment("a", 1000, 2000)], null, pts(1000));
    expect(index).toStrictEqual({ segments: [], pendingInPts: null });
  });

  it("ignores a pending In mark that does not parse", () => {
    expect(indexSegmentBoundaries([], "s", "1e3" as Pts).pendingInPts).toBeNull();
  });
});

describe("the frame gate and the match together, as the badges run them", () => {
  const badgesAt = (playback: BoundaryBadgePlayback, hasActiveSource = true) =>
    matchBoundaryBadges(boundaryBadgeFramePts(playback, hasActiveSource), splitIndex);

  it("shows the badges of the paused frame on screen", () => {
    expect(badgesAt(pausedAt(2000))).toStrictEqual({
      outNumbers: [1],
      inNumbers: [2],
      pendingIn: false,
    });
  });

  it("shows no badge on a boundary frame while not calibrated, seeking or playing", () => {
    for (const playback of [
      pausedAt(2000, { calibrationStatus: "calibrating" }),
      pausedAt(2000, { calibrationStatus: "unavailable" }),
      pausedAt(2000, { seekTargetSeconds: 1 }),
      pausedAt(2000, { hasDeferredNavigation: true }),
      pausedAt(2000, { isPlaying: true }),
      pausedAt(null),
    ]) {
      expect(badgesAt(playback)).toBeNull();
    }
    expect(badgesAt(pausedAt(2000), false)).toBeNull();
  });
});

describe("describeBoundaryBadges", () => {
  it("gives one line for each boundary, with the segment number", () => {
    expect(
      describeBoundaryBadges({ outNumbers: [1], inNumbers: [2, 3], pendingIn: true }),
    ).toStrictEqual({
      out: [{ key: "preview.boundaryBadge.outOfSegment", values: { index: 1 } }],
      in: [
        { key: "preview.boundaryBadge.inOfSegment", values: { index: 2 } },
        { key: "preview.boundaryBadge.inOfSegment", values: { index: 3 } },
        { key: "preview.boundaryBadge.inPending" },
      ],
    });
  });

  it("gives no line to a badge that does not show", () => {
    expect(
      describeBoundaryBadges({ outNumbers: [4], inNumbers: [], pendingIn: false }).in,
    ).toStrictEqual([]);
  });
});

describe("the catalog text of the badges", () => {
  it("says in both languages that the Out frame is not in the segment", () => {
    expect(en.preview.boundaryBadge.outOfSegment).toContain("{{index}}");
    expect(en.preview.boundaryBadge.outOfSegment).toContain("not in the segment");
    expect(zhCN.preview.boundaryBadge.outOfSegment).toContain("{{index}}");
    expect(zhCN.preview.boundaryBadge.outOfSegment).toContain("不在片段内");
    expect(zhCN.preview.boundaryBadge.inOfSegment).toContain("{{index}}");
  });

  it("uses the terms of the transport bar in Chinese", () => {
    expect(zhCN.preview.boundaryBadge.in).toBe(zhCN.transport.action.markIn);
    expect(zhCN.preview.boundaryBadge.out).toBe(zhCN.transport.action.markOut);
  });
});
