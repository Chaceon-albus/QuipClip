/**
 * Plans the time jumps of the window keyboard layer: an arrow key jumps 5 s back or forward,
 * 1 s with Shift and 30 s with primary, as a media player such as PotPlayer or mpv does.
 *
 * `planTimeJump` reads one snapshot of the media and playback state and returns the seek of the
 * jump, an edge (`start` or `end`) whose seek the caller plans with the plan of Home or End, or
 * null when the jump does nothing. The module has no React, DOM or store dependency.
 *
 * - The jump counts from the displayed position of ADR 022: the seek target while a seek is
 *   pending, then the frame on screen, then the approximate clock (`getDisplayedElapsedSeconds`).
 *   The playback store runs one seek at a time and keeps the latest request, so a held key, which
 *   repeats about 30 times each second, adds one jump for each repeat to the pending target and
 *   does not lose the repeats that the queue coalesces.
 * - A target before the start goes to the start, and a target at or after the end goes to the
 *   end. An extent that is indeterminate has no end and no ruler, so the jump does nothing
 *   there, as End does.
 * - On the frame grid of ADR 022, the jump is a whole number of frames: the seconds of the jump
 *   times the nominal rate, rounded to the nearest frame, with a tie away from zero (ADR 002).
 *   It counts from the frame of the displayed position by the rule of ADR 028, and it goes there
 *   with `seekToFrameIndex`: the element seeks to the middle of the frame, and the playhead shows
 *   its nominal start. Each press therefore moves the same number of frames, a held key adds
 *   that number for each repeat, and a jump back and a jump forward of the same size return to
 *   the same frame. At 29.97 fps, 1 s is 30 frames, 5 s is 150 frames and 30 s is 899 frames. A
 *   frame before frame 0 is the start, and a frame after the last frame of the extent is the end.
 *   A jump to the frame that holds the target time would move 149 or 150 frames for 5 s at
 *   29.97 fps, by the rounding of the position, and back and forward would differ.
 * - Off the grid, the jump seeks to the tick nearest the target with `seekToPts`, and the browser
 *   shows the frame that holds it. Without a calibration, it seeks on the approximate clock.
 * - Every jump keeps the playback running (`keepPlaying`, SeekOptions), and the caller gives the
 *   seek of Home and End at an edge the same option. A jump plays no cue: it is a seek, as a
 *   click on the ruler is, and not a frame step (ADR 019).
 * - A jump to the frame on screen does nothing while the video is paused and no seek is pending,
 *   because a seek onto that frame may bring no frame callback (ADR 022, ADR 026). During
 *   playback the store applies its own rule (`seekToFrameIndex`).
 * - While the calibration is open, the store defers the seek until the anchor (ADR 022): a frame
 *   index as a seek to the first frame and that many steps, and a PTS as the same seek.
 */

import type { MediaProbe } from "@/features/media";
import {
  getDisplayedElapsedSeconds,
  getNominalFrameRate,
  hasExactFrameGrid,
  type FrameIndexSeekOptions,
  type PlaybackState,
  type SeekOptions,
} from "@/features/playback";
import { getTimelineDurationSeconds } from "@/features/timeline";
import { elapsedSecondsToPts, isPtsString, isTickCountString } from "@/lib/time";
import {
  frameBoundaryMarginSeconds,
  frameIndexOfTicks,
  lastFrameIndexOfExtent,
} from "@/lib/timecode";
import type { Pts, Rational } from "@/types/project";
import { isSourceActive } from "./actionConditions";
import type { ShortcutAction } from "./shortcutBindings";

/** The seconds that each time jump action moves: negative back, positive forward. */
export const TIME_JUMP_SECONDS = {
  jumpBackFiveSeconds: -5,
  jumpForwardFiveSeconds: 5,
  jumpBackOneSecond: -1,
  jumpForwardOneSecond: 1,
  jumpBackThirtySeconds: -30,
  jumpForwardThirtySeconds: 30,
} as const satisfies Partial<Record<ShortcutAction, number>>;

/** An action of the key table that jumps in time. */
export type TimeJumpAction = keyof typeof TIME_JUMP_SECONDS;

/**
 * The options of every seek of a jump. A jump while the video plays plays on from the target,
 * as a media player does (SeekOptions.keepPlaying).
 */
export const TIME_JUMP_SEEK_OPTIONS: FrameIndexSeekOptions = { keepPlaying: true };

/** The probe facts that a jump reads. */
export type TimeJumpProbe = Pick<
  MediaProbe,
  | "videoStartPts"
  | "videoTimeBase"
  | "videoDurationTicks"
  | "approximateDurationSeconds"
  | "avgFrameRate"
  | "rFrameRate"
>;

/** One read of the state that a jump needs. The store states satisfy it as they are. */
export interface TimeJumpSnapshot {
  /** The probe of the open media, or null while no media is open. */
  readonly probe: TimeJumpProbe | null;
  readonly playback: Pick<
    PlaybackState,
    | "isAttached"
    | "isReady"
    | "isPlaying"
    | "calibrationStatus"
    | "presentedFrame"
    | "seekTargetSeconds"
    | "approximateBrowserTimeSeconds"
    | "runtimeBrowserDurationSeconds"
  >;
}

/**
 * What a jump does.
 *
 * - `start`: the target lies before the start of the source. The caller seeks as Home does.
 * - `end`: the target lies at or after the end of the source. The caller seeks as End does.
 * - A seek of the playback store, with its options.
 */
export type TimeJumpPlan =
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  | {
      readonly kind: "seekToFrameIndex";
      readonly frameIndex: number;
      readonly options: FrameIndexSeekOptions;
    }
  | { readonly kind: "seekToPts"; readonly pts: Pts; readonly options: SeekOptions }
  | {
      readonly kind: "seekApproximate";
      readonly seconds: number;
      readonly options: SeekOptions;
    };

const START: TimeJumpPlan = { kind: "start" };
const END: TimeJumpPlan = { kind: "end" };

/** The jump on the approximate clock, in seconds from the start of the source (ADR 003). */
function approximateJump(targetSeconds: number): TimeJumpPlan {
  return {
    kind: "seekApproximate",
    seconds: targetSeconds,
    options: TIME_JUMP_SEEK_OPTIONS,
  };
}

/**
 * The ticks of the frame on screen from the start of the source, or null when no frame counts
 * as on screen for the no-op of a jump: the calibration must be ready, a frame must be
 * presented, no seek may be pending, and the video must be paused.
 */
function pausedFrameTicks(
  playback: TimeJumpSnapshot["playback"],
  probe: TimeJumpProbe,
): bigint | null {
  const frame = playback.presentedFrame;
  if (
    playback.calibrationStatus !== "ready" ||
    frame === null ||
    playback.seekTargetSeconds !== null ||
    playback.isPlaying ||
    !isPtsString(frame.inferredSourcePts) ||
    !isPtsString(probe.videoStartPts)
  ) {
    return null;
  }
  return BigInt(frame.inferredSourcePts) - BigInt(probe.videoStartPts);
}

/**
 * The ADR 028 index of the last frame of the extent in ticks (`lastFrameIndexOfExtent`), the
 * frame that End goes to on the grid, or null when the probe gives no extent in ticks.
 */
function lastFrameIndex(probe: TimeJumpProbe, rate: Rational): bigint | null {
  return isTickCountString(probe.videoDurationTicks)
    ? lastFrameIndexOfExtent(
        BigInt(probe.videoDurationTicks),
        probe.videoTimeBase,
        rate,
      )
    : null;
}

/**
 * The frames of a jump of `jumpSeconds` at the nominal rate: `jumpSeconds × rate`, rounded to
 * the nearest whole frame with a tie away from zero (ADR 002). The arithmetic is exact BigInt for
 * whole seconds, the jumps of the key table. Any other value rounds the double.
 */
export function timeJumpFrames(jumpSeconds: number, rate: Rational): bigint | null {
  if (Number.isSafeInteger(jumpSeconds)) {
    const numerator = BigInt(Math.abs(jumpSeconds)) * BigInt(rate.n);
    const denominator = BigInt(rate.d);
    // round(n / d) for n >= 0 and d > 0, with a tie up: floor((2n + d) / 2d).
    const frames = (2n * numerator + denominator) / (2n * denominator);
    return jumpSeconds < 0 ? -frames : frames;
  }
  const frames = Math.round((Math.abs(jumpSeconds) * rate.n) / rate.d);
  if (!Number.isSafeInteger(frames)) {
    return null;
  }
  return BigInt(jumpSeconds < 0 ? -frames : frames);
}

/**
 * The ADR 028 index of the frame that the jump counts from: the frame of the displayed position.
 *
 * - With no seek pending and a frame on screen, the index of the ticks of that frame, which is
 *   exact.
 * - Otherwise the index of the displayed position, the seek target or the approximate clock:
 *   that position plus the frame boundary margin, times the rate, rounded down. This is the rule
 *   of the timecode and of the frame step of the store. The display target of an earlier jump is
 *   the nominal start of its frame, and the margin keeps the rounding on that frame, so a held
 *   key counts from the frame that the earlier repeat named.
 */
function startFrameIndex(
  playback: TimeJumpSnapshot["playback"],
  probe: TimeJumpProbe,
  rate: Rational,
): bigint | null {
  const timeBase = probe.videoTimeBase;
  const frame = playback.presentedFrame;
  if (
    playback.seekTargetSeconds === null &&
    playback.calibrationStatus === "ready" &&
    frame !== null &&
    isPtsString(frame.inferredSourcePts) &&
    isPtsString(probe.videoStartPts)
  ) {
    const ticks = BigInt(frame.inferredSourcePts) - BigInt(probe.videoStartPts);
    return ticks <= 0n ? 0n : frameIndexOfTicks(ticks, timeBase, rate, timeBase);
  }
  const seconds = getDisplayedElapsedSeconds(playback, probe.videoStartPts, timeBase);
  const margin = frameBoundaryMarginSeconds(rate, timeBase);
  const index = Math.floor(((seconds + margin) * rate.n) / rate.d);
  return Number.isSafeInteger(index) ? BigInt(Math.max(0, index)) : null;
}

/**
 * The jump on the frame grid: a whole number of frames from the frame of the displayed position
 * (`timeJumpFrames`, `startFrameIndex`). A frame before frame 0 is the start. A frame after the
 * last frame of the extent in ticks is the end, and without an extent in ticks a frame that
 * starts at or after the end of the ruler is the end.
 */
function planGridJump(
  jumpSeconds: number,
  rate: Rational,
  endSeconds: number,
  snapshot: TimeJumpSnapshot,
  probe: TimeJumpProbe,
): TimeJumpPlan | null {
  const start = startFrameIndex(snapshot.playback, probe, rate);
  const frames = timeJumpFrames(jumpSeconds, rate);
  if (start === null || frames === null) {
    return null;
  }
  const target = start + frames;
  if (target < 0n) {
    return START;
  }
  const last = lastFrameIndex(probe, rate);
  const isSafe = target <= BigInt(Number.MAX_SAFE_INTEGER);
  const pastEnd =
    last !== null
      ? target > last
      : !isSafe || (Number(target) * rate.d) / rate.n >= endSeconds;
  if (pastEnd) {
    return END;
  }
  if (!isSafe) {
    return null;
  }
  // A jump of less than half a frame, such as 1 s below 0.5 fps, moves no frame, so its target
  // is the frame on screen.
  const onScreen = pausedFrameTicks(snapshot.playback, probe);
  if (
    onScreen !== null &&
    frameIndexOfTicks(onScreen, probe.videoTimeBase, rate, probe.videoTimeBase) ===
      target
  ) {
    return null;
  }
  return {
    kind: "seekToFrameIndex",
    frameIndex: Number(target),
    options: TIME_JUMP_SEEK_OPTIONS,
  };
}

/**
 * The jump off the frame grid: to the tick nearest the target. No frame boundary is known, so
 * only a target that is the PTS of the frame on screen counts as that frame.
 */
function planTickJump(
  targetSeconds: number,
  snapshot: TimeJumpSnapshot,
  probe: TimeJumpProbe,
): TimeJumpPlan | null {
  const start = probe.videoStartPts;
  const pts =
    start !== null && isPtsString(start)
      ? elapsedSecondsToPts(targetSeconds, start, probe.videoTimeBase)
      : null;
  if (start === null || pts === null) {
    // No PTS names the target. The store would refuse a seekToPts, so the jump seeks on the
    // approximate clock, as a click on the ruler of such a source does.
    return approximateJump(targetSeconds);
  }
  const onScreen = pausedFrameTicks(snapshot.playback, probe);
  if (onScreen !== null && onScreen === BigInt(pts) - BigInt(start)) {
    return null;
  }
  return { kind: "seekToPts", pts, options: TIME_JUMP_SEEK_OPTIONS };
}

/**
 * Returns what a jump of `jumpSeconds` does now, or null when it does nothing. See the module
 * comment for the rules.
 *
 * @param jumpSeconds The seconds of the jump: negative back, positive forward.
 * @param snapshot One read of the media and playback state.
 */
export function planTimeJump(
  jumpSeconds: number,
  snapshot: TimeJumpSnapshot,
): TimeJumpPlan | null {
  const { probe, playback } = snapshot;
  if (probe === null || !isSourceActive(true, playback.isAttached, playback.isReady)) {
    return null;
  }
  // The extent rule of the timeline (ADR 007), as `sourceEndSeconds` reads it for End.
  const endSeconds = getTimelineDurationSeconds({
    videoDurationTicks: probe.videoDurationTicks,
    videoTimeBase: probe.videoTimeBase,
    approximateDurationSeconds: probe.approximateDurationSeconds,
    runtimeBrowserDuration: playback.runtimeBrowserDurationSeconds,
  });
  if (endSeconds === null) {
    return null;
  }
  // A calibration that is ready or still open: the store runs the seek on the calibrated mapping,
  // at once or at the anchor (ADR 022). On the grid the jump counts whole frames.
  const rate = getNominalFrameRate(probe);
  if (
    playback.calibrationStatus !== "unavailable" &&
    rate !== null &&
    hasExactFrameGrid(probe)
  ) {
    return planGridJump(jumpSeconds, rate, endSeconds, snapshot, probe);
  }
  const targetSeconds =
    getDisplayedElapsedSeconds(playback, probe.videoStartPts, probe.videoTimeBase) +
    jumpSeconds;
  if (!Number.isFinite(targetSeconds)) {
    return null;
  }
  if (targetSeconds < 0) {
    return START;
  }
  if (targetSeconds >= endSeconds) {
    return END;
  }
  if (playback.calibrationStatus === "unavailable") {
    return approximateJump(targetSeconds);
  }
  return planTickJump(targetSeconds, snapshot, probe);
}
