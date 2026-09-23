/**
 * Pure math and layout helpers for timeline zoom and pan.
 *
 * Implements mouse-wheel zooming anchored to the pointer position,
 * content width scaling, zoom clamping, and wheel delta normalization.
 */

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
 * 200 px/s makes one 24fps frame 8.33 px (200 / 24), a comfortable target, and past that
 * the frame-step keys are the better tool.
 */
export const MAX_TIMELINE_PIXELS_PER_SECOND = 200;

export const TIMELINE_WHEEL_ZOOM_BASE = 1.25;
export const MAX_WHEEL_DELTA_PER_EVENT_PX = 400;

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
 * Divides by the lane width (base - TIMELINE_GUTTER_WIDTH_PX) rather than content width
 * so that the lane reaches exactly MAX_TIMELINE_PIXELS_PER_SECOND (200 px/s, or 8.33 px
 * per 24fps frame) and MAX_TIMELINE_CONTENT_WIDTH_PX (100,000 px).
 */
export function calculateMaxZoom(
  totalDurationSeconds: number | null | undefined,
  viewportWidthPx: number,
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
      (MAX_TIMELINE_PIXELS_PER_SECOND * totalDurationSeconds) / lane,
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
