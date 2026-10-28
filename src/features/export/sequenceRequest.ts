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
import type {
  ExportAudioMode,
  ExportPiece,
  ExportRequest,
  ExportSource,
  ExportSourceRevision,
  ExportStreams,
} from "./types";
import type { Preset } from "@/features/settings/types";

/**
 * The most pieces that one export joins. It is a copy of `MAX_EXPORT_SEGMENTS` in
 * `src-tauri/src/ffmpeg/export/mod.rs`, and the two values must stay equal. The backend refuses
 * more pieces with `tooManySegments`. The OPEN step refuses them first, so the user learns it
 * before naming an output file (ADR 053).
 */
export const MAX_EXPORT_PIECES = 48;

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
