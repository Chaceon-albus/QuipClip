import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown, FileOutput, Minus, Square, X } from "lucide-react";
import appIcon from "@/assets/brand/app-icon.svg";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShortcutTooltipContent } from "@/components/common/ShortcutTooltipContent";
import { useOpenMediaAction } from "@/components/common/useOpenMediaAction";
import { useShortcutLabels } from "@/components/common/useShortcutLabels";
import { ExportDialog } from "@/components/export/ExportDialog";
import { useExportPanelStore } from "@/features/export";
import { useMediaStore } from "@/features/media";
import {
  getActiveSourceSegmentEntries,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import { splitFileName } from "@/lib/fileName";
import { isMacOS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { canExportMedia } from "./actionConditions";
import { runExportFlow } from "./exportFlowController";

/**
 * The hover delay of the full path. It is longer than the default of the shell, because the
 * title is not a control and a pointer often crosses it on the way to the window edge.
 */
const PATH_TOOLTIP_DELAY_MS = 600;

/** The gap between the title and its path tooltip, in pixels. */
const PATH_TOOLTIP_OFFSET = 6;

// A number, so the title bar renders again only when the count changes.
const selectActiveSourceSegmentCount = (state: TimelineStoreState) =>
  getActiveSourceSegmentEntries(state.segments, state.sourceId).length;

export function TitleBar() {
  const { t } = useTranslation();
  // Everything that is not macOS takes the Windows branch, so Linux gets the
  // Windows title bar.
  const isMac = isMacOS();
  const media = useMediaStore((state) => state.media);
  const segmentCount = useTimelineStore(selectActiveSourceSegmentCount);
  const exportDialogOpen = useExportPanelStore((state) => state.open);
  const setExportDialogOpen = useExportPanelStore((state) => state.setOpen);
  // The key names come from the binding table (ADR 026).
  const shortcutOf = useShortcutLabels();
  const openMediaShortcut = shortcutOf("openMedia");
  const exportShortcut = shortcutOf("export");

  // The empty preview offers the same action through its Open button.
  const handleOpenMedia = useOpenMediaAction();

  const handleExport = () => {
    void runExportFlow({
      setModalOpen: setExportDialogOpen,
      // The save dialog and the open dialog list the same file kind, so both read the
      // one `dialog.videoFilter` label. A second key with the same text would drift.
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
        // The reserved width for the native macOS traffic-light buttons, which
        // titleBarStyle: "Overlay" draws over the top left of the web view.
        isMac ? "pr-3 pl-[78px]" : "pr-0 pl-3",
      )}
    >
      {/* Left: File menu (constant), plus app icon, title, and separator on non-macOS platforms */}
      <div className="flex items-center gap-2.5">
        {/* On macOS the application identity belongs to the menu bar, so a
            document window's title bar shows the document name only. The
            center zone already shows the file name, so it carries that role. */}
        {!isMac && (
          <>
            <img src={appIcon} alt="" className="size-[22px] shrink-0" />
            <span className="text-sm font-medium text-sidebar-foreground">
              {t("app.name")}
            </span>
            <Separator orientation="vertical" className="h-4 bg-sidebar-border" />
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="chrome" size="xs" className="px-1.5">
              {t("titleBar.menu.file")}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          {/* The menu is wider than its trigger, so a label and its key fit on one row. The
              key text is hidden from assistive technology, because each item declares the
              same key in aria-keyshortcuts. */}
          <DropdownMenuContent align="start" className="w-auto min-w-48">
            <DropdownMenuItem
              onClick={handleOpenMedia}
              aria-keyshortcuts={openMediaShortcut?.aria}
            >
              {t("titleBar.menu.openMedia")}
              {openMediaShortcut && (
                <DropdownMenuShortcut aria-hidden="true">
                  {openMediaShortcut.keys}
                </DropdownMenuShortcut>
              )}
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
            <DropdownMenuItem
              onClick={handleExport}
              aria-keyshortcuts={exportShortcut?.aria}
            >
              {t("titleBar.menu.export")}
              {exportShortcut && (
                <DropdownMenuShortcut aria-hidden="true">
                  {exportShortcut.keys}
                </DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Centre: the open file and its segment count. With no media, macOS shows the
          application name here, because its left zone does not (ADR 020). Every other
          platform shows the name in the left zone, so the centre stays empty. */}
      <div className="absolute left-1/2 flex max-w-[min(42vw,560px)] -translate-x-1/2 items-center text-xs text-muted-foreground">
        {media ? (
          <TitleBarFile
            fileName={media.fileName}
            path={media.path}
            segmentCount={segmentCount}
          />
        ) : (
          isMac && <span>{t("app.name")}</span>
        )}
      </div>

      {/* Right: Export button (constant), plus window controls on non-macOS platforms */}
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="default"
              disabled={!canExportMedia(media !== null)}
              onClick={handleExport}
              aria-keyshortcuts={exportShortcut?.aria}
            >
              <FileOutput />
              {t("titleBar.action.export")}
            </Button>
          </TooltipTrigger>
          <ShortcutTooltipContent
            label={t("titleBar.action.export")}
            keys={exportShortcut?.keys}
          />
        </Tooltip>
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
      <ExportDialog open={exportDialogOpen} onOpenChange={setExportDialogOpen} />
    </header>
  );
}

interface TitleBarFileProps {
  readonly fileName: string;
  readonly path: string;
  readonly segmentCount: number;
}

/**
 * The name of the open file in the centre zone, with its full path in a tooltip.
 *
 * The stem truncates and the extension does not, so a long name keeps its extension.
 *
 * The title is not a control: it takes no focus and no click, so a press on it still drags
 * the window (ADR 020). The Tauri drag script treats an element with a `tabindex` as
 * clickable and does not start a drag on it. A focusable title would therefore stop the
 * window drag. For version 1 the full path is available on hover only. A place that the
 * keyboard can reach is a later step.
 *
 * The tooltip is controlled, because a press on the title can start a window drag. Radix
 * closes a tooltip that is open at the press, but it does not cancel the delay timer, and
 * the pointer does not leave the title while the window moves with it. Without the
 * suppression, the tooltip would open during or after the drag. A press suppresses the
 * tooltip until the pointer leaves the title.
 */
function TitleBarFile({ fileName, path, segmentCount }: TitleBarFileProps) {
  const { t } = useTranslation();
  const { stem, extension } = splitFileName(fileName);
  const [open, setOpen] = useState(false);
  const suppressedRef = useRef(false);

  const handleOpenChange = (next: boolean) => {
    if (next && suppressedRef.current) {
      return;
    }
    setOpen(next);
  };

  const handlePointerDown = () => {
    suppressedRef.current = true;
    setOpen(false);
  };

  const handlePointerLeave = () => {
    suppressedRef.current = false;
  };

  return (
    <Tooltip
      open={open}
      onOpenChange={handleOpenChange}
      delayDuration={PATH_TOOLTIP_DELAY_MS}
    >
      <TooltipTrigger
        asChild
        onPointerDown={handlePointerDown}
        onPointerLeave={handlePointerLeave}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex min-w-0 font-medium text-sidebar-foreground">
            <span className="truncate">{stem}</span>
            <span className="shrink-0 text-muted-foreground">{extension}</span>
          </span>
          {segmentCount > 0 && (
            <>
              <span aria-hidden="true" className="shrink-0">
                ·
              </span>
              <span className="shrink-0 whitespace-nowrap">
                {t("titleBar.source.segmentCount", { count: segmentCount })}
              </span>
            </>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={PATH_TOOLTIP_OFFSET}
        className="max-w-[min(80vw,720px)] font-mono break-all"
      >
        {path}
      </TooltipContent>
    </Tooltip>
  );
}
