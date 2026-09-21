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
