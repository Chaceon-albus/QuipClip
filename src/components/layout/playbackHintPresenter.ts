/**
 * Pure presenter for the status bar's playback-position hint.
 *
 * The playhead follows the approximate browser clock whenever the exact frame timestamp is
 * unknown, and the playhead itself carries no visual mark for that. This line is the only
 * place that states it, and the only place that explains why Mark In, Mark Out, and Split
 * are disabled (ADR 003). Returns translation keys and values without calling the i18n
 * runtime (ADR 011).
 */

import type { CalibrationStatus, PlaybackStoreState } from "@/features/playback";

/** Exactly the facts the hint reads. */
export interface PlaybackHintState {
  /** True while an attached element of the open source has loaded metadata. */
  readonly hasReadySource: boolean;
  /** Calibration status of the active source. */
  readonly calibrationStatus: CalibrationStatus;
}

export type PlaybackHintDetailKey =
  | "statusBar.approximatePositionDetail"
  | "statusBar.approximatePositionMarks"
  | "statusBar.preparingPositionDetail";

export interface PlaybackHintView {
  readonly lineKey: "statusBar.approximatePosition" | "statusBar.preparingPosition";
  /** Longer text for the tooltip. The footer line does not wrap, so it stays short. */
  readonly detail: readonly PlaybackHintDetailKey[];
  /**
   * `warning` for a source that cannot calibrate. `neutral` while the calibration runs: that
   * state ends by itself at the first presented frame.
   */
  readonly tone: "warning" | "neutral";
}

/**
 * Reports whether a ready element of the open source is attached.
 *
 * A selector over primitives, because the playback store notifies once per presented frame:
 * the equality check settles on a boolean and stops the re-render there without allocating.
 *
 * @param state Playback store state.
 * @param hasMedia True while a media source is open in the media store.
 */
export function selectHasReadySource(
  state: PlaybackStoreState,
  hasMedia: boolean,
): boolean {
  return hasMedia && state.isAttached && state.isReady;
}

/** Reads the calibration status. A primitive selector, for the same reason as above. */
export function selectCalibrationStatus(state: PlaybackStoreState): CalibrationStatus {
  return state.calibrationStatus;
}

/**
 * Returns the hint view, or null when there is nothing to say: no ready source, or a source
 * whose calibration is ready.
 *
 * The condition is the calibration status, not `isPlaybackPositionApproximate`. That
 * predicate is also true between a seek and the RVFC callback that answers it. A calibrated
 * source would then paint this warning for the length of every ruler click and every frame
 * step. The preview timecode badge keys on the calibration status for the same reason. The
 * calibration status holds for a whole session, and it is the state that disables Mark In,
 * Mark Out, and Split.
 *
 * While the calibration runs, the hint says "Preparing the preview..." in the neutral tone.
 * The state ends at the first presented frame, and a navigation in it waits for that frame
 * and does not lose precise editing, so it is not a warning. Only a source that cannot
 * calibrate gets the warning.
 */
export function presentPlaybackHint(state: PlaybackHintState): PlaybackHintView | null {
  if (!state.hasReadySource || state.calibrationStatus === "ready") {
    return null;
  }
  if (state.calibrationStatus === "calibrating") {
    return {
      lineKey: "statusBar.preparingPosition",
      detail: [
        "statusBar.preparingPositionDetail",
        "statusBar.approximatePositionMarks",
      ],
      tone: "neutral",
    };
  }
  return {
    lineKey: "statusBar.approximatePosition",
    detail: [
      "statusBar.approximatePositionDetail",
      "statusBar.approximatePositionMarks",
    ],
    // The state removes a capability, so it takes the same tone as a missing encoder.
    tone: "warning",
  };
}
