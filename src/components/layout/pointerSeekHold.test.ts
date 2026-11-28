import { describe, expect, it, vi } from "vitest";
import { createTimelineScrubGesture } from "@/components/timeline/timelineScrub";
import { createStepHold, type StepHoldTimers } from "@/components/transport/stepHold";
import {
  createPointerSeekHold,
  frameStepHoldKey,
  TIMELINE_GESTURE_KEY,
} from "./pointerSeekHold";

/** A scheduler that never runs its callbacks: the tests below need no scrub sample. */
const idleScheduler = { request: () => 1, cancel: () => {} };

/** Timers that never fire: the tests read the hold, not the repeat. */
const idleTimers: StepHoldTimers = { setTimer: () => 1, clearTimer: () => {} };

describe("pointerSeekHold (ADR 074)", () => {
  it("holds while one key or more holds, and notifies each change", () => {
    const hold = createPointerSeekHold();
    const listener = vi.fn();
    const unsubscribe = hold.subscribe(listener);
    expect(hold.isHeld()).toBe(false);
    hold.hold("a");
    hold.hold("a");
    hold.hold("b");
    expect(hold.isHeld()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    hold.release("a");
    // Another gesture still holds.
    expect(hold.isHeld()).toBe(true);
    hold.release("unknown");
    hold.release("b");
    expect(hold.isHeld()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    hold.hold("a");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  describe("the gesture of the timeline", () => {
    function timelineGesture() {
      const hold = createPointerSeekHold();
      const gesture = createTimelineScrubGesture({
        onSample: () => {},
        onStart: () => {
          hold.hold(TIMELINE_GESTURE_KEY);
        },
        onFinish: () => {
          hold.release(TIMELINE_GESTURE_KEY);
        },
        scheduler: idleScheduler,
        holdCursor: () => () => {},
      });
      return { hold, gesture };
    }

    it("holds from the press, before its first sample, to the release", () => {
      const hold = createPointerSeekHold();
      const heldAtSample: boolean[] = [];
      const gesture = createTimelineScrubGesture({
        onSample: () => {
          heldAtSample.push(hold.isHeld());
        },
        onStart: () => {
          hold.hold(TIMELINE_GESTURE_KEY);
        },
        onFinish: () => {
          hold.release(TIMELINE_GESTURE_KEY);
        },
        scheduler: idleScheduler,
        holdCursor: () => () => {},
      });
      gesture.begin(1, 100);
      gesture.move(1, 200);
      expect(hold.isHeld()).toBe(true);
      gesture.end(1, 200);
      // The final sample of the release still runs under the hold.
      expect(heldAtSample).toEqual([true, true]);
      expect(hold.isHeld()).toBe(false);
    });

    it("releases at a cancel: a lost capture, a blur of the window, a cancel of the follow", () => {
      const { hold, gesture } = timelineGesture();
      gesture.begin(1, 100);
      gesture.cancel(1);
      expect(hold.isHeld()).toBe(false);
      gesture.begin(2, 100);
      gesture.cancel();
      expect(hold.isHeld()).toBe(false);
    });

    it("releases at unmount, and when the sample of the press throws", () => {
      const { hold, gesture } = timelineGesture();
      gesture.begin(1, 100);
      gesture.dispose();
      expect(hold.isHeld()).toBe(false);

      const throwing = createPointerSeekHold();
      const failing = createTimelineScrubGesture({
        onSample: () => {
          throw new Error("sample");
        },
        onStart: () => {
          throwing.hold(TIMELINE_GESTURE_KEY);
        },
        onFinish: () => {
          throwing.release(TIMELINE_GESTURE_KEY);
        },
        scheduler: idleScheduler,
      });
      expect(() => failing.begin(1, 100)).toThrow("sample");
      expect(throwing.isHeld()).toBe(false);
    });

    it("keeps the hold for the release of another pointer, and for a second press", () => {
      const { hold, gesture } = timelineGesture();
      gesture.begin(1, 100);
      gesture.begin(2, 100);
      gesture.end(2, 100);
      gesture.cancel(2);
      expect(hold.isHeld()).toBe(true);
      gesture.end(1, 100);
      expect(hold.isHeld()).toBe(false);
    });
  });

  describe("a held frame step button", () => {
    function heldButton() {
      const hold = createPointerSeekHold();
      const key = frameStepHoldKey(1);
      const stepHold = createStepHold(
        () => {},
        idleTimers,
        (holding) => {
          if (holding) {
            hold.hold(key);
          } else {
            hold.release(key);
          }
        },
      );
      return { hold, stepHold };
    }

    it("holds from the press to the stop: a release, a cancel, a leave or a blur", () => {
      const { hold, stepHold } = heldButton();
      stepHold.press();
      expect(hold.isHeld()).toBe(true);
      stepHold.stop();
      expect(hold.isHeld()).toBe(false);
      // The click of the press does not hold again.
      stepHold.click(1);
      expect(hold.isHeld()).toBe(false);
    });

    it("releases when the button becomes disabled or leaves the tree", () => {
      const { hold, stepHold } = heldButton();
      stepHold.press();
      stepHold.cancel();
      expect(hold.isHeld()).toBe(false);
    });

    it("does not hold for a click from the keyboard", () => {
      const { hold, stepHold } = heldButton();
      stepHold.click(0);
      expect(hold.isHeld()).toBe(false);
    });

    it("holds each button under its own key", () => {
      const hold = createPointerSeekHold();
      hold.hold(frameStepHoldKey(-1));
      hold.hold(frameStepHoldKey(1));
      hold.release(frameStepHoldKey(1));
      expect(hold.isHeld()).toBe(true);
    });
  });
});
