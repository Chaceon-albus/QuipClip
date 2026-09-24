import { describe, expect, it } from "vitest";
import {
  SEGMENT_TOOLTIP_DELAY_MS,
  SEGMENT_TOOLTIP_SKIP_DELAY_MS,
  createSegmentTooltipController,
  type SegmentTooltipClock,
} from "./segmentTooltipController";

/** A clock whose time moves only when the test advances it. */
function createFakeClock() {
  let now = 1_000;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: SegmentTooltipClock = {
    setTimeout: (callback, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + delayMs, callback });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    now: () => now,
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = target;
  };
  return { clock, advance, pendingTimers: () => timers.size };
}

const mouse = { pointerType: "mouse", buttons: 0 };

function setup() {
  const fake = createFakeClock();
  const controller = createSegmentTooltipController(fake.clock);
  let notifications = 0;
  controller.subscribe(() => {
    notifications += 1;
  });
  return { ...fake, controller, notifications: () => notifications };
}

describe("createSegmentTooltipController", () => {
  it("starts closed", () => {
    const { controller } = setup();
    expect(controller.getState()).toStrictEqual({
      targetId: null,
      delayed: false,
      trigger: null,
      measure: 0,
    });
  });

  it("opens after the hover delay and marks the open as delayed", () => {
    const { controller, advance } = setup();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS - 1);
    expect(controller.getState().targetId).toBeNull();
    advance(1);
    expect(controller.getState()).toStrictEqual({
      targetId: "a",
      delayed: true,
      trigger: "pointer",
      measure: 0,
    });
  });

  it("does not restart the delay on a pointer move over the same segment", () => {
    const { controller, advance } = setup();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS - 100);
    controller.hover("a", mouse);
    advance(100);
    expect(controller.getState().targetId).toBe("a");
  });

  it("cancels the pending open when the pointer leaves", () => {
    const { controller, advance, pendingTimers } = setup();
    controller.hover("a", mouse);
    controller.leave("a");
    expect(pendingTimers()).toBe(0);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();
  });

  it("restarts the delay for a segment entered before the first one opened", () => {
    const { controller, advance } = setup();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS - 1);
    controller.leave("a");
    controller.hover("b", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS - 1);
    expect(controller.getState().targetId).toBeNull();
    advance(1);
    expect(controller.getState().targetId).toBe("b");
  });

  it("moves an open tooltip to another segment at once, without the entry animation", () => {
    const { controller, advance } = setup();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    controller.hover("b", mouse);
    expect(controller.getState()).toMatchObject({ targetId: "b", delayed: false });
  });

  it("skips the delay shortly after a close, and not later", () => {
    const { controller, advance } = setup();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    controller.leave("a");
    expect(controller.getState().targetId).toBeNull();
    advance(SEGMENT_TOOLTIP_SKIP_DELAY_MS - 1);
    controller.hover("b", mouse);
    expect(controller.getState()).toMatchObject({ targetId: "b", delayed: false });

    controller.leave("b");
    advance(SEGMENT_TOOLTIP_SKIP_DELAY_MS);
    controller.hover("c", mouse);
    expect(controller.getState().targetId).toBeNull();
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState()).toMatchObject({ targetId: "c", delayed: true });
  });

  it("ignores a pointer with a button held, such as a playhead scrub", () => {
    const { controller, advance } = setup();
    controller.hover("a", { pointerType: "mouse", buttons: 1 });
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();

    // A drag that passes over segments while a tooltip is open does not move it either.
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    controller.hover("b", { pointerType: "pen", buttons: 1 });
    expect(controller.getState().targetId).toBe("a");
  });

  it("ignores a touch pointer", () => {
    const { controller, advance } = setup();
    controller.hover("a", { pointerType: "touch", buttons: 0 });
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();
  });

  it("closes on a press and stays closed until the pointer leaves the segment", () => {
    const { controller, advance } = setup();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    controller.press("a");
    expect(controller.getState().targetId).toBeNull();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();

    controller.leave("a");
    advance(SEGMENT_TOOLTIP_SKIP_DELAY_MS);
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBe("a");
  });

  it("cancels a pending open on a press", () => {
    const { controller, advance } = setup();
    controller.hover("a", mouse);
    controller.press("a");
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();
  });

  it("opens at once for a keyboard focus, and not for a focus from a click", () => {
    const { controller } = setup();
    controller.focus("a", false);
    expect(controller.getState().targetId).toBeNull();
    controller.focus("a", true);
    expect(controller.getState()).toStrictEqual({
      targetId: "a",
      delayed: false,
      trigger: "focus",
      measure: 0,
    });
  });

  it("closes on blur of the segment it shows, and not on blur of another", () => {
    const { controller } = setup();
    controller.focus("a", true);
    controller.blur("b");
    expect(controller.getState().targetId).toBe("a");
    controller.blur("a");
    expect(controller.getState().targetId).toBeNull();
  });

  it("stays closed after a dismissal until the pointer leaves that segment", () => {
    const { controller, advance } = setup();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    controller.dismiss();
    expect(controller.getState().targetId).toBeNull();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();

    // Another segment is not suppressed.
    controller.hover("b", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBe("b");
  });

  it("opens again from the keyboard after a dismissal", () => {
    const { controller } = setup();
    controller.focus("a", true);
    controller.dismiss();
    controller.blur("a");
    controller.focus("b", true);
    expect(controller.getState().targetId).toBe("b");
    controller.focus("a", true);
    expect(controller.getState().targetId).toBe("a");
  });

  it("ends the suppression of a segment that is deleted, so an undo brings it back usable", () => {
    const { controller, advance } = setup();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    // A click on A suppresses it. Delete removes its button, which fires no pointerleave.
    controller.press("a");
    controller.retain(new Set(["b"]));
    // The pointer moves away, and an undo restores A.
    advance(SEGMENT_TOOLTIP_SKIP_DELAY_MS);
    controller.retain(new Set(["a", "b"]));
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBe("a");
  });

  it("keeps the suppression of a segment that still exists", () => {
    const { controller, advance } = setup();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    controller.press("a");
    controller.retain(new Set(["a", "b"]));
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();
  });

  it("closes the tooltip on a segment that no longer exists, and keeps it on one that does", () => {
    const { controller, advance } = setup();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    controller.retain(new Set(["a"]));
    expect(controller.getState().targetId).toBe("a");
    controller.retain(new Set(["b"]));
    expect(controller.getState().targetId).toBeNull();
  });

  it("cancels a pending open for a segment that no longer exists", () => {
    const { controller, advance, pendingTimers } = setup();
    controller.hover("a", mouse);
    controller.retain(new Set());
    expect(pendingTimers()).toBe(0);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();
  });

  it("cancels a pending open on a scroll of the timeline", () => {
    const { controller, advance, pendingTimers } = setup();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS - 100);
    controller.scroll();
    expect(pendingTimers()).toBe(0);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();
  });

  it("closes a pointer tooltip on a scroll, until the pointer leaves that segment", () => {
    const { controller, advance } = setup();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    controller.scroll();
    expect(controller.getState().targetId).toBeNull();
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();
    controller.leave("a");
    advance(SEGMENT_TOOLTIP_SKIP_DELAY_MS);
    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBe("a");
  });

  it("keeps a focus tooltip on a scroll and asks for a new anchor", () => {
    const { controller, notifications } = setup();
    controller.focus("a", true);
    const before = notifications();
    controller.scroll();
    controller.scroll();
    expect(controller.getState()).toStrictEqual({
      targetId: "a",
      delayed: false,
      trigger: "focus",
      measure: 2,
    });
    expect(notifications()).toBe(before + 2);
    // A new open starts the counter again.
    controller.focus("b", true);
    expect(controller.getState().measure).toBe(0);
  });

  it("does nothing on a scroll while closed", () => {
    const { controller, notifications } = setup();
    controller.scroll();
    expect(notifications()).toBe(0);
  });

  it("dismisses on a Radix close after Escape or a press outside, for either trigger", () => {
    const { controller, advance } = setup();
    controller.focus("a", true);
    controller.tooltipClosed({ explicit: true, scrolled: false });
    expect(controller.getState().targetId).toBeNull();

    controller.blur("a");
    controller.hover("b", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    // A press outside that comes with a scroll is still a dismissal.
    controller.tooltipClosed({ explicit: true, scrolled: true });
    expect(controller.getState().targetId).toBeNull();
    controller.hover("b", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();
  });

  it("dismisses a focus tooltip when another tooltip opens and nothing scrolled", () => {
    const { controller } = setup();
    controller.focus("a", true);
    controller.tooltipClosed({ explicit: false, scrolled: false });
    expect(controller.getState().targetId).toBeNull();
  });

  it("treats a Radix close after a scroll event as a scroll", () => {
    const { controller, advance } = setup();
    // A focus tooltip stays and measures its anchor again.
    controller.focus("a", true);
    controller.tooltipClosed({ explicit: false, scrolled: true });
    expect(controller.getState()).toStrictEqual({
      targetId: "a",
      delayed: false,
      trigger: "focus",
      measure: 1,
    });
    // A pointer tooltip closes, and stays closed until the pointer leaves that segment.
    controller.blur("a");
    advance(SEGMENT_TOOLTIP_SKIP_DELAY_MS);
    controller.hover("b", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    controller.tooltipClosed({ explicit: false, scrolled: true });
    expect(controller.getState().targetId).toBeNull();
    controller.hover("b", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();
  });

  it("cancels the pending open on dispose", () => {
    const { controller, advance, pendingTimers } = setup();
    controller.hover("a", mouse);
    controller.dispose();
    expect(pendingTimers()).toBe(0);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    expect(controller.getState().targetId).toBeNull();
  });

  it("notifies only on a change and keeps the state object otherwise", () => {
    const { controller, advance, notifications } = setup();
    const closed = controller.getState();
    controller.leave("a");
    controller.blur("a");
    controller.dismiss();
    expect(notifications()).toBe(0);
    expect(controller.getState()).toBe(closed);

    controller.hover("a", mouse);
    advance(SEGMENT_TOOLTIP_DELAY_MS);
    const open = controller.getState();
    controller.hover("a", mouse);
    controller.focus("a", false);
    expect(controller.getState()).toBe(open);
    expect(notifications()).toBe(1);
  });

  it("stops notifying a listener after it unsubscribes", () => {
    const { controller, advance } = setup();
    let calls = 0;
    const unsubscribe = controller.subscribe(() => {
      calls += 1;
    });
    controller.focus("a", true);
    unsubscribe();
    controller.blur("a");
    advance(0);
    expect(calls).toBe(1);
  });
});
