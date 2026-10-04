/**
 * Pure presenter for the reason that a transport control is disabled.
 *
 * The tooltip of Mark In, Mark Out, Split, the two frame step buttons and the play button shows
 * a second line while the control is disabled, so the user learns what to do. The presenter
 * reads the same facts as the conditions of those controls (`canMarkIn`, `canMarkOut`,
 * `canSplitCurrentSegment`, `canStepFrames` and `canTogglePlayback`) and first asks each
 * condition itself, so it never gives a reason for an enabled control.
 *
 * Every seek clears `presentedFrame` until the frame callback answers it (ADR 022), which
 * disables the three edit controls for a few frames, and the transport bar delays the dimming
 * for that window. The reason line must not change in that window either, or the tooltip
 * would switch between one line and two on every frame step. Two rules keep it still:
 *
 * - A reason that does not depend on the playhead comes before the test for a pending seek,
 *   so a seek does not interrupt it. "Mark an In point first" is true at every position.
 * - A reason that depends on the playhead cannot be known while the seek is pending. The
 *   presenter then returns `EDIT_REASON_PENDING`, and `settleDisabledReason` keeps the last
 *   settled reason until the frame callback answers.
 *
 * The presenter also gives the description of Mark In and of Mark Out while a press would
 * finish the current segment (`presentMarkInFinishesSegment`, `presentMarkOutFinishesSegment`).
 * Those lines depend on the playhead too, so they settle by the same rule.
 *
 * It returns translation keys and does not call the i18n runtime (ADR 011).
 */

import { canStepFrames, canTogglePlayback } from "@/components/layout/actionConditions";
import type { PlaybackState } from "@/features/playback";
import {
  canMarkIn,
  canMarkOut,
  canSplitCurrentSegment,
  markInFinishesSegment,
  markOutFinishesSegment,
  planFinishSegment,
  type CurrentSegmentTarget,
} from "@/features/timeline";
import { isPtsString } from "@/lib/time";
import type { Pts } from "@/types/project";

/** The edit controls that can show a reason. */
export type EditReasonControl = "markIn" | "markOut" | "split";

export type TransportDisabledReasonKey =
  | "transport.disabledReason.preciseMarkingUnavailable"
  | "transport.disabledReason.markInFirst"
  | "transport.disabledReason.selectSegment"
  | "transport.disabledReason.playheadInsideSegment"
  | "transport.disabledReason.playheadAfterIn"
  | "transport.disabledReason.atInPoint"
  | "transport.disabledReason.noFrameRate"
  | "transport.disabledReason.decodeStalled";

/** The description of Mark In while a press would finish the current segment. */
export type MarkInFinishesSegmentKey = "transport.state.finishesSegment";

/** The description of Mark Out while a press would finish the current segment at its Out. */
export type MarkOutFinishesSegmentKey = "transport.state.finishesAtOut";

/**
 * The value for a disabled control whose reason depends on a playhead position that a
 * pending seek has not confirmed yet, and for a description that depends on it in the same
 * way. It is not a reason or a description: the caller keeps the last one.
 */
export const EDIT_REASON_PENDING = "pending";

export type EditDisabledReason =
  TransportDisabledReasonKey | typeof EDIT_REASON_PENDING | null;

export type MarkInFinishesSegmentDescription =
  MarkInFinishesSegmentKey | typeof EDIT_REASON_PENDING | null;

export type MarkOutFinishesSegmentDescription =
  MarkOutFinishesSegmentKey | typeof EDIT_REASON_PENDING | null;

/** The description of Finish while an In mark is pending: what a press does now. */
export type FinishSegmentDescriptionKey =
  "transport.state.finishCompletesSegment" | "transport.state.finishDiscardsIn";

export type FinishSegmentDescription =
  FinishSegmentDescriptionKey | typeof EDIT_REASON_PENDING | null;

/**
 * The playback facts that the reason reads. The playback store state satisfies it as it is,
 * so a store selector can pass its state without allocating an object for each frame.
 */
export type TransportReasonPlayback = Pick<
  PlaybackState,
  "calibrationStatus" | "presentedFrame" | "seekTargetSeconds"
> & {
  /**
   * The decode stall of the preview element (ADR 039). Only the description of Finish reads
   * it. Absent means none.
   */
  readonly decodeStall?: PlaybackState["decodeStall"];
};

/** The facts that change only with an edit or with the source, not with each frame. */
export interface EditReasonContext {
  /** True while media is open and an attached element of it has loaded metadata. */
  readonly hasActiveSource: boolean;
  readonly pendingInPts: Pts | null;
  readonly currentTarget: CurrentSegmentTarget;
}

/**
 * Returns the reason that the two frame step buttons are disabled, or null when they are
 * enabled or no source is active.
 *
 * The condition of a step is an active source, a valid nominal frame rate (ADR 021), and no
 * decode stall (`canStepFrames`). The frame rate comes from the probe, so its reason holds for
 * the whole session, and it comes first. A decode stall ends at the next seek, and its reason
 * says so. The notice of the preview says the same, but the user can close it.
 */
export function presentStepDisabledReason(
  hasActiveSource: boolean,
  hasNominalRate: boolean,
  isDecodeStalled: boolean,
): TransportDisabledReasonKey | null {
  if (
    !hasActiveSource ||
    canStepFrames(hasActiveSource, hasNominalRate, isDecodeStalled)
  ) {
    return null;
  }
  return hasNominalRate
    ? "transport.disabledReason.decodeStalled"
    : "transport.disabledReason.noFrameRate";
}

/**
 * Returns the reason that the play button is disabled, or null when it is enabled or no source
 * is active. With an active source, only a decode stall disables it (`canTogglePlayback`).
 */
export function presentPlayDisabledReason(
  hasActiveSource: boolean,
  isDecodeStalled: boolean,
): TransportDisabledReasonKey | null {
  if (!hasActiveSource || canTogglePlayback(hasActiveSource, isDecodeStalled)) {
    return null;
  }
  return "transport.disabledReason.decodeStalled";
}

function isEnabled(
  control: EditReasonControl,
  playback: TransportReasonPlayback,
  context: EditReasonContext,
): boolean {
  const { calibrationStatus, presentedFrame } = playback;
  const { hasActiveSource, pendingInPts, currentTarget } = context;
  switch (control) {
    case "markIn":
      return canMarkIn(
        calibrationStatus,
        presentedFrame,
        hasActiveSource,
        currentTarget,
      );
    case "markOut":
      return canMarkOut(
        calibrationStatus,
        presentedFrame,
        pendingInPts,
        hasActiveSource,
        currentTarget,
      );
    case "split":
      return canSplitCurrentSegment(
        currentTarget,
        calibrationStatus,
        presentedFrame,
        hasActiveSource,
      );
  }
}

/**
 * Returns the reason that Mark In, Mark Out or Split is disabled, `EDIT_REASON_PENDING` while
 * a pending seek hides a reason that depends on the playhead, or null when there is no reason.
 *
 * Null in these states:
 *
 * - The control is enabled.
 * - No source is active. Every control is disabled then, and the empty preview says what to do.
 * - The calibration is still running. It ends at the first presented frame.
 * - The current segment has a stored PTS that does not parse, or the pending In does not
 *   parse. The user cannot correct either.
 */
export function presentEditDisabledReason(
  control: EditReasonControl,
  playback: TransportReasonPlayback,
  context: EditReasonContext,
): EditDisabledReason {
  if (!context.hasActiveSource || isEnabled(control, playback, context)) {
    return null;
  }

  // A source that cannot calibrate stays on the approximate clock for the whole session, and
  // ADR 003 denies it every edit point. That is the reason, whatever the playhead position.
  if (playback.calibrationStatus === "unavailable") {
    return "transport.disabledReason.preciseMarkingUnavailable";
  }
  if (playback.calibrationStatus !== "ready") {
    return null;
  }

  const { currentTarget, pendingInPts } = context;
  const bounds = currentTarget.bounds;
  if (currentTarget.hasSegment && bounds === null) {
    return null;
  }

  // The reasons that do not depend on the playhead come before the test for a pending seek.
  if (!currentTarget.hasSegment) {
    if (control === "split") {
      return "transport.disabledReason.selectSegment";
    }
    if (control === "markOut") {
      if (pendingInPts === null) {
        return "transport.disabledReason.markInFirst";
      }
      if (!isPtsString(pendingInPts)) {
        return null;
      }
    }
  }

  const frame = playback.presentedFrame;
  if (
    playback.seekTargetSeconds !== null ||
    frame === null ||
    !isPtsString(frame.inferredSourcePts)
  ) {
    return EDIT_REASON_PENDING;
  }

  const pts = BigInt(frame.inferredSourcePts);

  switch (control) {
    case "markIn":
      // With no current segment, Mark In needs only a presented frame, and one is here, so
      // the control is enabled and this branch does not run.
      if (bounds === null) {
        return null;
      }
      // With a current segment, Mark In is disabled only on the In boundary. At or after the
      // Out it finishes the segment and starts the next one there, so it is enabled.
      return pts === bounds.lo ? "transport.disabledReason.atInPoint" : null;

    case "markOut":
      // With no current segment, the condition is false and a pending In exists, so the
      // playhead is at or before it. With a current segment, Mark Out is disabled only at or
      // before its In: on the Out it finishes the segment, so it is enabled there.
      if (bounds === null || pts <= bounds.lo) {
        return "transport.disabledReason.playheadAfterIn";
      }
      return null;

    case "split":
      // A current segment exists here, and the playhead is on a boundary or outside it.
      return "transport.disabledReason.playheadInsideSegment";
  }
}

/**
 * The description of a mark control while a press would finish the current segment, given
 * whether the press finishes it now. Returns `EDIT_REASON_PENDING` while a pending seek hides
 * the frame that decides it, and null in every other state.
 *
 * Null without a pending seek in these states, because no playhead position can make the
 * description true: no source is active, the calibration is not ready, no segment is current,
 * or the current segment has a stored PTS that does not parse.
 *
 * A frame step from the Out point clears the presented frame until the frame callback answers
 * (ADR 022). The pending value keeps the second line of the tooltip for that window, so the
 * tooltip does not switch between two lines and one.
 */
function presentFinishesSegment<K extends string>(
  finishes: boolean,
  key: K,
  playback: TransportReasonPlayback,
  context: EditReasonContext,
): K | typeof EDIT_REASON_PENDING | null {
  if (finishes) {
    return key;
  }
  const { calibrationStatus, presentedFrame } = playback;
  const { hasActiveSource, currentTarget } = context;
  if (
    !hasActiveSource ||
    calibrationStatus !== "ready" ||
    !currentTarget.hasSegment ||
    currentTarget.bounds === null
  ) {
    return null;
  }
  if (
    playback.seekTargetSeconds !== null ||
    presentedFrame === null ||
    !isPtsString(presentedFrame.inferredSourcePts)
  ) {
    return EDIT_REASON_PENDING;
  }
  return null;
}

/**
 * Returns the description of Mark In while a press would finish the current segment and
 * start a pending In at the frame on screen (`markInFinishesSegment`). Returns
 * `EDIT_REASON_PENDING` while a pending seek hides the frame that decides it, and null in
 * every other state (`presentFinishesSegment`).
 */
export function presentMarkInFinishesSegment(
  playback: TransportReasonPlayback,
  context: EditReasonContext,
): MarkInFinishesSegmentDescription {
  return presentFinishesSegment(
    markInFinishesSegment(
      playback.calibrationStatus,
      playback.presentedFrame,
      context.hasActiveSource,
      context.currentTarget,
    ),
    "transport.state.finishesSegment",
    playback,
    context,
  );
}

/**
 * Returns the description of Mark Out while a press would finish the current segment, because
 * the frame on screen is its Out (`markOutFinishesSegment`). Returns `EDIT_REASON_PENDING`
 * while a pending seek hides the frame that decides it, and null in every other state
 * (`presentFinishesSegment`).
 */
export function presentMarkOutFinishesSegment(
  playback: TransportReasonPlayback,
  context: EditReasonContext,
): MarkOutFinishesSegmentDescription {
  return presentFinishesSegment(
    markOutFinishesSegment(
      playback.calibrationStatus,
      playback.presentedFrame,
      context.hasActiveSource,
      context.currentTarget,
    ),
    "transport.state.finishesAtOut",
    playback,
    context,
  );
}

/**
 * Returns the description of Finish while an In mark is pending (`planFinishSegment`): a press
 * makes a segment that ends at the frame on screen, or it discards the In mark when that frame
 * is at or before the In. Returns `EDIT_REASON_PENDING` while no frame is on screen, because
 * the frame decides it, and null when no In mark is pending or no source is active. A current
 * segment has no description: Finish only ends it, as the label says.
 *
 * During a decode stall (ADR 039) no frame is on screen until a seek loads the preview again,
 * which can take long. Finish is disabled then, and the description is null, so the tooltip
 * does not keep a line that no press can do.
 */
export function presentFinishSegmentDescription(
  playback: TransportReasonPlayback,
  context: EditReasonContext,
): FinishSegmentDescription {
  const { hasActiveSource, pendingInPts, currentTarget } = context;
  if (
    !hasActiveSource ||
    currentTarget.hasSegment ||
    pendingInPts === null ||
    playback.decodeStall != null
  ) {
    return null;
  }
  const plan = planFinishSegment(
    playback.calibrationStatus,
    playback.presentedFrame,
    pendingInPts,
    hasActiveSource,
    currentTarget,
  );
  if (plan === null) {
    return EDIT_REASON_PENDING;
  }
  return plan.kind === "complete"
    ? "transport.state.finishCompletesSegment"
    : "transport.state.finishDiscardsIn";
}

/**
 * Returns the reason to show, given the reason shown before and the one presented now. The
 * descriptions of Mark In, Mark Out and Finish (`presentMarkInFinishesSegment`,
 * `presentMarkOutFinishesSegment`, `presentFinishSegmentDescription`) settle by the same rule.
 *
 * `EDIT_REASON_PENDING` keeps the reason shown before, so a frame step does not blank the
 * reason line and does not show a reason for a position the frame callback has not
 * confirmed. Every other value replaces it.
 */
export function settleDisabledReason<
  K extends
    | TransportDisabledReasonKey
    | MarkInFinishesSegmentKey
    | MarkOutFinishesSegmentKey
    | FinishSegmentDescriptionKey,
>(shown: K | null, presented: K | typeof EDIT_REASON_PENDING | null): K | null {
  return presented === EDIT_REASON_PENDING ? shown : presented;
}
