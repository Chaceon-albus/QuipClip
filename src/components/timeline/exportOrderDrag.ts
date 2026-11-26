/**
 * The pointer drag of a row of the Export Order dialog (ADR 066), as a pure reducer.
 *
 * The dialog uses pointer events and not the drag and drop of HTML, because the window takes the
 * drop of a file. A press on a row arms a drag. The drag starts when the pointer moves more than
 * `EXPORT_ORDER_DRAG_THRESHOLD_PX` from the press, so a click on a row only focuses it. While the
 * drag runs, the list shows the row at its target place (`previewExportOrderDrag`). The release
 * moves the row there (`dropExportOrderDrag`). Escape, a pointer cancel, a lost capture and a
 * close of the dialog end the drag with no change (`planExportOrderDragEnd`). A held Escape that
 * ended a drag does not also close the dialog (`createExportOrderEscapeGuard`).
 *
 * Every row has the same height, so the target of the drag is arithmetic on the row pitch, the
 * scroll of the list and the pointer, and reads no layout. The list scrolls while the pointer is
 * near its top or its bottom (`exportOrderAutoScrollStep`).
 *
 * The module has no React or DOM dependency, so the tests need no document.
 */

import { moveExportOrderRow } from "./exportOrderModel";

/** The distance that a pressed pointer moves before the drag starts, in CSS pixels. */
export const EXPORT_ORDER_DRAG_THRESHOLD_PX = 4;

/** The band at the top and at the bottom of the list in which the list scrolls, in CSS pixels. */
export const EXPORT_ORDER_AUTO_SCROLL_ZONE_PX = 32;

/** The scroll speed at the edge of the list and past it, in CSS pixels per second. */
export const EXPORT_ORDER_AUTO_SCROLL_MAX_SPEED_PX_PER_S = 720;

/**
 * The longest time that one scroll step counts, in milliseconds. A frame that comes late, as
 * after a stall of the page, does not jump the list.
 */
export const EXPORT_ORDER_AUTO_SCROLL_MAX_FRAME_MS = 50;

/** The geometry of the list that a drag reads, all in CSS pixels. */
export interface ExportOrderListGeometry {
  /** The distance from the top of one row to the top of the next row. */
  readonly rowPitchPx: number;
  /** The number of rows. */
  readonly rowCount: number;
  /** The client Y of the top edge of the visible part of the list. */
  readonly viewportTopPx: number;
  /** The height of the visible part of the list (`clientHeight`). */
  readonly viewportHeightPx: number;
  /** The scroll position of the list (`scrollTop`). */
  readonly scrollTopPx: number;
  /** The height of the content of the list (`scrollHeight`). */
  readonly scrollHeightPx: number;
  /** The distance from the top of the content to the top of the first row (`offsetTop`). */
  readonly firstRowOffsetPx: number;
}

/** A press or a drag of a row. */
export type ExportOrderDrag =
  /** A pointer pressed a row, and has not moved past the threshold yet. */
  | {
      readonly phase: "pressed";
      readonly pointerId: number;
      readonly fromIndex: number;
      readonly startClientY: number;
      /** The distance from the top of the row to the pointer at the press. */
      readonly grabOffsetPx: number;
    }
  /** The row follows the pointer. */
  | {
      readonly phase: "dragging";
      readonly pointerId: number;
      readonly fromIndex: number;
      readonly grabOffsetPx: number;
      /** The client Y of the pointer at its last move. */
      readonly clientY: number;
      /** The index that the row takes in the list if the pointer is released now. */
      readonly targetIndex: number;
    };

/** The Y of a client point in the content of the list, from the top of the first row. */
function contentY(clientY: number, geometry: ExportOrderListGeometry): number {
  return (
    clientY - geometry.viewportTopPx + geometry.scrollTopPx - geometry.firstRowOffsetPx
  );
}

/** True when every value of the geometry can place a row. */
function isUsableGeometry(geometry: ExportOrderListGeometry): boolean {
  return (
    Number.isFinite(geometry.rowPitchPx) &&
    geometry.rowPitchPx > 0 &&
    Number.isInteger(geometry.rowCount) &&
    geometry.rowCount > 0 &&
    Number.isFinite(geometry.viewportTopPx) &&
    Number.isFinite(geometry.scrollTopPx) &&
    Number.isFinite(geometry.firstRowOffsetPx)
  );
}

/**
 * Arms a drag for a press on the row at `fromIndex`. Null when the index or the geometry cannot
 * place a row.
 */
export function pressExportOrderRow(
  pointerId: number,
  fromIndex: number,
  clientY: number,
  geometry: ExportOrderListGeometry,
): ExportOrderDrag | null {
  if (
    !isUsableGeometry(geometry) ||
    !Number.isInteger(fromIndex) ||
    fromIndex < 0 ||
    fromIndex >= geometry.rowCount ||
    !Number.isFinite(clientY)
  ) {
    return null;
  }
  return {
    phase: "pressed",
    pointerId,
    fromIndex,
    startClientY: clientY,
    grabOffsetPx: contentY(clientY, geometry) - fromIndex * geometry.rowPitchPx,
  };
}

/**
 * The index that the dragged row takes: the row whose slot holds the middle of the dragged row,
 * which keeps the grab offset of the press. It is clamped to the list.
 */
export function exportOrderDragTarget(
  clientY: number,
  grabOffsetPx: number,
  geometry: ExportOrderListGeometry,
): number {
  if (!isUsableGeometry(geometry) || !Number.isFinite(clientY)) {
    return 0;
  }
  const middle = contentY(clientY, geometry) - grabOffsetPx + geometry.rowPitchPx / 2;
  const index = Math.floor(middle / geometry.rowPitchPx);
  return Math.min(Math.max(index, 0), geometry.rowCount - 1);
}

/**
 * The drag after a move of the pointer, or after a scroll of the list, which passes the last
 * client Y again. A move of another pointer changes nothing. A press becomes a drag when the
 * pointer moved at least the threshold from the press.
 */
export function moveExportOrderDrag(
  drag: ExportOrderDrag,
  pointerId: number,
  clientY: number,
  geometry: ExportOrderListGeometry,
): ExportOrderDrag {
  if (pointerId !== drag.pointerId || !Number.isFinite(clientY)) {
    return drag;
  }
  if (
    drag.phase === "pressed" &&
    Math.abs(clientY - drag.startClientY) < EXPORT_ORDER_DRAG_THRESHOLD_PX
  ) {
    return drag;
  }
  const targetIndex = exportOrderDragTarget(clientY, drag.grabOffsetPx, geometry);
  if (
    drag.phase === "dragging" &&
    drag.clientY === clientY &&
    drag.targetIndex === targetIndex
  ) {
    return drag;
  }
  return {
    phase: "dragging",
    pointerId: drag.pointerId,
    fromIndex: drag.fromIndex,
    grabOffsetPx: drag.grabOffsetPx,
    clientY,
    targetIndex,
  };
}

/**
 * The order that the list shows: the draft with the dragged row at its target place while a drag
 * runs, and the draft itself before the drag starts.
 */
export function previewExportOrderDrag(
  drag: ExportOrderDrag | null,
  draft: readonly string[],
): readonly string[] {
  if (drag === null || drag.phase !== "dragging") {
    return draft;
  }
  return moveExportOrderRow(draft, drag.fromIndex, drag.targetIndex);
}

/** The draft after a release, and the index of the moved row. */
export interface ExportOrderDrop {
  readonly draft: readonly string[];
  readonly index: number;
}

/**
 * The draft after the release of `pointerId`: the row at its target place. Null when nothing
 * moves: another pointer, a press that never became a drag, or a drag that ends at its own place.
 */
export function dropExportOrderDrag(
  drag: ExportOrderDrag,
  pointerId: number,
  draft: readonly string[],
): ExportOrderDrop | null {
  if (
    pointerId !== drag.pointerId ||
    drag.phase !== "dragging" ||
    drag.fromIndex >= draft.length
  ) {
    return null;
  }
  const next = moveExportOrderRow(draft, drag.fromIndex, drag.targetIndex);
  return next === draft ? null : { draft: next, index: drag.targetIndex };
}

/**
 * The scroll speed of the list for the pointer of a drag, in CSS pixels per second: negative
 * toward the top, positive toward the bottom, 0 outside the two bands. The speed rises from 0 at
 * the inner edge of a band to the full speed at the edge of the list, and stays there past it.
 */
export function exportOrderAutoScrollVelocity(
  clientY: number,
  geometry: Pick<ExportOrderListGeometry, "viewportTopPx" | "viewportHeightPx">,
): number {
  const { viewportTopPx: top, viewportHeightPx: height } = geometry;
  if (!Number.isFinite(clientY) || !Number.isFinite(top) || !(height > 0)) {
    return 0;
  }
  // A list lower than two bands splits its height between them.
  const zone = Math.min(EXPORT_ORDER_AUTO_SCROLL_ZONE_PX, height / 2);
  const fromTop = clientY - top;
  const fromBottom = top + height - clientY;
  const speed = (depth: number) =>
    EXPORT_ORDER_AUTO_SCROLL_MAX_SPEED_PX_PER_S * Math.min(1, depth / zone);
  if (fromTop < zone) {
    return -speed(zone - fromTop);
  }
  if (fromBottom < zone) {
    return speed(zone - fromBottom);
  }
  return 0;
}

/**
 * The scroll step of one animation frame of a drag, in CSS pixels: the speed of
 * `exportOrderAutoScrollVelocity` for the time since the last frame, kept inside the scroll range
 * of the list. 0 for a press that is not a drag yet.
 *
 * @param drag The drag, or null.
 * @param geometry The list now.
 * @param elapsedMs The time since the last frame.
 */
export function exportOrderAutoScrollStep(
  drag: ExportOrderDrag | null,
  geometry: ExportOrderListGeometry,
  elapsedMs: number,
): number {
  if (drag === null || drag.phase !== "dragging" || !(elapsedMs > 0)) {
    return 0;
  }
  const velocity = exportOrderAutoScrollVelocity(drag.clientY, geometry);
  if (velocity === 0) {
    return 0;
  }
  const step =
    (velocity * Math.min(elapsedMs, EXPORT_ORDER_AUTO_SCROLL_MAX_FRAME_MS)) / 1000;
  const maxScroll = Math.max(0, geometry.scrollHeightPx - geometry.viewportHeightPx);
  const next = Math.min(Math.max(geometry.scrollTopPx + step, 0), maxScroll);
  return next - geometry.scrollTopPx;
}

/** An event that can end a press or a drag. */
export type ExportOrderDragEndEvent =
  /**
   * The release of a pointer, with the draft, the client Y of the release and the geometry of
   * the list of that moment. The geometry is null when the list cannot be measured.
   */
  | {
      readonly kind: "release";
      readonly pointerId: number;
      readonly draft: readonly string[];
      readonly clientY: number;
      readonly geometry: ExportOrderListGeometry | null;
    }
  /** The browser cancelled a pointer, or the list lost the capture of a pointer. */
  | { readonly kind: "pointerCancel" | "lostCapture"; readonly pointerId: number }
  /** Escape, while the pointer can still be down. */
  | { readonly kind: "escape" }
  /**
   * The segments of the export changed under the dialog, which discards the draft and any drag
   * (`followExportOrderTimeline`), while the pointer can still be down.
   */
  | { readonly kind: "reset" }
  /** The dialog closed, while the pointer can still be down. */
  | { readonly kind: "close" };

/** What the end of a press or a drag does (`planExportOrderDragEnd`). */
export interface ExportOrderDragEnd {
  /** The draft after a release that moves the row, or null when the draft does not change. */
  readonly drop: ExportOrderDrop | null;
  /**
   * True when the dragged row takes the focus again. The preview moves the node of a row in the
   * document, and a node that moves can lose the focus, which then goes to the dialog. The keys
   * of the list work only on a focused row, so every end in the open dialog gives the focus back
   * to the row. The focus rule of the dialog keeps a focus that the user moved to another
   * enabled control during the drag (`canMoveExportOrderFocusToRow`). A close gives the focus to
   * the element that opened the dialog instead.
   */
  readonly focusDraggedRow: boolean;
  /**
   * True when the list releases the capture of the pointer of the drag. The pointer can still be
   * down after Escape or a close, and a capture that stays would send its events to a list that
   * no longer drags, or that is gone.
   */
  readonly releaseCapture: boolean;
}

/**
 * The end of a press or a drag by `event`, or null when the event ends nothing: there is no
 * press or drag, or the event is of another pointer.
 *
 * - A release moves the row to the slot under the pointer of the release, in the geometry of the
 *   list at the release (`exportOrderDragTarget`). The target of the last move or scroll can be
 *   stale: a wheel scroll during the drag can change the list before its `scroll` event arrives.
 *   A press that never became a drag stays a click and moves nothing.
 * - A pointer cancel and a lost capture end it with no change. The capture is already gone.
 * - Escape ends it with no change, and the dialog stays open.
 * - A reset of the draft ends it with no change. The reset gives the focus to a row itself.
 * - A close ends it with no change. The dialog no longer takes input, so the row takes no focus.
 */
export function planExportOrderDragEnd(
  drag: ExportOrderDrag | null,
  event: ExportOrderDragEndEvent,
): ExportOrderDragEnd | null {
  if (drag === null) {
    return null;
  }
  switch (event.kind) {
    case "release":
      if (event.pointerId !== drag.pointerId) {
        return null;
      }
      return {
        drop: dropExportOrderDrag(
          drag.phase === "dragging" &&
            event.geometry !== null &&
            Number.isFinite(event.clientY)
            ? {
                ...drag,
                clientY: event.clientY,
                targetIndex: exportOrderDragTarget(
                  event.clientY,
                  drag.grabOffsetPx,
                  event.geometry,
                ),
              }
            : drag,
          event.pointerId,
          event.draft,
        ),
        focusDraggedRow: true,
        releaseCapture: false,
      };
    case "pointerCancel":
    case "lostCapture":
      if (event.pointerId !== drag.pointerId) {
        return null;
      }
      return { drop: null, focusDraggedRow: true, releaseCapture: false };
    case "escape":
      return { drop: null, focusDraggedRow: true, releaseCapture: true };
    case "reset":
    case "close":
      return { drop: null, focusDraggedRow: false, releaseCapture: true };
  }
}

/** The end of a press or a drag, with the row that it moved. */
export interface ExportOrderDragEnded extends ExportOrderDragEnd {
  /** The index of the dragged row in the draft of the drag. */
  readonly fromIndex: number;
}

/** The effects of a drag session (`createExportOrderDragSession`). */
export interface ExportOrderDragSessionEffects {
  /** Shows a new press or drag, or none: the list renders its preview. */
  readonly render: (drag: ExportOrderDrag | null) => void;
  /** Releases the capture of the pointer by the list, when the list still holds it. */
  readonly releaseCapture: (pointerId: number) => void;
}

/**
 * The press or the drag of one open of the dialog. Each event writes the latest state at once,
 * and each later event reads it, so no event depends on a render that is still pending. A move is
 * a continuous event, and React can render its update after the release that follows, which then
 * read the target of the move before.
 */
export interface ExportOrderDragSession {
  /** The latest press or drag, or null. */
  readonly current: () => ExportOrderDrag | null;
  /** Arms a drag for a press on a row (`pressExportOrderRow`). False when nothing is armed. */
  readonly press: (
    pointerId: number,
    fromIndex: number,
    clientY: number,
    geometry: ExportOrderListGeometry,
  ) => boolean;
  /** A move of a pointer (`moveExportOrderDrag`). */
  readonly move: (
    pointerId: number,
    clientY: number,
    geometry: ExportOrderListGeometry,
  ) => void;
  /** A scroll of the list during a drag: the last client Y lies over another row now. */
  readonly scroll: (geometry: ExportOrderListGeometry) => void;
  /**
   * Ends the press or the drag (`planExportOrderDragEnd`). Every path goes through here, so the
   * capture of the pointer is released wherever the pointer can still be down. Null when the
   * event ends nothing.
   */
  readonly end: (event: ExportOrderDragEndEvent) => ExportOrderDragEnded | null;
}

/** Creates the drag session of one open of the dialog, with no press. */
export function createExportOrderDragSession(
  effects: ExportOrderDragSessionEffects,
): ExportOrderDragSession {
  let drag: ExportOrderDrag | null = null;
  const write = (next: ExportOrderDrag | null) => {
    if (next !== drag) {
      drag = next;
      effects.render(next);
    }
  };
  return {
    current: () => drag,
    press: (pointerId, fromIndex, clientY, geometry) => {
      if (drag !== null) {
        return false;
      }
      const pressed = pressExportOrderRow(pointerId, fromIndex, clientY, geometry);
      write(pressed);
      return pressed !== null;
    },
    move: (pointerId, clientY, geometry) => {
      if (drag !== null) {
        write(moveExportOrderDrag(drag, pointerId, clientY, geometry));
      }
    },
    scroll: (geometry) => {
      if (drag !== null && drag.phase === "dragging") {
        write(moveExportOrderDrag(drag, drag.pointerId, drag.clientY, geometry));
      }
    },
    end: (event) => {
      const ending = drag;
      const end = planExportOrderDragEnd(ending, event);
      if (ending === null || end === null) {
        return null;
      }
      write(null);
      if (end.releaseCapture) {
        effects.releaseCapture(ending.pointerId);
      }
      return { ...end, fromIndex: ending.fromIndex };
    },
  };
}

/**
 * True while the list scrolls by itself near its top and its bottom: a drag runs and the dialog
 * is open. A closed dialog has no list to scroll, so the loop of animation frames stops at the
 * close, also while a captured pointer is still down.
 */
export function isExportOrderAutoScrollActive(
  isOpen: boolean,
  drag: ExportOrderDrag | null,
): boolean {
  return isOpen && drag?.phase === "dragging";
}

/** What an Escape key press does in the dialog (`ExportOrderEscapeGuard`). */
export type ExportOrderEscapeOutcome =
  /** The press ends the press or the drag of a row, and the dialog stays open. */
  | "cancelDrag"
  /** The press does nothing, and the dialog stays open. */
  | "ignore"
  /** The press closes the dialog, and the draft is discarded. */
  | "dismiss";

/** The part of an Escape key press that the guard reads. */
export interface ExportOrderEscapePress {
  /** True for a key press that a held key repeats. */
  readonly repeat: boolean;
  /** True while a press or a drag of a row runs. */
  readonly isDragActive: boolean;
}

/**
 * The rule of Escape in the dialog. Escape during a press or a drag ends that drag only. The key
 * that did it can still be down, and its repeated key presses come after the drag ended, so the
 * dialog takes Escape until that key is released. A repeated Escape never closes the dialog,
 * because only a new press of the key asks for the close.
 */
export interface ExportOrderEscapeGuard {
  /** The outcome of an Escape key press that reaches the dialog. */
  readonly keyDown: (press: ExportOrderEscapePress) => ExportOrderEscapeOutcome;
  /** A key release. The release of Escape ends the hold. */
  readonly keyUp: (key: string) => void;
  /** The window lost the focus, so the release of the key may never arrive. */
  readonly reset: () => void;
}

/** Creates the Escape guard of one open of the dialog. */
export function createExportOrderEscapeGuard(): ExportOrderEscapeGuard {
  // True from an Escape that ended a drag until the release of that key.
  let held = false;
  return {
    keyDown: ({ repeat, isDragActive }) => {
      if (isDragActive) {
        held = true;
        return "cancelDrag";
      }
      if (held || repeat) {
        return "ignore";
      }
      return "dismiss";
    },
    keyUp: (key) => {
      if (key === "Escape") {
        held = false;
      }
    },
    reset: () => {
      held = false;
    },
  };
}
