import { describe, expect, it, vi } from "vitest";
import {
  WINDOW_INACTIVE_ATTRIBUTE,
  applyWindowFocus,
  getWindowFocusRoot,
  type WindowFocusRoot,
} from "./windowFocusAttribute";
import { startWindowStateSync, type WindowStateSource } from "./windowStateSync";

function fakeRoot(): WindowFocusRoot & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute: vi.fn((name: string, value: string) => {
      attributes.set(name, value);
    }),
    removeAttribute: vi.fn((name: string) => {
      attributes.delete(name);
    }),
  };
}

/** Settles the promise callbacks of the sync. */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("applyWindowFocus", () => {
  it("names the attribute that the window-inactive variant reads", () => {
    expect(WINDOW_INACTIVE_ATTRIBUTE).toBe("data-window-inactive");
  });

  it("sets the attribute while the window does not have the focus", () => {
    const root = fakeRoot();
    applyWindowFocus(root, false);
    expect(root.attributes.get(WINDOW_INACTIVE_ATTRIBUTE)).toBe("");
  });

  it("removes the attribute when the window has the focus again", () => {
    const root = fakeRoot();
    applyWindowFocus(root, false);
    applyWindowFocus(root, true);
    expect(root.attributes.has(WINDOW_INACTIVE_ATTRIBUTE)).toBe(false);
  });

  it("gives the same result for a repeated state", () => {
    const root = fakeRoot();
    applyWindowFocus(root, false);
    applyWindowFocus(root, false);
    expect(root.attributes.get(WINDOW_INACTIVE_ATTRIBUTE)).toBe("");
    applyWindowFocus(root, true);
    applyWindowFocus(root, true);
    expect(root.attributes.has(WINDOW_INACTIVE_ATTRIBUTE)).toBe(false);
  });

  it("does nothing with a null root", () => {
    expect(() => applyWindowFocus(null, false)).not.toThrow();
  });

  it("finds no root outside a document", () => {
    expect(getWindowFocusRoot()).toBeNull();
  });
});

describe("the inactive attribute follows the one focus listener", () => {
  function createSource(initiallyFocused: boolean) {
    let focusHandler: ((focused: boolean) => void) | null = null;
    const source: WindowStateSource = {
      isMaximized: () => Promise.resolve(false),
      isFullscreen: () => Promise.resolve(false),
      isFocused: vi.fn(() => Promise.resolve(initiallyFocused)),
      onResized: () => Promise.resolve(() => {}),
      onFocusChanged: vi.fn((handler: (focused: boolean) => void) => {
        focusHandler = handler;
        return Promise.resolve(() => {});
      }),
    };
    return {
      source,
      emitFocus: (focused: boolean) => {
        focusHandler?.(focused);
      },
    };
  }

  it("marks a window that starts without the focus, and clears the mark on focus", async () => {
    const root = fakeRoot();
    const { source, emitFocus } = createSource(false);
    const stop = startWindowStateSync({
      enabled: true,
      source,
      trackMaximized: false,
      onMaximizedChange: () => {},
      onFocusedChange: (focused) => applyWindowFocus(root, focused),
    });
    await flushPromises();

    expect(source.onFocusChanged).toHaveBeenCalledTimes(1);
    expect(root.attributes.get(WINDOW_INACTIVE_ATTRIBUTE)).toBe("");

    emitFocus(true);
    expect(root.attributes.has(WINDOW_INACTIVE_ATTRIBUTE)).toBe(false);

    emitFocus(false);
    expect(root.attributes.get(WINDOW_INACTIVE_ATTRIBUTE)).toBe("");

    stop();
  });

  it("writes nothing more after the sync stops", async () => {
    const root = fakeRoot();
    const { source, emitFocus } = createSource(true);
    const stop = startWindowStateSync({
      enabled: true,
      source,
      trackMaximized: false,
      onMaximizedChange: () => {},
      onFocusedChange: (focused) => applyWindowFocus(root, focused),
    });
    await flushPromises();
    expect(root.attributes.has(WINDOW_INACTIVE_ATTRIBUTE)).toBe(false);

    stop();
    emitFocus(false);
    expect(root.attributes.has(WINDOW_INACTIVE_ATTRIBUTE)).toBe(false);
  });
});
