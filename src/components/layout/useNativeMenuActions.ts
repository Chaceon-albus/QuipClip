import { useEffect } from "react";
import { isMediaFileDialogOpen } from "@/features/media";
import { BACKEND_EVENTS, listenEvent, type UnlistenFn } from "@/lib/ipc";
import { MODAL_LAYER_SELECTOR } from "./keyboardShortcutController";
import { planNativeMenuCommand } from "./nativeMenuActions";
import { readShortcutSnapshot, runShortcutCommand } from "./useKeyboardShortcuts";

/**
 * True while a modal layer of the page is open: a dialog, an alert dialog, a menu or a list
 * box. It is the test of the window keyboard layer (`MODAL_LAYER_SELECTOR`). False outside a
 * document.
 */
function isModalLayerOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector(MODAL_LAYER_SELECTOR) !== null
  );
}

/** Subscribes a handler to the menu events. A test passes a fake. */
export type NativeMenuSubscribe = (
  handler: (payload: unknown) => void,
) => Promise<UnlistenFn>;

/**
 * Subscribes `onPayload` to the menu events, and returns the function that releases the
 * subscription.
 *
 * The subscription resolves after this returns. React StrictMode runs the release once before
 * that in development, so a subscription that resolves late is released at once, and an event
 * that arrives after the release runs nothing. A refused subscription leaves the menu items
 * without an effect, which is also the state outside the Tauri shell.
 */
export function startNativeMenuActionListener(
  onPayload: (payload: unknown) => void,
  subscribe: NativeMenuSubscribe,
): () => void {
  let released = false;
  let unlisten: UnlistenFn | null = null;

  let subscription: Promise<UnlistenFn>;
  try {
    subscription = subscribe((payload) => {
      if (!released) {
        onPayload(payload);
      }
    });
  } catch {
    // No Tauri runtime answered. Nothing is subscribed, so nothing is released.
    return () => {
      released = true;
    };
  }
  subscription.then(
    (unlistenFn) => {
      if (released) {
        unlistenFn();
      } else {
        unlisten = unlistenFn;
      }
    },
    () => {
      // Nothing is subscribed, so nothing is released.
    },
  );

  return () => {
    released = true;
    const unlistenFn = unlisten;
    unlisten = null;
    unlistenFn?.();
  };
}

/**
 * Runs the command of one menu event, with the conditions of the window keyboard layer
 * (`planNativeMenuCommand`). The state is read when the event arrives.
 */
export function runNativeMenuAction(payload: unknown): void {
  const command = planNativeMenuCommand(
    payload,
    {
      isOverlayOpen: isModalLayerOpen(),
      isFileDialogOpen: isMediaFileDialogOpen(),
    },
    readShortcutSnapshot(),
  );
  if (command !== null) {
    runShortcutCommand(command);
  }
}

/**
 * Runs the command items of the macOS application menu: Settings, Open Media and Export. Mount
 * it once, in the application shell.
 *
 * Only the macOS menu sends these events. On Windows the subscription exists and receives
 * nothing, which is cheaper to keep than a second platform test that could disagree with the
 * one in Rust.
 */
export function useNativeMenuActions(): void {
  useEffect(
    () =>
      startNativeMenuActionListener(runNativeMenuAction, (handler) =>
        listenEvent<unknown>(BACKEND_EVENTS.MENU_ACTION, handler),
      ),
    [],
  );
}
