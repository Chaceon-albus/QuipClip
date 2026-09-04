import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useFfmpegStore } from "@/features/ffmpeg";
import { useMediaStore } from "@/features/media";
import {
  getLanguagePreference,
  getResolvedLanguage,
  type LanguagePreference,
} from "@/i18n";
import { cn } from "@/lib/utils";
import { presentFfmpegStatus, type FfmpegStatusView } from "./ffmpegStatusPresenter";
import { createLanguageMenuController } from "./languageMenuController";

const toneClasses: Record<FfmpegStatusView["tone"], string> = {
  neutral: "text-muted-foreground",
  ready: "text-muted-foreground",
  warning: "text-warning",
};

export function StatusBar() {
  const { t, i18n } = useTranslation();
  const media = useMediaStore((state) => state.media);
  const [preference, setPreference] = useState<LanguagePreference>(() =>
    getLanguagePreference(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  const controller = useMemo(
    () =>
      createLanguageMenuController({
        instance: i18n,
        initialPreference: getLanguagePreference(),
        onPreferenceChange: setPreference,
      }),
    [i18n],
  );

  // Sync preference state when i18n language changes externally
  useEffect(() => {
    controller.activate();
    const handleLanguageChanged = () => {
      controller.handleLanguageChanged();
    };
    i18n.on("languageChanged", handleLanguageChanged);
    return () => {
      i18n.off("languageChanged", handleLanguageChanged);
      controller.deactivate();
    };
  }, [i18n, controller]);

  const probeStartedRef = useRef(false);
  const ffmpeg = useFfmpegStore();
  const startProbe = useFfmpegStore((state) => state.startProbe);

  // Probe ffmpeg readiness once on mount with StrictMode guard
  useEffect(() => {
    if (probeStartedRef.current) {
      return;
    }
    probeStartedRef.current = true;
    void startProbe();
  }, [startProbe]);

  const handleLanguageChange = (value: string) => {
    void controller.requestPreference(value);
  };

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

  const width = media ? media.probe.width : 1920;
  const height = media ? media.probe.height : 1080;
  const fpsNumber = media?.probe.avgFrameRate
    ? media.probe.avgFrameRate.n / media.probe.avgFrameRate.d
    : media?.probe.rFrameRate
      ? media.probe.rFrameRate.n / media.probe.rFrameRate.d
      : null;

  const formattedWidth = numberFormatter.format(width);
  const formattedHeight = numberFormatter.format(height);
  const formattedFps = fpsNumber === null ? null : numberFormatter.format(fpsNumber);
  const statusLineText = (
    t as (key: string, options?: Record<string, string>) => string
  )(statusView.lineKey, statusView.lineValues);

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-sidebar px-3 text-xs text-muted-foreground select-none">
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
      </div>

      {/* Right: Settings button and Language dropdown menu */}
      <div className="flex items-center">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  aria-label={t("statusBar.settings")}
                >
                  <Settings className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("statusBar.settings")}</TooltipContent>
          </Tooltip>

          <DropdownMenuContent
            align="end"
            side="top"
            sideOffset={6}
            className="min-w-44"
          >
            <DropdownMenuLabel>{t("settings.language.label")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={preference}
              onValueChange={handleLanguageChange}
            >
              <DropdownMenuRadioItem value="system">
                {t("settings.language.system")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="en">
                {t("settings.language.en")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="zh-CN">
                {t("settings.language.zhCN")}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
              {t("settings.title")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </div>
    </footer>
  );
}
