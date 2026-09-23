import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BACKEND_EVENTS, listenEvent, type UnlistenFn } from "@/lib/ipc";
import { quitGuard } from "./quitGuardController";

/** The close request of the window, reduced to the one method the listener calls. */
export interface CloseRequest {
  preventDefault: () => void;
}

/** The two ways a quit reaches the frontend (ADR 027). A test passes fakes. */
export interface QuitRequestSources {
  /**
   * The close request of the window: the close button, `Alt+F4`, and the red window
   * button. Tauri destroys the window after the handler unless the handler cancels it.
   */
  onCloseRequested: (handler: (event: CloseRequest) => void) => Promise<UnlistenFn>;
  /** The application exit that Rust held back, such as a call of `exit`. */
  onQuitRequested: (handler: () => void) => Promise<UnlistenFn>;
}

/**
 * Returns the Tauri sources, or null when no Tauri window exists, for example in a plain
 * browser. Nothing can close the application there.
 */
export function createTauriQuitRequestSources(): QuitRequestSources | null {
  let appWindow: ReturnType<typeof getCurrentWindow>;
  try {
    appWindow = getCurrentWindow();
  } catch {
    return null;
  }
  return {
    onCloseRequested: (handler) => appWindow.onCloseRequested(handler),
    onQuitRequested: (handler) =>
      listenEvent<unknown>(BACKEND_EVENTS.QUIT_REQUESTED, () => {
        handler();
      }),
  };
}

/**
 * Subscribes `requestQuit` to both sources, and returns the function that releases them.
 *
 * The close handler always cancels the close request. The window then closes only through
 * `confirm_quit`, which ends the application. The handler cancels the request even after the
 * release: a subscription that resolves after the release still runs until it is released,
 * and a handler that did not cancel would let Tauri destroy the window with no decision.
 *
 * The subscriptions resolve after this returns. React StrictMode runs the release once before
 * that in development, so a subscription that resolves late is released at once.
 */
export function startQuitRequestListeners(
  requestQuit: () => void,
  sources: QuitRequestSources,
): () => void {
  let released = false;
  const unlistens: UnlistenFn[] = [];

  function hold(subscribe: () => Promise<UnlistenFn>): void {
    let subscription: Promise<UnlistenFn>;
    try {
      subscription = subscribe();
    } catch {
      // No Tauri runtime answered. Nothing is subscribed, so nothing is released.
      return;
    }
    subscription.then(
      (unlisten) => {
        if (released) {
          unlisten();
        } else {
          unlistens.push(unlisten);
        }
      },
      () => {
        // A refused subscription leaves that way to quit without the confirmation. The
        // window close then closes the window, and Rust lets the exit continue (ADR 027).
      },
    );
  }

  hold(() =>
    sources.onCloseRequested((event) => {
      event.preventDefault();
      if (!released) {
        requestQuit();
      }
    }),
  );
  hold(() =>
    sources.onQuitRequested(() => {
      if (!released) {
        requestQuit();
      }
    }),
  );

  return () => {
    released = true;
    for (const unlisten of unlistens.splice(0)) {
      unlisten();
    }
  };
}

/**
 * Routes every close request and every held-back exit request of the application to the
 * quit guard. Mount it once, in the application shell. `QuitGuardDialog` shows the prompt.
 */
export function useQuitGuard(): void {
  useEffect(() => {
    const sources = createTauriQuitRequestSources();
    if (sources === null) {
      return undefined;
    }
    return startQuitRequestListeners(() => {
      quitGuard.requestQuit();
    }, sources);
  }, []);
}
