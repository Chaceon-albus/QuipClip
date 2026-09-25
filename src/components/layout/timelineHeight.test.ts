import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMELINE_HEIGHT_PX,
  MIN_TIMELINE_HEIGHT_PX,
} from "@/features/settings/timelineHeightPreference";
import { SPLITTER_KEYS } from "./keyboardShortcutController";
import {
  MIN_PREVIEW_HEIGHT_PX,
  TIMELINE_HEIGHT_LARGE_STEP_PX,
  TIMELINE_HEIGHT_STEP_PX,
  clampTimelineHeight,
  resolveTimelineHeightBounds,
  resolveTimelineSplitterDrag,
  resolveTimelineSplitterKey,
  type TimelineHeightBounds,
  type TimelineSplitterKeyPress,
} from "./timelineHeight";

/**
 * The height that the preview and the timeline share in a window of the given height: the
 * window less the 40px title bar, the 72px transport bar and the 28px status bar.
 */
function sharedHeightOfWindow(windowHeightPx: number): number {
  return windowHeightPx - 40 - 72 - 28;
}

function press(
  key: string,
  modifiers: Partial<Omit<TimelineSplitterKeyPress, "key">> = {},
): TimelineSplitterKeyPress {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...modifiers,
  };
}

const BOUNDS: TimelineHeightBounds = { minPx: 108, maxPx: 300 };

describe("resolveTimelineHeightBounds", () => {
  it("keeps the preview minimum in the smallest window", () => {
    // 640 is the minimum window height (tauri.conf.json).
    expect(resolveTimelineHeightBounds(sharedHeightOfWindow(640))).toEqual({
      minPx: MIN_TIMELINE_HEIGHT_PX,
      maxPx: 244,
    });
    expect(MIN_PREVIEW_HEIGHT_PX).toBe(256);
  });

  it("gives the default window a larger range", () => {
    expect(resolveTimelineHeightBounds(sharedHeightOfWindow(900)).maxPx).toBe(504);
  });

  it("rounds a fractional shared height down, so the preview keeps its minimum", () => {
    expect(resolveTimelineHeightBounds(500.8).maxPx).toBe(244);
  });

  it("never gives a maximum below the minimum", () => {
    expect(resolveTimelineHeightBounds(300)).toEqual({ minPx: 108, maxPx: 108 });
    expect(resolveTimelineHeightBounds(0)).toEqual({ minPx: 108, maxPx: 108 });
  });

  it("has no top before the first measurement", () => {
    expect(resolveTimelineHeightBounds(null)).toEqual({
      minPx: MIN_TIMELINE_HEIGHT_PX,
      maxPx: Number.POSITIVE_INFINITY,
    });
    expect(resolveTimelineHeightBounds(Number.NaN).maxPx).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("clampTimelineHeight", () => {
  it("keeps a height in range", () => {
    expect(clampTimelineHeight(180, BOUNDS)).toBe(180);
    expect(clampTimelineHeight(108, BOUNDS)).toBe(108);
    expect(clampTimelineHeight(300, BOUNDS)).toBe(300);
  });

  it("clamps a height to each end of the range", () => {
    expect(clampTimelineHeight(40, BOUNDS)).toBe(108);
    expect(clampTimelineHeight(900, BOUNDS)).toBe(300);
  });

  it("clamps a stored height again when the window becomes shorter", () => {
    const tall = resolveTimelineHeightBounds(sharedHeightOfWindow(1000));
    const short = resolveTimelineHeightBounds(sharedHeightOfWindow(640));
    expect(clampTimelineHeight(500, tall)).toBe(500);
    expect(clampTimelineHeight(500, short)).toBe(244);
  });

  it("rounds to a whole pixel", () => {
    expect(clampTimelineHeight(200.4, BOUNDS)).toBe(200);
    expect(clampTimelineHeight(200.6, BOUNDS)).toBe(201);
  });

  it("reads a height that is not finite as the default", () => {
    expect(clampTimelineHeight(Number.NaN, BOUNDS)).toBe(DEFAULT_TIMELINE_HEIGHT_PX);
    expect(clampTimelineHeight(Number.POSITIVE_INFINITY, BOUNDS)).toBe(
      DEFAULT_TIMELINE_HEIGHT_PX,
    );
  });

  it("keeps any height above the minimum before the first measurement", () => {
    const unmeasured = resolveTimelineHeightBounds(null);
    expect(clampTimelineHeight(2000, unmeasured)).toBe(2000);
    expect(clampTimelineHeight(10, unmeasured)).toBe(MIN_TIMELINE_HEIGHT_PX);
  });
});

describe("resolveTimelineSplitterKey", () => {
  it("steps 8px with the arrow keys: up makes the timeline taller", () => {
    expect(TIMELINE_HEIGHT_STEP_PX).toBe(8);
    expect(resolveTimelineSplitterKey(press("ArrowUp"), 180, BOUNDS)).toBe(188);
    expect(resolveTimelineSplitterKey(press("ArrowDown"), 180, BOUNDS)).toBe(172);
  });

  it("steps 40px with Shift", () => {
    expect(TIMELINE_HEIGHT_LARGE_STEP_PX).toBe(40);
    expect(
      resolveTimelineSplitterKey(press("ArrowUp", { shiftKey: true }), 180, BOUNDS),
    ).toBe(220);
    expect(
      resolveTimelineSplitterKey(press("ArrowDown", { shiftKey: true }), 180, BOUNDS),
    ).toBe(140);
  });

  it("reaches the default from the minimum in whole steps", () => {
    let height = MIN_TIMELINE_HEIGHT_PX;
    let steps = 0;
    while (height < DEFAULT_TIMELINE_HEIGHT_PX) {
      height = resolveTimelineSplitterKey(press("ArrowUp"), height, BOUNDS) ?? height;
      steps += 1;
    }
    expect(height).toBe(DEFAULT_TIMELINE_HEIGHT_PX);
    expect(steps).toBe(9);
  });

  it("clamps a step at each end of the range", () => {
    expect(resolveTimelineSplitterKey(press("ArrowUp"), 296, BOUNDS)).toBe(300);
    expect(resolveTimelineSplitterKey(press("ArrowUp"), 300, BOUNDS)).toBe(300);
    expect(resolveTimelineSplitterKey(press("ArrowDown"), 112, BOUNDS)).toBe(108);
    expect(
      resolveTimelineSplitterKey(press("ArrowDown", { shiftKey: true }), 108, BOUNDS),
    ).toBe(108);
  });

  it("goes to the minimum with Home and to the maximum with End", () => {
    expect(resolveTimelineSplitterKey(press("Home"), 180, BOUNDS)).toBe(108);
    expect(resolveTimelineSplitterKey(press("End"), 180, BOUNDS)).toBe(300);
    expect(
      resolveTimelineSplitterKey(press("Home", { shiftKey: true }), 180, BOUNDS),
    ).toBe(108);
    expect(
      resolveTimelineSplitterKey(press("End", { shiftKey: true }), 180, BOUNDS),
    ).toBe(300);
  });

  it("does nothing with End before the first measurement", () => {
    const unmeasured = resolveTimelineHeightBounds(null);
    expect(resolveTimelineSplitterKey(press("End"), 180, unmeasured)).toBeNull();
    expect(resolveTimelineSplitterKey(press("Home"), 180, unmeasured)).toBe(108);
  });

  it("leaves Ctrl, Cmd and Alt to the system and the web view", () => {
    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      for (const key of ["ArrowUp", "ArrowDown", "Home", "End"]) {
        expect(
          resolveTimelineSplitterKey(press(key, { [modifier]: true }), 180, BOUNDS),
        ).toBeNull();
      }
    }
  });

  it("does not answer the keys of the frame step or any other key", () => {
    for (const key of [
      "ArrowLeft",
      "ArrowRight",
      " ",
      "Enter",
      "PageUp",
      "i",
      "Escape",
    ]) {
      expect(resolveTimelineSplitterKey(press(key), 180, BOUNDS)).toBeNull();
    }
  });

  it("answers every key that the window keyboard layer leaves to a focused splitter", () => {
    for (const key of SPLITTER_KEYS) {
      expect(resolveTimelineSplitterKey(press(key), 180, BOUNDS)).not.toBeNull();
    }
  });
});

describe("resolveTimelineSplitterDrag", () => {
  it("follows the pointer: a move up makes the timeline taller by the same distance", () => {
    expect(resolveTimelineSplitterDrag(180, 500, 440, BOUNDS)).toBe(240);
    expect(resolveTimelineSplitterDrag(180, 500, 540, BOUNDS)).toBe(140);
    expect(resolveTimelineSplitterDrag(180, 500, 500, BOUNDS)).toBe(180);
  });

  it("clamps the drag to the range", () => {
    expect(resolveTimelineSplitterDrag(180, 500, 0, BOUNDS)).toBe(300);
    expect(resolveTimelineSplitterDrag(180, 500, 900, BOUNDS)).toBe(108);
  });

  it("rounds a fractional pointer position to a whole pixel", () => {
    expect(resolveTimelineSplitterDrag(180, 500, 489.6, BOUNDS)).toBe(190);
  });
});
