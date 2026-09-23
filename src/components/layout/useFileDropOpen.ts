import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { mediaStore } from "@/features/media";
import {
  resolveFileDropEvent,
  type DroppedPathsClassification,
} from "./fileDropPresenter";
import { MODAL_LAYER_SELECTOR } from "./keyboardShortcutController";
import { quitGuard } from "./quitGuardController";

/**
 * True when a drop must not open a file: a modal layer is open, or an import is loading.
 *
 * The modal test is the one the keyboard layer applies (ADR 021), so a drop and a key press
 * stop at the same layers.
 */
function isFileDropBlocked(): boolean {
  const isModalLayerOpen =
    typeof document !== "undefined" &&
    document.querySelector(MODAL_LAYER_SELECTOR) !== null;
  return isModalLayerOpen || mediaStore.getState().status === "loading";
}

/**
 * Opens a video that the user drops on the window, and returns what the drop overlay shows.
 *
 * The hook subscribes once to the drag-drop events of the Tauri web view. A drop opens the
 * file through `requestOpen` of the quit guard, which is the call the Open Media dialog makes
 * after the user picks a file. The drop therefore replaces an open source exactly as the
 * dialog does: it asks first when the open source has segments (ADR 027), and the import
 * validates the file in the same way.
 *
 * @returns The classification the overlay shows, or null when the overlay is hidden.
 */
export function useFileDropOpen(): DroppedPathsClassification | null {
  const [overlay, setOverlay] = useState<DroppedPathsClassification | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let dragged: DroppedPathsClassification | null = null;

    let subscription: Promise<UnlistenFn>;
    try {
      subscription = getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) {
          return;
        }
        const step = resolveFileDropEvent(event.payload, dragged, isFileDropBlocked());
        dragged = step.dragged;
        setOverlay(step.overlay);
        if (step.openPath !== null) {
          void quitGuard.requestOpen(step.openPath);
        }
      });
    } catch {
      // No Tauri web view exists, for example in a plain browser. Nothing can be dropped.
      return;
    }

    // The subscription resolves after the effect returns. React StrictMode runs the cleanup
    // once before that in development, so a late subscription is released at once.
    subscription.then(
      (release) => {
        if (disposed) {
          release();
        } else {
          unlisten = release;
        }
      },
      () => {
        // A refused subscription leaves the window without drop support. Nothing else fails.
      },
    );

    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  }, []);

  return overlay;
}
