import { useEffect } from "react";
import { isSystemFileDialogOpen } from "@/lib/systemFileDialog";
import { BACKEND_EVENTS, listenWindowEvent, type UnlistenFn } from "@/lib/ipc";
import { isPageOverlayOpen } from "./nativeContextMenuState";
import { planNativeMenuCommand } from "./nativeMenuActions";
import { readShortcutSnapshot, runShortcutCommand } from "./useKeyboardShortcuts";

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
 * True while a file dialog of the system that the main window opened is open: the Open Media
 * dialog, the save dialog of a project, the save dialog of an export, or the save dialog of
 * Export Frame (`isSystemFileDialogOpen`). A menu item does nothing then: it would queue a second
 * dialog behind the first one, or change the state under an open save dialog.
 */
export function isNativeMenuFileDialogOpen(): boolean {
  return isSystemFileDialogOpen();
}

/**
 * Runs the command of one menu event, with the conditions of the window keyboard layer
 * (`planNativeMenuCommand`). The state is read when the event arrives.
 */
export function runNativeMenuAction(payload: unknown): void {
  const command = planNativeMenuCommand(
    payload,
    {
      // The test of the window keyboard layer. A native context menu, such as the menu of a
      // timeline segment, counts as an open menu.
      isOverlayOpen: isPageOverlayOpen(),
      isFileDialogOpen: isNativeMenuFileDialogOpen(),
    },
    readShortcutSnapshot(),
  );
  if (command !== null) {
    runShortcutCommand(command);
  }
}

/**
 * Runs the command items of the macOS application menu that send their action: Open Media, Save,
 * Save As, Export and Export Frame. The Settings item opens the Settings window in Rust. Mount it once, in the
 * application shell.
 *
 * Only the macOS menu sends these events. On Windows the subscription exists and receives
 * nothing, which is cheaper to keep than a second platform test that could disagree with the
 * one in Rust.
 */
export function useNativeMenuActions(): void {
  useEffect(
    () =>
      // Rust sends the menu actions to the main window alone (`menu.rs`).
      startNativeMenuActionListener(runNativeMenuAction, (handler) =>
        listenWindowEvent<unknown>(BACKEND_EVENTS.MENU_ACTION, handler),
      ),
    [],
  );
}
