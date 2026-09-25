/**
 * Pure presenter for the segment summary in the gutter of the track row: the number of segments
 * that the export joins, and their total duration.
 *
 * The values are the ones of the Export tooltip of the title bar (`presentExportAction`): the
 * count of `selectActiveSourceSegmentCount`, and the total of `totalActiveSourceSegments` in the
 * timecode format of the source, written by `formatSegmentTotal` (ADR 024, ADR 028). So the
 * gutter and the Export button always show the same two values.
 *
 * It returns translation keys and values, and does not call the i18n runtime (ADR 011).
 */

import { formatSegmentTotal } from "@/features/timeline";
import type { TimecodeDisplay } from "@/lib/timecode";

/** What the gutter shows under the lane label. */
export interface SegmentSummaryView {
  /** The number of segments of the active source. The count line is its plural form. */
  readonly count: number;
  /** The total duration, as the Export tooltip writes it, such as `00:01:23:04`. */
  readonly duration: string;
  /** The count line. */
  readonly countKey: "timeline.segmentSummary.count";
  /**
   * The accessible text of the summary: the count and the duration in one sentence, which says
   * what the duration is. The visible lines leave that out, so that they fit the gutter.
   */
  readonly labelKey: "timeline.segmentSummary.label";
}

export interface SegmentSummaryInput {
  /** The number of segments of the active source (`selectActiveSourceSegmentCount`). */
  readonly segmentCount: number;
  /**
   * Their total duration, from `totalActiveSourceSegments` with `display`, or null when it is
   * not known.
   */
  readonly segmentTotal: bigint | null;
  /** The timecode format of the source (`resolveTimecodeDisplay`). */
  readonly display: TimecodeDisplay;
}

/**
 * Returns the summary, or null when the active source has no segment. The gutter then shows the
 * lane label only. A total that is not known shows the placeholder of the display, as the Export
 * tooltip does.
 */
export function presentSegmentSummary(
  input: SegmentSummaryInput,
): SegmentSummaryView | null {
  if (!Number.isSafeInteger(input.segmentCount) || input.segmentCount <= 0) {
    return null;
  }
  return {
    count: input.segmentCount,
    duration: formatSegmentTotal(input.segmentTotal, input.display),
    countKey: "timeline.segmentSummary.count",
    labelKey: "timeline.segmentSummary.label",
  };
}
