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
 * Pure logic without DOM or React dependencies.
 */

export type TimelineScrubPhase = "scrub" | "final";

export interface TimelineScrubScheduler {
  request: (cb: () => void) => number;
  cancel: (handle: number) => void;
}

export interface CreateTimelineScrubGestureOptions {
  onSample: (clientX: number, phase: TimelineScrubPhase) => void;
  scheduler?: TimelineScrubScheduler;
}

export interface TimelineScrubGesture {
  begin(pointerId: number, clientX: number): void;
  move(pointerId: number, clientX: number): void;
  end(pointerId: number, clientX: number): void;
  cancel(pointerId?: number): void;
  dispose(): void;
  isActive(): boolean;
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
  const { onSample, scheduler = defaultScheduler } = options;

  let activePointerId: number | null = null;
  let downClientX = 0;
  let latestClientX = 0;
  let scheduledHandle: number | null = null;
  let hasMoved = false;

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
        activePointerId = null;
        hasMoved = false;
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
      if (scheduledHandle !== null) {
        scheduler.cancel(scheduledHandle);
        scheduledHandle = null;
      }
      const moved = hasMoved;
      hasMoved = false;
      try {
        if (moved) {
          onSample(clientX, "final");
        }
      } finally {
        activePointerId = null;
      }
    },

    cancel(pointerId?: number): void {
      if (activePointerId === null) {
        return;
      }
      if (pointerId !== undefined && pointerId !== activePointerId) {
        return;
      }
      if (scheduledHandle !== null) {
        scheduler.cancel(scheduledHandle);
        scheduledHandle = null;
      }
      const moved = hasMoved;
      hasMoved = false;
      try {
        if (moved) {
          onSample(latestClientX, "final");
        }
      } finally {
        activePointerId = null;
      }
    },

    dispose(): void {
      if (scheduledHandle !== null) {
        scheduler.cancel(scheduledHandle);
        scheduledHandle = null;
      }
      activePointerId = null;
      hasMoved = false;
    },

    isActive(): boolean {
      return activePointerId !== null;
    },
  };
}
