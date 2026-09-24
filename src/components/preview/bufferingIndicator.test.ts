import { describe, expect, it } from "vitest";
import {
  stepDelayedIndicator,
  type DelayedIndicatorEvent,
  type DelayedIndicatorPhase,
} from "@/components/common/delayedIndicator";
import {
  BUFFERING_ELEMENT_EVENTS,
  bufferingIndicatorEvent,
  PREVIEW_BUFFERING_DELAY_MS,
  type BufferingElementEvent,
} from "./bufferingIndicator";

/**
 * Feeds element events to the spinner the way `PreviewBufferingIndicator` does, with one delay
 * timer while the phase is `pending`. Returns the phase at `untilMs`, and each time at which
 * the spinner showed.
 */
function simulate(
  events: readonly { readonly atMs: number; readonly type: BufferingElementEvent }[],
  untilMs: number,
): { readonly phase: DelayedIndicatorPhase; readonly shownAtMs: readonly number[] } {
  let phase: DelayedIndicatorPhase = "idle";
  let timerAtMs: number | null = null;
  const shownAtMs: number[] = [];

  const apply = (event: DelayedIndicatorEvent, nowMs: number) => {
    const next = stepDelayedIndicator(phase, event);
    if (next !== phase) {
      timerAtMs = next === "pending" ? nowMs + PREVIEW_BUFFERING_DELAY_MS : null;
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

  for (const event of events) {
    runTimerUntil(event.atMs);
    apply(bufferingIndicatorEvent(event.type), event.atMs);
  }
  runTimerUntil(untilMs);
  return { phase, shownAtMs };
}

describe("bufferingIndicator", () => {
  it("waits 400 ms", () => {
    expect(PREVIEW_BUFFERING_DELAY_MS).toBe(400);
  });

  it("starts on waiting and ends on every other element event", () => {
    expect(BUFFERING_ELEMENT_EVENTS).toStrictEqual([
      "waiting",
      "playing",
      "canplay",
      "seeked",
      "pause",
      "ended",
      "emptied",
    ]);
    expect(bufferingIndicatorEvent("waiting")).toBe("begin");
    for (const type of [
      "playing",
      "canplay",
      "seeked",
      "pause",
      "ended",
      "emptied",
    ] as const) {
      expect(bufferingIndicatorEvent(type)).toBe("end");
    }
  });

  it("shows nothing when data arrives within the delay", () => {
    const result = simulate(
      [
        { atMs: 0, type: "waiting" },
        { atMs: 399, type: "canplay" },
      ],
      2000,
    );
    expect(result.shownAtMs).toStrictEqual([]);
    expect(result.phase).toBe("idle");
  });

  it("shows after 400 ms of waiting, and hides at once on playing", () => {
    const result = simulate(
      [
        { atMs: 0, type: "waiting" },
        { atMs: 1000, type: "playing" },
      ],
      2000,
    );
    expect(result.shownAtMs).toStrictEqual([400]);
    expect(result.phase).toBe("idle");
  });

  it("counts the delay from the first waiting event of a stall", () => {
    const result = simulate(
      [
        { atMs: 0, type: "waiting" },
        { atMs: 300, type: "waiting" },
      ],
      2000,
    );
    expect(result.shownAtMs).toStrictEqual([400]);
    expect(result.phase).toBe("visible");
  });

  it("starts a new delay after a seeked event ends the wait", () => {
    const result = simulate(
      [
        { atMs: 0, type: "waiting" },
        { atMs: 350, type: "seeked" },
        { atMs: 360, type: "waiting" },
      ],
      2000,
    );
    expect(result.shownAtMs).toStrictEqual([760]);
  });

  it.each(["playing", "canplay", "seeked", "pause", "ended", "emptied"] as const)(
    "hides a shown spinner at once on %s",
    (type) => {
      const result = simulate(
        [
          { atMs: 0, type: "waiting" },
          { atMs: 500, type },
        ],
        2000,
      );
      expect(result.shownAtMs).toStrictEqual([400]);
      expect(result.phase).toBe("idle");
    },
  );
});
