/**
 * The export request of a sequence of clips (ADR 052, ADR 053).
 *
 * Each segment on the sequence, in array order, expands into pieces: source intervals in sequence
 * order (`expandSegment`). The request names each source that a piece uses once, in the order of
 * its first piece, with its path and the revision that the segments were marked against. The
 * backend sees an ordered list of source intervals and knows nothing of clips.
 */

import type { ImportMediaResult } from "@/features/media/types";
import {
  expandSegment,
  isValidSequenceSegment,
  type SequenceSources,
} from "@/features/timeline/sequence";
import type { Clip, SequenceSegment } from "@/types/project";
import {
  ExportError,
  type ExportAudioMode,
  type ExportPiece,
  type ExportRequest,
  type ExportSource,
  type ExportSourceRevision,
  type ExportStreams,
} from "./types";
import type { Preset } from "@/features/settings/types";
import { ptsToBigInt } from "@/lib/time";

/**
 * The most pieces that one export joins (ADR 055). It is a copy of `MAX_EXPORT_PIECES` in
 * `src-tauri/src/ffmpeg/export/mod.rs`, which is the source of truth, and `types.test.ts` reads
 * that file and asserts that the two values are equal. The backend refuses more pieces with
 * `tooManySegments`. The OPEN step refuses them first, so the user learns it before naming an
 * output file.
 */
export const MAX_EXPORT_PIECES = 256;

/**
 * The most inputs that one export process opens, and so the most sources of one export and the
 * most runs of its pieces (ADR 055). It is a copy of `MAX_EXPORT_INPUTS` in
 * `src-tauri/src/ffmpeg/export/inputs.rs`, which is the source of truth, and `types.test.ts`
 * reads that file and asserts that the two values are equal.
 */
export const MAX_EXPORT_INPUTS = 85;

/** A piece as the count of runs reads it: its source and its In and Out points. */
export type RunPiece = Pick<ExportPiece, "sourceId" | "inPts" | "outPts">;

/**
 * The count of runs of `pieces`, by the rule of `source_runs` in
 * `src-tauri/src/ffmpeg/export/inputs.rs` (ADR 055).
 *
 * The pieces are taken in export order. Each piece joins the run of its own source whose last
 * piece has the latest Out point at or before the In point of the piece. When two such runs end at
 * the same Out point, the piece joins the one that opened first. When no run of its source ends at
 * or before its In point, the piece opens a new run. The Out point is exclusive (ADR 002), so a
 * piece whose In point equals the Out point of a run joins that run.
 *
 * The PTS are compared exactly, as `bigint`, and only within one source, never across two
 * (ADR 002). `inputRunCases.json` holds the cases that this function and the Rust function both
 * run.
 */
export function countInputRuns(pieces: readonly RunPiece[]): number {
  // The runs in the order they opened, with the source and the Out point of the last piece.
  const runs: { sourceId: string; lastOut: bigint }[] = [];
  for (const piece of pieces) {
    const inPts = ptsToBigInt(piece.inPts);
    let best: { sourceId: string; lastOut: bigint } | null = null;
    for (const run of runs) {
      // A later run with an equal Out point does not replace the earlier one.
      if (
        run.sourceId === piece.sourceId &&
        run.lastOut <= inPts &&
        (best === null || run.lastOut > best.lastOut)
      ) {
        best = run;
      }
    }
    const outPts = ptsToBigInt(piece.outPts);
    if (best === null) {
      runs.push({ sourceId: piece.sourceId, lastOut: outPts });
    } else {
      best.lastOut = outPts;
    }
  }
  return runs.length;
}

/**
 * The refusal of the limits of ADR 055 for the export of `pieces` from `sourceCount` sources, or
 * null when the export is within them. The checks run in the order of the backend, and each
 * refusal names its limit:
 *
 * 1. More pieces than `MAX_EXPORT_PIECES` -- `tooManySegments`, with `pieceLimit`.
 * 2. More sources than `MAX_EXPORT_INPUTS` -- `tooManySources`, with `sourceLimit`.
 * 3. More pieces than `MAX_EXPORT_INPUTS`, which need more runs than `MAX_EXPORT_INPUTS`
 *    (`countInputRuns`) -- `piecesOutOfOrder`, with `inputLimit`.
 */
export function exportLimitError(
  pieces: readonly RunPiece[],
  sourceCount: number,
): ExportError | null {
  if (pieces.length > MAX_EXPORT_PIECES) {
    return new ExportError({ code: "tooManySegments", pieceLimit: MAX_EXPORT_PIECES });
  }
  if (sourceCount > MAX_EXPORT_INPUTS) {
    return new ExportError({ code: "tooManySources", sourceLimit: MAX_EXPORT_INPUTS });
  }
  if (pieces.length > MAX_EXPORT_INPUTS) {
    let runs: number;
    try {
      runs = countInputRuns(pieces);
    } catch {
      // A PTS that is not a decimal integer. The store validates each PTS, so this only reports
      // what the backend would refuse anyway, instead of rejecting the OPEN step without a word.
      return new ExportError({ code: "invalidSegment" });
    }
    if (runs > MAX_EXPORT_INPUTS) {
      return new ExportError({
        code: "piecesOutOfOrder",
        inputLimit: MAX_EXPORT_INPUTS,
      });
    }
  }
  return null;
}

/** The inputs of `buildSequenceExportRequest`. */
export interface SequenceExportRequestOptions {
  readonly clips: readonly Clip[];
  readonly segments: readonly SequenceSegment[];
  /** The timing facts of the sources, by source ID. */
  readonly sources: SequenceSources;
  /** The imported media of the sources, by source ID: the path and the revision of each file. */
  readonly media: Readonly<Record<string, ImportMediaResult>>;
  readonly outputPath: string;
  readonly preset: Preset;
  readonly streams: ExportStreams;
  readonly audioMode: ExportAudioMode;
  /**
   * True to send the revision of each source, so the backend refuses a file that changed while
   * the export waited. False after "Export anyway", which checks nothing (ADR 024).
   */
  readonly checkRevisions: boolean;
}

/** The pieces and the sources of the segments on the sequence, in export order. */
export interface SequenceExportPieces {
  readonly pieces: ExportPiece[];
  /** The IDs of the sources that the pieces use, in the order of their first piece. */
  readonly sourceIds: string[];
  /** The number of segments that gave pieces. */
  readonly segmentCount: number;
}

/**
 * The pieces of the segments on the sequence, in array order (ADR 007). A segment that is not on
 * the sequence, such as a segment of a clip that left it, gives no piece.
 */
export function sequenceExportPieces(
  clips: readonly Clip[],
  segments: readonly SequenceSegment[],
  sources: SequenceSources,
): SequenceExportPieces {
  const pieces: ExportPiece[] = [];
  const sourceIds: string[] = [];
  let segmentCount = 0;
  for (const segment of segments) {
    if (!isValidSequenceSegment(segment, clips, sources)) {
      continue;
    }
    const expanded = expandSegment(segment, clips, sources);
    if (expanded === null || expanded.length === 0) {
      continue;
    }
    segmentCount += 1;
    for (const piece of expanded) {
      if (!sourceIds.includes(piece.sourceId)) {
        sourceIds.push(piece.sourceId);
      }
      pieces.push({
        sourceId: piece.sourceId,
        inPts: piece.inPts,
        outPts: piece.outPts,
      });
    }
  }
  return { pieces, sourceIds, segmentCount };
}

/** The revision of an imported file, as the import reported it (ADR 010). */
export function revisionOf(media: ImportMediaResult): ExportSourceRevision {
  return { size: media.size, mtime: media.mtime };
}

/**
 * The export request of the sequence, or null when no segment gives a piece, the output path is
 * blank, or a source of a piece has no imported media.
 */
export function buildSequenceExportRequest(
  options: SequenceExportRequestOptions,
): ExportRequest | null {
  const outputPath = options.outputPath.trim();
  if (outputPath.length === 0) {
    return null;
  }
  const { pieces, sourceIds, segmentCount } = sequenceExportPieces(
    options.clips,
    options.segments,
    options.sources,
  );
  if (pieces.length === 0) {
    return null;
  }
  const sources: ExportSource[] = [];
  for (const id of sourceIds) {
    const media = options.media[id];
    if (media === undefined) {
      return null;
    }
    const source: ExportSource = { id, path: media.path };
    if (options.checkRevisions) {
      source.expectedRevision = revisionOf(media);
    }
    sources.push(source);
  }
  return {
    sources,
    pieces,
    segmentCount,
    outputPath,
    preset: options.preset,
    streams: options.streams,
    audioMode: options.audioMode,
  };
}
