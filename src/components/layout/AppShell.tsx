import { useEffect, useRef } from "react";
import { DropOverlay } from "@/components/layout/DropOverlay";
import { startExportAttentionSync } from "@/components/layout/exportAttentionSync";
import { ProjectOpenDialog } from "@/components/layout/ProjectOpenDialog";
import { ProjectSaveErrorDialog } from "@/components/layout/ProjectSaveErrorDialog";
import { QuitGuardDialog } from "@/components/layout/QuitGuardDialog";
import { RecoveryPromptDialog } from "@/components/layout/RecoveryPromptDialog";
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
import { ExportOrderDialog } from "@/components/timeline/ExportOrderDialog";
import { SegmentRenameDialog } from "@/components/timeline/SegmentRenameDialog";
import { TimelinePanel } from "@/components/timeline/TimelinePanel";
import { TransportBar } from "@/components/transport/TransportBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startExportQueueRecovery } from "@/features/export/recovery";
import { startPageRecovery } from "@/features/recovery/pageController";
import { usePreferenceSync } from "@/features/settings/preferenceSync";
import { useSettingsChangedSync } from "@/features/settings/settingsSync";
import { useSettingsWindowDraftMirror } from "@/features/settings/settingsWindowDraft";
import { useSequencePlaybackStore } from "@/features/sequence";

export function AppShell() {
  useKeyboardShortcuts();
  // The web view opens its context menu only in a text field. A development build keeps it
  // everywhere except on the preview media.
  useContextMenuPolicy();
  // The Open, Save, Save As, Export and Export Frame items of the macOS menu run the commands of
  // their keys, under the same conditions.
  useNativeMenuActions();
  // Every close request and every held-back exit request runs the quit decision (ADR 027).
  useQuitGuard();
  // The Settings window is a window of its own. These keep this window on the settings
  // document and the preferences that it writes, and on the name of its unsaved preset
  // draft, which the quit decision reads.
  useSettingsChangedSync();
  usePreferenceSync();
  useSettingsWindowDraftMirror();

  // Rebuild the export queue that the backend still runs after a page reload (ADR 049). It
  // runs once per page. The status views and the quit guard read the restored stores.
  useEffect(() => startExportQueueRecovery(), []);
  // Start the recovery session of the page (ADR 073): the recovery file of the work that is not
  // saved, and the offers of the work that an earlier exit kept. The start runs one time, also
  // when StrictMode runs this effect two times, and nothing stops it: only a confirmed quit ends
  // the session.
  useEffect(() => {
    startPageRecovery();
  }, []);
  // Mirror the export progress on the Dock and the task bar (ADR 025).
  useEffect(() => startTaskbarProgressSync(), []);
  // Bounce the Dock icon or flash the task bar button when an export ends in the background.
  useEffect(() => startExportAttentionSync(), []);
  // Name the open file, or the project file (ADR 072), in the native window title, which the
  // system shows outside the window.
  useEffect(() => startWindowTitleSync(), []);

  const runtimeBrowserDurationSeconds = useSequencePlaybackStore(
    (state) => state.runtimeBrowserDurationSeconds,
  );
  const seekApproximate = useSequencePlaybackStore((state) => state.seekApproximate);
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
        {/* The one mount of the Rename Segment dialog (ADR 065). The F2 key and the item of the
            segment menu open it through its store. */}
        <SegmentRenameDialog />
        {/* The one mount of the Export Order dialog (ADR 066). Its key and the segment summary
            in the gutter of the track row open it through its store. */}
        <ExportOrderDialog />
        {/* The one mount of the project dialog (ADR 072): the progress of the open of a project,
            the files to locate, and the error of an open. The open step of the quit guard
            drives it through its store. */}
        <ProjectOpenDialog />
        {/* The one mount of the recovery prompt (ADR 073). It shows for the work that an exit
            that did not ask kept, while no other dialog is open. A quit prompt opens above it. */}
        <RecoveryPromptDialog />
        {/*
         * The one mount of the quit guard dialog. Its portal opens after any dialog that is
         * already open, so it draws above the export dialog and the project dialog.
         */}
        <QuitGuardDialog />
        {/* The one mount of the dialog of a save that failed (ADR 072). The Save action and the
            save prompt of the quit guard report the error through its store. It opens after the
            quit guard dialog, so it draws above it. */}
        <ProjectSaveErrorDialog />
      </div>
    </TooltipProvider>
  );
}
