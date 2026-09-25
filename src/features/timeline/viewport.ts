/**
 * Pure math and layout helpers for timeline zoom and pan.
 *
 * Implements mouse-wheel zooming anchored to the pointer position, the zoom step of the keys
 * and the buttons with its playhead-or-centre anchor, content width scaling, zoom clamping,
 * and wheel delta normalization.
 */

import type { Rational } from "@/types/project";

/**
 * Width of the sticky timeline gutter in pixels.
 * Must stay equal to the sticky gutter element widths in TimelinePanel.tsx (w-[96px]).
 * If they diverge, the lane width calculation drifts by (gutter - 96px).
 */
export const TIMELINE_GUTTER_WIDTH_PX = 96;
export const TIMELINE_MIN_CONTENT_WIDTH_PX = 900;
export const MIN_TIMELINE_ZOOM = 1;

/**
 * 100,000 px is a policy number far inside the ~33.5 million px LayoutUnit
 * saturation of both engines, chosen so a very wide lane still scrolls smoothly.
 */
export const MAX_TIMELINE_CONTENT_WIDTH_PX = 100_000;

/**
 * The pixels-per-second ceiling of a source with no nominal frame rate, and the lowest ceiling
 * of any source. 200 px/s makes one 24fps frame 8.33 px (200 / 24) and one 25fps frame 8 px.
 * A source with a nominal frame rate can zoom further, until one frame is
 * `FRAME_BAND_MIN_WIDTH_PX` wide (`calculateMaxPixelsPerSecond`).
 */
export const MAX_TIMELINE_PIXELS_PER_SECOND = 200;

/**
 * The narrowest frame on screen, in CSS pixels, that shows the frame bands of the timeline: the
 * band of the frame at the playhead and the Out frame of the current segment. A narrower band
 * would be hidden by the playhead line and its outline, which are 4px wide together. The zoom
 * ceiling of a source with a nominal frame rate lets one frame reach this width, so the bands
 * can show at every common rate, as they do in Premiere Pro and DaVinci Resolve.
 */
export const FRAME_BAND_MIN_WIDTH_PX = 8;

function isValidFrameRate(rate: Rational | null | undefined): rate is Rational {
  return (
    rate !== null &&
    rate !== undefined &&
    Number.isSafeInteger(rate.n) &&
    Number.isSafeInteger(rate.d) &&
    rate.n > 0 &&
    rate.d > 0
  );
}

/**
 * The highest frame rate that raises the zoom ceiling, in frames per second. A probe can report
 * a real frame rate far above the frames of the file, such as 1000/1 for a Matroska time base,
 * and 8 px per frame of such a rate would be 8000 px/s. The cap keeps the ceiling at 1920 px/s
 * or below. A source above it zooms as far as a 240 fps source.
 */
export const MAX_ZOOM_CEILING_FRAME_RATE_FPS = 240;

/**
 * The pixels-per-second ceiling of the lane: `MAX_TIMELINE_PIXELS_PER_SECOND`, or more for a
 * source with a nominal frame rate, so that one nominal frame can be `FRAME_BAND_MIN_WIDTH_PX`
 * wide: `max(200, 8 × min(fps, 240))`. 24 and 25 fps keep 200 px/s, 29.97 fps gives 239.76,
 * 60 fps 480, 120 fps 960, and 240 fps or more 1920. The width ceiling of `calculateMaxZoom`
 * still applies on top.
 *
 * @param frameRate The nominal frame rate of the source (`getNominalFrameRate`), or null when
 *   the source reports none.
 */
export function calculateMaxPixelsPerSecond(
  frameRate: Rational | null | undefined,
): number {
  if (!isValidFrameRate(frameRate)) {
    return MAX_TIMELINE_PIXELS_PER_SECOND;
  }
  const fps = Math.min(MAX_ZOOM_CEILING_FRAME_RATE_FPS, frameRate.n / frameRate.d);
  return Math.max(MAX_TIMELINE_PIXELS_PER_SECOND, FRAME_BAND_MIN_WIDTH_PX * fps);
}

export const TIMELINE_WHEEL_ZOOM_BASE = 1.25;
export const MAX_WHEEL_DELTA_PER_EVENT_PX = 400;

/**
 * The factor of one step of the zoom keys and the zoom buttons. It is the zoom of one 100px
 * wheel notch (`calculateWheelZoomFactor`), so a key press, a button click and a wheel notch
 * zoom by the same amount.
 */
export const TIMELINE_ZOOM_STEP_FACTOR = TIMELINE_WHEEL_ZOOM_BASE;

/**
 * The relative distance under which a zoom factor snaps to a bound. A product of steps in and
 * steps out can land one rounding error away from 1 or from the maximum. Without the snap, a
 * factor of 1.0000000001 would keep Zoom Out and Fit enabled on a lane that already fits.
 */
const TIMELINE_ZOOM_SNAP_TOLERANCE = 1e-9;

/**
 * Ratio in 0..1 of a client x coordinate across the lane rectangle.
 */
export function calculateAnchorRatio(
  anchorClientX: number,
  laneClientLeft: number,
  laneWidthPx: number,
): number {
  if (
    !Number.isFinite(anchorClientX) ||
    !Number.isFinite(laneClientLeft) ||
    !Number.isFinite(laneWidthPx) ||
    laneWidthPx <= 0
  ) {
    return 0;
  }
  const ratio = (anchorClientX - laneClientLeft) / laneWidthPx;
  return Math.max(0, Math.min(1, ratio));
}

/**
 * The scrollLeft that keeps the time under the pointer under the pointer,
 * measured from the lane rectangle AFTER the new width is committed.
 */
export function calculateAnchoredScrollLeft(
  scrollLeftPx: number,
  anchorRatio: number,
  anchorClientX: number,
  laneClientLeftAfter: number,
  laneWidthAfterPx: number,
  maxScrollLeftPx: number,
): number {
  if (
    !Number.isFinite(scrollLeftPx) ||
    !Number.isFinite(anchorRatio) ||
    !Number.isFinite(anchorClientX) ||
    !Number.isFinite(laneClientLeftAfter) ||
    !Number.isFinite(laneWidthAfterPx) ||
    !Number.isFinite(maxScrollLeftPx)
  ) {
    return Number.isFinite(scrollLeftPx) ? scrollLeftPx : 0;
  }
  if (maxScrollLeftPx <= 0) {
    return 0;
  }
  const targetScrollLeft =
    scrollLeftPx +
    (laneClientLeftAfter + anchorRatio * laneWidthAfterPx) -
    anchorClientX;
  return Math.max(0, Math.min(maxScrollLeftPx, targetScrollLeft));
}

/**
 * Mirrors the CSS `min-width: 900px` under `calc(96px + (100% - 96px) * zoom)`.
 */
export function calculateContentWidthPx(zoom: number, viewportWidthPx: number): number {
  const safeZoom = Number.isFinite(zoom) ? zoom : 1;
  const safeViewport = Number.isFinite(viewportWidthPx) ? viewportWidthPx : 0;
  return Math.max(
    TIMELINE_MIN_CONTENT_WIDTH_PX,
    TIMELINE_GUTTER_WIDTH_PX + safeZoom * (safeViewport - TIMELINE_GUTTER_WIDTH_PX),
  );
}

/**
 * min(pixels-per-second ceiling, engine-safe width ceiling); 1 when the extent is indeterminate.
 *
 * The pixels-per-second ceiling depends on the nominal frame rate
 * (`calculateMaxPixelsPerSecond`): 200 px/s with no rate, and enough for one frame of
 * `FRAME_BAND_MIN_WIDTH_PX` with a rate, such as 480 px/s at 60 fps. The width ceiling of
 * MAX_TIMELINE_CONTENT_WIDTH_PX (100,000 px) applies on top, so a long source stops at that
 * width, whatever its rate.
 *
 * Divides by the lane width (base - TIMELINE_GUTTER_WIDTH_PX) rather than content width
 * so that the lane reaches exactly the pixels-per-second ceiling and
 * MAX_TIMELINE_CONTENT_WIDTH_PX.
 *
 * @param totalDurationSeconds The source extent of the ruler (ADR 007).
 * @param viewportWidthPx The width of the scroll container.
 * @param frameRate The nominal frame rate of the source (`getNominalFrameRate`), or null when
 *   the source reports none.
 */
export function calculateMaxZoom(
  totalDurationSeconds: number | null | undefined,
  viewportWidthPx: number,
  frameRate: Rational | null = null,
): number {
  if (
    totalDurationSeconds === null ||
    totalDurationSeconds === undefined ||
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0
  ) {
    return 1;
  }
  const base = calculateContentWidthPx(1, viewportWidthPx);
  const lane = Math.max(1, base - TIMELINE_GUTTER_WIDTH_PX);
  return Math.max(
    1,
    Math.min(
      (calculateMaxPixelsPerSecond(frameRate) * totalDurationSeconds) / lane,
      (MAX_TIMELINE_CONTENT_WIDTH_PX - TIMELINE_GUTTER_WIDTH_PX) / lane,
    ),
  );
}

export function clampTimelineZoom(zoom: number, maxZoom: number): number {
  const safeMax =
    Number.isFinite(maxZoom) && maxZoom >= MIN_TIMELINE_ZOOM
      ? maxZoom
      : MIN_TIMELINE_ZOOM;
  if (Number.isNaN(zoom)) {
    return MIN_TIMELINE_ZOOM;
  }
  if (zoom === Infinity) {
    return safeMax;
  }
  if (zoom <= MIN_TIMELINE_ZOOM) {
    return MIN_TIMELINE_ZOOM;
  }
  if (zoom >= safeMax) {
    return safeMax;
  }
  return zoom;
}

/**
 * Clamps a zoom factor to 1 and the maximum, and snaps a factor within a rounding error of a
 * bound to that bound. Every zoom change of the viewport store goes through this function, so
 * `zoom === MIN_TIMELINE_ZOOM` and `zoom === maxZoom` are exact tests for the two limits.
 */
export function settleTimelineZoom(zoom: number, maxZoom: number): number {
  const safeMax = clampTimelineZoom(Infinity, maxZoom);
  const clamped = clampTimelineZoom(zoom, maxZoom);
  if (clamped - MIN_TIMELINE_ZOOM <= TIMELINE_ZOOM_SNAP_TOLERANCE * MIN_TIMELINE_ZOOM) {
    return MIN_TIMELINE_ZOOM;
  }
  if (safeMax - clamped <= TIMELINE_ZOOM_SNAP_TOLERANCE * safeMax) {
    return safeMax;
  }
  return clamped;
}

/** The zoom factor after one step of the zoom keys or the zoom buttons. */
export function stepTimelineZoom(
  zoom: number,
  direction: "in" | "out",
  maxZoom: number,
): number {
  const safeZoom = Number.isFinite(zoom) ? zoom : MIN_TIMELINE_ZOOM;
  const next =
    direction === "in"
      ? safeZoom * TIMELINE_ZOOM_STEP_FACTOR
      : safeZoom / TIMELINE_ZOOM_STEP_FACTOR;
  return settleTimelineZoom(next, maxZoom);
}

/**
 * A point of the time axis that a zoom holds at one position in the viewport.
 *
 * After the new lane width is committed, the panel passes the point to
 * `calculateAnchoredScrollLeft`, with `viewportOffsetPx` added to the left edge of the scroll
 * container as the anchor client x.
 */
export interface TimelineZoomAnchorPoint {
  /** The position on the time axis, as a ratio from 0 to 1 of the source extent. */
  readonly ratio: number;
  /** The distance of the point from the left edge of the scroll container, in pixels. */
  readonly viewportOffsetPx: number;
}

/** Inputs of `resolvePlayheadOrCentreAnchor`. All of them describe the view before the zoom. */
export interface PlayheadOrCentreAnchorInput {
  /** The zoom factor of the lane before the change. */
  readonly zoom: number;
  /**
   * The fractional width of the scroll container, which is the `100%` of the lane width rule.
   * The anchor point comes from it, so the zoom holds the playhead or the centre where the
   * lane really draws it.
   */
  readonly viewportWidthPx: number;
  /**
   * The rounded width that the follow reads (`viewportWidthPx` of the panel). The test for a
   * visible playhead uses it, so the zoom and the follow agree in the edge band that the
   * rounding makes.
   */
  readonly followViewportWidthPx: number;
  /** The scrollLeft of the scroll container before the change. */
  readonly scrollLeftPx: number;
  /**
   * The drawn playhead, in percent of the source extent, as `calculatePlayheadLayout` gives it
   * to the follow, or null when no playhead is drawn.
   */
  readonly playheadPercent: number | null;
}

/** The result of `resolvePlayheadOrCentreAnchor`. */
export interface PlayheadOrCentreAnchor extends TimelineZoomAnchorPoint {
  /**
   * The playhead percent that the anchor holds, or null when it holds the centre of the
   * visible lane. After the zoom, the panel keeps that playhead in the window of the follow
   * (`clampScrollLeftToFollowWindow`).
   */
  readonly heldPlayheadPercent: number | null;
}

/**
 * The anchor of a zoom from a key or a button: the playhead when it is in the visible lane,
 * and the centre of the visible lane otherwise.
 *
 * The visible lane is the part of the viewport to the right of the sticky gutter. The test for
 * a visible playhead is `calculateFollowScrollLeft` with the inputs that the follow gives it:
 * the rounded width for the bound and for the lane width. The follow places the playhead on a
 * lane of the rounded width, which differs from the drawn lane by up to half a pixel times the
 * zoom, so a test on the bound alone would still disagree with the follow. A playhead whose
 * follow page the scroll range cancels counts as visible too, because the follow does not
 * move the view for it (`shouldWriteFollowScrollLeft`). The paused follow
 * never pages after a zoom, because a zoom does not move the playhead in seconds
 * (`calculatePausedFollow`). The playback follow does not page either, because the panel
 * keeps a held playhead in the window of the follow (`clampScrollLeftToFollowWindow`).
 *
 * The point to hold uses the fractional width. The lane width before the zoom comes from
 * `calculateContentWidthPx`, which mirrors the CSS rule of the lane, because the DOM already
 * holds the new width when the panel resolves the anchor.
 */
export function resolvePlayheadOrCentreAnchor(
  input: PlayheadOrCentreAnchorInput,
): PlayheadOrCentreAnchor {
  const fallback: PlayheadOrCentreAnchor = {
    ratio: 0,
    viewportOffsetPx: TIMELINE_GUTTER_WIDTH_PX,
    heldPlayheadPercent: null,
  };
  if (
    !Number.isFinite(input.zoom) ||
    !Number.isFinite(input.viewportWidthPx) ||
    !Number.isFinite(input.scrollLeftPx) ||
    input.viewportWidthPx <= TIMELINE_GUTTER_WIDTH_PX
  ) {
    return fallback;
  }
  const laneWidthPx =
    calculateContentWidthPx(input.zoom, input.viewportWidthPx) -
    TIMELINE_GUTTER_WIDTH_PX;
  if (laneWidthPx <= 0) {
    return fallback;
  }

  const playheadPercent = input.playheadPercent;
  // `calculateFollowScrollLeft` also returns null for inputs it cannot use, so a width that is
  // not usable must not reach it, or it would read as a visible playhead.
  if (
    playheadPercent !== null &&
    Number.isFinite(playheadPercent) &&
    Number.isFinite(input.followViewportWidthPx) &&
    input.followViewportWidthPx > TIMELINE_GUTTER_WIDTH_PX
  ) {
    // The follow computes its lane width in the panel with the same rule.
    const followLaneWidthPx = Math.max(
      0,
      calculateContentWidthPx(input.zoom, input.followViewportWidthPx) -
        TIMELINE_GUTTER_WIDTH_PX,
    );
    const followTarget = calculateFollowScrollLeft(
      playheadPercent,
      followLaneWidthPx,
      TIMELINE_GUTTER_WIDTH_PX,
      input.scrollLeftPx,
      input.followViewportWidthPx,
      PLAYHEAD_FOLLOW_LEAD_FRACTION,
    );
    // The follow keeps the view when it sees the playhead, and also when its page, clamped to
    // the scroll range as applyFollowScrollLeft clamps it, moves nothing. The second case is a
    // playhead at the end of the lane that the lane of the follow places just past the view:
    // at a width such as 1095.6 the follow never sees 100%, and at the maximum scrollLeft its
    // page is a no-op. Holding the centre there would move the view away from the end, and
    // the follow would then page back to it.
    const maxScrollLeftPx = Math.max(
      0,
      calculateContentWidthPx(input.zoom, input.viewportWidthPx) -
        input.viewportWidthPx,
    );
    const followKeepsView =
      followTarget === null ||
      !shouldWriteFollowScrollLeft(
        input.scrollLeftPx,
        Math.min(followTarget, maxScrollLeftPx),
      );
    if (followKeepsView) {
      const ratio = Math.max(0, Math.min(1, playheadPercent / 100));
      return {
        ratio,
        viewportOffsetPx:
          TIMELINE_GUTTER_WIDTH_PX + ratio * laneWidthPx - input.scrollLeftPx,
        heldPlayheadPercent: playheadPercent,
      };
    }
  }

  const centreOffset = (TIMELINE_GUTTER_WIDTH_PX + input.viewportWidthPx) / 2;
  const centreRatio =
    (input.scrollLeftPx + centreOffset - TIMELINE_GUTTER_WIDTH_PX) / laneWidthPx;
  return {
    ratio: Math.max(0, Math.min(1, centreRatio)),
    viewportOffsetPx: centreOffset,
    heldPlayheadPercent: null,
  };
}

/**
 * The margin that `clampScrollLeftToFollowWindow` keeps inside the window of the follow. The
 * panel reads scrollLeft back after it writes it, and the browser snaps the value to the
 * device pixel grid, which moves it by less than one CSS pixel. Without the margin, a value
 * on the edge of the window could fall one snap outside it.
 */
export const FOLLOW_WINDOW_MARGIN_PX = 1;

/** Inputs of `clampScrollLeftToFollowWindow`. All of them describe the view after the zoom. */
export interface FollowWindowInput {
  /** The scrollLeft that the anchor gives. */
  readonly scrollLeftPx: number;
  /** The held playhead, in percent of the source extent (`heldPlayheadPercent`). */
  readonly playheadPercent: number;
  /** The zoom factor after the change. */
  readonly zoom: number;
  /** The rounded width that the follow reads, as in `PlayheadOrCentreAnchorInput`. */
  readonly followViewportWidthPx: number;
}

/**
 * Clamps a scrollLeft into the window in which the playback follow sees the held playhead
 * after a zoom, so the follow does not page after the zoom.
 *
 * The follow places the playhead at `x = gutter + percent / 100 * W`, on a lane `W` of the
 * rounded width at the new zoom, and it sees the playhead while
 * `scrollLeft + gutter <= x <= scrollLeft + width` (`calculateFollowScrollLeft`). So the
 * window of scrollLeft is `[x - width, x - gutter]`, here with `FOLLOW_WINDOW_MARGIN_PX`
 * inside each edge. The anchor holds the drawn playhead in place, and the drawn lane differs
 * from the lane of the follow by up to half a pixel times the zoom. After a large zoom the
 * anchored scrollLeft can therefore leave the window. The clamp moves the drawn playhead by
 * no more than that difference.
 *
 * The result can be outside the scroll range, so the caller clamps it to that range after.
 * Returns the input scrollLeft when an input is not usable or the window is empty.
 */
export function clampScrollLeftToFollowWindow(input: FollowWindowInput): number {
  const { scrollLeftPx, playheadPercent, zoom, followViewportWidthPx } = input;
  if (
    !Number.isFinite(scrollLeftPx) ||
    !Number.isFinite(playheadPercent) ||
    !Number.isFinite(zoom) ||
    !Number.isFinite(followViewportWidthPx)
  ) {
    return scrollLeftPx;
  }
  // The lane of the follow, with the rule that the panel uses for the follow.
  const followLaneWidthPx = Math.max(
    0,
    calculateContentWidthPx(zoom, followViewportWidthPx) - TIMELINE_GUTTER_WIDTH_PX,
  );
  const playheadContentX =
    TIMELINE_GUTTER_WIDTH_PX + (playheadPercent / 100) * followLaneWidthPx;
  const lowest = playheadContentX - followViewportWidthPx + FOLLOW_WINDOW_MARGIN_PX;
  const highest = playheadContentX - TIMELINE_GUTTER_WIDTH_PX - FOLLOW_WINDOW_MARGIN_PX;
  if (lowest > highest) {
    return scrollLeftPx;
  }
  return Math.max(lowest, Math.min(highest, scrollLeftPx));
}

/**
 * Normalizes deltaMode and returns the multiplicative zoom factor for one wheel event.
 */
export function calculateWheelZoomFactor(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return 1;
  }
  let normalizedDeltaY = deltaY;
  if (deltaMode === 1) {
    // DOM_DELTA_LINE: 16px per line
    normalizedDeltaY = deltaY * 16;
  } else if (deltaMode === 2) {
    // DOM_DELTA_PAGE: 400px per page
    normalizedDeltaY = deltaY * 400;
  }
  const clampedDelta = Math.max(
    -MAX_WHEEL_DELTA_PER_EVENT_PX,
    Math.min(MAX_WHEEL_DELTA_PER_EVENT_PX, normalizedDeltaY),
  );
  return TIMELINE_WHEEL_ZOOM_BASE ** (-clampedDelta / 100);
}

/** Where the playhead lands, as a fraction of the visible window, after a follow scroll. */
export const PLAYHEAD_FOLLOW_LEAD_FRACTION = 0.1;

/** The distance under which a follow target counts as the scroll position already there. */
export const FOLLOW_WRITE_TOLERANCE_PX = 1;

/**
 * True when the follow must write its target scrollLeft to the scroll container.
 *
 * The mirror holds the value that the element kept, which the browser snapped to the device
 * pixel grid, and the target is not snapped. A difference under `FOLLOW_WRITE_TOLERANCE_PX`
 * is that snap, so the follow does not write again. At the end of the lane it would otherwise
 * write on every frame, because the clamped target never equals the snapped mirror.
 *
 * A target of exactly 0 is written whenever the mirror is not 0, so a snap residual at the
 * start of the lane does not stay. A real page moves far more than the tolerance: the smallest
 * page on the left moves by the lead minus the gutter, about 14px at a width of 1096, and a
 * page on the right moves by about the width minus the lead.
 */
export function shouldWriteFollowScrollLeft(
  mirrorScrollLeftPx: number,
  targetScrollLeftPx: number,
): boolean {
  return (
    (targetScrollLeftPx === 0 && mirrorScrollLeftPx !== 0) ||
    Math.abs(mirrorScrollLeftPx - targetScrollLeftPx) >= FOLLOW_WRITE_TOLERANCE_PX
  );
}

/**
 * Returns the scrollLeft that brings the playhead back into view, or null when the
 * playhead is already visible and no scroll is needed.
 *
 * `laneLeftOffsetPx` is both where the lane starts and how much of the left edge of the
 * viewport is covered by the sticky gutter, which is why it appears in both expressions:
 * - A playhead is visible only when `playheadContentX >= scrollLeftPx + laneLeftOffsetPx`
 *   and `playheadContentX <= scrollLeftPx + viewportWidthPx`.
 * - When follow scrolls, the target places the playhead at
 *   `Math.max(laneLeftOffsetPx, leadFraction * viewportWidthPx)` from the left edge of
 *   the viewport, ensuring it clears the sticky gutter even if `leadFraction * viewportWidthPx`
 *   is narrower than the gutter.
 */
export function calculateFollowScrollLeft(
  playheadPercent: number,
  laneWidthPx: number,
  laneLeftOffsetPx: number,
  scrollLeftPx: number,
  viewportWidthPx: number,
  leadFraction: number,
): number | null {
  if (
    !Number.isFinite(playheadPercent) ||
    !Number.isFinite(laneWidthPx) ||
    !Number.isFinite(laneLeftOffsetPx) ||
    !Number.isFinite(scrollLeftPx) ||
    !Number.isFinite(viewportWidthPx) ||
    !Number.isFinite(leadFraction) ||
    laneWidthPx <= 0 ||
    viewportWidthPx <= 0 ||
    leadFraction < 0 ||
    leadFraction > 1
  ) {
    return null;
  }

  const playheadContentX = laneLeftOffsetPx + (playheadPercent / 100) * laneWidthPx;
  if (
    playheadContentX >= scrollLeftPx + laneLeftOffsetPx &&
    playheadContentX <= scrollLeftPx + viewportWidthPx
  ) {
    return null;
  }

  return Math.max(
    0,
    playheadContentX - Math.max(laneLeftOffsetPx, leadFraction * viewportWidthPx),
  );
}

/** The result of `calculatePendingNavigation`. */
export interface PendingNavigation {
  /**
   * True while a seek request is pending that the pointer gesture of the timeline did not
   * send. Each seek action sets the seek target when it accepts a request (ADR 022), so a
   * frame step sets it. A seek that settles, a pause and the last frames of playback do not.
   */
  isNavigationPending: boolean;
  /**
   * The gesture target to keep recorded. It stays while the pending target is the target
   * of the gesture, and it becomes null when that target settles or a later request
   * replaces it.
   */
  nextRecordedTarget: number | null;
}

/**
 * Decides whether the pending seek target is a navigation or a position that the pointer
 * gesture of the timeline requested.
 *
 * `recordedGestureTargetSeconds` is the seek target that the last request of the gesture
 * left in the store. A pending target equal to it belongs to the gesture, so it is not a
 * navigation. The render of the exact seek at release runs after the gesture ends, so a
 * test of the active gesture cannot filter that seek, and the recorded target filters it.
 *
 * The record is cleared as soon as the pending target differs from it. A later request
 * that lands on the same value is therefore a navigation.
 */
export function calculatePendingNavigation(
  seekTargetSeconds: number | null,
  recordedGestureTargetSeconds: number | null,
): PendingNavigation {
  const isGestureTarget =
    seekTargetSeconds !== null && seekTargetSeconds === recordedGestureTargetSeconds;
  return {
    isNavigationPending: seekTargetSeconds !== null && !isGestureTarget,
    nextRecordedTarget: isGestureTarget ? recordedGestureTargetSeconds : null,
  };
}

/** Inputs of `calculatePausedFollow`. */
export interface PausedFollowInput {
  /** The displayed playhead position, in percent of the source extent. */
  playheadPercent: number;
  /** The displayed playhead position, in seconds from the start of the source. */
  elapsedSeconds: number;
  /** The displayed playhead position at the previous decision, in seconds. */
  previousElapsedSeconds: number;
  /** `isNavigationPending` of `calculatePendingNavigation`. */
  isNavigationPending: boolean;
  /** True while a pointer gesture on the timeline is active. */
  isGestureActive: boolean;
  laneWidthPx: number;
  laneLeftOffsetPx: number;
  scrollLeftPx: number;
  viewportWidthPx: number;
  /** The lead fraction of a forward move. A backward move uses `1 - leadFraction`. */
  leadFraction: number;
}

/** The result of `calculatePausedFollow`. */
export interface PausedFollowDecision {
  /**
   * True when a navigation moved the playhead. A navigation ends the suspension of the
   * follow that a pan by the user started.
   */
  isNavigation: boolean;
  /** The scrollLeft that brings the playhead into view, or null to keep the view. */
  scrollLeftPx: number | null;
}

/**
 * Decides the follow of the playhead while the source is paused.
 *
 * The view moves only when all of these are true:
 * - The displayed position changed, in seconds. A zoom or a resize changes the geometry and
 *   not the position, so the view stays where the zoom put it. A change of the source extent
 *   changes the percent of the playhead and not its position in seconds, so it is not a move
 *   either.
 * - A seek request that the pointer gesture did not send is pending. A drag must not move
 *   the view under the pointer, and a position that changes with no request, such as the
 *   settle of a seek or the last frame after a pause, is not a navigation.
 * - No pointer gesture is active.
 * - `calculateFollowScrollLeft` reports that the playhead is outside the visible window.
 *
 * The paging is the paging of playback, with one difference: a backward move puts the
 * playhead the lead fraction from the right edge, so the frames before it are in view. With
 * the forward lead, each backward step past the gutter would page again, and the whole
 * timeline would slide under the eye.
 */
export function calculatePausedFollow(input: PausedFollowInput): PausedFollowDecision {
  const hasMoved =
    Number.isFinite(input.elapsedSeconds) &&
    Number.isFinite(input.previousElapsedSeconds) &&
    input.elapsedSeconds !== input.previousElapsedSeconds;
  const isNavigation = !input.isGestureActive && input.isNavigationPending && hasMoved;
  if (!isNavigation) {
    return { isNavigation: false, scrollLeftPx: null };
  }

  const isBackward = input.elapsedSeconds < input.previousElapsedSeconds;
  return {
    isNavigation: true,
    scrollLeftPx: calculateFollowScrollLeft(
      input.playheadPercent,
      input.laneWidthPx,
      input.laneLeftOffsetPx,
      input.scrollLeftPx,
      input.viewportWidthPx,
      isBackward ? 1 - input.leadFraction : input.leadFraction,
    ),
  };
}

/** Inputs of `calculatePlaybackFollow`. */
export interface PlaybackFollowInput {
  readonly isPlaying: boolean;
  /** True while a pointer gesture on the timeline is active. */
  readonly isGestureActive: boolean;
  /** True while a pan by the user suspends the follow. */
  readonly isUserScrolled: boolean;
  /** The displayed playhead position, in percent of the source extent. */
  readonly playheadPercent: number;
  readonly laneWidthPx: number;
  readonly laneLeftOffsetPx: number;
  readonly scrollLeftPx: number;
  readonly viewportWidthPx: number;
  readonly leadFraction: number;
}

/** The result of `calculatePlaybackFollow`. */
export type PlaybackFollowDecision =
  /** No follow: playback is stopped, a drag owns the view, or the view has no width. */
  | { readonly kind: "idle" }
  /** The playhead is in view. A suspension from an earlier pan ends. */
  | { readonly kind: "visible" }
  /** The playhead is outside the view, but the user put the view where it is. */
  | { readonly kind: "suspended" }
  /** The view pages to this scrollLeft. */
  | { readonly kind: "page"; readonly scrollLeftPx: number };

/**
 * Decides the follow of the playhead during playback.
 *
 * - With playback stopped, the paused follow owns the view (`calculatePausedFollow`).
 * - While a pointer gesture is active, the drag owns the view: its edge auto-scroll moves it,
 *   and a page would move the lane under the pointer. A drag pauses playback at its first
 *   seek, but a play key can start playback again before the next sample pauses it.
 * - A playhead in view ends a suspension from an earlier pan.
 * - A playhead outside the view pages it, unless a pan by the user suspends the follow.
 */
export function calculatePlaybackFollow(
  input: PlaybackFollowInput,
): PlaybackFollowDecision {
  if (!input.isPlaying || input.isGestureActive || !(input.viewportWidthPx > 0)) {
    return { kind: "idle" };
  }
  const scrollLeftPx = calculateFollowScrollLeft(
    input.playheadPercent,
    input.laneWidthPx,
    input.laneLeftOffsetPx,
    input.scrollLeftPx,
    input.viewportWidthPx,
    input.leadFraction,
  );
  if (scrollLeftPx === null) {
    return { kind: "visible" };
  }
  if (input.isUserScrolled) {
    return { kind: "suspended" };
  }
  return { kind: "page", scrollLeftPx };
}
