/**
 * The number and the total duration of the segments of the active source.
 *
 * The Export tooltip of the title bar and the summary sentence of the export setup step both
 * read these functions, so the two places always show the same count and the same duration,
 * in the timecode format of the source (ADR 024, ADR 028). The segment tooltip of the timeline
 * computes the length of each segment with the same rule (`formatElapsedTickSpan`).
 *
 * Pure module with no React dependencies.
 */

import { isPtsString, isValidSegmentRange } from "@/lib/time";
import {
  elapsedGridIndex,
  formatGridCountTimecode,
  timecodePlaceholder,
  type TimecodeDisplay,
} from "@/lib/timecode";
import type { Pts, Rational, Segment } from "@/types/project";
import { getActiveSourceSegmentEntries } from "./math";
import type { TimelineState } from "./types";

/** The facts of the open source that the segment total reads. */
export interface SegmentTotalSource {
  /** The time base of every segment PTS of the source (ADR 002). */
  readonly videoTimeBase: Rational;
  /** The PTS at which the elapsed time of the source is zero, or null when unstated. */
  readonly videoStartPts: Pts | null;
}

/**
 * Returns the number of segments of the active source. It is a store selector: a number
 * compares by value, so a component renders again only when the count changes.
 */
export function selectActiveSourceSegmentCount(
  state: Pick<TimelineState, "segments" | "sourceId">,
): number {
  return getActiveSourceSegmentEntries(state.segments, state.sourceId).length;
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
 * Formats a value of `totalActiveSourceSegments` in the display that produced it, as
 * `formatGridCountTimecode` writes it, or the placeholder of the display when the total is
 * not known.
 *
 * @param total The value of `totalActiveSourceSegments` with `display`.
 * @param display The format that applies to the source.
 */
export function formatSegmentTotal(
  total: bigint | null,
  display: TimecodeDisplay,
): string {
  return total === null
    ? timecodePlaceholder(display)
    : formatGridCountTimecode(total, display);
}
