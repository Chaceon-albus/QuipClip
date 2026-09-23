/**
 * Pure presenter for the reason that a transport control is disabled.
 *
 * The tooltip of Mark In, Mark Out, Split and the two frame step buttons shows a second line
 * while the control is disabled, so the user learns what to do. The presenter reads the same
 * facts as the conditions of those controls (`canMarkIn`, `canMarkOut`,
 * `canSplitCurrentSegment` and `canStepFrames`) and first asks each condition itself, so it
 * never gives a reason for an enabled control.
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
 * It returns translation keys and does not call the i18n runtime (ADR 011).
 */

import { canStepFrames } from "@/components/layout/actionConditions";
import type { PlaybackState } from "@/features/playback";
import {
  canMarkIn,
  canMarkOut,
  canSplitCurrentSegment,
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
  | "transport.disabledReason.playheadBeforeOut"
  | "transport.disabledReason.playheadAfterIn"
  | "transport.disabledReason.atInPoint"
  | "transport.disabledReason.atOutPoint"
  | "transport.disabledReason.noFrameRate";

/**
 * The value for a disabled control whose reason depends on a playhead position that a
 * pending seek has not confirmed yet. It is not a reason: the caller keeps the last one.
 */
export const EDIT_REASON_PENDING = "pending";

export type EditDisabledReason =
  TransportDisabledReasonKey | typeof EDIT_REASON_PENDING | null;

/**
 * The playback facts that the reason reads. The playback store state satisfies it as it is,
 * so a store selector can pass its state without allocating an object for each frame.
 */
export type TransportReasonPlayback = Pick<
  PlaybackState,
  "calibrationStatus" | "presentedFrame" | "seekTargetSeconds"
>;

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
 * The condition of a step is an active source and a valid nominal frame rate (ADR 021). The
 * frame rate comes from the probe, so the reason holds for the whole session.
 */
export function presentStepDisabledReason(
  hasActiveSource: boolean,
  hasNominalRate: boolean,
): TransportDisabledReasonKey | null {
  if (!hasActiveSource || canStepFrames(hasActiveSource, hasNominalRate)) {
    return null;
  }
  return "transport.disabledReason.noFrameRate";
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
      if (pts === bounds.lo) {
        return "transport.disabledReason.atInPoint";
      }
      if (pts >= bounds.hi) {
        return "transport.disabledReason.playheadBeforeOut";
      }
      return null;

    case "markOut":
      if (bounds === null) {
        // The condition is false and a pending In exists, so the playhead is at or before it.
        return "transport.disabledReason.playheadAfterIn";
      }
      if (pts === bounds.hi) {
        return "transport.disabledReason.atOutPoint";
      }
      if (pts <= bounds.lo) {
        return "transport.disabledReason.playheadAfterIn";
      }
      return null;

    case "split":
      // A current segment exists here, and the playhead is on a boundary or outside it.
      return "transport.disabledReason.playheadInsideSegment";
  }
}

/**
 * Returns the reason to show, given the reason shown before and the one presented now.
 *
 * `EDIT_REASON_PENDING` keeps the reason shown before, so a frame step does not blank the
 * reason line and does not show a reason for a position the frame callback has not
 * confirmed. Every other value replaces it.
 */
export function settleDisabledReason(
  shown: TransportDisabledReasonKey | null,
  presented: EditDisabledReason,
): TransportDisabledReasonKey | null {
  return presented === EDIT_REASON_PENDING ? shown : presented;
}
