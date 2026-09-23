import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Settings, TriangleAlert } from "lucide-react";
import { ShortcutTooltipContent } from "@/components/common/ShortcutTooltipContent";
import { useShortcutLabels } from "@/components/common/useShortcutLabels";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFfmpegStore } from "@/features/ffmpeg";
import { useMediaStore } from "@/features/media";
import { usePlaybackStore, type PlaybackStoreState } from "@/features/playback";
import { useSettingsPanelStore } from "@/features/settings/panelStore";
import { getResolvedLanguage } from "@/i18n";
import { cn } from "@/lib/utils";
import { presentFfmpegStatus, selectFfmpegState } from "./ffmpegStatusPresenter";
import { ExportStatusIndicator } from "./ExportStatusIndicator";
import {
  presentPlaybackHint,
  selectCalibrationStatus,
  selectHasReadySource,
} from "./playbackHintPresenter";
import { presentSourceInfo } from "./sourceInfoPresenter";
import { statusBarItem } from "./statusBarItem";

/** A 16px tall vertical rule between two status bar items, like the export indicator's. */
const itemSeparatorClass = "h-4 bg-border data-vertical:self-center";

export function StatusBar() {
  const { t, i18n } = useTranslation();
  const media = useMediaStore((state) => state.media);
  const settingsOpen = useSettingsPanelStore((state) => state.open);
  const showSettings = useSettingsPanelStore((state) => state.show);
  // The key name comes from the binding table (ADR 026).
  const shortcutOf = useShortcutLabels();
  const settingsShortcut = shortcutOf("openSettings");

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

  const probe = media ? media.probe : null;
  const sourceInfo = useMemo(
    () => presentSourceInfo(probe, numberFormatter),
    [probe, numberFormatter],
  );

  // The presenters return typed keys with plain string values. This view of `t` accepts
  // them without a cast at each call.
  const translate = t as (
    key: string,
    options?: Readonly<Record<string, string>>,
  ) => string;

  // A missing or failed ffmpeg, or one with no working encoder, cannot export. The item then
  // becomes a warning chip with an icon.
  const ffmpegWarning = statusView.tone === "warning";

  // Layout, from left to right:
  //
  // - Left group: the open source and the approximate-position chip. The chip comes right
  //   after the source, because it is the only place that says why Mark In, Mark Out, and
  //   Split are unavailable. The group takes the free width and clips what does not fit.
  // - Right group: the application services. FFmpeg, the export indicator, and the settings
  //   button. The group never shrinks.
  //
  // A vertical separator divides two items. A middle dot only joins two values inside one
  // item, such as `1920 × 1080 · 29.97 fps`.
  //
  // The footer is a size container, so the text of the least important items collapses
  // first when the bar is narrow. The window is never narrower than 1024px, and at that
  // width every item shows its text. Below 56rem (896px), the ready or pending FFmpeg label
  // becomes a status dot. Below 48rem (768px), the approximate-position chip and a warning
  // FFmpeg chip keep only their icons. A collapsed label stays in the accessibility tree as
  // `sr-only` text, so the accessible name of each item does not change.
  //
  // The right padding is 8px, not 12px: a 16px glyph centred in the 24px settings button
  // adds a 4px inset, so the glyph sits 12px from the edge. The left group moves 6px to the
  // left, into the 12px left padding, so the text of its first item, inside its own 6px
  // padding, also sits 12px from the edge.
  return (
    <footer className="@container flex h-7 shrink-0 items-center gap-3 border-t border-border bg-sidebar pr-2 pl-3 text-xs text-muted-foreground select-none">
      {/* Left: the open source and its playback-position state */}
      <div className="-ml-1.5 flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {sourceInfo && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Focusable with no role: the item has no action, and a keyboard user must
                  still be able to open its tooltip. */}
              <span tabIndex={0} className={cn(statusBarItem(), "shrink-0")}>
                <span className="min-w-0 truncate">
                  {translate(sourceInfo.lineKey, sourceInfo.lineValues)}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-md flex-col items-start gap-1 text-xs">
              {sourceInfo.detail.map((entry) => (
                <p key={entry.key}>{translate(entry.key, entry.values)}</p>
              ))}
            </TooltipContent>
          </Tooltip>
        )}

        {sourceInfo && playbackHint && (
          <Separator orientation="vertical" className={itemSeparatorClass} />
        )}

        {/*
         * Approximate-position hint. The timeline playhead carries no visual mark for this
         * state, so this chip is the only place that reports it. The icon and the words
         * carry the state, so colour is not the only cue.
         */}
        {playbackHint && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Focusable with no role, for the same reason as the source item. */}
              <span
                tabIndex={0}
                className={cn(statusBarItem({ tone: playbackHint.tone }), "shrink-0")}
                data-tone={playbackHint.tone}
              >
                <TriangleAlert
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-warning-text"
                />
                <span className="min-w-0 truncate @max-3xl:sr-only">
                  {t(playbackHint.lineKey)}
                </span>
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

      {/* Right: FFmpeg, the export indicator, and the Settings button */}
      <div className="flex shrink-0 items-center">
        {/*
         * The FFmpeg item opens Settings on its FFmpeg tab, which shows the complete status
         * and every detail line. The tooltip keeps a short summary. Its label can shrink:
         * the short version has at most 12 characters, and the label truncates at 12rem.
         */}
        <Tooltip>
          <TooltipTrigger asChild>
            {/* No aria-expanded: the gear carries the open state of the shared dialog, and
                two controls that report one dialog as expanded contradict each other. */}
            <button
              type="button"
              aria-haspopup="dialog"
              className={statusBarItem({
                tone: ffmpegWarning ? "warning" : "neutral",
                interactive: true,
              })}
              data-tone={statusView.tone}
              onClick={() => {
                showSettings("ffmpeg");
              }}
            >
              {ffmpegWarning ? (
                <TriangleAlert
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-warning-text"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className={cn(
                    "hidden size-2 shrink-0 rounded-full @max-4xl:block",
                    statusView.tone === "ready"
                      ? "bg-success"
                      : "bg-muted-foreground motion-safe:animate-pulse",
                  )}
                />
              )}
              <span
                className={cn(
                  "max-w-48 min-w-0 truncate",
                  ffmpegWarning ? "@max-3xl:sr-only" : "@max-4xl:sr-only",
                )}
              >
                {translate(statusView.labelKey, statusView.labelValues)}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-md flex-col items-start gap-1 text-xs">
            {statusView.summary.map((entry) => (
              <p key={entry.id} className="wrap-anywhere">
                {translate(entry.key, entry.values)}
              </p>
            ))}
            <p>{t("statusBar.ffmpeg.settingsHint")}</p>
          </TooltipContent>
        </Tooltip>
        <Separator
          orientation="vertical"
          className={cn("mx-1.5", itemSeparatorClass)}
        />

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
              aria-keyshortcuts={settingsShortcut?.aria}
              onClick={() => {
                showSettings();
              }}
            >
              <Settings className="size-4" strokeWidth={1.75} />
            </Button>
          </TooltipTrigger>
          <ShortcutTooltipContent
            label={t("statusBar.settings")}
            keys={settingsShortcut?.keys}
          />
        </Tooltip>
      </div>
    </footer>
  );
}
