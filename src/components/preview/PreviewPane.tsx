import { useTranslation } from "react-i18next";
import { ChevronDown, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function PreviewPane() {
  const { t } = useTranslation();

  return (
    <section className="flex min-h-[200px] flex-1 flex-col overflow-hidden bg-preview-background p-3 text-preview-foreground select-none">
      {/* 16:9 Video Canvas Surface */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <div className="relative flex aspect-video h-full max-h-full w-auto max-w-full items-center justify-center rounded-lg border border-preview-border bg-preview-surface shadow-xs">
          <span className="text-xs text-preview-muted">{t("preview.noMedia")}</span>
        </div>
      </div>

      {/* Preview Bottom Row: Timecode and View Controls */}
      <div className="flex shrink-0 items-center justify-between px-1 pt-2">
        <div className="flex items-center gap-1.5 font-mono text-xs">
          <span className="font-medium text-primary">00:00:00:00</span>
          <span className="text-preview-muted">/</span>
          <span className="text-preview-muted">00:00:00:00</span>
        </div>

        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled>
              <Button
                variant="ghost"
                size="xs"
                disabled
                className="h-6 gap-1 px-2 text-xs text-preview-muted hover:bg-preview-surface hover:text-preview-foreground"
              >
                {t("preview.zoom.fit")}
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>{t("preview.zoom.fit")}</DropdownMenuItem>
              <DropdownMenuItem>{t("preview.zoom.zoom50")}</DropdownMenuItem>
              <DropdownMenuItem>{t("preview.zoom.zoom100")}</DropdownMenuItem>
              <DropdownMenuItem>{t("preview.zoom.zoom200")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled
                className="size-6 text-preview-muted hover:bg-preview-surface hover:text-preview-foreground"
                aria-label={t("preview.action.toggleFullscreen")}
              >
                <Maximize2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("preview.action.fullscreen")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
