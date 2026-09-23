import { useEffect, useState } from "react";
import {
  DEFAULT_WINDOW_STATE,
  startWindowStateSync,
  type WindowState,
} from "./windowStateSync";

/**
 * The maximized state and the focus state of the native window. Outside Tauri, the window
 * is not maximized and has the focus.
 *
 * A change of `trackMaximized` restarts the sync.
 */
export function useWindowState(trackMaximized: boolean): WindowState {
  const [maximized, setMaximized] = useState(DEFAULT_WINDOW_STATE.maximized);
  const [focused, setFocused] = useState(DEFAULT_WINDOW_STATE.focused);

  useEffect(
    () =>
      startWindowStateSync({
        trackMaximized,
        onMaximizedChange: setMaximized,
        onFocusedChange: setFocused,
      }),
    [trackMaximized],
  );

  return { maximized, focused };
}
