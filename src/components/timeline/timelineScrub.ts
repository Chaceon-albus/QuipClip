/**
 * Pure timeline scrub gesture tracker (ADR 022).
 *
 * A click is one exact seek: pointer down emits an exact seek sample ("final")
 * synchronously, and release without movement emits nothing.
 *
 * A drag is an exact seek at pointer down ("final"), coalesced scrub samples
 * during the move (at most one "scrub" sample per animation frame), and an exact
 * seek at release ("final").
 *
 * ADR 022: the next unit makes scrub samples use fastSeek, so a click must never
 * go through the scrub phase.
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
  isActive(): boolean;
}

const defaultScheduler: TimelineScrubScheduler = {
  request: (cb: () => void) => globalThis.requestAnimationFrame(cb),
  cancel: (handle: number) => globalThis.cancelAnimationFrame(handle),
};

export function createTimelineScrubGesture(
  options: CreateTimelineScrubGestureOptions,
): TimelineScrubGesture {
  const { onSample, scheduler = defaultScheduler } = options;

  let activePointerId: number | null = null;
  let latestClientX = 0;
  let scheduledHandle: number | null = null;
  let hasMoved = false;

  return {
    begin(pointerId: number, clientX: number): void {
      if (activePointerId !== null) {
        return;
      }
      activePointerId = pointerId;
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
      hasMoved = true;
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
      activePointerId = null;
      hasMoved = false;
    },

    isActive(): boolean {
      return activePointerId !== null;
    },
  };
}
