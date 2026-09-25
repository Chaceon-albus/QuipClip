/**
 * The open state of a native context menu of the page, such as the menu of a timeline segment.
 *
 * The window keyboard layer does nothing while a menu is open (ADR 021). It finds a Radix menu
 * in the document (`MODAL_LAYER_SELECTOR`), but a native menu has no element in the document,
 * so the layer cannot see it there. The code that opens a native menu therefore marks it here,
 * from the decision to open it until the menu closes, and the layer reads this state.
 *
 * The state covers two intervals. Before the menu shows, the page waits for the IPC calls that
 * build it, and a key press in that interval must do nothing. While the menu shows, the system
 * gives the key presses to the menu, so this state only repeats that rule for the page.
 *
 * # When the popup never settles
 *
 * A mark closes when the popup of its menu settles. A popup that never settles would leave the
 * page without a keyboard and without presses until a reload. A native menu takes all the input
 * of the window while it shows, so a trusted press or key press that reaches the window proves
 * that the menu has closed. After the popup call is sent (`showing`) and a grace period
 * (`NATIVE_CONTEXT_MENU_GRACE_MS`) has passed, the first such event closes the mark. It only
 * closes the mark: the owner keeps what waits for the popup, such as the choice of an item,
 * because the likeliest cause is a popup reply that got lost while the item event still
 * arrives on its own channel. The grace period lets the IPC call reach the native side first.
 * The rule does not apply before the popup call, while the page builds the menu: a press there
 * must still do nothing.
 *
 * The listeners of that rule are on the window in the capture phase, and the state of the
 * application installs them when this module loads. The window keyboard layer and the other
 * window listeners mount later, so these listeners run first, and the event that closes a mark
 * keeps its normal meaning: the layer and the handlers of the page find no open menu. The
 * listeners only read the event. They never cancel it or stop it. A hot reload in development
 * removes them (`dispose`), and the new module installs its own.
 *
 * `isPageOverlayOpen` joins this state with the test for a modal layer in the document. The
 * window keyboard layer and the command items of the macOS menu read that one test.
 *
 * The module has no React or store dependency. It reads the document only in
 * `isModalLayerOpen`, and only when a document exists, so the tests need no document.
 */

import { MODAL_LAYER_SELECTOR } from "./keyboardShortcutController";

/**
 * The time after the popup call during which an input event does not prove that the menu
 * closed, in milliseconds. The native side needs this time to receive the call and show the
 * menu. A first show, which builds the menu, and a busy main thread can take several hundred
 * milliseconds.
 *
 * Two windows remain:
 *
 * - When a popup never settles, the page ignores presses and key presses for up to this time
 *   after the popup call. The first input after it closes the mark.
 * - When the native side takes longer than this time to show the menu, a press in the interval
 *   between the end of this time and the menu reaches the page with no menu open. A primary
 *   press there can start a gesture, such as a scrub, whose release the menu then takes.
 */
export const NATIVE_CONTEXT_MENU_GRACE_MS = 1_000;

/** The input events that prove that a native menu has closed. */
export const NATIVE_CONTEXT_MENU_INPUT_EVENTS = ["pointerdown", "keydown"] as const;

type NativeContextMenuInputType = (typeof NATIVE_CONTEXT_MENU_INPUT_EVENTS)[number];

/** The part of an input event that the rule reads. */
export interface NativeContextMenuInputEvent {
  /** False for an event that a script dispatched. Only the user can close a native menu. */
  readonly isTrusted: boolean;
}

/** The part of the window that the state listens on. A test passes a fake. */
export interface NativeContextMenuInputTarget {
  addEventListener(
    type: NativeContextMenuInputType,
    listener: (event: NativeContextMenuInputEvent) => void,
    options: { readonly capture: true },
  ): void;
  removeEventListener(
    type: NativeContextMenuInputType,
    listener: (event: NativeContextMenuInputEvent) => void,
    options: { readonly capture: true },
  ): void;
}

/** One open native menu. */
export interface NativeContextMenuMark {
  /** Marks the menu closed. It acts once, so a second call does not close another menu. */
  readonly close: () => void;
  /**
   * Reports that the popup call of the menu was sent. From the grace period on, the first
   * trusted press or key press that reaches the window closes the mark. A mark that is already
   * closed stays closed.
   */
  readonly showing: () => void;
}

export interface NativeContextMenuState {
  /** True while at least one native context menu is open. */
  readonly isOpen: () => boolean;
  /** Marks a native context menu as open. */
  readonly open: () => NativeContextMenuMark;
  /** Removes the input listeners, for a hot reload of this module. */
  readonly dispose: () => void;
}

/** The environment of a state. */
export interface NativeContextMenuStateOptions {
  /** The target of the input events, or null for none. The state listens on it at once. */
  readonly input?: NativeContextMenuInputTarget | null;
  /** The clock of the grace period, in milliseconds. `performance.now` by default. */
  readonly now?: () => number;
}

/** Creates an empty state. */
export function createNativeContextMenuState(
  options: NativeContextMenuStateOptions = {},
): NativeContextMenuState {
  const input = options.input ?? null;
  const now = options.now ?? (() => performance.now());
  // The open marks. A set, and not a flag, so a menu that closes after a newer one opened does
  // not clear the state of the newer one.
  const open = new Set<object>();
  // The marks whose popup call was sent, with the time of the call.
  const showing = new Map<object, number>();

  const onInput = (event: NativeContextMenuInputEvent): void => {
    if (!event.isTrusted || showing.size === 0) {
      return;
    }
    const time = now();
    for (const [mark, since] of [...showing]) {
      if (time - since >= NATIVE_CONTEXT_MENU_GRACE_MS) {
        showing.delete(mark);
        open.delete(mark);
      }
    }
  };

  for (const type of NATIVE_CONTEXT_MENU_INPUT_EVENTS) {
    input?.addEventListener(type, onInput, { capture: true });
  }

  return {
    isOpen: () => open.size > 0,
    open: () => {
      const mark = {};
      open.add(mark);
      return {
        close: () => {
          open.delete(mark);
          showing.delete(mark);
        },
        showing: () => {
          if (open.has(mark) && !showing.has(mark)) {
            showing.set(mark, now());
          }
        },
      };
    },
    dispose: () => {
      for (const type of NATIVE_CONTEXT_MENU_INPUT_EVENTS) {
        input?.removeEventListener(type, onInput, { capture: true });
      }
    },
  };
}

/**
 * The state of the application. It listens on the window from the time this module loads, so
 * its listeners run before the listeners that the application mounts later (see above).
 */
export const nativeContextMenuState: NativeContextMenuState =
  createNativeContextMenuState({
    input: typeof window === "undefined" ? null : window,
  });

// A hot reload of this module in development makes a new state with new listeners. The old
// listeners go with the old state.
import.meta.hot?.dispose(() => {
  nativeContextMenuState.dispose();
});

/**
 * True while a modal layer of the page is open: a dialog, an alert dialog, a menu or a list
 * box (`MODAL_LAYER_SELECTOR`). False outside a document. A native context menu is not in the
 * document, so this test does not see it (`isPageOverlayOpen`).
 */
export function isModalLayerOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector(MODAL_LAYER_SELECTOR) !== null
  );
}

/**
 * True while an overlay of the page owns the keyboard and the commands: a modal layer in the
 * document (`isModalLayerOpen`), or a native context menu (`NativeContextMenuState`). The window
 * keyboard layer and the command items of the macOS menu do nothing while it is true (ADR 021).
 *
 * @param state The state of the native context menus. The state of the application by default.
 * @param hasModalLayer The test for a modal layer. `isModalLayerOpen` by default.
 */
export function isPageOverlayOpen(
  state: NativeContextMenuState = nativeContextMenuState,
  hasModalLayer: () => boolean = isModalLayerOpen,
): boolean {
  return hasModalLayer() || state.isOpen();
}
