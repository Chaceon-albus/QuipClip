import { describe, expect, it } from "vitest";
import { getDisplayedElapsedSeconds } from "@/features/playback/presentation";
import { TIMELINE_GUTTER_WIDTH_PX } from "@/features/timeline";
import type { Pts, Rational, Segment } from "@/types/project";
import {
  planScrubSeek,
  resolveSnapIndicatorRatio,
  type ScrubSeekPlanInput,
} from "./scrubSeekPlan";
import { collectSnapBoundaries } from "./scrubSnap";

const pts = (value: string) => value as Pts;

// A 10 s source at 1/1000 s per tick, first frame at PTS 0. The container starts at client x
// 0 and is 1096 px wide, so the lane runs from x 96 to x 1096 at zoom 1: 100 px per second.
const timeBase: Rational = { n: 1, d: 1000 };
const segments: Segment[] = [
  { id: "a", sourceId: "src", inPts: pts("2000"), outPts: pts("4000") },
];
const boundaries = collectSnapBoundaries({
  segments,
  sourceId: "src",
  pendingInPts: null,
  videoStartPts: pts("0"),
  videoTimeBase: timeBase,
  totalDurationSeconds: 10,
});
// The In of segment a, at 2 s, is at client x 296.
const IN_X = TIMELINE_GUTTER_WIDTH_PX + 200;

function input(overrides: Partial<ScrubSeekPlanInput> = {}): ScrubSeekPlanInput {
  return {
    pointerX: IN_X - 3,
    phase: "scrub",
    isDragSample: true,
    canSeek: true,
    canSeekExactly: true,
    canSeekApproximately: true,
    lane: { left: TIMELINE_GUTTER_WIDTH_PX, width: 1000 },
    container: { left: 0, right: 1096 },
    totalDurationSeconds: 10,
    videoStartPts: pts("0"),
    videoTimeBase: timeBase,
    boundaries,
    isSnapSuppressed: false,
    previousLaneX: null,
    previousDirection: 0,
    ...overrides,
  };
}

describe("planScrubSeek", () => {
  it("snaps a scrub sample of a drag to the stored PTS of the boundary", () => {
    const plan = planScrubSeek(input());
    expect(plan.request).toEqual({ kind: "pts", pts: "2000" });
    expect(plan.scrub).toBe(true);
    expect(plan.snap?.pts).toBe("2000");
  });

  it("never snaps the seek at pointer down, which is the seek of a click", () => {
    const plan = planScrubSeek(input({ phase: "final", isDragSample: false }));
    expect(plan.snap).toBeNull();
    // The PTS nearest to the pixel, 3 px before the boundary: 30 ms at 100 px per second.
    expect(plan.request).toEqual({ kind: "pts", pts: "1970" });
    expect(plan.scrub).toBe(false);
  });

  it("snaps the release of a drag, as an exact seek", () => {
    const plan = planScrubSeek(input({ phase: "final", isDragSample: true }));
    expect(plan.request).toEqual({ kind: "pts", pts: "2000" });
    expect(plan.scrub).toBe(false);
    expect(plan.snap?.pts).toBe("2000");
  });

  it("never snaps in the approximate mode, and seeks in seconds there", () => {
    const plan = planScrubSeek(input({ canSeekExactly: false }));
    expect(plan.snap).toBeNull();
    expect(plan.request?.kind).toBe("seconds");
    expect(plan.request?.kind === "seconds" ? plan.request.seconds : NaN).toBeCloseTo(
      1.97,
      12,
    );
  });

  it("requests no seek in the approximate mode without an approximate seek", () => {
    const plan = planScrubSeek(
      input({ canSeekExactly: false, canSeekApproximately: false }),
    );
    expect(plan.request).toBeNull();
  });

  it("requests nothing while the timeline cannot seek, and keeps the drag direction", () => {
    const plan = planScrubSeek(
      input({ canSeek: false, previousLaneX: 150, previousDirection: -1 }),
    );
    expect(plan).toEqual({
      request: null,
      scrub: true,
      snap: null,
      laneX: 150,
      direction: -1,
    });
    expect(planScrubSeek(input({ totalDurationSeconds: null })).request).toBeNull();
  });

  it("does not snap while Alt is held", () => {
    const plan = planScrubSeek(input({ isSnapSuppressed: true }));
    expect(plan.snap).toBeNull();
    expect(plan.request).toEqual({ kind: "pts", pts: "1970" });
  });

  it("does not snap to a boundary outside the visible lane", () => {
    // Scrolled so that the In of segment a, 200 px into the lane, lies at x 94: 2 px under
    // the sticky gutter, and 3 px from the pointer.
    const lane = { left: -106, width: 1000 };
    const plan = planScrubSeek(input({ lane, pointerX: TIMELINE_GUTTER_WIDTH_PX + 1 }));
    expect(plan.snap).toBeNull();
  });

  it("clamps a pointer past the right edge to the edge of the view", () => {
    // Zoom 2: the lane is 2000 px wide, and the view shows 0 s to 5 s.
    const lane = { left: TIMELINE_GUTTER_WIDTH_PX, width: 2000 };
    const plan = planScrubSeek(input({ lane, pointerX: 1500, isDragSample: true }));
    expect(plan.request).toEqual({ kind: "pts", pts: "5000" });
    expect(plan.laneX).toBe(1000);
  });

  it("reaches the exact end of a lane of fractional width at the end of the scroll range", () => {
    // The view is 1023.6 px wide, and the snap to the device pixel grid leaves the lane end
    // 0.4 px past it.
    const plan = planScrubSeek(
      input({
        container: { left: 0, right: 1023.6 },
        lane: { left: 1024 - 2000, width: 2000 },
        pointerX: 1500,
        boundaries: [],
      }),
    );
    expect(plan.request).toEqual({ kind: "pts", pts: "10000" });
  });

  it("clamps a pointer over the gutter to the left edge of the view", () => {
    const lane = { left: -904, width: 2000 };
    const plan = planScrubSeek(input({ lane, pointerX: 20, boundaries: [] }));
    // The visible lane starts at x 96, 1000 px into the lane: 5 s.
    expect(plan.request).toEqual({ kind: "pts", pts: "5000" });
  });

  it("measures the drag direction on the lane, and starts it again at pointer down", () => {
    const moving = planScrubSeek(input({ previousLaneX: 150, previousDirection: -1 }));
    expect(moving.laneX).toBe(IN_X - 3 - TIMELINE_GUTTER_WIDTH_PX);
    expect(moving.direction).toBe(1);

    const down = planScrubSeek(
      input({
        phase: "final",
        isDragSample: false,
        previousLaneX: 150,
        previousDirection: 1,
      }),
    );
    expect(down.direction).toBe(0);
  });

  it("gives a tie to the boundary ahead of the drag", () => {
    // Two boundaries 4 px on each side of the pointer: 1.96 s and 2.04 s.
    const tied = collectSnapBoundaries({
      segments: [{ id: "t", sourceId: "src", inPts: pts("1960"), outPts: pts("2040") }],
      sourceId: "src",
      pendingInPts: null,
      videoStartPts: pts("0"),
      videoTimeBase: timeBase,
      totalDurationSeconds: 10,
    });
    const forward = planScrubSeek(
      input({
        boundaries: tied,
        pointerX: IN_X,
        previousLaneX: 150,
        previousDirection: 0,
      }),
    );
    expect(forward.snap?.pts).toBe("2040");
    const backward = planScrubSeek(
      input({
        boundaries: tied,
        pointerX: IN_X,
        previousLaneX: 900,
        previousDirection: 0,
      }),
    );
    expect(backward.snap?.pts).toBe("1960");
  });
});

describe("resolveSnapIndicatorRatio", () => {
  const [inBoundary] = boundaries;
  const state = {
    seekTargetSeconds: null as number | null,
    presentedFrame: null as { mediaTime: number; inferredSourcePts: Pts } | null,
    calibrationStatus: "ready" as const,
    approximateBrowserTimeSeconds: 0,
  };
  const drawn = (overrides: Partial<typeof state>) =>
    getDisplayedElapsedSeconds({ ...state, ...overrides }, pts("0"), timeBase);

  it("shows the indicator while an accepted seek draws the playhead on the boundary", () => {
    expect(resolveSnapIndicatorRatio(inBoundary, drawn({ seekTargetSeconds: 2 }))).toBe(
      0.2,
    );
  });

  it("hides the indicator when the seek was refused", () => {
    // A refused seek clears the target, and the playhead stays on the frame before.
    expect(
      resolveSnapIndicatorRatio(
        inBoundary,
        drawn({ presentedFrame: { mediaTime: 1.5, inferredSourcePts: pts("1500") } }),
      ),
    ).toBeNull();
    expect(resolveSnapIndicatorRatio(inBoundary, drawn({}))).toBeNull();
  });

  it("keeps the indicator for a dropped repeat on a boundary whose seek settled", () => {
    expect(
      resolveSnapIndicatorRatio(
        inBoundary,
        drawn({ presentedFrame: { mediaTime: 2, inferredSourcePts: pts("2000") } }),
      ),
    ).toBe(0.2);
  });

  it("hides the indicator for a sample that did not snap", () => {
    expect(resolveSnapIndicatorRatio(null, drawn({ seekTargetSeconds: 2 }))).toBeNull();
  });
});
