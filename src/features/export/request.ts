/**
 * Pure request assembler for media export operations.
 *
 * Implements:
 * - Filtering timeline segments to the active source preserving array order (ADR 007).
 * - One source and one piece for each active segment, in the wire of several sources (ADR 053).
 * - Boundary validation returning null when media or active segments are absent.
 */

import type { Preset } from "@/features/settings/types";
import { getActiveSourceSegmentEntries } from "@/features/timeline/math";
import type { Segment } from "@/types/project";
import type {
  ExportAudioMode,
  ExportPiece,
  ExportRequest,
  ExportSourceRevision,
  ExportStreams,
} from "./types";

/**
 * Parameters for assembling an `ExportRequest`.
 */
export interface BuildExportRequestOptions {
  /**
   * Path to the active source media file on disk.
   */
  sourcePath?: string | null;
  /**
   * Media object containing the source path (e.g. from `mediaStore.media`).
   */
  media?: { path: string } | null;
  /**
   * Destination path where the rendered video will be written.
   */
  outputPath?: string | null;
  /**
   * All timeline segments from the project or timeline store.
   * Multi-source segments will be filtered to `activeSourceId`.
   */
  segments?: readonly Segment[] | null;
  /**
   * Unique identifier of the active source clip.
   */
  activeSourceId?: string | null;
  /**
   * The preset that the export renders with, whole. Required: the backend reads no preset from
   * the settings file (ADR 049), so the caller passes the preset that the user saw.
   */
  preset: Preset;
  /**
   * The streams of the source that the export writes. Required: the backend refuses a
   * request without it, so each caller states the choice rather than inheriting a default.
   */
  streams: ExportStreams;
  /**
   * Whether the export copies the audio of the source or encodes it (ADR 048). Required, for
   * the reason of `streams`.
   */
  audioMode: ExportAudioMode;
  /**
   * The revision of the source that the segments were marked against, or null to send none:
   * the user chose to export a changed file anyway (ADR 024).
   */
  expectedSourceRevision?: ExportSourceRevision | null;
}

/**
 * Assembles an `ExportRequest` from store states.
 *
 * Requirements:
 * - Pure function, independently testable without component mount or store side-effects.
 * - Multi-source aware: filters segments to `activeSourceId` while strictly PRESERVING ARRAY ORDER (ADR 007).
 * - Never sorts segments; array order is export order.
 * - Names one source, the active source: its id is `activeSourceId`, its path the media path,
 *   and its `expectedRevision` the `expectedSourceRevision` of the caller, when it gives one.
 * - Maps each Segment to the piece `{ sourceId, inPts, outPts }` of that source, dropping its
 *   `id`, and counts one segment for each piece.
 * - Forwards `preset`, `streams` and `audioMode` unchanged.
 * - Returns `null` when there is no media, no output path, or no segments for the active source.
 *
 * @param options Export assembly parameters.
 * @returns The constructed ExportRequest, or null if requirements are not met.
 */
export function buildExportRequest(
  options: BuildExportRequestOptions,
): ExportRequest | null {
  const resolvedSourcePath = options.sourcePath || options.media?.path || null;
  if (!resolvedSourcePath || resolvedSourcePath.trim().length === 0) {
    return null;
  }

  if (!options.outputPath || options.outputPath.trim().length === 0) {
    return null;
  }

  if (!options.activeSourceId || options.activeSourceId.trim().length === 0) {
    return null;
  }

  if (!options.segments || options.segments.length === 0) {
    return null;
  }

  const activeEntries = getActiveSourceSegmentEntries(
    options.segments,
    options.activeSourceId,
  );

  if (activeEntries.length === 0) {
    return null;
  }

  const sourceId = options.activeSourceId;

  // Preserve array order strictly: one piece of the one source for each segment.
  const pieces: ExportPiece[] = activeEntries.map((entry) => ({
    sourceId,
    inPts: entry.segment.inPts,
    outPts: entry.segment.outPts,
  }));

  const source: ExportRequest["sources"][number] = {
    id: sourceId,
    path: resolvedSourcePath,
  };
  if (options.expectedSourceRevision) {
    source.expectedRevision = {
      size: options.expectedSourceRevision.size,
      mtime: options.expectedSourceRevision.mtime,
    };
  }

  return {
    sources: [source],
    pieces,
    segmentCount: pieces.length,
    outputPath: options.outputPath.trim(),
    preset: options.preset,
    streams: options.streams,
    audioMode: options.audioMode,
  };
}
