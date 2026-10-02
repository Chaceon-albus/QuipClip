import { useEffect, useRef } from "react";
import { useContextMenuPolicy } from "@/components/layout/useContextMenuPolicy";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ffmpegStore } from "@/features/ffmpeg";
import { usePreferenceSync } from "@/features/settings/preferenceSync";
import { useSettingsChangedSync } from "@/features/settings/settingsSync";
import { startPageDropGuard } from "./pageDropGuard";
import { SettingsWindow } from "./SettingsWindow";

/**
 * The root of the Settings window. `main.tsx` renders it instead of `App` in the window with
 * the label `settings`, from the same entry chunk (ADR 032).
 *
 * It mounts what the Settings view needs and nothing of the editor. The window keyboard
 * layer, the quit guard, the menu listener, the status bar, the export interface, the file
 * drop and the title, taskbar and attention syncs belong to the main window alone: the quit
 * decision runs there (ADR 027), the keys of ADR 026 act on the timeline, and the macOS menu
 * sends its actions there.
 */
export function SettingsWindowRoot() {
  // The web view opens its context menu only in a text field, as in the main window.
  useContextMenuPolicy();
  // The main window writes the settings file too, for example the default preset of an
  // export, and it reads the preferences that this window changes.
  useSettingsChangedSync();
  usePreferenceSync();
  // A file dropped on this window must not replace the page and its unsaved draft.
  useEffect(() => startPageDropGuard(document), []);

  // The FFmpeg tab shows the capabilities, and the Presets tab marks the encoders that do not
  // work. An unforced probe is a cache hit in the usual case. A probe that this window forces
  // after a path change is announced to the main window, which takes it over.
  const probeStartedRef = useRef(false);
  useEffect(() => {
    if (probeStartedRef.current) {
      return;
    }
    probeStartedRef.current = true;
    void ffmpegStore.getState().startProbe();
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <SettingsWindow />
    </TooltipProvider>
  );
}
