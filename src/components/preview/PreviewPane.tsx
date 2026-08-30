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
  return (
    <section className="flex min-h-[200px] flex-1 flex-col overflow-hidden bg-preview-background p-3 text-preview-foreground select-none">
      {/* 16:9 Video Canvas Surface */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <div className="relative flex aspect-video h-full max-h-full w-auto max-w-full items-center justify-center rounded-lg border border-preview-border bg-preview-surface shadow-xs">
          <span className="text-xs text-preview-muted">No media loaded</span>
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
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                className="h-6 gap-1 px-2 text-xs text-preview-muted hover:bg-preview-surface hover:text-preview-foreground"
              >
                Fit
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>Fit</DropdownMenuItem>
              <DropdownMenuItem>50%</DropdownMenuItem>
              <DropdownMenuItem>100%</DropdownMenuItem>
              <DropdownMenuItem>200%</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-6 text-preview-muted hover:bg-preview-surface hover:text-preview-foreground"
                aria-label="Toggle Fullscreen"
              >
                <Maximize2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fullscreen</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
