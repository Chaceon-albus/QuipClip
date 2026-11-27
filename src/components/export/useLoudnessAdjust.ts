/**
 * The Adjust switch of the Gain row, as the export dialog runs it (ADR 061).
 *
 * While the switch is active, the hook measures the audio of the export, and fills the Gain field
 * with the gain that brings the true peak to -1.0 dBTP. It measures again when the identity of the
 * request changes (the sources, the pieces, the rate, the channels, the streams, or the frame
 * rate with video), and when the switch becomes active again: at a later opening of the dialog,
 * and when the Audio switch turns on again. It cancels the measurement when the switch stops
 * being active. Until a measurement fills the field, the field shows the gain of the preset.
 * `gainAdjust.ts` holds the state and its rules, and this module connects them to React.
 */

import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { measurementScope } from "@/components/layout/exportFlowController";
import { WHOLE_EXPORT_SCOPE, type ExportScope } from "@/features/export/scope";
import type { ExportStreams } from "@/features/export/types";
import {
  loudnessRequestId,
  loudnessStore,
  useLoudnessMeasurement,
} from "@/features/loudness/store";
import type { LoudnessScope } from "@/features/loudness/types";
import {
  useAudioOverrides,
  useMediaStore,
  type MediaStoreState,
} from "@/features/media";
import { useAttachedMediaStore } from "@/features/sequence/attachedMedia";
import type { Preset } from "@/features/settings/types";
import { useTimelineStore, type TimelineStoreState } from "@/features/timeline";
import { createGainAdjust, presentGainAdjust, type GainAdjustView } from "./gainAdjust";

const selectClips = (state: TimelineStoreState) => state.clips;
const selectSequenceSegments = (state: TimelineStoreState) => state.sequenceSegments;
const selectSequenceSources = (state: TimelineStoreState) => state.sequenceSources;
const selectSegments = (state: TimelineStoreState) => state.segments;
const selectSourceId = (state: TimelineStoreState) => state.sourceId;
const selectImportedSources = (state: MediaStoreState) => state.sources;
const selectAttachedMedia = (state: MediaStoreState) => state.media;

/**
 * The scope of the measurement of the export that the step would start now, from the stores that
 * the export flow reads (`measurementScope`), or null without a preset or a request. It measures
 * the pieces of the segments of `exportScope`, the scope of the setup step (ADR 067).
 */
export function useMeasurementScope(
  preset: Preset | null,
  streams: ExportStreams,
  skipSourceRevisionCheck: boolean,
  exportScope: ExportScope = WHOLE_EXPORT_SCOPE,
): LoudnessScope | null {
  const clips = useTimelineStore(selectClips);
  const sequenceSegments = useTimelineStore(selectSequenceSegments);
  const sequenceSources = useTimelineStore(selectSequenceSources);
  const segments = useTimelineStore(selectSegments);
  const sourceId = useTimelineStore(selectSourceId);
  const sources = useMediaStore(selectImportedSources);
  const media = useAttachedMediaStore(selectAttachedMedia);
  // A new override gives the scope a new identity, so a measurement of the old streams ends with
  // no result for the step (ADR 070).
  const audioOverrides = useAudioOverrides();
  return useMemo(
    () =>
      preset === null
        ? null
        : measurementScope({
            timeline: { clips, sequenceSegments, sequenceSources },
            sources,
            media,
            segments,
            sourceId,
            preset,
            streams,
            skipSourceRevisionCheck,
            audioOverrides,
            scope: exportScope,
          }),
    [
      exportScope,
      clips,
      sequenceSegments,
      sequenceSources,
      segments,
      sourceId,
      sources,
      media,
      preset,
      streams,
      skipSourceRevisionCheck,
      audioOverrides,
    ],
  );
}

export interface LoudnessAdjustInput {
  /**
   * True while the step measures: the dialog shows the setup step, the Adjust switch is on, the
   * Gain row shows, and the preset can export.
   */
  readonly active: boolean;
  /** The scope of the export, or null when the request cannot be built. */
  readonly scope: LoudnessScope | null;
  /** The gain of the selected preset, in tenths of a decibel. */
  readonly presetGainTenths: number;
}

export interface LoudnessAdjust extends GainAdjustView {
  /**
   * The identity of the request of the measurement, or null while the step does not measure. The
   * export compares it with the request after the save panel (`confirmExportFlow`).
   */
  readonly request: string | null;
  readonly setFieldText: (text: string) => void;
}

/** The Gain field and the measurement of the setup step, for the life of the web view. */
export const gainAdjust = createGainAdjust(loudnessStore);

const setFieldText = (text: string): void => {
  gainAdjust.type(text);
};

export function useLoudnessAdjust({
  active,
  scope,
  presetGainTenths,
}: LoudnessAdjustInput): LoudnessAdjust {
  const followed = active ? scope : null;
  const request = useMemo(
    () => (followed === null ? null : loudnessRequestId(followed)),
    [followed],
  );
  const state = useStore(gainAdjust.store);
  const measurement = useLoudnessMeasurement((store) => store.measurement);

  // A scope of a new identity starts a request, and null stops it. `follow` ignores a scope of the
  // same identity, so a change that does not change the audio keeps the field.
  useEffect(() => {
    gainAdjust.follow(followed);
  }, [followed]);

  // The dialog goes away: the measurement stops.
  useEffect(
    () => () => {
      gainAdjust.follow(null);
    },
    [],
  );

  return {
    ...presentGainAdjust(state, measurement, request, presetGainTenths),
    request,
    setFieldText,
  };
}
