/**
 * Pure request assembler for media export operations.
 *
 * Implements:
 * - Filtering timeline segments to the active source preserving array order (ADR 007).
 * - Dropping segment id and sourceId to construct ExportSegmentBoundary intervals.
 * - Boundary validation returning null when media or active segments are absent.
 */

import { getActiveSourceSegmentEntries } from "@/features/timeline/math";
import type { Segment } from "@/types/project";
import type { ExportRequest, ExportSegmentBoundary } from "./types";

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
   * Optional preset identifier configuring the encoder.
   */
  presetId?: string;
}

/**
 * Assembles an `ExportRequest` from store states.
 *
 * Requirements:
 * - Pure function, independently testable without component mount or store side-effects.
 * - Multi-source aware: filters segments to `activeSourceId` while strictly PRESERVING ARRAY ORDER (ADR 007).
 * - Never sorts segments; array order is export order.
 * - Maps each Segment to `{ inPts, outPts }`, dropping `id` and `sourceId`.
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

  // Preserve array order strictly; map to { inPts, outPts }
  const segments: ExportSegmentBoundary[] = activeEntries.map((entry) => ({
    inPts: entry.segment.inPts,
    outPts: entry.segment.outPts,
  }));

  const request: ExportRequest = {
    sourcePath: resolvedSourcePath,
    outputPath: options.outputPath.trim(),
    segments,
  };

  if (options.presetId !== undefined && options.presetId.trim().length > 0) {
    request.presetId = options.presetId;
  }

  return request;
}
