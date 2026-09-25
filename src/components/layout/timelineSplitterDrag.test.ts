import { describe, expect, it } from "vitest";
import type { TimelineHeightBounds } from "./timelineHeight";
import {
  createTimelineResizeCursor,
  RESIZING_TIMELINE_ATTRIBUTE,
} from "./timelineResizeCursor";
import { createTimelineSplitterDrag } from "./timelineSplitterDrag";

const BOUNDS: TimelineHeightBounds = { minPx: 108, maxPx: 300 };

/** `PointerEvent.buttons` with the primary button, the secondary button, and no button held. */
const PRIMARY = 1;
const SECONDARY = 2;
const NONE = 0;

function setup() {
  const attributes = new Set<string>();
  const holdCursor = createTimelineResizeCursor(() => ({
    setAttribute: (name) => {
      attributes.add(name);
    },
    removeAttribute: (name) => {
      attributes.delete(name);
    },
  }));
  const drag = createTimelineSplitterDrag({ holdCursor });
  return {
    drag,
    cursorHeld: () => attributes.has(RESIZING_TIMELINE_ATTRIBUTE),
  };
}

describe("createTimelineSplitterDrag", () => {
  it("shows a draft on each move and stores the height at the release", () => {
    const { drag, cursorHeld } = setup();

    expect(drag.begin(1, 500, 180)).toBe(true);
    expect(cursorHeld()).toBe(true);
    expect(drag.activePointerId()).toBe(1);

    expect(drag.move(1, 460, PRIMARY, BOUNDS)).toEqual({
      kind: "draft",
      heightPx: 220,
    });
    expect(drag.move(1, 440, PRIMARY, BOUNDS)).toEqual({
      kind: "draft",
      heightPx: 240,
    });
    expect(drag.end(1, 430, BOUNDS)).toEqual({ kind: "commit", heightPx: 250 });

    expect(cursorHeld()).toBe(false);
    expect(drag.activePointerId()).toBeNull();
  });

  it("clamps the draft and the stored height to the range", () => {
    const { drag } = setup();
    drag.begin(1, 500, 180);
    expect(drag.move(1, 0, PRIMARY, BOUNDS)).toEqual({ kind: "draft", heightPx: 300 });
    expect(drag.end(1, 900, BOUNDS)).toEqual({ kind: "commit", heightPx: 108 });
  });

  it("stores nothing for a release at the start height", () => {
    const { drag, cursorHeld } = setup();
    drag.begin(1, 500, 180);
    expect(drag.end(1, 500, BOUNDS)).toEqual({ kind: "cancel" });
    expect(cursorHeld()).toBe(false);
  });

  it("does not begin a second drag while one runs", () => {
    const { drag } = setup();
    expect(drag.begin(1, 500, 180)).toBe(true);
    expect(drag.begin(2, 400, 180)).toBe(false);
    expect(drag.activePointerId()).toBe(1);
    expect(drag.move(2, 300, PRIMARY, BOUNDS)).toBeNull();
    expect(drag.end(2, 300, BOUNDS)).toBeNull();
    expect(drag.cancel(2)).toBeNull();
  });

  it("restores the old height on a cancel, and begins again after it", () => {
    const { drag, cursorHeld } = setup();
    drag.begin(1, 500, 180);
    drag.move(1, 440, PRIMARY, BOUNDS);

    // A window blur, Escape, a pointer cancel and a lost capture all end here.
    expect(drag.cancel()).toEqual({ kind: "cancel" });
    expect(cursorHeld()).toBe(false);
    expect(drag.activePointerId()).toBeNull();

    // The lost capture that follows the cancel finds no drag.
    expect(drag.cancel(1)).toBeNull();
    // A pointer with no button held that moves after the cancel is ignored.
    expect(drag.move(1, 300, NONE, BOUNDS)).toBeNull();

    // No drag stays active, so a new press begins one.
    expect(drag.begin(3, 500, 180)).toBe(true);
    expect(cursorHeld()).toBe(true);
  });

  it("ends a drag whose release was lost at the last height it showed", () => {
    const { drag, cursorHeld } = setup();
    drag.begin(1, 500, 180);
    drag.move(1, 440, PRIMARY, BOUNDS);

    // The pointer came back with no button held, and at another height.
    expect(drag.move(1, 350, NONE, BOUNDS)).toEqual({ kind: "commit", heightPx: 240 });
    expect(cursorHeld()).toBe(false);
    expect(drag.activePointerId()).toBeNull();
    expect(drag.end(1, 350, BOUNDS)).toBeNull();
  });

  it("ends the drag when the primary button came up while another button is held", () => {
    const { drag, cursorHeld } = setup();
    drag.begin(1, 500, 180);
    drag.move(1, 440, PRIMARY, BOUNDS);

    // The primary and the secondary button are both held: the drag goes on.
    expect(drag.move(1, 430, PRIMARY | SECONDARY, BOUNDS)).toEqual({
      kind: "draft",
      heightPx: 250,
    });
    // Only the secondary button is held: the release of the primary one was lost.
    expect(drag.move(1, 350, SECONDARY, BOUNDS)).toEqual({
      kind: "commit",
      heightPx: 250,
    });
    expect(cursorHeld()).toBe(false);
    expect(drag.activePointerId()).toBeNull();
  });

  it("stores nothing for a lost release before any move", () => {
    const { drag } = setup();
    drag.begin(1, 500, 180);
    expect(drag.move(1, 300, NONE, BOUNDS)).toEqual({ kind: "cancel" });
  });

  it("cancels only the drag of the named pointer", () => {
    const { drag } = setup();
    drag.begin(1, 500, 180);
    expect(drag.cancel(2)).toBeNull();
    expect(drag.activePointerId()).toBe(1);
    expect(drag.cancel(1)).toEqual({ kind: "cancel" });
  });

  it("ends the cursor hold on dispose, with no outcome", () => {
    const { drag, cursorHeld } = setup();
    drag.begin(1, 500, 180);
    drag.dispose();
    expect(cursorHeld()).toBe(false);
    expect(drag.activePointerId()).toBeNull();
    expect(() => drag.dispose()).not.toThrow();
  });
});
