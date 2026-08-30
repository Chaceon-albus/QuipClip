import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown, Minus, Square, X } from "lucide-react";
import appIcon from "@/assets/brand/app-icon.svg";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { openMediaFileDialog, useMediaStore } from "@/features/media";
import { cn } from "@/lib/utils";

/**
 * Detect whether the client is running on macOS.
 * macOS uses native traffic light controls at the top left.
 */
function isMacOS(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
}

export function TitleBar() {
  const { t } = useTranslation();
  const isMac = isMacOS();
  const media = useMediaStore((state) => state.media);

  const handleOpenMedia = () => {
    void openMediaFileDialog({
      filterName: t("dialog.videoFilter"),
    });
  };

  const handleMinimize = () => {
    void getCurrentWindow().minimize();
  };

  const handleMaximize = () => {
    void getCurrentWindow().toggleMaximize();
  };

  const handleClose = () => {
    void getCurrentWindow().close();
  };

  return (
    <header
      data-tauri-drag-region="deep"
      className={cn(
        "relative flex h-10 shrink-0 items-center justify-between border-b border-border bg-sidebar text-xs select-none",
        isMac ? "pr-3 pl-[78px]" : "pr-0 pl-3",
      )}
    >
      {/* Left: App icon, title, separator, File menu */}
      <div className="flex items-center gap-2.5">
        <img src={appIcon} alt="" className="size-[22px] shrink-0" />
        <span className="text-sm font-medium text-sidebar-foreground">
          {t("app.name")}
        </span>
        <Separator orientation="vertical" className="h-4 bg-sidebar-border" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              {t("titleBar.menu.file")}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={handleOpenMedia}>
              {t("titleBar.menu.openMedia")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              {t("titleBar.menu.newProject")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              {t("titleBar.menu.openProject")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>{t("titleBar.menu.save")}</DropdownMenuItem>
            <DropdownMenuItem disabled>{t("titleBar.menu.export")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Center: Real filename when loaded, or Untitled */}
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 text-xs text-muted-foreground">
        {media ? (
          <span className="max-w-[320px] truncate font-medium text-sidebar-foreground">
            {media.fileName}
          </span>
        ) : (
          <span>{t("titleBar.project.untitled")}</span>
        )}
      </div>

      {/* Right: Window Controls for non-macOS platforms */}
      <div className="flex items-center">
        {!isMac && (
          <div className="flex h-10 items-center">
            <button
              type="button"
              onClick={handleMinimize}
              aria-label={t("window.minimize")}
              className="inline-flex h-10 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Minus className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={handleMaximize}
              aria-label={t("window.toggleMaximize")}
              className="inline-flex h-10 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Square className="size-3" />
            </button>
            <button
              type="button"
              onClick={handleClose}
              aria-label={t("window.close")}
              className="inline-flex h-10 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
