import { useMemo } from "react";
import {
  exportScopeSourceFacts,
  type ExportSourceFacts,
} from "@/features/export/outputSummary";
import { WHOLE_EXPORT_SCOPE, type ExportScope } from "@/features/export/scope";
import {
  useAudioOverrides,
  useMediaStore,
  type MediaStoreState,
} from "@/features/media";
import type { MediaProbe } from "@/features/media/types";
import { useTimelineStore, type TimelineStoreState } from "@/features/timeline";

const selectClips = (state: TimelineStoreState) => state.clips;
const selectSequenceSegments = (state: TimelineStoreState) => state.sequenceSegments;
const selectSequenceSources = (state: TimelineStoreState) => state.sequenceSources;
const selectSegments = (state: TimelineStoreState) => state.segments;
const selectSourceId = (state: TimelineStoreState) => state.sourceId;
const selectImportedSources = (state: MediaStoreState) => state.sources;

/**
 * The facts of the sources of the export (`exportSourceFacts`), from the timeline and the
 * imported media. The setup step and the dialog both read them, so the streams, the copy of the
 * audio and the summary agree with the request (ADR 036, ADR 048, ADR 053).
 *
 * `probe` is the probe of the attached clip, which decides alone with one clip. Each fact reads
 * the effective audio stream of its source, and a new override gives the step new facts
 * (ADR 070).
 *
 * `scope` is the scope of the setup step (ADR 067). The facts read only the segments of the scope
 * (`exportScopeSourceFacts`). Defaults to the whole export.
 */
export function useExportSourceFacts(
  probe: MediaProbe | null,
  scope: ExportScope = WHOLE_EXPORT_SCOPE,
): ExportSourceFacts {
  const clips = useTimelineStore(selectClips);
  const sequenceSegments = useTimelineStore(selectSequenceSegments);
  const sequenceSources = useTimelineStore(selectSequenceSources);
  const segments = useTimelineStore(selectSegments);
  const sourceId = useTimelineStore(selectSourceId);
  const imported = useMediaStore(selectImportedSources);
  const audioOverrides = useAudioOverrides();
  return useMemo(
    () =>
      exportScopeSourceFacts({
        probe,
        timeline: { clips, sequenceSegments, sequenceSources, segments, sourceId },
        scope,
        imported,
        audioOverrides,
      }),
    [
      probe,
      scope,
      clips,
      sequenceSegments,
      sequenceSources,
      segments,
      sourceId,
      imported,
      audioOverrides,
    ],
  );
}
