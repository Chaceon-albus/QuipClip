import { useMemo } from "react";
import {
  exportSourceFacts,
  type ExportSourceFacts,
} from "@/features/export/outputSummary";
import { useMediaStore, type MediaStoreState } from "@/features/media";
import type { MediaProbe } from "@/features/media/types";
import {
  selectActiveSourceSegmentCount,
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
 * `probe` is the probe of the attached clip, which decides alone with one clip.
 */
export function useExportSourceFacts(probe: MediaProbe | null): ExportSourceFacts {
  const segmentCount = useTimelineStore(selectActiveSourceSegmentCount);
  const clips = useTimelineStore(selectClips);
  const segments = useTimelineStore(selectSequenceSegments);
  const sources = useTimelineStore(selectSequenceSources);
  const imported = useMediaStore(selectImportedSources);
  return useMemo(
    () =>
      exportSourceFacts({ probe, segmentCount, clips, segments, sources, imported }),
    [probe, segmentCount, clips, segments, sources, imported],
  );
}
