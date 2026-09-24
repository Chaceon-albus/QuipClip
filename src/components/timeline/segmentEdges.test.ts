import { describe, expect, it } from "vitest";
import type { BoundarySeekPlayback } from "@/components/layout/shortcutCommands";
import { calculateSegmentLayout } from "@/features/timeline";
import type { Pts, Rational, Segment } from "@/types/project";
import {
  NO_SEGMENT_EDGES,
  SEGMENT_EDGE_HANDLES_MIN_WIDTH_PX,
  SEGMENT_EDGE_HIT_WIDTH_PX,
  SEGMENT_EDGE_MIN_BODY_WIDTH_PX,
  SEGMENT_FOCUS_RING_INSET_MIN_WIDTH_PX,
  buildSegmentEdgeEntries,
  calculateVisibleEdgeAnchor,
  parseSegmentEdge,
  planSegmentEdgeSeek,
  resolveSegmentFocusRing,
  resolveShownSegmentEdge,
  showsSegmentEdgeHandles,
} from "./segmentEdges";
import { buildSegmentTooltipRows, type SegmentTooltipRow } from "./segmentLabels";

const pts = (value: string) => value as Pts;

const tb90k: Rational = { n: 1, d: 90000 };

const segment = (inPts: string, outPts: string): Segment => ({
  id: "s1",
  sourceId: "source-1",
  inPts: pts(inPts),
  outPts: pts(outPts),
});

const rows: readonly SegmentTooltipRow[] = buildSegmentTooltipRows({
  inTime: "00:00:01:00",
  outTime: "00:00:03:00",
  duration: "00:00:02:00",
  compactDuration: "02:00",
});
const inRow = rows[0];
const outRow = rows[1];

describe("showsSegmentEdgeHandles", () => {
  it("needs room for two hit areas and the 12px body between them", () => {
    expect(SEGMENT_EDGE_HIT_WIDTH_PX).toBe(6);
    expect(SEGMENT_EDGE_MIN_BODY_WIDTH_PX).toBe(12);
    expect(SEGMENT_EDGE_HANDLES_MIN_WIDTH_PX).toBe(24);
  });

  it("shows the handles from the minimum width, and not below it", () => {
    expect(showsSegmentEdgeHandles(24)).toBe(true);
    expect(showsSegmentEdgeHandles(400)).toBe(true);
    expect(showsSegmentEdgeHandles(23.99)).toBe(false);
    expect(showsSegmentEdgeHandles(12)).toBe(false);
    expect(showsSegmentEdgeHandles(0)).toBe(false);
  });

  it("keeps the two hit areas apart, with the body between them, at the minimum width", () => {
    const width = SEGMENT_EDGE_HANDLES_MIN_WIDTH_PX;
    const inEnd = SEGMENT_EDGE_HIT_WIDTH_PX;
    const outStart = width - SEGMENT_EDGE_HIT_WIDTH_PX;
    expect(outStart - inEnd).toBeGreaterThanOrEqual(SEGMENT_EDGE_MIN_BODY_WIDTH_PX);
  });

  it("shows no handles for a width that is not finite", () => {
    expect(showsSegmentEdgeHandles(Number.NaN)).toBe(false);
    expect(showsSegmentEdgeHandles(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("parseSegmentEdge", () => {
  it("reads the two edges and nothing else", () => {
    expect(parseSegmentEdge("in")).toBe("in");
    expect(parseSegmentEdge("out")).toBe("out");
    expect(parseSegmentEdge("In")).toBeNull();
    expect(parseSegmentEdge("")).toBeNull();
    expect(parseSegmentEdge(null)).toBeNull();
    expect(parseSegmentEdge(undefined)).toBeNull();
  });
});

describe("buildSegmentEdgeEntries", () => {
  it("places both boundaries on the lane, with the row of each", () => {
    // 1 s to 3 s of a 10 s source.
    const edges = buildSegmentEdgeEntries(
      segment("90000", "270000"),
      pts("0"),
      tb90k,
      10,
      rows,
    );
    expect(edges).toStrictEqual({
      in: { percent: 10, row: inRow },
      out: { percent: 30, row: outRow },
    });
  });

  it("puts an In edge that is not clamped exactly at the left of the segment box", () => {
    const seg = segment("123457", "270001");
    const layout = calculateSegmentLayout(seg, pts("1"), tb90k, 7.3);
    const edges = buildSegmentEdgeEntries(seg, pts("1"), tb90k, 7.3, rows);
    expect(edges.in?.percent).toBe(layout.leftPercent);
  });

  it("counts from the start PTS of the source, also a negative one", () => {
    const edges = buildSegmentEdgeEntries(
      segment("-90000", "0"),
      pts("-180000"),
      tb90k,
      4,
      rows,
    );
    expect(edges.in?.percent).toBe(25);
    expect(edges.out?.percent).toBe(50);
  });

  it("gives no handle to a boundary outside the source extent", () => {
    // The Out boundary at 12 s lies after the 10 s extent, and the layout clamps it.
    const late = buildSegmentEdgeEntries(
      segment("90000", "1080000"),
      pts("0"),
      tb90k,
      10,
      rows,
    );
    expect(late.in?.percent).toBe(10);
    expect(late.out).toBeNull();
    // The In boundary lies before the start PTS.
    const early = buildSegmentEdgeEntries(
      segment("-90000", "90000"),
      pts("0"),
      tb90k,
      10,
      rows,
    );
    expect(early.in).toBeNull();
    expect(early.out?.percent).toBe(10);
  });

  it("keeps a boundary on either end of the extent", () => {
    const edges = buildSegmentEdgeEntries(
      segment("0", "900000"),
      pts("0"),
      tb90k,
      10,
      rows,
    );
    expect(edges.in?.percent).toBe(0);
    expect(edges.out?.percent).toBe(100);
  });

  it("has no edges without the rows of the times", () => {
    expect(
      buildSegmentEdgeEntries(segment("90000", "270000"), pts("0"), tb90k, 10, []),
    ).toBe(NO_SEGMENT_EDGES);
  });

  it("has no edges for missing timing, an invalid range or an unknown extent", () => {
    const seg = segment("90000", "270000");
    expect(buildSegmentEdgeEntries(seg, null, tb90k, 10, rows)).toBe(NO_SEGMENT_EDGES);
    expect(buildSegmentEdgeEntries(seg, pts("0"), null, 10, rows)).toBe(
      NO_SEGMENT_EDGES,
    );
    expect(buildSegmentEdgeEntries(seg, pts("0"), tb90k, null, rows)).toBe(
      NO_SEGMENT_EDGES,
    );
    expect(buildSegmentEdgeEntries(seg, pts("0"), tb90k, 0, rows)).toBe(
      NO_SEGMENT_EDGES,
    );
    expect(buildSegmentEdgeEntries(seg, pts("0"), tb90k, Number.NaN, rows)).toBe(
      NO_SEGMENT_EDGES,
    );
    expect(
      buildSegmentEdgeEntries(segment("270000", "90000"), pts("0"), tb90k, 10, rows),
    ).toBe(NO_SEGMENT_EDGES);
    expect(
      buildSegmentEdgeEntries(segment("90000", "90000"), pts("0"), tb90k, 10, rows),
    ).toBe(NO_SEGMENT_EDGES);
  });
});

describe("resolveShownSegmentEdge", () => {
  const both = {
    in: { percent: 10, row: inRow },
    out: { percent: 30, row: outRow },
  };

  it("shows the edge that the controller names while its handle shows", () => {
    expect(resolveShownSegmentEdge("in", both, 200)).toBe("in");
    expect(resolveShownSegmentEdge("out", both, 24)).toBe("out");
  });

  it("shows the body once a zoom out makes the segment too narrow for handles", () => {
    expect(resolveShownSegmentEdge("in", both, 23.99)).toBeNull();
    expect(resolveShownSegmentEdge("out", both, 5)).toBeNull();
    expect(resolveShownSegmentEdge("out", both, Number.NaN)).toBeNull();
  });

  it("shows the body for the body part and for an edge that has no handle", () => {
    expect(resolveShownSegmentEdge("body", both, 200)).toBeNull();
    expect(resolveShownSegmentEdge("out", { ...both, out: null }, 200)).toBeNull();
    expect(resolveShownSegmentEdge("in", NO_SEGMENT_EDGES, 200)).toBeNull();
  });
});

describe("calculateVisibleEdgeAnchor", () => {
  // A lane 10000px wide, scrolled so that client x 0 is lane x 3000. The viewport shows
  // client x 96 (the right edge of the gutter) to 1096.
  const lane = { left: -3000, width: 10000 };
  const visible = { left: 96, right: 1096 };

  it("anchors a line of zero width on a visible boundary", () => {
    // Lane x 3500: client x 500.
    expect(calculateVisibleEdgeAnchor("in", 35, lane, visible)).toStrictEqual({
      left: "35%",
      width: "0%",
      visible: true,
    });
    expect(calculateVisibleEdgeAnchor("out", 35, lane, visible)).toStrictEqual({
      left: "35%",
      width: "0%",
      visible: true,
    });
  });

  it("moves the anchor into the visible part of an In hit area under the gutter", () => {
    // The boundary is at client x 94, 2px under the gutter. The hit area ends at client x
    // 100, so client x 96 to 100 is visible, and the anchor moves to client x 96, lane x 3096.
    const anchor = calculateVisibleEdgeAnchor("in", 30.94, lane, visible);
    expect(anchor.visible).toBe(true);
    expect(Number.parseFloat(anchor.left)).toBeCloseTo(30.96, 10);
    expect(anchor.width).toBe("0%");
  });

  it("moves the anchor into the visible part of an Out hit area past the viewport edge", () => {
    // The boundary is at client x 1099. The hit area starts at client x 1093, so client x
    // 1093 to 1096 is visible, and the anchor moves to client x 1096, lane x 4096.
    const anchor = calculateVisibleEdgeAnchor("out", 40.99, lane, visible);
    expect(anchor.visible).toBe(true);
    expect(Number.parseFloat(anchor.left)).toBeCloseTo(40.96, 10);
  });

  it("marks the anchor not visible when no part of the hit area is visible", () => {
    // The In hit area at client x 80 to 86 lies under the gutter.
    expect(calculateVisibleEdgeAnchor("in", 30.8, lane, visible)).toStrictEqual({
      left: "30.8%",
      width: "0%",
      visible: false,
    });
    // The Out hit area of a boundary at client x 96 lies at client x 90 to 96, which ends
    // where the visible part starts.
    expect(calculateVisibleEdgeAnchor("out", 30.96, lane, visible).visible).toBe(false);
    // The In hit area of a boundary at client x 1096 starts where the visible part ends.
    expect(calculateVisibleEdgeAnchor("in", 40.96, lane, visible).visible).toBe(false);
  });

  it("anchors on the boundary and marks it visible when the lane has no width", () => {
    expect(
      calculateVisibleEdgeAnchor("out", 12.5, { left: 0, width: 0 }, visible),
    ).toStrictEqual({ left: "12.5%", width: "0%", visible: true });
  });
});

describe("planSegmentEdgeSeek", () => {
  /** A calibrated source at 1 s (PTS 90000) with no seek pending. */
  const ready: BoundarySeekPlayback = {
    calibrationStatus: "ready",
    presentedFrame: { mediaTime: 1, inferredSourcePts: pts("90000") },
    seekTargetSeconds: null,
  };
  const seg = segment("180000", "270000");

  it("seeks to the stored In PTS for the In edge", () => {
    expect(planSegmentEdgeSeek("in", seg, ready, true)).toBe("180000");
  });

  it("seeks to the stored Out PTS, the first frame after the segment, for the Out edge", () => {
    expect(planSegmentEdgeSeek("out", seg, ready, true)).toBe("270000");
  });

  it("keeps the exact PTS of a boundary that a number cannot hold", () => {
    const large = segment("9007199254740993", "9007199254740995");
    expect(planSegmentEdgeSeek("in", large, ready, true)).toBe("9007199254740993");
    expect(planSegmentEdgeSeek("out", large, ready, true)).toBe("9007199254740995");
  });

  it("does not seek when the boundary is the frame already on screen", () => {
    const atIn: BoundarySeekPlayback = {
      ...ready,
      presentedFrame: { mediaTime: 2, inferredSourcePts: pts("180000") },
    };
    expect(planSegmentEdgeSeek("in", seg, atIn, true)).toBeNull();
    expect(planSegmentEdgeSeek("out", seg, atIn, true)).toBe("270000");
  });

  it("seeks while another seek is pending, also to the frame on screen", () => {
    const pending: BoundarySeekPlayback = {
      ...ready,
      presentedFrame: { mediaTime: 2, inferredSourcePts: pts("180000") },
      seekTargetSeconds: 5,
    };
    expect(planSegmentEdgeSeek("in", seg, pending, true)).toBe("180000");
  });

  it("does not seek without an active source or a ready calibration", () => {
    expect(planSegmentEdgeSeek("in", seg, ready, false)).toBeNull();
    for (const calibrationStatus of ["calibrating", "unavailable"] as const) {
      expect(
        planSegmentEdgeSeek("out", seg, { ...ready, calibrationStatus }, true),
      ).toBeNull();
    }
  });

  it("does not seek to a malformed boundary", () => {
    expect(planSegmentEdgeSeek("in", segment("1.5", "270000"), ready, true)).toBeNull();
  });
});

describe("resolveSegmentFocusRing", () => {
  it("puts the ring inside the box, in the colour that contrasts with the fill", () => {
    expect(resolveSegmentFocusRing(200, false)).toStrictEqual({
      placement: "inset",
      tone: "foreground",
    });
    expect(resolveSegmentFocusRing(200, true)).toStrictEqual({
      placement: "inset",
      tone: "primaryForeground",
    });
  });

  it("puts the ring outside a narrow segment, in the colour that contrasts with the track", () => {
    expect(SEGMENT_FOCUS_RING_INSET_MIN_WIDTH_PX).toBe(12);
    expect(resolveSegmentFocusRing(12, true).placement).toBe("inset");
    for (const isCurrent of [false, true]) {
      expect(resolveSegmentFocusRing(11.9, isCurrent)).toStrictEqual({
        placement: "outset",
        tone: "foreground",
      });
    }
    expect(resolveSegmentFocusRing(Number.NaN, true).placement).toBe("outset");
  });
});
