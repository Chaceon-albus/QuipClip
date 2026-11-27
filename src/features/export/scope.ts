/**
 * The scope of an export (ADR 067): the whole export, or a list of segment ids.
 *
 * With the whole export, an export takes the segments of the export (ADR 066). With a list, it
 * takes the segments of the export whose id is in the list, in the export order. The order of
 * the list has no effect.
 *
 * `resolveExportScope` is the one function that gives the segments of a scope, with their pieces.
 * Each reader of the segments of the export inside the export dialog and the export flow reads
 * them through it: the checks of the open step, the two builders of the request, the request of
 * the loudness measurement, and the facts of the setup step. `narrowToExportScope` gives these
 * readers a timeline that holds only the segments of the scope, so each reader keeps its own
 * rules. Nothing outside the dialog reads a scope.
 *
 * A list has a record: the pieces of each of its segments, read one time, when the action makes
 * the list (`createSegmentListScope`). A list is valid only while each of its segments is a
 * segment of the export and gives the pieces of its record. An export of a list that is not valid
 * sends nothing, and the flow reports `selectedSegmentsChanged`.
 *
 * The module has no React dependency.
 */

import {
  isSequenceExport,
  oneClipExportSegments,
  sequenceExportSegments,
} from "@/features/timeline/exportSegments";
import type { SequenceSource } from "@/features/timeline/sequence";
import type { Clip, Pts, Segment, SequenceSegment } from "@/types/project";

/**
 * One source interval of a segment of the export, as a record of a list keeps it.
 *
 * With several clips it is a piece of `expandSegment`. With one clip it is the one piece of the
 * segment: the source and the clip of that clip, and the PTS of the segment, which with one clip
 * is a source PTS (ADR 052). With no clip, the source is the source of the segment and the clip is
 * null.
 */
export interface ExportScopePiece {
  readonly clipId: string | null;
  readonly sourceId: string;
  readonly inPts: Pts;
  readonly outPts: Pts;
}

/** One segment of a list, with the pieces that it gave when the action made the list. */
export interface ExportScopeRecordEntry {
  readonly id: string;
  readonly pieces: readonly ExportScopePiece[];
}

/**
 * The scope of an export (ADR 067).
 *
 * - `export`: the whole export.
 * - `list`: the segments of `record`, with the pieces of each one.
 */
export type ExportScope =
  | { readonly kind: "export" }
  | { readonly kind: "list"; readonly record: readonly ExportScopeRecordEntry[] };

/** The scope of the Export action, and of a run with no kept scope. */
export const WHOLE_EXPORT_SCOPE: ExportScope = { kind: "export" };

/** The parts of the timeline that the segments of a scope read. */
export interface ExportScopeInput {
  readonly clips: readonly Clip[];
  readonly sequenceSegments: readonly SequenceSegment[];
  readonly sequenceSources: Readonly<Record<string, SequenceSource>>;
  /** The derived segments, which an export of one clip reads. */
  readonly segments: readonly Segment[];
  /** The virtual source of the derived segments. */
  readonly sourceId: string | null;
}

/** One segment of the export, as a scope gives it. */
export interface ExportScopeSegment {
  readonly id: string;
  /**
   * The number of the segment among all the segments of the export, from 1, as its bar shows it
   * (ADR 066).
   */
  readonly number: number;
  /** The name of the segment (ADR 065), or undefined for a segment with no name. */
  readonly name: string | undefined;
  readonly pieces: readonly ExportScopePiece[];
}

/** The segments of a scope, and whether the scope is valid. */
export interface ExportScopeSegments {
  /** The segments of the export that the scope takes, in the export order. */
  readonly segments: readonly ExportScopeSegment[];
  /**
   * False for a list whose segment is no longer a segment of the export, or gives other pieces
   * than its record. Always true for the whole export.
   */
  readonly valid: boolean;
}

/**
 * Every segment of the export, in the export order, with its pieces. The rule is the rule of
 * `exportSegmentIds` (ADR 066): the anchored segments with several clips, the derived segments of
 * the active source with one clip.
 */
function allExportSegments(input: ExportScopeInput): ExportScopeSegment[] {
  if (isSequenceExport(input.clips)) {
    return sequenceExportSegments(
      input.clips,
      input.sequenceSegments,
      new Map(Object.entries(input.sequenceSources)),
    ).map(({ segment, pieces }, index) => ({
      id: segment.id,
      number: index + 1,
      name: segment.name,
      pieces: pieces.map((piece) => ({
        clipId: piece.clipId,
        sourceId: piece.sourceId,
        inPts: piece.inPts,
        outPts: piece.outPts,
      })),
    }));
  }
  const clip = input.clips[0];
  return oneClipExportSegments(input.segments, input.sourceId).map(
    (segment, index) => ({
      id: segment.id,
      number: index + 1,
      name: segment.name,
      pieces: [
        {
          clipId: clip?.id ?? null,
          sourceId: clip?.sourceId ?? segment.sourceId,
          inPts: segment.inPts,
          outPts: segment.outPts,
        },
      ],
    }),
  );
}

/** True when the two lists hold the same pieces in the same order. */
function samePieces(
  left: readonly ExportScopePiece[],
  right: readonly ExportScopePiece[],
): boolean {
  return (
    left.length === right.length &&
    left.every((piece, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        piece.clipId === other.clipId &&
        piece.sourceId === other.sourceId &&
        piece.inPts === other.inPts &&
        piece.outPts === other.outPts
      );
    })
  );
}

/**
 * A list of the segments `ids`, with its record: the pieces that each segment gives now. The
 * action of ADR 067 calls it one time, when it makes the list. An id that is not a segment of the
 * export gets no pieces, so the list is not valid (`resolveExportScope`).
 */
export function createSegmentListScope(
  input: ExportScopeInput,
  ids: readonly string[],
): ExportScope {
  const byId = new Map(
    allExportSegments(input).map((segment) => [segment.id, segment]),
  );
  const record = [...new Set(ids)].map((id) => ({
    id,
    pieces: byId.get(id)?.pieces ?? [],
  }));
  return { kind: "list", record };
}

/**
 * The segments of `scope`, with their pieces, and whether the scope is valid (ADR 067).
 *
 * The whole export gives every segment of the export. A list gives the segments of the export
 * whose id is in the list, in the export order. The list is valid only while each of its
 * segments is a segment of the export and gives the pieces of its record. A list that is not
 * valid still gives the segments of the export that it names, so the setup step can show them,
 * but the flow sends nothing for it.
 */
export function resolveExportScope(
  input: ExportScopeInput,
  scope: ExportScope,
): ExportScopeSegments {
  const all = allExportSegments(input);
  if (scope.kind === "export") {
    return { segments: all, valid: true };
  }
  const recorded = new Map(scope.record.map((entry) => [entry.id, entry.pieces]));
  const segments = all.filter((segment) => recorded.has(segment.id));
  const found = new Map(segments.map((segment) => [segment.id, segment]));
  const valid = scope.record.every((entry) => {
    const segment = found.get(entry.id);
    return segment !== undefined && samePieces(segment.pieces, entry.pieces);
  });
  return { segments, valid };
}

/**
 * `input` with only the segments of `scope` (`resolveExportScope`), in both arrays of segments.
 * The whole export gives `input` itself. Each reader of the dialog and the flow then applies its
 * own rule to the segments of the scope, as it applies it to the segments of the export.
 */
export function narrowToExportScope<T extends ExportScopeInput>(
  input: T,
  scope: ExportScope,
): T {
  if (scope.kind === "export") {
    return input;
  }
  const ids = new Set(resolveExportScope(input, scope).segments.map((s) => s.id));
  return {
    ...input,
    segments: input.segments.filter((segment) => ids.has(segment.id)),
    sequenceSegments: input.sequenceSegments.filter((segment) => ids.has(segment.id)),
  };
}

/**
 * The ids of the sources that the pieces of `segments` read, each one time, in the order of the
 * first piece that reads it.
 */
export function scopeSourceIds(segments: readonly ExportScopeSegment[]): string[] {
  return [
    ...new Set(segments.flatMap((segment) => segment.pieces.map((p) => p.sourceId))),
  ];
}
