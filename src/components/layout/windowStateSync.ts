/**
 * Reads the maximized state and the focus state of the native window for the title bar.
 *
 * On Windows the application draws its own window buttons (ADR 020). The maximize button
 * shows the Restore glyph and label while the window is maximized. The title bar dims its
 * glyphs and its title while the window does not have the focus, as the system title bar
 * does.
 *
 * The permissions are in `core:default`: `core:window:default` allows `is_maximized` and
 * `is_focused`, and `core:event:default` allows `listen` and `unlisten`.
 */

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** The state of the window that the title bar shows. */
export interface WindowState {
  readonly maximized: boolean;
  readonly focused: boolean;
}

/** The state before the first read, and the state outside Tauri. */
export const DEFAULT_WINDOW_STATE: WindowState = { maximized: false, focused: true };

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
 * The trailing delay of the `isMaximized` query after a resize event, in milliseconds. A live
 * resize sends many events. The delay folds them into at most one query per interval.
 */
export const MAXIMIZED_QUERY_DELAY_MS = 100;

/** The window calls that the sync uses. Tests supply a fake. */
export interface WindowStateSource {
  readonly isMaximized: () => Promise<boolean>;
  readonly isFocused: () => Promise<boolean>;
  readonly onResized: (handler: () => void) => Promise<Unlisten>;
  readonly onFocusChanged: (handler: (focused: boolean) => void) => Promise<Unlisten>;
}

export interface WindowStateSyncOptions {
  readonly onMaximizedChange: (maximized: boolean) => void;
  readonly onFocusedChange: (focused: boolean) => void;
  /**
   * When false, the sync does not listen to resize events. The macOS title bar has no
   * maximize button, and a live resize sends many events.
   */
  readonly trackMaximized: boolean;
  /** Defaults to the current Tauri window. */
  readonly source?: WindowStateSource;
  /** Defaults to `isTauri()`. When false, the sync does nothing. */
  readonly enabled?: boolean;
}

function currentWindowSource(): WindowStateSource {
  const current = getCurrentWindow();
  return {
    isMaximized: () => current.isMaximized(),
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
 * Listens to the window and reports its maximized state and its focus state. Returns the stop
 * function.
 *
 * Each state is read once after its listener is registered, also when the registration
 * fails. A change before the registration is therefore not lost.
 *
 * A resize event has no maximized flag, so the sync sends an `isMaximized` query after it.
 * The query is throttled on the trailing edge: the first event starts a timer of
 * `MAXIMIZED_QUERY_DELAY_MS`, and the events before the timer fires add no query. The query
 * therefore reads the state after the last of those events, and an event after the query
 * starts a new timer. The queries can settle out of order, so only the result of the newest
 * query is reported.
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
  let maximizedTimer: ReturnType<typeof setTimeout> | null = null;

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

  if (options.trackMaximized) {
    let newestQuery = 0;
    const queryMaximized = () => {
      if (stopped) {
        return;
      }
      newestQuery += 1;
      const query = newestQuery;
      attempt(() => source.isMaximized()).then(
        (maximized) => {
          if (!stopped && query === newestQuery) {
            options.onMaximizedChange(maximized);
          }
        },
        () => {},
      );
    };
    const scheduleMaximizedQuery = () => {
      if (stopped || maximizedTimer !== null) {
        return;
      }
      maximizedTimer = setTimeout(() => {
        maximizedTimer = null;
        queryMaximized();
      }, MAXIMIZED_QUERY_DELAY_MS);
    };
    // The read after the registration is not delayed. Only the resize events are throttled.
    register(() => source.onResized(scheduleMaximizedQuery), queryMaximized);
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
    if (maximizedTimer !== null) {
      clearTimeout(maximizedTimer);
      maximizedTimer = null;
    }
    for (const unlisten of unlistens.splice(0)) {
      unlisten();
    }
  };
}
