/**
 * Pure drag gesture of the timeline splitter (`TimelineArea`).
 *
 * A primary press begins a drag. Each move gives a draft height, which the area shows and does
 * not store. The drag then ends in one of these ways:
 *
 * - The release stores the height under the pointer. A release at the start height stores
 *   nothing, so a click keeps a height that the window clamps.
 * - A move without the primary button means that the release went somewhere the splitter did
 *   not see. Another button can still be held. The drag ends and stores the last draft,
 *   because that is the height the user saw when the button came up. The pointer may have
 *   moved after the release, so its current position is not used.
 * - A cancel restores the height from before the drag. A pointer cancel, a lost capture, a
 *   window blur and Escape cancel. After a blur the release goes to another application, so a
 *   drag that stayed active would follow a pointer with no button held and would keep the
 *   resize cursor on the whole document. The timeline scrub ends on a blur for the same reason.
 *
 * From the press to the end of the drag, the gesture holds the resize cursor of the document
 * (`timelineResizeCursor.ts`). That attribute on <html> also tells the window keyboard layer
 * that Escape belongs to the drag (`isGestureEscape`). The hold ends by every path, also on
 * `dispose`.
 *
 * The module has no React and no DOM dependency. The cursor is injected, so the tests need no
 * document.
 */

import {
  resolveTimelineSplitterDrag,
  type TimelineHeightBounds,
} from "./timelineHeight";
import {
  holdTimelineResizeCursor,
  type HoldTimelineResizeCursor,
  type ReleaseTimelineResizeCursor,
} from "./timelineResizeCursor";

/** What the area does after one event of the drag. */
export type TimelineSplitterDragOutcome =
  /** Show this height, and do not store it. */
  | { readonly kind: "draft"; readonly heightPx: number }
  /** The drag ended. Store this height. */
  | { readonly kind: "commit"; readonly heightPx: number }
  /** The drag ended with no change. Show the height from before the drag. */
  | { readonly kind: "cancel" };

export interface TimelineSplitterDrag {
  /**
   * Begins a drag. Returns false, and does nothing, while a drag already runs.
   *
   * @param startHeightPx The height on screen at the press.
   */
  begin(pointerId: number, clientY: number, startHeightPx: number): boolean;
  /**
   * A move of a pointer. `buttons` is `PointerEvent.buttons`: a move without its primary bit
   * ends the drag. Returns null for a pointer that does not drag.
   */
  move(
    pointerId: number,
    clientY: number,
    buttons: number,
    bounds: TimelineHeightBounds,
  ): TimelineSplitterDragOutcome | null;
  /** The release of a pointer. Returns null for a pointer that does not drag. */
  end(
    pointerId: number,
    clientY: number,
    bounds: TimelineHeightBounds,
  ): TimelineSplitterDragOutcome | null;
  /**
   * Cancels the drag. With a pointer id, only the drag of that pointer. Returns null when no
   * such drag runs.
   */
  cancel(pointerId?: number): TimelineSplitterDragOutcome | null;
  /** The pointer of the running drag, or null. */
  activePointerId(): number | null;
  /** Ends a running drag with no outcome, for an unmount. */
  dispose(): void;
}

export interface CreateTimelineSplitterDragOptions {
  /** Defaults to `holdTimelineResizeCursor`, which writes the attribute on the document root. */
  readonly holdCursor?: HoldTimelineResizeCursor;
}

interface ActiveDrag {
  readonly pointerId: number;
  readonly startClientY: number;
  readonly startHeightPx: number;
  lastHeightPx: number;
  readonly releaseCursor: ReleaseTimelineResizeCursor;
}

const CANCEL: TimelineSplitterDragOutcome = { kind: "cancel" };

/** The bit of the primary button in `PointerEvent.buttons`. */
const PRIMARY_BUTTON = 1;

/** Stores the height, or cancels when the drag did not change it. */
function finish(drag: ActiveDrag, heightPx: number): TimelineSplitterDragOutcome {
  return heightPx === drag.startHeightPx ? CANCEL : { kind: "commit", heightPx };
}

export function createTimelineSplitterDrag(
  options?: CreateTimelineSplitterDragOptions,
): TimelineSplitterDrag {
  const holdCursor = options?.holdCursor ?? holdTimelineResizeCursor;
  let active: ActiveDrag | null = null;

  /** Ends the drag of this pointer, and returns it. Null when no drag of it runs. */
  function take(pointerId?: number): ActiveDrag | null {
    const drag = active;
    if (drag === null || (pointerId !== undefined && drag.pointerId !== pointerId)) {
      return null;
    }
    active = null;
    drag.releaseCursor();
    return drag;
  }

  return {
    begin(pointerId, clientY, startHeightPx) {
      if (active !== null) {
        return false;
      }
      active = {
        pointerId,
        startClientY: clientY,
        startHeightPx,
        lastHeightPx: startHeightPx,
        releaseCursor: holdCursor(),
      };
      return true;
    },
    move(pointerId, clientY, buttons, bounds) {
      const drag = active;
      if (drag === null || drag.pointerId !== pointerId) {
        return null;
      }
      // The primary button is bit 0 of `buttons`. Another button can still be held after the
      // primary one came up, so only that bit counts.
      if ((buttons & PRIMARY_BUTTON) === 0) {
        take(pointerId);
        return finish(drag, drag.lastHeightPx);
      }
      drag.lastHeightPx = resolveTimelineSplitterDrag(
        drag.startHeightPx,
        drag.startClientY,
        clientY,
        bounds,
      );
      return { kind: "draft", heightPx: drag.lastHeightPx };
    },
    end(pointerId, clientY, bounds) {
      const drag = take(pointerId);
      if (drag === null) {
        return null;
      }
      return finish(
        drag,
        resolveTimelineSplitterDrag(
          drag.startHeightPx,
          drag.startClientY,
          clientY,
          bounds,
        ),
      );
    },
    cancel(pointerId) {
      return take(pointerId) === null ? null : CANCEL;
    },
    activePointerId() {
      return active?.pointerId ?? null;
    },
    dispose() {
      take();
    },
  };
}
