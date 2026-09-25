import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_CONTEXT_MENU_GRACE_MS,
  createNativeContextMenuState,
  isModalLayerOpen,
  isPageOverlayOpen,
  nativeContextMenuState,
  type NativeContextMenuInputEvent,
  type NativeContextMenuInputTarget,
} from "./nativeContextMenuState";

/** A window stand-in: it records the listeners, and a test fires an input event on it. */
function createInput() {
  const listeners: {
    readonly type: string;
    readonly capture: boolean;
    readonly listener: (event: NativeContextMenuInputEvent) => void;
  }[] = [];
  const target: NativeContextMenuInputTarget = {
    addEventListener: (type, listener, options) => {
      listeners.push({ type, capture: options.capture, listener });
    },
    removeEventListener: (type, listener, options) => {
      const index = listeners.findIndex(
        (entry) =>
          entry.type === type &&
          entry.listener === listener &&
          entry.capture === options.capture,
      );
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    },
  };
  /** Fires one event on every listener, in the order of registration. */
  const fire = (type: "pointerdown" | "keydown", isTrusted = true) => {
    const event = {
      isTrusted,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    for (const entry of [...listeners]) {
      if (entry.type === type) {
        entry.listener(event);
      }
    }
    return event;
  };
  return { target, listeners, fire };
}

/** A state on a fake window and a manual clock. */
function createHarness() {
  const input = createInput();
  let time = 1_000;
  const state = createNativeContextMenuState({ input: input.target, now: () => time });
  return {
    state,
    input,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("createNativeContextMenuState", () => {
  it("is closed at the start", () => {
    expect(createNativeContextMenuState().isOpen()).toBe(false);
  });

  it("is open from open() until the mark closes", () => {
    const state = createNativeContextMenuState();
    const mark = state.open();
    expect(state.isOpen()).toBe(true);
    mark.close();
    expect(state.isOpen()).toBe(false);
  });

  it("closes a mark once, so a second call keeps a newer menu open", () => {
    const state = createNativeContextMenuState();
    const first = state.open();
    first.close();
    const second = state.open();
    first.close();
    expect(state.isOpen()).toBe(true);
    second.close();
    expect(state.isOpen()).toBe(false);
  });

  it("stays open while any of two menus is open", () => {
    const state = createNativeContextMenuState();
    const first = state.open();
    const second = state.open();
    first.close();
    expect(state.isOpen()).toBe(true);
    second.close();
    expect(state.isOpen()).toBe(false);
  });
});

describe("the fallback for a popup that never settles", () => {
  it("waits one second after the popup call", () => {
    expect(NATIVE_CONTEXT_MENU_GRACE_MS).toBe(1_000);
  });

  it("listens for presses and key presses on the window in the capture phase, at once", () => {
    const { input } = createHarness();
    // The listeners exist before the menu opens, so they come before the listeners that the
    // application mounts later, such as the window keyboard layer.
    expect(
      input.listeners.map(({ type, capture }) => ({ type, capture })),
    ).toStrictEqual([
      { type: "pointerdown", capture: true },
      { type: "keydown", capture: true },
    ]);
  });

  it("removes its listeners at dispose, for a hot reload", () => {
    const { state, input, advance } = createHarness();
    state.dispose();
    expect(input.listeners).toHaveLength(0);
    state.open().showing();
    advance(NATIVE_CONTEXT_MENU_GRACE_MS);
    input.fire("pointerdown");
    expect(state.isOpen()).toBe(true);
  });

  it("closes a showing mark at the first trusted press after the grace period", () => {
    const { state, input, advance } = createHarness();
    state.open().showing();
    advance(NATIVE_CONTEXT_MENU_GRACE_MS);
    input.fire("pointerdown");
    expect(state.isOpen()).toBe(false);
  });

  it("closes a showing mark at a trusted key press too", () => {
    const { state, input, advance } = createHarness();
    state.open().showing();
    advance(NATIVE_CONTEXT_MENU_GRACE_MS + 1);
    input.fire("keydown");
    expect(state.isOpen()).toBe(false);
  });

  it("finds the menu closed in the same event, in a listener that runs after its own", () => {
    const { state, input, advance } = createHarness();
    // The window keyboard layer, which mounts after the state, reads the overlay test in the
    // same key press.
    const seen: boolean[] = [];
    input.target.addEventListener(
      "keydown",
      () => {
        seen.push(isPageOverlayOpen(state, () => false));
      },
      { capture: true },
    );
    state.open().showing();
    input.fire("keydown");
    advance(NATIVE_CONTEXT_MENU_GRACE_MS);
    input.fire("keydown");
    // Within the grace period the menu still counts as open. After it, the event that proves
    // the close finds no open menu, so it keeps its normal meaning.
    expect(seen).toStrictEqual([true, false]);
  });

  it("keeps the mark within the grace period, while the popup call is on its way", () => {
    const { state, input, advance } = createHarness();
    state.open().showing();
    input.fire("pointerdown");
    advance(NATIVE_CONTEXT_MENU_GRACE_MS - 1);
    input.fire("keydown");
    expect(state.isOpen()).toBe(true);
    // The events within the grace period do not count later either.
    advance(1);
    expect(state.isOpen()).toBe(true);
    input.fire("keydown");
    expect(state.isOpen()).toBe(false);
  });

  it("keeps a mark whose popup call was not sent, while the page builds the menu", () => {
    const { state, input, advance } = createHarness();
    const mark = state.open();
    advance(10 * NATIVE_CONTEXT_MENU_GRACE_MS);
    input.fire("pointerdown");
    input.fire("keydown");
    expect(state.isOpen()).toBe(true);
    mark.close();
    expect(state.isOpen()).toBe(false);
  });

  it("ignores an event that a script dispatched", () => {
    const { state, input, advance } = createHarness();
    state.open().showing();
    advance(NATIVE_CONTEXT_MENU_GRACE_MS);
    input.fire("pointerdown", false);
    input.fire("keydown", false);
    expect(state.isOpen()).toBe(true);
  });

  it("never cancels or stops the event, so it keeps its normal meaning", () => {
    const { state, input, advance } = createHarness();
    state.open().showing();
    advance(NATIVE_CONTEXT_MENU_GRACE_MS);
    const event = input.fire("pointerdown");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("does not open a mark again that closed first", () => {
    const { state, input, advance } = createHarness();
    const mark = state.open();
    mark.showing();
    mark.close();
    // A report after the close does nothing.
    mark.showing();
    advance(NATIVE_CONTEXT_MENU_GRACE_MS);
    input.fire("pointerdown");
    expect(state.isOpen()).toBe(false);
  });

  it("closes only the marks whose grace period has passed", () => {
    const { state, input, advance } = createHarness();
    state.open().showing();
    advance(NATIVE_CONTEXT_MENU_GRACE_MS);
    const newer = state.open();
    newer.showing();
    input.fire("pointerdown");
    expect(state.isOpen()).toBe(true);
    newer.close();
    expect(state.isOpen()).toBe(false);
  });
});

describe("isPageOverlayOpen", () => {
  it("is true while a modal layer or a native context menu is open", () => {
    const state = createNativeContextMenuState();
    expect(isPageOverlayOpen(state, () => false)).toBe(false);
    expect(isPageOverlayOpen(state, () => true)).toBe(true);
    const mark = state.open();
    expect(isPageOverlayOpen(state, () => false)).toBe(true);
    mark.close();
    expect(isPageOverlayOpen(state, () => false)).toBe(false);
  });

  it("reads the state of the application and the document by default", () => {
    // The window keyboard layer and the command items of the macOS menu call it with no
    // argument. The tests run with no document, so no modal layer is open.
    expect(isModalLayerOpen()).toBe(false);
    expect(isPageOverlayOpen()).toBe(false);
    const mark = nativeContextMenuState.open();
    try {
      expect(isPageOverlayOpen()).toBe(true);
    } finally {
      mark.close();
    }
    expect(isPageOverlayOpen()).toBe(false);
  });
});
