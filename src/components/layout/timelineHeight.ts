/**
 * Pure model of the timeline height: the range that the window allows, the clamp, the keys of
 * the splitter, and the drag.
 *
 * The shell is a column: the title bar, the preview, the transport bar, the timeline area and
 * the status bar. Only the preview and the timeline area change height. The preview takes the
 * height that the timeline area leaves, and it must keep `MIN_PREVIEW_HEIGHT_PX`. So the
 * largest timeline height is the height that the two share, less that minimum. `TimelineArea`
 * measures the shared height, so the heights of the title bar, the transport bar and the
 * status bar are not repeated here.
 *
 * The module has no React and no DOM dependency, so the tests need no document.
 */

import {
  DEFAULT_TIMELINE_HEIGHT_PX,
  MIN_TIMELINE_HEIGHT_PX,
} from "@/features/settings/timelineHeightPreference";

/**
 * The smallest height that the timeline leaves to the preview, in CSS pixels.
 *
 * The preview area is this height less 56px: the padding of the preview and its timecode row.
 * At 256px the 16:9 frame is 200px tall, and the empty state, with its Open button, fits in it
 * without a scroll (about 191px). At the 200px minimum of `PreviewPane` the frame is only
 * 144px tall, and the empty state scrolls.
 *
 * The value must not be less than the `min-h-[200px]` of `PreviewPane`. If it were, the flex
 * layout would still keep the preview at its own minimum, because the timeline area can shrink
 * below its height (`TimelineArea`), but the splitter would report a height that it does not
 * show.
 */
export const MIN_PREVIEW_HEIGHT_PX = 256;

/** One step of the arrow keys, in CSS pixels. */
export const TIMELINE_HEIGHT_STEP_PX = 8;

/** One step of the arrow keys with Shift, in CSS pixels: five plain steps. */
export const TIMELINE_HEIGHT_LARGE_STEP_PX = 40;

/** The heights that the timeline area can take in the current window, in CSS pixels. */
export interface TimelineHeightBounds {
  readonly minPx: number;
  /**
   * The largest height. It is never less than `minPx`. It is infinite before the first
   * measurement of the window.
   */
  readonly maxPx: number;
}

/**
 * Returns the range of the timeline height.
 *
 * @param sharedHeightPx The height that the preview and the timeline area share: the sum of
 *   their two heights. Null before the first measurement.
 */
export function resolveTimelineHeightBounds(
  sharedHeightPx: number | null,
): TimelineHeightBounds {
  if (sharedHeightPx === null || !Number.isFinite(sharedHeightPx)) {
    return { minPx: MIN_TIMELINE_HEIGHT_PX, maxPx: Number.POSITIVE_INFINITY };
  }
  const maxPx = Math.floor(sharedHeightPx - MIN_PREVIEW_HEIGHT_PX);
  return {
    minPx: MIN_TIMELINE_HEIGHT_PX,
    maxPx: Math.max(MIN_TIMELINE_HEIGHT_PX, maxPx),
  };
}

/**
 * Clamps a height to the range, and rounds it to a whole pixel. A height that is not finite
 * reads as the default.
 */
export function clampTimelineHeight(
  heightPx: number,
  bounds: TimelineHeightBounds,
): number {
  const height = Number.isFinite(heightPx)
    ? Math.round(heightPx)
    : DEFAULT_TIMELINE_HEIGHT_PX;
  return Math.min(bounds.maxPx, Math.max(bounds.minPx, height));
}

/** The part of a key press that the splitter reads. A `KeyboardEvent` has it. */
export interface TimelineSplitterKeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/**
 * Returns the height after one key press on the splitter, or null when the splitter does not
 * answer that key press.
 *
 * `ArrowUp` moves the splitter up, so the timeline becomes taller. `ArrowDown` makes it shorter.
 * Each step is `TIMELINE_HEIGHT_STEP_PX`, or `TIMELINE_HEIGHT_LARGE_STEP_PX` with Shift. `Home`
 * gives the smallest height and `End` the largest, with or without Shift. `Ctrl`, `Cmd` and
 * `Alt` keep the key press for the system and the web view.
 *
 * These are the keys of `SPLITTER_KEYS` (`keyboardShortcutController.ts`), which the window
 * keyboard layer leaves to a focused splitter. `ArrowLeft` and `ArrowRight` are not among
 * them: a horizontal splitter moves up and down, so they keep the frame step (ADR 021).
 *
 * The result is clamped to the range, so a step at an end of the range returns the same height.
 * Before the first measurement the range has no top, and `End` then does nothing.
 *
 * @param currentPx The height on screen, which is already clamped.
 */
export function resolveTimelineSplitterKey(
  press: TimelineSplitterKeyPress,
  currentPx: number,
  bounds: TimelineHeightBounds,
): number | null {
  if (press.ctrlKey || press.metaKey || press.altKey) {
    return null;
  }
  const step = press.shiftKey ? TIMELINE_HEIGHT_LARGE_STEP_PX : TIMELINE_HEIGHT_STEP_PX;
  switch (press.key) {
    case "ArrowUp":
      return clampTimelineHeight(currentPx + step, bounds);
    case "ArrowDown":
      return clampTimelineHeight(currentPx - step, bounds);
    case "Home":
      return bounds.minPx;
    case "End":
      return Number.isFinite(bounds.maxPx) ? bounds.maxPx : null;
    default:
      return null;
  }
}

/**
 * Returns the height during a drag of the splitter. The splitter follows the pointer, so a move
 * up makes the timeline taller by the same distance.
 *
 * @param startHeightPx The height on screen when the drag started.
 * @param startClientY The vertical pointer position when the drag started.
 * @param clientY The vertical pointer position now.
 */
export function resolveTimelineSplitterDrag(
  startHeightPx: number,
  startClientY: number,
  clientY: number,
  bounds: TimelineHeightBounds,
): number {
  return clampTimelineHeight(startHeightPx + (startClientY - clientY), bounds);
}
