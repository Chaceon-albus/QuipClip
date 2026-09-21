import { useEffect } from "react";
import { mediaStore } from "@/features/media";
import { hasNominalFrameRate, playbackStore } from "@/features/playback";
import {
  MODAL_LAYER_SELECTOR,
  resolveShortcut,
  type ShortcutEventTarget,
  type ShortcutKeyEvent,
} from "./keyboardShortcutController";

/** Mounts the window-level shortcut layer for the lifetime of the application. */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      let target: ShortcutEventTarget | null = null;
      if (typeof Element !== "undefined" && event.target instanceof Element) {
        const element = event.target;
        target = {
          tagName: element.tagName,
          isContentEditable:
            typeof HTMLElement !== "undefined" && element instanceof HTMLElement
              ? element.isContentEditable
              : false,
          hasAncestorMatching: (selector: string) => element.closest(selector) !== null,
        };
      }

      const isOverlayOpen =
        typeof document !== "undefined" &&
        document.querySelector(MODAL_LAYER_SELECTOR) !== null;

      const shortcutEvent: ShortcutKeyEvent = {
        key: event.key,
        repeat: event.repeat,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        defaultPrevented: event.defaultPrevented,
        target,
        isOverlayOpen,
      };

      const media = mediaStore.getState().media;
      const playback = playbackStore.getState();

      const hasActiveSource = playback.isAttached && playback.isReady && media !== null;
      const hasNominalRate = hasNominalFrameRate(media?.probe);

      const resolution = resolveShortcut(shortcutEvent, {
        hasActiveSource,
        hasNominalRate,
      });

      if (resolution.claimed) {
        event.preventDefault();
        event.stopPropagation();

        // Claiming a key press means owning it completely. Cancelling the event is not
        // enough on its own: it stops the native operation of a plain button, which
        // happens on the key release, but a library that implements a key in its own
        // React handler never sees that the event was cancelled. Radix opens a dropdown
        // menu from `Enter` and `Space` in exactly such a handler, so without this call
        // one press of Space on a focused menu trigger both started playback and opened
        // the menu. Stopping propagation in the capture phase keeps the event from every
        // handler below, which is what "the layer owns this key" has to mean.
        //
        // The reach is bounded by the suppression rules: a key press inside a dialog, a
        // menu, a list box or a text field is never claimed, so this call never runs
        // there, and every widget of an open overlay keeps its own keys.
        switch (resolution.action) {
          case "togglePlayback":
            playback.togglePlayback();
            break;
          case "stepBackOneFrame":
            playback.seekNominal(-1);
            break;
          case "stepForwardOneFrame":
            playback.seekNominal(1);
            break;
          case null:
            break;
        }
      }
    };

    // Capture on window is the first position in the propagation path, so no handler
    // in between can consume the event first — that starvation is the bug being fixed.
    // Radix registers its Escape handler on document in the capture phase, and React
    // attaches its delegated listeners to the root container, so window capture is
    // ahead of both without depending on registration order.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, []);
}
