/**
 * Pure rules for the Stop Export button of the export dialog.
 *
 * The button stops the export, and a stop cannot be undone: the encode is lost. An export
 * that has run for a long time therefore asks for a second click before it stops. A short
 * export stops on the first click, because little work is lost.
 *
 * The rules take the time as an argument and read no clock, so the tests need no timers. The
 * caller passes a monotonic time in milliseconds, such as `performance.now()`.
 *
 * The rename of the button is wording only. The stop is the cancel of ADR 016 and ADR 025.
 */

import {
  isCancelEnabled,
  isCancelOutstanding,
  type ExportCancelStateInput,
} from "./exportCancelState";

/** An export that has run for this long needs a second click to stop. */
export const STOP_CONFIRM_AFTER_MS = 30_000;

/** How long the armed button waits for the second click before it reverts. */
export const STOP_CONFIRM_WINDOW_MS = 3_000;

/**
 * A click this soon after the arming click is ignored. 500 ms is the default double-click
 * interval on Windows and on macOS, so one double-click cannot arm and stop.
 */
export const STOP_CONFIRM_MIN_DELAY_MS = 500;

/**
 * Answers whether the button is armed at `now`: the first click came less than
 * `STOP_CONFIRM_WINDOW_MS` before `now`.
 */
export function isStopArmed(armedAt: number | null, now: number): boolean {
  return armedAt !== null && now >= armedAt && now - armedAt < STOP_CONFIRM_WINDOW_MS;
}

/**
 * Gives the armed time that holds at `now`: `armedAt` while the window is open, and null after
 * it. The dialog calls it when the window becomes visible or takes the focus again. A hidden
 * or occluded window can delay its timers, so the timer alone can leave a stale confirmation
 * label.
 */
export function refreshStopArmedAt(armedAt: number | null, now: number): number | null {
  return isStopArmed(armedAt, now) ? armedAt : null;
}

/** Milliseconds until the armed button reverts. Zero when the window is over. */
export function stopArmRemainingMs(armedAt: number, now: number): number {
  return Math.max(0, armedAt + STOP_CONFIRM_WINDOW_MS - now);
}

export interface StopClickInput {
  /** The time of the click. */
  now: number;
  /**
   * The time the export started, from `trackExportRunTiming` in
   * `src/features/export/runTiming.ts`, or null when no start is known. The caller passes
   * null once the run has ended, when the timing holds an end, so an old start never decides
   * a click.
   */
  startedAt: number | null;
  /** The time of the click that armed the button, or null when it is not armed. */
  armedAt: number | null;
}

/**
 * The result of a click on an enabled Stop Export button.
 *
 * - `stop`: send the cancel request now.
 * - `arm`: do not stop. Show the confirmation label until `armedAt + STOP_CONFIRM_WINDOW_MS`.
 * - `ignore`: do nothing. The button stays armed, and its window does not restart.
 */
export type StopClickDecision =
  { kind: "stop" } | { kind: "arm"; armedAt: number } | { kind: "ignore" };

/**
 * Decides what a click on the enabled Stop Export button does.
 *
 * 1. A click on the armed button less than `STOP_CONFIRM_MIN_DELAY_MS` after the arming
 *    click is ignored. It is the second half of a double-click, not a confirmation.
 * 2. Any other click on the armed button stops.
 * 3. A click less than `STOP_CONFIRM_AFTER_MS` after the start stops.
 * 4. Any other click arms the button.
 *
 * An unknown start stops on the first click. The dialog records the start before the button
 * can be clicked, so this case does not occur. The rule does not let an unknown value block
 * the stop.
 */
export function decideStopClick({
  now,
  startedAt,
  armedAt,
}: StopClickInput): StopClickDecision {
  if (armedAt !== null && isStopArmed(armedAt, now)) {
    return now - armedAt < STOP_CONFIRM_MIN_DELAY_MS
      ? { kind: "ignore" }
      : { kind: "stop" };
  }
  if (startedAt === null || now - startedAt < STOP_CONFIRM_AFTER_MS) {
    return { kind: "stop" };
  }
  return { kind: "arm", armedAt: now };
}

export type StopButtonLabelKey =
  "export.action.stop" | "export.action.stopConfirm" | "export.status.canceling";

/**
 * How the button is drawn.
 *
 * - `destructive`: the solid destructive style of `DESTRUCTIVE_CONFIRM_CLASS`.
 * - `outline`: the outline button. A disabled button uses it, because a disabled solid
 *   destructive button is a half-transparent red block that still reads as an action.
 */
export type StopButtonAppearance = "destructive" | "outline";

export interface StopButtonView {
  labelKey: StopButtonLabelKey;
  /** Whether the button accepts a click. `isCancelEnabled` holds the rule. */
  enabled: boolean;
  /** Whether the button shows the confirmation label. Never true on a disabled button. */
  armed: boolean;
  appearance: StopButtonAppearance;
  /** A line beside the button that says why it cannot stop, or null. */
  noteKey: "export.status.stopUnavailable" | null;
}

export interface StopButtonInput extends ExportCancelStateInput {
  /** Whether the dialog holds an armed state that has not reverted. */
  armed: boolean;
}

/**
 * Presents the Stop Export button.
 *
 * An outstanding cancel shows "Stopping...". An armed, enabled button shows the confirmation
 * label. A disabled button uses the outline style. In `publishing` the button is disabled
 * (ADR 016), and the note says that the export can no longer be stopped. The note does not
 * show while a cancel is outstanding, because the progress readout already says that the stop
 * cannot prevent the output file.
 */
export function presentStopButton(input: StopButtonInput): StopButtonView {
  const enabled = isCancelEnabled(input);
  const canceling = isCancelOutstanding(input);
  const armed = enabled && input.armed;

  let labelKey: StopButtonLabelKey = "export.action.stop";
  if (canceling) {
    labelKey = "export.status.canceling";
  } else if (armed) {
    labelKey = "export.action.stopConfirm";
  }

  const noteKey =
    input.status === "publishing" && !canceling
      ? "export.status.stopUnavailable"
      : null;

  return {
    labelKey,
    enabled,
    armed,
    appearance: enabled ? "destructive" : "outline",
    noteKey,
  };
}
