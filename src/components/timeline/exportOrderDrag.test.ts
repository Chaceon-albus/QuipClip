import { describe, expect, it } from "vitest";
import {
  createExportOrderDragSession,
  createExportOrderEscapeGuard,
  dropExportOrderDrag,
  EXPORT_ORDER_AUTO_SCROLL_MAX_FRAME_MS,
  EXPORT_ORDER_AUTO_SCROLL_MAX_SPEED_PX_PER_S,
  EXPORT_ORDER_AUTO_SCROLL_ZONE_PX,
  EXPORT_ORDER_DRAG_THRESHOLD_PX,
  exportOrderAutoScrollStep,
  exportOrderAutoScrollVelocity,
  exportOrderDragTarget,
  isExportOrderAutoScrollActive,
  moveExportOrderDrag,
  planExportOrderDragEnd,
  pressExportOrderRow,
  previewExportOrderDrag,
  type ExportOrderDrag,
  type ExportOrderListGeometry,
} from "./exportOrderDrag";

/**
 * Ten rows of 36px, in a list whose visible part starts at client Y 100 and is 180px high (five
 * rows), with 4px of padding above the first row. The content is 368px high.
 */
const geometry = (
  overrides: Partial<ExportOrderListGeometry> = {},
): ExportOrderListGeometry => ({
  rowPitchPx: 36,
  rowCount: 10,
  viewportTopPx: 100,
  viewportHeightPx: 180,
  scrollTopPx: 0,
  scrollHeightPx: 368,
  firstRowOffsetPx: 4,
  ...overrides,
});

const DRAFT = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

/** The client Y of the middle of row `index`, with no scroll. */
const middleOf = (index: number) => 100 + 4 + index * 36 + 18;

/** A press on the middle of row `index`, then a move to `clientY`. */
function dragTo(index: number, clientY: number, list = geometry()): ExportOrderDrag {
  const pressed = pressExportOrderRow(1, index, middleOf(index), list);
  if (pressed === null) {
    throw new Error("no press");
  }
  return moveExportOrderDrag(pressed, 1, clientY, list);
}

describe("the press", () => {
  it("arms a drag with the grab offset in the row", () => {
    expect(pressExportOrderRow(7, 2, middleOf(2), geometry())).toEqual({
      phase: "pressed",
      pointerId: 7,
      fromIndex: 2,
      startClientY: middleOf(2),
      grabOffsetPx: 18,
    });
  });

  it("refuses a row or a geometry that places nothing", () => {
    expect(pressExportOrderRow(1, -1, 120, geometry())).toBeNull();
    expect(pressExportOrderRow(1, 10, 120, geometry())).toBeNull();
    expect(pressExportOrderRow(1, 0, 120, geometry({ rowPitchPx: 0 }))).toBeNull();
    expect(pressExportOrderRow(1, 0, 120, geometry({ rowCount: 0 }))).toBeNull();
    expect(pressExportOrderRow(1, 0, Number.NaN, geometry())).toBeNull();
  });
});

describe("the move", () => {
  it("starts the drag only past the threshold, so a click only focuses the row", () => {
    const pressed = pressExportOrderRow(1, 2, middleOf(2), geometry());
    if (pressed === null) {
      throw new Error("no press");
    }
    const small = moveExportOrderDrag(
      pressed,
      1,
      middleOf(2) + EXPORT_ORDER_DRAG_THRESHOLD_PX - 1,
      geometry(),
    );
    expect(small).toBe(pressed);
    const started = moveExportOrderDrag(
      pressed,
      1,
      middleOf(2) + EXPORT_ORDER_DRAG_THRESHOLD_PX,
      geometry(),
    );
    expect(started).toMatchObject({ phase: "dragging", fromIndex: 2, targetIndex: 2 });
  });

  it("ignores another pointer", () => {
    const pressed = pressExportOrderRow(1, 2, middleOf(2), geometry());
    if (pressed === null) {
      throw new Error("no press");
    }
    expect(moveExportOrderDrag(pressed, 2, middleOf(6), geometry())).toBe(pressed);
  });

  it("targets the slot that holds the middle of the dragged row", () => {
    // The row moves down by half a row: its middle reaches the edge of the next slot.
    expect(dragTo(2, middleOf(2) + 17)).toMatchObject({ targetIndex: 2 });
    expect(dragTo(2, middleOf(2) + 18)).toMatchObject({ targetIndex: 3 });
    expect(dragTo(2, middleOf(5))).toMatchObject({ targetIndex: 5 });
    expect(dragTo(5, middleOf(0))).toMatchObject({ targetIndex: 0 });
  });

  it("clamps the target to the list", () => {
    expect(dragTo(2, -500)).toMatchObject({ targetIndex: 0 });
    expect(dragTo(2, 5000)).toMatchObject({ targetIndex: 9 });
  });

  it("counts the scroll of the list", () => {
    // Scrolled by three rows: the pointer at the middle of the visible row 0 is over row 3.
    const scrolled = geometry({ scrollTopPx: 108 });
    expect(exportOrderDragTarget(middleOf(0), 18, scrolled)).toBe(3);
    // A scroll during the drag moves the target with the same pointer.
    const drag = dragTo(2, middleOf(2) + 10);
    expect(drag).toMatchObject({ targetIndex: 2 });
    if (drag.phase !== "dragging") {
      throw new Error("no drag");
    }
    expect(
      moveExportOrderDrag(drag, 1, drag.clientY, geometry({ scrollTopPx: 72 })),
    ).toMatchObject({ targetIndex: 4 });
  });

  it("returns the same drag when nothing changes", () => {
    const drag = dragTo(2, middleOf(4));
    expect(moveExportOrderDrag(drag, 1, middleOf(4), geometry())).toBe(drag);
  });
});

describe("the preview and the drop", () => {
  it("shows the row at its target while the drag runs", () => {
    expect(previewExportOrderDrag(null, DRAFT)).toBe(DRAFT);
    const pressed = pressExportOrderRow(1, 2, middleOf(2), geometry());
    expect(previewExportOrderDrag(pressed, DRAFT)).toBe(DRAFT);
    expect(previewExportOrderDrag(dragTo(2, middleOf(4)), DRAFT).slice(0, 5)).toEqual([
      "a",
      "b",
      "d",
      "e",
      "c",
    ]);
  });

  it("moves the row to its target at the release", () => {
    expect(dropExportOrderDrag(dragTo(2, middleOf(4)), 1, DRAFT)).toEqual({
      draft: ["a", "b", "d", "e", "c", "f", "g", "h", "i", "j"],
      index: 4,
    });
  });

  it("moves nothing for a click, another pointer or a drag back to its place", () => {
    const pressed = pressExportOrderRow(1, 2, middleOf(2), geometry());
    if (pressed === null) {
      throw new Error("no press");
    }
    expect(dropExportOrderDrag(pressed, 1, DRAFT)).toBeNull();
    expect(dropExportOrderDrag(dragTo(2, middleOf(4)), 2, DRAFT)).toBeNull();
    expect(dropExportOrderDrag(dragTo(2, middleOf(2) + 10), 1, DRAFT)).toBeNull();
  });
});

describe("the scroll near the top and the bottom", () => {
  it("scrolls up near the top and down near the bottom, faster near the edge", () => {
    const list = geometry();
    expect(exportOrderAutoScrollVelocity(190, list)).toBe(0);
    // The inner edge of the top band: no speed yet.
    expect(
      exportOrderAutoScrollVelocity(100 + EXPORT_ORDER_AUTO_SCROLL_ZONE_PX, list),
    ).toBe(0);
    const halfway = exportOrderAutoScrollVelocity(
      100 + EXPORT_ORDER_AUTO_SCROLL_ZONE_PX / 2,
      list,
    );
    expect(halfway).toBeCloseTo(-EXPORT_ORDER_AUTO_SCROLL_MAX_SPEED_PX_PER_S / 2);
    expect(exportOrderAutoScrollVelocity(100, list)).toBe(
      -EXPORT_ORDER_AUTO_SCROLL_MAX_SPEED_PX_PER_S,
    );
    // Past the edge the speed stays at its largest value.
    expect(exportOrderAutoScrollVelocity(40, list)).toBe(
      -EXPORT_ORDER_AUTO_SCROLL_MAX_SPEED_PX_PER_S,
    );
    expect(exportOrderAutoScrollVelocity(280, list)).toBe(
      EXPORT_ORDER_AUTO_SCROLL_MAX_SPEED_PX_PER_S,
    );
    expect(exportOrderAutoScrollVelocity(900, list)).toBe(
      EXPORT_ORDER_AUTO_SCROLL_MAX_SPEED_PX_PER_S,
    );
  });

  it("splits a low list between the two bands", () => {
    const low = geometry({ viewportHeightPx: 40 });
    expect(exportOrderAutoScrollVelocity(120, low)).toBe(0);
    expect(exportOrderAutoScrollVelocity(100, low)).toBe(
      -EXPORT_ORDER_AUTO_SCROLL_MAX_SPEED_PX_PER_S,
    );
  });

  it("steps for the time of the frame, inside the scroll range, only while a drag runs", () => {
    const atBottom = dragTo(2, 280);
    // 16 ms at 720 px/s.
    expect(exportOrderAutoScrollStep(atBottom, geometry(), 16)).toBeCloseTo(11.52);
    // A late frame counts no more than the longest frame.
    expect(exportOrderAutoScrollStep(atBottom, geometry(), 1000)).toBeCloseTo(
      (EXPORT_ORDER_AUTO_SCROLL_MAX_SPEED_PX_PER_S *
        EXPORT_ORDER_AUTO_SCROLL_MAX_FRAME_MS) /
        1000,
    );
    // The end of the scroll range: 368 - 180 = 188.
    expect(
      exportOrderAutoScrollStep(atBottom, geometry({ scrollTopPx: 185 }), 16),
    ).toBe(3);
    expect(
      exportOrderAutoScrollStep(atBottom, geometry({ scrollTopPx: 188 }), 16),
    ).toBe(0);
    // At the top, with no scroll, nothing moves.
    expect(exportOrderAutoScrollStep(dragTo(2, 100), geometry(), 16)).toBe(0);
    expect(
      exportOrderAutoScrollStep(dragTo(2, 100), geometry({ scrollTopPx: 5 }), 16),
    ).toBe(-5);
    // A press, no drag, or no time: no step.
    const pressed = pressExportOrderRow(1, 2, 280, geometry());
    expect(exportOrderAutoScrollStep(pressed, geometry(), 16)).toBe(0);
    expect(exportOrderAutoScrollStep(null, geometry(), 16)).toBe(0);
    expect(exportOrderAutoScrollStep(atBottom, geometry(), 0)).toBe(0);
  });
});

describe("the end of a press or a drag", () => {
  const pressed = () => {
    const press = pressExportOrderRow(1, 2, middleOf(2), geometry());
    if (press === null) {
      throw new Error("no press");
    }
    return press;
  };

  it("moves the row at the release, and gives the focus back to the dragged row", () => {
    expect(
      planExportOrderDragEnd(dragTo(2, middleOf(4)), {
        kind: "release",
        pointerId: 1,
        draft: DRAFT,
        clientY: middleOf(4),
        geometry: geometry(),
      }),
    ).toEqual({
      drop: { draft: ["a", "b", "d", "e", "c", "f", "g", "h", "i", "j"], index: 4 },
      focusDraggedRow: true,
      releaseCapture: false,
    });
    // A click on a row moves nothing, and the row keeps the focus.
    expect(
      planExportOrderDragEnd(pressed(), {
        kind: "release",
        pointerId: 1,
        draft: DRAFT,
        clientY: middleOf(2) + 2,
        geometry: geometry(),
      }),
    ).toEqual({ drop: null, focusDraggedRow: true, releaseCapture: false });
  });

  it("ends with no change at a pointer cancel or a lost capture, and gives the focus back", () => {
    for (const kind of ["pointerCancel", "lostCapture"] as const) {
      for (const drag of [pressed(), dragTo(2, middleOf(4))]) {
        expect(planExportOrderDragEnd(drag, { kind, pointerId: 1 })).toEqual({
          drop: null,
          focusDraggedRow: true,
          releaseCapture: false,
        });
      }
    }
  });

  it("ends with no change at Escape, gives the focus back, and releases the held pointer", () => {
    expect(planExportOrderDragEnd(dragTo(2, middleOf(4)), { kind: "escape" })).toEqual({
      drop: null,
      focusDraggedRow: true,
      releaseCapture: true,
    });
  });

  it("ends at a close of the dialog, releases the held pointer, and focuses no row", () => {
    const drag = dragTo(2, geometry().viewportTopPx + geometry().viewportHeightPx - 1);
    // The pointer of the drag is in the scroll band at the bottom of the list.
    expect(isExportOrderAutoScrollActive(true, drag)).toBe(true);
    expect(planExportOrderDragEnd(drag, { kind: "close" })).toEqual({
      drop: null,
      focusDraggedRow: false,
      releaseCapture: true,
    });
    // The loop of animation frames stops at the close, also before the drag state is gone.
    expect(isExportOrderAutoScrollActive(false, drag)).toBe(false);
    expect(isExportOrderAutoScrollActive(true, null)).toBe(false);
    // A press that is not a drag yet does not scroll.
    expect(isExportOrderAutoScrollActive(true, pressed())).toBe(false);
  });

  it("ends nothing with no drag, or for an event of another pointer", () => {
    expect(planExportOrderDragEnd(null, { kind: "escape" })).toBeNull();
    expect(planExportOrderDragEnd(null, { kind: "close" })).toBeNull();
    const drag = dragTo(2, middleOf(4));
    expect(
      planExportOrderDragEnd(drag, {
        kind: "release",
        pointerId: 2,
        draft: DRAFT,
        clientY: middleOf(4),
        geometry: geometry(),
      }),
    ).toBeNull();
    expect(
      planExportOrderDragEnd(drag, { kind: "pointerCancel", pointerId: 2 }),
    ).toBeNull();
    expect(
      planExportOrderDragEnd(drag, { kind: "lostCapture", pointerId: 2 }),
    ).toBeNull();
  });
});

describe("Escape", () => {
  it("closes the dialog when no drag runs", () => {
    const guard = createExportOrderEscapeGuard();
    expect(guard.keyDown({ repeat: false, isDragActive: false })).toBe("dismiss");
  });

  it("ends the drag only, and a held Escape that ended it never closes the dialog", () => {
    const guard = createExportOrderEscapeGuard();
    expect(guard.keyDown({ repeat: false, isDragActive: true })).toBe("cancelDrag");
    // The repeats of the held key come after the drag ended.
    expect(guard.keyDown({ repeat: true, isDragActive: false })).toBe("ignore");
    expect(guard.keyDown({ repeat: true, isDragActive: false })).toBe("ignore");
    // A key press of the held key that a web view does not mark as a repeat.
    expect(guard.keyDown({ repeat: false, isDragActive: false })).toBe("ignore");
    // Another key that is released changes nothing.
    guard.keyUp("Shift");
    expect(guard.keyDown({ repeat: true, isDragActive: false })).toBe("ignore");
    // After the release of Escape, a new press closes the dialog.
    guard.keyUp("Escape");
    expect(guard.keyDown({ repeat: false, isDragActive: false })).toBe("dismiss");
  });

  it("never closes the dialog for a repeated Escape", () => {
    const guard = createExportOrderEscapeGuard();
    expect(guard.keyDown({ repeat: true, isDragActive: false })).toBe("ignore");
    expect(guard.keyDown({ repeat: false, isDragActive: false })).toBe("dismiss");
  });

  it("ends the hold when the window loses the focus before the release", () => {
    const guard = createExportOrderEscapeGuard();
    expect(guard.keyDown({ repeat: false, isDragActive: true })).toBe("cancelDrag");
    guard.reset();
    expect(guard.keyDown({ repeat: false, isDragActive: false })).toBe("dismiss");
  });

  it("ends the drag at Escape with no change, so the draft before the drag stays", () => {
    // A draft that the user changed, then a second drag, and a held Escape.
    const draft = ["b", "a", "c", "d", "e", "f", "g", "h", "i", "j"];
    const guard = createExportOrderEscapeGuard();
    const drag = dragTo(2, middleOf(4));
    expect(guard.keyDown({ repeat: false, isDragActive: true })).toBe("cancelDrag");
    expect(planExportOrderDragEnd(drag, { kind: "escape" })?.drop).toBeNull();
    expect(previewExportOrderDrag(null, draft)).toBe(draft);
    expect(guard.keyDown({ repeat: true, isDragActive: false })).not.toBe("dismiss");
  });
});

describe("the drag session", () => {
  /** A session whose effects only record what they were asked to do. */
  function recordingSession() {
    const rendered: (ExportOrderDrag | null)[] = [];
    const released: number[] = [];
    const session = createExportOrderDragSession({
      render: (drag) => rendered.push(drag),
      releaseCapture: (pointerId) => released.push(pointerId),
    });
    return { session, rendered, released };
  }

  it("drops at the target of the last move, also when no render ran after that move", () => {
    const { session } = recordingSession();
    expect(session.press(1, 2, middleOf(2), geometry())).toBe(true);
    // The first move crosses the threshold and targets row 3. React renders it.
    session.move(1, middleOf(3), geometry());
    // The next move targets row 4, and the release follows before React renders that move.
    session.move(1, middleOf(4), geometry());
    expect(
      session.end({
        kind: "release",
        pointerId: 1,
        draft: DRAFT,
        clientY: middleOf(4),
        geometry: geometry(),
      }),
    ).toEqual({
      drop: { draft: ["a", "b", "d", "e", "c", "f", "g", "h", "i", "j"], index: 4 },
      focusDraggedRow: true,
      releaseCapture: false,
      fromIndex: 2,
    });
    expect(session.current()).toBeNull();
  });

  it("drops at the row under the pointer of the release, after a scroll that no event reported", () => {
    const { session } = recordingSession();
    session.press(1, 2, middleOf(2), geometry());
    session.move(1, middleOf(4), geometry());
    expect(session.current()).toMatchObject({ phase: "dragging", targetIndex: 4 });
    // A wheel scroll moves the list by one row while the pointer is held. Neither a move nor
    // the `scroll` event reaches the session before the release at the same client Y.
    const scrolled = geometry({ scrollTopPx: 36 });
    expect(
      session.end({
        kind: "release",
        pointerId: 1,
        draft: DRAFT,
        clientY: middleOf(4),
        geometry: scrolled,
      }),
    ).toMatchObject({
      drop: { draft: ["a", "b", "d", "e", "f", "c", "g", "h", "i", "j"], index: 5 },
    });
    // With no geometry, the release keeps the target of the last event.
    session.press(1, 2, middleOf(2), geometry());
    session.move(1, middleOf(4), geometry());
    expect(
      session.end({
        kind: "release",
        pointerId: 1,
        draft: DRAFT,
        clientY: middleOf(4),
        geometry: null,
      }),
    ).toMatchObject({ drop: { index: 4 } });
    // A press that never became a drag stays a click, whatever the geometry says.
    session.press(1, 2, middleOf(2), geometry());
    expect(
      session.end({
        kind: "release",
        pointerId: 1,
        draft: DRAFT,
        clientY: middleOf(2),
        geometry: scrolled,
      }),
    ).toMatchObject({ drop: null });
  });

  it("reads the last state for Escape, a pointer cancel, a lost capture and the scroll loop", () => {
    const { session, released } = recordingSession();
    session.press(1, 2, middleOf(2), geometry());
    session.move(1, middleOf(4), geometry());
    expect(session.current()).toMatchObject({ phase: "dragging", targetIndex: 4 });
    // The scroll loop reads the drag of the last move, and the scroll moves its target.
    const scrolled = geometry({ scrollTopPx: 36 });
    // The pointer of the last move is in the band at the bottom, so the loop scrolls down.
    expect(
      exportOrderAutoScrollStep(session.current(), geometry(), 16),
    ).toBeGreaterThan(0);
    session.scroll(scrolled);
    expect(session.current()).toMatchObject({ phase: "dragging", targetIndex: 5 });
    expect(session.end({ kind: "escape" })).toMatchObject({ focusDraggedRow: true });
    expect(released).toEqual([1]);

    for (const kind of ["pointerCancel", "lostCapture"] as const) {
      session.press(1, 2, middleOf(2), geometry());
      session.move(1, middleOf(4), geometry());
      expect(session.end({ kind, pointerId: 1 })).toMatchObject({ drop: null });
      expect(session.current()).toBeNull();
    }
  });

  it("releases the capture at a reset of the draft, and the held pointer drags nothing after it", () => {
    const { session, rendered, released } = recordingSession();
    session.press(7, 2, middleOf(2), geometry());
    session.move(7, middleOf(4), geometry());
    // An import that ends splits a crossing segment, and the dialog resets the draft.
    expect(session.end({ kind: "reset" })).toEqual({
      drop: null,
      focusDraggedRow: false,
      releaseCapture: true,
      fromIndex: 2,
    });
    expect(released).toEqual([7]);
    expect(rendered[rendered.length - 1]).toBeNull();
    // The pointer is still down: its moves and its release start and drop nothing.
    session.move(7, middleOf(6), geometry());
    expect(session.current()).toBeNull();
    expect(
      session.end({
        kind: "release",
        pointerId: 7,
        draft: DRAFT,
        clientY: middleOf(6),
        geometry: geometry(),
      }),
    ).toBeNull();
    // A later Escape and a close find no drag, and release nothing again.
    expect(session.end({ kind: "escape" })).toBeNull();
    expect(session.end({ kind: "close" })).toBeNull();
    expect(released).toEqual([7]);
    // A new press starts a new drag.
    expect(session.press(7, 1, middleOf(1), geometry())).toBe(true);
  });

  it("releases the capture at a close, and arms one press at a time", () => {
    const { session, released } = recordingSession();
    expect(session.press(1, 2, middleOf(2), geometry())).toBe(true);
    expect(session.press(2, 3, middleOf(3), geometry())).toBe(false);
    expect(session.end({ kind: "close" })).toMatchObject({
      focusDraggedRow: false,
      releaseCapture: true,
    });
    expect(released).toEqual([1]);
    // A press that places no row arms nothing.
    expect(session.press(1, 20, middleOf(2), geometry())).toBe(false);
    expect(session.current()).toBeNull();
  });
});
