import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function StatusBar() {
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-sidebar px-3 text-xs text-muted-foreground select-none">
      {/* Left: Project resolution and frame rate */}
      <div className="flex items-center gap-4">
        <span>Project Resolution: 1920 × 1080</span>
        <span>Frame Rate: 25 fps</span>
      </div>

      {/* Right: Settings button */}
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              aria-label="Settings"
            >
              <Settings className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </div>
    </footer>
  );
}
