/**
 * The timing facts of an imported source that the sequence reads (ADR 052).
 */

import type { SequenceSource } from "@/features/timeline/sequence";
import { getGeneratedSourceId } from "./sourceIdentity";
import type { ImportMediaResult } from "./types";

/**
 * The sequence source of an imported media file, or null when the file has no revision key. Its
 * ID is the generated source ID, which the revision key keys, so a file that changed on disk is a
 * new source (ADR 010).
 */
export function toSequenceSource(media: ImportMediaResult): SequenceSource | null {
  const id = getGeneratedSourceId(media);
  if (id === null) {
    return null;
  }
  return {
    id,
    videoTimeBase: media.probe.videoTimeBase,
    videoStartPts: media.probe.videoStartPts,
    videoEndPts: media.probe.videoEndPts,
    videoDurationTicks: media.probe.videoDurationTicks,
    approximateDurationSeconds: media.probe.approximateDurationSeconds,
  };
}
