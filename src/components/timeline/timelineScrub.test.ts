import { describe, expect, it, vi } from "vitest";
import {
  createTimelineScrubGesture,
  SCRUB_MOVE_THRESHOLD_PX,
  type TimelineScrubScheduler,
} from "./timelineScrub";

interface FakeScheduler extends TimelineScrubScheduler {
  flush: () => void;
  hasPending: () => boolean;
}

function createFakeScheduler(): FakeScheduler {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();

  return {
    request(cb: () => void): number {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    cancel(handle: number): void {
      callbacks.delete(handle);
    },
    flush(): void {
      const entries = Array.from(callbacks.entries());
      callbacks.clear();
      for (const [, cb] of entries) {
        cb();
      }
    },
    hasPending(): boolean {
      return callbacks.size > 0;
    },
  };
}

describe("timelineScrub", () => {
  it("emits a synchronous final sample on begin", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    expect(gesture.isActive()).toBe(false);

    gesture.begin(1, 100);

    expect(gesture.isActive()).toBe(true);
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledWith(100, "final");
    expect(scheduler.hasPending()).toBe(false);
  });

  it("emits exactly one sample with phase 'final' for a click (begin then end, no move)", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledWith(100, "final");

    gesture.end(1, 100);

    expect(onSample).toHaveBeenCalledTimes(1);
    expect(gesture.isActive()).toBe(false);
    expect(scheduler.hasPending()).toBe(false);
    scheduler.flush();
    expect(onSample).toHaveBeenCalledTimes(1);
  });

  it("emits 'final' at begin, coalesced 'scrub' samples during drag, and 'final' at end", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenLastCalledWith(100, "final");

    gesture.move(1, 110);
    gesture.move(1, 120);
    expect(onSample).toHaveBeenCalledTimes(1);
    scheduler.flush();
    expect(onSample).toHaveBeenCalledTimes(2);
    expect(onSample).toHaveBeenLastCalledWith(120, "scrub");

    gesture.move(1, 130);
    scheduler.flush();
    expect(onSample).toHaveBeenCalledTimes(3);
    expect(onSample).toHaveBeenLastCalledWith(130, "scrub");

    gesture.end(1, 150);
    expect(onSample).toHaveBeenCalledTimes(4);
    expect(onSample).toHaveBeenLastCalledWith(150, "final");
    expect(gesture.isActive()).toBe(false);
  });

  it("coalesces moves into one sample per scheduled frame with the latest clientX", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    onSample.mockClear();

    // Multiple moves in the same frame
    gesture.move(1, 110);
    gesture.move(1, 125);
    gesture.move(1, 140);

    // Frame not yet executed: nothing emitted yet
    expect(onSample).not.toHaveBeenCalled();
    expect(scheduler.hasPending()).toBe(true);

    // Frame runs: only the latest clientX is emitted
    scheduler.flush();
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledWith(140, "scrub");
    expect(scheduler.hasPending()).toBe(false);

    // Next move schedules a new frame
    onSample.mockClear();
    gesture.move(1, 160);
    expect(scheduler.hasPending()).toBe(true);
    scheduler.flush();
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledWith(160, "scrub");
  });

  it("ignores moves from another pointer", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    onSample.mockClear();

    gesture.move(2, 200);

    expect(scheduler.hasPending()).toBe(false);
    scheduler.flush();
    expect(onSample).not.toHaveBeenCalled();
  });

  it("ignores a second begin while active", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledWith(100, "final");

    // Second begin while first pointer is active is ignored
    gesture.begin(2, 200);
    expect(onSample).toHaveBeenCalledTimes(1);

    // Moves for original pointer still work, moves for second pointer are ignored
    gesture.move(2, 220);
    expect(scheduler.hasPending()).toBe(false);

    gesture.move(1, 120);
    expect(scheduler.hasPending()).toBe(true);
  });

  it("cancels pending frame and emits one final sample on end", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    gesture.move(1, 120);
    expect(scheduler.hasPending()).toBe(true);
    onSample.mockClear();

    gesture.end(1, 150);

    // Pending frame was cancelled
    expect(scheduler.hasPending()).toBe(false);
    expect(gesture.isActive()).toBe(false);

    // Emitted final sample with end coordinate
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledWith(150, "final");

    // Flushing scheduler does nothing further
    scheduler.flush();
    expect(onSample).toHaveBeenCalledTimes(1);
  });

  it("ignores end on pointerId mismatch", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    gesture.move(1, 120);
    onSample.mockClear();

    gesture.end(2, 200);

    // Gesture still active, frame still pending, nothing emitted
    expect(gesture.isActive()).toBe(true);
    expect(scheduler.hasPending()).toBe(true);
    expect(onSample).not.toHaveBeenCalled();
  });

  it("cancels pending frame and emits one final sample at the latest clientX on cancel after a move", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    gesture.move(1, 120);
    expect(scheduler.hasPending()).toBe(true);
    onSample.mockClear();

    gesture.cancel(1);

    expect(scheduler.hasPending()).toBe(false);
    expect(gesture.isActive()).toBe(false);
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledWith(120, "final");

    // Flushing does nothing
    scheduler.flush();
    expect(onSample).toHaveBeenCalledTimes(1);
  });

  it("emits nothing on cancel without a move", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    onSample.mockClear();

    gesture.cancel(1);

    expect(gesture.isActive()).toBe(false);
    expect(onSample).not.toHaveBeenCalled();
    expect(scheduler.hasPending()).toBe(false);
  });

  it("cancels pending frame and emits nothing on dispose even after a move", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    gesture.move(1, 120);
    expect(scheduler.hasPending()).toBe(true);
    onSample.mockClear();

    gesture.dispose();

    expect(scheduler.hasPending()).toBe(false);
    expect(gesture.isActive()).toBe(false);
    expect(onSample).not.toHaveBeenCalled();

    // Flushing does nothing
    scheduler.flush();
    expect(onSample).not.toHaveBeenCalled();
  });

  it("ignores cancel on pointerId mismatch", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    gesture.move(1, 120);
    expect(scheduler.hasPending()).toBe(true);

    gesture.cancel(2);

    expect(gesture.isActive()).toBe(true);
    expect(scheduler.hasPending()).toBe(true);
  });

  it("allows cancel without pointerId to cancel pending frame and emit final sample if moved", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    gesture.move(1, 120);
    expect(scheduler.hasPending()).toBe(true);
    onSample.mockClear();

    gesture.cancel();

    expect(scheduler.hasPending()).toBe(false);
    expect(gesture.isActive()).toBe(false);
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledWith(120, "final");
  });

  it("allows begin to work again after end and after cancel", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    // Begin then end (click)
    gesture.begin(1, 100);
    gesture.end(1, 100);
    expect(gesture.isActive()).toBe(false);

    // Begin works again after end
    gesture.begin(1, 200);
    expect(gesture.isActive()).toBe(true);
    expect(onSample).toHaveBeenLastCalledWith(200, "final");

    // Drag then end
    gesture.move(1, 210);
    gesture.end(1, 220);
    expect(gesture.isActive()).toBe(false);

    // Begin works again after drag end
    gesture.begin(2, 300);
    expect(gesture.isActive()).toBe(true);
    expect(onSample).toHaveBeenLastCalledWith(300, "final");

    // Cancel
    gesture.move(2, 310);
    gesture.cancel(2);
    expect(gesture.isActive()).toBe(false);

    // Begin works again after cancel
    gesture.begin(3, 400);
    expect(gesture.isActive()).toBe(true);
    expect(onSample).toHaveBeenLastCalledWith(400, "final");
    gesture.end(3, 400);
    expect(gesture.isActive()).toBe(false);
  });

  it("does not leave gesture active if onSample throws in begin", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn().mockImplementation(() => {
      throw new Error("begin failure");
    });
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    expect(() => gesture.begin(1, 100)).toThrow("begin failure");
    expect(gesture.isActive()).toBe(false);

    // Verify next gesture works
    onSample.mockImplementation(() => {});
    gesture.begin(1, 200);
    expect(gesture.isActive()).toBe(true);
    expect(onSample).toHaveBeenCalledWith(200, "final");
    gesture.end(1, 200);
    expect(gesture.isActive()).toBe(false);
  });

  it("does not leave gesture active if onSample throws in end", () => {
    const scheduler = createFakeScheduler();
    let shouldThrow = false;
    const onSample = vi.fn().mockImplementation(() => {
      if (shouldThrow) {
        throw new Error("end failure");
      }
    });
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    gesture.move(1, 120);
    shouldThrow = true;
    expect(() => gesture.end(1, 150)).toThrow("end failure");
    expect(gesture.isActive()).toBe(false);

    // Verify next gesture works
    shouldThrow = false;
    gesture.begin(1, 200);
    expect(gesture.isActive()).toBe(true);
    expect(onSample).toHaveBeenLastCalledWith(200, "final");
    gesture.end(1, 200);
    expect(gesture.isActive()).toBe(false);
  });

  it("does not leave gesture active if onSample throws in cancel", () => {
    const scheduler = createFakeScheduler();
    let shouldThrow = false;
    const onSample = vi.fn().mockImplementation(() => {
      if (shouldThrow) {
        throw new Error("cancel failure");
      }
    });
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    gesture.move(1, 120);
    shouldThrow = true;
    expect(() => gesture.cancel(1)).toThrow("cancel failure");
    expect(gesture.isActive()).toBe(false);

    // Verify next gesture works
    shouldThrow = false;
    gesture.begin(1, 200);
    expect(gesture.isActive()).toBe(true);
    expect(onSample).toHaveBeenLastCalledWith(200, "final");
    gesture.end(1, 200);
    expect(gesture.isActive()).toBe(false);
  });

  it("uses globalThis.requestAnimationFrame and cancelAnimationFrame in default scheduler", () => {
    const rafStub = vi.fn<(cb: () => void) => number>().mockReturnValue(777);
    const cafStub = vi.fn<(handle: number) => void>();
    vi.stubGlobal("requestAnimationFrame", rafStub);
    vi.stubGlobal("cancelAnimationFrame", cafStub);

    try {
      const onSample = vi.fn();
      const gesture = createTimelineScrubGesture({ onSample });

      gesture.begin(1, 100);
      gesture.move(1, 110);

      expect(rafStub).toHaveBeenCalledTimes(1);
      const scheduledCallback = rafStub.mock.calls[0]?.[0];
      scheduledCallback?.();
      expect(onSample).toHaveBeenCalledWith(110, "scrub");

      // Test cancelAnimationFrame on end
      gesture.move(1, 120);
      expect(rafStub).toHaveBeenCalledTimes(2);
      gesture.end(1, 130);
      expect(cafStub).toHaveBeenCalledWith(777);

      // Test cancelAnimationFrame on cancel
      gesture.begin(2, 200);
      gesture.move(2, 210);
      expect(rafStub).toHaveBeenCalledTimes(3);
      gesture.cancel(2);
      expect(cafStub).toHaveBeenCalledWith(777);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("emits nothing on move after end", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.begin(1, 100);
    gesture.move(1, 110);
    gesture.end(1, 120);
    onSample.mockClear();

    gesture.move(1, 140);

    expect(scheduler.hasPending()).toBe(false);
    scheduler.flush();
    expect(onSample).not.toHaveBeenCalled();
  });

  it("ignores move, end, cancel, and dispose when gesture is not active", () => {
    const scheduler = createFakeScheduler();
    const onSample = vi.fn();
    const gesture = createTimelineScrubGesture({ onSample, scheduler });

    gesture.move(1, 100);
    gesture.end(1, 100);
    gesture.cancel(1);
    gesture.cancel();
    gesture.dispose();

    expect(onSample).not.toHaveBeenCalled();
    expect(scheduler.hasPending()).toBe(false);
    expect(gesture.isActive()).toBe(false);
  });

  describe("isDragging", () => {
    it("is false for a click and true after the pointer crosses the threshold", () => {
      const scheduler = createFakeScheduler();
      const dragging: boolean[] = [];
      const gesture = createTimelineScrubGesture({
        onSample: () => dragging.push(gesture.isDragging()),
        scheduler,
      });

      expect(gesture.isDragging()).toBe(false);
      gesture.begin(1, 100);
      // The sample of pointer down is the seek of a click.
      expect(dragging).toEqual([false]);
      gesture.move(1, 102);
      expect(gesture.isDragging()).toBe(false);
      gesture.move(1, 110);
      expect(gesture.isDragging()).toBe(true);
      scheduler.flush();
      expect(dragging).toEqual([false, true]);
    });

    it("stays true during the final sample of a drag, and is false after it", () => {
      const scheduler = createFakeScheduler();
      const dragging: boolean[] = [];
      const gesture = createTimelineScrubGesture({
        onSample: (_clientX, phase) => {
          if (phase === "final") {
            dragging.push(gesture.isDragging());
          }
        },
        scheduler,
      });

      gesture.begin(1, 100);
      gesture.move(1, 120);
      gesture.end(1, 130);
      expect(dragging).toEqual([false, true]);
      expect(gesture.isDragging()).toBe(false);

      gesture.begin(2, 100);
      gesture.move(2, 120);
      gesture.cancel(2);
      expect(dragging).toEqual([false, true, false, true]);
      expect(gesture.isDragging()).toBe(false);
    });

    it("is false after dispose", () => {
      const gesture = createTimelineScrubGesture({
        onSample: () => {},
        scheduler: createFakeScheduler(),
      });
      gesture.begin(1, 100);
      gesture.move(1, 120);
      gesture.dispose();
      expect(gesture.isDragging()).toBe(false);
      expect(gesture.isActive()).toBe(false);
    });
  });

  describe("sampleNow", () => {
    it("emits a scrub sample at once at the latest position and drops the scheduled one", () => {
      const scheduler = createFakeScheduler();
      const onSample = vi.fn();
      const gesture = createTimelineScrubGesture({ onSample, scheduler });

      gesture.begin(1, 100);
      gesture.move(1, 120);
      expect(scheduler.hasPending()).toBe(true);
      onSample.mockClear();

      gesture.sampleNow();
      expect(onSample).toHaveBeenCalledTimes(1);
      expect(onSample).toHaveBeenCalledWith(120, "scrub");
      expect(scheduler.hasPending()).toBe(false);

      // A pointer that rests can be sampled again, for example after each scroll step.
      gesture.sampleNow();
      expect(onSample).toHaveBeenCalledTimes(2);
      expect(onSample).toHaveBeenLastCalledWith(120, "scrub");
    });

    it("does nothing before the threshold, and with no active gesture", () => {
      const scheduler = createFakeScheduler();
      const onSample = vi.fn();
      const gesture = createTimelineScrubGesture({ onSample, scheduler });

      gesture.sampleNow();
      expect(onSample).not.toHaveBeenCalled();

      gesture.begin(1, 100);
      onSample.mockClear();
      gesture.move(1, 101);
      gesture.sampleNow();
      expect(onSample).not.toHaveBeenCalled();

      gesture.move(1, 120);
      gesture.end(1, 120);
      onSample.mockClear();
      gesture.sampleNow();
      expect(onSample).not.toHaveBeenCalled();
    });
  });

  describe("onFinish", () => {
    it("is called once after the final sample of end and of cancel", () => {
      const scheduler = createFakeScheduler();
      const calls: string[] = [];
      const gesture = createTimelineScrubGesture({
        onSample: (_clientX, phase) => calls.push(phase),
        onFinish: () => calls.push(`finish:${String(gesture.isActive())}`),
        scheduler,
      });

      gesture.begin(1, 100);
      gesture.move(1, 120);
      gesture.end(1, 130);
      expect(calls).toEqual(["final", "final", "finish:false"]);

      calls.length = 0;
      gesture.begin(2, 100);
      gesture.cancel(2);
      expect(calls).toEqual(["final", "finish:false"]);

      calls.length = 0;
      gesture.begin(3, 100);
      gesture.end(3, 100);
      expect(calls).toEqual(["final", "finish:false"]);
    });

    it("is called on dispose of an active gesture only", () => {
      const onFinish = vi.fn();
      const gesture = createTimelineScrubGesture({
        onSample: () => {},
        onFinish,
        scheduler: createFakeScheduler(),
      });
      gesture.dispose();
      expect(onFinish).not.toHaveBeenCalled();
      gesture.begin(1, 100);
      gesture.dispose();
      expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it("is not called for an event that the gesture ignores", () => {
      const onFinish = vi.fn();
      const gesture = createTimelineScrubGesture({
        onSample: () => {},
        onFinish,
        scheduler: createFakeScheduler(),
      });
      gesture.end(1, 100);
      gesture.cancel();
      gesture.begin(1, 100);
      gesture.end(2, 100);
      gesture.cancel(2);
      expect(onFinish).not.toHaveBeenCalled();
    });

    it("is called when a sample throws", () => {
      let shouldThrow = true;
      const onFinish = vi.fn();
      const gesture = createTimelineScrubGesture({
        onSample: () => {
          if (shouldThrow) {
            throw new Error("sample failure");
          }
        },
        onFinish,
        scheduler: createFakeScheduler(),
      });

      expect(() => gesture.begin(1, 100)).toThrow("sample failure");
      expect(onFinish).toHaveBeenCalledTimes(1);

      shouldThrow = false;
      gesture.begin(1, 100);
      gesture.move(1, 120);
      shouldThrow = true;
      expect(() => gesture.end(1, 130)).toThrow("sample failure");
      expect(onFinish).toHaveBeenCalledTimes(2);
      expect(gesture.isActive()).toBe(false);
    });
  });

  describe("movement threshold (SCRUB_MOVE_THRESHOLD_PX)", () => {
    it("exports SCRUB_MOVE_THRESHOLD_PX as 3", () => {
      expect(SCRUB_MOVE_THRESHOLD_PX).toBe(3);
    });

    it("a 1-2 px jitter click emits exactly one 'final' sample", () => {
      const scheduler = createFakeScheduler();
      const onSample = vi.fn();
      const gesture = createTimelineScrubGesture({ onSample, scheduler });

      gesture.begin(1, 100);
      expect(onSample).toHaveBeenCalledTimes(1);
      expect(onSample).toHaveBeenCalledWith(100, "final");

      // Jitter moves under threshold (1-2 px delta)
      gesture.move(1, 101); // +1 px
      gesture.move(1, 102); // +2 px
      gesture.move(1, 99); // -1 px
      gesture.move(1, 98.5); // -1.5 px
      expect(scheduler.hasPending()).toBe(false);
      expect(onSample).toHaveBeenCalledTimes(1);

      // Release under the threshold emits nothing (pointer-down seek already happened)
      gesture.end(1, 101);
      expect(onSample).toHaveBeenCalledTimes(1);
      expect(gesture.isActive()).toBe(false);
      expect(scheduler.hasPending()).toBe(false);
    });

    it("cancel under the movement threshold emits nothing", () => {
      const scheduler = createFakeScheduler();
      const onSample = vi.fn();
      const gesture = createTimelineScrubGesture({ onSample, scheduler });

      gesture.begin(1, 100);
      expect(onSample).toHaveBeenCalledTimes(1);
      expect(onSample).toHaveBeenCalledWith(100, "final");

      gesture.move(1, 102);
      expect(scheduler.hasPending()).toBe(false);

      gesture.cancel(1);
      expect(onSample).toHaveBeenCalledTimes(1);
      expect(gesture.isActive()).toBe(false);
    });

    it("crossing the threshold starts scrub samples", () => {
      const scheduler = createFakeScheduler();
      const onSample = vi.fn();
      const gesture = createTimelineScrubGesture({ onSample, scheduler });

      gesture.begin(1, 100);
      expect(onSample).toHaveBeenCalledTimes(1);
      expect(onSample).toHaveBeenLastCalledWith(100, "final");

      // Sub-threshold move ignored
      gesture.move(1, 102);
      expect(scheduler.hasPending()).toBe(false);
      expect(onSample).toHaveBeenCalledTimes(1);

      // Exactly at threshold: |103 - 100| >= 3 px
      gesture.move(1, 103);
      expect(scheduler.hasPending()).toBe(true);

      scheduler.flush();
      expect(onSample).toHaveBeenCalledTimes(2);
      expect(onSample).toHaveBeenLastCalledWith(103, "scrub");
    });

    it("after crossing, moving back within 3 px of the start still scrubs", () => {
      const scheduler = createFakeScheduler();
      const onSample = vi.fn();
      const gesture = createTimelineScrubGesture({ onSample, scheduler });

      gesture.begin(1, 100);
      expect(onSample).toHaveBeenCalledTimes(1);

      // Cross threshold
      gesture.move(1, 104);
      expect(scheduler.hasPending()).toBe(true);
      scheduler.flush();
      expect(onSample).toHaveBeenCalledTimes(2);
      expect(onSample).toHaveBeenLastCalledWith(104, "scrub");

      // Move back within 3 px of start (e.g. 101, delta 1 px from 100)
      gesture.move(1, 101);
      expect(scheduler.hasPending()).toBe(true);
      scheduler.flush();
      expect(onSample).toHaveBeenCalledTimes(3);
      expect(onSample).toHaveBeenLastCalledWith(101, "scrub");

      // Move back to exact downClientX (100)
      gesture.move(1, 100);
      expect(scheduler.hasPending()).toBe(true);
      scheduler.flush();
      expect(onSample).toHaveBeenCalledTimes(4);
      expect(onSample).toHaveBeenLastCalledWith(100, "scrub");

      // Release emits final sample
      gesture.end(1, 100);
      expect(onSample).toHaveBeenCalledTimes(5);
      expect(onSample).toHaveBeenLastCalledWith(100, "final");
    });
  });

  describe("scrub cursor", () => {
    /** A cursor that records each hold and each release in one log. */
    function createCursorLog(): { log: string[]; holdCursor: () => () => void } {
      const log: string[] = [];
      let count = 0;
      return {
        log,
        holdCursor: () => {
          count += 1;
          const id = count;
          log.push(`hold ${id}`);
          return () => {
            log.push(`release ${id}`);
          };
        },
      };
    }

    it("holds nothing for a click, also with a jitter under the threshold", () => {
      const { log, holdCursor } = createCursorLog();
      const gesture = createTimelineScrubGesture({
        onSample: () => {},
        scheduler: createFakeScheduler(),
        holdCursor,
      });

      gesture.begin(1, 100);
      gesture.move(1, 102);
      gesture.end(1, 102);
      gesture.begin(2, 100);
      gesture.cancel(2);
      expect(log).toEqual([]);
    });

    it("holds the cursor from the first move past the threshold to the end of the drag", () => {
      const { log, holdCursor } = createCursorLog();
      const gesture = createTimelineScrubGesture({
        onSample: (_clientX, phase) => log.push(phase),
        scheduler: createFakeScheduler(),
        holdCursor,
      });

      gesture.begin(1, 100);
      expect(log).toEqual(["final"]);
      gesture.move(1, 110);
      gesture.move(1, 120);
      // One hold for the whole drag.
      expect(log).toEqual(["final", "hold 1"]);

      gesture.end(1, 130);
      // The release comes after the final sample of the drag.
      expect(log).toEqual(["final", "hold 1", "final", "release 1"]);
    });

    it("releases the cursor on cancel, on dispose and when the final sample throws", () => {
      const { log, holdCursor } = createCursorLog();
      let shouldThrow = false;
      const gesture = createTimelineScrubGesture({
        onSample: () => {
          if (shouldThrow) {
            throw new Error("sample failure");
          }
        },
        scheduler: createFakeScheduler(),
        holdCursor,
      });

      gesture.begin(1, 100);
      gesture.move(1, 120);
      gesture.cancel(1);
      expect(log).toEqual(["hold 1", "release 1"]);

      gesture.begin(2, 100);
      gesture.move(2, 120);
      gesture.dispose();
      expect(log).toEqual(["hold 1", "release 1", "hold 2", "release 2"]);

      gesture.begin(3, 100);
      gesture.move(3, 120);
      shouldThrow = true;
      expect(() => gesture.end(3, 130)).toThrow("sample failure");
      expect(log).toEqual([
        "hold 1",
        "release 1",
        "hold 2",
        "release 2",
        "hold 3",
        "release 3",
      ]);
    });

    it("releases the cursor before onFinish runs", () => {
      const { log, holdCursor } = createCursorLog();
      const gesture = createTimelineScrubGesture({
        onSample: () => {},
        onFinish: () => log.push("finish"),
        scheduler: createFakeScheduler(),
        holdCursor,
      });

      gesture.begin(1, 100);
      gesture.move(1, 120);
      gesture.end(1, 120);
      expect(log).toEqual(["hold 1", "release 1", "finish"]);
    });

    it("sets data-scrubbing on the document root with the default cursor", async () => {
      const attributes = new Map<string, string>();
      vi.stubGlobal("document", {
        documentElement: {
          setAttribute: (name: string, value: string) => attributes.set(name, value),
          removeAttribute: (name: string) => attributes.delete(name),
        },
      });

      try {
        // A fresh copy of the modules, so the holds that other tests left open on the shared
        // default cursor do not count here.
        vi.resetModules();
        const fresh = await import("./timelineScrub");
        const gesture = fresh.createTimelineScrubGesture({
          onSample: () => {},
          scheduler: createFakeScheduler(),
        });

        gesture.begin(1, 100);
        expect(attributes.has("data-scrubbing")).toBe(false);
        gesture.move(1, 120);
        expect(attributes.has("data-scrubbing")).toBe(true);
        gesture.end(1, 120);
        expect(attributes.has("data-scrubbing")).toBe(false);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
