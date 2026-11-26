import { useMemo } from "react";
import {
  exportSourceFacts,
  type ExportSourceFacts,
} from "@/features/export/outputSummary";
import {
  useAudioOverrides,
  useMediaStore,
  type MediaStoreState,
} from "@/features/media";
import type { MediaProbe } from "@/features/media/types";
import {
  selectExportSegmentCount,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";

const selectClips = (state: TimelineStoreState) => state.clips;
const selectSequenceSegments = (state: TimelineStoreState) => state.sequenceSegments;
const selectSequenceSources = (state: TimelineStoreState) => state.sequenceSources;
const selectImportedSources = (state: MediaStoreState) => state.sources;

/**
 * The facts of the sources of the export (`exportSourceFacts`), from the timeline and the
 * imported media. The setup step and the dialog both read them, so the streams, the copy of the
 * audio and the summary agree with the request (ADR 036, ADR 048, ADR 053).
 *
 * `probe` is the probe of the attached clip, which decides alone with one clip. Each fact reads
 * the effective audio stream of its source, and a new override gives the step new facts
 * (ADR 070).
 */
export function useExportSourceFacts(probe: MediaProbe | null): ExportSourceFacts {
  const segmentCount = useTimelineStore(selectExportSegmentCount);
  const clips = useTimelineStore(selectClips);
  const segments = useTimelineStore(selectSequenceSegments);
  const sources = useTimelineStore(selectSequenceSources);
  const imported = useMediaStore(selectImportedSources);
  const audioOverrides = useAudioOverrides();
  return useMemo(
    () =>
      exportSourceFacts({
        probe,
        segmentCount,
        clips,
        segments,
        sources,
        imported,
        audioOverrides,
      }),
    [probe, segmentCount, clips, segments, sources, imported, audioOverrides],
  );
}
