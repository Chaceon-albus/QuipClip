import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  selectActiveSourceSegmentCount,
  totalActiveSourceSegments,
  useTimelineStore,
  type SegmentTotalSource,
  type TimelineStoreState,
} from "@/features/timeline";
import type { TimecodeDisplay } from "@/lib/timecode";
import { presentSegmentSummary } from "./segmentSummaryModel";

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
 */
export const SegmentSummary = memo(function SegmentSummary({
  probe,
  timecodeDisplay,
}: SegmentSummaryProps) {
  const { t } = useTranslation();
  const segmentCount = useTimelineStore(selectActiveSourceSegmentCount);
  // The selector of the title bar, so the total is the one that the Export tooltip shows.
  const selectSegmentTotal = useCallback(
    (state: TimelineStoreState) =>
      totalActiveSourceSegments(state.segments, state.sourceId, probe, timecodeDisplay),
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
  return (
    <div className="flex min-w-0 flex-col text-muted-foreground tabular-nums">
      <span className="sr-only">{t(summary.labelKey, values)}</span>
      <span aria-hidden="true" className="truncate text-2xs">
        {t(summary.countKey, values)}
      </span>
      <span aria-hidden="true" className="truncate font-mono text-[10px] leading-4">
        {summary.duration}
      </span>
    </div>
  );
});
