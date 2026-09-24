import { describe, expect, it, vi } from "vitest";
import {
  calculateTimelineSecondsFromClientX,
  TIMELINE_GUTTER_WIDTH_PX,
} from "@/features/timeline";
import {
  calculateEdgeAutoScrollStep,
  calculateEdgeAutoScrollVelocity,
  calculateScrubClampRange,
  calculateVisibleLane,
  clampToVisibleLane,
  advanceEdgeAutoScrollArming,
  createEdgeAutoScroll,
  createEdgeAutoScrollArming,
  EDGE_AUTO_SCROLL_ARM_PX,
  isEdgeAutoScrollStalled,
  LANE_END_SNAP_PX,
  EDGE_AUTO_SCROLL_EDGE_SPEED_PX_PER_S,
  EDGE_AUTO_SCROLL_FIRST_FRAME_MS,
  EDGE_AUTO_SCROLL_MAX_FRAME_MS,
  EDGE_AUTO_SCROLL_MAX_SPEED_PX_PER_S,
  EDGE_AUTO_SCROLL_MIN_SPEED_PX_PER_S,
  EDGE_AUTO_SCROLL_OVERSHOOT_PX,
  EDGE_AUTO_SCROLL_ZONE_PX,
  type EdgeAutoScrollArming,
  type EdgeAutoScrollGeometry,
  type EdgeAutoScrollScheduler,
} from "./edgeAutoScroll";

// A visible lane from x 100 (the right edge of the gutter) to x 1000.
const LEFT = 100;
const RIGHT = 1000;

describe("calculateEdgeAutoScrollVelocity", () => {
  it("does not scroll outside the two zones", () => {
    expect(calculateEdgeAutoScrollVelocity(500, LEFT, RIGHT)).toBe(0);
    expect(
      calculateEdgeAutoScrollVelocity(LEFT + EDGE_AUTO_SCROLL_ZONE_PX, LEFT, RIGHT),
    ).toBe(0);
    expect(
      calculateEdgeAutoScrollVelocity(RIGHT - EDGE_AUTO_SCROLL_ZONE_PX, LEFT, RIGHT),
    ).toBe(0);
  });

  it("uses a zone of 24 px", () => {
    expect(EDGE_AUTO_SCROLL_ZONE_PX).toBe(24);
  });

  it("scrolls toward the end near the right edge and toward the start near the left edge", () => {
    expect(calculateEdgeAutoScrollVelocity(RIGHT - 10, LEFT, RIGHT)).toBeGreaterThan(0);
    expect(calculateEdgeAutoScrollVelocity(LEFT + 10, LEFT, RIGHT)).toBeLessThan(0);
  });

  it("starts at the minimum speed just inside the zone and reaches the edge speed on the edge", () => {
    expect(
      calculateEdgeAutoScrollVelocity(
        RIGHT - EDGE_AUTO_SCROLL_ZONE_PX + 1e-9,
        LEFT,
        RIGHT,
      ),
    ).toBeCloseTo(EDGE_AUTO_SCROLL_MIN_SPEED_PX_PER_S, 3);
    expect(calculateEdgeAutoScrollVelocity(RIGHT, LEFT, RIGHT)).toBe(
      EDGE_AUTO_SCROLL_EDGE_SPEED_PX_PER_S,
    );
    expect(calculateEdgeAutoScrollVelocity(LEFT, LEFT, RIGHT)).toBe(
      -EDGE_AUTO_SCROLL_EDGE_SPEED_PX_PER_S,
    );
  });

  it("rises past the edge up to the maximum, and stays there", () => {
    expect(
      calculateEdgeAutoScrollVelocity(
        RIGHT + EDGE_AUTO_SCROLL_OVERSHOOT_PX,
        LEFT,
        RIGHT,
      ),
    ).toBe(EDGE_AUTO_SCROLL_MAX_SPEED_PX_PER_S);
    expect(calculateEdgeAutoScrollVelocity(RIGHT + 10_000, LEFT, RIGHT)).toBe(
      EDGE_AUTO_SCROLL_MAX_SPEED_PX_PER_S,
    );
    expect(calculateEdgeAutoScrollVelocity(LEFT - 10_000, LEFT, RIGHT)).toBe(
      -EDGE_AUTO_SCROLL_MAX_SPEED_PX_PER_S,
    );
  });

  it("is continuous at the edge, and faster the nearer to or the further past the edge", () => {
    const speeds: number[] = [];
    for (let x = RIGHT - EDGE_AUTO_SCROLL_ZONE_PX + 1; x <= RIGHT + 200; x += 1) {
      speeds.push(calculateEdgeAutoScrollVelocity(x, LEFT, RIGHT));
    }
    for (let index = 1; index < speeds.length; index++) {
      expect(speeds[index]).toBeGreaterThanOrEqual(speeds[index - 1]);
    }
    const justBefore = calculateEdgeAutoScrollVelocity(RIGHT - 1e-6, LEFT, RIGHT);
    const justAfter = calculateEdgeAutoScrollVelocity(RIGHT + 1e-6, LEFT, RIGHT);
    expect(justAfter - justBefore).toBeLessThan(1);
  });

  it("is symmetric at the two edges", () => {
    for (const depth of [1, 12, 24, 60, 144, 500]) {
      expect(
        calculateEdgeAutoScrollVelocity(
          LEFT + EDGE_AUTO_SCROLL_ZONE_PX - depth,
          LEFT,
          RIGHT,
        ),
      ).toBe(
        -calculateEdgeAutoScrollVelocity(
          RIGHT - EDGE_AUTO_SCROLL_ZONE_PX + depth,
          LEFT,
          RIGHT,
        ),
      );
    }
  });

  it("gives the nearer edge the scroll when the zones overlap on a narrow lane", () => {
    expect(calculateEdgeAutoScrollVelocity(105, 100, 130)).toBeLessThan(0);
    expect(calculateEdgeAutoScrollVelocity(125, 100, 130)).toBeGreaterThan(0);
    expect(calculateEdgeAutoScrollVelocity(115, 100, 130)).toBe(0);
  });

  it("does not scroll for an input that is not finite or an empty lane", () => {
    expect(calculateEdgeAutoScrollVelocity(NaN, LEFT, RIGHT)).toBe(0);
    expect(calculateEdgeAutoScrollVelocity(RIGHT, NaN, RIGHT)).toBe(0);
    expect(calculateEdgeAutoScrollVelocity(RIGHT, LEFT, Infinity)).toBe(0);
    expect(calculateEdgeAutoScrollVelocity(RIGHT, RIGHT, RIGHT)).toBe(0);
    expect(calculateEdgeAutoScrollVelocity(RIGHT, RIGHT, LEFT)).toBe(0);
  });
});

describe("clampToVisibleLane", () => {
  it("clamps a pointer past an edge to that edge", () => {
    expect(clampToVisibleLane(50, LEFT, RIGHT)).toBe(LEFT);
    expect(clampToVisibleLane(1200, LEFT, RIGHT)).toBe(RIGHT);
    expect(clampToVisibleLane(500, LEFT, RIGHT)).toBe(500);
  });

  it("keeps the pointer when the lane is not usable", () => {
    expect(clampToVisibleLane(50, NaN, RIGHT)).toBe(50);
    expect(clampToVisibleLane(50, RIGHT, LEFT)).toBe(50);
  });
});

describe("calculateVisibleLane", () => {
  it("starts at the right edge of the gutter and ends at the fractional right of the container", () => {
    expect(calculateVisibleLane({ left: 10.4, right: 1034.0 })).toEqual({
      left: 10.4 + TIMELINE_GUTTER_WIDTH_PX,
      right: 1034.0,
    });
  });
});

describe("calculateScrubClampRange", () => {
  const visible = { left: 196, right: 1123.6 };

  it("is the visible lane while the lane runs on past both edges", () => {
    expect(calculateScrubClampRange(visible, { left: -500, right: 3000 })).toEqual(
      visible,
    );
  });

  it("takes an end of the lane less than one pixel outside the view as that edge", () => {
    expect(calculateScrubClampRange(visible, { left: 195.6, right: 1124.1 })).toEqual({
      left: 195.6,
      right: 1124.1,
    });
  });

  it("keeps the edge of the view for an end of the lane one pixel or more outside it", () => {
    expect(
      calculateScrubClampRange(visible, {
        left: 196 - LANE_END_SNAP_PX,
        right: 1123.6 + LANE_END_SNAP_PX,
      }),
    ).toEqual(visible);
  });

  it("keeps the edge of the view for an end of the lane inside it", () => {
    expect(calculateScrubClampRange(visible, { left: 300, right: 900 })).toEqual(
      visible,
    );
  });

  it("lets a drag past the right edge reach the exact end of a lane of fractional width", () => {
    // A container 1023.6 px wide at 125% scaling: clientWidth would round it to 1024, and
    // with that a right edge 0.4 px past the lane. The rectangle keeps the fraction.
    const container = { left: 0, right: 1023.6 };
    const totalSeconds = 7200;
    // Zoom 1: the lane fills the visible part of the container exactly.
    const fitLane = { left: TIMELINE_GUTTER_WIDTH_PX, right: 1023.6 };
    const fit = calculateScrubClampRange(calculateVisibleLane(container), fitLane);
    const fitX = clampToVisibleLane(5000, fit.left, fit.right);
    expect(
      calculateTimelineSecondsFromClientX(
        fitX,
        fitLane.left,
        fitLane.right - fitLane.left,
        totalSeconds,
      ),
    ).toBe(totalSeconds);

    // At the end of the scroll range the device pixel snap leaves the lane end 0.4 px past
    // the view. On a 2 h source at zoom 2 that is more than one second.
    const zoomedLane = { left: -832, right: 1024.0 };
    const zoomed = calculateScrubClampRange(
      calculateVisibleLane(container),
      zoomedLane,
    );
    const zoomedX = clampToVisibleLane(5000, zoomed.left, zoomed.right);
    expect(
      calculateTimelineSecondsFromClientX(
        zoomedX,
        zoomedLane.left,
        zoomedLane.right - zoomedLane.left,
        totalSeconds,
      ),
    ).toBe(totalSeconds);
  });

  it("lets a drag past the left edge reach the exact start of the lane", () => {
    const container = { left: 0.3, right: 1023.6 };
    // scrollLeft snapped to 0.4 px: the lane starts 0.4 px under the gutter.
    const lane = { left: 0.3 + TIMELINE_GUTTER_WIDTH_PX - 0.4, right: 3000 };
    const range = calculateScrubClampRange(calculateVisibleLane(container), lane);
    const x = clampToVisibleLane(-50, range.left, range.right);
    expect(
      calculateTimelineSecondsFromClientX(x, lane.left, lane.right - lane.left, 60),
    ).toBe(0);
  });
});

describe("isEdgeAutoScrollStalled", () => {
  it("is false when the view moved", () => {
    expect(isEdgeAutoScrollStalled(100, 112, 112, 2000)).toBe(false);
    expect(isEdgeAutoScrollStalled(1999, 2000, 1999.5, 2000)).toBe(false);
  });

  it("is true when the view kept its value for a request at an end of the range", () => {
    // The rounded maximum is 2000, and the view keeps 1999.5.
    expect(isEdgeAutoScrollStalled(1999.5, 2000, 1999.5, 2000)).toBe(true);
    expect(isEdgeAutoScrollStalled(0.4, 0, 0.4, 2000)).toBe(true);
  });

  it("is true when the view refused a move of one pixel or more", () => {
    expect(isEdgeAutoScrollStalled(500, 500 + LANE_END_SNAP_PX, 500, 2000)).toBe(true);
    expect(isEdgeAutoScrollStalled(500, 488, 500, 2000)).toBe(true);
  });

  it("is false for a slow step that is smaller than one device pixel", () => {
    expect(isEdgeAutoScrollStalled(500, 500.5, 500, 2000)).toBe(false);
    expect(isEdgeAutoScrollStalled(500, 499.6, 500, 2000)).toBe(false);
  });
});

describe("calculateEdgeAutoScrollStep", () => {
  it("moves by the velocity times the frame time, in the direction of the velocity", () => {
    expect(calculateEdgeAutoScrollStep(500, 2000, 600, 20, 0)).toEqual({
      scrollLeftPx: 512,
      canMove: true,
    });
    expect(calculateEdgeAutoScrollStep(500, 2000, -600, 20, 0)).toEqual({
      scrollLeftPx: 488,
      canMove: true,
    });
  });

  it("adds the carry of the earlier steps", () => {
    expect(
      calculateEdgeAutoScrollStep(500, 2000, 60, 16, 0.4).scrollLeftPx,
    ).toBeCloseTo(501.36, 10);
  });

  it("clamps to the scroll range", () => {
    expect(calculateEdgeAutoScrollStep(1995, 2000, 3600, 16, 0)).toEqual({
      scrollLeftPx: 2000,
      canMove: true,
    });
    expect(calculateEdgeAutoScrollStep(5, 2000, -3600, 16, 0)).toEqual({
      scrollLeftPx: 0,
      canMove: true,
    });
  });

  it("cannot move at the end of the range in its direction, or with no velocity", () => {
    expect(calculateEdgeAutoScrollStep(2000, 2000, 600, 16, 0).canMove).toBe(false);
    expect(calculateEdgeAutoScrollStep(0, 2000, -600, 16, 0).canMove).toBe(false);
    expect(calculateEdgeAutoScrollStep(0, 0, 600, 16, 0).canMove).toBe(false);
    expect(calculateEdgeAutoScrollStep(500, 2000, 0, 16, 0)).toEqual({
      scrollLeftPx: 500,
      canMove: false,
    });
    // The other direction can still move.
    expect(calculateEdgeAutoScrollStep(2000, 2000, -600, 16, 0).canMove).toBe(true);
  });

  it("limits a long frame, so a stall does not jump", () => {
    expect(calculateEdgeAutoScrollStep(0, 10_000, 1000, 1000, 0).scrollLeftPx).toBe(
      (1000 * EDGE_AUTO_SCROLL_MAX_FRAME_MS) / 1000,
    );
    expect(calculateEdgeAutoScrollStep(0, 10_000, 1000, -5, 0).scrollLeftPx).toBe(0);
  });

  it("treats an input that is not finite safely", () => {
    expect(calculateEdgeAutoScrollStep(NaN, 2000, 600, 16, 0).scrollLeftPx).toBeCloseTo(
      9.6,
      10,
    );
    expect(calculateEdgeAutoScrollStep(500, 2000, NaN, 16, 0).canMove).toBe(false);
    expect(calculateEdgeAutoScrollStep(500, 2000, 600, NaN, NaN).scrollLeftPx).toBe(
      500,
    );
  });
});

describe("the arming of the auto-scroll", () => {
  /** The arming after a drag from `start` through each of `moves`. */
  const drag = (start: number, ...moves: number[]): EdgeAutoScrollArming =>
    moves.reduce(
      (arming, x) => advanceEdgeAutoScrollArming(arming, x, LEFT, RIGHT),
      createEdgeAutoScrollArming(start, LEFT, RIGHT),
    );

  it("uses the drag threshold as the move that arms a zone", () => {
    expect(EDGE_AUTO_SCROLL_ARM_PX).toBe(3);
  });

  it("arms nothing at the pointer down, also inside a zone", () => {
    expect(createEdgeAutoScrollArming(RIGHT - 10, LEFT, RIGHT)).toEqual({
      armed: null,
      zone: "right",
      referenceX: RIGHT - 10,
    });
    expect(drag(500).armed).toBeNull();
  });

  it("arms a zone that the pointer enters from outside it", () => {
    expect(drag(500, RIGHT - 10).armed).toBe("right");
    expect(drag(500, LEFT - 30).armed).toBe("left");
    // Past the edge counts as the zone.
    expect(drag(500, RIGHT + 100).armed).toBe("right");
  });

  it("does not arm a zone that the drag started in while the pointer moves away from its edge", () => {
    expect(drag(RIGHT - 5, RIGHT - 8, RIGHT - 12, RIGHT - 20).armed).toBeNull();
    expect(drag(LEFT + 5, LEFT + 8, LEFT + 20).armed).toBeNull();
  });

  it("arms that zone once the pointer moves toward the edge by the arming distance", () => {
    // Away to RIGHT - 20, then back toward the edge.
    expect(drag(RIGHT - 5, RIGHT - 20, RIGHT - 18).armed).toBeNull();
    expect(
      drag(RIGHT - 5, RIGHT - 20, RIGHT - 20 + EDGE_AUTO_SCROLL_ARM_PX).armed,
    ).toBe("right");
    expect(drag(LEFT + 5, LEFT + 20, LEFT + 20 - EDGE_AUTO_SCROLL_ARM_PX).armed).toBe(
      "left",
    );
    // Straight toward the edge from the pointer down.
    expect(drag(RIGHT - 20, RIGHT - 16).armed).toBe("right");
  });

  it("keeps an armed zone while the pointer rests or moves back inside it", () => {
    const armed = drag(500, RIGHT - 5);
    expect(advanceEdgeAutoScrollArming(armed, RIGHT - 5, LEFT, RIGHT).armed).toBe(
      "right",
    );
    expect(advanceEdgeAutoScrollArming(armed, RIGHT - 20, LEFT, RIGHT).armed).toBe(
      "right",
    );
  });

  it("disarms outside the zones, and arms again at the next entry", () => {
    const out = drag(500, RIGHT - 5, 600);
    expect(out).toEqual({ armed: null, zone: null, referenceX: 600 });
    expect(advanceEdgeAutoScrollArming(out, RIGHT - 1, LEFT, RIGHT).armed).toBe(
      "right",
    );
  });

  it("arms the other zone when the pointer crosses into it on a narrow lane", () => {
    // A lane 40 px wide: the zones meet in the middle.
    const narrow = createEdgeAutoScrollArming(125, 100, 140);
    expect(narrow.zone).toBe("right");
    expect(advanceEdgeAutoScrollArming(narrow, 105, 100, 140).armed).toBe("left");
  });
});

interface FakeFrames extends EdgeAutoScrollScheduler {
  /** Runs the scheduled callbacks at a timestamp. */
  run: (timestampMs: number) => void;
  pending: () => number;
}

function createFakeFrames(): FakeFrames {
  let nextHandle = 1;
  const callbacks = new Map<number, (timestampMs: number) => void>();
  return {
    request(callback) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      callbacks.delete(handle);
    },
    run(timestampMs) {
      const entries = [...callbacks.values()];
      callbacks.clear();
      for (const callback of entries) {
        callback(timestampMs);
      }
    },
    pending: () => callbacks.size,
  };
}

/**
 * A view with a scroll range of 0 to 5000. It keeps each written scrollLeft snapped to a
 * device pixel ratio of 2, as a browser does.
 */
function createFakeView(initialScrollLeft = 1000) {
  let scrollLeft = initialScrollLeft;
  let dragging = true;
  const writes: number[] = [];
  const onScrolled = vi.fn();
  const frames = createFakeFrames();
  const readGeometry = vi.fn((): EdgeAutoScrollGeometry | null => ({
    visibleLeftPx: LEFT,
    visibleRightPx: RIGHT,
    scrollLeftPx: scrollLeft,
    maxScrollLeftPx: 5000,
  }));
  const autoScroll = createEdgeAutoScroll({
    readGeometry,
    writeScrollLeft: (value) => {
      writes.push(value);
      scrollLeft = Math.max(0, Math.min(5000, Math.floor(value * 2) / 2));
      return scrollLeft;
    },
    onScrolled,
    isDragging: () => dragging,
    scheduler: frames,
  });
  // The drag starts in the middle of the view, so a move into a zone arms it.
  autoScroll.begin(500);
  return {
    autoScroll,
    frames,
    writes,
    onScrolled,
    readGeometry,
    scrollLeft: () => scrollLeft,
    setDragging: (value: boolean) => {
      dragging = value;
    },
  };
}

describe("createEdgeAutoScroll", () => {
  it("does not read the view in update, only in the frame", () => {
    const view = createFakeView();
    view.autoScroll.update(RIGHT);
    expect(view.readGeometry).not.toHaveBeenCalled();
    expect(view.autoScroll.isRunning()).toBe(true);
    view.frames.run(0);
    expect(view.readGeometry).toHaveBeenCalledTimes(1);
  });

  it("stops at once when the pointer is outside the zones", () => {
    const view = createFakeView();
    view.autoScroll.update(500);
    view.frames.run(0);
    expect(view.writes).toEqual([]);
    expect(view.onScrolled).not.toHaveBeenCalled();
    expect(view.autoScroll.isRunning()).toBe(false);
  });

  it("scrolls once per frame by the speed times the frame time, and samples after each step", () => {
    const view = createFakeView();
    view.autoScroll.update(RIGHT);
    view.frames.run(1000);
    // The first step has no earlier frame and takes the nominal frame time.
    expect(view.writes[0]).toBeCloseTo(
      1000 +
        (EDGE_AUTO_SCROLL_EDGE_SPEED_PX_PER_S * EDGE_AUTO_SCROLL_FIRST_FRAME_MS) / 1000,
      9,
    );
    expect(view.onScrolled).toHaveBeenCalledTimes(1);
    expect(view.frames.pending()).toBe(1);

    const afterFirst = view.scrollLeft();
    view.frames.run(1010);
    expect(view.writes[1]).toBeCloseTo(
      afterFirst +
        (view.writes[0] - afterFirst) +
        EDGE_AUTO_SCROLL_EDGE_SPEED_PX_PER_S / 100,
      9,
    );
    expect(view.onScrolled).toHaveBeenCalledTimes(2);
  });

  it("carries the part of a step that the pixel snap removed, so a slow scroll still moves", () => {
    const view = createFakeView();
    // Just inside the zone: about 120 px/s, 0.5 px at 240 Hz, less than one snap step of the
    // fake view at some frames.
    const pointerX = RIGHT - EDGE_AUTO_SCROLL_ZONE_PX + 0.001;
    view.autoScroll.update(pointerX);
    let timestamp = 0;
    for (let frame = 0; frame < 240; frame++) {
      view.frames.run(timestamp);
      timestamp += 1000 / 240;
    }
    // One second at the minimum speed.
    expect(view.scrollLeft() - 1000).toBeGreaterThan(
      EDGE_AUTO_SCROLL_MIN_SPEED_PX_PER_S - 2,
    );
    expect(view.scrollLeft() - 1000).toBeLessThan(
      EDGE_AUTO_SCROLL_MIN_SPEED_PX_PER_S + 3,
    );
  });

  it("scrolls toward the start near the left edge", () => {
    const view = createFakeView();
    view.autoScroll.update(LEFT - 50);
    view.frames.run(0);
    expect(view.scrollLeft()).toBeLessThan(1000);
  });

  it("stops at the end of the range", () => {
    const view = createFakeView(4999);
    view.autoScroll.update(RIGHT + 200);
    view.frames.run(0);
    expect(view.scrollLeft()).toBe(5000);
    expect(view.autoScroll.isRunning()).toBe(true);
    view.frames.run(16);
    expect(view.writes).toHaveLength(1);
    expect(view.autoScroll.isRunning()).toBe(false);
  });

  it("stops at an end of the range that the rounded maximum does not show", () => {
    let scrollLeft = 4000;
    const writes: number[] = [];
    const onScrolled = vi.fn();
    const frames = createFakeFrames();
    const autoScroll = createEdgeAutoScroll({
      // The panel reads 5000 as the maximum, and the view keeps at most 4999.5.
      readGeometry: () => ({
        visibleLeftPx: LEFT,
        visibleRightPx: RIGHT,
        scrollLeftPx: scrollLeft,
        maxScrollLeftPx: 5000,
      }),
      writeScrollLeft: (value) => {
        writes.push(value);
        scrollLeft = Math.min(4999.5, value);
        return scrollLeft;
      },
      onScrolled,
      isDragging: () => true,
      scheduler: frames,
    });
    autoScroll.begin(500);
    autoScroll.update(RIGHT + 500);
    for (let frame = 0; frame < 100; frame++) {
      frames.run(frame * 16);
    }
    expect(scrollLeft).toBe(4999.5);
    expect(autoScroll.isRunning()).toBe(false);
    // The last write changed nothing, so it did not sample the drag again.
    expect(onScrolled).toHaveBeenCalledTimes(writes.length - 1);
    expect(writes.length).toBeLessThan(100);
  });

  it("does not scroll a drag that starts in a zone and moves away from its edge", () => {
    const view = createFakeView();
    view.autoScroll.begin(RIGHT - 5);
    view.autoScroll.update(RIGHT - 9);
    view.frames.run(0);
    view.autoScroll.update(RIGHT - 15);
    view.frames.run(16);
    expect(view.writes).toEqual([]);
    expect(view.autoScroll.isRunning()).toBe(false);

    // A move back toward the edge arms the zone, and the scroll starts.
    view.autoScroll.update(RIGHT - 15 + EDGE_AUTO_SCROLL_ARM_PX);
    view.frames.run(32);
    expect(view.writes).toHaveLength(1);
    expect(view.scrollLeft()).toBeGreaterThan(1000);
  });

  it("keeps scrolling while the pointer rests in an armed zone", () => {
    const view = createFakeView();
    view.autoScroll.update(RIGHT - 5);
    for (let frame = 0; frame < 10; frame++) {
      view.frames.run(frame * 16);
    }
    expect(view.writes).toHaveLength(10);
    expect(view.autoScroll.isRunning()).toBe(true);
  });

  it("starts the arming again for each drag", () => {
    const view = createFakeView();
    view.autoScroll.update(RIGHT - 5);
    view.frames.run(0);
    expect(view.writes).toHaveLength(1);
    view.autoScroll.stop();

    // A new drag that starts in the zone and moves away does not scroll.
    view.autoScroll.begin(RIGHT - 5);
    view.autoScroll.update(RIGHT - 9);
    view.frames.run(16);
    expect(view.writes).toHaveLength(1);
  });

  it("stops when the drag ends", () => {
    const view = createFakeView();
    view.autoScroll.update(RIGHT);
    view.frames.run(0);
    view.setDragging(false);
    view.frames.run(16);
    expect(view.writes).toHaveLength(1);
    expect(view.autoScroll.isRunning()).toBe(false);
  });

  it("stops when the view cannot be read", () => {
    const view = createFakeView();
    view.readGeometry.mockReturnValueOnce(null);
    view.autoScroll.update(RIGHT);
    view.frames.run(0);
    expect(view.writes).toEqual([]);
    expect(view.autoScroll.isRunning()).toBe(false);
  });

  it("stop cancels the scheduled frame and forgets the pointer", () => {
    const view = createFakeView();
    view.autoScroll.update(RIGHT);
    view.autoScroll.stop();
    expect(view.frames.pending()).toBe(0);
    expect(view.autoScroll.isRunning()).toBe(false);
    view.frames.run(0);
    expect(view.writes).toEqual([]);
  });

  it("schedules one frame for many updates, and uses the latest pointer", () => {
    const view = createFakeView();
    view.autoScroll.update(500);
    view.autoScroll.update(700);
    view.autoScroll.update(RIGHT + EDGE_AUTO_SCROLL_OVERSHOOT_PX);
    expect(view.frames.pending()).toBe(1);
    view.frames.run(0);
    expect(view.writes[0]).toBeCloseTo(
      1000 +
        (EDGE_AUTO_SCROLL_MAX_SPEED_PX_PER_S * EDGE_AUTO_SCROLL_FIRST_FRAME_MS) / 1000,
      9,
    );
  });

  it("starts the frame time again after a stop", () => {
    const view = createFakeView();
    view.autoScroll.update(RIGHT);
    view.frames.run(0);
    view.autoScroll.update(500);
    view.frames.run(16);
    expect(view.autoScroll.isRunning()).toBe(false);
    const before = view.scrollLeft();
    view.autoScroll.update(RIGHT);
    // Ten seconds later, the step still takes the nominal frame time.
    view.frames.run(10_016);
    expect(view.writes[view.writes.length - 1]).toBeCloseTo(
      before +
        (EDGE_AUTO_SCROLL_EDGE_SPEED_PX_PER_S * EDGE_AUTO_SCROLL_FIRST_FRAME_MS) / 1000,
      9,
    );
  });

  it("uses requestAnimationFrame by default", () => {
    const raf = vi
      .fn<(callback: (timestamp: number) => void) => number>()
      .mockReturnValue(7);
    const caf = vi.fn<(handle: number) => void>();
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", caf);
    try {
      const autoScroll = createEdgeAutoScroll({
        readGeometry: () => null,
        writeScrollLeft: (value) => value,
        onScrolled: () => {},
        isDragging: () => true,
      });
      autoScroll.update(RIGHT);
      expect(raf).toHaveBeenCalledTimes(1);
      autoScroll.stop();
      expect(caf).toHaveBeenCalledWith(7);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
