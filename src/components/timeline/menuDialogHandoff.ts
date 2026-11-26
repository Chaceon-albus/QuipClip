/**
 * The hand-off from a native context menu to a dialog that one of its items opens (ADR 065).
 *
 * The dialog opens after the menu closes. The choice of the item and the end of the menu reach
 * the page on two channels, in either order: the item sends its event on its own channel, and the
 * end of the menu is the settled popup, or the first input after its grace period when the popup
 * reply got lost (`NativeContextMenuMark.onClose`). The item therefore runs when both arrived,
 * and only once. A dialog never opens over a menu that still shows.
 *
 * An item event proves that its menu is closing. So when the choice arrived and the end of the
 * menu did not arrive within the grace period of `nativeContextMenuState.ts`, a timer of the
 * hand-off treats the menu as closed, and the item runs with no further input. A popup reply that
 * arrives after that changes nothing.
 *
 * A later menu cancels the hand-off of the menu before it (`cancel`), with its timer, so an item
 * of an earlier menu never runs after a later menu opened (ADR 026).
 *
 * The module has no React, DOM or store dependency.
 */

/** The state of one hand-off. */
export type MenuDialogHandoffState<A> =
  /** Neither the choice nor the end of the menu arrived. */
  | { readonly kind: "waiting" }
  /** The choice arrived, and the menu still shows or is on its way out. */
  | { readonly kind: "chosen"; readonly action: A }
  /** The menu ended, with no choice yet. A late item event can still come. */
  | { readonly kind: "closed" }
  /** The choice ran. Nothing else runs. */
  | { readonly kind: "done" };

/** What reaches the hand-off. */
export type MenuDialogHandoffEvent<A> =
  | { readonly kind: "choose"; readonly action: A }
  | { readonly kind: "close" }
  /** A later menu opened: nothing of this menu runs any more. */
  | { readonly kind: "cancel" };

/** The next state, and the action to run now, or null. */
export interface MenuDialogHandoffStep<A> {
  readonly state: MenuDialogHandoffState<A>;
  readonly run: A | null;
}

/**
 * One step of the hand-off. The action runs at the second of the two events, whatever their
 * order. A native menu closes after one choice, so a second choice is ignored.
 */
export function stepMenuDialogHandoff<A>(
  state: MenuDialogHandoffState<A>,
  event: MenuDialogHandoffEvent<A>,
): MenuDialogHandoffStep<A> {
  if (event.kind === "cancel") {
    return { state: { kind: "done" }, run: null };
  }
  switch (state.kind) {
    case "waiting":
      return event.kind === "choose"
        ? { state: { kind: "chosen", action: event.action }, run: null }
        : { state: { kind: "closed" }, run: null };
    case "chosen":
      return event.kind === "close"
        ? { state: { kind: "done" }, run: state.action }
        : { state, run: null };
    case "closed":
      return event.kind === "choose"
        ? { state: { kind: "done" }, run: event.action }
        : { state, run: null };
    case "done":
      return { state, run: null };
  }
}

/** A hand-off that keeps its state and runs the action. */
export interface MenuDialogHandoff<A> {
  /** The item event of the chosen item. */
  readonly choose: (action: A) => void;
  /** The end of the menu. */
  readonly close: () => void;
  /** A later menu opened. Nothing of this menu runs any more, and the timer stops. */
  readonly cancel: () => void;
}

/** Starts a timer, and returns the function that stops it. */
export type MenuDialogHandoffSchedule = (
  callback: () => void,
  delayMs: number,
) => () => void;

/** The timer of a hand-off (see above). */
export interface MenuDialogHandoffTimer {
  readonly schedule: MenuDialogHandoffSchedule;
  /** The longest wait for the end of the menu after the choice. */
  readonly delayMs: number;
  /**
   * Runs when the timer ends the wait, before the item runs. The owner closes the mark of the
   * menu there, because the item event proved that the menu has gone.
   */
  readonly onExpire?: () => void;
}

/**
 * Creates a hand-off that calls `run` once, when both events arrived, or when the timer ends the
 * wait for the end of the menu after the choice.
 */
export function createMenuDialogHandoff<A>(
  run: (action: A) => void,
  timer?: MenuDialogHandoffTimer,
): MenuDialogHandoff<A> {
  let state: MenuDialogHandoffState<A> = { kind: "waiting" };
  let stopTimer: (() => void) | null = null;
  const clearTimer = (): void => {
    stopTimer?.();
    stopTimer = null;
  };
  const apply = (event: MenuDialogHandoffEvent<A>): void => {
    const step = stepMenuDialogHandoff(state, event);
    state = step.state;
    if (state.kind !== "chosen") {
      clearTimer();
    }
    if (step.run !== null) {
      run(step.run);
    }
  };
  return {
    choose: (action) => {
      apply({ kind: "choose", action });
      if (state.kind === "chosen" && timer !== undefined && stopTimer === null) {
        stopTimer = timer.schedule(() => {
          stopTimer = null;
          if (state.kind !== "chosen") {
            return;
          }
          timer.onExpire?.();
          apply({ kind: "close" });
        }, timer.delayMs);
      }
    },
    close: () => apply({ kind: "close" }),
    cancel: () => apply({ kind: "cancel" }),
  };
}
