/**
 * The hover line and the snap indicator of the timeline: the rules, and the DOM writes that
 * draw them.
 *
 * The hover line is a thin vertical line through the ruler and the track at the pointer,
 * with a small "≈ timecode" label in the ruler. It shows the time under a pointer that hovers
 * with no drag running. The time comes from a pixel position, and a pixel is a range of
 * times, so the label is marked as approximate and uses the approximate conversion. It never
 * becomes an edit position or a seek target.
 *
 * The snap indicator is a thin line through the ruler and the track at the boundary that a
 * drag snapped to, with a small diamond in the ruler (see `scrubSnap.ts`).
 *
 * Both are drawn by writes to the DOM and not by React state. The pointer moves many times a
 * second, and a render of the panel for each move would render the layers under it again.
 * The layer elements (`TimelineDragAids.tsx`) render once and stay mounted, and the writes
 * change only their `hidden` attribute, one transform or left value, and one text.
 */

/** The gap between the hover line and its label, in CSS pixels. */
export const HOVER_LABEL_GAP_PX = 4;

/** The side of the hover line at which the label sits. */
export type HoverLabelSide = "right" | "left";

/**
 * The side of the hover line for the label. The label sits to the right of the line. It moves
 * to the left when it does not fit before the right edge of the visible lane and the left
 * side has more room. A label that fits on neither side takes the side with more room.
 */
export function resolveHoverLabelSide(
  lineX: number,
  labelWidthPx: number,
  visibleLeftPx: number,
  visibleRightPx: number,
  gapPx: number = HOVER_LABEL_GAP_PX,
): HoverLabelSide {
  if (
    !Number.isFinite(lineX) ||
    !Number.isFinite(labelWidthPx) ||
    !Number.isFinite(visibleLeftPx) ||
    !Number.isFinite(visibleRightPx)
  ) {
    return "right";
  }
  const roomRight = visibleRightPx - lineX - gapPx;
  if (roomRight >= labelWidthPx) {
    return "right";
  }
  const roomLeft = lineX - visibleLeftPx - gapPx;
  return roomLeft > roomRight ? "left" : "right";
}

/**
 * Rounds a CSS pixel offset to the device pixel grid. A translation that is not snapped paints
 * a 1px line across two device pixels, with soft edges.
 */
export function snapToDevicePixel(offsetPx: number, devicePixelRatio: number): number {
  if (!Number.isFinite(offsetPx)) {
    return 0;
  }
  const ratio =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.round(offsetPx * ratio) / ratio;
}

/**
 * The offset of the hover line from the left edge of the lane, in CSS pixels, such that the
 * line lies on the device pixel grid.
 *
 * The line is translated from the left edge of the lane, and that edge can itself lie between
 * two device pixels: the scroll position and the container are fractional at 125%, 150% and
 * 175% display scaling. So the position in the window, the lane edge plus the offset, is
 * rounded to the grid first, and the lane edge is subtracted after.
 */
export function calculateHoverLineOffset(
  clientX: number,
  laneLeftPx: number,
  devicePixelRatio: number,
): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(laneLeftPx)) {
    return 0;
  }
  return snapToDevicePixel(clientX, devicePixelRatio) - laneLeftPx;
}

/** The pointer fields that the hover controller reads. */
export interface HoverPointer {
  readonly clientX: number;
  readonly pointerType: string;
  /** The buttons that are held. A pointer with a button held is in a press or a drag. */
  readonly buttons: number;
}

/** The frame scheduler of the hover controller. `requestAnimationFrame` by default. */
export interface HoverScheduler {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
}

export interface CreateTimelineHoverLineOptions {
  /** True while the line must stay hidden, such as during a drag of the playhead. */
  readonly isSuppressed: () => boolean;
  /**
   * Draws the line at a client X coordinate in the animation frame. Returns false when it
   * cannot draw, for example with no time axis. The controller then hides the line.
   */
  readonly draw: (clientX: number) => boolean;
  /** Hides the line. */
  readonly hide: () => void;
  readonly scheduler?: HoverScheduler;
}

/** The hover controller of one panel. */
export interface TimelineHoverLine {
  /** A pointer moved over the ruler lane or the track lane. */
  move(pointer: HoverPointer): void;
  /**
   * The pointer left a lane. The line hides in the next frame, and not at once: a pointer
   * that moves from the ruler lane to the track lane leaves one lane and moves over the other
   * in the same frame, and the move then cancels the hide, so the line does not flicker.
   */
  leave(): void;
  /** Hides the line and forgets the pointer, for example when a drag starts. */
  hide(): void;
  /**
   * Draws the line again at the last pointer position, when the time under it can have
   * changed with no pointer move: a scroll, a zoom, or a change of the timecode format.
   */
  refresh(): void;
  /** Cancels a scheduled frame. */
  dispose(): void;
}

const defaultScheduler: HoverScheduler = {
  request: (callback) => globalThis.requestAnimationFrame(callback),
  cancel: (handle) => globalThis.cancelAnimationFrame(handle),
};

/**
 * Creates the hover controller. It keeps the last pointer position, and it draws at most once
 * for each animation frame, however many events arrive in that frame.
 *
 * The line hides for a touch pointer, which has no hover, and for a pointer with a button
 * held, which is in a press or a drag.
 */
export function createTimelineHoverLine(
  options: CreateTimelineHoverLineOptions,
): TimelineHoverLine {
  const { isSuppressed, draw, hide } = options;
  const scheduler = options.scheduler ?? defaultScheduler;

  let pointerX: number | null = null;
  let handle: number | null = null;
  let isShown = false;

  const hideNow = (): void => {
    if (handle !== null) {
      scheduler.cancel(handle);
      handle = null;
    }
    pointerX = null;
    if (isShown) {
      isShown = false;
      hide();
    }
  };

  const frame = (): void => {
    handle = null;
    if (pointerX === null || isSuppressed()) {
      hideNow();
      return;
    }
    if (draw(pointerX)) {
      isShown = true;
    } else {
      hideNow();
    }
  };

  const schedule = (): void => {
    if (handle === null) {
      handle = scheduler.request(frame);
    }
  };

  return {
    move(pointer: HoverPointer): void {
      if (pointer.pointerType === "touch" || pointer.buttons !== 0 || isSuppressed()) {
        hideNow();
        return;
      }
      pointerX = pointer.clientX;
      schedule();
    },
    leave(): void {
      pointerX = null;
      // The frame hides the line, unless a move in the same frame gives it a pointer again.
      if (isShown) {
        schedule();
      } else if (handle !== null) {
        scheduler.cancel(handle);
        handle = null;
      }
    },
    hide(): void {
      hideNow();
    },
    refresh(): void {
      if (pointerX !== null) {
        schedule();
      }
    },
    dispose(): void {
      if (handle !== null) {
        scheduler.cancel(handle);
        handle = null;
      }
      pointerX = null;
    },
  };
}

/** The elements of the hover line. A null element is not mounted, and is skipped. */
export interface HoverLineElements {
  /** The line in the ruler lane. The label is its child. */
  readonly ruler: HTMLElement | null;
  /** The "≈ timecode" label in the ruler. */
  readonly label: HTMLElement | null;
  /** The line in the track lane. */
  readonly track: HTMLElement | null;
}

/** What `writeHoverLine` draws. */
export interface HoverLineDrawing {
  /** The offset of the line from the left edge of the lane, in CSS pixels. */
  readonly offsetPx: number;
  /** The label text. */
  readonly text: string;
  /**
   * Returns the side of the label from its rendered width. The writer measures the width only
   * when the length of the text changes, which is rare, because a timecode has a fixed width.
   */
  readonly resolveSide: (labelWidthPx: number) => HoverLabelSide;
}

/** The last measured label width, by the length of the text it was measured for. */
const measuredLabelWidths = new WeakMap<
  HTMLElement,
  { length: number; width: number }
>();

/**
 * Draws the hover line: one transform on each of the two lines, the label text and its side.
 * The two lanes share one left edge and one width (ADR 007), so one offset serves both.
 */
export function writeHoverLine(
  elements: HoverLineElements,
  drawing: HoverLineDrawing,
): void {
  const transform = `translateX(${drawing.offsetPx}px)`;
  const { ruler, label, track } = elements;
  if (label !== null) {
    if (label.textContent !== drawing.text) {
      label.textContent = drawing.text;
    }
  }
  if (ruler !== null) {
    ruler.style.transform = transform;
    ruler.hidden = false;
  }
  if (track !== null) {
    track.style.transform = transform;
    track.hidden = false;
  }
  if (label !== null) {
    // The width read comes after the writes above, so it lays out once, and only when the
    // length of the text changed. A width of 0 is not kept: the label is not rendered while
    // a segment tooltip hides the line (`TimelineDragAids.tsx`), and the next draw measures
    // it again.
    let measured = measuredLabelWidths.get(label);
    if (measured === undefined || measured.length !== drawing.text.length) {
      const width = label.offsetWidth;
      measured = { length: drawing.text.length, width };
      if (width > 0) {
        measuredLabelWidths.set(label, measured);
      }
    }
    const side = drawing.resolveSide(measured.width);
    if (label.dataset.side !== side) {
      label.dataset.side = side;
    }
  }
}

/** Hides the hover line. */
export function hideHoverLine(elements: HoverLineElements): void {
  if (elements.ruler !== null) {
    elements.ruler.hidden = true;
  }
  if (elements.track !== null) {
    elements.track.hidden = true;
  }
}

/** The elements of the snap indicator. A null element is not mounted, and is skipped. */
export interface SnapIndicatorElements {
  /** The line and the diamond in the ruler lane. */
  readonly ruler: HTMLElement | null;
  /** The line in the track lane. */
  readonly track: HTMLElement | null;
}

/**
 * Shows the snap indicator at a boundary, as a ratio from 0 to 1 of the source extent.
 *
 * The indicator moves with `left` and not with a transform, as the playhead does, so the
 * engine snaps its 1px line to the device pixel grid. The line is 1px wide, so a left edge
 * half a pixel before the boundary centres it on the boundary and on the playhead line that a
 * snapped seek draws there.
 */
export function showSnapIndicator(
  elements: SnapIndicatorElements,
  ratio: number,
): void {
  const left = `calc(${ratio * 100}% - 0.5px)`;
  for (const element of [elements.ruler, elements.track]) {
    if (element === null) {
      continue;
    }
    if (element.style.left !== left) {
      element.style.left = left;
    }
    element.hidden = false;
  }
}

/** Hides the snap indicator. */
export function hideSnapIndicator(elements: SnapIndicatorElements): void {
  if (elements.ruler !== null) {
    elements.ruler.hidden = true;
  }
  if (elements.track !== null) {
    elements.track.hidden = true;
  }
}
