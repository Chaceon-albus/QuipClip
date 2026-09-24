/**
 * Pure presenter for the export action of the title bar: the Export button and the Export
 * item of the File menu.
 *
 * The button and the item read one `disabled` value from here, and that value is
 * `canExportMedia`, the condition that the window keyboard layer also reads (ADR 026). So the
 * key, the button and the item agree about when the action is available.
 *
 * `canExportMedia` needs open media and nothing more (ADR 020). With media open and no
 * segment, the action stays available and the export dialog reports `noSegments` (ADR 024).
 * The tooltip tells the user that before the click, with a second, muted line.
 *
 * It returns translation keys and does not call the i18n runtime (ADR 011).
 */

import { isExportRunActive } from "@/components/export/exportCancelState";
import type { ExportStatus } from "@/features/export";
import { getActiveSourceSegmentEntries } from "@/features/timeline";
import { isPtsString, isValidSegmentRange } from "@/lib/time";
import {
  elapsedGridIndex,
  formatGridCountTimecode,
  timecodePlaceholder,
  type TimecodeDisplay,
} from "@/lib/timecode";
import type { Pts, Rational, Segment } from "@/types/project";
import { canExportMedia } from "./actionConditions";

/** The second line of the tooltip: what the user must do before the export can run. */
export type ExportActionReasonKey =
  "titleBar.exportTooltip.openVideoFirst" | "titleBar.exportTooltip.markSegmentFirst";

/** The first line of the tooltip, beside the key chip. */
export type ExportActionLabel =
  | { readonly key: "titleBar.action.export" }
  | { readonly key: "titleBar.exportTooltip.showRunningExport" }
  | {
      readonly key: "titleBar.exportTooltip.exportSegments";
      /** The number of segments of the open source. */
      readonly count: number;
      /** Their total duration, in the timecode format of the source. */
      readonly duration: string;
    };

export interface ExportActionView {
  /** The `disabled` state of the button and of the File menu item. */
  readonly disabled: boolean;
  /** True while an export run is active. The button icon then becomes a spinner. */
  readonly busy: boolean;
  readonly label: ExportActionLabel;
  readonly reason: ExportActionReasonKey | null;
}

/** The facts of the open source that the segment total reads. */
export interface SegmentTotalSource {
  /** The time base of every segment PTS of the source (ADR 002). */
  readonly videoTimeBase: Rational;
  /** The PTS at which the elapsed time of the source is zero, or null when unstated. */
  readonly videoStartPts: Pts | null;
}

export interface ExportActionInput {
  readonly hasMedia: boolean;
  readonly exportStatus: ExportStatus;
  /** The number of segments of the open source. */
  readonly segmentCount: number;
  /**
   * The total duration of those segments, from `totalActiveSourceSegments` with the same
   * display, or null when it is not known. Its unit depends on the display: whole frames in
   * the frame format, whole milliseconds in the millisecond format.
   */
  readonly segmentTotal: bigint | null;
  /** The timecode format of the open source (`resolveTimecodeDisplay`). */
  readonly display: TimecodeDisplay;
}

/**
 * Returns the exact total duration of the segments of the active source, as one bigint in
 * the unit that the display counts: whole frames in the frame format, whole milliseconds in
 * the millisecond format. A store selector can return it, because a bigint compares by value:
 * the selector then settles on a value that changes only with the total.
 *
 * Each segment counts `index(outPts - start) - index(inPts - start)`, where `index` is
 * `elapsedGridIndex`: the frame index `J` of the frame timecode (ADR 028), or the whole
 * milliseconds of the millisecond timecode, with the rule of the playhead (ADR 022). The total
 * is the sum of these lengths, in both formats. The segment tooltip computes the length of
 * each segment with the same rule (`formatElapsedTickSpan`). A segment with no width on the
 * timeline has no tooltip, and it still counts here, because the export includes it. So the
 * tooltip lengths add up to this total when every segment of the source has a width.
 * The total is not a sum of tick lengths rounded once. A container can store each PTS rounded
 * to its time base, so a tick length can be up to one tick more or less than a whole number of
 * frames or milliseconds, and a rounded tick length can disagree with the two ends.
 *
 * Only the segments of the active source count. They share one time base, so their values can
 * be added (ADR 002, ADR 007).
 *
 * Returns null when the total is not known: no source, no valid start PTS, a segment of the
 * active source with no valid range, or an end that has no index (see `elapsedGridIndex`).
 */
export function totalActiveSourceSegments(
  segments: readonly Segment[],
  activeSourceId: string | null | undefined,
  source: SegmentTotalSource | null,
  display: TimecodeDisplay,
): bigint | null {
  if (source === null || !isPtsString(source.videoStartPts)) {
    return null;
  }
  const startPts = BigInt(source.videoStartPts);
  let total = 0n;
  for (const { segment } of getActiveSourceSegmentEntries(segments, activeSourceId)) {
    // A valid range means two canonical PTS values with inPts < outPts.
    if (!isValidSegmentRange(segment.inPts, segment.outPts)) {
      return null;
    }
    const inIndex = elapsedGridIndex(
      BigInt(segment.inPts) - startPts,
      source.videoTimeBase,
      display,
    );
    const outIndex = elapsedGridIndex(
      BigInt(segment.outPts) - startPts,
      source.videoTimeBase,
      display,
    );
    if (inIndex === null || outIndex === null) {
      return null;
    }
    total += outIndex - inIndex;
  }
  return total;
}

/**
 * Returns what the export action shows. The rules apply in this order:
 *
 * 1. No media: disabled, with the reason "Open a video first".
 * 2. An active run (preparing, running or publishing): the icon is a spinner, and the
 *    tooltip says that a click shows the running export. The export flow opens the dialog
 *    on that run (ADR 025). The label of the button stays "Export".
 * 3. No segment of the open source: available, with the hint "Mark at least one segment
 *    first". A click opens the dialog on the `noSegments` message (ADR 024).
 * 4. Otherwise: the number of segments and their total duration.
 *
 * Media stays open once it is open, so rule 1 never meets an active run. The order only
 * decides the result for a state that the application does not reach.
 */
export function presentExportAction(input: ExportActionInput): ExportActionView {
  if (!canExportMedia(input.hasMedia)) {
    return {
      disabled: true,
      busy: false,
      label: { key: "titleBar.action.export" },
      reason: "titleBar.exportTooltip.openVideoFirst",
    };
  }

  if (isExportRunActive(input.exportStatus)) {
    return {
      disabled: false,
      busy: true,
      label: { key: "titleBar.exportTooltip.showRunningExport" },
      reason: null,
    };
  }

  if (input.segmentCount === 0) {
    return {
      disabled: false,
      busy: false,
      label: { key: "titleBar.action.export" },
      reason: "titleBar.exportTooltip.markSegmentFirst",
    };
  }

  const duration =
    input.segmentTotal === null
      ? timecodePlaceholder(input.display)
      : formatGridCountTimecode(input.segmentTotal, input.display);

  return {
    disabled: false,
    busy: false,
    label: {
      key: "titleBar.exportTooltip.exportSegments",
      count: input.segmentCount,
      duration,
    },
    reason: null,
  };
}
