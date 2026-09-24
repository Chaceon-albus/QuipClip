import { describe, expect, it, vi } from "vitest";
import {
  STEP_HOLD_DELAY_MS,
  STEP_HOLD_INTERVAL_MS,
  createStepHold,
  isStepHoldPress,
  type StepHoldTimers,
} from "./stepHold";

/** A manual clock: `advance` fires every timer that falls due, in time order. */
function createManualTimers(): StepHoldTimers & {
  advance: (milliseconds: number) => void;
  pending: () => number;
} {
  let now = 0;
  let nextId = 1;
  const armed = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimer: (callback, milliseconds) => {
      const id = nextId++;
      armed.set(id, { at: now + milliseconds, callback });
      return id;
    },
    clearTimer: (handle) => {
      armed.delete(handle);
    },
    advance: (milliseconds) => {
      const end = now + milliseconds;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, entry] of armed) {
          if (entry.at <= end && entry.at < dueAt) {
            dueId = id;
            dueAt = entry.at;
          }
        }
        if (dueId === null) {
          break;
        }
        const entry = armed.get(dueId)!;
        armed.delete(dueId);
        now = entry.at;
        entry.callback();
      }
      now = end;
    },
    pending: () => armed.size,
  };
}

function setup() {
  const timers = createManualTimers();
  const step = vi.fn();
  const hold = createStepHold(step, timers);
  return { timers, step, hold };
}

describe("createStepHold", () => {
  it("pins the delay and the rate of the repeat", () => {
    expect(STEP_HOLD_DELAY_MS).toBe(400);
    // About 30 steps each second, the rate of a held arrow key (ADR 019, ADR 021).
    expect(1000 / STEP_HOLD_INTERVAL_MS).toBeGreaterThanOrEqual(29);
    expect(1000 / STEP_HOLD_INTERVAL_MS).toBeLessThanOrEqual(31);
  });

  it("steps once at the press, and a short press adds no step on its click", () => {
    const { timers, step, hold } = setup();

    hold.press();
    expect(step).toHaveBeenCalledTimes(1);

    timers.advance(STEP_HOLD_DELAY_MS - 1);
    hold.stop();
    hold.click(1);

    expect(step).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);
  });

  it("starts the repeat after the delay, with one step for each interval", () => {
    const { timers, step, hold } = setup();

    hold.press();
    timers.advance(STEP_HOLD_DELAY_MS - 1);
    expect(step).toHaveBeenCalledTimes(1);
    expect(hold.isHolding()).toBe(true);

    timers.advance(1);
    expect(step).toHaveBeenCalledTimes(2);

    timers.advance(STEP_HOLD_INTERVAL_MS * 9);
    expect(step).toHaveBeenCalledTimes(11);

    // One second of repeat is about 30 steps.
    timers.advance(1000);
    expect(step.mock.calls.length - 11).toBeGreaterThanOrEqual(29);
    expect(step.mock.calls.length - 11).toBeLessThanOrEqual(31);
  });

  it("stops on release, and the click of that release takes no step", () => {
    const { timers, step, hold } = setup();

    hold.press();
    timers.advance(STEP_HOLD_DELAY_MS + STEP_HOLD_INTERVAL_MS * 2);
    const count = step.mock.calls.length;

    hold.stop();
    expect(hold.isHolding()).toBe(false);
    hold.click(1);
    timers.advance(1000);

    expect(step).toHaveBeenCalledTimes(count);
    expect(timers.pending()).toBe(0);
  });

  it("stops on pointer leave or blur, and a later release click still takes no step", () => {
    const { timers, step, hold } = setup();

    hold.press();
    timers.advance(STEP_HOLD_DELAY_MS);
    // The pointer leaves the button: the repeat stops, the press stays open.
    hold.stop();
    const count = step.mock.calls.length;
    timers.advance(1000);
    expect(step).toHaveBeenCalledTimes(count);

    // The pointer comes back and releases over the button, which sends the click.
    hold.click(1);
    expect(step).toHaveBeenCalledTimes(count);
  });

  it("does not start the repeat when the press ends before the delay", () => {
    const { timers, step, hold } = setup();

    hold.press();
    timers.advance(100);
    hold.stop();
    timers.advance(STEP_HOLD_DELAY_MS * 3);

    expect(step).toHaveBeenCalledTimes(1);
  });

  it("steps once for each click that does not come from a pointer, and never repeats", () => {
    const { timers, step, hold } = setup();

    // Enter on a focused button, an assistive technology click, or element.click().
    hold.click(0);
    hold.click(0);
    timers.advance(STEP_HOLD_DELAY_MS * 3);

    expect(step).toHaveBeenCalledTimes(2);
    expect(hold.isHolding()).toBe(false);
    expect(timers.pending()).toBe(0);
  });

  it("steps for a keyboard click even while a pointer press is open", () => {
    const { step, hold } = setup();

    hold.press();
    hold.click(0);

    expect(step).toHaveBeenCalledTimes(2);
  });

  it("steps once for a pointer click whose press the button did not take", () => {
    const { step, hold } = setup();

    // A press with a modifier does not step, so its click keeps the old single step.
    hold.click(1);

    expect(step).toHaveBeenCalledTimes(1);
  });

  it("gives a double click two steps", () => {
    const { timers, step, hold } = setup();

    hold.press();
    hold.stop();
    hold.click(1);
    timers.advance(50);
    hold.press();
    hold.stop();
    hold.click(2);

    expect(step).toHaveBeenCalledTimes(2);
  });

  it("does not let a press that ended outside the button drop a later keyboard step", () => {
    const { step, hold } = setup();

    // The pointer leaves and releases elsewhere, so no click arrives for this press.
    hold.press();
    hold.stop();
    hold.click(0);

    expect(step).toHaveBeenCalledTimes(2);
  });

  it("lets a modifier click step once after a press that was released off the button", () => {
    const { timers, step, hold } = setup();

    // Press, hold into the repeat, drag off the button, and release elsewhere: no click.
    hold.press();
    timers.advance(STEP_HOLD_DELAY_MS + STEP_HOLD_INTERVAL_MS);
    hold.stop();
    const count = step.mock.calls.length;

    // A Shift or Alt click on the button: the window pointer down forgets the old press, the
    // button does not take this press, and its click with a count of 1 steps once.
    hold.forgetPress();
    hold.click(1);

    expect(step).toHaveBeenCalledTimes(count + 1);
  });

  it("still takes no step for the click of a press that the button took after forgetPress", () => {
    const { step, hold } = setup();

    // The window pointer down runs first, then the pointer down of the button.
    hold.forgetPress();
    hold.press();
    hold.stop();
    hold.click(1);

    expect(step).toHaveBeenCalledTimes(1);
  });

  it("does not stop the repeat on forgetPress", () => {
    const { timers, step, hold } = setup();

    hold.press();
    hold.forgetPress();
    timers.advance(STEP_HOLD_DELAY_MS + STEP_HOLD_INTERVAL_MS);

    expect(hold.isHolding()).toBe(true);
    expect(step).toHaveBeenCalledTimes(3);
  });

  it("cancels the repeat and forgets the press when the button is disabled", () => {
    const { timers, step, hold } = setup();

    hold.press();
    timers.advance(STEP_HOLD_DELAY_MS + STEP_HOLD_INTERVAL_MS);
    const count = step.mock.calls.length;

    hold.cancel();
    timers.advance(1000);
    expect(step).toHaveBeenCalledTimes(count);
    expect(timers.pending()).toBe(0);

    // The press is forgotten, so a later pointer click steps once.
    hold.click(1);
    expect(step).toHaveBeenCalledTimes(count + 1);
  });

  it("restarts the delay on a second press and keeps one timer", () => {
    const { timers, step, hold } = setup();

    hold.press();
    timers.advance(STEP_HOLD_DELAY_MS - 50);
    hold.press();
    expect(timers.pending()).toBe(1);

    timers.advance(STEP_HOLD_DELAY_MS - 1);
    expect(step).toHaveBeenCalledTimes(2);
    timers.advance(1);
    expect(step).toHaveBeenCalledTimes(3);
  });

  it("stops the repeat when the step itself cancels the hold", () => {
    const timers = createManualTimers();
    let calls = 0;
    const hold = createStepHold(() => {
      calls++;
      if (calls === 3) {
        hold.cancel();
      }
    }, timers);

    hold.press();
    timers.advance(STEP_HOLD_DELAY_MS + STEP_HOLD_INTERVAL_MS * 10);

    expect(calls).toBe(3);
    expect(timers.pending()).toBe(0);
  });

  it("takes a press only from the primary button of the primary pointer, with no modifier", () => {
    const plain = {
      button: 0,
      isPrimary: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      width: 1,
      height: 1,
    };
    expect(isStepHoldPress(plain)).toBe(true);
    // A touch or a pen contact reports its size.
    expect(isStepHoldPress({ ...plain, width: 23, height: 23 })).toBe(true);
    // Only a size of 0 by 0 marks a synthetic pointer down. One zero side is still a contact.
    expect(isStepHoldPress({ ...plain, width: 0, height: 0 })).toBe(false);
    expect(isStepHoldPress({ ...plain, width: 0, height: 1 })).toBe(true);
    expect(isStepHoldPress({ ...plain, width: 1, height: 0 })).toBe(true);
    expect(isStepHoldPress({ ...plain, button: 1 })).toBe(false);
    expect(isStepHoldPress({ ...plain, button: 2 })).toBe(false);
    expect(isStepHoldPress({ ...plain, isPrimary: false })).toBe(false);
    expect(isStepHoldPress({ ...plain, ctrlKey: true })).toBe(false);
    expect(isStepHoldPress({ ...plain, metaKey: true })).toBe(false);
    expect(isStepHoldPress({ ...plain, altKey: true })).toBe(false);
    expect(isStepHoldPress({ ...plain, shiftKey: true })).toBe(false);
  });

  it("gives a screen reader activation one step: no press from a 0 by 0 pointer down", () => {
    const { step, hold } = setup();
    const synthetic = {
      button: 0,
      isPrimary: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      width: 0,
      height: 0,
    };

    // The caller forwards the pointer down only when it is a press, as FrameStepButton does.
    hold.forgetPress();
    if (isStepHoldPress(synthetic)) {
      hold.press();
    }
    hold.click(0);

    expect(step).toHaveBeenCalledTimes(1);
    expect(hold.isHolding()).toBe(false);
  });

  it("treats stop, forgetPress and cancel as no-ops without a press", () => {
    const { timers, step, hold } = setup();

    expect(() => {
      hold.stop();
      hold.forgetPress();
      hold.cancel();
    }).not.toThrow();
    expect(step).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });
});
