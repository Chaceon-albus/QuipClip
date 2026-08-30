import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaStore } from "@/features/media";
import {
  getLanguagePreference,
  getResolvedLanguage,
  type LanguagePreference,
} from "@/i18n";
import { createLanguageMenuController } from "./languageMenuController";

export function StatusBar() {
  const { t, i18n } = useTranslation();
  const media = useMediaStore((state) => state.media);
  const [preference, setPreference] = useState<LanguagePreference>(() =>
    getLanguagePreference(),
  );

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

  const handleLanguageChange = (value: string) => {
    void controller.requestPreference(value);
  };

  const resolvedLanguage = getResolvedLanguage(i18n);

  const numberFormatter = useMemo(
    () =>
      new Intl.NumberFormat(resolvedLanguage, {
        maximumFractionDigits: 3,
      }),
    [resolvedLanguage],
  );

  const width = media ? media.probe.width : 1920;
  const height = media ? media.probe.height : 1080;
  const fpsNumber = media
    ? media.probe.avgFrameRate.n / media.probe.avgFrameRate.d
    : 25;

  const formattedWidth = numberFormatter.format(width);
  const formattedHeight = numberFormatter.format(height);
  const formattedFps = numberFormatter.format(fpsNumber);

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-sidebar px-3 text-xs text-muted-foreground select-none">
      {/* Left: Project resolution and frame rate */}
      <div className="flex items-center gap-4">
        <span>
          {t("statusBar.projectResolution", {
            width: formattedWidth,
            height: formattedHeight,
          })}
        </span>
        <span>
          {t("statusBar.frameRate", {
            fps: formattedFps,
          })}
        </span>
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
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </footer>
  );
}
