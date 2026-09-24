import type { MouseEvent } from "react";

/**
 * Keeps a mouse press from moving the focus to the element that it lands on. Pass it as the
 * `onMouseDown` handler of a control that must not keep the focus after a click (ADR 021).
 *
 * The browser gives the focus on mouse down, so a cancelled mouse down leaves the focus where
 * it was. The click still happens, because the browser sends a click on mouse up and does not
 * test whether the mouse down was cancelled. The pointer events come before the mouse events,
 * so a pointer handler on the same element still runs. The Tab order does not change: an
 * element reached with the Tab key still takes the focus.
 *
 * Each caller states why its control must not keep the focus.
 */
export function preventFocusOnMouseDown(event: MouseEvent<HTMLElement>): void {
  event.preventDefault();
}
