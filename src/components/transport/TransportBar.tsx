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
  return (
    <section className="flex h-[72px] shrink-0 items-center justify-center border-y border-border bg-card px-4 select-none">
      <div className="flex items-center gap-4">
        {/* Group 1: History (Undo / Redo with icon over label) */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Undo"
          >
            <Undo2 className="size-4" />
            <span className="text-[10px] leading-none font-medium">Undo</span>
          </Button>
          <Button
            variant="ghost"
            className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Redo"
          >
            <Redo2 className="size-4" />
            <span className="text-[10px] leading-none font-medium">Redo</span>
          </Button>
        </div>

        <Separator orientation="vertical" className="h-8 bg-border" />

        {/* Group 2: Mark points and cut tools (In, Out, Split) */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="flex h-11 items-center gap-2 rounded-lg border-border bg-card px-3 hover:bg-muted"
            aria-label="Mark In Point"
          >
            <ArrowRightToLine className="size-4 text-muted-foreground" />
            <div className="flex flex-col items-start leading-tight">
              <span className="text-xs font-semibold">In</span>
              <span className="text-[10px] text-muted-foreground">Mark In</span>
            </div>
          </Button>

          <Button
            variant="outline"
            className="flex h-11 items-center gap-2 rounded-lg border-border bg-card px-3 hover:bg-muted"
            aria-label="Mark Out Point"
          >
            <ArrowLeftToLine className="size-4 text-muted-foreground" />
            <div className="flex flex-col items-start leading-tight">
              <span className="text-xs font-semibold">Out</span>
              <span className="text-[10px] text-muted-foreground">Mark Out</span>
            </div>
          </Button>

          <Button
            variant="outline"
            className="flex h-11 items-center gap-2 rounded-lg border-border bg-card px-3 hover:bg-muted"
            aria-label="Split Segment"
          >
            <Scissors className="size-4 text-muted-foreground" />
            <div className="flex flex-col items-start leading-tight">
              <span className="text-xs font-semibold">Split</span>
              <span className="text-[10px] text-muted-foreground">Cut Clip</span>
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
                className="size-11 rounded-lg bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover active:bg-primary-active"
                aria-label="Play"
              >
                <Play className="size-5 fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Play</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-10 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Previous Frame"
              >
                <SkipBack className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Previous Frame</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-10 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Next Frame"
              >
                <SkipForward className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Next Frame</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
