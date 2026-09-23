import { useEffect } from "react";
import { DropOverlay } from "@/components/layout/DropOverlay";
import { QuitGuardDialog } from "@/components/layout/QuitGuardDialog";
import { StatusBar } from "@/components/layout/StatusBar";
import { TitleBar } from "@/components/layout/TitleBar";
import { startTaskbarProgressSync } from "@/components/layout/taskbarProgressSync";
import { useKeyboardShortcuts } from "@/components/layout/useKeyboardShortcuts";
import { useQuitGuard } from "@/components/layout/useQuitGuard";
import { startWindowTitleSync } from "@/components/layout/windowTitleSync";
import { PreviewPane } from "@/components/preview/PreviewPane";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { TimelinePanel } from "@/components/timeline/TimelinePanel";
import { TransportBar } from "@/components/transport/TransportBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePlaybackStore } from "@/features/playback";

export function AppShell() {
  useKeyboardShortcuts();
  // Every close request and every held-back exit request runs the quit decision (ADR 027).
  useQuitGuard();

  // Mirror the export progress on the Dock and the task bar (ADR 025).
  useEffect(() => startTaskbarProgressSync(), []);
  // Name the open file in the native window title, which the system shows outside the window.
  useEffect(() => startWindowTitleSync(), []);

  const runtimeBrowserDurationSeconds = usePlaybackStore(
    (state) => state.runtimeBrowserDurationSeconds,
  );
  const seekApproximate = usePlaybackStore((state) => state.seekApproximate);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground select-none">
        <TitleBar />
        <PreviewPane />
        <TransportBar />
        <TimelinePanel
          runtimeBrowserDurationSeconds={runtimeBrowserDurationSeconds}
          onApproximateSeek={seekApproximate}
        />
        <StatusBar />
        {/*
         * The one mount of the settings dialog. The settings panel store opens it, so any
         * component can open it on a given tab. It is mounted here and not in the status bar,
         * because the status bar only holds one of its openers.
         */}
        <SettingsDialog />
        {/*
         * The one subscription to file drops on the window. The overlay holds the drag state
         * itself, so a drag renders the overlay and not the whole shell.
         */}
        <DropOverlay />
        {/*
         * The one mount of the quit guard dialog. Its portal opens after any dialog that is
         * already open, so it draws above a settings dialog that holds an unsaved draft.
         */}
        <QuitGuardDialog />
      </div>
    </TooltipProvider>
  );
}
