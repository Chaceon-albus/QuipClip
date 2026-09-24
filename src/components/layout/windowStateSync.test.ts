import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WINDOW_STATE,
  MAXIMIZED_QUERY_DELAY_MS,
  resolveMaximizeControl,
  startWindowStateSync,
  type WindowStateSource,
} from "./windowStateSync";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The sync tests run on fake timers, so this settles the pending promise callbacks without
// firing a throttle timer.
async function flushPromises(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Fires the trailing throttle timer of the maximized query. */
async function elapseThrottle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(MAXIMIZED_QUERY_DELAY_MS);
}

/**
 * A fake window. Each query returns a deferred promise that the test settles. The listener
 * registrations settle when the test calls `registerResize` or `registerFocus`.
 */
function createSource() {
  const maximizedQueries: Deferred<boolean>[] = [];
  const fullscreenQueries: Deferred<boolean>[] = [];
  const focusedQueries: Deferred<boolean>[] = [];
  const resizeRegistration = deferred<() => void>();
  const focusRegistration = deferred<() => void>();
  const unlistenResize = vi.fn();
  const unlistenFocus = vi.fn();
  let resizeHandler: (() => void) | null = null;
  let focusHandler: ((focused: boolean) => void) | null = null;

  const source: WindowStateSource = {
    isMaximized: vi.fn(() => {
      const query = deferred<boolean>();
      maximizedQueries.push(query);
      return query.promise;
    }),
    isFullscreen: vi.fn(() => {
      const query = deferred<boolean>();
      fullscreenQueries.push(query);
      return query.promise;
    }),
    isFocused: vi.fn(() => {
      const query = deferred<boolean>();
      focusedQueries.push(query);
      return query.promise;
    }),
    onResized: vi.fn((handler: () => void) => {
      resizeHandler = handler;
      return resizeRegistration.promise;
    }),
    onFocusChanged: vi.fn((handler: (focused: boolean) => void) => {
      focusHandler = handler;
      return focusRegistration.promise;
    }),
  };

  return {
    source,
    maximizedQueries,
    fullscreenQueries,
    focusedQueries,
    unlistenResize,
    unlistenFocus,
    async registerResize() {
      resizeRegistration.resolve(unlistenResize);
      await flushPromises();
    },
    async failResize() {
      resizeRegistration.reject(new Error("listen refused"));
      await flushPromises();
    },
    async registerFocus() {
      focusRegistration.resolve(unlistenFocus);
      await flushPromises();
    },
    resize() {
      resizeHandler?.();
    },
    focus(focused: boolean) {
      focusHandler?.(focused);
    },
  };
}

function setup(trackMaximized = true, trackFullscreen?: boolean) {
  const fake = createSource();
  const onMaximizedChange = vi.fn<(maximized: boolean) => void>();
  const onFocusedChange = vi.fn<(focused: boolean) => void>();
  const onFullscreenChange = vi.fn<(fullscreen: boolean) => void>();
  const stop = startWindowStateSync({
    source: fake.source,
    enabled: true,
    trackMaximized,
    trackFullscreen,
    onMaximizedChange,
    onFocusedChange,
    onFullscreenChange,
  });
  return { ...fake, onMaximizedChange, onFocusedChange, onFullscreenChange, stop };
}

/** The macOS title bar: the full-screen state and the focus state, and no maximized state. */
function setupMac() {
  return setup(false, true);
}

async function settle(query: Deferred<boolean> | undefined, value: boolean) {
  expect(query).toBeDefined();
  query?.resolve(value);
  await flushPromises();
}

describe("resolveMaximizeControl", () => {
  it("offers Maximize while the window is not maximized", () => {
    expect(resolveMaximizeControl(false)).toEqual({
      glyph: "maximize",
      labelKey: "window.maximize",
    });
  });

  it("offers Restore Down while the window is maximized", () => {
    expect(resolveMaximizeControl(true)).toEqual({
      glyph: "restore",
      labelKey: "window.restore",
    });
  });
});

describe("DEFAULT_WINDOW_STATE", () => {
  it("is a window that is not maximized, not in full screen, and has the focus", () => {
    expect(DEFAULT_WINDOW_STATE).toEqual({
      maximized: false,
      focused: true,
      fullscreen: false,
    });
  });
});

describe("startWindowStateSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("does nothing when it is not enabled", () => {
    const fake = createSource();
    const stop = startWindowStateSync({
      source: fake.source,
      enabled: false,
      trackMaximized: true,
      onMaximizedChange: vi.fn(),
      onFocusedChange: vi.fn(),
    });
    expect(fake.source.onResized).not.toHaveBeenCalled();
    expect(fake.source.onFocusChanged).not.toHaveBeenCalled();
    expect(fake.source.isMaximized).not.toHaveBeenCalled();
    expect(fake.source.isFocused).not.toHaveBeenCalled();
    stop();
  });

  it("reads the maximized state once after the resize listener registers", async () => {
    const sync = setup();
    expect(sync.source.isMaximized).not.toHaveBeenCalled();
    await sync.registerResize();
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(1);
    await settle(sync.maximizedQueries[0], true);
    expect(sync.onMaximizedChange).toHaveBeenLastCalledWith(true);
    sync.stop();
  });

  it("still reads the maximized state when the resize listener fails", async () => {
    const sync = setup();
    await sync.failResize();
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(1);
    await settle(sync.maximizedQueries[0], true);
    expect(sync.onMaximizedChange).toHaveBeenLastCalledWith(true);
    sync.stop();
  });

  it("reads the maximized state again after each resize, once the delay elapses", async () => {
    const sync = setup();
    await sync.registerResize();
    await settle(sync.maximizedQueries[0], false);
    sync.resize();
    await vi.advanceTimersByTimeAsync(MAXIMIZED_QUERY_DELAY_MS - 1);
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(2);
    await settle(sync.maximizedQueries[1], true);
    expect(sync.onMaximizedChange).toHaveBeenLastCalledWith(true);
    sync.resize();
    await elapseThrottle();
    await settle(sync.maximizedQueries[2], false);
    expect(sync.onMaximizedChange).toHaveBeenLastCalledWith(false);
    sync.stop();
  });

  it("folds a burst of resize events into one trailing query", async () => {
    const sync = setup();
    await sync.registerResize();
    for (let i = 0; i < 20; i++) {
      sync.resize();
      await vi.advanceTimersByTimeAsync(4);
    }
    // 80 ms passed, so the timer of the first event has not fired yet.
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(1);
    await elapseThrottle();
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(2);
    sync.stop();
  });

  it("sends at most one query per interval during a long resize, and one after the end", async () => {
    const sync = setup();
    await sync.registerResize();
    // A live resize of 450 ms with an event every 10 ms.
    for (let i = 0; i < 45; i++) {
      sync.resize();
      await vi.advanceTimersByTimeAsync(10);
    }
    // The initial read, plus one query at 100, 200, 300 and 400 ms.
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(5);
    // The events after 400 ms started a timer, so the state after the last event is read.
    await elapseThrottle();
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(6);
    await elapseThrottle();
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(6);
    sync.stop();
  });

  it("does not delay the read after the registration", async () => {
    const sync = setup();
    await sync.registerResize();
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(1);
    sync.stop();
  });

  it("reports only the newest maximized query when the queries settle out of order", async () => {
    const sync = setup();
    await sync.registerResize();
    sync.resize();
    await elapseThrottle();
    sync.resize();
    await elapseThrottle();
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(3);
    // The newest query settles first, and the older queries settle after it.
    await settle(sync.maximizedQueries[2], true);
    await settle(sync.maximizedQueries[1], false);
    await settle(sync.maximizedQueries[0], false);
    expect(sync.onMaximizedChange.mock.calls).toEqual([[true]]);
    sync.stop();
  });

  it("drops a pending throttled query when it stops", async () => {
    const sync = setup();
    await sync.registerResize();
    sync.resize();
    sync.stop();
    await elapseThrottle();
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a failed maximized query", async () => {
    const sync = setup();
    await sync.registerResize();
    sync.maximizedQueries[0]?.reject(new Error("command refused"));
    await flushPromises();
    expect(sync.onMaximizedChange).not.toHaveBeenCalled();
    sync.stop();
  });

  it("does not listen to resize events when it does not track the maximized state", async () => {
    const sync = setup(false);
    await sync.registerFocus();
    expect(sync.source.onResized).not.toHaveBeenCalled();
    expect(sync.source.isMaximized).not.toHaveBeenCalled();
    expect(sync.source.onFocusChanged).toHaveBeenCalledTimes(1);
    sync.stop();
  });

  it("reads the focus state once after the focus listener registers", async () => {
    const sync = setup();
    expect(sync.source.isFocused).not.toHaveBeenCalled();
    await sync.registerFocus();
    expect(sync.source.isFocused).toHaveBeenCalledTimes(1);
    await settle(sync.focusedQueries[0], false);
    expect(sync.onFocusedChange).toHaveBeenLastCalledWith(false);
    sync.stop();
  });

  it("reports each focus event", async () => {
    const sync = setup();
    await sync.registerFocus();
    await settle(sync.focusedQueries[0], true);
    sync.focus(false);
    sync.focus(true);
    expect(sync.onFocusedChange.mock.calls).toEqual([[true], [false], [true]]);
    sync.stop();
  });

  it("discards a focus query that a newer focus event overtook", async () => {
    const sync = setup();
    await sync.registerFocus();
    sync.focus(false);
    await settle(sync.focusedQueries[0], true);
    expect(sync.onFocusedChange.mock.calls).toEqual([[false]]);
    sync.stop();
  });

  it("removes each listener when it stops", async () => {
    const sync = setup();
    await sync.registerResize();
    await sync.registerFocus();
    sync.stop();
    expect(sync.unlistenResize).toHaveBeenCalledTimes(1);
    expect(sync.unlistenFocus).toHaveBeenCalledTimes(1);
  });

  it("removes a listener that registers after the stop, and reads nothing", async () => {
    const sync = setup();
    sync.stop();
    await sync.registerResize();
    await sync.registerFocus();
    expect(sync.unlistenResize).toHaveBeenCalledTimes(1);
    expect(sync.unlistenFocus).toHaveBeenCalledTimes(1);
    expect(sync.source.isMaximized).not.toHaveBeenCalled();
    expect(sync.source.isFocused).not.toHaveBeenCalled();
  });

  it("reports nothing after it stops", async () => {
    const sync = setup();
    await sync.registerResize();
    await sync.registerFocus();
    sync.resize();
    await elapseThrottle();
    sync.stop();
    await settle(sync.maximizedQueries[0], true);
    await settle(sync.maximizedQueries[1], true);
    await settle(sync.focusedQueries[0], false);
    sync.focus(false);
    sync.resize();
    await elapseThrottle();
    expect(sync.onMaximizedChange).not.toHaveBeenCalled();
    expect(sync.onFocusedChange).not.toHaveBeenCalled();
    expect(sync.source.isMaximized).toHaveBeenCalledTimes(2);
  });

  it("stops twice without a second unlisten", async () => {
    const sync = setup();
    await sync.registerResize();
    await sync.registerFocus();
    sync.stop();
    sync.stop();
    expect(sync.unlistenResize).toHaveBeenCalledTimes(1);
    expect(sync.unlistenFocus).toHaveBeenCalledTimes(1);
  });

  describe("the full-screen state", () => {
    it("is not read unless the caller tracks it", async () => {
      const sync = setup(true);
      await sync.registerResize();
      sync.resize();
      await elapseThrottle();
      expect(sync.source.isFullscreen).not.toHaveBeenCalled();
      expect(sync.onFullscreenChange).not.toHaveBeenCalled();
      sync.stop();
    });

    it("is read once after the resize listener registers, with no maximized read", async () => {
      const sync = setupMac();
      expect(sync.source.isFullscreen).not.toHaveBeenCalled();
      await sync.registerResize();
      expect(sync.source.isFullscreen).toHaveBeenCalledTimes(1);
      expect(sync.source.isMaximized).not.toHaveBeenCalled();
      await settle(sync.fullscreenQueries[0], true);
      expect(sync.onFullscreenChange).toHaveBeenLastCalledWith(true);
      sync.stop();
    });

    it("is still read when the resize listener fails", async () => {
      const sync = setupMac();
      await sync.failResize();
      expect(sync.source.isFullscreen).toHaveBeenCalledTimes(1);
      await settle(sync.fullscreenQueries[0], false);
      expect(sync.onFullscreenChange).toHaveBeenLastCalledWith(false);
      sync.stop();
    });

    it("is read again after the resize that ends a change into or out of full screen", async () => {
      const sync = setupMac();
      await sync.registerResize();
      await settle(sync.fullscreenQueries[0], false);

      sync.resize();
      await vi.advanceTimersByTimeAsync(MAXIMIZED_QUERY_DELAY_MS - 1);
      expect(sync.source.isFullscreen).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sync.source.isFullscreen).toHaveBeenCalledTimes(2);
      await settle(sync.fullscreenQueries[1], true);
      expect(sync.onFullscreenChange).toHaveBeenLastCalledWith(true);

      sync.resize();
      await elapseThrottle();
      await settle(sync.fullscreenQueries[2], false);
      expect(sync.onFullscreenChange).toHaveBeenLastCalledWith(false);
      sync.stop();
    });

    it("folds the resize events of the transition into one trailing query", async () => {
      const sync = setupMac();
      await sync.registerResize();
      for (let i = 0; i < 20; i++) {
        sync.resize();
        await vi.advanceTimersByTimeAsync(4);
      }
      expect(sync.source.isFullscreen).toHaveBeenCalledTimes(1);
      await elapseThrottle();
      expect(sync.source.isFullscreen).toHaveBeenCalledTimes(2);
      sync.stop();
    });

    it("reports only the newest query when the queries settle out of order", async () => {
      const sync = setupMac();
      await sync.registerResize();
      sync.resize();
      await elapseThrottle();
      await settle(sync.fullscreenQueries[1], true);
      await settle(sync.fullscreenQueries[0], false);
      expect(sync.onFullscreenChange.mock.calls).toEqual([[true]]);
      sync.stop();
    });

    it("shares one resize listener and one timer with the maximized state", async () => {
      const sync = setup(true, true);
      await sync.registerResize();
      expect(sync.source.onResized).toHaveBeenCalledTimes(1);
      expect(sync.source.isMaximized).toHaveBeenCalledTimes(1);
      expect(sync.source.isFullscreen).toHaveBeenCalledTimes(1);

      sync.resize();
      sync.resize();
      await elapseThrottle();
      expect(sync.source.isMaximized).toHaveBeenCalledTimes(2);
      expect(sync.source.isFullscreen).toHaveBeenCalledTimes(2);

      // Each state reports its own answer.
      await settle(sync.maximizedQueries[1], true);
      await settle(sync.fullscreenQueries[1], false);
      expect(sync.onMaximizedChange.mock.calls).toEqual([[true]]);
      expect(sync.onFullscreenChange.mock.calls).toEqual([[false]]);
      sync.stop();
    });

    it("ignores a failed query", async () => {
      const sync = setupMac();
      await sync.registerResize();
      sync.fullscreenQueries[0]?.reject(new Error("command refused"));
      await flushPromises();
      expect(sync.onFullscreenChange).not.toHaveBeenCalled();
      sync.stop();
    });

    it("reports nothing after the sync stops", async () => {
      const sync = setupMac();
      await sync.registerResize();
      sync.resize();
      sync.stop();
      await settle(sync.fullscreenQueries[0], true);
      await elapseThrottle();
      expect(sync.source.isFullscreen).toHaveBeenCalledTimes(1);
      expect(sync.onFullscreenChange).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
