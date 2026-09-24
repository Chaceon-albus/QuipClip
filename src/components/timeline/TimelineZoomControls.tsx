import { useTranslation } from "react-i18next";
import { MoveHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { preventFocusOnMouseDown } from "@/components/common/preventFocusOnMouseDown";
import { ShortcutTooltipContent } from "@/components/common/ShortcutTooltipContent";
import {
  useShortcutLabels,
  type ShortcutLabel,
} from "@/components/common/useShortcutLabels";
import {
  canFitTimeline,
  canZoomTimelineIn,
  canZoomTimelineOut,
} from "@/components/layout/actionConditions";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaStore, type MediaStoreState } from "@/features/media";
import {
  timelineViewportStore,
  useTimelineViewportStore,
  type TimelineViewportStoreState,
} from "@/features/timeline";

const selectHasMedia = (state: MediaStoreState) => state.media !== null;
const selectZoom = (state: TimelineViewportStoreState) => state.zoom;
const selectMaxZoom = (state: TimelineViewportStoreState) => state.maxZoom;

// A zoom button does not keep the focus after a mouse click (`preventFocusOnMouseDown`), as a
// button of the transport bar does (ADR 021). A zoom button that takes the focus and then
// reaches its limit becomes disabled, and the focus would fall to the body.

// Each click handler calls the action with no argument. A handler passed directly would give
// the click event to the action as its anchor.
const zoomOut = () => {
  timelineViewportStore.getState().zoomOut();
};
const fit = () => {
  timelineViewportStore.getState().fit();
};
const zoomIn = () => {
  timelineViewportStore.getState().zoomIn();
};

interface ZoomButtonProps {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly shortcut: ShortcutLabel | null;
  readonly children: React.ReactNode;
}

/**
 * One zoom button with its tooltip.
 *
 * A disabled button takes no pointer events, so its own tooltip could never open. The span
 * around it is the tooltip trigger, as in the transport bar: it takes the pointer while the
 * button is disabled, and the events of an enabled button reach it by bubbling. The span has
 * no tabIndex, so the Tab order does not change.
 */
function ZoomButton({ label, disabled, onClick, shortcut, children }: ZoomButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            variant="chrome"
            size="icon-xs"
            disabled={disabled}
            onMouseDown={preventFocusOnMouseDown}
            onClick={onClick}
            aria-label={label}
            aria-keyshortcuts={shortcut?.aria}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      {/* Every chip of the action: one for Zoom In and Zoom Out, and `\` and Shift+Z for Fit. */}
      <ShortcutTooltipContent label={label} keys={shortcut?.chips} />
    </Tooltip>
  );
}

/**
 * The zoom controls of the timeline: Zoom Out, Fit and Zoom In, in the gutter header of the
 * ruler row.
 *
 * Each button has the condition of its key (`actionConditions.ts`), and its tooltip names the
 * key from the binding table (ADR 026). Zoom In and Zoom Out anchor on the playhead when it is
 * in the visible lane, and on the centre of the visible lane otherwise. Fit returns to zoom 1
 * and the start of the lane. The panel applies the anchor after it commits the new width.
 *
 * The glyphs follow the status bar rule for a standalone icon button: a 24px box with a 16px
 * glyph at a stroke of 1.75. The chrome variant gives hover the sidebar accent of the gutter.
 */
export function TimelineZoomControls() {
  const { t } = useTranslation();
  const shortcutOf = useShortcutLabels();
  const hasMedia = useMediaStore(selectHasMedia);
  const zoom = useTimelineViewportStore(selectZoom);
  const maxZoom = useTimelineViewportStore(selectMaxZoom);

  return (
    <div
      role="group"
      aria-label={t("timeline.zoom.group")}
      className="flex items-center gap-0.5"
    >
      <ZoomButton
        label={t("timeline.zoom.zoomOut")}
        disabled={!canZoomTimelineOut(hasMedia, zoom)}
        onClick={zoomOut}
        shortcut={shortcutOf("zoomOut")}
      >
        <ZoomOut className="size-4" strokeWidth={1.75} />
      </ZoomButton>
      <ZoomButton
        label={t("timeline.zoom.fit")}
        disabled={!canFitTimeline(hasMedia, zoom)}
        onClick={fit}
        shortcut={shortcutOf("zoomToFit")}
      >
        <MoveHorizontal className="size-4" strokeWidth={1.75} />
      </ZoomButton>
      <ZoomButton
        label={t("timeline.zoom.zoomIn")}
        disabled={!canZoomTimelineIn(hasMedia, zoom, maxZoom)}
        onClick={zoomIn}
        shortcut={shortcutOf("zoomIn")}
      >
        <ZoomIn className="size-4" strokeWidth={1.75} />
      </ZoomButton>
    </div>
  );
}
