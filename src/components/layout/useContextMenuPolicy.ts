import { useEffect } from "react";
import {
  describeContextMenuTarget,
  shouldSuppressContextMenu,
} from "./contextMenuPolicy";

/**
 * Mounts the context menu rule of `contextMenuPolicy.ts` for the lifetime of the application.
 *
 * The listener is on the window in the bubble phase, so it runs after every handler of the
 * page. A component that draws a menu of its own cancels the event in its handler, and the
 * web view then opens no menu. A listener in the capture phase would cancel the event before
 * such a handler runs, and a Radix context menu does not open for an event that is already
 * cancelled. Only a release build cancels most events, so that fault would not show in a
 * development build.
 *
 * The key that opens a menu from the keyboard, such as Shift+F10 or the Menu key on Windows,
 * sends the same event with the focused element as its target, so the same rule applies.
 */
export function useContextMenuPolicy(): void {
  useEffect(() => {
    const isDevBuild = import.meta.env.DEV;

    const onContextMenu = (event: MouseEvent) => {
      if (
        shouldSuppressContextMenu(describeContextMenuTarget(event.target), isDevBuild)
      ) {
        event.preventDefault();
      }
    };

    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);
}
