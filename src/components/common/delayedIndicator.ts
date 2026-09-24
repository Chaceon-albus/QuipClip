/**
 * Pure timing rules for an indicator of a state that usually ends at once, such as the
 * loading chip of the preview, the buffering spinner, and the Preparing chip of the status
 * bar.
 *
 * An indicator shows only after its condition has held for its whole delay, so a condition
 * that ends sooner shows nothing and nothing flashes. It hides at once when the condition
 * ends. A new start while the condition holds keeps the first delay, so a repeated event
 * cannot hold the indicator back.
 *
 * The caller runs one delay timer while the phase is `pending`, and only then. It sends
 * `elapsed` when that timer runs, and it stops the timer when the phase changes.
 */

/**
 * How long a load of the preview, or the calibration of a source, must last before its
 * indicator shows. Most loads and calibrations end sooner, so a fast open shows no flash.
 */
export const SHORT_STATE_INDICATOR_DELAY_MS = 250;

/**
 * The phase of a delayed indicator.
 *
 * - `idle`: the condition does not hold. Nothing shows.
 * - `pending`: the condition holds, and its delay has not ended. Nothing shows yet.
 * - `visible`: the condition has held for the whole delay. The indicator shows.
 */
export type DelayedIndicatorPhase = "idle" | "pending" | "visible";

/**
 * An input of a delayed indicator.
 *
 * - `begin`: the condition starts, or it is reported again while it holds.
 * - `end`: the condition stops.
 * - `elapsed`: the delay timer ran.
 */
export type DelayedIndicatorEvent = "begin" | "end" | "elapsed";

/** The phase of a delayed indicator after an input. */
export function stepDelayedIndicator(
  phase: DelayedIndicatorPhase,
  event: DelayedIndicatorEvent,
): DelayedIndicatorPhase {
  switch (event) {
    case "begin":
      return phase === "idle" ? "pending" : phase;
    case "end":
      return "idle";
    case "elapsed":
      // A timer that runs after the condition ended, or after the indicator showed, is stale.
      return phase === "pending" ? "visible" : phase;
  }
}
