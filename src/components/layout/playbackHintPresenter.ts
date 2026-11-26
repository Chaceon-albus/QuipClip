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
  /**
   * True while a new load of the preview can help (`canRecalibrate`, ADR 063). Absent means
   * false.
   */
  readonly canRecalibrate?: boolean;
  /**
   * True while a recalibration of the open source replaces the preview element
   * (`isRecalibrating`, ADR 063). The element is not ready for part of that time. Absent means
   * false.
   */
  readonly isRecalibrating?: boolean;
}

export type PlaybackHintDetailKey =
  | "statusBar.approximatePositionDetail"
  | "statusBar.approximatePositionMarks"
  | "statusBar.approximatePositionRetryMarks"
  | "statusBar.preparingPositionDetail"
  | "statusBar.preparingPositionMarks";

/** The keys of the approximate position, which the status bar item and the badge share. */
export type ApproximatePositionLineKey =
  "statusBar.approximatePosition" | "statusBar.approximatePositionRetry";

/**
 * What the approximate-position item of the status bar and the `≈` badge beside the preview
 * timecode say, and whether they are buttons. One source for both, so they never disagree.
 */
export interface ApproximatePositionView {
  /** The line of the item, and the accessible name of the badge. */
  readonly lineKey: ApproximatePositionLineKey;
  /** The lines of the tooltip. */
  readonly detail: readonly PlaybackHintDetailKey[];
  /**
   * True when the item and the badge are buttons that start a recalibration (`recalibrate`, ADR
   * 063). A click or Enter starts it. Space stays the play key of the window (ADR 026).
   */
  readonly recalibrates: boolean;
}

export interface PlaybackHintView {
  readonly lineKey: ApproximatePositionLineKey | "statusBar.preparingPosition";
  /** Longer text for the tooltip. The footer line does not wrap, so it stays short. */
  readonly detail: readonly PlaybackHintDetailKey[];
  /**
   * `warning` for a source that cannot calibrate. `neutral` while the calibration runs: that
   * state ends by itself at the first presented frame.
   */
  readonly tone: "warning" | "neutral";
  /** True when the item is a button that starts a recalibration (ApproximatePositionView). */
  readonly recalibrates: boolean;
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

/** Reads `canRecalibrate`. A primitive selector, for the same reason as above. */
export function selectCanRecalibrate(state: PlaybackStoreState): boolean {
  return state.canRecalibrate;
}

/**
 * Reports whether a recalibration of the open source is in progress. A primitive selector, for
 * the same reason as above.
 *
 * @param state Playback store state.
 * @param hasMedia True while a media source is open in the media store.
 */
export function selectIsRecalibrating(
  state: PlaybackStoreState,
  hasMedia: boolean,
): boolean {
  return hasMedia && state.isRecalibrating;
}

/**
 * Returns what the approximate position says while the calibration is unavailable.
 *
 * When a new load of the preview can help (ADR 063), the element never read the first frame of
 * the video. The line then asks for a click, and the tooltip says that the mark actions wait for
 * the exact frame timestamps and that a click loads the preview again. Otherwise the state holds
 * for the session, so the tooltip gives the next step of ADR 003: convert the video.
 *
 * @param canRecalibrate True while a recalibration can help (`canRecalibrate`).
 */
export function presentApproximatePosition(
  canRecalibrate: boolean,
): ApproximatePositionView {
  if (canRecalibrate) {
    return {
      lineKey: "statusBar.approximatePositionRetry",
      detail: [
        "statusBar.approximatePositionDetail",
        "statusBar.approximatePositionRetryMarks",
      ],
      recalibrates: true,
    };
  }
  return {
    lineKey: "statusBar.approximatePosition",
    detail: [
      "statusBar.approximatePositionDetail",
      "statusBar.approximatePositionMarks",
    ],
    recalibrates: false,
  };
}

/**
 * Returns the hint view, or null when there is nothing to say: no ready source, or a source
 * whose calibration is ready.
 *
 * The condition is the calibration status, not `isPlaybackPositionApproximate`. That
 * predicate is also true between a seek and the RVFC callback that answers it. A calibrated
 * source would then paint this warning for the length of every ruler click and every frame
 * step. The preview timecode badge keys on the calibration status for the same reason. The
 * calibration status is the state that disables Mark In, Mark Out, and Split.
 *
 * While the calibration runs, the hint says "Preparing the preview…" in the neutral tone.
 * The state ends at the first presented frame, and a navigation in it waits for that frame
 * and does not lose precise editing, so it is not a warning. Only a source that cannot
 * calibrate gets the warning.
 *
 * Each state has its own line about the mark actions. While the calibration runs, they wait
 * for the exact frame timestamps. A source that cannot calibrate gets the line of
 * `presentApproximatePosition`: a click that loads the preview again when that can help, and
 * the next step of ADR 003 otherwise.
 *
 * While a recalibration replaces the element (ADR 063), the hint says "Preparing the preview…"
 * too. The old element still reports its calibration, and the new element is not ready for a
 * while, but the preview prepares in both.
 */
export function presentPlaybackHint(state: PlaybackHintState): PlaybackHintView | null {
  const preparing =
    state.isRecalibrating === true ||
    (state.hasReadySource && state.calibrationStatus === "calibrating");
  if (!preparing && (!state.hasReadySource || state.calibrationStatus === "ready")) {
    return null;
  }
  if (preparing) {
    return {
      lineKey: "statusBar.preparingPosition",
      detail: ["statusBar.preparingPositionDetail", "statusBar.preparingPositionMarks"],
      tone: "neutral",
      recalibrates: false,
    };
  }
  return {
    ...presentApproximatePosition(state.canRecalibrate === true),
    // The state removes a capability, so it takes the same tone as a missing encoder.
    tone: "warning",
  };
}
