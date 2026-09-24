import { useMemo } from "react";
import { formatPreviewCurrentTime } from "@/components/preview/previewFrame";
import {
  usePlaybackStore,
  type PlaybackState,
  type PlaybackStoreState,
} from "@/features/playback";
import type { TimecodeDisplay } from "@/lib/timecode";
import type { Pts, Rational } from "@/types/project";

/** The playback facts that the displayed position reads. */
export type PlayheadTimecodeState = Pick<
  PlaybackState,
  | "seekTargetSeconds"
  | "presentedFrame"
  | "calibrationStatus"
  | "approximateBrowserTimeSeconds"
>;

/**
 * Formats the displayed playback position as the timecode that the preview shows for it, in
 * the format of the source (ADR 028). The seek slider gives it to assistive technology as its
 * `aria-valuetext`, so a screen reader reads the same timecode that the user sees.
 *
 * The rule is the one of the preview timecode, `formatPreviewCurrentTime`, and this function
 * only calls it, so the rule exists once. That rule takes the pending seek target first, then
 * the exact tick delta of the presented frame while the calibration is ready, and the
 * approximate clock otherwise (ADR 022). The frame branch formats ticks and not the seconds
 * that the playhead is drawn at, so a frame start never shows the frame before it.
 *
 * @param state The playback facts of the displayed position.
 * @param videoStartPts The start PTS of the source video stream.
 * @param videoTimeBase The video time base of the source.
 * @param display The timecode format of the source.
 */
export function formatPlayheadTimecode(
  state: PlayheadTimecodeState,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  display: TimecodeDisplay,
): string {
  // The preview passes the approximate clock with the same fallback to 0 (PreviewTimecode).
  return formatPreviewCurrentTime(
    state.presentedFrame,
    state.calibrationStatus,
    videoStartPts,
    videoTimeBase,
    state.approximateBrowserTimeSeconds ?? 0,
    state.seekTargetSeconds,
    display,
  );
}

const selectSeekTargetSeconds = (state: PlaybackStoreState) => state.seekTargetSeconds;
const selectPresentedFrame = (state: PlaybackStoreState) => state.presentedFrame;
const selectCalibrationStatus = (state: PlaybackStoreState) => state.calibrationStatus;
const selectApproximateBrowserTimeSeconds = (state: PlaybackStoreState) =>
  state.approximateBrowserTimeSeconds;

/**
 * Subscribes to the displayed playback position and returns its timecode
 * (`formatPlayheadTimecode`).
 *
 * It subscribes to the four fields that `useDisplayedPlaybackPosition` also reads. A component
 * that calls both hooks therefore renders once for each change of the position, and not once
 * more.
 *
 * @param videoStartPts The start PTS of the source video stream.
 * @param videoTimeBase The video time base of the source.
 * @param display The timecode format of the source. The value must be memoized.
 */
export function usePlayheadTimecode(
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  display: TimecodeDisplay,
): string {
  const seekTargetSeconds = usePlaybackStore(selectSeekTargetSeconds);
  const presentedFrame = usePlaybackStore(selectPresentedFrame);
  const calibrationStatus = usePlaybackStore(selectCalibrationStatus);
  const approximateBrowserTimeSeconds = usePlaybackStore(
    selectApproximateBrowserTimeSeconds,
  );
  return useMemo(
    () =>
      formatPlayheadTimecode(
        {
          seekTargetSeconds,
          presentedFrame,
          calibrationStatus,
          approximateBrowserTimeSeconds,
        },
        videoStartPts,
        videoTimeBase,
        display,
      ),
    [
      seekTargetSeconds,
      presentedFrame,
      calibrationStatus,
      approximateBrowserTimeSeconds,
      videoStartPts,
      videoTimeBase,
      display,
    ],
  );
}
