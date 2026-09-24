import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown, FileOutput, Loader2 } from "lucide-react";
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
import { useExportPanelStore, useExportStore } from "@/features/export";
import { useMediaStore } from "@/features/media";
import { resolveTimecodeDisplay } from "@/features/playback";
import { useTimecodePreference } from "@/features/settings/timecodePreference";
import {
  selectActiveSourceSegmentCount,
  totalActiveSourceSegments,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import { splitFileName } from "@/lib/fileName";
import { isMacOS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { presentExportAction, type ExportActionLabel } from "./exportActionPresenter";
import { runExportFlow } from "./exportFlowController";
import { resolveTitleBarPadding } from "./titleBarLayout";
import { useWindowState } from "./useWindowState";
import { CloseGlyph, MaximizeGlyph, MinimizeGlyph, RestoreGlyph } from "./WindowGlyphs";
import { resolveMaximizeControl } from "./windowStateSync";

/**
 * The hover delay of the full path. It is longer than the default of the shell, because the
 * title is not a control and a pointer often crosses it on the way to the window edge.
 */
const PATH_TOOLTIP_DELAY_MS = 600;

/** The gap between the title and its path tooltip, in pixels. */
const PATH_TOOLTIP_OFFSET = 6;

/**
 * The title text while the window does not have the focus. The system dims the title of an
 * inactive window, on Windows and on macOS, and this class mirrors that. The dim is 75 %,
 * because at 60 % the muted title text is too faint on the light chrome (about 2.4:1).
 */
const INACTIVE_TITLE_CLASS = "group-data-inactive/title-bar:opacity-75";

/**
 * A Windows window button. The size is the Windows 11 caption button: 46 pixels wide, and the
 * full height of the title bar above its bottom border.
 *
 * That height is 39 pixels, and a centred 10 pixel glyph would start 14.5 pixels down. The
 * anti-aliased close glyph would then straddle two pixel rows. The 1 pixel bottom padding
 * makes the content box 38 pixels, so the glyph starts on a whole pixel, 14 pixels down.
 *
 * The focus ring is inset (`focus-ring-inset`), so the edge of the window does not clip it.
 * The ring is an outline, so forced-colors mode draws it as a visible focus mark.
 */
const WINDOW_BUTTON_CLASS =
  "group/window-button inline-flex w-[46px] items-center justify-center pb-px text-chrome-foreground transition-colors focus-ring-inset";

/** The hover and press fills of the minimize and maximize buttons. */
const WINDOW_BUTTON_FILL_CLASS =
  "hover:bg-foreground/[0.06] active:bg-foreground/[0.12]";

/**
 * The hover and press fills of the close button. The red is the fixed Windows 11 close colour.
 * The system uses it in the light theme and in the dark theme, so no palette token replaces it.
 *
 * On the red fill the focus ring is white, like the glyph: --ring keeps only 1.22:1 (light)
 * and 2.37:1 (dark) against that red, and white keeps 5.66:1. The ring utility sets its colour
 * at rest, so these state classes replace it.
 */
const CLOSE_BUTTON_FILL_CLASS =
  "hover:bg-[#c42b1c] hover:text-white hover:outline-white active:bg-[#c42b1c]/90 active:text-white active:outline-white";

/**
 * The glyph of a window button. While the window does not have the focus, the glyph dims, as
 * the system glyphs do. Hover and press show it at full strength again, so the white glyph on
 * the close colour does not dim. The dim is on the glyph only, so the fills keep their colour.
 *
 * The full-strength rules repeat the inactive variant. A plain `group-hover` rule has the same
 * specificity as the dim rule, and Tailwind writes the dim rule later, so the dim would win.
 * The stacked variant adds one selector, so its rule wins in any order.
 */
const WINDOW_GLYPH_CLASS =
  "group-data-inactive/title-bar:opacity-60 group-data-inactive/title-bar:group-hover/window-button:opacity-100 group-data-inactive/title-bar:group-active/window-button:opacity-100";

export function TitleBar() {
  const { t } = useTranslation();
  // Everything that is not macOS takes the Windows branch, so Linux gets the
  // Windows title bar.
  const isMac = isMacOS();
  const media = useMediaStore((state) => state.media);
  const segmentCount = useTimelineStore(selectActiveSourceSegmentCount);
  const exportStatus = useExportStore((state) => state.status);
  const exportTracking = useExportStore((state) => state.tracking);
  const exportDialogOpen = useExportPanelStore((state) => state.open);
  const setExportDialogOpen = useExportPanelStore((state) => state.setOpen);
  // The key names come from the binding table (ADR 026).
  const shortcutOf = useShortcutLabels();
  const openMediaShortcut = shortcutOf("openMedia");
  const exportShortcut = shortcutOf("export");

  // The duration in the tooltip uses the timecode format of the open source (ADR 028).
  const timecodePreference = useTimecodePreference((state) => state.format);
  const probe = media?.probe;
  const timecodeDisplay = useMemo(
    () => resolveTimecodeDisplay(timecodePreference, probe),
    [timecodePreference, probe],
  );
  // One bigint or null. Both compare by value, so the title bar renders again only when the
  // total changes, and not on each edit that keeps it.
  const selectSegmentTotal = useCallback(
    (state: TimelineStoreState) =>
      totalActiveSourceSegments(
        state.segments,
        state.sourceId,
        probe ?? null,
        timecodeDisplay,
      ),
    [probe, timecodeDisplay],
  );
  const segmentTotal = useTimelineStore(selectSegmentTotal);
  // The button and the File menu item read one view, so their disabled states are equal.
  const exportAction = presentExportAction({
    hasMedia: media !== null,
    exportStatus,
    exportTracking,
    segmentCount,
    segmentTotal,
    display: timecodeDisplay,
  });
  const exportLabelText = labelTextOf(exportAction.label, t);
  const exportReasonText = exportAction.reason === null ? null : t(exportAction.reason);
  // The line that the tooltip adds to the button name. A disabled button takes no hover and
  // no focus, so the button also names this text in `aria-describedby`.
  const exportDescription =
    exportReasonText ??
    (exportAction.label.key === "titleBar.action.export" ? null : exportLabelText);
  const exportDescriptionId = useId();

  // The empty preview offers the same action through its Open button.
  const handleOpenMedia = useOpenMediaAction();

  // macOS draws its own window buttons, so only the other platforms read the maximized state.
  // macOS hides those buttons in full screen, so only macOS reads the full-screen state.
  const { maximized, focused, fullscreen } = useWindowState({
    trackMaximized: !isMac,
    trackFullscreen: isMac,
  });
  const maximizeControl = resolveMaximizeControl(maximized);

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
      // The window buttons and the title text dim while the window does not have the focus.
      data-inactive={focused ? undefined : ""}
      className={cn(
        // The position of the macOS window buttons depends on this height and this border.
        // `src-tauri/src/traffic_lights.rs` computes it when the application starts, from
        // `TITLE_BAR_CONTENT_HEIGHT` (39, this height less the border), and
        // `titleBarLayout.ts` holds the same numbers and the fallback. A change to either one
        // must change both files.
        "group/title-bar relative flex h-10 shrink-0 items-center justify-between border-b border-border bg-chrome text-xs select-none",
        // The reserved width for the native macOS window buttons, which
        // titleBarStyle: "Overlay" draws over the top left of the web view. It is free again
        // in full screen, where macOS hides them.
        resolveTitleBarPadding({ isMac, fullscreen }),
      )}
    >
      {/* Left: File menu (constant), plus app icon, title, and separator on non-macOS platforms */}
      <div className="flex items-center gap-2.5">
        {/* On macOS the application identity belongs to the menu bar, so a
            document window's title bar shows the document name only. The
            center zone already shows the file name, so it carries that role. */}
        {!isMac && (
          <>
            <img
              src={appIcon}
              alt=""
              draggable={false}
              className="size-[22px] shrink-0"
            />
            <span
              className={cn(
                "text-sm font-medium text-chrome-foreground",
                INACTIVE_TITLE_CLASS,
              )}
            >
              {t("app.name")}
            </span>
            <Separator orientation="vertical" className="h-4 bg-chrome-border" />
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
            {/* The interface does not open or save a project yet, so the menu lists no
                project items. */}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={exportAction.disabled}
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
      <div
        className={cn(
          "absolute left-1/2 flex max-w-[min(42vw,560px)] -translate-x-1/2 items-center text-xs text-muted-foreground",
          INACTIVE_TITLE_CLASS,
        )}
      >
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

      {/* Right: Export button (constant), plus window controls on non-macOS platforms. The
          zone takes the full bar height, so the window buttons can fill it. */}
      <div className="flex items-center gap-1 self-stretch">
        {/* A disabled button takes no pointer events, so its own tooltip could never open.
            The span around it is the tooltip trigger: it takes the pointer while the button
            is disabled, and the events of an enabled button reach it by bubbling. The span
            has no tabIndex, so the Tab order does not change. The span is not a control, so
            it opts out of the window drag: a press on the disabled button does not move the
            window (ADR 020). */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex" data-tauri-drag-region="false">
              <Button
                size="sm"
                variant="default"
                disabled={exportAction.disabled}
                onClick={handleExport}
                aria-describedby={exportDescription ? exportDescriptionId : undefined}
                aria-keyshortcuts={exportShortcut?.aria}
              >
                {/* While a run is active, a click shows that run, and the icon says so. */}
                {exportAction.busy ? (
                  <Loader2 className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <FileOutput />
                )}
                {t("titleBar.action.export")}
              </Button>
              {exportDescription && (
                <span id={exportDescriptionId} className="sr-only">
                  {exportDescription}
                </span>
              )}
            </span>
          </TooltipTrigger>
          <ShortcutTooltipContent
            label={exportLabelText}
            keys={exportShortcut?.keys}
            reason={exportReasonText}
          />
        </Tooltip>
        {!isMac && (
          // The margin keeps the filled Export button apart from the hover fill of the
          // minimize button. The group and its buttons stretch to the bar height.
          <div className="ml-2 flex self-stretch">
            <button
              type="button"
              onClick={handleMinimize}
              aria-label={t("window.minimize")}
              className={cn(WINDOW_BUTTON_CLASS, WINDOW_BUTTON_FILL_CLASS)}
            >
              <MinimizeGlyph className={WINDOW_GLYPH_CLASS} />
            </button>
            <button
              type="button"
              onClick={handleMaximize}
              aria-label={t(maximizeControl.labelKey)}
              className={cn(WINDOW_BUTTON_CLASS, WINDOW_BUTTON_FILL_CLASS)}
            >
              {maximizeControl.glyph === "restore" ? (
                <RestoreGlyph className={WINDOW_GLYPH_CLASS} />
              ) : (
                <MaximizeGlyph className={WINDOW_GLYPH_CLASS} />
              )}
            </button>
            <button
              type="button"
              onClick={handleClose}
              aria-label={t("window.close")}
              className={cn(WINDOW_BUTTON_CLASS, CLOSE_BUTTON_FILL_CLASS)}
            >
              <CloseGlyph className={WINDOW_GLYPH_CLASS} />
            </button>
          </div>
        )}
      </div>
      <ExportDialog open={exportDialogOpen} onOpenChange={setExportDialogOpen} />
    </header>
  );
}

/** The first tooltip line of the export action. */
function labelTextOf(label: ExportActionLabel, t: TFunction): string {
  switch (label.key) {
    case "titleBar.exportTooltip.exportSegments":
      return t(label.key, { count: label.count, duration: label.duration });
    default:
      return t(label.key);
  }
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
          <span className="flex min-w-0 font-medium text-chrome-foreground">
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
