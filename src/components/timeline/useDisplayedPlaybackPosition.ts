import { useMemo } from "react";
import {
  getDisplayedElapsedSeconds,
  isPlaybackPositionApproximate,
  usePlaybackStore,
  type PlaybackStoreState,
} from "@/features/playback";
import type { Pts, Rational } from "@/types/project";

const selectSeekTargetSeconds = (state: PlaybackStoreState) => state.seekTargetSeconds;
const selectPresentedFrame = (state: PlaybackStoreState) => state.presentedFrame;
const selectCalibrationStatus = (state: PlaybackStoreState) => state.calibrationStatus;
const selectApproximateBrowserTimeSeconds = (state: PlaybackStoreState) =>
  state.approximateBrowserTimeSeconds;

/** The playback position that the timeline draws. */
export interface DisplayedPlaybackPosition {
  /**
   * Seconds from the start of the source at which the playhead is drawn. This is display
   * only. The edit actions read `presentedFrame` (ADR 022).
   */
  elapsedSeconds: number;
  /** The target of the pending seek request, or null when no seek is pending. */
  seekTargetSeconds: number | null;
  /**
   * True while the position comes from the browser clock. The playhead takes no visual
   * mark for it: the status bar carries the marking, and marking it twice would make a
   * working playhead look broken.
   */
  isApproximate: boolean;
}

/**
 * Subscribes to the playback position that the timeline draws.
 *
 * A component that calls this hook renders again on every presented frame during playback.
 * Only the small layers that draw the position call it, so the timeline panel itself does
 * not render per frame. The subscription is synchronous: a seek action writes
 * `seekTargetSeconds`, and the layers draw that target in the same frame (ADR 022).
 *
 * The position is the inferred PTS of the presented frame relative to `videoStartPts`, and
 * the approximate browser clock otherwise. A source that never calibrates has no inferred
 * PTS for its whole session, and a frozen 0 would leave the playhead at the left edge while
 * the picture plays. Both branches report seconds elapsed from the start of the source, the
 * axis the whole ruler uses: the store subtracts the origin of the browser media timeline
 * from the approximate clock, and `onApproximateSeek` adds it back (ADR 003).
 *
 * When a seek is pending, `seekTargetSeconds` takes precedence over all other positions, so
 * the playhead tracks the target immediately (ADR 022).
 */
export function useDisplayedPlaybackPosition(
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
): DisplayedPlaybackPosition {
  const seekTargetSeconds = usePlaybackStore(selectSeekTargetSeconds);
  const presentedFrame = usePlaybackStore(selectPresentedFrame);
  const calibrationStatus = usePlaybackStore(selectCalibrationStatus);
  const approximateBrowserTimeSeconds = usePlaybackStore(
    selectApproximateBrowserTimeSeconds,
  );

  const elapsedSeconds = useMemo(
    () =>
      getDisplayedElapsedSeconds(
        {
          seekTargetSeconds,
          presentedFrame,
          calibrationStatus,
          approximateBrowserTimeSeconds,
        },
        videoStartPts,
        videoTimeBase,
      ),
    [
      seekTargetSeconds,
      presentedFrame,
      calibrationStatus,
      approximateBrowserTimeSeconds,
      videoStartPts,
      videoTimeBase,
    ],
  );

  return {
    elapsedSeconds,
    seekTargetSeconds,
    isApproximate: isPlaybackPositionApproximate(calibrationStatus, presentedFrame),
  };
}
