import { useCallback, useEffect, useState } from "react";
import {
  stepDelayedIndicator,
  type DelayedIndicatorEvent,
  type DelayedIndicatorPhase,
} from "./delayedIndicator";

/**
 * Holds the phase of a delayed indicator and runs its delay timer (see `delayedIndicator`).
 *
 * The timer runs while the phase is `pending`, and only then. A change of the phase, or an
 * unmount, stops it.
 *
 * @param delayMs How long the condition must hold before the indicator shows.
 * @param initialPhase The phase of the first render.
 */
export function useDelayedIndicatorPhase(
  delayMs: number,
  initialPhase: DelayedIndicatorPhase = "idle",
): readonly [DelayedIndicatorPhase, (event: DelayedIndicatorEvent) => void] {
  const [phase, setPhase] = useState<DelayedIndicatorPhase>(initialPhase);
  const dispatch = useCallback((event: DelayedIndicatorEvent) => {
    setPhase((current) => stepDelayedIndicator(current, event));
  }, []);

  useEffect(() => {
    if (phase !== "pending") {
      return;
    }
    const timer = window.setTimeout(() => {
      dispatch("elapsed");
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [phase, delayMs, dispatch]);

  return [phase, dispatch];
}

/**
 * True when `active` has held for `delayMs` without a break. It turns false in the same render
 * as `active`.
 */
export function useDelayedVisibility(active: boolean, delayMs: number): boolean {
  const [phase, dispatch] = useDelayedIndicatorPhase(
    delayMs,
    stepDelayedIndicator("idle", active ? "begin" : "end"),
  );
  // The phase follows a change of `active` during the render, so an end hides the indicator
  // before the browser paints, and the timer effect sees the new phase.
  const [previousActive, setPreviousActive] = useState(active);
  if (previousActive !== active) {
    setPreviousActive(active);
    dispatch(active ? "begin" : "end");
  }
  return active && phase === "visible";
}
