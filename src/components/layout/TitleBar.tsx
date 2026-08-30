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
import { cn } from "@/lib/utils";

/**
 * Detect whether the client is running on macOS.
 * macOS uses native traffic light controls at the top left.
 */
function isMacOS(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
}

export function TitleBar() {
  const isMac = isMacOS();

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
        <span className="text-sm font-medium text-sidebar-foreground">QuipClip</span>
        <Separator orientation="vertical" className="h-4 bg-sidebar-border" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled>
            <Button
              variant="ghost"
              size="xs"
              disabled
              className="h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              File
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem>New Project</DropdownMenuItem>
            <DropdownMenuItem>Open Project...</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>Save</DropdownMenuItem>
            <DropdownMenuItem disabled>Export...</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Center: Project title and save state */}
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 text-xs text-muted-foreground">
        <span>Untitled Project</span>
        <span>·</span>
        <span>Saved</span>
      </div>

      {/* Right: Window Controls for non-macOS platforms */}
      <div className="flex items-center">
        {!isMac && (
          <div className="flex h-10 items-center">
            <button
              type="button"
              onClick={handleMinimize}
              aria-label="Minimize"
              className="inline-flex h-10 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Minus className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={handleMaximize}
              aria-label="Toggle maximize/restore"
              className="inline-flex h-10 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Square className="size-3" />
            </button>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close"
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
