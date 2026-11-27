import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { mediaStore } from "@/features/media";
import {
  resolveFileDropEvent,
  type DroppedPathsClassification,
} from "./fileDropPresenter";
import { fileDropTargetStore, resolveDropTarget } from "./fileDropTarget";
import { MODAL_LAYER_SELECTOR } from "./keyboardShortcutController";
import { quitGuard } from "./quitGuardController";

/**
 * True when a drop must not open a file: a modal layer is open, an import is loading, or the quit
 * guard would refuse the request (`canOpen`: a prompt shows, a flow runs, or the quit started).
 *
 * The modal test is the one the keyboard layer applies (ADR 021), so a drop and a key press
 * stop at the same layers. The test of the guard keeps the overlay from saying that a release
 * opens a file that the guard would not take.
 */
function isFileDropBlocked(): boolean {
  const isModalLayerOpen =
    typeof document !== "undefined" &&
    document.querySelector(MODAL_LAYER_SELECTOR) !== null;
  return (
    isModalLayerOpen ||
    mediaStore.getState().status === "loading" ||
    !quitGuard.canOpen()
  );
}

/**
 * Opens the files that the user drops on the window, and returns what the drop overlay shows.
 *
 * The hook subscribes once to the drag-drop events of the Tauri web view. A drop gives its files
 * to `requestOpen` of the quit guard as one request, as the Open action does with the files of
 * its dialog (ADR 072). Each video becomes a clip (ADR 052): at the junction under the pointer
 * when the drop lands on the track lane, else at the end of the sequence. The import validates
 * it as the dialog does. One project file alone opens that project, with no index. A project
 * file with other files goes as one request with no index too, and the quit guard shows that a
 * project file opens alone.
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
        // The junction under the pointer, while the drag of videos is over the track lane
        // (ADR 052). A project file does not use the place of the pointer (ADR 072). The
        // position of the event is in physical pixels of the web view.
        const position = "position" in event.payload ? event.payload.position : null;
        const scale = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
        const target =
          position === null || !step.atPointer
            ? null
            : resolveDropTarget(position.x / scale, position.y / scale);
        const nextTarget =
          event.payload.type === "drop" || event.payload.type === "leave"
            ? null
            : target;
        const shown = fileDropTargetStore.getState().target;
        if (
          nextTarget?.junction !== shown?.junction ||
          nextTarget?.leftPercent !== shown?.leftPercent
        ) {
          fileDropTargetStore.setState({ target: nextTarget });
        }
        if (step.openPaths !== null) {
          void quitGuard.requestOpen(step.openPaths, target?.junction ?? null);
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
      fileDropTargetStore.setState({ target: null });
      unlisten?.();
      unlisten = null;
    };
  }, []);

  return overlay;
}
