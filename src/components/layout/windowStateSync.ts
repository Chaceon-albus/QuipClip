/**
 * Reads the maximized state, the full-screen state and the focus state of the native window
 * for the title bar.
 *
 * On Windows the application draws its own window buttons (ADR 020). The maximize button
 * shows the Restore glyph and label while the window is maximized. The title bar dims its
 * glyphs and its title while the window does not have the focus, as the system title bar
 * does.
 *
 * On macOS the system draws the three window buttons over the title bar, and the title bar
 * keeps a space free for them. In full screen the system hides them, so the title bar gives
 * that space back (`titleBarLayout.ts`).
 *
 * The permissions are in `core:default`: `core:window:default` allows `is_maximized`,
 * `is_fullscreen` and `is_focused`, and `core:event:default` allows `listen` and `unlisten`.
 */

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** The state of the window that the title bar shows. */
export interface WindowState {
  readonly maximized: boolean;
  readonly focused: boolean;
  readonly fullscreen: boolean;
}

/** The state before the first read, and the state outside Tauri. */
export const DEFAULT_WINDOW_STATE: WindowState = {
  maximized: false,
  focused: true,
  fullscreen: false,
};

export type MaximizeControl =
  | { readonly glyph: "maximize"; readonly labelKey: "window.maximize" }
  | { readonly glyph: "restore"; readonly labelKey: "window.restore" };

/** Pure mapping from the maximized state to the glyph and the label of the middle button. */
export function resolveMaximizeControl(maximized: boolean): MaximizeControl {
  return maximized
    ? { glyph: "restore", labelKey: "window.restore" }
    : { glyph: "maximize", labelKey: "window.maximize" };
}

type Unlisten = () => void;

/**
 * The trailing delay of the `isMaximized` and `isFullscreen` queries after a resize event, in
 * milliseconds. A live resize sends many events. The delay folds them into at most one query
 * of each state per interval.
 */
export const MAXIMIZED_QUERY_DELAY_MS = 100;

/** The window calls that the sync uses. Tests supply a fake. */
export interface WindowStateSource {
  readonly isMaximized: () => Promise<boolean>;
  readonly isFullscreen: () => Promise<boolean>;
  readonly isFocused: () => Promise<boolean>;
  readonly onResized: (handler: () => void) => Promise<Unlisten>;
  readonly onFocusChanged: (handler: (focused: boolean) => void) => Promise<Unlisten>;
}

export interface WindowStateSyncOptions {
  readonly onMaximizedChange: (maximized: boolean) => void;
  readonly onFocusedChange: (focused: boolean) => void;
  /** Receives the full-screen state. Only called while `trackFullscreen` is true. */
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
  /**
   * When false, the sync does not read the maximized state. The macOS title bar has no
   * maximize button.
   */
  readonly trackMaximized: boolean;
  /**
   * When true, the sync reads the full-screen state. Only the macOS title bar needs it.
   * Defaults to false.
   *
   * The sync listens to resize events only while it tracks the maximized state or the
   * full-screen state, because a live resize sends many events. A change into or out of full
   * screen ends with a resize event, because the window changes its size (tao sends one when
   * the change is complete), so the query after it reads the new state.
   */
  readonly trackFullscreen?: boolean;
  /** Defaults to the current Tauri window. */
  readonly source?: WindowStateSource;
  /** Defaults to `isTauri()`. When false, the sync does nothing. */
  readonly enabled?: boolean;
}

function currentWindowSource(): WindowStateSource {
  const current = getCurrentWindow();
  return {
    isMaximized: () => current.isMaximized(),
    isFullscreen: () => current.isFullscreen(),
    isFocused: () => current.isFocused(),
    onResized: (handler) => current.onResized(() => handler()),
    onFocusChanged: (handler) =>
      current.onFocusChanged(({ payload }) => handler(payload)),
  };
}

/** Calls `call` and turns a synchronous throw into a rejected promise. */
function attempt<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Listens to the window and reports its maximized state, its full-screen state and its focus
 * state. Returns the stop function.
 *
 * Each state is read once after its listener is registered, also when the registration
 * fails. A change before the registration is therefore not lost.
 *
 * A resize event has no maximized flag and no full-screen flag, so the sync sends an
 * `isMaximized` query and an `isFullscreen` query after it, for each state that it tracks. The
 * queries are throttled on the trailing edge: the first event starts a timer of
 * `MAXIMIZED_QUERY_DELAY_MS`, and the events before the timer fires add no query. The queries
 * therefore read the state after the last of those events, and an event after the queries
 * starts a new timer. The queries can settle out of order, so only the result of the newest
 * query of each state is reported.
 *
 * A focus event carries the new state. A focus query that was sent before the newest focus
 * event is older than that event, so its result is discarded.
 *
 * The listeners register asynchronously. If the sync stops before a registration settles,
 * the listener is removed when it settles. The stop function is therefore safe in the
 * StrictMode double mount. A failed call does not break the editor. The state then keeps its
 * last value.
 */
export function startWindowStateSync(options: WindowStateSyncOptions): () => void {
  if (!(options.enabled ?? isTauri())) {
    return () => {};
  }
  const source = options.source ?? currentWindowSource();
  const unlistens: Unlisten[] = [];
  let stopped = false;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  function register(listen: () => Promise<Unlisten>, afterRegister: () => void): void {
    attempt(listen).then(
      (unlisten) => {
        if (stopped) {
          unlisten();
          return;
        }
        unlistens.push(unlisten);
        afterRegister();
      },
      () => {
        if (!stopped) {
          afterRegister();
        }
      },
    );
  }

  /**
   * Returns the query of one state that a resize can change. Only the result of its newest
   * query is reported.
   */
  function resizeStateQuery(
    read: () => Promise<boolean>,
    report: (value: boolean) => void,
  ): () => void {
    let newestQuery = 0;
    return () => {
      if (stopped) {
        return;
      }
      newestQuery += 1;
      const query = newestQuery;
      attempt(read).then(
        (value) => {
          if (!stopped && query === newestQuery) {
            report(value);
          }
        },
        () => {},
      );
    };
  }

  const resizeQueries: (() => void)[] = [];
  if (options.trackMaximized) {
    resizeQueries.push(
      resizeStateQuery(() => source.isMaximized(), options.onMaximizedChange),
    );
  }
  if (options.trackFullscreen === true) {
    const onFullscreenChange = options.onFullscreenChange ?? (() => {});
    resizeQueries.push(
      resizeStateQuery(() => source.isFullscreen(), onFullscreenChange),
    );
  }

  if (resizeQueries.length > 0) {
    const queryResizeStates = () => {
      for (const query of resizeQueries) {
        query();
      }
    };
    const scheduleResizeQueries = () => {
      if (stopped || resizeTimer !== null) {
        return;
      }
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        queryResizeStates();
      }, MAXIMIZED_QUERY_DELAY_MS);
    };
    // The read after the registration is not delayed. Only the resize events are throttled.
    register(() => source.onResized(scheduleResizeQueries), queryResizeStates);
  }

  let focusEvents = 0;
  const queryFocused = () => {
    const eventsAtQuery = focusEvents;
    attempt(() => source.isFocused()).then(
      (focused) => {
        if (!stopped && eventsAtQuery === focusEvents) {
          options.onFocusedChange(focused);
        }
      },
      () => {},
    );
  };
  register(
    () =>
      source.onFocusChanged((focused) => {
        if (stopped) {
          return;
        }
        focusEvents += 1;
        options.onFocusedChange(focused);
      }),
    queryFocused,
  );

  return () => {
    stopped = true;
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    for (const unlisten of unlistens.splice(0)) {
      unlisten();
    }
  };
}
