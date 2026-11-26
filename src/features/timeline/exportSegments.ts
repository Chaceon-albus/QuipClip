/**
 * The segments of the export (ADR 066): the segments that a request for an export would take at
 * this moment, in that order.
 *
 * The export reads one of two arrays (`composeExportRequest`):
 *
 * - One clip: the derived segments of the active source (`buildExportRequest`). The derived array
 *   holds only the segments that `derive` can place on the virtual axis.
 * - Several clips: the live anchored segments, each with its pieces (`sequenceExportPieces`).
 *
 * `exportSegmentIds` gives the ids of these segments, from the same two rules that build the
 * request. The dialog of ADR 066, the segment summary, the action Export Order and the numbers
 * `#N` of the segments all read it, so they agree with the export and with each other.
 *
 * The module has no React dependency.
 */

import type { Clip, Segment, SequenceSegment } from "@/types/project";
import { getActiveSourceSegmentEntries } from "./math";
import {
  expandSegment,
  isValidSequenceSegment,
  type SequencePiece,
  type SequenceSources,
} from "./sequence";
import type { TimelineState } from "./types";

/**
 * True when an export of `clips` reads the anchored segments of the sequence, and false when it
 * reads the derived segments of the one clip. `composeExportRequest` chooses its builder by this
 * rule, and `exportSegmentIds` chooses its array by it.
 */
export function isSequenceExport(clips: readonly Clip[]): boolean {
  return clips.length > 1;
}

/** A segment of an export of several clips, with its pieces in sequence order. */
export interface SequenceExportSegment {
  readonly segment: SequenceSegment;
  readonly pieces: readonly SequencePiece[];
}

/**
 * The segments that an export of several clips takes, in array order (ADR 007, ADR 052). A
 * segment that is not on the sequence, such as a segment of a clip that left it, gives no piece
 * and is not in the list. `sequenceExportPieces` builds the pieces of the request from this list.
 */
export function sequenceExportSegments(
  clips: readonly Clip[],
  segments: readonly SequenceSegment[],
  sources: SequenceSources,
): SequenceExportSegment[] {
  const result: SequenceExportSegment[] = [];
  for (const segment of segments) {
    if (!isValidSequenceSegment(segment, clips, sources)) {
      continue;
    }
    const pieces = expandSegment(segment, clips, sources);
    if (pieces === null || pieces.length === 0) {
      continue;
    }
    result.push({ segment, pieces });
  }
  return result;
}

/**
 * The segments that an export of one clip takes: the segments of the active source, in array
 * order (ADR 007). `buildExportRequest` builds one piece for each of them.
 */
export function oneClipExportSegments(
  segments: readonly Segment[],
  activeSourceId: string | null | undefined,
): Segment[] {
  return getActiveSourceSegmentEntries(segments, activeSourceId).map(
    (entry) => entry.segment,
  );
}

/** The parts of the timeline state that the segments of the export read. */
export type ExportSegmentsInput = Pick<
  TimelineState,
  "clips" | "sequenceSegments" | "sequenceSources" | "segments" | "sourceId"
>;

/**
 * The ids of the segments of the export, in the export order (ADR 066): exactly the segments
 * that `composeExportRequest` puts into a request at this moment.
 *
 * The order is the order of the array in both cases, because each rule only leaves segments out.
 */
export function exportSegmentIds(state: ExportSegmentsInput): string[] {
  if (isSequenceExport(state.clips)) {
    return sequenceExportSegments(
      state.clips,
      state.sequenceSegments,
      new Map(Object.entries(state.sequenceSources)),
    ).map((entry) => entry.segment.id);
  }
  return oneClipExportSegments(state.segments, state.sourceId).map(
    (segment) => segment.id,
  );
}

/** The inputs and the result of the last call of `selectExportSegmentIds`. */
interface ExportSegmentIdsCache {
  readonly clips: ExportSegmentsInput["clips"];
  readonly sequenceSegments: ExportSegmentsInput["sequenceSegments"];
  readonly sequenceSources: ExportSegmentsInput["sequenceSources"];
  readonly segments: ExportSegmentsInput["segments"];
  readonly sourceId: ExportSegmentsInput["sourceId"];
  readonly ids: readonly string[];
}

let lastIds: ExportSegmentIdsCache | null = null;

/**
 * `exportSegmentIds` as a store selector. It returns the same array while its inputs keep their
 * identity, and also while a new result holds the same ids in the same order. So a component
 * that selects it renders again only when the segments of the export or their order change.
 */
export function selectExportSegmentIds(state: ExportSegmentsInput): readonly string[] {
  const cache = lastIds;
  if (
    cache !== null &&
    cache.clips === state.clips &&
    cache.sequenceSegments === state.sequenceSegments &&
    cache.sequenceSources === state.sequenceSources &&
    cache.segments === state.segments &&
    cache.sourceId === state.sourceId
  ) {
    return cache.ids;
  }
  const next = exportSegmentIds(state);
  const ids =
    cache !== null &&
    cache.ids.length === next.length &&
    cache.ids.every((id, index) => id === next[index])
      ? cache.ids
      : next;
  lastIds = {
    clips: state.clips,
    sequenceSegments: state.sequenceSegments,
    sequenceSources: state.sequenceSources,
    segments: state.segments,
    sourceId: state.sourceId,
    ids,
  };
  return ids;
}

/**
 * The number of segments of the export (`selectExportSegmentIds`). It is a store selector: a
 * number compares by value.
 */
export function selectExportSegmentCount(state: ExportSegmentsInput): number {
  return selectExportSegmentIds(state).length;
}
