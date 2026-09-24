/**
 * The open state of the one tooltip that the segment layer shares among all its segments.
 *
 * One Radix tooltip for each segment would mount a popper, a context and a set of listeners
 * for each segment. The layer instead reports pointer and focus events to this controller,
 * and one tooltip reads the segment that the controller names. The controller is a small
 * external store, so a hover renders the tooltip again and not the layer.
 *
 * The rules follow the Radix tooltip where they can:
 *
 * - A pointer that rests on a segment opens the tooltip after `SEGMENT_TOOLTIP_DELAY_MS`.
 * - While the tooltip is open, or for `SEGMENT_TOOLTIP_SKIP_DELAY_MS` after it closes, a
 *   pointer that enters another segment moves the tooltip there at once.
 * - Keyboard focus opens it at once. A focus from a click does not.
 * - A press on a segment closes it, and the tooltip stays closed until the pointer leaves
 *   that segment. A dismissal (Escape, a press outside, another tooltip) does the same.
 * - A scroll of the timeline cancels a pending open. It closes a tooltip that a pointer
 *   opened, as a dismissal does, because the content moved under the pointer. It keeps a
 *   tooltip that keyboard focus opened and asks for a new anchor, because a focus on a
 *   segment outside the viewport scrolls the timeline to it just after the focus.
 * - A touch pointer never opens it.
 * - A pointer with a button held never opens it. With a button held, the pointer is in a
 *   drag, such as a scrub of the playhead, and the segments under it are not its subject.
 *
 * The tooltip shows one part of a segment. The body shows the whole segment. An edge (the In
 * or the Out hit area, see `segmentEdges`) shows the time of that boundary only. A pointer
 * that moves between the parts of the open segment moves the tooltip at once, as a move to
 * another segment does. While an open waits for its delay, a move to another part of the same
 * segment keeps the delay and changes the part that opens. Keyboard focus opens the body. A
 * tooltip that keyboard focus opened shows the part under the pointer and keeps its trigger,
 * so the scroll rule of a focus tooltip still applies to it.
 */

import type { SegmentEdge } from "./segmentEdges";

/** The part of a segment that the tooltip shows: the body or one edge. */
export type SegmentTooltipPart = "body" | SegmentEdge;

/** The hover delay before the tooltip opens, in milliseconds. */
export const SEGMENT_TOOLTIP_DELAY_MS = 400;

/**
 * After the tooltip closes, for this long a pointer that enters a segment opens it at once,
 * in milliseconds. It is the default of the Radix tooltip provider.
 */
export const SEGMENT_TOOLTIP_SKIP_DELAY_MS = 300;

export interface SegmentTooltipState {
  /** The segment that the tooltip shows, or null while the tooltip is closed. */
  readonly targetId: string | null;
  /** The part of the segment that the tooltip shows. It is `body` while the tooltip is closed. */
  readonly part: SegmentTooltipPart;
  /** True when the tooltip opened after the hover delay. Only that open animates in. */
  readonly delayed: boolean;
  /** What opened the tooltip, or null while it is closed. */
  readonly trigger: "pointer" | "focus" | null;
  /**
   * A counter that goes up each time the tooltip must measure its anchor again while it
   * stays open on one segment, such as after a scroll of a focus tooltip.
   */
  readonly measure: number;
}

/** The part of a pointer event that the controller reads. */
export interface SegmentTooltipPointer {
  readonly pointerType: string;
  readonly buttons: number;
}

/** The timers and the clock of the controller, so a test can drive them. */
export interface SegmentTooltipClock {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
}

/**
 * The controller. Its members are function properties and not methods, so a caller can pass
 * `getState` and `subscribe` to `useSyncExternalStore` without a bound `this`.
 */
export interface SegmentTooltipController {
  readonly getState: () => SegmentTooltipState;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * A pointer entered or moved over a segment. `part` is the part under the pointer, and the
   * body when it is not given.
   */
  readonly hover: (
    segmentId: string,
    pointer: SegmentTooltipPointer,
    part?: SegmentTooltipPart,
  ) => void;
  /** The pointer left a segment. */
  readonly leave: (segmentId: string) => void;
  /** A pointer pressed a segment. */
  readonly press: (segmentId: string) => void;
  /** A segment took focus. `focusVisible` is true for a keyboard focus. */
  readonly focus: (segmentId: string, focusVisible: boolean) => void;
  /** A segment lost focus. */
  readonly blur: (segmentId: string) => void;
  /** The tooltip closed itself: Escape, a press outside it, or another tooltip. */
  readonly dismiss: () => void;
  /**
   * The timeline viewport scrolled. It cancels a pending open. It dismisses a tooltip that a
   * pointer opened, and asks a tooltip that keyboard focus opened to measure its anchor again.
   */
  readonly scroll: () => void;
  /**
   * Radix closed the tooltip itself, and reported no cause. The component tells the causes
   * apart:
   *
   * - `explicit`: Escape or a press outside came first. The tooltip is dismissed.
   * - `scrolled`: an ancestor of the anchor sent a scroll event since the last measurement,
   *   so this is the scroll close of Radix. The scroll rule applies (`scroll`), which keeps a
   *   focus tooltip.
   * - Neither: no scroll, so another tooltip opened. The tooltip is dismissed, also a focus
   *   tooltip, so that two tooltips do not show at once.
   */
  readonly tooltipClosed: (cause: {
    readonly explicit: boolean;
    readonly scrolled: boolean;
  }) => void;
  /**
   * Forgets every segment that is not in `segmentIds`: it closes the tooltip on such a
   * segment, cancels a pending open for it, and ends its suppression. The layer calls it
   * when its segments change. A removed button fires no pointerleave, so without this call
   * a deleted segment would keep its state, and an undo would bring it back suppressed or
   * with the tooltip open away from the pointer.
   */
  readonly retain: (segmentIds: ReadonlySet<string>) => void;
  /** Cancels the pending open. The controller stays usable. */
  readonly dispose: () => void;
}

const CLOSED: SegmentTooltipState = Object.freeze({
  targetId: null,
  part: "body",
  delayed: false,
  trigger: null,
  measure: 0,
});

const defaultClock: SegmentTooltipClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
  now: () => Date.now(),
};

/**
 * Creates a controller.
 *
 * @param clock The timers and the clock. The default uses the global timers.
 */
export function createSegmentTooltipController(
  clock: SegmentTooltipClock = defaultClock,
): SegmentTooltipController {
  let state: SegmentTooltipState = CLOSED;
  let pendingId: string | null = null;
  let pendingPart: SegmentTooltipPart = "body";
  let timer: unknown = null;
  // The segment that must not open the tooltip until the pointer leaves it or it loses focus.
  let suppressedId: string | null = null;
  let closedAt = Number.NEGATIVE_INFINITY;
  const listeners = new Set<() => void>();

  const setState = (next: SegmentTooltipState) => {
    if (
      next.targetId === state.targetId &&
      next.part === state.part &&
      next.delayed === state.delayed &&
      next.trigger === state.trigger &&
      next.measure === state.measure
    ) {
      return;
    }
    state = next;
    listeners.forEach((listener) => listener());
  };

  const cancelPending = () => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
    pendingId = null;
    pendingPart = "body";
  };

  const open = (
    segmentId: string,
    part: SegmentTooltipPart,
    delayed: boolean,
    trigger: "pointer" | "focus",
  ) => {
    cancelPending();
    setState({ targetId: segmentId, part, delayed, trigger, measure: 0 });
  };

  const close = () => {
    cancelPending();
    if (state.targetId !== null) {
      closedAt = clock.now();
      setState(CLOSED);
    }
  };

  const dismiss = () => {
    if (state.targetId !== null) {
      suppressedId = state.targetId;
    }
    close();
  };

  const scroll = () => {
    cancelPending();
    if (state.targetId === null) {
      return;
    }
    if (state.trigger === "focus") {
      setState({ ...state, measure: state.measure + 1 });
      return;
    }
    dismiss();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hover: (segmentId, pointer, part = "body") => {
      if (pointer.pointerType === "touch" || pointer.buttons !== 0) {
        return;
      }
      if (suppressedId === segmentId) {
        return;
      }
      if (state.targetId === segmentId) {
        if (state.part === part) {
          return;
        }
        // Keyboard focus opened the tooltip on this segment. It keeps its trigger, so a scroll
        // keeps it and measures it again, and it shows the part under the pointer.
        if (state.trigger === "focus") {
          setState({ ...state, part });
          return;
        }
      }
      // The delay counts from the entry into the segment. The open shows the part that is
      // under the pointer when the delay ends.
      if (pendingId === segmentId) {
        pendingPart = part;
        return;
      }
      if (
        state.targetId !== null ||
        clock.now() - closedAt < SEGMENT_TOOLTIP_SKIP_DELAY_MS
      ) {
        open(segmentId, part, false, "pointer");
        return;
      }
      cancelPending();
      pendingId = segmentId;
      pendingPart = part;
      timer = clock.setTimeout(() => {
        const openPart = pendingPart;
        timer = null;
        pendingId = null;
        pendingPart = "body";
        open(segmentId, openPart, true, "pointer");
      }, SEGMENT_TOOLTIP_DELAY_MS);
    },
    leave: (segmentId) => {
      if (suppressedId === segmentId) {
        suppressedId = null;
      }
      if (pendingId === segmentId) {
        cancelPending();
      }
      if (state.targetId === segmentId) {
        close();
      }
    },
    press: (segmentId) => {
      suppressedId = segmentId;
      close();
    },
    focus: (segmentId, focusVisible) => {
      if (!focusVisible) {
        return;
      }
      if (suppressedId === segmentId) {
        suppressedId = null;
      }
      open(segmentId, "body", false, "focus");
    },
    blur: (segmentId) => {
      if (suppressedId === segmentId) {
        suppressedId = null;
      }
      if (pendingId === segmentId) {
        cancelPending();
      }
      if (state.targetId === segmentId) {
        close();
      }
    },
    dismiss,
    scroll,
    tooltipClosed: ({ explicit, scrolled }) => {
      if (!explicit && scrolled) {
        scroll();
        return;
      }
      dismiss();
    },
    retain: (segmentIds) => {
      if (suppressedId !== null && !segmentIds.has(suppressedId)) {
        suppressedId = null;
      }
      if (pendingId !== null && !segmentIds.has(pendingId)) {
        cancelPending();
      }
      if (state.targetId !== null && !segmentIds.has(state.targetId)) {
        close();
      }
    },
    dispose: () => {
      cancelPending();
    },
  };
}
