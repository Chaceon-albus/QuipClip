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
import { isPtsString, segmentDurationTicks } from "@/lib/time";
import {
  formatFrameCountTimecode,
  formatMillisecondsFromTicks,
  frameIndexOfTicks,
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
   * source and the same display, or null when it is not known. Its unit depends on the
   * display: frames in the frame format, ticks of the video time base in the millisecond
   * format.
   */
  readonly segmentTotal: bigint | null;
  /** The video time base of the open source, or null with no media. */
  readonly videoTimeBase: Rational | null;
  /** The timecode format of the open source (`resolveTimecodeDisplay`). */
  readonly display: TimecodeDisplay;
}

/**
 * The frame index `J` that the frame timecode names for a PTS: the frame of the elapsed time
 * `pts - videoStartPts` (ADR 028). The playhead timecode uses the same function, with the same
 * margin. Null for a PTS before the start.
 */
function frameIndexOfPts(
  pts: bigint,
  startPts: bigint,
  videoTimeBase: Rational,
  display: Extract<TimecodeDisplay, { format: "frames" }>,
): bigint | null {
  return frameIndexOfTicks(
    pts - startPts,
    videoTimeBase,
    display.rate,
    display.videoTimeBase,
  );
}

/**
 * Returns the exact total duration of the segments of the active source, as one bigint in
 * the unit that the display counts. A store selector can return it, because a bigint
 * compares by value: the selector then settles on a value that changes only with the total.
 *
 * - Frame format: whole nominal frames. Each segment counts `J(outPts) - J(inPts)`, where `J`
 *   is the frame index that the frame timecode names for that PTS (ADR 028). The total is the
 *   sum of these counts, so it equals the sum of the frame counts of the segments. It is not
 *   made from a sum of tick lengths. A container can store each PTS rounded to its time base,
 *   so each tick length can be up to one tick more or less than a whole number of frames, and
 *   the errors of several segments add up to a wrong frame count.
 * - Millisecond format: ticks of the video time base, added exactly. The formatter rounds the
 *   sum once.
 *
 * Only the segments of the active source count. They share one time base, so their values can
 * be added (ADR 002, ADR 007).
 *
 * Returns null when the total is not known: no source, or a segment of the active source with
 * no valid range. In the frame format it also returns null with no valid start PTS, or for a
 * PTS before the start, because the frame timecode then names no frame.
 */
export function totalActiveSourceSegments(
  segments: readonly Segment[],
  activeSourceId: string | null | undefined,
  source: SegmentTotalSource | null,
  display: TimecodeDisplay,
): bigint | null {
  if (source === null) {
    return null;
  }
  const entries = getActiveSourceSegmentEntries(segments, activeSourceId);

  if (display.format === "milliseconds") {
    let ticks = 0n;
    for (const { segment } of entries) {
      const length = segmentDurationTicks(segment.inPts, segment.outPts);
      if (length === null) {
        return null;
      }
      ticks += length;
    }
    return ticks;
  }

  if (!isPtsString(source.videoStartPts)) {
    return null;
  }
  const startPts = BigInt(source.videoStartPts);
  let frames = 0n;
  for (const { segment } of entries) {
    // A valid range means two canonical PTS values with inPts < outPts.
    if (segmentDurationTicks(segment.inPts, segment.outPts) === null) {
      return null;
    }
    const inFrame = frameIndexOfPts(
      BigInt(segment.inPts),
      startPts,
      source.videoTimeBase,
      display,
    );
    const outFrame = frameIndexOfPts(
      BigInt(segment.outPts),
      startPts,
      source.videoTimeBase,
      display,
    );
    if (inFrame === null || outFrame === null) {
      return null;
    }
    frames += outFrame - inFrame;
  }
  return frames;
}

/** Formats a value of `totalActiveSourceSegments` in the display that produced it. */
function formatSegmentTotal(
  total: bigint,
  videoTimeBase: Rational | null,
  display: TimecodeDisplay,
): string {
  if (display.format === "frames") {
    return formatFrameCountTimecode(total, display.rate);
  }
  return videoTimeBase === null
    ? timecodePlaceholder(display)
    : formatMillisecondsFromTicks(total, videoTimeBase);
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
      : formatSegmentTotal(input.segmentTotal, input.videoTimeBase, input.display);

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
