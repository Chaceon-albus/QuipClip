/**
 * Pure timeline scrub gesture tracker (ADR 022).
 *
 * A click is one exact seek: pointer down emits an exact seek sample ("final")
 * synchronously, and release without movement emits nothing.
 *
 * A drag is an exact seek at pointer down ("final"), coalesced scrub samples
 * during the move (at most one "scrub" sample per animation frame), and an exact
 * seek at release or cancellation ("final").
 *
 * Scrub samples use fastSeek when available, so a drag must never end on a
 * keyframe.
 *
 * From the first move of a drag to the end of the gesture, the gesture holds the scrub
 * cursor (`scrubCursor.ts`), so the resize cursor shows everywhere in the window. A click
 * never moves, so it keeps the cursor of the element under the pointer.
 *
 * Pure logic without React dependencies. The DOM is reached only through the default
 * scheduler and the default cursor, and a test replaces both.
 */

import { holdScrubCursor, type HoldScrubCursor } from "./scrubCursor";

export type TimelineScrubPhase = "scrub" | "final";

export interface TimelineScrubScheduler {
  request: (cb: () => void) => number;
  cancel: (handle: number) => void;
}

export interface CreateTimelineScrubGestureOptions {
  onSample: (clientX: number, phase: TimelineScrubPhase) => void;
  /**
   * Called once each time an active gesture stops being active: after the final sample of
   * `end` or `cancel`, on `dispose`, and when the sample of `begin` throws. The panel uses it
   * to remove the aids of a drag, such as the snap indicator and the edge auto-scroll.
   */
  onFinish?: () => void;
  scheduler?: TimelineScrubScheduler;
  /**
   * Shows the scrub cursor from the first move of a drag until the gesture ends. Defaults to
   * `holdScrubCursor`, which writes the attribute on the document root.
   */
  holdCursor?: HoldScrubCursor;
}

export interface TimelineScrubGesture {
  begin(pointerId: number, clientX: number): void;
  move(pointerId: number, clientX: number): void;
  end(pointerId: number, clientX: number): void;
  cancel(pointerId?: number): void;
  dispose(): void;
  isActive(): boolean;
  /**
   * True while a gesture is active and its pointer moved `SCRUB_MOVE_THRESHOLD_PX` or more.
   * It stays true during the final sample of `end` and `cancel` after such a move, so that
   * sample can tell the release of a drag from the pointer down of a click.
   */
  isDragging(): boolean;
  /**
   * Emits one scrub sample at once at the latest pointer position while a drag is running,
   * and drops a scheduled sample. The panel calls it when the time under a pointer that does
   * not move changes: after an auto-scroll step, or when the snap modifier changes. A
   * scheduled sample would come one frame after the scroll, and for that frame the playhead
   * would lag behind the edge of the view.
   */
  sampleNow(): void;
}

/** Movement threshold in CSS pixels before pointer movement counts as a drag (ADR 022). */
export const SCRUB_MOVE_THRESHOLD_PX = 3;

const defaultScheduler: TimelineScrubScheduler = {
  request: (cb: () => void) => globalThis.requestAnimationFrame(cb),
  cancel: (handle: number) => globalThis.cancelAnimationFrame(handle),
};

export function createTimelineScrubGesture(
  options: CreateTimelineScrubGestureOptions,
): TimelineScrubGesture {
  const {
    onSample,
    onFinish,
    scheduler = defaultScheduler,
    holdCursor = holdScrubCursor,
  } = options;

  let activePointerId: number | null = null;
  let downClientX = 0;
  let latestClientX = 0;
  let scheduledHandle: number | null = null;
  let hasMoved = false;
  let releaseCursor: (() => void) | null = null;

  const cancelScheduled = (): void => {
    if (scheduledHandle !== null) {
      scheduler.cancel(scheduledHandle);
      scheduledHandle = null;
    }
  };

  /** Ends the active gesture. The caller has already cancelled a scheduled sample. */
  const finish = (): void => {
    activePointerId = null;
    hasMoved = false;
    releaseCursor?.();
    releaseCursor = null;
    onFinish?.();
  };

  return {
    begin(pointerId: number, clientX: number): void {
      if (activePointerId !== null) {
        return;
      }
      activePointerId = pointerId;
      downClientX = clientX;
      latestClientX = clientX;
      hasMoved = false;
      try {
        onSample(clientX, "final");
      } catch (err) {
        finish();
        throw err;
      }
    },

    move(pointerId: number, clientX: number): void {
      if (activePointerId === null || pointerId !== activePointerId) {
        return;
      }
      if (!hasMoved) {
        if (Math.abs(clientX - downClientX) < SCRUB_MOVE_THRESHOLD_PX) {
          return;
        }
        hasMoved = true;
        releaseCursor = holdCursor();
      }
      latestClientX = clientX;
      if (scheduledHandle === null) {
        scheduledHandle = scheduler.request(() => {
          scheduledHandle = null;
          if (activePointerId === null) {
            return;
          }
          onSample(latestClientX, "scrub");
        });
      }
    },

    end(pointerId: number, clientX: number): void {
      if (activePointerId === null || pointerId !== activePointerId) {
        return;
      }
      cancelScheduled();
      try {
        if (hasMoved) {
          onSample(clientX, "final");
        }
      } finally {
        finish();
      }
    },

    cancel(pointerId?: number): void {
      if (activePointerId === null) {
        return;
      }
      if (pointerId !== undefined && pointerId !== activePointerId) {
        return;
      }
      cancelScheduled();
      try {
        if (hasMoved) {
          onSample(latestClientX, "final");
        }
      } finally {
        finish();
      }
    },

    dispose(): void {
      cancelScheduled();
      if (activePointerId !== null) {
        finish();
      }
    },

    isActive(): boolean {
      return activePointerId !== null;
    },

    isDragging(): boolean {
      return activePointerId !== null && hasMoved;
    },

    sampleNow(): void {
      if (activePointerId === null || !hasMoved) {
        return;
      }
      cancelScheduled();
      onSample(latestClientX, "scrub");
    },
  };
}
