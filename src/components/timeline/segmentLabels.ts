/**
 * Pure model for the text of a timeline segment: the label on the segment, its accessible
 * name and description, and the rows of the shared segment tooltip.
 *
 * The functions return values and translation keys, and do not call the i18n runtime
 * (ADR 011). Every time comes from the stored PTS pair (ADR 002), in the timecode format that
 * applies to the source (ADR 028).
 */

import { isPtsString, isValidSegmentRange } from "@/lib/time";
import {
  formatElapsedTickSpan,
  type ElapsedTickSpan,
  type TimecodeDisplay,
} from "@/lib/timecode";
import type { Pts, Rational, Segment } from "@/types/project";

/** A segment of the timeline with its position in the export order. */
export interface ExportNumberedSegment {
  readonly segment: Segment;
  /** The index in the segment list of the timeline. It is unique, so element IDs can use it. */
  readonly projectIndex: number;
  /**
   * The 1-based position among the segments of the export (`exportSegmentIds`, ADR 066). `#N`
   * shows this number.
   */
  readonly number: number;
}

/** The segments of the timeline in export order, and how many segments the export joins. */
export interface ExportNumbering {
  readonly entries: readonly ExportNumberedSegment[];
  /** The number of segments that the export joins. */
  readonly total: number;
}

/**
 * Numbers the segments of the timeline by their place among the segments of the export.
 *
 * The segments of the export are the segments that a request for an export takes, in that order
 * (`exportSegmentIds`, ADR 066). The dialog of ADR 066 numbers its rows by the same list, so a
 * number on the timeline is the number of the row of that segment. The project array can also
 * hold segments that the export leaves out, such as the segments of a source that was replaced
 * (ADR 027), so a number taken from the array index would count them. A segment that has no
 * width on the timeline still counts, because the export includes it. A segment of the list that
 * is not a segment of the export gets no number and no entry.
 *
 * @param segments The segments of the timeline (`segments`), in array order.
 * @param exportIds The ids of the segments of the export, in export order.
 */
export function numberSegmentsInExportOrder(
  segments: readonly Segment[],
  exportIds: readonly string[],
): ExportNumbering {
  const numberOf = new Map(exportIds.map((id, index) => [id, index + 1]));
  const entries: ExportNumberedSegment[] = [];
  segments.forEach((segment, projectIndex) => {
    const number = numberOf.get(segment.id);
    if (number !== undefined) {
      entries.push({ segment, projectIndex, number });
    }
  });
  return { entries, total: exportIds.length };
}

/**
 * The horizontal margins of the label in the full tier, both sides together (`mx-2`).
 */
export const SEGMENT_FULL_LABEL_MARGIN_PX = 16;

/**
 * The horizontal margins of the label in the number tier, both sides together (`mx-1`).
 */
export const SEGMENT_NUMBER_LABEL_MARGIN_PX = 8;

/** The advance of one character of the duration line. Geist Mono at 10px is 0.6em. */
export const SEGMENT_DURATION_CHAR_WIDTH_PX = 6;

/**
 * The advance of `#` on the number line, in Geist at 11px and weight 600 (6.08px), rounded
 * up to the next half pixel.
 */
export const SEGMENT_NUMBER_HASH_WIDTH_PX = 6.5;

/**
 * The advance of one digit on the number line, in Geist at 11px and weight 600 with tabular
 * figures (6.87px), rounded up to the next half pixel. The number line uses `tabular-nums`,
 * so every digit has this advance.
 */
export const SEGMENT_NUMBER_DIGIT_WIDTH_PX = 7;

/**
 * How much text a segment shows.
 *
 * - `full`: the number and the duration, on two lines.
 * - `number`: the number only.
 * - `none`: no text. The tooltip and the accessible name still give every value.
 */
export type SegmentLabelTier = "full" | "number" | "none";

/** The narrowest segment, in CSS pixels, that shows each tier without a cut. */
export interface SegmentLabelWidths {
  /** The number and its margins in the number tier. */
  readonly numberTierPx: number;
  /**
   * The wider of the two lines and the margins of the full tier, or null when the duration
   * is not known. The full tier then never applies.
   */
  readonly fullTierPx: number | null;
}

/**
 * Estimates the width that each tier needs for a segment from the text it shows: `#N` on the
 * first line and the compact duration on the second. The estimate uses fixed advances, so it
 * reads no layout. Both lines use tabular figures, so each character has one advance.
 *
 * @param number The segment number, `#N`.
 * @param compactDuration The compact duration, or null when it is not known.
 */
export function measureSegmentLabel(
  number: number,
  compactDuration: string | null,
): SegmentLabelWidths {
  const numberPx =
    SEGMENT_NUMBER_HASH_WIDTH_PX +
    String(number).length * SEGMENT_NUMBER_DIGIT_WIDTH_PX;
  return {
    numberTierPx: SEGMENT_NUMBER_LABEL_MARGIN_PX + numberPx,
    fullTierPx:
      compactDuration === null
        ? null
        : SEGMENT_FULL_LABEL_MARGIN_PX +
          Math.max(numberPx, compactDuration.length * SEGMENT_DURATION_CHAR_WIDTH_PX),
  };
}

/**
 * Returns the width of a segment in CSS pixels: `widthPercent` of a lane `laneWidthPx` wide.
 * The multiplication comes first: `5.6 / 100 * 1000` is `55.99999999999999` in floating
 * point, and `5.6 * 1000 / 100` is `56`.
 *
 * @param widthPercent The width of the segment, as a percent of the lane.
 * @param laneWidthPx The width of the lane in CSS pixels.
 */
export function calculateSegmentWidthPx(
  widthPercent: number,
  laneWidthPx: number,
): number {
  return (widthPercent * laneWidthPx) / 100;
}

/**
 * Returns the richest label tier whose text fits a segment `widthPx` wide. A width that is
 * not finite shows no text.
 *
 * @param widthPx The width of the segment in CSS pixels.
 * @param widths The widths that the tiers of this segment need (`measureSegmentLabel`).
 */
export function resolveSegmentLabelTier(
  widthPx: number,
  widths: SegmentLabelWidths,
): SegmentLabelTier {
  if (!Number.isFinite(widthPx)) {
    return "none";
  }
  if (widths.fullTierPx !== null && widthPx >= widths.fullTierPx) {
    return "full";
  }
  if (widthPx >= widths.numberTierPx) {
    return "number";
  }
  return "none";
}

/** The gap between the number and the name on the number line (`ml-1`). */
export const SEGMENT_NAME_GAP_PX = 4;

/**
 * The classes of the name on the bar (ADR 065). The bar clips a name that is too long, with no
 * ellipsis: a name can start with a character that paints nothing and is not `White_Space`, such
 * as U+2800, and an ellipsis after it would show no letter at all.
 */
export const SEGMENT_BAR_NAME_CLASS =
  "ml-1 min-w-0 overflow-hidden font-medium text-clip whitespace-nowrap";

/**
 * The horizontal margins of the label of a bar that shows a name, both sides together (`mx-1`):
 * the margins of the number tier, in every tier. The line of the number then has one padding
 * whatever the tier of the duration, so a name that shows at a width shows at every larger
 * width (ADR 065).
 */
export const SEGMENT_NAMED_LABEL_MARGIN_PX = SEGMENT_NUMBER_LABEL_MARGIN_PX;

/**
 * True when the bar shows the name after the number (ADR 065): the segment has a name, the bar
 * shows the number, and the line of the number has some room left after the margins of a named
 * label (`SEGMENT_NAMED_LABEL_MARGIN_PX`), the number and the gap: more than 0 px. The room of
 * that line alone decides, so the tier of the duration does not hide the name. The width of a
 * name is not estimated: CSS fits a short name and clips a long one (`SEGMENT_BAR_NAME_CLASS`).
 * The number does not shrink, so the name never pushes it out.
 *
 * @param tier The tier of the bar (`resolveSegmentLabelTier`).
 * @param widthPx The width of the segment in CSS pixels.
 * @param widths The widths of the tiers of this segment (`measureSegmentLabel`).
 * @param name The name of the segment, or undefined for no name.
 */
export function showsSegmentName(
  tier: SegmentLabelTier,
  widthPx: number,
  widths: SegmentLabelWidths,
  name: string | undefined,
): boolean {
  if (
    tier === "none" ||
    name === undefined ||
    name === "" ||
    !Number.isFinite(widthPx)
  ) {
    return false;
  }
  const numberPx = widths.numberTierPx - SEGMENT_NUMBER_LABEL_MARGIN_PX;
  const roomPx =
    widthPx - SEGMENT_NAMED_LABEL_MARGIN_PX - numberPx - SEGMENT_NAME_GAP_PX;
  return roomPx > 0;
}

/**
 * The classes of the body of the segment tooltip. The tooltip has a largest width (`max-w-xs`),
 * and its content is a flex row, where a child keeps the least width of its longest word unless
 * it can shrink. `min-w-0` lets the body shrink to the tooltip, so a long name wraps inside it.
 */
export const SEGMENT_TOOLTIP_BODY_CLASS = "flex min-w-0 flex-col gap-1.5";

/**
 * The classes of the title of the segment tooltip: the number and the name (ADR 065). A name of
 * 80 characters can be one word with no break, such as 80 `W`, so the title breaks anywhere
 * (`wrap-anywhere`) and never runs out of the tooltip.
 */
export const SEGMENT_TOOLTIP_TITLE_CLASS = "font-semibold wrap-anywhere";

/** A catalog key and its values. */
export interface SegmentText<K extends string> {
  readonly key: K;
  readonly values: Readonly<Record<string, string | number>>;
}

/**
 * The form of `t` that takes a `SegmentText`. The typed `t` of i18next checks the values of each
 * key, and it cannot match a union of keys with their values.
 */
export type TranslateSegmentText = (
  key: string,
  values: Readonly<Record<string, string | number>>,
) => string;

/**
 * The title of the segment tooltip: the number, and the name after it when the segment has one
 * (ADR 065).
 */
export function resolveSegmentTitle(
  number: number,
  name: string | undefined,
): SegmentText<"timeline.segment" | "timeline.segmentNamed"> {
  return name === undefined
    ? { key: "timeline.segment", values: { index: number } }
    : { key: "timeline.segmentNamed", values: { index: number, name } };
}

/**
 * The accessible name of a segment: the number, the name when the segment has one (ADR 065), and
 * the In time, the Out time and the duration when they are known.
 */
export function resolveSegmentAccessibleName(
  number: number,
  name: string | undefined,
  times: Pick<SegmentTimes, "inTime" | "outTime" | "duration"> | null,
): SegmentText<
  | "timeline.segment"
  | "timeline.segmentNamed"
  | "timeline.segmentLabel"
  | "timeline.segmentLabelNamed"
> {
  if (times === null) {
    return resolveSegmentTitle(number, name);
  }
  const values = {
    index: number,
    inTime: times.inTime,
    outTime: times.outTime,
    duration: times.duration,
  };
  return name === undefined
    ? { key: "timeline.segmentLabel", values }
    : { key: "timeline.segmentLabelNamed", values: { ...values, name } };
}

/** The left and the width of a tooltip anchor, as CSS percentages of the lane. */
export interface SegmentAnchor {
  readonly left: string;
  readonly width: string;
  /**
   * False when no part of the segment is in the visible part of the viewport. The tooltip
   * then stays open but hidden, so it does not float over the sticky gutter or away from
   * the segment.
   */
  readonly visible: boolean;
}

/**
 * Returns the part of a segment that is inside the visible part of the lane, as CSS
 * percentages of the lane, so that the tooltip centres on the part of the segment that the
 * user sees. At a high zoom a segment can be much wider than the viewport, and a tooltip
 * centred on the whole segment would open far from it, at the window edge.
 *
 * All positions are client pixels. When no part of the segment is visible, the anchor is the
 * whole segment and is marked not visible. When the lane has no width, nothing can be
 * measured, and the anchor is the whole segment, marked visible.
 *
 * @param segment The left and the width of the segment, as percentages of the lane.
 * @param lane The left edge and the width of the lane.
 * @param visible The left and the right edge of the visible part of the timeline viewport.
 */
export function calculateVisibleSegmentAnchor(
  segment: { readonly leftPercent: number; readonly widthPercent: number },
  lane: { readonly left: number; readonly width: number },
  visible: { readonly left: number; readonly right: number },
): SegmentAnchor {
  const whole = (isVisible: boolean): SegmentAnchor => ({
    left: `${segment.leftPercent}%`,
    width: `${segment.widthPercent}%`,
    visible: isVisible,
  });
  if (!Number.isFinite(lane.width) || lane.width <= 0) {
    return whole(true);
  }
  const segmentLeft = lane.left + (segment.leftPercent * lane.width) / 100;
  const segmentRight = segmentLeft + (segment.widthPercent * lane.width) / 100;
  const start = Math.max(segmentLeft, visible.left);
  const end = Math.min(segmentRight, visible.right);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return whole(false);
  }
  return {
    left: `${((start - lane.left) * 100) / lane.width}%`,
    width: `${((end - start) * 100) / lane.width}%`,
    visible: true,
  };
}

/** The times of one segment, each in the timecode format of the source. */
export type SegmentTimes = ElapsedTickSpan;

/**
 * Formats the In time, the Out time and the duration of a segment (`formatElapsedTickSpan`).
 *
 * The In and Out times are elapsed times from `videoStartPts`, formatted as the preview
 * formats the playhead, so a boundary shows the same timecode as the frame it names. The
 * duration is the distance between the two, counted on the grid of the format, so the three
 * values always agree.
 *
 * Returns null when the source timing is missing or not valid, or when the segment is not a
 * valid half-open interval (`inPts < outPts`).
 *
 * @param segment The PTS pair of the segment.
 * @param videoStartPts The start PTS of the source video stream.
 * @param videoTimeBase The video time base of the source.
 * @param display The timecode format that applies to the source.
 */
export function formatSegmentTimes(
  segment: Pick<Segment, "inPts" | "outPts">,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  display: TimecodeDisplay,
): SegmentTimes | null {
  if (
    !videoStartPts ||
    !videoTimeBase ||
    !isPtsString(videoStartPts) ||
    !isValidSegmentRange(segment.inPts, segment.outPts)
  ) {
    return null;
  }
  const start = BigInt(videoStartPts);
  return formatElapsedTickSpan(
    BigInt(segment.inPts) - start,
    BigInt(segment.outPts) - start,
    videoTimeBase,
    display,
  );
}

/** The label key of a tooltip row. */
export type SegmentTooltipRowLabelKey =
  | "timeline.segmentTooltip.in"
  | "timeline.segmentTooltip.out"
  | "timeline.segmentTooltip.duration";

/** One row of the segment tooltip: a label and a timecode. */
export interface SegmentTooltipRow {
  readonly labelKey: SegmentTooltipRowLabelKey;
  readonly value: string;
  /**
   * True for the Out row. The Out boundary is the first frame after the segment (ADR 002),
   * so the tooltip marks that time as not included.
   */
  readonly excluded: boolean;
}

/**
 * Returns the time rows of the segment tooltip, in the order In, Out, duration. Returns no
 * rows when the times are not known. The tooltip then shows the number and the export order
 * only.
 *
 * @param times The times of the segment, or null.
 */
export function buildSegmentTooltipRows(
  times: SegmentTimes | null,
): readonly SegmentTooltipRow[] {
  if (times === null) {
    return [];
  }
  return [
    { labelKey: "timeline.segmentTooltip.in", value: times.inTime, excluded: false },
    { labelKey: "timeline.segmentTooltip.out", value: times.outTime, excluded: true },
    {
      labelKey: "timeline.segmentTooltip.duration",
      value: times.duration,
      excluded: false,
    },
  ];
}
