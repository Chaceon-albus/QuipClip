import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFfmpegStore } from "@/features/ffmpeg";
import { useMediaStore } from "@/features/media";
import { usePlaybackStore, type PlaybackStoreState } from "@/features/playback";
import { useSettingsPanelStore } from "@/features/settings/panelStore";
import { getResolvedLanguage } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  presentFfmpegStatus,
  selectFfmpegState,
  type FfmpegStatusView,
} from "./ffmpegStatusPresenter";
import { ExportStatusIndicator } from "./ExportStatusIndicator";
import {
  presentPlaybackHint,
  selectCalibrationStatus,
  selectHasReadySource,
  type PlaybackHintView,
} from "./playbackHintPresenter";

/**
 * Tone of any line this footer renders. It is the union of the tones of both presenters, so
 * each presenter's tone is checked against its own type and neither can break the other by
 * renaming a member of its union.
 */
type StatusBarTone = FfmpegStatusView["tone"] | PlaybackHintView["tone"];

const toneClasses: Record<StatusBarTone, string> = {
  neutral: "text-muted-foreground",
  ready: "text-muted-foreground",
  warning: "text-warning-text",
};

export function StatusBar() {
  const { t, i18n } = useTranslation();
  const media = useMediaStore((state) => state.media);
  const settingsOpen = useSettingsPanelStore((state) => state.open);
  const showSettings = useSettingsPanelStore((state) => state.show);

  const probeStartedRef = useRef(false);
  const ffmpeg = useFfmpegStore(useShallow(selectFfmpegState));
  const startProbe = useFfmpegStore((state) => state.startProbe);

  // Probe ffmpeg readiness once on mount with StrictMode guard
  useEffect(() => {
    if (probeStartedRef.current) {
      return;
    }
    probeStartedRef.current = true;
    void startProbe();
  }, [startProbe]);

  const resolvedLanguage = getResolvedLanguage(i18n);

  const listFormatter = useMemo(
    () =>
      new Intl.ListFormat(resolvedLanguage, {
        style: "long",
        type: "unit",
      }),
    [resolvedLanguage],
  );

  const numberFormatter = useMemo(
    () =>
      new Intl.NumberFormat(resolvedLanguage, {
        maximumFractionDigits: 3,
      }),
    [resolvedLanguage],
  );

  const statusView = useMemo(
    () =>
      presentFfmpegStatus(ffmpeg, {
        list: listFormatter,
        number: numberFormatter,
      }),
    [ffmpeg, listFormatter, numberFormatter],
  );

  const hasMedia = media !== null;
  // The playback store notifies once per presented frame. One primitive selector per fact,
  // the way TransportBar reads the same store, keeps this footer off that render path without
  // allocating a state object for each notification.
  const hasReadySource = usePlaybackStore((state: PlaybackStoreState) =>
    selectHasReadySource(state, hasMedia),
  );
  const calibrationStatus = usePlaybackStore(selectCalibrationStatus);
  const playbackHint = useMemo(
    () => presentPlaybackHint({ hasReadySource, calibrationStatus }),
    [hasReadySource, calibrationStatus],
  );

  const width = media ? media.probe.width : 1920;
  const height = media ? media.probe.height : 1080;
  const fpsNumber = media?.probe.avgFrameRate
    ? media.probe.avgFrameRate.n / media.probe.avgFrameRate.d
    : media?.probe.rFrameRate
      ? media.probe.rFrameRate.n / media.probe.rFrameRate.d
      : null;

  // A frame size is a technical identifier, not a counted quantity, so it keeps its defined
  // format and never takes digit grouping: 1920 × 1080, never 1,920 × 1,080. The frame rate
  // below IS a measured quantity and stays with `Intl`.
  const formattedWidth = String(width);
  const formattedHeight = String(height);
  const formattedFps = fpsNumber === null ? null : numberFormatter.format(fpsNumber);
  const statusLineText = (
    t as (key: string, options?: Record<string, string>) => string
  )(statusView.lineKey, statusView.lineValues);

  // The right padding is 8px, not 12px: a 16px glyph centred in the 24px settings button
  // adds a 4px inset, so the glyph sits 12px from the edge, the same inset as the left text.
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-sidebar pr-2 pl-3 text-xs text-muted-foreground select-none">
      {/* Left: Project resolution and reported source-rate metadata */}
      <div className="flex items-center gap-4">
        <span>
          {t("statusBar.projectResolution", {
            width: formattedWidth,
            height: formattedHeight,
          })}
        </span>
        <span>
          {formattedFps === null
            ? t("statusBar.sourceNominalRateUnavailable")
            : t("statusBar.sourceNominalRate", { fps: formattedFps })}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              role="button"
              aria-label={statusLineText}
              className={cn(
                "cursor-default rounded-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
                toneClasses[statusView.tone],
              )}
              data-tone={statusView.tone}
            >
              {statusLineText}
            </span>
          </TooltipTrigger>
          <TooltipContent
            className={cn(
              "max-h-64 max-w-md flex-col items-start gap-1 overflow-y-auto text-xs",
            )}
          >
            <p className="font-semibold">{t("ffmpeg.detail.title")}</p>
            {statusView.detail.map((item) => (
              <p
                key={item.id}
                className={cn(item.mono && "font-mono break-all select-text")}
              >
                {t(item.key, {
                  defaultValue: t("ffmpegError.unknown"),
                  ...item.values,
                })}
              </p>
            ))}
          </TooltipContent>
        </Tooltip>

        {/*
         * Approximate-position hint. The timeline playhead carries no visual mark for this
         * state, so this line is the only place that reports it.
         */}
        {playbackHint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                role="button"
                aria-label={t(playbackHint.lineKey)}
                className={cn(
                  "cursor-default rounded-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
                  toneClasses[playbackHint.tone],
                )}
                data-tone={playbackHint.tone}
              >
                {t(playbackHint.lineKey)}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-md flex-col items-start gap-1 text-xs">
              {playbackHint.detail.map((key) => (
                <p key={key}>{t(key)}</p>
              ))}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Right: Export indicator and the Settings button */}
      <div className="flex items-center">
        <ExportStatusIndicator />
        {/*
         * Status bar sizing rule: a standalone icon button is a 24px box with a 16px glyph,
         * and an icon inline with text is 14px. The 24px controls fit the 28px bar without
         * making it taller. The dark: and aria-expanded: overrides replace the ghost
         * variant's neutral colours, so hover and the open dialog use the sidebar accent in
         * both themes, like the export indicator next to this button.
         *
         * The button opens the settings dialog directly. The dialog is mounted in AppShell,
         * so this button is not a Radix DialogTrigger and sets the two attributes that a
         * DialogTrigger would set.
         */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent"
              aria-label={t("statusBar.settings")}
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => {
                showSettings();
              }}
            >
              <Settings className="size-4" strokeWidth={1.75} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("statusBar.settings")}</TooltipContent>
        </Tooltip>
      </div>
    </footer>
  );
}
