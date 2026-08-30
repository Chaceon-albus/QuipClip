import { useTranslation } from "react-i18next";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Play,
  Redo2,
  Scissors,
  SkipBack,
  SkipForward,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function TransportBar() {
  const { t } = useTranslation();

  return (
    <section className="flex h-[72px] shrink-0 items-center justify-center border-y border-border bg-card px-4 select-none">
      <div className="flex items-center gap-4">
        {/* Group 1: History (Undo / Redo with icon over label) */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            disabled
            className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("transport.action.undo")}
          >
            <Undo2 className="size-4" />
            <span className="text-[10px] leading-none font-medium">
              {t("transport.action.undo")}
            </span>
          </Button>
          <Button
            variant="ghost"
            disabled
            className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("transport.action.redo")}
          >
            <Redo2 className="size-4" />
            <span className="text-[10px] leading-none font-medium">
              {t("transport.action.redo")}
            </span>
          </Button>
        </div>

        <Separator orientation="vertical" className="h-8 bg-border" />

        {/* Group 2: Mark points and cut tools (In, Out, Split) */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled
            className="flex h-11 items-center gap-2 rounded-lg border-border bg-card px-3 hover:bg-muted"
            aria-label={t("transport.action.markInAria")}
          >
            <ArrowRightToLine className="size-4 text-muted-foreground" />
            <div className="flex flex-col items-start leading-tight">
              <span className="text-xs font-semibold">
                {t("transport.action.markIn")}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {t("transport.action.markInDetail")}
              </span>
            </div>
          </Button>

          <Button
            variant="outline"
            disabled
            className="flex h-11 items-center gap-2 rounded-lg border-border bg-card px-3 hover:bg-muted"
            aria-label={t("transport.action.markOutAria")}
          >
            <ArrowLeftToLine className="size-4 text-muted-foreground" />
            <div className="flex flex-col items-start leading-tight">
              <span className="text-xs font-semibold">
                {t("transport.action.markOut")}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {t("transport.action.markOutDetail")}
              </span>
            </div>
          </Button>

          <Button
            variant="outline"
            disabled
            className="flex h-11 items-center gap-2 rounded-lg border-border bg-card px-3 hover:bg-muted"
            aria-label={t("transport.action.splitAria")}
          >
            <Scissors className="size-4 text-muted-foreground" />
            <div className="flex flex-col items-start leading-tight">
              <span className="text-xs font-semibold">
                {t("transport.action.split")}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {t("transport.action.splitDetail")}
              </span>
            </div>
          </Button>
        </div>

        <Separator orientation="vertical" className="h-8 bg-border" />

        {/* Group 3: Playback Controls */}
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                disabled
                className="size-11 rounded-lg bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover active:bg-primary-active"
                aria-label={t("transport.action.play")}
              >
                <Play className="size-5 fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("transport.action.play")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled
                className="size-10 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("transport.action.previousFrame")}
              >
                <SkipBack className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("transport.action.previousFrame")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled
                className="size-10 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("transport.action.nextFrame")}
              >
                <SkipForward className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("transport.action.nextFrame")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
