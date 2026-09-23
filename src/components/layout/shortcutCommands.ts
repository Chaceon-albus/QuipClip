/**
 * Plans the store call for a shortcut action of the window keyboard layer (ADR 026).
 *
 * `planShortcutCommand` reads one snapshot of the media, playback and timeline state. It
 * returns the call that the action makes, or null when the condition of the action is false.
 * The condition and the target of the call come from the same snapshot, so they cannot
 * disagree. The keyboard layer uses a null plan as "owned, no action".
 *
 * Every condition that a control also carries comes from `actionConditions.ts`, or from the
 * timeline feature for Mark In and Mark Out. The module has no React, DOM or store dependency.
 */

import type { MediaProbe } from "@/features/media";
import {
  getNominalFrameRate,
  hasNominalFrameRate,
  NOMINAL_STEP_EDGE_TOLERANCE_SECONDS,
  type PlaybackState,
} from "@/features/playback";
import {
  canMarkIn,
  canMarkOut,
  findCurrentSegment,
  getCurrentSegmentTarget,
  getTimelineDurationSeconds,
  type CurrentSegmentRef,
  type TimelineState,
} from "@/features/timeline";
import { isPtsString } from "@/lib/time";
import type { Pts } from "@/types/project";
import {
  canDeleteSegment,
  canExportMedia,
  canFinishSegment,
  canRedoEdit,
  canStepFrames,
  canTogglePlayback,
  canUndoEdit,
  isSourceActive,
} from "./actionConditions";
import type { ShortcutAction } from "./shortcutBindings";

/** The number of nominal frame intervals that one Shift+Arrow step moves (ADR 026). */
export const LARGE_FRAME_STEP = 10;

/** The probe facts that the plans read. */
export type ShortcutProbe = Pick<
  MediaProbe,
  | "videoStartPts"
  | "videoTimeBase"
  | "videoDurationTicks"
  | "approximateDurationSeconds"
  | "avgFrameRate"
  | "rFrameRate"
>;

/** One read of the state that the plans need. The store states satisfy it as they are. */
export interface ShortcutSnapshot {
  /** The probe of the open media, or null while no media is open. */
  readonly probe: ShortcutProbe | null;
  readonly playback: Pick<
    PlaybackState,
    | "isAttached"
    | "isReady"
    | "calibrationStatus"
    | "presentedFrame"
    | "seekTargetSeconds"
    | "runtimeBrowserDurationSeconds"
    | "approximateBrowserTimeSeconds"
    | "isPlaying"
  >;
  readonly timeline: Pick<
    TimelineState,
    | "sourceId"
    | "segments"
    | "currentSegmentId"
    | "pendingInPts"
    | "canUndo"
    | "canRedo"
  >;
}

/** The store call that one shortcut action makes. */
export type ShortcutCommand =
  | { readonly kind: "togglePlayback" }
  | { readonly kind: "seekNominal"; readonly frames: number }
  | { readonly kind: "seekToPts"; readonly pts: Pts }
  | { readonly kind: "seekApproximate"; readonly seconds: number }
  | { readonly kind: "markIn"; readonly pts: Pts }
  | { readonly kind: "markOut"; readonly pts: Pts }
  | { readonly kind: "deleteSegment" }
  | { readonly kind: "newSegment" }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" }
  | { readonly kind: "openMedia" }
  | { readonly kind: "export" }
  | { readonly kind: "openSettings" };

function currentSegmentOf(
  timeline: ShortcutSnapshot["timeline"],
): CurrentSegmentRef | null {
  return findCurrentSegment(
    timeline.segments,
    timeline.currentSegmentId,
    timeline.sourceId,
  );
}

/**
 * True when a precise seek to the target would land on the frame that is already on screen
 * while no seek is pending.
 *
 * Such a seek changes nothing the user can see, and it can harm the state: `seekToPts` clears
 * `presentedFrame`, and a seek onto the frame on screen may bring no frame callback (ADR 022),
 * so Mark In, Mark Out and Split would stay disabled. ADR 026 therefore owns the key press
 * and performs nothing. A pending seek (a set `seekTargetSeconds`) means that the element is
 * moving away from the presented frame, so the seek still runs then.
 *
 * The comparison is exact, with `BigInt`, on two parsed PTS values.
 */
function isTargetOnScreen(
  playback: ShortcutSnapshot["playback"],
  target: Pts,
): boolean {
  const frame = playback.presentedFrame;
  if (
    frame === null ||
    playback.seekTargetSeconds !== null ||
    !isPtsString(frame.inferredSourcePts) ||
    !isPtsString(target)
  ) {
    return false;
  }
  return BigInt(frame.inferredSourcePts) === BigInt(target);
}

/**
 * True when the element already stands at the End target on a calibrated source, with a
 * frame on screen, no seek pending and no playback.
 *
 * This is the rule of `isTargetOnScreen` for End. End seeks on the approximate clock, so no
 * PTS names its target. The presented frame is also not the value to compare: the last frame
 * starts one frame interval before the end, so its time never equals the target. The plan
 * therefore compares the position of the element, `approximateBrowserTimeSeconds`. It is on
 * the axis of the target, seconds from the start of the source, and the `seeked` handler of
 * the preview updates it when a seek completes. `seekApproximate` can clamp the target to the
 * duration of the element, and the plan does not repeat that clamp. When the clamp moves the
 * target by the tolerance or more, End seeks again, as it did before this rule.
 *
 * The tolerance is half a nominal frame interval. A position nearer than that to the target
 * is nearer to it than to any other nominal frame position, so the seek would show the frame
 * already on screen. A position one frame before the end is outside it, and End still moves
 * there. Without a nominal frame rate no interval is known, and the tolerance is
 * `NOMINAL_STEP_EDGE_TOLERANCE_SECONDS`. The nominal step uses the same value to compare a
 * clamp target with the position that the element reads back after a seek to it. After End,
 * the two values differ only by the rounding of one instant, and the value is far below the
 * frame interval of any real source.
 *
 * During playback the rule never applies. The approximate clock is then a `timeupdate` sample
 * that lags the element, and the seek of End also stops the playback.
 */
function isElementAtEnd(
  playback: ShortcutSnapshot["playback"],
  probe: ShortcutProbe,
  endSeconds: number,
): boolean {
  const position = playback.approximateBrowserTimeSeconds;
  if (
    playback.calibrationStatus !== "ready" ||
    playback.presentedFrame === null ||
    playback.seekTargetSeconds !== null ||
    playback.isPlaying ||
    position === null
  ) {
    return false;
  }
  const rate = getNominalFrameRate(probe);
  const tolerance =
    rate === null ? NOMINAL_STEP_EDGE_TOLERANCE_SECONDS : rate.d / (2 * rate.n);
  return Math.abs(position - endSeconds) < tolerance;
}

/**
 * The PTS of the named segment that Go to In (`inPts`) or Go to Out (`outPts`) seeks to.
 *
 * With no current segment, Go to In goes to the pending In mark. The two never hold a value
 * together (ADR 007), so the order of the two tests does not decide anything. Go to Out has
 * no pending counterpart.
 *
 * `seekToPts` needs a calibrated source, and it reports a failed seek on any other source. The
 * plan therefore needs the calibration too, so an uncalibrated source never shows that error.
 */
function planSegmentBoundarySeek(
  snapshot: ShortcutSnapshot,
  hasActiveSource: boolean,
  boundary: "inPts" | "outPts",
): ShortcutCommand | null {
  if (!hasActiveSource || snapshot.playback.calibrationStatus !== "ready") {
    return null;
  }
  const current = currentSegmentOf(snapshot.timeline);
  let target: Pts | null;
  if (current !== null) {
    target = current.segment[boundary];
  } else {
    target = boundary === "inPts" ? snapshot.timeline.pendingInPts : null;
  }
  if (target === null || !isPtsString(target)) {
    return null;
  }
  // Already there: I then Shift+I, or O then Shift+O, moves nothing and keeps the frame.
  if (isTargetOnScreen(snapshot.playback, target)) {
    return null;
  }
  return { kind: "seekToPts", pts: target };
}

/**
 * Returns the store call that the action makes now, or null when its condition is false.
 */
export function planShortcutCommand(
  action: ShortcutAction,
  snapshot: ShortcutSnapshot,
): ShortcutCommand | null {
  const { probe, playback, timeline } = snapshot;
  const hasMedia = probe !== null;
  const hasActiveSource = isSourceActive(
    hasMedia,
    playback.isAttached,
    playback.isReady,
  );

  switch (action) {
    case "togglePlayback":
      return canTogglePlayback(hasActiveSource) ? { kind: "togglePlayback" } : null;

    case "stepBackOneFrame":
    case "stepForwardOneFrame":
    case "stepBackTenFrames":
    case "stepForwardTenFrames": {
      if (!canStepFrames(hasActiveSource, hasNominalFrameRate(probe))) {
        return null;
      }
      const size =
        action === "stepBackTenFrames" || action === "stepForwardTenFrames"
          ? LARGE_FRAME_STEP
          : 1;
      const sign =
        action === "stepBackOneFrame" || action === "stepBackTenFrames" ? -1 : 1;
      // One request with all the frame intervals, never one request for each frame: ADR 019
      // then sounds one cue for the step.
      return { kind: "seekNominal", frames: sign * size };
    }

    case "goToStart": {
      // While the calibration is open, a seek would refuse precise editing for the attachment
      // (ADR 021), because the anchor frame would no longer be the frame `videoStartPts`
      // names. Home owns the key press and performs nothing then (ADR 026).
      if (
        !hasActiveSource ||
        probe === null ||
        playback.calibrationStatus === "calibrating"
      ) {
        return null;
      }
      // A calibrated source goes to the frame that `videoStartPts` names. Any other source
      // goes to time zero on the approximate clock, because `seekToPts` would report a failed
      // seek there (ADR 026).
      if (
        playback.calibrationStatus === "ready" &&
        probe.videoStartPts !== null &&
        isPtsString(probe.videoStartPts)
      ) {
        // Already there: Home, Home moves nothing and keeps the frame for Mark In.
        if (isTargetOnScreen(playback, probe.videoStartPts)) {
          return null;
        }
        return { kind: "seekToPts", pts: probe.videoStartPts };
      }
      return { kind: "seekApproximate", seconds: 0 };
    }

    case "goToEnd": {
      // The same rule as Home while the calibration is open.
      if (
        !hasActiveSource ||
        probe === null ||
        playback.calibrationStatus === "calibrating"
      ) {
        return null;
      }
      // The end of the ruler, from the same extent rule and the same inputs as the timeline
      // (ADR 007). This is the seek that a press at the right end of the ruler makes on the
      // approximate clock, and `seekApproximate` clamps it to the duration of the element. An
      // indeterminate extent has no end to go to, as it has no click-to-seek.
      const endSeconds = getTimelineDurationSeconds({
        videoDurationTicks: probe.videoDurationTicks,
        videoTimeBase: probe.videoTimeBase,
        approximateDurationSeconds: probe.approximateDurationSeconds,
        runtimeBrowserDuration: playback.runtimeBrowserDurationSeconds,
      });
      if (endSeconds === null) {
        return null;
      }
      // Already there: End, End moves nothing and keeps the frame for Mark Out.
      if (isElementAtEnd(playback, probe, endSeconds)) {
        return null;
      }
      return { kind: "seekApproximate", seconds: endSeconds };
    }

    case "markIn": {
      // The same predicate as the Mark In button, and the same PTS: the frame that the browser
      // confirmed (ADR 003, ADR 022). A pending seek clears `presentedFrame`, so a key press
      // during it does nothing.
      const frame = playback.presentedFrame;
      const target = getCurrentSegmentTarget(currentSegmentOf(timeline));
      if (
        frame === null ||
        !canMarkIn(playback.calibrationStatus, frame, hasActiveSource, target)
      ) {
        return null;
      }
      return { kind: "markIn", pts: frame.inferredSourcePts };
    }

    case "markOut": {
      const frame = playback.presentedFrame;
      const target = getCurrentSegmentTarget(currentSegmentOf(timeline));
      if (
        frame === null ||
        !canMarkOut(
          playback.calibrationStatus,
          frame,
          timeline.pendingInPts,
          hasActiveSource,
          target,
        )
      ) {
        return null;
      }
      return { kind: "markOut", pts: frame.inferredSourcePts };
    }

    case "goToSegmentIn":
      return planSegmentBoundarySeek(snapshot, hasActiveSource, "inPts");

    case "goToSegmentOut":
      // `outPts` is the first frame after the half-open segment (ADR 002). It is also the
      // frame at which the user pressed Mark Out, so a mark and a return to it show one frame.
      return planSegmentBoundarySeek(snapshot, hasActiveSource, "outPts");

    case "deleteSegment":
      return canDeleteSegment(hasActiveSource, currentSegmentOf(timeline))
        ? { kind: "deleteSegment" }
        : null;

    case "finishSegment":
      return canFinishSegment(
        hasActiveSource,
        currentSegmentOf(timeline),
        timeline.pendingInPts,
      )
        ? { kind: "newSegment" }
        : null;

    case "undo":
      return canUndoEdit(hasActiveSource, timeline.canUndo) ? { kind: "undo" } : null;

    case "redo":
      return canRedoEdit(hasActiveSource, timeline.canRedo) ? { kind: "redo" } : null;

    case "openMedia":
      // The Open Media item of the title bar menu has no condition.
      return { kind: "openMedia" };

    case "export":
      return canExportMedia(hasMedia) ? { kind: "export" } : null;

    case "openSettings":
      // The settings button of the status bar has no condition.
      return { kind: "openSettings" };
  }
}
