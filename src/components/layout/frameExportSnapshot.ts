/**
 * One read of the stores for the plan of Export Frame (ADR 069). `readShortcutSnapshot` calls it,
 * so the key, the button of the transport bar and the item of the macOS menu read the same state.
 */

import { formatPreviewCurrentTime } from "@/components/preview/previewFrame";
import { frameExportController } from "@/features/frameExport";
import { mediaStore } from "@/features/media/store";
import { playbackStore, resolveTimecodeDisplay } from "@/features/playback";
import { attachedMediaStore } from "@/features/sequence/attachedMedia";
import { sequenceMediaStore } from "@/features/sequence/media";
import { sequencePlayback } from "@/features/sequence/playback";
import { timecodePreferenceStore } from "@/features/settings/timecodePreference";
import type { FrameExportSnapshot } from "./frameExportPlan";

/**
 * The time that the preview timecode shows now: the position on the sequence, in the format of
 * the timecode row (`PreviewPane`, `PreviewTimecode`). Empty while no media is open.
 */
export function readDisplayedPreviewTime(): string {
  const probe = sequenceMediaStore.getState().media?.probe;
  if (!probe) {
    return "";
  }
  const sequence = sequencePlayback.store.getState();
  return formatPreviewCurrentTime(
    sequence.presentedFrame,
    sequence.calibrationStatus,
    probe.videoStartPts,
    probe.videoTimeBase,
    sequence.approximateBrowserTimeSeconds ?? 0,
    sequence.seekTargetSeconds,
    resolveTimecodeDisplay(timecodePreferenceStore.getState().format, probe),
  );
}

/** Reads the state that `planFrameExport` needs. */
export function readFrameExportSnapshot(): FrameExportSnapshot {
  return {
    // The store of the element, not the sequence: its PTS is a PTS of the source (ADR 052).
    playback: playbackStore.getState(),
    attachedMedia: attachedMediaStore.getState().media,
    sessionSourcePaths: Object.values(mediaStore.getState().sources).map(
      (source) => source.path,
    ),
    displayedTime: readDisplayedPreviewTime(),
    isBusy: frameExportController.store.getState().busy,
  };
}
