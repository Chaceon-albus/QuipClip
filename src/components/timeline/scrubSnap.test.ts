import { describe, expect, it } from "vitest";
import { calculateSegmentLayout } from "@/features/timeline";
import type { Pts, Rational, Segment } from "@/types/project";
import {
  buildSnapBoundaries,
  collectSnapBoundaries,
  createSnapBoundaryCache,
  resolveDragDirection,
  resolveScrubSnap,
  SCRUB_SNAP_THRESHOLD_PX,
  type ScrubSnapInput,
  type SnapBoundarySource,
} from "./scrubSnap";

const pts = (value: string) => value as Pts;

// 1/1000 s per tick, first frame at PTS -1000, a 10 s extent.
const timeBase: Rational = { n: 1, d: 1000 };

const segments: Segment[] = [
  { id: "a", sourceId: "src", inPts: pts("1000"), outPts: pts("3000") },
  // Meets segment a after a split: its In is the Out of a.
  { id: "b", sourceId: "src", inPts: pts("3000"), outPts: pts("5000") },
  // Another source: its PTS values do not belong to this time axis.
  { id: "c", sourceId: "other", inPts: pts("2000"), outPts: pts("4000") },
  // An invalid range gives no boundary.
  { id: "d", sourceId: "src", inPts: pts("6000"), outPts: pts("6000") },
];

function source(overrides: Partial<SnapBoundarySource> = {}): SnapBoundarySource {
  return {
    segments,
    sourceId: "src",
    pendingInPts: null,
    videoStartPts: pts("-1000"),
    videoTimeBase: timeBase,
    totalDurationSeconds: 10,
    ...overrides,
  };
}

function snapInput(overrides: Partial<ScrubSnapInput> = {}): ScrubSnapInput {
  return {
    pointerX: 100,
    boundaryXs: [],
    visibleRange: { left: 0, right: 1000 },
    thresholdPx: SCRUB_SNAP_THRESHOLD_PX,
    isSnapSuppressed: false,
    canSeekExactly: true,
    direction: 0,
    ...overrides,
  };
}

describe("collectSnapBoundaries", () => {
  it("collects the In and the Out of each valid segment of the active source, once each, in time order", () => {
    expect(collectSnapBoundaries(source())).toEqual([
      { pts: "1000", elapsedSeconds: 2, ratio: 0.2 },
      { pts: "3000", elapsedSeconds: 4, ratio: 0.4 },
      { pts: "5000", elapsedSeconds: 6, ratio: 0.6 },
    ]);
  });

  it("keeps the stored PTS strings, so a snap seeks to the exact boundary", () => {
    const boundaries = collectSnapBoundaries(
      source({
        segments: [
          { id: "a", sourceId: "src", inPts: pts("1234"), outPts: pts("1235") },
        ],
      }),
    );
    expect(boundaries.map((boundary) => boundary.pts)).toEqual(["1234", "1235"]);
  });

  it("adds the pending In, and merges it with a segment boundary at the same PTS", () => {
    expect(
      collectSnapBoundaries(source({ pendingInPts: pts("7000") })).map((b) => b.pts),
    ).toEqual(["1000", "3000", "5000", "7000"]);
    expect(
      collectSnapBoundaries(source({ pendingInPts: pts("3000") })).map((b) => b.pts),
    ).toEqual(["1000", "3000", "5000"]);
    expect(
      collectSnapBoundaries(source({ segments: [], pendingInPts: pts("0") })),
    ).toEqual([{ pts: "0", elapsedSeconds: 1, ratio: 0.1 }]);
  });

  it("orders by PTS and not by the order of the project array", () => {
    const reversed = [...segments].reverse();
    expect(
      collectSnapBoundaries(source({ segments: reversed })).map((b) => b.pts),
    ).toEqual(["1000", "3000", "5000"]);
  });

  it("gives each boundary the ratio at which the segment layer draws it", () => {
    const [first] = segments;
    const layout = calculateSegmentLayout(first, pts("-1000"), timeBase, 10);
    const [inBoundary, outBoundary] = collectSnapBoundaries(
      source({ segments: [first] }),
    );
    expect(inBoundary.ratio * 100).toBeCloseTo(layout.leftPercent, 12);
    expect(outBoundary.ratio * 100).toBeCloseTo(
      layout.leftPercent + layout.widthPercent,
      12,
    );
  });

  it("keeps the boundaries at the two ends of the extent, and leaves out a boundary outside it", () => {
    const edges: Segment[] = [
      { id: "a", sourceId: "src", inPts: pts("-1000"), outPts: pts("9000") },
      { id: "b", sourceId: "src", inPts: pts("-2000"), outPts: pts("9001") },
    ];
    expect(collectSnapBoundaries(source({ segments: edges }))).toEqual([
      { pts: "-1000", elapsedSeconds: 0, ratio: 0 },
      { pts: "9000", elapsedSeconds: 10, ratio: 1 },
    ]);
  });

  it("returns no boundary when the time axis is not usable", () => {
    expect(collectSnapBoundaries(source({ sourceId: null }))).toEqual([]);
    expect(collectSnapBoundaries(source({ videoStartPts: null }))).toEqual([]);
    expect(collectSnapBoundaries(source({ videoTimeBase: null }))).toEqual([]);
    expect(collectSnapBoundaries(source({ videoTimeBase: { n: 0, d: 1 } }))).toEqual(
      [],
    );
    expect(collectSnapBoundaries(source({ totalDurationSeconds: null }))).toEqual([]);
    expect(collectSnapBoundaries(source({ totalDurationSeconds: 0 }))).toEqual([]);
    expect(collectSnapBoundaries(source({ totalDurationSeconds: Infinity }))).toEqual(
      [],
    );
  });

  it("shares its candidate rule with buildSnapBoundaries", () => {
    // Each PTS once, in time order, inside the extent, and only canonical PTS strings.
    expect(
      buildSnapBoundaries(
        [pts("3000"), pts("1000"), pts("3000"), pts("9001"), pts("01"), pts("-1000")],
        pts("-1000"),
        timeBase,
        10,
      ),
    ).toEqual([
      { pts: "-1000", elapsedSeconds: 0, ratio: 0 },
      { pts: "1000", elapsedSeconds: 2, ratio: 0.2 },
      { pts: "3000", elapsedSeconds: 4, ratio: 0.4 },
    ]);
    expect(buildSnapBoundaries([pts("1000")], pts("-1000"), timeBase, 0)).toEqual([]);
    expect(buildSnapBoundaries([pts("1000")], pts("-1000"), timeBase, NaN)).toEqual([]);
  });

  it("ignores a segment or a pending In that is not a canonical PTS", () => {
    expect(
      collectSnapBoundaries(
        source({
          segments: [
            { id: "a", sourceId: "src", inPts: pts("1e3"), outPts: pts("3000") },
          ],
          pendingInPts: pts(" 5000"),
        }),
      ),
    ).toEqual([]);
  });
});

describe("createSnapBoundaryCache", () => {
  it("builds the list again only when an input changes", () => {
    const read = createSnapBoundaryCache();
    const first = read(source());
    // A new input object with the same fields keeps the list.
    expect(read(source())).toBe(first);

    const withPending = read(source({ pendingInPts: pts("7000") }));
    expect(withPending).not.toBe(first);
    expect(withPending.map((b) => b.pts)).toContain("7000");

    const newSegments = [...segments];
    expect(read(source({ pendingInPts: pts("7000"), segments: newSegments }))).not.toBe(
      withPending,
    );
    expect(read(source({ totalDurationSeconds: 20 }))[0]?.ratio).toBe(0.1);
  });
});

describe("resolveScrubSnap", () => {
  it("snaps to a boundary within the threshold, including at the threshold", () => {
    expect(resolveScrubSnap(snapInput({ boundaryXs: [103] }))).toBe(0);
    expect(resolveScrubSnap(snapInput({ boundaryXs: [106] }))).toBe(0);
    expect(resolveScrubSnap(snapInput({ boundaryXs: [94] }))).toBe(0);
    expect(resolveScrubSnap(snapInput({ boundaryXs: [106.01] }))).toBeNull();
    expect(resolveScrubSnap(snapInput({ boundaryXs: [93.99] }))).toBeNull();
  });

  it("uses a threshold of 6 px", () => {
    expect(SCRUB_SNAP_THRESHOLD_PX).toBe(6);
  });

  it("returns null with no boundary", () => {
    expect(resolveScrubSnap(snapInput())).toBeNull();
  });

  it("picks the nearest boundary", () => {
    expect(resolveScrubSnap(snapInput({ boundaryXs: [95, 102, 105] }))).toBe(1);
    expect(resolveScrubSnap(snapInput({ boundaryXs: [105, 97] }))).toBe(1);
    expect(resolveScrubSnap(snapInput({ boundaryXs: [80, 100, 120] }))).toBe(1);
  });

  it("gives a tie to the boundary in the direction of the drag", () => {
    const boundaryXs = [97, 103];
    expect(resolveScrubSnap(snapInput({ boundaryXs, direction: 1 }))).toBe(1);
    expect(resolveScrubSnap(snapInput({ boundaryXs, direction: -1 }))).toBe(0);
    // The order of the list does not change the rule.
    expect(resolveScrubSnap(snapInput({ boundaryXs: [103, 97], direction: 1 }))).toBe(
      0,
    );
    expect(resolveScrubSnap(snapInput({ boundaryXs: [103, 97], direction: -1 }))).toBe(
      1,
    );
  });

  it("gives a tie with no direction, or at one position, to the first boundary", () => {
    expect(resolveScrubSnap(snapInput({ boundaryXs: [97, 103], direction: 0 }))).toBe(
      0,
    );
    expect(resolveScrubSnap(snapInput({ boundaryXs: [103, 97], direction: 0 }))).toBe(
      0,
    );
    expect(resolveScrubSnap(snapInput({ boundaryXs: [103, 103], direction: 1 }))).toBe(
      0,
    );
    expect(resolveScrubSnap(snapInput({ boundaryXs: [100, 100], direction: -1 }))).toBe(
      0,
    );
  });

  it("does not let a nearer boundary behind the drag lose to a farther one ahead of it", () => {
    expect(resolveScrubSnap(snapInput({ boundaryXs: [98, 104], direction: 1 }))).toBe(
      0,
    );
  });

  it("snaps only to a boundary inside the visible range, the two ends included", () => {
    const visibleRange = { left: 96, right: 1000 };
    // Under the sticky gutter, and past the right edge.
    expect(
      resolveScrubSnap(snapInput({ pointerX: 98, boundaryXs: [95], visibleRange })),
    ).toBeNull();
    expect(
      resolveScrubSnap(snapInput({ pointerX: 998, boundaryXs: [1001], visibleRange })),
    ).toBeNull();
    // On the edges.
    expect(
      resolveScrubSnap(snapInput({ pointerX: 98, boundaryXs: [96], visibleRange })),
    ).toBe(0);
    expect(
      resolveScrubSnap(snapInput({ pointerX: 998, boundaryXs: [1000], visibleRange })),
    ).toBe(0);
  });

  it("lets a boundary inside the visible range win over a nearer one outside it", () => {
    expect(
      resolveScrubSnap(
        snapInput({
          pointerX: 98,
          boundaryXs: [95.5, 102],
          visibleRange: { left: 96, right: 1000 },
        }),
      ),
    ).toBe(1);
  });

  it("does not snap with a visible range that is NaN", () => {
    expect(
      resolveScrubSnap(
        snapInput({ boundaryXs: [100], visibleRange: { left: NaN, right: 1000 } }),
      ),
    ).toBeNull();
  });

  it("does not snap while the modifier is held", () => {
    expect(
      resolveScrubSnap(snapInput({ boundaryXs: [100], isSnapSuppressed: true })),
    ).toBeNull();
  });

  it("does not snap without a precise seek, because no stored PTS can then be reached", () => {
    expect(
      resolveScrubSnap(snapInput({ boundaryXs: [100], canSeekExactly: false })),
    ).toBeNull();
  });

  it("ignores positions that are not finite", () => {
    expect(resolveScrubSnap(snapInput({ boundaryXs: [NaN, Infinity, 104] }))).toBe(2);
    expect(
      resolveScrubSnap(snapInput({ pointerX: NaN, boundaryXs: [100] })),
    ).toBeNull();
    expect(
      resolveScrubSnap(snapInput({ thresholdPx: NaN, boundaryXs: [100] })),
    ).toBeNull();
    expect(
      resolveScrubSnap(snapInput({ thresholdPx: -1, boundaryXs: [100] })),
    ).toBeNull();
  });
});

describe("resolveDragDirection", () => {
  it("follows the sign of the move on the lane", () => {
    expect(resolveDragDirection(100, 110, 0)).toBe(1);
    expect(resolveDragDirection(100, 90, 0)).toBe(-1);
    expect(resolveDragDirection(100, 90, 1)).toBe(-1);
  });

  it("keeps the previous direction for a sample that does not move", () => {
    expect(resolveDragDirection(100, 100, 1)).toBe(1);
    expect(resolveDragDirection(100, 100, -1)).toBe(-1);
    expect(resolveDragDirection(100, 100, 0)).toBe(0);
  });

  it("keeps the previous direction with no earlier position or an input that is not finite", () => {
    expect(resolveDragDirection(null, 100, 0)).toBe(0);
    expect(resolveDragDirection(null, 100, -1)).toBe(-1);
    expect(resolveDragDirection(NaN, 100, 1)).toBe(1);
    expect(resolveDragDirection(100, Infinity, -1)).toBe(-1);
  });
});
