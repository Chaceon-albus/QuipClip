/**
 * The number and the total duration of the segments of the active source.
 *
 * The Export tooltip of the title bar and the summary sentence of the export setup step both
 * read these functions, so the two places always show the same count and the same duration,
 * in the timecode format of the source (ADR 024, ADR 028). The segment tooltip of the timeline
 * computes the length of each segment with the same rule (`formatElapsedTickSpan`).
 * `totalExportSegments` gives the total of the segments of the export (ADR 066), which those two
 * places and the segment summary of the gutter show.
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
import type { Clip, Pts, Rational, Segment, SequenceSegment } from "@/types/project";
import { selectExportSegmentIds, type ExportSegmentsInput } from "./exportSegments";
import { getActiveSourceSegmentEntries } from "./math";
import { expandSegment, type SequenceSources } from "./sequence";
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
    const length = placedSegmentGridLength(segment, startPts, source, display);
    if (length === null) {
      return null;
    }
    total += length;
  }
  return total;
}

/**
 * The length of a segment of the active source on the grid of the display:
 * `index(outPts - start) - index(inPts - start)`, as `totalActiveSourceSegments` counts it. Null
 * for a segment with no valid range, or an end that has no index.
 */
function placedSegmentGridLength(
  segment: Pick<Segment, "inPts" | "outPts">,
  startPts: bigint,
  source: SegmentTotalSource,
  display: TimecodeDisplay,
): bigint | null {
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
  return outIndex - inIndex;
}

/**
 * The length of an anchored segment on the grid of the display, from its pieces (ADR 052): the
 * sum of the grid lengths of the pieces, each from the start PTS and in the time base of its own
 * source. It reads no virtual PTS, so it also gives the length of a segment that the derived
 * timeline cannot place. The rows of the Export Order dialog show it for such a segment
 * (ADR 066), and `totalExportSegments` adds it, so the rows and the total agree.
 *
 * Null when the segment has no pieces, a source has no valid start PTS, or an end has no index.
 */
export function sequenceSegmentGridLength(
  segment: SequenceSegment,
  clips: readonly Clip[],
  sources: SequenceSources,
  display: TimecodeDisplay,
): bigint | null {
  const pieces = expandSegment(segment, clips, sources);
  if (pieces === null || pieces.length === 0) {
    return null;
  }
  let total = 0n;
  for (const piece of pieces) {
    const source = sources.get(piece.sourceId);
    if (
      source === undefined ||
      source.videoStartPts === null ||
      !isPtsString(source.videoStartPts)
    ) {
      return null;
    }
    const start = BigInt(source.videoStartPts);
    const inIndex = elapsedGridIndex(
      BigInt(piece.inPts) - start,
      source.videoTimeBase,
      display,
    );
    const outIndex = elapsedGridIndex(
      BigInt(piece.outPts) - start,
      source.videoTimeBase,
      display,
    );
    if (inIndex === null || outIndex === null || outIndex < inIndex) {
      return null;
    }
    total += outIndex - inIndex;
  }
  return total;
}

/** The facts that `exportSegmentGridLength` reads, besides the segment. */
export interface ExportSegmentLengthFacts {
  readonly clips: readonly Clip[];
  readonly sources: SequenceSources;
  /** The virtual source of the timeline (the probe of the sequence), or null when not known. */
  readonly axis: SegmentTotalSource | null;
  /** The timecode format that the timeline shows (ADR 028). */
  readonly display: TimecodeDisplay;
}

/**
 * The length of one segment of the export on the grid of the display (ADR 066). The rows of the
 * Export Order dialog and `totalExportSegments` both read it, so no state exists in which the
 * rows show a duration and the total does not, or the reverse.
 *
 * - The length on the virtual axis, when the derived timeline places the segment and that
 *   calculation gives a value. It is the length that the tooltip of the bar shows
 *   (`formatSegmentTimes`), and the length that `totalActiveSourceSegments` counts.
 * - Else the length from its pieces (`sequenceSegmentGridLength`). This covers a segment that
 *   the derived timeline cannot place, a virtual PTS that the display cannot count, and an axis
 *   that is not known.
 * - Else null.
 *
 * @param placed The derived segment, or undefined when the derived timeline does not place it.
 * @param anchored The anchored segment, or undefined when the array does not hold it.
 */
export function exportSegmentGridLength(
  placed: Pick<Segment, "inPts" | "outPts"> | undefined,
  anchored: SequenceSegment | undefined,
  facts: ExportSegmentLengthFacts,
): bigint | null {
  const { axis, display } = facts;
  if (placed !== undefined && axis !== null && isPtsString(axis.videoStartPts)) {
    const length = placedSegmentGridLength(
      placed,
      BigInt(axis.videoStartPts),
      axis,
      display,
    );
    if (length !== null) {
      return length;
    }
  }
  return anchored === undefined
    ? null
    : sequenceSegmentGridLength(anchored, facts.clips, facts.sources, display);
}

/** The parts of the timeline state that `totalExportSegments` reads. */
export type ExportSegmentTotalInput = ExportSegmentsInput;

/**
 * The exact total duration of the segments of the export (ADR 066), as one bigint in the unit
 * that the display counts, as `totalActiveSourceSegments` gives it. The segment summary of the
 * gutter, the Export tooltip of the title bar and the summary sentence of the export setup read
 * it, with the count of `selectExportSegmentCount`, so the count and the total name the same
 * segments.
 *
 * It adds the length of each segment of `exportSegmentIds` (`exportSegmentGridLength`), which
 * the rows of the Export Order dialog show. When the virtual axis gives the length of every
 * segment, the value is the value of `totalActiveSourceSegments`. Null when a segment has no
 * known length.
 *
 * @param source The virtual source of the timeline (the probe of the sequence), or null.
 */
export function totalExportSegments(
  state: ExportSegmentTotalInput,
  source: SegmentTotalSource | null,
  display: TimecodeDisplay,
): bigint | null {
  const placed = new Map(
    getActiveSourceSegmentEntries(state.segments, state.sourceId).map(({ segment }) => [
      segment.id,
      segment,
    ]),
  );
  const anchored = new Map(state.sequenceSegments.map((entry) => [entry.id, entry]));
  const facts: ExportSegmentLengthFacts = {
    clips: state.clips,
    sources: new Map(Object.entries(state.sequenceSources)),
    axis: source,
    display,
  };
  let total = 0n;
  for (const id of selectExportSegmentIds(state)) {
    const length = exportSegmentGridLength(placed.get(id), anchored.get(id), facts);
    if (length === null) {
      return null;
    }
    total += length;
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
