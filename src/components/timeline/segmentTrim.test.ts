import { describe, expect, it } from "vitest";
import type { PresentedFrame } from "@/features/playback";
import type { Pts, Rational, Segment, TickCount } from "@/types/project";
import type { SnapBoundary } from "./scrubSnap";
import {
  beginTrimAwait,
  calculateTrimLastFrameIndex,
  calculateTrimLimitPts,
  calculateTrimPreviewLayout,
  canCommitTrim,
  clampTrimPts,
  collectTrimSnapBoundaries,
  createTrimSnapBoundaryCache,
  isTrimCurrent,
  isWithinTrimLimit,
  planSegmentTrimStart,
  planTrimCancel,
  planTrimRelease,
  resolveTrimAwait,
  resolveTrimGridRate,
  resolveTrimStartPlayhead,
  resolveTrimTarget,
  trimFrameIndexOf,
  trimNearestFrameIndexOf,
  type SegmentTrim,
  type SegmentTrimPlayback,
  type SegmentTrimProbe,
  type SegmentTrimStartInput,
  type TrimAwait,
  type TrimReleasePlan,
  type TrimSnapSet,
  type TrimTarget,
} from "./segmentTrim";

const pts = (value: string) => value as Pts;

const SOURCE_ID = "source-1";
const REVISION = "/clip.mp4:100:200";

const tb90k: Rational = { n: 1, d: 90_000 };
const fps25: Rational = { n: 25, d: 1 };
/** One nominal frame at 25 fps on a 1/90000 time base. */
const FRAME = 3600;
/** The extent of the ruler: 10 s, 250 frames. Frame 249 is the last one. */
const TOTAL = 10;
const LAST_FRAME_PTS = String(249 * FRAME);

/** A constant 25 fps on a 1/90000 time base: the frame grid is exact. */
const gridProbe: SegmentTrimProbe = {
  videoStartPts: pts("0"),
  videoTimeBase: tb90k,
  avgFrameRate: fps25,
  rFrameRate: fps25,
};

/** The average and the real rate differ: a variable rate. */
const vfrProbe: SegmentTrimProbe = { ...gridProbe, rFrameRate: { n: 50, d: 1 } };

/** 23.976 fps on a 1/24 time base: one tick is almost a whole frame, a coarse time base. */
const coarseProbe: SegmentTrimProbe = {
  videoStartPts: pts("0"),
  videoTimeBase: { n: 1, d: 24 },
  avgFrameRate: { n: 24000, d: 1001 },
  rFrameRate: { n: 24000, d: 1001 },
};

function segment(
  id: string,
  inPts: string,
  outPts: string,
  sourceId = SOURCE_ID,
): Segment {
  return { id, sourceId, inPts: pts(inPts), outPts: pts(outPts) };
}

/** Segment a is frames 25 to 49 (1 s to 2 s). Segment b meets it at 2 s, as after a split. */
const segments: readonly Segment[] = [
  segment("a", "90000", "180000"),
  segment("b", "180000", "270000"),
  segment("c", "360000", "450000"),
  segment("foreign", "0", "900000", "source-2"),
];

function frame(mediaTime: number, inferred: string): PresentedFrame {
  return { mediaTime, inferredSourcePts: pts(inferred) };
}

/** A ready, paused source with frame 75 (3 s, PTS 270000) on screen and no seek pending. */
function playback(overrides: Partial<SegmentTrimPlayback> = {}): SegmentTrimPlayback {
  return {
    calibrationStatus: "ready",
    presentedFrame: frame(3, "270000"),
    seekTargetSeconds: null,
    approximateBrowserTimeSeconds: 3,
    attachedSourceRevisionKey: REVISION,
    isReady: true,
    isPlaying: false,
    ...overrides,
  };
}

function startInput(
  overrides: Partial<SegmentTrimStartInput> = {},
): SegmentTrimStartInput {
  return {
    segmentId: "a",
    edge: "out",
    segments,
    sourceId: SOURCE_ID,
    hasActiveSource: true,
    playback: playback(),
    probe: gridProbe,
    totalDurationSeconds: TOTAL,
    ...overrides,
  };
}

function startTrim(overrides: Partial<SegmentTrimStartInput> = {}): SegmentTrim {
  const trim = planSegmentTrimStart(startInput(overrides));
  if (trim === null) {
    throw new Error("the trim did not start");
  }
  return trim;
}

function snapAt(value: string): SnapBoundary {
  const seconds = Number(value) / 90_000;
  return { pts: pts(value), elapsedSeconds: seconds, ratio: seconds / TOTAL };
}

/** A target from the pointer position. */
function pointer(value: string): TrimTarget {
  return { pts: pts(value), snap: null, writesAtOnce: false };
}

/** A snap whose release writes its PTS at once. */
function exactSnap(value: string): TrimTarget {
  return { pts: pts(value), snap: snapAt(value), writesAtOnce: true };
}

function waitPlan(plan: TrimReleasePlan): Extract<TrimReleasePlan, { kind: "wait" }> {
  if (plan.kind !== "wait") {
    throw new Error(`expected a wait, got ${plan.kind}`);
  }
  return plan;
}

function snapsOf(trim: SegmentTrim): TrimSnapSet {
  return collectTrimSnapBoundaries({ trim, segments, totalDurationSeconds: TOTAL });
}

describe("calculateTrimLimitPts", () => {
  const a = segment("a", "90000", "180000");

  it("stops the In edge one nominal frame before the Out, and the Out one after the In", () => {
    expect(calculateTrimLimitPts("in", a, fps25, tb90k)).toBe(String(180000 - FRAME));
    expect(calculateTrimLimitPts("out", a, fps25, tb90k)).toBe(String(90000 + FRAME));
  });

  it("rounds the frame down for the In edge and up for the Out edge", () => {
    // 30000/1001 fps on a 1/1000 time base: one frame is 33.37 ticks.
    const ms = segment("m", "968", "1001");
    const rate = { n: 30000, d: 1001 };
    const tb = { n: 1, d: 1000 };
    expect(calculateTrimLimitPts("in", ms, rate, tb)).toBe("968");
    expect(calculateTrimLimitPts("out", ms, rate, tb)).toBe("1002");
  });

  it("lets the In edge reach a segment of one frame at 29.97 fps on a 1/1000 time base", () => {
    // Frame 30 starts at 1001 ms and frame 29 at 968 ms, as a container rounds them to the
    // millisecond. A limit rounded up (1001 - 34 = 967) would keep the In off frame 29.
    const trim = startTrim({
      segments: [segment("a", "0", "1001")],
      edge: "in",
      probe: {
        videoStartPts: pts("0"),
        videoTimeBase: { n: 1, d: 1000 },
        avgFrameRate: { n: 30000, d: 1001 },
        rFrameRate: { n: 30000, d: 1001 },
      },
      playback: playback({ presentedFrame: frame(0, "0") }),
    });
    expect(isWithinTrimLimit(trim, pts("968"))).toBe(true);
    expect(isWithinTrimLimit(trim, pts("969"))).toBe(false);
  });

  it("uses one tick without a nominal frame rate", () => {
    expect(calculateTrimLimitPts("in", a, null, tb90k)).toBe("179999");
    expect(calculateTrimLimitPts("out", a, null, tb90k)).toBe("90001");
  });

  it("gives no limit for an invalid pair, an invalid time base, or a limit outside i64", () => {
    expect(
      calculateTrimLimitPts("in", segment("x", "5", "5"), fps25, tb90k),
    ).toBeNull();
    expect(calculateTrimLimitPts("in", a, fps25, { n: 0, d: 1 })).toBeNull();
    const nearMin = segment("x", "-9223372036854775808", "-9223372036854775000");
    expect(calculateTrimLimitPts("in", nearMin, fps25, tb90k)).toBeNull();
  });
});

describe("resolveTrimGridRate", () => {
  it("gives the nominal rate of an exact frame grid", () => {
    expect(resolveTrimGridRate(gridProbe)).toEqual(fps25);
  });

  it("gives no rate for a variable rate, a coarse time base, or no probe", () => {
    expect(resolveTrimGridRate(vfrProbe)).toBeNull();
    expect(resolveTrimGridRate(coarseProbe)).toBeNull();
    expect(
      resolveTrimGridRate({ ...gridProbe, avgFrameRate: null, rFrameRate: null }),
    ).toBeNull();
    expect(resolveTrimGridRate(null)).toBeNull();
  });
});

/** The rates and time bases where the frame boundary margin is one tick (ADR 028). */
const oneTickMargin: readonly {
  readonly label: string;
  readonly probe: SegmentTrimProbe;
  readonly lastFrame: bigint;
  /** The nominal start of the last frame, rounded up to a tick. */
  readonly lastFramePts: string;
  /** A segment that ends a few frames into the source. */
  readonly segment: Segment;
  /** A segment whose In is the last frame. */
  readonly lastSegment: Segment;
}[] = [
  {
    label: "29.97 fps on 1/1000, 10010 ticks",
    probe: {
      videoStartPts: pts("0"),
      videoTimeBase: { n: 1, d: 1000 },
      videoDurationTicks: "10010" as TickCount,
      avgFrameRate: { n: 30000, d: 1001 },
      rFrameRate: { n: 30000, d: 1001 },
    },
    lastFrame: 299n,
    lastFramePts: "9977",
    segment: segment("a", "0", "1001"),
    lastSegment: segment("a", "9977", "10010"),
  },
  {
    label: "30 fps on 1/1000, 10000 ticks",
    probe: {
      videoStartPts: pts("0"),
      videoTimeBase: { n: 1, d: 1000 },
      videoDurationTicks: "10000" as TickCount,
      avgFrameRate: { n: 30, d: 1 },
      rFrameRate: { n: 30, d: 1 },
    },
    lastFrame: 299n,
    lastFramePts: "9967",
    segment: segment("a", "0", "1000"),
    lastSegment: segment("a", "9967", "10000"),
  },
  {
    label: "23.976 fps on 1/600, 25025 ticks",
    probe: {
      videoStartPts: pts("0"),
      videoTimeBase: { n: 1, d: 600 },
      videoDurationTicks: "25025" as TickCount,
      avgFrameRate: { n: 24000, d: 1001 },
      rFrameRate: { n: 24000, d: 1001 },
    },
    lastFrame: 999n,
    lastFramePts: "25000",
    segment: segment("a", "0", "751"),
    lastSegment: segment("a", "25000", "25025"),
  },
];

describe("calculateTrimLastFrameIndex", () => {
  it.each(oneTickMargin)(
    "names the last frame with a margin of one tick: $label",
    (grid) => {
      const rate = resolveTrimGridRate(grid.probe);
      expect(rate).not.toBeNull();
      if (rate !== null) {
        expect(calculateTrimLastFrameIndex(grid.probe, rate, null)).toBe(
          grid.lastFrame,
        );
      }
    },
  );

  it("names the frame count of the extent minus one", () => {
    expect(calculateTrimLastFrameIndex(gridProbe, fps25, TOTAL)).toBe(249n);
    // The reported duration in ticks wins over the extent of the ruler.
    const reported = { ...gridProbe, videoDurationTicks: "450000" as TickCount };
    expect(calculateTrimLastFrameIndex(reported, fps25, TOTAL)).toBe(124n);
  });

  it("is unknown without an extent", () => {
    expect(calculateTrimLastFrameIndex(gridProbe, fps25, null)).toBeNull();
    expect(calculateTrimLastFrameIndex(gridProbe, fps25, 0)).toBeNull();
  });
});

describe("planSegmentTrimStart", () => {
  it("records the boundaries, the range, the grid and the playhead of the start", () => {
    expect(startTrim({ edge: "out" })).toEqual({
      segmentId: "a",
      edge: "out",
      sourceId: SOURCE_ID,
      sourceRevisionKey: REVISION,
      videoStartPts: "0",
      videoTimeBase: tb90k,
      gridRate: fps25,
      originalPts: "180000",
      fixedPts: "90000",
      limitPts: "93600",
      lastFrameIndex: 249n,
      maxPts: LAST_FRAME_PTS,
      startPlayheadPts: "270000",
      startPlayheadIsFrame: true,
    });
    expect(startTrim({ edge: "in" })).toMatchObject({
      originalPts: "90000",
      fixedPts: "180000",
      limitPts: "176400",
      maxPts: null,
    });
  });

  it("never starts a trim off the exact frame grid, so the edge press stays the click", () => {
    expect(planSegmentTrimStart(startInput({ probe: vfrProbe }))).toBeNull();
    expect(
      planSegmentTrimStart(
        startInput({
          probe: coarseProbe,
          segments: [segment("a", "24", "48")],
          playback: playback({ presentedFrame: frame(0, "0") }),
        }),
      ),
    ).toBeNull();
  });

  it("needs the condition of Mark In and Mark Out: an active source and a ready calibration", () => {
    expect(planSegmentTrimStart(startInput({ hasActiveSource: false }))).toBeNull();
    for (const calibrationStatus of ["calibrating", "unavailable"] as const) {
      expect(
        planSegmentTrimStart(startInput({ playback: playback({ calibrationStatus }) })),
      ).toBeNull();
    }
  });

  it("needs a segment of the active source and a source with a start PTS", () => {
    expect(planSegmentTrimStart(startInput({ segmentId: "ghost" }))).toBeNull();
    expect(planSegmentTrimStart(startInput({ segmentId: "foreign" }))).toBeNull();
    expect(planSegmentTrimStart(startInput({ sourceId: null }))).toBeNull();
    expect(planSegmentTrimStart(startInput({ probe: null }))).toBeNull();
    expect(
      planSegmentTrimStart(
        startInput({ probe: { ...gridProbe, videoStartPts: null } }),
      ),
    ).toBeNull();
    expect(
      planSegmentTrimStart(
        startInput({ playback: playback({ attachedSourceRevisionKey: null }) }),
      ),
    ).toBeNull();
    expect(
      planSegmentTrimStart(startInput({ segments: [segment("a", "180000", "90000")] })),
    ).toBeNull();
  });

  it("gives an Out edge on the last frame no room, so the press stays the click", () => {
    // The In is on frame 249, the last frame of the extent, and the stored Out lies less than
    // half a frame after it, so the Out does not raise the last frame.
    const last = [segment("a", LAST_FRAME_PTS, "897000")];
    expect(planSegmentTrimStart(startInput({ segments: last }))).toBeNull();
    // The In edge of that segment can still move.
    expect(
      planSegmentTrimStart(startInput({ segments: last, edge: "in" })),
    ).not.toBeNull();
  });

  it("raises the last frame of an Out edge to a stored Out after the end of the extent", () => {
    // A stored Out is a frame that the browser showed. An Out on frame 250 says that the extent
    // of 10 s ends before the end of the last frame, so the Out edge can stay on its frame.
    const trim = startTrim({ segments: [segment("a", LAST_FRAME_PTS, "900000")] });
    expect(trim.lastFrameIndex).toBe(250n);
    expect(trim.maxPts).toBe("900000");
    expect(trim.limitPts).toBe("900000");
  });

  it("takes the drawn position as the start while a grid step is pending", () => {
    // A frame step shows the nominal start of its target while it runs, and not the frame on
    // screen, so the snap target and the Escape return stay where the playhead was drawn.
    const trim = startTrim({
      playback: playback({
        presentedFrame: frame(3, "270000"),
        seekTargetSeconds: 3.04,
      }),
    });
    expect(trim.startPlayheadPts).toBe("273600");
    expect(trim.startPlayheadIsFrame).toBe(false);
  });
});

describe("resolveTrimStartPlayhead", () => {
  it("takes the frame on screen only when no seek is pending", () => {
    expect(resolveTrimStartPlayhead(playback(), pts("0"), tb90k)).toEqual({
      pts: "270000",
      isFrame: true,
    });
    expect(
      resolveTrimStartPlayhead(playback({ seekTargetSeconds: 0.5 }), pts("0"), tb90k),
    ).toEqual({ pts: "45000", isFrame: false });
  });

  it("takes the approximate clock with no frame and no target", () => {
    expect(
      resolveTrimStartPlayhead(
        playback({ presentedFrame: null, approximateBrowserTimeSeconds: 2 }),
        pts("0"),
        tb90k,
      ),
    ).toEqual({ pts: "180000", isFrame: false });
  });
});

describe("the frame grid of a trim", () => {
  const trim = startTrim();

  it("names the nominal frame of a target by the ADR 028 rule", () => {
    // A whole number of ticks for each frame: the frame starts lie on the tick grid.
    expect(trimFrameIndexOf(trim, pts("180000"))).toBe(50n);
    expect(trimFrameIndexOf(trim, pts("183599"))).toBe(50n);
    expect(trimFrameIndexOf(trim, pts("183600"))).toBe(51n);
    expect(trimFrameIndexOf(trim, pts("179999"))).toBe(49n);
    expect(trimFrameIndexOf(trim, pts("-1"))).toBeNull();
  });

  it("counts a real frame start one tick before its nominal start as its own frame", () => {
    // 29.97 fps on a 1/1000 time base: frame 30 starts at 1001 ms, and a container can round
    // a start down by up to one tick.
    const ntscMs: Rational = { n: 30000, d: 1001 };
    const ms = startTrim({
      segments: [segment("a", "0", "2002")],
      probe: {
        videoStartPts: pts("0"),
        videoTimeBase: { n: 1, d: 1000 },
        avgFrameRate: ntscMs,
        rFrameRate: ntscMs,
      },
      playback: playback({ presentedFrame: frame(0, "0") }),
    });
    expect(trimFrameIndexOf(ms, pts("1000"))).toBe(30n);
    expect(trimFrameIndexOf(ms, pts("999"))).toBe(29n);
  });

  it("rounds a presented frame to the nearest nominal frame", () => {
    expect(trimNearestFrameIndexOf(trim, pts("180000"))).toBe(50n);
    expect(trimNearestFrameIndexOf(trim, pts("180001"))).toBe(50n);
    expect(trimNearestFrameIndexOf(trim, pts("179999"))).toBe(50n);
    expect(trimNearestFrameIndexOf(trim, pts("181800"))).toBe(51n);
    expect(trimNearestFrameIndexOf(trim, pts("181799"))).toBe(50n);
    expect(trimNearestFrameIndexOf(trim, pts("-1"))).toBeNull();
  });

  it("counts frames from the start PTS of the source", () => {
    const shifted = startTrim({
      segments: [segment("a", "91000", "181000")],
      probe: { ...gridProbe, videoStartPts: pts("1000") },
    });
    expect(trimFrameIndexOf(shifted, pts("181000"))).toBe(50n);
    expect(trimNearestFrameIndexOf(shifted, pts("181000"))).toBe(50n);
    expect(shifted.maxPts).toBe(String(1000 + 249 * FRAME));
  });
});

describe("the range of a trim", () => {
  it("keeps the Out edge between its limit and the last frame, and the In at or before its limit", () => {
    const out = startTrim({ edge: "out" });
    expect(isWithinTrimLimit(out, pts("93600"))).toBe(true);
    expect(isWithinTrimLimit(out, pts("93599"))).toBe(false);
    expect(isWithinTrimLimit(out, pts(LAST_FRAME_PTS))).toBe(true);
    expect(isWithinTrimLimit(out, pts("896401"))).toBe(false);
    expect(clampTrimPts(out, pts("10"))).toBe("93600");
    expect(clampTrimPts(out, pts("500000"))).toBe("500000");
    // The end of the lane, and a pointer past it, stop on the last frame.
    expect(clampTrimPts(out, pts("900000"))).toBe(LAST_FRAME_PTS);
    expect(clampTrimPts(out, pts("990000"))).toBe(LAST_FRAME_PTS);

    const inEdge = startTrim({ edge: "in" });
    expect(isWithinTrimLimit(inEdge, pts("176400"))).toBe(true);
    expect(isWithinTrimLimit(inEdge, pts("176401"))).toBe(false);
    expect(clampTrimPts(inEdge, pts("900000"))).toBe("176400");
  });

  it("has no cap on the Out edge without an extent", () => {
    const out = startTrim({ totalDurationSeconds: null });
    expect(out.maxPts).toBeNull();
    expect(isWithinTrimLimit(out, pts("990000"))).toBe(true);
  });
});

describe("isTrimCurrent", () => {
  it("holds while the calibration, the element and the source of the start hold", () => {
    const trim = startTrim();
    expect(isTrimCurrent(trim, playback())).toBe(true);
    expect(isTrimCurrent(trim, playback({ calibrationStatus: "unavailable" }))).toBe(
      false,
    );
    expect(isTrimCurrent(trim, playback({ isReady: false }))).toBe(false);
    expect(isTrimCurrent(trim, playback({ attachedSourceRevisionKey: "other" }))).toBe(
      false,
    );
  });
});

describe("collectTrimSnapBoundaries", () => {
  const collect = (trim: SegmentTrim) =>
    snapsOf(trim).boundaries.map(({ pts: v }) => v);

  it("snaps an Out edge to the other boundaries and the start frame", () => {
    const trim = startTrim({
      edge: "out",
      playback: playback({ presentedFrame: frame(2.5, "225000") }),
    });
    // The In of a lies beyond the limit. The Out that the trim moves is no target, but the In
    // of b shares that PTS and stays.
    expect(collect(trim)).toEqual(["180000", "225000", "270000", "360000", "450000"]);
    // Each of them writes its PTS at once: the start is the frame on screen.
    expect([...snapsOf(trim).exactPts].sort()).toEqual(
      ["180000", "225000", "270000", "360000", "450000", "90000"].sort(),
    );
  });

  it("snaps an In edge only on its side of the limit, and never to its own boundary", () => {
    expect(collect(startTrim({ edge: "in" }))).toEqual([]);
    // The In of b is no target, but the Out of a shares that PTS and stays.
    expect(collect(startTrim({ segmentId: "b", edge: "in" }))).toEqual([
      "90000",
      "180000",
    ]);
  });

  it("keeps a drawn start as a target, but not as a value to write at once", () => {
    const trim = startTrim({
      playback: playback({
        presentedFrame: frame(2, "180000"),
        seekTargetSeconds: 2.5,
      }),
    });
    expect(collect(trim)).toContain("225000");
    expect(snapsOf(trim).exactPts.has("225000")).toBe(false);
  });

  it("leaves out a boundary after the last frame of the source", () => {
    // Segment z ends at the end of the source, after the last frame (frame 249).
    const ends = [segment("a", "90000", "180000"), segment("z", "450000", "900000")];
    const trim = startTrim({ segments: ends });
    expect(
      collectTrimSnapBoundaries({
        trim,
        segments: ends,
        totalDurationSeconds: TOTAL,
      }).boundaries.map(({ pts: value }) => value),
    ).toEqual(["270000", "450000"]);
  });

  it("gives nothing without a usable extent", () => {
    expect(
      collectTrimSnapBoundaries({
        trim: startTrim(),
        segments,
        totalDurationSeconds: null,
      }).boundaries,
    ).toEqual([]);
  });

  it("builds the list again only when an input changes identity", () => {
    const read = createTrimSnapBoundaryCache();
    const source = { trim: startTrim(), segments, totalDurationSeconds: TOTAL };
    const first = read(source);
    expect(read({ ...source })).toBe(first);
    expect(read({ ...source, trim: startTrim() })).not.toBe(first);
  });
});

describe("resolveTrimTarget", () => {
  const trim = startTrim({ edge: "out" });
  const snaps = snapsOf(trim);

  it("keeps a snap in the range, and marks a stored one to write at once", () => {
    const snap = snapAt("360000");
    expect(
      resolveTrimTarget(trim, { kind: "pts", pts: snap.pts }, snap, snaps),
    ).toEqual({
      pts: "360000",
      snap,
      writesAtOnce: true,
    });
  });

  it("clamps a pointer target to the range, and a clamped target has no snap", () => {
    expect(
      resolveTrimTarget(trim, { kind: "pts", pts: pts("12345") }, null, snaps),
    ).toEqual(pointer("93600"));
    expect(
      resolveTrimTarget(trim, { kind: "pts", pts: pts("900000") }, null, snaps),
    ).toEqual(pointer(LAST_FRAME_PTS));
    const beyond = snapAt("90000");
    expect(
      resolveTrimTarget(trim, { kind: "pts", pts: beyond.pts }, beyond, snaps),
    ).toEqual(pointer("93600"));
  });

  it("gives no target without a PTS request", () => {
    expect(resolveTrimTarget(trim, null, null, snaps)).toBeNull();
    expect(
      resolveTrimTarget(trim, { kind: "seconds", seconds: 2 }, null, snaps),
    ).toBeNull();
  });
});

describe("planTrimRelease", () => {
  const trim = startTrim({ edge: "out" });
  /** The scrub seek of the drag is pending, and its frame 75 (3 s) is on screen. */
  const scrubbed = playback({ seekTargetSeconds: 3.01 });

  it("writes the frame on screen at once when it rounds to the frame of the target", () => {
    // Target 273000 lies in frame 75, the frame on screen. The scrub target never clears, so
    // this is the release after a pause on a frame.
    expect(planTrimRelease(trim, pointer("273000"), scrubbed)).toEqual({
      kind: "write",
      pts: "270000",
      seek: { kind: "frame", frameIndex: 75n },
    });
    // With no seek pending, it sends no seek.
    expect(planTrimRelease(trim, pointer("273000"), playback())).toEqual({
      kind: "write",
      pts: "270000",
      seek: null,
    });
  });

  it("seeks to the target frame and waits for it when the frame on screen is another one", () => {
    expect(planTrimRelease(trim, pointer("275000"), scrubbed)).toEqual({
      kind: "wait",
      frameIndex: 76n,
    });
    expect(
      planTrimRelease(trim, pointer("275000"), playback({ presentedFrame: null })),
    ).toEqual({ kind: "wait", frameIndex: 76n });
  });

  it("keeps the frame inside the range", () => {
    // The limit of the In is frame 49, the frame before the Out at frame 50.
    const inEdge = startTrim({ edge: "in" });
    expect(
      waitPlan(planTrimRelease(inEdge, pointer("176400"), scrubbed)).frameIndex,
    ).toBe(49n);
    // Frame 26 is the first frame after the In at frame 25.
    expect(waitPlan(planTrimRelease(trim, pointer("93600"), scrubbed)).frameIndex).toBe(
      26n,
    );
  });

  it.each(oneTickMargin)(
    "stops an Out edge at the end of the source on the last frame: $label",
    (grid) => {
      const trim = startTrim({
        probe: grid.probe,
        segments: [grid.segment],
        playback: playback({ presentedFrame: frame(0, "0") }),
        totalDurationSeconds: null,
      });
      expect(trim.lastFrameIndex).toBe(grid.lastFrame);
      expect(trim.maxPts).toBe(grid.lastFramePts);
      const extent = String(grid.probe.videoDurationTicks);
      for (const end of [extent, String(Number(extent) + 500)]) {
        expect(clampTrimPts(trim, pts(end))).toBe(grid.lastFramePts);
        expect(
          waitPlan(planTrimRelease(trim, pointer(end), playback())).frameIndex,
        ).toBe(grid.lastFrame);
      }
      // The Out edge of a segment whose In is the last frame has no room. Its stored Out at the
      // end of the extent raises the last frame by one, but the limit, the In plus the
      // rounded-up interval, lies one tick after the nominal start of that frame.
      expect(
        planSegmentTrimStart(
          startInput({
            probe: grid.probe,
            segments: [grid.lastSegment],
            playback: playback({ presentedFrame: frame(0, "0") }),
            totalDurationSeconds: null,
          }),
        ),
      ).toBeNull();
    },
  );

  it("stops an Out edge at the end of the source on the last frame", () => {
    // The end of the lane maps to the end of the extent, where no frame starts: frame 250
    // does not exist, and a seek to it would show frame 249.
    for (const end of ["900000", "990000"]) {
      expect(waitPlan(planTrimRelease(trim, pointer(end), scrubbed)).frameIndex).toBe(
        249n,
      );
    }
  });

  it("writes a snap at once and seeks to its frame with seekToFrameIndex", () => {
    expect(planTrimRelease(trim, exactSnap("360000"), scrubbed)).toEqual({
      kind: "write",
      pts: "360000",
      seek: { kind: "frame", frameIndex: 100n },
    });
  });

  it("writes the start frame at once, with no seek while it is still on screen", () => {
    expect(planTrimRelease(trim, exactSnap("270000"), playback())).toEqual({
      kind: "write",
      pts: "270000",
      seek: null,
    });
  });

  it("commits a snap to a drawn start through its frame, and never writes it at once", () => {
    const drawn: TrimTarget = {
      pts: pts("225000"),
      snap: snapAt("225000"),
      writesAtOnce: false,
    };
    expect(planTrimRelease(trim, drawn, scrubbed)).toEqual({
      kind: "wait",
      frameIndex: 62n,
    });
  });

  it("drops a release with no target, a lost calibration, or a new source", () => {
    expect(planTrimRelease(trim, null, playback())).toEqual({ kind: "drop" });
    expect(
      planTrimRelease(
        trim,
        pointer("230000"),
        playback({ calibrationStatus: "unavailable" }),
      ),
    ).toEqual({ kind: "drop" });
    expect(
      planTrimRelease(
        trim,
        pointer("230000"),
        playback({ attachedSourceRevisionKey: "other" }),
      ),
    ).toEqual({ kind: "drop" });
  });
});

describe("an extent that ends before the last frame", () => {
  // A WebM file at 25 fps on a 1/1000 time base, with no videoDurationTicks. Its Matroska
  // Duration is the start of the last block, and not its end: 9.96 s for frames 0 to 249. The
  // extent of the ruler then holds 249 frames, and its last frame is frame 248 at 9920.
  const webmProbe: SegmentTrimProbe = {
    videoStartPts: pts("0"),
    videoTimeBase: { n: 1, d: 1000 },
    avgFrameRate: fps25,
    rFrameRate: fps25,
  };
  const DURATION = 9.96;
  /** Segment a ends with a stored Out on frame 249, the last frame of the source. */
  const onLastFrame = segment("a", "4000", "9960");
  const scrubbed = playback({ seekTargetSeconds: 9.5 });

  function startWebmTrim(
    overrides: Partial<SegmentTrimStartInput> = {},
    totalDurationSeconds = DURATION,
  ): SegmentTrim {
    return startTrim({
      probe: webmProbe,
      segments: [onLastFrame],
      playback: playback({ presentedFrame: frame(9.96, "9960") }),
      totalDurationSeconds,
      ...overrides,
    });
  }

  it("raises the last frame of an Out edge to the frame of the stored Out", () => {
    expect(calculateTrimLastFrameIndex(webmProbe, fps25, DURATION)).toBe(248n);
    const trim = startWebmTrim();
    expect(trim.lastFrameIndex).toBe(249n);
    expect(trim.maxPts).toBe("9960");
  });

  it("does not move the stored Out back on the first move of the drag", () => {
    const trim = startWebmTrim();
    const snaps = collectTrimSnapBoundaries({
      trim,
      segments: [onLastFrame],
      totalDurationSeconds: DURATION,
    });
    // The end of the lane is the stored Out. A pointer past the end stops there too.
    for (const at of ["9960", "9990"]) {
      expect(
        resolveTrimTarget(trim, { kind: "pts", pts: pts(at) }, null, snaps),
      ).toEqual(pointer("9960"));
    }
    expect(clampTrimPts(trim, pts("9950"))).toBe("9950");
  });

  it("releases an Out edge at the end of the lane on the frame of the stored Out", () => {
    const trim = startWebmTrim();
    expect(waitPlan(planTrimRelease(trim, pointer("9960"), scrubbed)).frameIndex).toBe(
      249n,
    );
  });

  it("keeps the cap of the extent for a stored Out before the last frame", () => {
    const trim = startWebmTrim({ segments: [segment("a", "4000", "8000")] });
    expect(trim.lastFrameIndex).toBe(248n);
    expect(trim.maxPts).toBe("9920");
    expect(clampTrimPts(trim, pts("9960"))).toBe("9920");
  });

  it("does not stop an In edge at the last frame of the extent", () => {
    // A Duration of 9.92 s: the extent holds 248 frames, and its last frame is frame 247. The
    // In of segment a can still move to frame 248, the frame before the Out on frame 249.
    const trim = startWebmTrim({ edge: "in" }, 9.92);
    expect(trim.lastFrameIndex).toBe(247n);
    expect(waitPlan(planTrimRelease(trim, pointer("9920"), scrubbed)).frameIndex).toBe(
      248n,
    );
  });
});

describe("beginTrimAwait", () => {
  const trim = startTrim();
  const plan = waitPlan(
    planTrimRelease(trim, pointer("275000"), playback({ seekTargetSeconds: 3 })),
  );
  // seekToFrameIndex shows the nominal start of frame 76 as the display target.
  const after = playback({ presentedFrame: null, seekTargetSeconds: 3.04 });

  it("waits for frame J, with the display target of the seek", () => {
    expect(beginTrimAwait(trim, plan, after)).toEqual({
      trim,
      frameIndex: 76n,
      awaitedTargetSeconds: 3.04,
    });
  });

  it("does not wait on a source that can no longer commit, or during playback", () => {
    expect(
      beginTrimAwait(trim, plan, { ...after, calibrationStatus: "unavailable" }),
    ).toBeNull();
    expect(beginTrimAwait(trim, plan, { ...after, isPlaying: true })).toBeNull();
  });
});

describe("resolveTrimAwait", () => {
  const trim = startTrim();
  const awaiting: TrimAwait = { trim, frameIndex: 76n, awaitedTargetSeconds: 3.04 };
  const pending = playback({ presentedFrame: null, seekTargetSeconds: 3.04 });

  it("writes a frame on screen that rounds to J, also while the target is set", () => {
    expect(
      resolveTrimAwait(awaiting, { ...pending, presentedFrame: frame(3.04, "273600") }),
    ).toEqual({ kind: "write", pts: "273600" });
    // A real start one tick after the nominal start still rounds to frame 76.
    expect(
      resolveTrimAwait(awaiting, {
        ...pending,
        presentedFrame: frame(3.04, "273601"),
        seekTargetSeconds: null,
      }),
    ).toEqual({ kind: "write", pts: "273601" });
  });

  it("writes a frame of J whichever callback put it on screen", () => {
    // A late callback of the drag that arrives out of order, or the frame on screen at the
    // first check after the seek: a frame of index J is frame J on the exact grid.
    const early = frame(3.04, "273600");
    expect(resolveTrimAwait(awaiting, { ...pending, presentedFrame: early })).toEqual({
      kind: "write",
      pts: "273600",
    });
  });

  it("never writes a late frame of another frame, even when it clears the target", () => {
    // A callback for the frame of the scrub, composited before the seek completed, arrives
    // after it and clears the display target. It is not the frame that the user chose.
    expect(
      resolveTrimAwait(awaiting, {
        ...pending,
        presentedFrame: frame(3, "270000"),
        seekTargetSeconds: null,
      }),
    ).toEqual({ kind: "wait" });
  });

  it("drops a wait that a later request replaced", () => {
    expect(resolveTrimAwait(awaiting, { ...pending, seekTargetSeconds: 5 })).toEqual({
      kind: "drop",
    });
  });

  it("keeps the wait when the target clears with no frame of J", () => {
    expect(resolveTrimAwait(awaiting, { ...pending, seekTargetSeconds: null })).toEqual(
      {
        kind: "wait",
      },
    );
    expect(resolveTrimAwait(awaiting, pending)).toEqual({ kind: "wait" });
  });

  it("drops a wait on a calibration loss, a new source, a lost element or playback", () => {
    for (const change of [
      { calibrationStatus: "unavailable" as const },
      { attachedSourceRevisionKey: "other" },
      { isReady: false },
      { isPlaying: true },
    ]) {
      expect(
        resolveTrimAwait(awaiting, {
          ...pending,
          presentedFrame: frame(3.04, "273600"),
          ...change,
        }),
      ).toEqual({ kind: "drop" });
    }
  });
});

describe("canCommitTrim", () => {
  const trim = startTrim({ edge: "out" });

  it("allows a write while the segment holds the boundaries of the start", () => {
    expect(canCommitTrim(trim, segments, SOURCE_ID, pts("273600"))).toBe(true);
  });

  it("refuses a segment that changed, went away or left the source", () => {
    expect(
      canCommitTrim(trim, [segment("a", "90000", "200000")], SOURCE_ID, pts("273600")),
    ).toBe(false);
    expect(
      canCommitTrim(trim, [segment("a", "95000", "180000")], SOURCE_ID, pts("273600")),
    ).toBe(false);
    expect(canCommitTrim(trim, [], SOURCE_ID, pts("273600"))).toBe(false);
    expect(canCommitTrim(trim, segments, "source-2", pts("273600"))).toBe(false);
  });

  it("refuses a write that breaks inPts < outPts", () => {
    expect(canCommitTrim(trim, segments, SOURCE_ID, pts("90000"))).toBe(false);
    expect(
      canCommitTrim(startTrim({ edge: "in" }), segments, SOURCE_ID, pts("180000")),
    ).toBe(false);
  });
});

describe("planTrimCancel", () => {
  it("returns to the frame of the start through its nominal frame", () => {
    const trim = startTrim();
    expect(
      planTrimCancel(trim, playback({ presentedFrame: null, seekTargetSeconds: 2.5 })),
    ).toEqual({ kind: "frame", frameIndex: 75n });
  });

  it("returns to the frame of the drawn position when a seek was pending at the start", () => {
    // A grid step to frame 76 was pending, and the playhead was drawn at its nominal start.
    const trim = startTrim({
      playback: playback({
        presentedFrame: frame(3, "270000"),
        seekTargetSeconds: 3.04,
      }),
    });
    expect(
      planTrimCancel(trim, playback({ presentedFrame: null, seekTargetSeconds: 2.5 })),
    ).toEqual({ kind: "frame", frameIndex: 76n });
  });

  it("sends no seek when the start frame is still on screen with no seek pending", () => {
    expect(planTrimCancel(startTrim(), playback())).toBeNull();
  });

  it("sends no seek without a start PTS or without the calibration", () => {
    const trim = startTrim();
    expect(planTrimCancel({ ...trim, startPlayheadPts: null }, playback())).toBeNull();
    expect(
      planTrimCancel(trim, playback({ calibrationStatus: "unavailable" })),
    ).toBeNull();
  });
});

describe("calculateTrimPreviewLayout", () => {
  it("spans from the fixed edge to the displayed position", () => {
    expect(
      calculateTrimPreviewLayout("out", pts("90000"), 3, pts("0"), tb90k, TOTAL),
    ).toEqual({
      leftPercent: 10,
      widthPercent: 20,
      left: "10%",
      width: "20%",
    });
    expect(
      calculateTrimPreviewLayout("in", pts("180000"), 0.5, pts("0"), tb90k, TOTAL),
    ).toEqual({ leftPercent: 5, widthPercent: 15, left: "5%", width: "15%" });
  });

  it("ends an Out edge at the end of the source on the start of the last frame", () => {
    // The seek target stops at the last frame, so the display target, and the preview, do too.
    const trim = startTrim();
    const end = clampTrimPts(trim, pts("900000"));
    const layout = calculateTrimPreviewLayout(
      "out",
      trim.fixedPts,
      Number(end) / 90_000,
      pts("0"),
      tb90k,
      TOTAL,
    );
    expect(layout?.leftPercent).toBeCloseTo(10, 9);
    expect(layout?.widthPercent).toBeCloseTo(99.6 - 10, 9);
  });

  it("draws nothing for a box of no width or without a time axis", () => {
    const at = (seconds: number, total: number) =>
      calculateTrimPreviewLayout("out", pts("90000"), seconds, pts("0"), tb90k, total);
    expect(at(0.5, TOTAL)).toBeNull();
    expect(at(1, TOTAL)).toBeNull();
    expect(at(3, 0)).toBeNull();
    expect(at(Number.NaN, TOTAL)).toBeNull();
    expect(
      calculateTrimPreviewLayout("out", pts("90000"), 3, null, tb90k, TOTAL),
    ).toBeNull();
  });
});

describe("the trim state machine", () => {
  it("starts, moves, snaps, clamps, releases, waits and commits a frame of the target", () => {
    const trim = startTrim({ edge: "out" });
    const snaps = snapsOf(trim);
    // Snap: the In of b, a stored boundary.
    const inOfB = snaps.boundaries.find((snap) => snap.pts === "180000") ?? null;
    expect(
      resolveTrimTarget(trim, { kind: "pts", pts: pts("180000") }, inOfB, snaps)
        ?.writesAtOnce,
    ).toBe(true);
    // Clamp: a drag past the other edge stops one frame after the In.
    expect(
      resolveTrimTarget(trim, { kind: "pts", pts: pts("0") }, null, snaps)?.pts,
    ).toBe("93600");

    // Release on frame 59 while the scrub seek of the drag is pending.
    const target = resolveTrimTarget(
      trim,
      { kind: "pts", pts: pts("215000") },
      null,
      snaps,
    );
    const before = playback({
      presentedFrame: frame(2, "180000"),
      seekTargetSeconds: 2.3,
    });
    const plan = waitPlan(planTrimRelease(trim, target, before));
    expect(plan).toEqual({ kind: "wait", frameIndex: 59n });

    const after = { ...before, presentedFrame: null, seekTargetSeconds: 59 / 25 };
    const awaiting = beginTrimAwait(trim, plan, after);
    if (awaiting === null) {
      throw new Error("the wait did not start");
    }
    expect(resolveTrimAwait(awaiting, after)).toEqual({ kind: "wait" });
    // Frame 59 arrives, with its real start one tick after its nominal start.
    expect(
      resolveTrimAwait(awaiting, { ...after, presentedFrame: frame(2.36, "212401") }),
    ).toEqual({ kind: "write", pts: "212401" });
  });
});
