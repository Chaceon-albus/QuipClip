import { useEffect } from "react";
import { exportPanelStore } from "@/features/export";
import { mediaStore, openMediaFileDialog } from "@/features/media";
import { playbackStore } from "@/features/playback";
import { settingsPanelStore } from "@/features/settings/panelStore";
import { timelineStore, timelineViewportStore } from "@/features/timeline";
import { i18n } from "@/i18n";
import { runExportFlow } from "./exportFlowController";
import {
  MODAL_LAYER_SELECTOR,
  OPEN_TOOLTIP_SELECTOR,
  resolveShortcut,
  type ShortcutEventTarget,
  type ShortcutKeyEvent,
} from "./keyboardShortcutController";
import { quitGuard } from "./quitGuardController";
import { getShortcutPlatform } from "./shortcutBindings";
import {
  planShortcutCommand,
  type ShortcutCommand,
  type ShortcutSnapshot,
} from "./shortcutCommands";

/**
 * Performs one planned store call. Each case is the call that the matching control makes.
 */
function runShortcutCommand(command: ShortcutCommand): void {
  const playback = playbackStore.getState();
  const timeline = timelineStore.getState();
  switch (command.kind) {
    case "togglePlayback":
      playback.togglePlayback();
      return;
    case "seekNominal":
      playback.seekNominal(command.frames);
      return;
    case "seekToPts":
      playback.seekToPts(command.pts);
      return;
    case "seekApproximate":
      playback.seekApproximate(command.seconds);
      return;
    case "markIn":
      timeline.markIn(command.pts);
      return;
    case "markOut":
      timeline.markOut(command.pts);
      return;
    case "deleteSegment":
      timeline.deleteSegment();
      return;
    case "newSegment":
      timeline.newSegment();
      return;
    case "undo":
      timeline.undo();
      return;
    case "redo":
      timeline.redo();
      return;
    case "openMedia":
      // The call of the Open Media item of the title bar menu (`useOpenMediaAction`).
      void openMediaFileDialog({
        filterName: i18n.t("dialog.videoFilter"),
        importPath: quitGuard.requestOpen,
      });
      return;
    case "export":
      // The call of the Export button of the title bar.
      void runExportFlow({
        setModalOpen: exportPanelStore.getState().setOpen,
        filterName: i18n.t("dialog.videoFilter"),
      });
      return;
    case "openSettings":
      // The call of the settings button of the status bar.
      settingsPanelStore.getState().show();
      return;
    case "zoomIn":
      // The calls of the zoom buttons of the timeline. Each one anchors on the playhead when
      // it is in the visible lane, and on the centre of the visible lane otherwise.
      timelineViewportStore.getState().zoomIn();
      return;
    case "zoomOut":
      timelineViewportStore.getState().zoomOut();
      return;
    case "zoomToFit":
      timelineViewportStore.getState().fit();
      return;
  }
}

/** Mounts the window-level shortcut layer for the lifetime of the application. */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    // The platform does not change while the process runs.
    const platform = getShortcutPlatform();

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
      // A tooltip is not a modal layer, so it does not suppress the layer. It only takes
      // Escape first, so that Radix can close it.
      const isTooltipOpen =
        typeof document !== "undefined" &&
        document.querySelector(OPEN_TOOLTIP_SELECTOR) !== null;

      const shortcutEvent: ShortcutKeyEvent = {
        key: event.key,
        code: event.code,
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
        isTooltipOpen,
      };

      // One read of each store, so the condition the resolver tests and the call that runs
      // below come from the same state.
      const snapshot: ShortcutSnapshot = {
        probe: mediaStore.getState().media?.probe ?? null,
        playback: playbackStore.getState(),
        timeline: timelineStore.getState(),
        viewport: timelineViewportStore.getState(),
      };

      const resolution = resolveShortcut(shortcutEvent, {
        platform,
        isActionAvailable: (action) => planShortcutCommand(action, snapshot) !== null,
      });

      if (!resolution.claimed) {
        return;
      }

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
      if (resolution.action === null) {
        return;
      }

      const command = planShortcutCommand(resolution.action, snapshot);
      if (command !== null) {
        runShortcutCommand(command);
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
