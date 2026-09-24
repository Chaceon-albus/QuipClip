/**
 * Press and hold on a frame step button of the transport bar.
 *
 * A primary pointer press steps one frame at once. When the press lasts `STEP_HOLD_DELAY_MS`,
 * the button steps again every `STEP_HOLD_INTERVAL_MS`, about 30 times each second. This is
 * the pattern of a held arrow key: the key down steps, and after the key repeat delay each
 * repeat steps once (ADR 021). Each step is one request, so the step count stays equal to the
 * count of steps the user asked for, and the continuation rule of the ADR 019 cue, which
 * exists for that rate, keeps the sound of a held button continuous.
 *
 * The press takes the step on pointer down, so the click that the same press sends on release
 * must not step again. The rule uses the click count of the event (`MouseEvent.detail`):
 *
 * - A click with a count of 0 does not come from a pointer. Enter on a focused button, a
 *   click that assistive technology sends, and `element.click()` all report 0. It always
 *   steps once, and it never starts the repeat, which keeps the keyboard behaviour of the
 *   button as it was.
 * - A click with a count of 1 or more comes from a pointer, and its press started on the
 *   button. The press already stepped when it was a primary press without a modifier, so the
 *   click takes no step. A press that the button did not take, such as a press with a
 *   modifier, leaves the click to step once as before.
 *
 * A press that ends off the button sends no click, so its record would stay and swallow the
 * click of a later press that the button did not take. The caller therefore forgets the press
 * on every pointer down in the window, before the button sees that pointer down.
 *
 * The helper holds no DOM reference. The caller forwards the events, and it stops the repeat
 * on pointer up, pointer cancel, pointer leave and window blur, and cancels it when the button
 * becomes disabled or leaves the tree.
 */

/** The time a press must last before the repeat starts, in milliseconds. */
export const STEP_HOLD_DELAY_MS = 400;

/** The time between two repeated steps, in milliseconds: about 30 steps each second. */
export const STEP_HOLD_INTERVAL_MS = 33;

/** Injected timers, so a test drives the schedule without a real clock. */
export interface StepHoldTimers {
  setTimer: (callback: () => void, milliseconds: number) => number;
  clearTimer: (handle: number) => void;
}

export interface StepHold {
  /** A primary pointer press on the enabled button: one step now, the repeat after the delay. */
  readonly press: () => void;
  /**
   * Stops the repeat, or the wait for it. The click that ends the press still takes no step.
   * The caller calls it for pointer up and pointer cancel anywhere in the window, for pointer
   * leave on the button, and for window blur.
   */
  readonly stop: () => void;
  /**
   * A click on the button, with the click count of the event. It steps once unless the press
   * of the same click already stepped.
   */
  readonly click: (clickCount: number) => void;
  /**
   * Forgets the press, so the next click steps unless a new press takes its step first. The
   * caller calls it for every pointer down in the window, in the capture phase, which runs
   * before the pointer down of the button. It does not stop the repeat.
   */
  readonly forgetPress: () => void;
  /**
   * Stops the repeat and forgets the press: the button became disabled, or it left the tree.
   */
  readonly cancel: () => void;
  /** True while the repeat runs or waits for its delay. */
  readonly isHolding: () => boolean;
}

/** The fields of a pointer down event that decide whether the button takes the press. */
export interface StepHoldPointerDown {
  readonly button: number;
  readonly isPrimary: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  /** The contact width in CSS pixels. A mouse reports 1. */
  readonly width: number;
  /** The contact height in CSS pixels. A mouse reports 1. */
  readonly height: number;
}

/**
 * True when a pointer down starts a press: the primary button of the primary pointer, with no
 * modifier. On macOS `Ctrl` with the primary button opens the context menu and sends no click,
 * and the other modifiers keep the plain click, which steps once. So a press with a modifier
 * steps through its click only and never repeats.
 *
 * A pointer down with no contact size, 0 by 0, is not a press either. Some screen readers send
 * one before the click with a count of 0 that activates the button, and that click must take
 * the single step. A real pointer reports a size of at least 1 by 1.
 */
export function isStepHoldPress(event: StepHoldPointerDown): boolean {
  return (
    event.button === 0 &&
    event.isPrimary &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !(event.width === 0 && event.height === 0)
  );
}

const defaultTimers: StepHoldTimers = {
  setTimer: (callback: () => void, milliseconds: number): number => {
    return globalThis.setTimeout(callback, milliseconds) as unknown as number;
  },
  clearTimer: (handle: number): void => {
    globalThis.clearTimeout(handle);
  },
};

/**
 * Creates the hold state of one step button.
 *
 * @param step Performs one frame step. The button passes one `seekNominal` request.
 * @param timers The timers. Undefined uses `setTimeout`.
 */
export function createStepHold(
  step: () => void,
  timers: StepHoldTimers = defaultTimers,
): StepHold {
  let handle: number | null = null;
  // True from a press that stepped until the click of that press. A press that ends outside
  // the button sends no click, so the value can stay true until the next pointer down, which
  // clears it (forgetPress). A click with a count of 0 does not read it.
  let pressStepped = false;

  const stop = (): void => {
    if (handle !== null) {
      timers.clearTimer(handle);
      handle = null;
    }
  };

  const repeat = (): void => {
    handle = timers.setTimer(repeat, STEP_HOLD_INTERVAL_MS);
    step();
  };

  const press = (): void => {
    stop();
    pressStepped = true;
    handle = timers.setTimer(repeat, STEP_HOLD_DELAY_MS);
    step();
  };

  const click = (clickCount: number): void => {
    if (clickCount > 0 && pressStepped) {
      pressStepped = false;
      return;
    }
    step();
  };

  const forgetPress = (): void => {
    pressStepped = false;
  };

  const cancel = (): void => {
    stop();
    pressStepped = false;
  };

  return {
    press,
    stop,
    click,
    forgetPress,
    cancel,
    isHolding: () => handle !== null,
  };
}
