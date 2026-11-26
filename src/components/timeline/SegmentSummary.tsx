import { memo, useCallback, useId } from "react";
import { useTranslation } from "react-i18next";
import { preventFocusOnMouseDown } from "@/components/common/preventFocusOnMouseDown";
import { ShortcutTooltipContent } from "@/components/common/ShortcutTooltipContent";
import { useShortcutLabels } from "@/components/common/useShortcutLabels";
import { canOpenExportOrder } from "@/components/layout/actionConditions";
import { isPageOverlayOpen } from "@/components/layout/nativeContextMenuState";
import { planControlCommand } from "@/components/layout/shortcutCommands";
import {
  readShortcutSnapshot,
  runShortcutCommand,
} from "@/components/layout/useKeyboardShortcuts";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import {
  selectExportSegmentCount,
  totalExportSegments,
  useTimelineStore,
  type SegmentTotalSource,
  type TimelineStoreState,
} from "@/features/timeline";
import type { TimecodeDisplay } from "@/lib/timecode";
import { presentSegmentSummary } from "./segmentSummaryModel";

/**
 * Runs Export Order (ADR 066) with the plan of its key, from one read of the stores, so the
 * button and the key do the same thing under the same conditions, the trim locks included. A
 * click does nothing while an overlay of the page owns the commands, as the key does: a native
 * segment menu marks itself open before it shows, and a click can arrive in that interval.
 */
const openExportOrder = () => {
  const command = planControlCommand(
    "exportOrder",
    isPageOverlayOpen(),
    readShortcutSnapshot(),
  );
  if (command !== null) {
    runShortcutCommand(command);
  }
};

export interface SegmentSummaryProps {
  /** The probe of the open media, or null while no media is open. */
  readonly probe: SegmentTotalSource | null;
  /** The timecode format of the source (ADR 028). The value must be memoized. */
  readonly timecodeDisplay: TimecodeDisplay;
}

/**
 * The number of segments and their total duration, under the lane label in the gutter of the
 * track row (`presentSegmentSummary`).
 *
 * The count and the total come from the store with the selectors of the Export button of the
 * title bar, and the total is written in the same format, so the two places always agree. Both
 * values compare by value, so an edit renders this component only when the count or the total
 * changes, and the panel does not render for it. With no segment, it renders nothing, and the
 * gutter shows the lane label only.
 *
 * The visible lines are short, so that they fit in the 96px gutter in both languages. The two
 * lines follow the label of a segment: the count in the text face with tabular figures, and the
 * duration in the 10px monospaced figures.
 *
 * - The count line is words, so it takes the smallest text step, which gives Han characters
 *   their 12px. In the monospaced face each letter takes 0.6em, and "100 segments" needed 79px.
 *   In the text face, "112 segments" is 72px wide, so a count of three digits fits in English.
 * - With the 12px left and 8px right padding of the gutter, 75px hold a millisecond timecode:
 *   12 characters of 6px.
 * - A line that still does not fit ends with an ellipsis.
 *
 * The lines are aria-hidden, and a visually hidden sentence gives assistive technology the full
 * text, which also says what the duration is.
 *
 * The summary is the button of Export Order (ADR 066). Its accessible name is the sentence of the
 * summary, which holds the text that the button shows, and its description names the action.
 * Its tooltip names the action and its key. It is disabled while the export has fewer than two
 * segments, and the summary then looks the same: only the hover fill and the tooltip differ. A
 * mouse click does not keep the focus (ADR 021): the dialog gives the focus back to the element
 * that held it, or else to this button.
 */
export const SegmentSummary = memo(function SegmentSummary({
  probe,
  timecodeDisplay,
}: SegmentSummaryProps) {
  const { t } = useTranslation();
  const shortcutOf = useShortcutLabels();
  const descriptionId = useId();
  const segmentCount = useTimelineStore(selectExportSegmentCount);
  // The selector of the title bar, so the total is the one that the Export tooltip shows. It
  // adds the segments that the count counts (ADR 066).
  const selectSegmentTotal = useCallback(
    (state: TimelineStoreState) => totalExportSegments(state, probe, timecodeDisplay),
    [probe, timecodeDisplay],
  );
  const segmentTotal = useTimelineStore(selectSegmentTotal);
  const summary = presentSegmentSummary({
    segmentCount,
    segmentTotal,
    display: timecodeDisplay,
  });
  if (summary === null) {
    return null;
  }
  const values = { count: summary.count, duration: summary.duration };
  const actionLabel = t("timeline.exportOrder.open");
  const shortcut = shortcutOf("exportOrder");
  return (
    <Tooltip>
      {/* A disabled button takes no pointer events, so its own tooltip could never open. The span
          is the trigger, as for the zoom buttons. It has no tabIndex, so the Tab order does not
          change. The negative margin and the padding give the hover fill room around the text,
          and keep the width of the two lines. */}
      <TooltipTrigger asChild>
        <span className="-mx-1 flex min-w-0">
          <button
            type="button"
            // `EXPORT_ORDER_TRIGGER_ATTRIBUTE`: the dialog finds the button by it.
            data-export-order-trigger=""
            disabled={!canOpenExportOrder(segmentCount)}
            onMouseDown={preventFocusOnMouseDown}
            onClick={openExportOrder}
            aria-describedby={descriptionId}
            aria-keyshortcuts={shortcut?.aria}
            className="flex w-full min-w-0 flex-col items-start rounded-sm px-1 text-left text-muted-foreground tabular-nums focus-ring-inset transition-colors outline-none hover:bg-chrome-accent hover:text-chrome-accent-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            <span className="sr-only">{t(summary.labelKey, values)}</span>
            <span aria-hidden="true" className="w-full truncate text-2xs">
              {t(summary.countKey, values)}
            </span>
            <span
              aria-hidden="true"
              className="w-full truncate font-mono text-[10px] leading-4"
            >
              {summary.duration}
            </span>
          </button>
          <span id={descriptionId} className="sr-only">
            {actionLabel}
          </span>
        </span>
      </TooltipTrigger>
      <ShortcutTooltipContent label={actionLabel} keys={shortcut?.chips} />
    </Tooltip>
  );
});
