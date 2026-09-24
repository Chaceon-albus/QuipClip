/**
 * The auto-scroll of the timeline while the user drags the playhead near an edge of the
 * visible lane.
 *
 * When the pointer of a drag is within `EDGE_AUTO_SCROLL_ZONE_PX` of the left or the right
 * edge of the visible lane, or past that edge, the view scrolls in that direction, once per
 * animation frame. The speed rises as the pointer comes nearer to the edge, and rises again
 * as it goes further past it (`calculateEdgeAutoScrollVelocity`). A zone scrolls only after
 * the drag armed it: the pointer entered it from outside, or moved toward its edge
 * (`EdgeAutoScrollArming`). A drag that starts near an edge and moves away from it does not
 * scroll.
 *
 * The visible lane is the part of the scroll container to the right of the sticky gutter
 * (`calculateVisibleLane`). The panel clamps the pointer to it for the seek
 * (`calculateScrubClampRange`), so the playhead stays at the edge of the view while the view
 * scrolls.
 *
 * The speed is in pixels per second and each step multiplies it by the time since the last
 * frame, so a display at 120 Hz scrolls at the same speed as one at 60 Hz. The browser snaps
 * scrollLeft to the device pixel grid, so a step of less than one device pixel can leave it
 * where it was. The loop keeps the part of each step that the snap removed and adds it to the
 * next step, so a slow scroll still moves.
 *
 * The scroll follows the pointer and stops when the pointer leaves the zone, so it is direct
 * manipulation and not an animation. It runs also when the user asks for reduced motion,
 * because without it a drag cannot reach a time outside the view.
 *
 * The module has no React dependency. The loop reads and writes the view through callbacks,
 * so the tests need no document.
 */

import { TIMELINE_GUTTER_WIDTH_PX } from "@/features/timeline";

/** A range of client X coordinates, in CSS pixels. */
export interface ClientRange {
  readonly left: number;
  readonly right: number;
}

/**
 * The visible part of the lane, from the rectangle of the scroll container: from the right
 * edge of the sticky gutter to the right edge of the container. The gutter covers the left
 * edge of the viewport, so the part of the lane under it is not visible.
 *
 * The right edge is the right of the rectangle, which is fractional. `clientWidth` is rounded
 * to a whole pixel, and at 125%, 150% or 175% display scaling a right edge from it can lie up
 * to half a pixel before the edge that the user sees. The rectangle is the visible area only
 * because the scroll container has no border, no padding and no vertical scrollbar
 * (`overflow-y: hidden`). Its horizontal scrollbar takes height, not width.
 */
export function calculateVisibleLane(containerRect: ClientRange): ClientRange {
  return {
    left: containerRect.left + TIMELINE_GUTTER_WIDTH_PX,
    right: containerRect.right,
  };
}

/**
 * The distance under which an end of the lane counts as the edge of the view, in CSS pixels.
 * The browser snaps scrollLeft to the device pixel grid, so at the start or the end of the
 * scroll range an end of the lane can lie a fraction of a device pixel outside the view.
 */
export const LANE_END_SNAP_PX = 1;

/**
 * The range that a drag clamps the pointer to: the visible lane, where an end of the lane that
 * lies less than `LANE_END_SNAP_PX` outside the view counts as that edge of the view.
 *
 * Without that rule, at the end of the scroll range a drag past the edge could stop a fraction
 * of a pixel before the end of the lane, and on a long source one pixel is several seconds.
 * With it, a drag past the edge reaches the exact first or last time of the lane whenever the
 * view cannot scroll further.
 *
 * The same range is the part of the lane in which a boundary can snap (`resolveScrubSnap`).
 */
export function calculateScrubClampRange(
  visibleLane: ClientRange,
  lane: ClientRange,
): ClientRange {
  const left =
    lane.left < visibleLane.left && visibleLane.left - lane.left < LANE_END_SNAP_PX
      ? lane.left
      : visibleLane.left;
  const right =
    lane.right > visibleLane.right && lane.right - visibleLane.right < LANE_END_SNAP_PX
      ? lane.right
      : visibleLane.right;
  return { left, right };
}

/** The width of the zone at each edge of the visible lane, in CSS pixels. */
export const EDGE_AUTO_SCROLL_ZONE_PX = 24;

/** The speed just inside the zone, in CSS pixels per second. */
export const EDGE_AUTO_SCROLL_MIN_SPEED_PX_PER_S = 120;

/** The speed with the pointer on the edge of the visible lane, in CSS pixels per second. */
export const EDGE_AUTO_SCROLL_EDGE_SPEED_PX_PER_S = 720;

/** How far past the edge the speed keeps rising, in CSS pixels. */
export const EDGE_AUTO_SCROLL_OVERSHOOT_PX = 120;

/** The speed at `EDGE_AUTO_SCROLL_OVERSHOOT_PX` past the edge and further, in pixels per second. */
export const EDGE_AUTO_SCROLL_MAX_SPEED_PX_PER_S = 3600;

/**
 * The longest frame time that one step uses, in milliseconds. A frame after a stall, such as
 * a garbage collection, would otherwise scroll by a large jump.
 */
export const EDGE_AUTO_SCROLL_MAX_FRAME_MS = 50;

/** The frame time of the first step, which has no earlier frame, in milliseconds. */
export const EDGE_AUTO_SCROLL_FIRST_FRAME_MS = 1000 / 60;

/**
 * The speed at one depth into the zone. The depth is the distance from the inner border of
 * the zone toward the edge: `EDGE_AUTO_SCROLL_ZONE_PX` is on the edge, and more is past it.
 */
function speedAtDepth(depthPx: number): number {
  if (depthPx <= EDGE_AUTO_SCROLL_ZONE_PX) {
    return (
      EDGE_AUTO_SCROLL_MIN_SPEED_PX_PER_S +
      ((EDGE_AUTO_SCROLL_EDGE_SPEED_PX_PER_S - EDGE_AUTO_SCROLL_MIN_SPEED_PX_PER_S) *
        depthPx) /
        EDGE_AUTO_SCROLL_ZONE_PX
    );
  }
  const past = Math.min(
    1,
    (depthPx - EDGE_AUTO_SCROLL_ZONE_PX) / EDGE_AUTO_SCROLL_OVERSHOOT_PX,
  );
  return (
    EDGE_AUTO_SCROLL_EDGE_SPEED_PX_PER_S +
    (EDGE_AUTO_SCROLL_MAX_SPEED_PX_PER_S - EDGE_AUTO_SCROLL_EDGE_SPEED_PX_PER_S) * past
  );
}

/**
 * The scroll velocity for a pointer position, in CSS pixels per second. It is negative toward
 * the start of the lane, positive toward the end, and 0 outside the two zones.
 *
 * - A pointer less than `EDGE_AUTO_SCROLL_ZONE_PX` from an edge, or past it, scrolls.
 * - Inside the zone, the speed rises in a straight line from
 *   `EDGE_AUTO_SCROLL_MIN_SPEED_PX_PER_S` to `EDGE_AUTO_SCROLL_EDGE_SPEED_PX_PER_S` on the
 *   edge.
 * - Past the edge, it rises in a straight line to `EDGE_AUTO_SCROLL_MAX_SPEED_PX_PER_S` at
 *   `EDGE_AUTO_SCROLL_OVERSHOOT_PX` past the edge, and stays there.
 * - When the lane is so narrow that the two zones overlap, the edge that the pointer is
 *   nearer to wins, and a pointer in the middle does not scroll.
 *
 * Returns 0 for an input that is not finite and for an empty lane.
 */
export function calculateEdgeAutoScrollVelocity(
  pointerX: number,
  visibleLeftPx: number,
  visibleRightPx: number,
): number {
  if (
    !Number.isFinite(pointerX) ||
    !Number.isFinite(visibleLeftPx) ||
    !Number.isFinite(visibleRightPx) ||
    visibleRightPx <= visibleLeftPx
  ) {
    return 0;
  }
  const leftDepth = visibleLeftPx + EDGE_AUTO_SCROLL_ZONE_PX - pointerX;
  const rightDepth = pointerX - (visibleRightPx - EDGE_AUTO_SCROLL_ZONE_PX);
  if (leftDepth > 0 && leftDepth > rightDepth) {
    return -speedAtDepth(leftDepth);
  }
  if (rightDepth > 0 && rightDepth > leftDepth) {
    return speedAtDepth(rightDepth);
  }
  return 0;
}

/** An edge zone of the visible lane. */
export type EdgeAutoScrollZone = "left" | "right";

/**
 * The move toward an edge, in CSS pixels, that arms the auto-scroll for a pointer that is
 * already in the zone of that edge. It is the drag threshold of the gesture
 * (`SCRUB_MOVE_THRESHOLD_PX`), so a tremor of a pointer that rests does not arm it.
 */
export const EDGE_AUTO_SCROLL_ARM_PX = 3;

/**
 * The arming of the auto-scroll during one drag.
 *
 * A drag that starts inside a zone must not scroll toward that edge while the pointer moves
 * away from it: the user pressed near the edge to scrub back into the view. So the zone of an
 * edge scrolls only after it is armed, and it is armed in one of two ways:
 *
 * - The pointer enters the zone from outside it.
 * - The pointer, already in the zone, moves `EDGE_AUTO_SCROLL_ARM_PX` or more toward the edge
 *   from the point where it was furthest from the edge. That point starts at the pointer down
 *   of the drag, and it follows the pointer while the pointer moves away from the edge.
 *
 * An armed zone stays armed while the pointer is in it, also while the pointer rests or moves
 * back a little. Outside both zones nothing is armed.
 */
export interface EdgeAutoScrollArming {
  /** The zone that scrolls, or null. */
  readonly armed: EdgeAutoScrollZone | null;
  /** The zone of the last pointer position, or null outside both zones. */
  readonly zone: EdgeAutoScrollZone | null;
  /** The point that a move toward the edge is measured from, in client pixels. */
  readonly referenceX: number;
}

/** The zone of a pointer position, or null outside both zones. */
function zoneOf(
  pointerX: number,
  visibleLeftPx: number,
  visibleRightPx: number,
): EdgeAutoScrollZone | null {
  const velocity = calculateEdgeAutoScrollVelocity(
    pointerX,
    visibleLeftPx,
    visibleRightPx,
  );
  return velocity > 0 ? "right" : velocity < 0 ? "left" : null;
}

/** The arming at the pointer down of a drag. Nothing is armed yet. */
export function createEdgeAutoScrollArming(
  startPointerX: number,
  visibleLeftPx: number,
  visibleRightPx: number,
): EdgeAutoScrollArming {
  return {
    armed: null,
    zone: zoneOf(startPointerX, visibleLeftPx, visibleRightPx),
    referenceX: startPointerX,
  };
}

/** The arming after the pointer moves to a new position. See `EdgeAutoScrollArming`. */
export function advanceEdgeAutoScrollArming(
  arming: EdgeAutoScrollArming,
  pointerX: number,
  visibleLeftPx: number,
  visibleRightPx: number,
): EdgeAutoScrollArming {
  const zone = zoneOf(pointerX, visibleLeftPx, visibleRightPx);
  if (zone === null) {
    return { armed: null, zone: null, referenceX: pointerX };
  }
  if (arming.armed === zone) {
    return { armed: zone, zone, referenceX: pointerX };
  }
  const towardEdgePx =
    zone === "right" ? pointerX - arming.referenceX : arming.referenceX - pointerX;
  if (arming.zone !== zone || towardEdgePx >= EDGE_AUTO_SCROLL_ARM_PX) {
    return { armed: zone, zone, referenceX: pointerX };
  }
  // Not armed yet: the reference follows the pointer while it moves away from the edge.
  const referenceX =
    zone === "right"
      ? Math.min(arming.referenceX, pointerX)
      : Math.max(arming.referenceX, pointerX);
  return { armed: null, zone, referenceX };
}

/**
 * Clamps a pointer position to the visible lane. A drag past an edge seeks to the time at
 * that edge, so the playhead stays in view while the view scrolls toward the pointer.
 */
export function clampToVisibleLane(
  pointerX: number,
  visibleLeftPx: number,
  visibleRightPx: number,
): number {
  if (
    !Number.isFinite(visibleLeftPx) ||
    !Number.isFinite(visibleRightPx) ||
    visibleRightPx < visibleLeftPx
  ) {
    return pointerX;
  }
  return Math.max(visibleLeftPx, Math.min(visibleRightPx, pointerX));
}

/** The view as one step of the loop reads it. */
export interface EdgeAutoScrollGeometry {
  /** The left edge of the visible lane, in client pixels: the right edge of the gutter. */
  readonly visibleLeftPx: number;
  /** The right edge of the visible lane, in client pixels. */
  readonly visibleRightPx: number;
  /** The scrollLeft of the view, from the mirror of the panel. */
  readonly scrollLeftPx: number;
  /** The largest scrollLeft of the view. */
  readonly maxScrollLeftPx: number;
}

/** The result of `calculateEdgeAutoScrollStep`. */
export interface EdgeAutoScrollStep {
  /** The scrollLeft to write, inside the scroll range. */
  readonly scrollLeftPx: number;
  /** True when the step can move the view. False at the end of the range in its direction. */
  readonly canMove: boolean;
}

/**
 * One step of the auto-scroll: the scrollLeft to write for a velocity and a frame time.
 *
 * `carryPx` is the part of the earlier steps that the device pixel snap removed. The step adds
 * it, so a speed of less than one device pixel for each frame still moves the view.
 */
export function calculateEdgeAutoScrollStep(
  scrollLeftPx: number,
  maxScrollLeftPx: number,
  velocityPxPerS: number,
  frameMs: number,
  carryPx: number,
): EdgeAutoScrollStep {
  const safeMax = Number.isFinite(maxScrollLeftPx) ? Math.max(0, maxScrollLeftPx) : 0;
  const safeScroll = Number.isFinite(scrollLeftPx)
    ? Math.max(0, Math.min(safeMax, scrollLeftPx))
    : 0;
  if (!Number.isFinite(velocityPxPerS) || velocityPxPerS === 0) {
    return { scrollLeftPx: safeScroll, canMove: false };
  }
  const canMove = velocityPxPerS > 0 ? safeScroll < safeMax : safeScroll > 0;
  if (!canMove) {
    return { scrollLeftPx: safeScroll, canMove: false };
  }
  const safeFrameMs = Number.isFinite(frameMs)
    ? Math.max(0, Math.min(EDGE_AUTO_SCROLL_MAX_FRAME_MS, frameMs))
    : 0;
  const safeCarry = Number.isFinite(carryPx) ? carryPx : 0;
  const next = safeScroll + safeCarry + (velocityPxPerS * safeFrameMs) / 1000;
  return { scrollLeftPx: Math.max(0, Math.min(safeMax, next)), canMove: true };
}

/**
 * True when a step wrote a scrollLeft and the view did not move, and it will not move at the
 * next step either, so the loop must stop.
 *
 * The largest scrollLeft that the panel reads is `scrollWidth - clientWidth`, and both are
 * rounded to whole pixels. The browser can keep a range end a fraction of a pixel short of it.
 * At that end every step requests the rounded end, the view keeps the same value, and without
 * this test the loop would write and sample the drag again on every frame while the pointer
 * rests past the edge.
 *
 * A step that did not move is not always a stall. A slow step can be smaller than one device
 * pixel, and the carry moves the view at a later step (`calculateEdgeAutoScrollStep`). So the
 * view counts as stalled only when it did not move and the step requested an end of the range,
 * or a move of `LANE_END_SNAP_PX` or more. No snap to the device pixel grid refuses a move that
 * large.
 */
export function isEdgeAutoScrollStalled(
  scrollLeftBeforePx: number,
  requestedScrollLeftPx: number,
  keptScrollLeftPx: number,
  maxScrollLeftPx: number,
): boolean {
  if (keptScrollLeftPx !== scrollLeftBeforePx) {
    return false;
  }
  return (
    requestedScrollLeftPx <= 0 ||
    requestedScrollLeftPx >= maxScrollLeftPx ||
    Math.abs(requestedScrollLeftPx - keptScrollLeftPx) >= LANE_END_SNAP_PX
  );
}

/** The frame scheduler of the loop. `requestAnimationFrame` by default. */
export interface EdgeAutoScrollScheduler {
  request: (callback: (timestampMs: number) => void) => number;
  cancel: (handle: number) => void;
}

export interface CreateEdgeAutoScrollOptions {
  /** Reads the view for a step, or returns null when the view cannot scroll now. */
  readonly readGeometry: () => EdgeAutoScrollGeometry | null;
  /**
   * Writes a scrollLeft to the view and returns the value that the view kept. The panel
   * writes its mirror of scrollLeft from that value.
   */
  readonly writeScrollLeft: (scrollLeftPx: number) => number;
  /** Called after each step that wrote a scrollLeft, so the panel can sample the drag again. */
  readonly onScrolled: () => void;
  /** True while the drag runs. The loop stops at the first step where it is false. */
  readonly isDragging: () => boolean;
  readonly scheduler?: EdgeAutoScrollScheduler;
}

export interface EdgeAutoScroll {
  /**
   * Starts the arming of a new drag at its pointer down, in client pixels
   * (`EdgeAutoScrollArming`). Nothing is armed until the pointer moves.
   */
  begin(startPointerX: number): void;
  /**
   * Records the pointer position of the drag, in client pixels, and makes sure that a step is
   * scheduled. The step updates the arming, decides whether the view scrolls, and stops the
   * loop when the pointer is outside the zones or in a zone that is not armed.
   */
  update(pointerX: number): void;
  /** Stops the loop and forgets the pointer and the arming. */
  stop(): void;
  /** True while a step is scheduled. */
  isRunning(): boolean;
}

const defaultScheduler: EdgeAutoScrollScheduler = {
  request: (callback) => globalThis.requestAnimationFrame(callback),
  cancel: (handle) => globalThis.cancelAnimationFrame(handle),
};

/**
 * Creates the auto-scroll loop of one panel.
 *
 * `update` only records the pointer and schedules a step, so a pointer move does no layout
 * read. The step reads the view in the animation frame, where the gesture reads it too, and it
 * updates the arming there with the latest pointer position of the frame. The zones are in
 * client pixels, and a scroll does not move them, so the arming holds while the view scrolls.
 */
export function createEdgeAutoScroll(
  options: CreateEdgeAutoScrollOptions,
): EdgeAutoScroll {
  const { readGeometry, writeScrollLeft, onScrolled, isDragging } = options;
  const scheduler = options.scheduler ?? defaultScheduler;

  let pointerX: number | null = null;
  // The pointer down of the drag, and the arming, which the first step creates from it.
  let startPointerX: number | null = null;
  let arming: EdgeAutoScrollArming | null = null;
  let handle: number | null = null;
  let lastTimestampMs: number | null = null;
  let carryPx = 0;

  const reset = (): void => {
    if (handle !== null) {
      scheduler.cancel(handle);
      handle = null;
    }
    lastTimestampMs = null;
    carryPx = 0;
  };

  const step = (timestampMs: number): void => {
    handle = null;
    if (pointerX === null || !isDragging()) {
      reset();
      return;
    }
    const geometry = readGeometry();
    if (geometry === null) {
      reset();
      return;
    }
    arming = advanceEdgeAutoScrollArming(
      arming ??
        createEdgeAutoScrollArming(
          startPointerX ?? pointerX,
          geometry.visibleLeftPx,
          geometry.visibleRightPx,
        ),
      pointerX,
      geometry.visibleLeftPx,
      geometry.visibleRightPx,
    );
    // An armed zone is the zone of the pointer, so its velocity points toward that edge.
    const velocity =
      arming.armed === null
        ? 0
        : calculateEdgeAutoScrollVelocity(
            pointerX,
            geometry.visibleLeftPx,
            geometry.visibleRightPx,
          );
    const frameMs =
      lastTimestampMs === null
        ? EDGE_AUTO_SCROLL_FIRST_FRAME_MS
        : timestampMs - lastTimestampMs;
    const next = calculateEdgeAutoScrollStep(
      geometry.scrollLeftPx,
      geometry.maxScrollLeftPx,
      velocity,
      frameMs,
      carryPx,
    );
    if (!next.canMove) {
      // Outside the zones, in a zone that is not armed, or at the end of the range: the loop
      // stops until the next move. The arming stays for that move.
      reset();
      return;
    }
    const keptPx = writeScrollLeft(next.scrollLeftPx);
    if (
      isEdgeAutoScrollStalled(
        geometry.scrollLeftPx,
        next.scrollLeftPx,
        keptPx,
        geometry.maxScrollLeftPx,
      )
    ) {
      // The view is at an end of its range that the rounded maximum does not show. Nothing
      // moved, so the drag needs no new sample.
      reset();
      return;
    }
    // At an end of the range there is nothing to carry.
    const atEnd =
      next.scrollLeftPx <= 0 || next.scrollLeftPx >= geometry.maxScrollLeftPx;
    carryPx = atEnd || !Number.isFinite(keptPx) ? 0 : next.scrollLeftPx - keptPx;
    lastTimestampMs = timestampMs;
    onScrolled();
    handle = scheduler.request(step);
  };

  return {
    begin(nextStartPointerX: number): void {
      pointerX = null;
      startPointerX = nextStartPointerX;
      arming = null;
      reset();
    },
    update(nextPointerX: number): void {
      pointerX = nextPointerX;
      if (handle === null) {
        handle = scheduler.request(step);
      }
    },
    stop(): void {
      pointerX = null;
      startPointerX = null;
      arming = null;
      reset();
    },
    isRunning(): boolean {
      return handle !== null;
    },
  };
}
