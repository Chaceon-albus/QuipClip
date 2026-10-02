import { useEffect, useRef } from "react";
import { DropOverlay } from "@/components/layout/DropOverlay";
import { startExportAttentionSync } from "@/components/layout/exportAttentionSync";
import { QuitGuardDialog } from "@/components/layout/QuitGuardDialog";
import { StatusBar } from "@/components/layout/StatusBar";
import { TimelineArea } from "@/components/layout/TimelineArea";
import { TitleBar } from "@/components/layout/TitleBar";
import { startTaskbarProgressSync } from "@/components/layout/taskbarProgressSync";
import { useContextMenuPolicy } from "@/components/layout/useContextMenuPolicy";
import { useKeyboardShortcuts } from "@/components/layout/useKeyboardShortcuts";
import { useNativeMenuActions } from "@/components/layout/useNativeMenuActions";
import { useQuitGuard } from "@/components/layout/useQuitGuard";
import { startWindowTitleSync } from "@/components/layout/windowTitleSync";
import { PreviewPane } from "@/components/preview/PreviewPane";
import { TimelinePanel } from "@/components/timeline/TimelinePanel";
import { TransportBar } from "@/components/transport/TransportBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePlaybackStore } from "@/features/playback";
import { usePreferenceSync } from "@/features/settings/preferenceSync";
import { useSettingsChangedSync } from "@/features/settings/settingsSync";
import { useSettingsWindowDraftMirror } from "@/features/settings/settingsWindowDraft";

export function AppShell() {
  useKeyboardShortcuts();
  // The web view opens its context menu only in a text field. A development build keeps it
  // everywhere except on the preview media.
  useContextMenuPolicy();
  // The Open Media and Export items of the macOS menu run the commands of their keys, under
  // the same conditions.
  useNativeMenuActions();
  // Every close request and every held-back exit request runs the quit decision (ADR 027).
  useQuitGuard();
  // The Settings window is a window of its own. These keep this window on the settings
  // document and the preferences that it writes, and on the name of its unsaved preset
  // draft, which the quit decision reads.
  useSettingsChangedSync();
  usePreferenceSync();
  useSettingsWindowDraftMirror();

  // Mirror the export progress on the Dock and the task bar (ADR 025).
  useEffect(() => startTaskbarProgressSync(), []);
  // Bounce the Dock icon or flash the task bar button when an export ends in the background.
  useEffect(() => startExportAttentionSync(), []);
  // Name the open file in the native window title, which the system shows outside the window.
  useEffect(() => startWindowTitleSync(), []);

  const runtimeBrowserDurationSeconds = usePlaybackStore(
    (state) => state.runtimeBrowserDurationSeconds,
  );
  const seekApproximate = usePlaybackStore((state) => state.seekApproximate);
  const previewSlotRef = useRef<HTMLDivElement | null>(null);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground select-none">
        <TitleBar />
        {/*
         * The slot of the preview. It takes the height that the timeline area leaves, and the
         * timeline area measures it to find the largest timeline height. The slot has no
         * minimum of its own, so the minimum of the preview applies.
         */}
        <div ref={previewSlotRef} className="flex flex-1 flex-col">
          <PreviewPane />
        </div>
        <TransportBar />
        <TimelineArea previewRef={previewSlotRef}>
          <TimelinePanel
            runtimeBrowserDurationSeconds={runtimeBrowserDurationSeconds}
            onApproximateSeek={seekApproximate}
          />
        </TimelineArea>
        <StatusBar />
        {/*
         * The one subscription to file drops on the window. The overlay holds the drag state
         * itself, so a drag renders the overlay and not the whole shell.
         */}
        <DropOverlay />
        {/*
         * The one mount of the quit guard dialog. Its portal opens after any dialog that is
         * already open, so it draws above the export dialog.
         */}
        <QuitGuardDialog />
      </div>
    </TooltipProvider>
  );
}
