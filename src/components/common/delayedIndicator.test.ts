import { describe, expect, it } from "vitest";
import {
  SHORT_STATE_INDICATOR_DELAY_MS,
  stepDelayedIndicator,
  type DelayedIndicatorEvent,
  type DelayedIndicatorPhase,
} from "./delayedIndicator";

/**
 * Drives the rules the way the hooks do: one delay timer runs while the phase is `pending`, it
 * starts when the phase becomes `pending`, and it stops when the phase changes. Returns the
 * phase at `untilMs`, and each time at which the indicator showed.
 */
function simulate(
  inputs: readonly { readonly atMs: number; readonly active: boolean }[],
  delayMs: number,
  untilMs: number,
): { readonly phase: DelayedIndicatorPhase; readonly shownAtMs: readonly number[] } {
  let phase: DelayedIndicatorPhase = "idle";
  let timerAtMs: number | null = null;
  const shownAtMs: number[] = [];

  const apply = (event: DelayedIndicatorEvent, nowMs: number) => {
    const next = stepDelayedIndicator(phase, event);
    if (next !== phase) {
      timerAtMs = next === "pending" ? nowMs + delayMs : null;
      if (next === "visible") {
        shownAtMs.push(nowMs);
      }
    }
    phase = next;
  };
  const runTimerUntil = (nowMs: number) => {
    while (timerAtMs !== null && timerAtMs <= nowMs) {
      apply("elapsed", timerAtMs);
    }
  };

  for (const input of inputs) {
    runTimerUntil(input.atMs);
    apply(input.active ? "begin" : "end", input.atMs);
  }
  runTimerUntil(untilMs);
  return { phase, shownAtMs };
}

describe("delayedIndicator", () => {
  describe("stepDelayedIndicator", () => {
    it.each<[DelayedIndicatorPhase, DelayedIndicatorEvent, DelayedIndicatorPhase]>([
      // A start waits for the delay
      ["idle", "begin", "pending"],
      // A start while the condition holds keeps the first delay and a shown indicator
      ["pending", "begin", "pending"],
      ["visible", "begin", "visible"],
      // An end hides at once
      ["idle", "end", "idle"],
      ["pending", "end", "idle"],
      ["visible", "end", "idle"],
      // The delay shows the indicator; a stale timer changes nothing
      ["pending", "elapsed", "visible"],
      ["idle", "elapsed", "idle"],
      ["visible", "elapsed", "visible"],
    ])("goes from %s on %s to %s", (phase, event, next) => {
      expect(stepDelayedIndicator(phase, event)).toBe(next);
    });
  });

  describe("a short state such as a load", () => {
    it("waits 250 ms", () => {
      expect(SHORT_STATE_INDICATOR_DELAY_MS).toBe(250);
    });

    it("shows nothing for a state that ends before the delay", () => {
      const result = simulate(
        [
          { atMs: 0, active: true },
          { atMs: 249, active: false },
        ],
        SHORT_STATE_INDICATOR_DELAY_MS,
        1000,
      );
      expect(result.shownAtMs).toStrictEqual([]);
      expect(result.phase).toBe("idle");
    });

    it("shows at 250 ms for a longer state, and hides when it ends", () => {
      const result = simulate(
        [
          { atMs: 0, active: true },
          { atMs: 900, active: false },
        ],
        SHORT_STATE_INDICATOR_DELAY_MS,
        1000,
      );
      expect(result.shownAtMs).toStrictEqual([250]);
      expect(result.phase).toBe("idle");
    });

    it("keeps the first delay when the state is reported again", () => {
      const result = simulate(
        [
          { atMs: 0, active: true },
          { atMs: 200, active: true },
        ],
        SHORT_STATE_INDICATOR_DELAY_MS,
        1000,
      );
      expect(result.shownAtMs).toStrictEqual([250]);
      expect(result.phase).toBe("visible");
    });

    it("starts the delay again for the next state", () => {
      const result = simulate(
        [
          { atMs: 0, active: true },
          { atMs: 100, active: false },
          { atMs: 200, active: true },
        ],
        SHORT_STATE_INDICATOR_DELAY_MS,
        1000,
      );
      expect(result.shownAtMs).toStrictEqual([450]);
      expect(result.phase).toBe("visible");
    });
  });
});
