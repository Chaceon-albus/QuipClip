import { useEffect, useState } from "react";
import { applyWindowFocus, getWindowFocusRoot } from "./windowFocusAttribute";
import {
  DEFAULT_WINDOW_STATE,
  startWindowStateSync,
  type WindowState,
} from "./windowStateSync";

/** The window states that the caller needs. The focus state is always read. */
export interface WindowStateTracking {
  /** Read the maximized state. The Windows title bar needs it for its maximize button. */
  readonly trackMaximized: boolean;
  /** Read the full-screen state. The macOS title bar needs it for its left reserve. */
  readonly trackFullscreen: boolean;
}

/**
 * The maximized state, the full-screen state and the focus state of the native window.
 * Outside Tauri, the window is not maximized, not in full screen, and has the focus.
 *
 * A state that is not tracked keeps its default value. A change of either flag restarts the
 * sync.
 *
 * The hook also writes the focus state on <html> (`windowFocusAttribute.ts`), so every part of
 * the window can dim while the window does not have the focus. The title bar is the one
 * caller of the hook, so the window has one focus listener and one writer of the attribute.
 */
export function useWindowState({
  trackMaximized,
  trackFullscreen,
}: WindowStateTracking): WindowState {
  const [maximized, setMaximized] = useState(DEFAULT_WINDOW_STATE.maximized);
  const [focused, setFocused] = useState(DEFAULT_WINDOW_STATE.focused);
  const [fullscreen, setFullscreen] = useState(DEFAULT_WINDOW_STATE.fullscreen);

  useEffect(
    () =>
      startWindowStateSync({
        trackMaximized,
        trackFullscreen,
        onMaximizedChange: setMaximized,
        onFocusedChange: setFocused,
        onFullscreenChange: setFullscreen,
      }),
    [trackMaximized, trackFullscreen],
  );

  useEffect(() => {
    applyWindowFocus(getWindowFocusRoot(), focused);
  }, [focused]);

  // An unmount leaves the window in the active state, so no stale attribute dims the chrome.
  useEffect(() => () => applyWindowFocus(getWindowFocusRoot(), true), []);

  return { maximized, focused, fullscreen };
}
