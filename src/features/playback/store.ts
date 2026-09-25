/**
 * Playback store managing active media element attachment, readiness lifecycle,
 * synchronous playback, PTS calibration, RVFC presentation, seekToPts, and nominal seek hints.
 *
 * Implements ADR 002, ADR 003, and ADR 007 with strict source-element concurrency guards.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { getSourceRevisionKey, isPositiveRational } from "@/features/media";
import {
  assertPositiveTimeBase,
  elapsedSecondsToPts,
  I64_MAX,
  isPtsString,
  isTickCountString,
  mediaTimeToPts,
  ptsElapsedSeconds,
  ptsToMediaTime,
  rationalsEqual,
} from "@/lib/time";
import {
  frameBoundaryMarginSeconds,
  frameIndexOfTicks,
  isFrameGridExact,
  lastFrameIndexOfExtent,
} from "@/lib/timecode";
import type { Pts, Rational } from "@/types/project";
import { scrubAudioController } from "./scrubAudio";
import type {
  CalibrationStatus,
  PlaybackErrorCode,
  PlaybackMediaElement,
  PlaybackSource,
  PlaybackState,
  PlaybackStop,
  PlaybackStoreState,
  SeekOptions,
} from "./types";

/**
 * Chooses valid avgFrameRate then rFrameRate for nominal navigation hints.
 * Returns null when neither frame rate is valid (ADR 003).
 */
export function getNominalFrameRate(
  source: Pick<PlaybackSource, "avgFrameRate" | "rFrameRate">,
): Rational | null {
  if (
    source.avgFrameRate &&
    Number.isSafeInteger(source.avgFrameRate.n) &&
    source.avgFrameRate.n > 0 &&
    Number.isSafeInteger(source.avgFrameRate.d) &&
    source.avgFrameRate.d > 0
  ) {
    return source.avgFrameRate;
  }
  if (
    source.rFrameRate &&
    Number.isSafeInteger(source.rFrameRate.n) &&
    source.rFrameRate.n > 0 &&
    Number.isSafeInteger(source.rFrameRate.d) &&
    source.rFrameRate.d > 0
  ) {
    return source.rFrameRate;
  }
  return null;
}

/**
 * True when the source reports a valid average frame rate and a valid real frame rate, and the
 * two differ. The source then has a variable frame rate: the frame timecode falls back to
 * milliseconds (ADR 028), and a nominal frame step does not use the frame grid (ADR 022).
 */
export function hasVariableFrameRate(
  source: Pick<PlaybackSource, "avgFrameRate" | "rFrameRate">,
): boolean {
  const { avgFrameRate, rFrameRate } = source;
  return (
    isPositiveRational(avgFrameRate) &&
    isPositiveRational(rFrameRate) &&
    !rationalsEqual(avgFrameRate, rFrameRate)
  );
}

/** True when the source reports a frame rate the nominal step can use. */
export function hasNominalFrameRate(
  source: Pick<PlaybackSource, "avgFrameRate" | "rFrameRate"> | null | undefined,
): boolean {
  if (!source) {
    return false;
  }
  return getNominalFrameRate(source) !== null;
}

/**
 * True when the source meets the two conditions of the frame grid that do not depend on the
 * calibration (ADR 022): the rate is constant, and the grid is exact on the video time base
 * (isFrameGridExact). A nominal step, and seekToFrameIndex, use the grid when this holds and the
 * calibration is also ready, because frame 0 of the grid starts at the calibrated first frame.
 */
export function hasExactFrameGrid(
  source: Pick<PlaybackSource, "avgFrameRate" | "rFrameRate" | "videoTimeBase">,
): boolean {
  const fps = getNominalFrameRate(source);
  return (
    fps !== null &&
    !hasVariableFrameRate(source) &&
    isFrameGridExact(fps, source.videoTimeBase)
  );
}

/** The probe facts that the stop of a segment playback reads (canPlaySegment). */
export type PlaybackStopSource = Pick<
  PlaybackSource,
  | "videoStartPts"
  | "videoTimeBase"
  | "videoDurationTicks"
  | "avgFrameRate"
  | "rFrameRate"
>;

/**
 * The last frame of a segment, where a segment playback stops (ADR 026).
 *
 * - `frame`: on the frame grid (hasExactFrameGrid), the ADR 028 index of the last frame, counted
 *   from the calibrated first frame.
 * - `tick`: off the grid no frame boundary is known. The last frame is the frame that holds the
 *   last tick before the Out, `outPts - 1`. `fps` is the nominal rate, or null without one.
 */
type PlaybackStopTarget =
  | { readonly kind: "frame"; readonly fps: Rational; readonly lastFrame: number }
  | {
      readonly kind: "tick";
      readonly fps: Rational | null;
      readonly out: bigint;
      readonly lastTick: Pts;
    };

/**
 * The last frame of the half-open segment `[inPts, outPts)` (ADR 002), or null when the segment
 * holds no frame of the source: a PTS that does not parse, `inPts >= outPts`, an Out at or before
 * `videoStartPts`, an invalid time base, or an In at or after the end of the extent when the probe
 * gives the extent in ticks, `videoStartPts + videoDurationTicks`. An Out after that end is valid,
 * as long as the In lies before it: on the grid the stop is the last frame of the extent, and off
 * the grid the end of the media ends the playback. On the frame grid it is also null when the
 * last frame lies before the ADR 028 frame of the In, the frame that the seek to the In shows: an
 * extent that ends before the segment, or a segment that ends no more than the margin after a
 * frame start, such as a segment of one tick on a grid whose margin is one tick.
 *
 * On the frame grid the last frame is the last nominal frame whose start lies before the Out by
 * more than the frame boundary margin of ADR 028: `lastFrameIndexOfExtent` of the ticks from
 * `videoStartPts` to the Out, the rule that End uses for the extent (ADR 026). For an Out that a
 * frame presented, which lies within one tick of its nominal start, that is the index of the Out
 * minus one. For an Out at the end of the extent it is the frame that End goes to, also when that
 * frame is shorter than an interval, where the index of the Out minus one would name the frame
 * before it. An Out past the end of the extent in ticks stops on the last frame of the extent.
 * An index past the safe integers goes by the tick instead.
 */
function playbackStopTarget(
  source: PlaybackStopSource,
  inPts: Pts,
  outPts: Pts,
): PlaybackStopTarget | null {
  const { videoStartPts, videoTimeBase, videoDurationTicks } = source;
  if (
    !isPtsString(inPts) ||
    !isPtsString(outPts) ||
    !isPtsString(videoStartPts) ||
    !isPositiveRational(videoTimeBase)
  ) {
    return null;
  }
  const start = BigInt(videoStartPts);
  const inValue = BigInt(inPts);
  const out = BigInt(outPts);
  if (inValue >= out || out <= start) {
    return null;
  }
  // A segment that starts at or after the end of the extent in ticks holds no frame of the
  // extent, on the grid or off it.
  if (
    isTickCountString(videoDurationTicks) &&
    inValue >= start + BigInt(videoDurationTicks)
  ) {
    return null;
  }
  const fps = getNominalFrameRate(source);
  if (fps !== null && hasExactFrameGrid(source)) {
    let last = lastFrameIndexOfExtent(out - start, videoTimeBase, fps);
    if (last === null) {
      // No frame starts before the Out by more than the margin.
      return null;
    }
    if (isTickCountString(videoDurationTicks)) {
      const extentLast = lastFrameIndexOfExtent(
        BigInt(videoDurationTicks),
        videoTimeBase,
        fps,
      );
      if (extentLast !== null && extentLast < last) {
        last = extentLast;
      }
    }
    // The last frame must not lie before the frame that the seek to the In shows. Otherwise the
    // first frame of the playback would meet the stop, and the stop would seek out of the
    // segment.
    const inIndex =
      inValue <= start
        ? 0n
        : frameIndexOfTicks(inValue - start, videoTimeBase, fps, videoTimeBase);
    if (inIndex === null || last < inIndex) {
      return null;
    }
    if (last <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return { kind: "frame", fps, lastFrame: Number(last) };
    }
  }
  return { kind: "tick", fps, out, lastTick: (out - 1n).toString() as Pts };
}

/**
 * True when `playSegment` can play the segment `[inPts, outPts)` on the source: the segment holds
 * a frame (playbackStopTarget). The window keyboard layer tests the same rule (ADR 026). The
 * action also needs an attached, ready element and a ready calibration, which the caller tests.
 */
export function canPlaySegment(
  source: PlaybackStopSource,
  inPts: Pts,
  outPts: Pts,
): boolean {
  return playbackStopTarget(source, inPts, outPts) !== null;
}

/**
 * The prediction of the last frame off the frame grid: true when the Out lies less than one and
 * a half nominal intervals after the start of the frame at `pts`. The next frame is expected one
 * interval later, so it would then be the Out or a later frame. The comparison is exact:
 * `(out - pts) * timeBase < 3 / (2 * rate)`.
 *
 * On the frame grid the same rule would name the last frame exactly, because a real frame start
 * lies less than one tick, and so less than half an interval, from its nominal start. Off the grid
 * it is a prediction, and the store pauses on a predicted frame with no seek, as on a proven one:
 * when the prediction is right, which is the usual case, that frame already holds the last tick
 * before the Out, and a seek to that tick would land on the frame on screen (ADR 022). A late
 * prediction lets the playback reach the Out, and the store seeks back from the Out frame. An early
 * one pauses one frame or more before the last frame. When the element has moved on before the
 * pause took effect, the browser presents a later frame. A later frame before the Out lies in the
 * segment at or before the real last frame, and it keeps the stop; it can still lie before the
 * real last frame. A later frame in the seek-back window is pulled back. When the element has not
 * moved on, the playback rests on the early frame. The half interval splits the two errors: a
 * frame is taken as the last frame when the Out is nearer to one interval after it than to two.
 */
function isPredictedLastFrame(
  pts: bigint,
  out: bigint,
  timeBase: Rational,
  fps: Rational,
): boolean {
  return (
    2n * (out - pts) * BigInt(timeBase.n) * BigInt(fps.n) <
    3n * BigInt(timeBase.d) * BigInt(fps.d)
  );
}

/**
 * The least distance in seconds past the Out that two rules of a segment playback read (ADR 026).
 * Each rule also uses one nominal interval when that is longer (playbackStopWindowSeconds).
 *
 * - The seek-back window of the "stopped" phase. A frame callback runs after the browser
 *   presented the frame, and the pause runs later still, so the paused position can lie some
 *   frames past the last frame: at 50 or 60 fps the delay of a callback is close to one frame.
 *   When the browser then presents the frame at that position, a frame that lies at most this
 *   distance past the Out is a frame of that delay, and the store seeks back from it. When the
 *   element paused after the Out, the window can also end at the paused position plus this same
 *   distance (stopWindowEndSeconds).
 * - The backstop of syncBrowserTime. A window that is hidden or minimized presents no frames, so
 *   no frame callback comes, and the sound would play past the Out. The approximate clock stops
 *   the playback when its position lies this distance past the Out. On a visible window the frame
 *   callbacks come for every frame, and the distance keeps two or more of them between the Out
 *   and the backstop at the usual rates.
 *
 * The picture follows the element clock while the decoder keeps up. When decoding lags, as with a
 * heavy file that a web view decodes in software, the picture can trail the clock by more than
 * this distance.
 */
const PLAYBACK_STOP_BACKSTOP_SECONDS = 0.1;

/** The distance past the Out of the seek-back window and of the backstop, in seconds. */
function playbackStopWindowSeconds(fps: Rational | null): number {
  return Math.max(PLAYBACK_STOP_BACKSTOP_SECONDS, fps === null ? 0 : fps.d / fps.n);
}

/**
 * Largest accepted distance in seconds, both between the start of the media timeline and the
 * position the attached element held at attach time, and between the position the element is
 * known to hold while nothing has moved it and the mediaTime of the first RVFC callback after
 * the attach (ADR 003 step 4).
 *
 * A first callback outside those bounds does not identify the frame that videoStartPts names.
 * It comes from an element that already played and was attached again, or from a loop that was
 * registered in a passive effect and missed the first presented frame. Calibration is refused
 * in that case, and the preview falls back to the approximate clock.
 *
 * The value is far above one frame interval, because the failure it rejects is tens of seconds.
 */
export const ANCHOR_TOLERANCE_SECONDS = 1.0;

/**
 * Largest distance in seconds between the clamped target of a nominal step and the position the
 * step starts from, at which the step counts as a step that cannot move the source.
 *
 * The bounds are positions on the browser media timeline. The lower bound is its origin, or the
 * calibrated first frame when that lies later. The upper bound is the lower bound plus the
 * approximate duration, or the duration the element reports when that is smaller. At an edge
 * the clamp returns the bound itself, and the start position is that same bound read back from
 * the element or from the pending seek. The two values can differ only by the rounding of one
 * instant, and the rounding error of a double at the length of any real source is below one
 * nanosecond. The value is one microsecond, which is far above that error. It is also far below
 * one frame interval (about 1 ms at 1000 fps, 33 ms at 30 fps), so a step that moves one real
 * frame never falls inside it.
 *
 * A start position outside the bounds needs no tolerance for a step further outward: a step
 * never moves against its direction, so its target is then the start position itself.
 */
export const NOMINAL_STEP_EDGE_TOLERANCE_SECONDS = 1e-6;

/**
 * Seconds from the start of nominal frame 0 to the middle of nominal frame `frameIndex`:
 * (frameIndex + 1/2) * frameRate.d / frameRate.n, written as
 * ((2 * frameIndex + 1) * frameRate.d) / (2 * frameRate.n).
 *
 * The numerator and the denominator are integers. While both are safe integers, both are exact
 * doubles, and the one division rounds the exact rational quotient once.
 */
function nominalFrameMiddleSeconds(frameIndex: number, frameRate: Rational): number {
  return ((2 * frameIndex + 1) * frameRate.d) / (2 * frameRate.n);
}

/**
 * The frame that a frame step goes to: a step of `deltaFrames` nominal frames from the frame it
 * starts from (seekNominal), or nominal frame `frameIndex` of the grid (seekToFrameIndex).
 */
type FrameStepRequest =
  | { readonly kind: "relative"; readonly deltaFrames: number }
  | { readonly kind: "absolute"; readonly frameIndex: number };

/**
 * The absolute seek of a navigation that the store deferred during calibration.
 * `keepBrowserTimeline` is the seek option of that name (see SeekOptions).
 */
type DeferredSeek =
  | {
      readonly kind: "approximate";
      readonly seconds: number;
      readonly scrub: boolean;
      readonly keepBrowserTimeline: boolean;
    }
  | { readonly kind: "pts"; readonly pts: Pts; readonly scrub: boolean };

/**
 * The seek that a deferred seek runs as once the calibration settles: a PTS on the calibrated
 * mapping, or seconds from the start of the source on the approximate clock.
 */
type SettledSeek =
  | { readonly kind: "approximate"; readonly seconds: number; readonly scrub: boolean }
  | { readonly kind: "pts"; readonly pts: Pts; readonly scrub: boolean };

/**
 * A navigation request that arrived while the calibration anchor was still open (ADR 003).
 *
 * The latest absolute seek replaces every earlier request, as a queued seek does (ADR 022).
 * Nominal steps add up instead: ADR 021 makes each key press one step, so three presses are a
 * step of three frames, and the latest press alone would drop two of them. The steps count
 * from the seek, or from the position the element holds when there is no seek.
 */
interface DeferredNavigation {
  /** The latest absolute seek, or null when the steps count from the element position. */
  readonly seek: DeferredSeek | null;
  /** The net number of nominal frames of the steps after that seek. */
  readonly frames: number;
}

/**
 * Factory function creating a vanilla Zustand store instance for playback state.
 *
 * The attached HTMLVideoElement/PlaybackMediaElement, active PlaybackSource, and calibration
 * anchor are kept strictly in the store factory closure to ensure that the public state
 * remains fully serializable.
 *
 * @param initialState Optional initial state overrides for testing.
 */
export function createPlaybackStore(
  initialState?: Partial<PlaybackState>,
): StoreApi<PlaybackStoreState> {
  let attachedSource: PlaybackSource | null = null;
  let attachedElement: PlaybackMediaElement | null = null;
  let activeSourceRevisionKey: string | null = null;
  let playSessionId = 0;
  let calibratedMediaTime: number | null = null;
  let lastPresentedMediaTime: number | null = null;
  let lastInferredPts: Pts | null = null;
  // Position the attached element held when it was attached, or null when it reported no
  // finite position. An element React has just created reports 0, and an element that already
  // played reports the position it reached, so the value separates the two whether or not
  // metadata has loaded. Used only by the anchor guard.
  let attachedStartTime: number | null = null;
  // Position the element is known to hold while nothing has moved it since the attach. It
  // starts at attachedStartTime and is taken again when metadata loads, because that is the
  // first moment the browser reports the true start of the media timeline, which ADR 003 does
  // not require to be 0. Used only by the anchor guard.
  let anchorBaselineTime: number | null = null;
  // Start of the browser media timeline, which ADR 003 does not require to be 0. It is taken
  // when metadata loads, the one moment the browser reports that start and nothing has moved
  // the element, and it is the same reading the anchor guard takes as its baseline. The
  // approximate clock subtracts it and seekApproximate adds it, so the browser clock and the
  // inferred source PTS report one axis: seconds elapsed from the start of the source. It
  // stays 0 until metadata loads, and it never reads seekable.start(0), which ADR 003 refuses
  // as a timestamp origin.
  let browserTimelineOriginSeconds = 0;
  // True when the store sent a seek to the element after the attach and before the calibration
  // anchor was taken. The frame such a seek presents is not the frame videoStartPts names, so
  // the anchor guard then refuses the anchor.
  //
  // The store defers every navigation while the calibration is "calibrating"
  // (deferredNavigation), so no action of the store can make this true in that state, and a
  // test calls every action before the anchor to hold that invariant. The flag stays as defence
  // in depth: issueSeek, the one place where the store moves the element, sets it whenever no
  // anchor exists, so a seek path that does not defer still cannot bind videoStartPts to a wrong
  // frame. A seek that the store does not send, such as the browser moving currentTime on its
  // own when metadata loads, is not recorded here; the position tests of the anchor guard cover
  // it.
  let seekedBeforeCalibration = false;
  // The navigation request that arrived while calibrationStatus was "calibrating", or null.
  // Issuing it would move the element away from the anchor baseline before the first frame
  // callback, and the attachment could then never calibrate (ADR 003). The store keeps the
  // request here, shows its target as the display target (ADR 022), and runs it through the
  // ordinary action when the calibration leaves "calibrating": on the calibrated path when it
  // is ready, and on the approximate path when it is unavailable. It is only ever set while the
  // status is "calibrating" and an element is attached and ready. A source change, a detach, a
  // reset, a loss of readiness, a failed seek, play, and an element that starts to play on its
  // own drop it. The public field hasDeferredNavigation reports it. The store has no timer:
  // while that field is true, the preview bounds the wait for the first frame, and at the
  // bound it reports frame callbacks as unavailable (syncPresentationUnavailable).
  let deferredNavigation: DeferredNavigation | null = null;
  // Source revision keys that lost precise editing. ADR 003 denies precision per source, so the
  // denial must outlive the attachment that detected it.
  const precisionDeniedSources = new Set<string>();
  // Queued seek target for coalescing rapid seeks. A media element aborts a running seek when
  // currentTime is assigned again, so a fast series of seeks never presents a frame; one seek
  // in flight with the latest request winning makes each seek complete (ADR 022).
  let queuedSeek: { mediaTime: number; scrub: boolean } | null = null;
  // Last accepted seek request (queued or issued). Used to de-duplicate successive scrub samples
  // that target the exact same media time, while never dropping an exact seek (ADR 022).
  // It is also the key that keeps the target while a scrub seek is the last request, and the
  // pending target for play and seekNominal.
  let lastAcceptedSeek: { mediaTime: number; scrub: boolean } | null = null;
  // Position of the last scrub audio burst request. Tracks drag direction and skips audio on
  // zero-distance moves (ADR 019, ADR 022).
  let lastScrubAudioTarget: number | null = null;

  return createStore<PlaybackStoreState>()((set, get) => {
    /**
     * Issues a seek to the media element (ADR 022).
     *
     * A scrub seek uses `fastSeek` when available to jump to a nearby keyframe, allowing
     * long-GOP sources to present frames more quickly during a drag. An exact seek (click
     * or final release of a drag) ALWAYS assigns `currentTime` so playback lands on the exact
     * target frame.
     */
    const issueSeek = (
      element: PlaybackMediaElement,
      entry: { mediaTime: number; scrub: boolean },
    ): void => {
      if (entry.scrub && typeof element.fastSeek === "function") {
        element.fastSeek(entry.mediaTime);
      } else {
        element.currentTime = entry.mediaTime;
      }
      if (calibratedMediaTime === null) {
        // The element left the baseline of the anchor guard before any anchor, so a later first
        // callback cannot identify videoStartPts. Defence in depth: while the calibration is
        // open, no action reaches this line (see seekedBeforeCalibration).
        seekedBeforeCalibration = true;
      }
    };

    /**
     * Requests an audio burst for a scrub seek that has been issued to the element (ADR 022).
     *
     * Audio is requested only when a seek is issued to the element rather than when queued,
     * so that the burst cadence follows the picture decoding cadence. Direction reflects
     * the sign of the movement from the last burst target (1 for forward or initial, -1 for backward).
     * Zero-distance moves are skipped.
     */
    const requestScrubBurst = (mediaTime: number): void => {
      let direction: 1 | -1;
      if (lastScrubAudioTarget === null) {
        direction = 1;
      } else if (mediaTime > lastScrubAudioTarget) {
        direction = 1;
      } else if (mediaTime < lastScrubAudioTarget) {
        direction = -1;
      } else {
        return;
      }
      lastScrubAudioTarget = mediaTime;
      scrubAudioController.request(mediaTime, direction);
    };

    /**
     * The pending display target to keep when the calibration stops holding, or undefined to
     * keep the current one (ADR 022).
     *
     * While the calibration holds, seekToPts and a nominal step report their display target
     * from the calibrated first frame, and a step reports the nominal start of its target
     * frame. Without a calibration, the playhead counts from the start of the timeline, the
     * axis of the approximate clock. A target that is still pending when the calibration
     * stops holding therefore moves to that axis: the position of the last accepted request,
     * measured from the start of the timeline. After play there is no such request; the
     * target then stays until the next seeked event or frame callback clears it.
     */
    const timelineAxisTargetOnCalibrationLoss = (): number | undefined => {
      const state = get();
      if (
        state.calibrationStatus !== "ready" ||
        state.seekTargetSeconds === null ||
        lastAcceptedSeek === null
      ) {
        return undefined;
      }
      return Math.max(0, lastAcceptedSeek.mediaTime - browserTimelineOriginSeconds);
    };

    // A media element aborts a running seek when currentTime is assigned again, so a fast series
    // of seeks never presents a frame; one seek in flight with the latest request winning makes
    // each seek complete (ADR 022).
    const dispatchSeek = (
      element: PlaybackMediaElement,
      mediaTime: number,
      scrub: boolean,
    ): boolean => {
      // Duplicate rule (ADR 022): drop a SCRUB request (no dispatch, no state change)
      // when its mediaTime equals the last accepted request's mediaTime, whether that
      // request was a scrub or exact.
      // An exact request is NEVER dropped, even when its time equals the previous
      // scrub target, because fastSeek lands on a keyframe rather than the target frame.
      if (
        scrub &&
        lastAcceptedSeek !== null &&
        lastAcceptedSeek.mediaTime === mediaTime
      ) {
        return false;
      }

      lastAcceptedSeek = { mediaTime, scrub };
      if (!scrub) {
        // Exact seeks record their mediaTime as the baseline for scrub audio, so the first
        // scrub after pointer down measures its direction from pointer-down time and a zero
        // move makes no sound (ADR 022).
        lastScrubAudioTarget = mediaTime;
      }

      playSessionId++;
      try {
        element.pause();
      } catch {
        // Ignore DOM exception
      }

      if (element.seeking === true) {
        queuedSeek = { mediaTime, scrub };
        return true;
      }

      try {
        issueSeek(element, { mediaTime, scrub });
        queuedSeek = null;
      } catch {
        queuedSeek = null;
        lastAcceptedSeek = null;
        lastScrubAudioTarget = null;
        set({
          isPlaying: false,
          error: "seekFailed",
          seekTargetSeconds: null,
          presentedFrame: null,
        });
        return false;
      }

      if (scrub) {
        requestScrubBurst(mediaTime);
      }
      return true;
    };

    /**
     * The bounds of a nominal step, as positions on the browser media timeline, the axis of
     * currentTime, which ADR 003 does not require to start at 0.
     *
     * The lower bound is the start of that timeline, or the calibrated first frame when it lies
     * later, because no frame precedes the one videoStartPts names. A target below the start
     * would never equal the position the next press reads back, because the browser moves it to
     * the start, so each press would seek again.
     *
     * The probe prefers the duration of the video stream, which counts from the first video
     * frame, so the approximate duration goes on the lower bound. The element stops a seek at
     * its own duration, an end position that caps any overshoot of that sum and that can be
     * rounded to the clock of the web view. Clamp to it as seekApproximate does, so that the
     * element reports back exactly the clamp value and the edge check of the step fires on the
     * next step. When the stream duration is invalid, the probe falls back to the container
     * duration, which counts from the container start, so the sum can overshoot by the distance
     * from the origin to the first frame; the element duration caps that overshoot when the
     * element reports one. Without either duration there is no upper bound.
     */
    const nominalStepBounds = (
      source: PlaybackSource,
      calibratedOrigin: number | null,
    ): { readonly lower: number; readonly upper: number } => {
      const lower =
        calibratedOrigin === null
          ? browserTimelineOriginSeconds
          : Math.max(browserTimelineOriginSeconds, calibratedOrigin);
      const approximateDuration = source.approximateDurationSeconds;
      const approximateEnd =
        typeof approximateDuration === "number" &&
        Number.isFinite(approximateDuration) &&
        approximateDuration > 0
          ? lower + approximateDuration
          : Number.POSITIVE_INFINITY;
      const runtimeDuration = get().runtimeBrowserDurationSeconds;
      const upper =
        runtimeDuration === null
          ? approximateEnd
          : Math.min(approximateEnd, runtimeDuration);
      return { lower, upper };
    };

    /**
     * The position on the browser media timeline that seekApproximate moves the element to, or
     * null when there is none.
     *
     * The caller passes seconds elapsed from the start of the source, the axis the ruler and the
     * approximate clock both use, so the origin of the browser media timeline goes back on. The
     * element stops a seek at its own duration.
     */
    const approximateSeekTarget = (seconds: number): number | null => {
      let target = seconds + browserTimelineOriginSeconds;
      const runtimeDuration = get().runtimeBrowserDurationSeconds;
      if (runtimeDuration !== null) {
        target = Math.min(target, runtimeDuration);
      }
      return Number.isFinite(target) && target >= 0 ? target : null;
    };

    /**
     * The index of the last nominal frame of the extent that the probe reports in ticks
     * (`lastFrameIndexOfExtent`), the frame that End goes to on the frame grid (ADR 026), or null
     * when the source reports no valid extent in ticks, or the index is not a safe integer.
     *
     * A frame step reads it so that the last frame a step reaches, and the frame that a step
     * clamped at the end shows, are that frame, and not the nominal frame that holds the end
     * position. The end position lies one interval after the start of the last frame, so the
     * frame that holds it by the ADR 028 margin is the frame after the last one, which does not
     * exist.
     */
    const extentLastFrameIndex = (
      source: PlaybackSource,
      fps: Rational,
    ): number | null => {
      const extent = source.videoDurationTicks;
      if (!isTickCountString(extent)) {
        return null;
      }
      const index = lastFrameIndexOfExtent(BigInt(extent), source.videoTimeBase, fps);
      return index !== null && index <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(index)
        : null;
    };

    /**
     * The frames that the steps of a deferred navigation can reach, and where they are, or null
     * when the source gives no step.
     *
     * The anchor is not known yet, so the frames are counted on the nominal grid from the lower
     * bound of a step without a calibration, the start of the browser media timeline, where ADR
     * 003 expects the first frame. The steps start from the target of the deferred seek, or
     * from the position the element holds when there is no seek. A PTS goes through the same
     * start. These values serve the display target and the edge rule of the deferred steps
     * only. The steps themselves run through seekNominal when the calibration settles, and it
     * applies its own grid, clamps and edges then (ADR 022).
     */
    const deferredStepGeometry = (
      seek: DeferredSeek | null,
    ): {
      readonly fps: Rational;
      readonly lower: number;
      readonly upper: number;
      readonly stepStart: number;
      readonly startFrame: number;
      readonly lastFrame: number;
      readonly onGrid: boolean;
    } | null => {
      if (!attachedSource || !attachedElement) {
        return null;
      }
      const fps = getNominalFrameRate(attachedSource);
      if (fps === null) {
        return null;
      }
      let start: number | null;
      if (seek === null) {
        start = attachedElement.currentTime;
      } else if (seek.kind === "approximate") {
        start = approximateSeekTarget(seek.seconds);
      } else {
        const elapsed =
          attachedSource.videoStartPts === null
            ? null
            : ptsElapsedSeconds(
                seek.pts,
                attachedSource.videoStartPts,
                attachedSource.videoTimeBase,
              );
        start = elapsed === null ? null : browserTimelineOriginSeconds + elapsed;
      }
      if (typeof start !== "number" || !Number.isFinite(start)) {
        return null;
      }
      const { lower, upper } = nominalStepBounds(attachedSource, null);
      const stepStart = Math.max(Math.min(start, upper), lower);
      // The ADR 028 rule: the nominal frame that contains a position, rounded down after the
      // frame boundary margin, as the step on the grid names frames.
      const marginSeconds = frameBoundaryMarginSeconds(
        fps,
        attachedSource.videoTimeBase,
      );
      const frameIndexAt = (browserTime: number): number =>
        Math.floor(((browserTime - lower + marginSeconds) * fps.n) / fps.d);
      const startFrame = frameIndexAt(stepStart);
      // The frame that contains the end position is the last frame a step reaches: a step past
      // it clamps to the end, inside that same frame. With the extent in ticks, the last frame
      // of the extent comes first, as it bounds a step after the anchor
      // (startsAtLastFrameOfExtent): the frame that holds the end position by the margin is
      // then the frame after it, which does not exist.
      const endFrame = Number.isFinite(upper)
        ? frameIndexAt(upper)
        : Number.POSITIVE_INFINITY;
      const extentLast = extentLastFrameIndex(attachedSource, fps);
      const lastFrame = Math.max(
        startFrame,
        extentLast === null ? endFrame : Math.min(endFrame, extentLast),
      );
      if (!Number.isSafeInteger(startFrame)) {
        return null;
      }
      return {
        fps,
        lower,
        upper,
        stepStart,
        startFrame,
        lastFrame,
        onGrid: hasExactFrameGrid(attachedSource),
      };
    };

    /**
     * The display target of a deferred navigation, in seconds from the start of the source, or
     * null when it moves nothing (ADR 022).
     *
     * A deferred seek alone shows its target as seekApproximate and seekToPts show it. A step
     * shows the nominal start of its target frame on a source where the step uses the frame
     * grid, and its relative target elsewhere, as seekNominal shows it. The target frame is
     * counted from the start of the timeline. When the calibrated first frame lies there, as it
     * does for most sources, the playhead does not move when the request runs.
     *
     * The grid display assumes that the calibration becomes ready. When it becomes unavailable
     * instead, the step runs off the grid, as the start position plus its intervals, and the
     * playhead moves when it runs. It moves by the part of a frame at which the deferred seek
     * lies, so by less than one frame, and not at all for a step from the element position,
     * which stands at the start of a frame.
     */
    const deferredDisplaySeconds = (entry: DeferredNavigation): number | null => {
      const { seek, frames } = entry;
      if (frames === 0) {
        if (seek === null) {
          return null;
        }
        if (seek.kind === "approximate") {
          const target = approximateSeekTarget(seek.seconds);
          return target === null
            ? null
            : Math.max(0, target - browserTimelineOriginSeconds);
        }
        const elapsed =
          attachedSource?.videoStartPts == null
            ? null
            : ptsElapsedSeconds(
                seek.pts,
                attachedSource.videoStartPts,
                attachedSource.videoTimeBase,
              );
        return elapsed === null ? null : Math.max(0, elapsed);
      }
      const geometry = deferredStepGeometry(seek);
      if (geometry === null) {
        return null;
      }
      const { fps, lower, upper, stepStart, startFrame, onGrid } = geometry;
      if (onGrid) {
        return Math.max(0, ((startFrame + frames) * fps.d) / fps.n);
      }
      const target = Math.max(
        Math.min(stepStart + (frames * fps.d) / fps.n, upper),
        lower,
      );
      return Math.max(0, target - lower);
    };

    /**
     * Keeps a navigation request while the calibration anchor is open, in place of a seek.
     *
     * The request stops playback, as a seek does, because a navigation means that the user
     * stops to look at frames. A pause does not move the element, so the anchor keeps its
     * baseline. The display target shows where the request goes (ADR 022). presentedFrame stays
     * null: no frame is confirmed before the anchor (ADR 003).
     */
    const deferNavigation = (entry: DeferredNavigation): void => {
      if (!attachedElement) {
        return;
      }
      playSessionId++;
      try {
        attachedElement.pause();
      } catch {
        // Ignore DOM exception
      }
      // A step back to the position the element holds leaves nothing to do.
      deferredNavigation = entry.seek === null && entry.frames === 0 ? null : entry;
      set({
        isPlaying: false,
        error: null,
        presentedFrame: null,
        seekTargetSeconds: deferredDisplaySeconds(entry),
        hasDeferredNavigation: deferredNavigation !== null,
      });
    };

    /**
     * True when a seek to the PTS shows the frame that the anchor presented, on a calibrated
     * source whose element has not moved since the anchor.
     *
     * A target at or before videoStartPts shows the first frame. On the frame grid (ADR 022), a
     * target inside nominal frame 0, counted from the calibrated first frame by the ADR 028 rule,
     * shows it too. Off the grid no frame boundary is known, so only the first test applies.
     */
    const ptsShowsAnchorFrame = (pts: Pts): boolean => {
      if (!attachedSource || !isPtsString(pts)) {
        return false;
      }
      const startPts = attachedSource.videoStartPts;
      const timeBase = attachedSource.videoTimeBase;
      if (startPts === null || !isPtsString(startPts)) {
        return false;
      }
      if (BigInt(pts) <= BigInt(startPts)) {
        return true;
      }
      const fps = getNominalFrameRate(attachedSource);
      if (fps === null || !hasExactFrameGrid(attachedSource)) {
        return false;
      }
      const elapsed = ptsElapsedSeconds(pts, startPts, timeBase);
      if (elapsed === null) {
        return false;
      }
      const marginSeconds = frameBoundaryMarginSeconds(fps, timeBase);
      return Math.floor(((elapsed + marginSeconds) * fps.n) / fps.d) <= 0;
    };

    /**
     * The seek that a deferred seek runs as once the calibration has left "calibrating", or
     * null when it is dropped.
     *
     * Ready:
     * - A seek with `keepBrowserTimeline`, End on the approximate clock (ADR 026), stays on the
     *   browser media timeline, as the same call runs after the anchor. A target at or before
     *   the anchor frame is dropped for the reason below.
     * - Any other ruler position becomes the PTS that the same position names on a calibrated
     *   source: videoStartPts plus its seconds in ticks, the conversion of a click on the ruler
     *   once the calibration holds (calculatePtsFromClientX). The deferred seconds count from the
     *   start of the browser timeline, and the ruler of a calibrated source counts from the
     *   calibrated first frame. Without the conversion, an audio-first lead would move the
     *   playhead back by that lead when the seek runs, and the steps after it would jump by the
     *   lead times the frame rate. The seconds are the ones the display target showed, clamped
     *   to the element duration as seekApproximate clamps them.
     * - A seek to the frame that the anchor presented is dropped (ptsShowsAnchorFrame). That
     *   frame is on screen, and a seek to it can bring no frame callback (ADR 022), which would
     *   leave presentedFrame null and the edit actions disabled. During playback the frame on
     *   screen changes, so nothing is dropped.
     *
     * Unavailable: the approximate path. A PTS goes to its elapsed seconds on the approximate
     * clock, because seekToPts has no mapping there.
     */
    const settleDeferredSeek = (
      seek: DeferredSeek,
      state: PlaybackState,
    ): SettledSeek | null => {
      if (!attachedSource) {
        return null;
      }
      const startPts = attachedSource.videoStartPts;
      const timeBase = attachedSource.videoTimeBase;
      if (
        state.calibrationStatus !== "ready" ||
        calibratedMediaTime === null ||
        startPts === null ||
        !isPtsString(startPts)
      ) {
        if (seek.kind === "approximate") {
          return seek;
        }
        const elapsed =
          startPts === null ? null : ptsElapsedSeconds(seek.pts, startPts, timeBase);
        return elapsed === null
          ? null
          : { kind: "approximate", seconds: Math.max(0, elapsed), scrub: seek.scrub };
      }
      let pts: Pts;
      if (seek.kind === "approximate") {
        const target = approximateSeekTarget(seek.seconds);
        if (target === null) {
          return null;
        }
        if (seek.keepBrowserTimeline) {
          // Before or at the anchor frame, the browser shows that frame, which is on screen.
          return !state.isPlaying &&
            target <= calibratedMediaTime + NOMINAL_STEP_EDGE_TOLERANCE_SECONDS
            ? null
            : seek;
        }
        const converted = elapsedSecondsToPts(
          Math.max(0, target - browserTimelineOriginSeconds),
          startPts,
          timeBase,
        );
        if (converted === null) {
          // No safe PTS for the position: it stays on the browser timeline.
          return seek;
        }
        pts = converted;
      } else {
        pts = seek.pts;
      }
      if (!state.isPlaying && ptsShowsAnchorFrame(pts)) {
        return null;
      }
      return { kind: "pts", pts, scrub: seek.scrub };
    };

    /**
     * Runs the deferred navigation once the calibration has left "calibrating", through the
     * ordinary actions, so every rule of those actions applies: the coalesced seeks, the frame
     * grid, the clamps and the edges of a step (ADR 022). The seek goes first, and the steps
     * count from it (settleDeferredSeek).
     *
     * The executed step requests the cue once, as every step does (ADR 019), and the deferred
     * presses requested none. The request makes no sound: the scrub audio element mounts only
     * after the calibration leaves "calibrating", which happens in this same call, so the
     * controller has no element when the request arrives.
     *
     * A seek with steps after it gives the element one seek, not two. Its target goes in as the
     * queued seek, the pending target that seekNominal counts from (ADR 022), and the step
     * replaces it. A step that cannot move from that target, at an edge, leaves it queued; the
     * seek then runs alone. A dropped seek leaves the steps to count from the frame on screen.
     */
    const runDeferredNavigation = (): void => {
      const entry = deferredNavigation;
      if (entry === null) {
        return;
      }
      deferredNavigation = null;
      const state = get();
      // The deferred request and its display target go. The action that runs sets its own.
      set({ hasDeferredNavigation: false, seekTargetSeconds: null });
      if (
        !attachedSource ||
        !attachedElement ||
        !state.isReady ||
        state.calibrationStatus === "calibrating"
      ) {
        return;
      }
      const seek = entry.seek === null ? null : settleDeferredSeek(entry.seek, state);
      const runSeek = (settled: SettledSeek): void => {
        if (settled.kind === "pts") {
          get().seekToPts(settled.pts, { scrub: settled.scrub });
        } else {
          get().seekApproximate(settled.seconds, { scrub: settled.scrub });
        }
      };
      if (entry.frames === 0) {
        if (seek !== null) {
          runSeek(seek);
        }
        return;
      }
      if (seek === null) {
        get().seekNominal(entry.frames);
        return;
      }
      const startPts = attachedSource.videoStartPts;
      const seekMediaTime =
        seek.kind === "approximate"
          ? approximateSeekTarget(seek.seconds)
          : calibratedMediaTime === null || startPts === null
            ? null
            : ptsToMediaTime(
                seek.pts,
                startPts,
                calibratedMediaTime,
                attachedSource.videoTimeBase,
              );
      if (seekMediaTime === null) {
        runSeek(seek);
        get().seekNominal(entry.frames);
        return;
      }
      const placeholder = { mediaTime: seekMediaTime, scrub: seek.scrub };
      queuedSeek = placeholder;
      get().seekNominal(entry.frames);
      if (queuedSeek === placeholder) {
        queuedSeek = null;
        runSeek(seek);
      }
    };

    /**
     * True when a frame step starts at or after the last frame of the extent that
     * `videoDurationTicks` reports, on a calibrated source (ADR 026). stepToFrame reads it for a
     * forward step that the end position clamped, which then cannot show a later frame.
     *
     * - On the frame grid, the start frame is at or after the last nominal frame of the extent,
     *   `lastFrameIndexOfExtent`, the frame that End goes to.
     * - Off the grid, no frame boundary is known. The start position is at or after the media
     *   time of the last tick of the extent, the target of End. The frame that holds that tick
     *   holds every later position, so the step would show the same frame.
     *
     * False without a calibration or without a valid extent in ticks: the edge rule then keeps
     * its other tests only.
     *
     * @param startFrame The frame the step starts from on the grid, or null off the grid.
     * @param startPosition The position the step starts from on the browser media timeline.
     */
    const startsAtLastFrameOfExtent = (
      source: PlaybackSource,
      fps: Rational,
      calibratedOrigin: number | null,
      startFrame: number | null,
      startPosition: number,
    ): boolean => {
      const extent = source.videoDurationTicks;
      const startPts = source.videoStartPts;
      if (
        calibratedOrigin === null ||
        !isTickCountString(extent) ||
        startPts === null ||
        !isPtsString(startPts)
      ) {
        return false;
      }
      if (startFrame !== null) {
        const lastFrame = extentLastFrameIndex(source, fps);
        return lastFrame !== null && startFrame >= lastFrame;
      }
      const extentTicks = BigInt(extent);
      if (extentTicks < 1n) {
        return false;
      }
      const lastTick = BigInt(startPts) + extentTicks - 1n;
      if (lastTick > I64_MAX) {
        return false;
      }
      const lastTickTime = ptsToMediaTime(
        lastTick.toString() as Pts,
        startPts,
        calibratedOrigin,
        source.videoTimeBase,
      );
      return (
        lastTickTime !== null &&
        startPosition >= lastTickTime - NOMINAL_STEP_EDGE_TOLERANCE_SECONDS
      );
    };

    /**
     * The frame step of seekNominal and seekToFrameIndex once the calibration has left
     * "calibrating", on the frame grid or off it (ADR 022). The caller checks the source, the
     * element, the readiness and the nominal rate, and passes them.
     *
     * A relative request steps `deltaFrames` frames from the frame the step starts from. An
     * absolute request goes to nominal frame `frameIndex` of the grid, and only on the grid; off
     * it the request does nothing. Both share every rule below: the start frame, the middle
     * target, the clamps, the edge no-op and the display target. The absolute request takes its
     * direction from the start frame, so a target that is the start frame is the edge no-op of
     * ADR 022 and ADR 026: a seek to the frame on screen, or to the frame of the pending exact
     * seek, does nothing. During playback that rule still holds while the element is inside the
     * start frame, and the request only pauses. Once the element has left the start frame, an
     * absolute request seeks back to it.
     */
    const stepToFrame = (
      request: FrameStepRequest,
      state: PlaybackState,
      source: PlaybackSource,
      element: PlaybackMediaElement,
      fps: Rational,
    ): void => {
      const pending =
        queuedSeek ?? (lastAcceptedSeek?.scrub === true ? lastAcceptedSeek : null);
      const currentBrowserTime = pending?.mediaTime ?? element.currentTime;
      if (
        typeof currentBrowserTime !== "number" ||
        !Number.isFinite(currentBrowserTime)
      ) {
        return;
      }

      // The calibrated first frame, while the calibration holds. It is the frame videoStartPts
      // names, so it is the start of nominal frame 0 and of the axis on which an inferred PTS
      // reports elapsed seconds.
      const calibratedOrigin =
        state.calibrationStatus === "ready" ? calibratedMediaTime : null;

      // The bounds on the browser media timeline (see nominalStepBounds). The edge check below
      // relies on the element reporting back exactly a clamp value.
      const { lower: lowerBound, upper: upperBound } = nominalStepBounds(
        source,
        calibratedOrigin,
      );

      // The step starts from the start position moved into the bounds. A step forward from a
      // position before the calibrated first frame therefore reaches the frame after it, and
      // not the frame already on screen, which can produce no RVFC callback (ADR 022). Each
      // clamp applies the lower bound last, so a step never seeks before the start of the
      // media when bad metadata puts the upper bound below it.
      const stepStart = Math.max(Math.min(currentBrowserTime, upperBound), lowerBound);

      // The step names frames on the nominal grid only when three conditions hold:
      // - A calibration holds. Frame 0 of the grid then starts at the calibrated first frame,
      //   the origin of the elapsed seconds that the timecode shows for the presented frame
      //   (videoStartPts), so the step and the timecode count the same frames (ADR 028).
      //   Without a calibration no frame boundary is known: the start of the timeline is not
      //   one when the audio starts before the video.
      // - The frame rate is constant: the average and the real frame rate do not differ, the
      //   test the timecode uses. At a variable rate the real frames do not follow the nominal
      //   grid, and a grid target skips a frame after a dropped or a longer frame.
      // - The grid is exact on the video time base (isFrameGridExact): the interval is a whole
      //   number of ticks, or one tick is less than half the interval minus 1 us. A real frame
      //   start lies less than one tick from its nominal start on every time base, so only
      //   then does the frame on screen round to its own nominal frame. On a coarser time
      //   base, such as 1/24 at 23.976 fps, one tick is almost a whole frame.
      //
      // On the grid, the step aims at the middle of the target frame, not at its nominal start.
      // A container such as Matroska stores each PTS rounded to the millisecond, so a real frame
      // can start after its nominal start, and a seek to the nominal start then presents the
      // frame before it again. The middle lies half an interval from both ends of the frame.
      //
      // Off the grid, the step moves the start position by the nominal interval, as it did
      // before the grid existed.
      //
      // A step of ten frames (ADR 026) is one request with ten frames, so it is one target and
      // one cue.
      const gridOrigin =
        calibratedOrigin !== null && hasExactFrameGrid(source)
          ? calibratedOrigin
          : null;
      let grid: {
        readonly startFrame: number;
        readonly targetFrame: number;
        readonly frameIndexAt: (browserTime: number) => number;
      } | null = null;
      let unclampedTarget: number;
      // The sign of the step: the sign of the relative step, or for an absolute target the side
      // of the start frame on which the target frame lies, and 0 when it is the start frame.
      let direction: number;
      if (gridOrigin === null) {
        // An absolute target needs the grid (seekToFrameIndex checks it first).
        if (request.kind === "absolute") {
          return;
        }
        unclampedTarget = stepStart + (request.deltaFrames * fps.d) / fps.n;
        direction = Math.sign(request.deltaFrames);
      } else {
        // The frame boundary margin of the timecode (ADR 028), from the same rate and time
        // base, so the step and the timecode name the same frame for the same position. It is
        // one tick when the interval is not a whole number of ticks, so a frame start that the
        // container rounded early, also against a rounded first PTS, still counts as its own
        // frame. On an exact grid it is less than half an interval minus 1 us, so the middle
        // target of the step before never reads as the next frame.
        const marginSeconds = frameBoundaryMarginSeconds(fps, source.videoTimeBase);
        // The nominal frame that contains a browser position: the ADR 028 rule, rounded down
        // after the margin. The position is converted once, to elapsed seconds on the grid, and
        // the rate stays the exact rational of the probe.
        const frameIndexAt = (browserTime: number): number =>
          Math.floor(((browserTime - gridOrigin + marginSeconds) * fps.n) / fps.d);

        // The start frame:
        // - With no seek pending, no display target and a frame on screen, it is that frame.
        //   RVFC reports the real start of the frame, which lies less than one tick from its
        //   nominal start, and on an exact grid one tick is less than half an interval, so
        //   rounding to the nearest frame is exact. currentTime can instead stand anywhere in
        //   the frame after a click, a drag or a pause, up to a tick before the next real start,
        //   where the rule below would name the next frame.
        // - A display target that is still set means that the last seek has not reported its
        //   frame. The frame on screen can then be the frame from before that seek: its late
        //   callback can arrive while the seek runs. Starting from it would aim at the frame of
        //   the pending target, and the edge rule would drop the press.
        // - Otherwise it is the frame of the start position. A pending or reached target of an
        //   earlier step is the middle of its frame, half an interval from each boundary, so a
        //   held key advances exactly one frame for each press and never drifts (ADR 021). Each
        //   target comes from a whole frame index and not from the earlier target plus an
        //   interval, so no rounding error accumulates. A frame start from seekToPts lies within
        //   one tick of its nominal start, which the margin covers.
        const presented = state.presentedFrame;
        let startFrame: number;
        if (
          pending === null &&
          state.seekTargetSeconds === null &&
          presented !== null
        ) {
          const exactFrame = ((presented.mediaTime - gridOrigin) * fps.n) / fps.d;
          // A tie breaks away from zero (ADR 002).
          startFrame =
            exactFrame < 0 ? -Math.round(-exactFrame) : Math.round(exactFrame);
        } else {
          startFrame = frameIndexAt(stepStart);
        }
        const targetFrame =
          request.kind === "absolute"
            ? request.frameIndex
            : startFrame + request.deltaFrames;
        direction = Math.sign(targetFrame - startFrame);
        if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(targetFrame)) {
          return;
        }
        unclampedTarget = gridOrigin + nominalFrameMiddleSeconds(targetFrame, fps);
        grid = { startFrame, targetFrame, frameIndexAt };
      }
      if (!Number.isFinite(unclampedTarget)) {
        return;
      }
      // The clamp can pull the target to a bound: the calibrated first frame or the start of
      // the timeline, or the end position.
      let targetTime = Math.max(Math.min(unclampedTarget, upperBound), lowerBound);
      // A step never moves against its direction when it starts outside the bounds. The rule
      // compares against the real start position, currentBrowserTime (the pending target when
      // one exists, and currentTime when none exists), not against stepStart. The element can
      // stand outside the bounds: the probe reports the duration of the video stream, and the
      // element plays to the end of the container, which can lie later. A forward step from
      // there would otherwise seek back, and a backward step from a position before the
      // calibrated first frame would seek forward. Inside the bounds only a step from the frame
      // on screen can aim behind currentTime, when playback moved currentTime past that frame
      // before its callback, and the frame on screen is then the right start.
      if (
        currentBrowserTime !== stepStart &&
        ((direction > 0 && targetTime < currentBrowserTime) ||
          (direction < 0 && targetTime > currentBrowserTime))
      ) {
        targetTime = currentBrowserTime;
      }

      // A step at the first or the last frame of the source cannot move it. Such a step does
      // nothing to the position. It dispatches no seek, keeps presentedFrame and
      // seekTargetSeconds, and requests no cue. A seek that lands on the frame already on
      // screen can produce no RVFC callback (ADR 022), so dispatching it would leave
      // presentedFrame null and the edit actions disabled, and each press would play the
      // ADR 019 cue again at the same position. Before the anchor is taken, the step does not
      // reach this line: its action defers it, with the same edge rule on the frames it counts.
      // ADR 021 makes each key press one step; at an edge there is no frame to step to, so a
      // press that does not move keeps that rule.
      //
      // Three tests find that step:
      // - The target is the position the step starts from: the rules above return it at a
      //   bound, and the no-backward rule returns it outside the bounds. The comparison uses
      //   the real start position, currentBrowserTime, and not stepStart: the pending target
      //   when one exists, and currentTime when none exists. A pending exact seek to the edge
      //   therefore absorbs each later press toward that edge, and the element still receives
      //   that one seek.
      // - On the frame grid, the clamped target lies in the frame the step starts from. A step
      //   back from the middle of the first frame clamps to the start of that same frame, which
      //   is a different position and the same picture. The same holds for a step forward that
      //   the end position clamps inside the frame it starts from. Without a clamp, the target
      //   is the middle of another frame and never matches.
      // - A forward step that the end position clamped starts from the last frame of the extent
      //   (startsAtLastFrameOfExtent). The end position lies one interval after the start of the
      //   last frame, so on the grid the clamp lands in the nominal frame after it, which does
      //   not exist, and the second test misses it. The seek would show the same frame. End goes
      //   to the last frame (ADR 026), so a step forward after End reaches this test.
      // A pending scrub target does not count: fastSeek lands on a keyframe and not on its
      // target, so an exact seek is still required (ADR 022).
      // An absolute target during playback does not count once the element has left the start
      // frame. The start frame is then the frame last reported, and the picture has already moved
      // past it, so a typed frame seeks back to it. While the element is still inside the start
      // frame, the edge rule applies: the step only pauses, the picture stays on that frame, and
      // presentedFrame stays valid, where a seek onto the frame on screen could bring no frame
      // callback and leave presentedFrame null (ADR 022).
      const leftStartFrameDuringPlayback =
        request.kind === "absolute" &&
        state.isPlaying &&
        grid !== null &&
        grid.frameIndexAt(currentBrowserTime) !== grid.startFrame;
      const clampedAtEnd = direction > 0 && unclampedTarget > upperBound;
      if (
        pending?.scrub !== true &&
        !leftStartFrameDuringPlayback &&
        (Math.abs(targetTime - currentBrowserTime) <
          NOMINAL_STEP_EDGE_TOLERANCE_SECONDS ||
          (grid !== null && grid.frameIndexAt(targetTime) === grid.startFrame) ||
          (clampedAtEnd &&
            startsAtLastFrameOfExtent(
              source,
              fps,
              calibratedOrigin,
              grid === null ? null : grid.startFrame,
              currentBrowserTime,
            )))
      ) {
        // A frame step means that the user stops to look at frames (ADR 019, ADR 022), so an
        // edge press during playback still pauses, as the seek path does. pause stops the cue
        // and invalidates a pending play promise, and it does not touch presentedFrame.
        if (state.isPlaying) {
          get().pause();
        }
        return;
      }

      // The step stays exact: it assigns currentTime through the helper with scrub false
      // (ADR 019, ADR 022).
      if (!dispatchSeek(element, targetTime, false)) {
        return;
      }

      // A relative step is a frame step, and it requests the cue (ADR 019). An absolute target
      // is a jump, as a click on the ruler is, and it requests none: seekToFrameIndex stopped
      // the cue as seekToPts does.
      if (request.kind === "relative") {
        scrubAudioController.request(targetTime, direction > 0 ? 1 : -1);
      }

      // Do not update inferred PTS optimistically after assigning currentTime.
      //
      // On the frame grid, the display target is the nominal start of the target frame, while
      // the element seeks to its middle. The presented frame then reports its real start, which
      // lies within one tick of that nominal start, so the playhead and the pending In region
      // do not move back when the frame arrives, and a held key moves them one frame for each
      // press (ADR 022). The timecode names the target frame from its nominal start (ADR 028).
      // A target that the end position pulled back shows the nominal start of the frame that
      // contains it, or of the last frame of the extent when that is earlier, for the same
      // reason. A target that the lower bound raised shows as it is.
      //
      // Off the grid, the target shows as it is. It counts from the calibrated first frame
      // while a calibration holds, the origin of the elapsed seconds of the presented frame and
      // of seekToPts, and from the start of the timeline, the origin of the approximate clock,
      // without one.
      let seekTargetSeconds: number;
      if (grid !== null && targetTime === unclampedTarget) {
        seekTargetSeconds = Math.max(0, (grid.targetFrame * fps.d) / fps.n);
      } else if (grid !== null && targetTime < unclampedTarget) {
        // The end position lies one interval after the start of the last frame, so the frame
        // that holds it by the margin is the frame after the last one. With the extent in ticks,
        // the display names the last frame of the extent instead, the frame that arrives, and the
        // playhead does not move back when it arrives.
        const extentLast = extentLastFrameIndex(source, fps);
        const shownFrame =
          extentLast === null
            ? grid.frameIndexAt(targetTime)
            : Math.min(grid.frameIndexAt(targetTime), extentLast);
        seekTargetSeconds = Math.max(0, (shownFrame * fps.d) / fps.n);
      } else {
        seekTargetSeconds = Math.max(
          0,
          targetTime - (calibratedOrigin ?? browserTimelineOriginSeconds),
        );
      }
      set({
        isPlaying: false,
        error: null,
        presentedFrame: null,
        seekTargetSeconds,
      });
    };

    /**
     * Clears the stop point of a segment playback (ADR 026). Every action that the user starts,
     * and every change of the source or of the calibration, calls it, so a playback that starts
     * later plays with no stop point. It writes only when a stop point is set.
     */
    const dropPlaybackStop = (): void => {
      if (get().playbackStop !== null) {
        set({ playbackStop: null });
      }
    };

    /**
     * Pauses the attached element, stops the cue and invalidates a pending play promise. It does
     * not touch presentedFrame. `pause` runs it after it clears the stop point, and the stop of a
     * segment playback runs it with the stop point kept.
     */
    const pauseElement = (): void => {
      lastScrubAudioTarget = null;
      scrubAudioController.stop();

      if (!attachedSource || !attachedElement) {
        set({ isPlaying: false });
        return;
      }

      playSessionId++;
      try {
        attachedElement.pause();
      } catch {
        // Ignore DOM exception
      }
      set({ isPlaying: false });
    };

    /**
     * The ADR 028 index of the frame at a presented PTS on the frame grid, counted from
     * videoStartPts, or -1 for a PTS before it. The index of a real frame is exact on the grid
     * (ADR 022), and this is the rule that End reads for the frame on screen (ADR 026).
     */
    const stopFrameIndexOfPts = (
      source: PlaybackSource,
      fps: Rational,
      pts: Pts,
    ): number => {
      const startPts = source.videoStartPts;
      if (startPts === null || !isPtsString(startPts) || !isPtsString(pts)) {
        return -1;
      }
      const index = frameIndexOfTicks(
        BigInt(pts) - BigInt(startPts),
        source.videoTimeBase,
        fps,
        source.videoTimeBase,
      );
      return index === null ? -1 : Number(index);
    };

    /**
     * True when the playback rests with a pause alone on the frame at a presented PTS, once the
     * stop is reached (applyPlaybackStop):
     *
     * - On the frame grid, the ADR 028 index of the frame is the index of the last frame.
     * - Off the grid, the frame starts before the Out. The playback reaches the stop on such a
     *   frame only when it starts at the last tick before the Out, which proves the last frame, or
     *   when the prediction names it (isPredictedLastFrame).
     *
     * The position of the element does not count. A frame callback runs after the browser
     * presented the frame, and the pause runs later still, so the paused position can lie past the
     * last frame while the picture still shows it. A seek from there could land on the frame on
     * screen, which can bring no frame callback (ADR 022). When the browser does present a later
     * frame, its callback comes in the "stopped" phase (isInStopWindow).
     */
    const isRestFrame = (
      source: PlaybackSource,
      target: PlaybackStopTarget,
      framePts: Pts,
    ): boolean => {
      if (target.kind === "frame") {
        return stopFrameIndexOfPts(source, target.fps, framePts) === target.lastFrame;
      }
      return isPtsString(framePts) && BigInt(framePts) < target.out;
    };

    /**
     * True when a settled frame in the "stopped" phase is a frame of the stop, which keeps it:
     *
     * - On the frame grid, the frame has the index of the last frame: the last frame shown again.
     * - Off the grid, the frame starts at or after the frame that the stop rested on, and before
     *   the Out. It is that frame shown again, or a later frame that the browser presents after the
     *   pause. After an early prediction, such a later frame lies in the segment at or before the
     *   real last frame, and it can still lie before it.
     *
     * A frame before the frame of the stop comes from a seek that the store did not make, as on
     * the grid.
     */
    const keepsStop = (
      source: PlaybackSource,
      target: PlaybackStopTarget,
      stop: Extract<PlaybackStop, { phase: "stopped" }>,
      framePts: Pts,
    ): boolean => {
      if (target.kind === "frame") {
        return stopFrameIndexOfPts(source, target.fps, framePts) === target.lastFrame;
      }
      if (!isPtsString(framePts) || !isPtsString(stop.restPts)) {
        return false;
      }
      const pts = BigInt(framePts);
      return pts >= BigInt(stop.restPts) && pts < target.out;
    };

    /**
     * The end of the seek-back window of a stop that rests with a pause alone, in seconds from
     * videoStartPts, or null when the Out has no safe elapsed time.
     *
     * The window reaches playbackStopWindowSeconds past the Out. When the element paused after
     * outPts, after a stall of the page or with a decoder that lags, the window reaches the
     * position where it paused, on the calibrated mapping, plus the same distance again, when that
     * is later. The frame that holds that position then lies in it. The browser normally
     * presents no later frame after the pause. The distance past the position allows for a
     * position that the web view reports as an estimate: with the media in another process, as
     * WKWebView runs it, `currentTime` right after a pause can lie a little before the position
     * where the element stops.
     */
    const stopWindowEndSeconds = (
      source: PlaybackSource,
      target: PlaybackStopTarget,
      outPts: Pts,
      position: number,
    ): number | null => {
      const startPts = source.videoStartPts;
      if (startPts === null || !isPtsString(startPts)) {
        return null;
      }
      const outElapsed = ptsElapsedSeconds(outPts, startPts, source.videoTimeBase);
      if (outElapsed === null) {
        return null;
      }
      const windowSeconds = playbackStopWindowSeconds(target.fps);
      const fromOut = outElapsed + windowSeconds;
      if (
        calibratedMediaTime === null ||
        typeof position !== "number" ||
        !Number.isFinite(position)
      ) {
        return fromOut;
      }
      return Math.max(fromOut, position - calibratedMediaTime + windowSeconds);
    };

    /**
     * True when a settled frame in the "stopped" phase lies in the seek-back window: after the
     * last frame, and at or before the frame that holds the end of the window
     * (stopWindowEndSeconds).
     *
     * - On the frame grid, its ADR 028 index lies after the index of the last frame, and at or
     *   before the index of the frame that holds the end of the window.
     * - Off the grid, it starts at or after the Out, and at or before the end of the window.
     *
     * Such a frame is a frame that the browser presented after the pause, from a position that
     * the element reached before the pause took effect. The seek back from it goes to another
     * frame than the one on screen, so it brings a frame callback. A frame past the window comes
     * from a seek that the store did not make, such as one from the media controls of the system.
     */
    const isInStopWindow = (
      source: PlaybackSource,
      target: PlaybackStopTarget,
      stop: Extract<PlaybackStop, { phase: "stopped" }>,
      framePts: Pts,
    ): boolean => {
      const startPts = source.videoStartPts;
      const windowEnd = stop.windowEndSeconds;
      if (
        !isPtsString(framePts) ||
        startPts === null ||
        !isPtsString(startPts) ||
        windowEnd === null
      ) {
        return false;
      }
      if (target.kind === "frame") {
        const index = stopFrameIndexOfPts(source, target.fps, framePts);
        if (index <= target.lastFrame) {
          return false;
        }
        // The frame that holds the end of the window, by the ADR 028 rule.
        const margin = frameBoundaryMarginSeconds(target.fps, source.videoTimeBase);
        const windowEndFrame = Math.floor(
          ((windowEnd + margin) * target.fps.n) / target.fps.d,
        );
        return index <= windowEndFrame;
      }
      if (BigInt(framePts) < target.out) {
        return false;
      }
      const elapsed = ptsElapsedSeconds(framePts, startPts, source.videoTimeBase);
      return elapsed !== null && elapsed <= windowEnd;
    };

    /**
     * True when the last frame of the segment is the last frame of the video: the Out lies at or
     * after the end of the extent in ticks, so no frame of the video follows the segment. On the
     * frame grid, the last frame is the last frame of the extent (the rule of End, ADR 026). Off
     * the grid, the Out lies at or after `videoStartPts + videoDurationTicks`. False when the probe
     * gives no extent in ticks.
     *
     * The element can play on after that frame, because the audio can last longer than the video.
     * The picture then keeps the last frame of the video, which is the last frame of the segment,
     * so a seek to it would land on the frame on screen.
     */
    const endsWithVideo = (
      source: PlaybackSource,
      target: PlaybackStopTarget,
    ): boolean => {
      const extent = source.videoDurationTicks;
      const startPts = source.videoStartPts;
      if (!isTickCountString(extent) || startPts === null || !isPtsString(startPts)) {
        return false;
      }
      if (target.kind === "frame") {
        const extentLast = lastFrameIndexOfExtent(
          BigInt(extent),
          source.videoTimeBase,
          target.fps,
        );
        return extentLast !== null && BigInt(target.lastFrame) >= extentLast;
      }
      return target.out >= BigInt(startPts) + BigInt(extent);
    };

    /**
     * True when the element stands at least playbackStopWindowSeconds past the media time of the
     * Out, on the calibrated mapping: the rule of the backstop (applyPlaybackStopBackstop).
     */
    const isPastStopWindow = (
      source: PlaybackSource,
      target: PlaybackStopTarget,
      stop: PlaybackStop,
      position: number,
    ): boolean => {
      const startPts = source.videoStartPts;
      if (
        calibratedMediaTime === null ||
        startPts === null ||
        typeof position !== "number" ||
        !Number.isFinite(position)
      ) {
        return false;
      }
      const outTime = ptsToMediaTime(
        stop.outPts,
        startPts,
        calibratedMediaTime,
        source.videoTimeBase,
      );
      return (
        outTime !== null && position >= outTime + playbackStopWindowSeconds(target.fps)
      );
    };

    /**
     * Clears the stop point and seeks to the last frame of the segment: on the frame grid with
     * the frame step to its index, which aims at the middle of the frame and shows its nominal
     * start (seekToFrameIndex, ADR 022), and off the grid with seekToPts of the last tick, which
     * the browser shows as the frame that holds it. Neither requests a cue (ADR 019).
     *
     * On the grid the step counts from the frame on screen, `framePts`, which always lies after
     * the last frame. With no frame named, it counts from the position of the element: with no
     * frame on screen, the frame step starts from the position (stepToFrame).
     */
    const seekToStopFrame = (
      target: PlaybackStopTarget,
      framePts: Pts | null,
    ): void => {
      set({ playbackStop: null });
      if (!attachedSource || !attachedElement) {
        return;
      }
      if (target.kind === "tick") {
        get().seekToPts(target.lastTick);
        return;
      }
      const state = get();
      stepToFrame(
        { kind: "absolute", frameIndex: target.lastFrame },
        framePts === null ? { ...state, presentedFrame: null } : state,
        attachedSource,
        attachedElement,
        target.fps,
      );
    };

    /**
     * Tests a presented frame against the stop point of a segment playback (ADR 026).
     * syncPresentedFrame calls it for a settled frame of a ready calibration: no seek runs or
     * waits, so the frame comes from the playback and not from a seek that is still running.
     *
     * While the playback runs, the stop is reached at the first frame that is the last frame of
     * the segment, or is predicted to be, or lies past it:
     *
     * - On the frame grid, the ADR 028 index of the frame is the index of the last frame or a
     *   later one. The index is exact, so the rule finds the last frame itself.
     * - Off the grid, the frame starts at or after the last tick before the Out, or the Out lies
     *   less than one and a half nominal intervals after it (isPredictedLastFrame). Without a
     *   nominal rate, only the first test applies.
     *
     * The store then pauses. When the frame is the last frame, or off the grid any frame before
     * the Out (isRestFrame), the pause is the whole stop, and the phase becomes "stopped", with the
     * frame and the end of the seek-back window (stopWindowEndSeconds). No seek lands on the frame
     * on screen. When the frame lies past the last frame, because a callback came late or was
     * skipped, the store seeks back from it (seekToStopFrame).
     *
     * In the "stopped" phase the element is paused. A frame of the stop keeps it (keepsStop). A
     * frame in the seek-back window (isInStopWindow) gets one seek back. Any other frame comes from
     * a seek that the store did not make, and the stop point goes with no seek.
     */
    const applyPlaybackStop = (framePts: Pts): void => {
      const stop = get().playbackStop;
      if (stop === null || !attachedSource || !attachedElement) {
        return;
      }
      const target = playbackStopTarget(attachedSource, stop.inPts, stop.outPts);
      if (target === null || !isPtsString(framePts)) {
        set({ playbackStop: null });
        return;
      }

      if (stop.phase === "stopped") {
        // An element that plays again was started from outside the store, and its `play` event
        // can run after this frame callback. The stop is over, as syncPlay would decide, and a
        // seek back would pause the playback that the user started.
        if (get().isPlaying || attachedElement.paused === false) {
          set({ playbackStop: null });
          return;
        }
        if (keepsStop(attachedSource, target, stop, framePts)) {
          return;
        }
        if (isInStopWindow(attachedSource, target, stop, framePts)) {
          seekToStopFrame(target, framePts);
        } else {
          set({ playbackStop: null });
        }
        return;
      }

      const reached =
        target.kind === "frame"
          ? stopFrameIndexOfPts(attachedSource, target.fps, framePts) >=
            target.lastFrame
          : BigInt(framePts) >= target.out - 1n ||
            (target.fps !== null &&
              isPredictedLastFrame(
                BigInt(framePts),
                target.out,
                attachedSource.videoTimeBase,
                target.fps,
              ));
      if (!reached) {
        return;
      }
      pauseElement();
      if (!isRestFrame(attachedSource, target, framePts)) {
        seekToStopFrame(target, framePts);
        return;
      }
      // The phase changes in the call that pauses, before the `pause` event of this pause runs,
      // so that event does not read as a pause from the system (syncPause). The position is read
      // after the pause, where the element stopped.
      set({
        playbackStop: {
          phase: "stopped",
          inPts: stop.inPts,
          outPts: stop.outPts,
          restPts: framePts,
          windowEndSeconds: stopWindowEndSeconds(
            attachedSource,
            target,
            stop.outPts,
            attachedElement.currentTime,
          ),
        },
      });
    };

    /**
     * The backstop of a segment playback on the approximate clock (ADR 026). syncBrowserTime
     * calls it for each `timeupdate`.
     *
     * The stop reads frame callbacks, and a window that is hidden or minimized presents no
     * frames, so the playback would run past the Out. While the phase is "playing" and no seek
     * runs or waits, a position that lies playbackStopWindowSeconds or more past the Out
     * (isPastStopWindow) pauses the element and seeks to the last frame, counted from the
     * position (seekToStopFrame). When the last frame of the segment is the last frame of the
     * video (endsWithVideo), the picture keeps that frame, and the pause is the whole stop.
     *
     * On a visible window the frame callbacks stop the playback first: the distance keeps two or
     * more of them between the Out and the backstop. While the decoder keeps up, the picture
     * follows the element clock, so a backstop that still fires there seeks to another frame than
     * the one on screen. A decoder that lags can leave the last frame on screen, and the seek of
     * the backstop can then land on it.
     */
    const applyPlaybackStopBackstop = (element: PlaybackMediaElement): void => {
      const stop = get().playbackStop;
      if (
        stop === null ||
        stop.phase !== "playing" ||
        !attachedSource ||
        element.seeking === true ||
        queuedSeek !== null
      ) {
        return;
      }
      const target = playbackStopTarget(attachedSource, stop.inPts, stop.outPts);
      if (
        target === null ||
        !isPastStopWindow(attachedSource, target, stop, element.currentTime)
      ) {
        return;
      }
      pauseElement();
      if (endsWithVideo(attachedSource, target)) {
        set({ playbackStop: null });
        return;
      }
      seekToStopFrame(target, null);
    };

    /**
     * Ends a segment playback when the element reaches the end of the media before the stop
     * (ADR 026). The element sends `pause` and then `ended`, and the first of the two calls this.
     * Both callers call it only while the element reports `ended`, so a late `ended` event of an
     * earlier end does not end a segment playback that started after it.
     *
     * The stop point goes. The store seeks back to the last frame only when the playback passed
     * the Out with no frame callback. It does not seek in two cases:
     *
     * - The last frame of the segment is the last frame of the video (endsWithVideo). The element
     *   ends with the audio, which can last longer than the video, and the picture keeps the last
     *   frame of the video. This is the case of an Out at the end of the extent (ADR 026), and of
     *   an extent that ends after the last frame, where the last frame of the grid does not exist.
     * - The Out lies at or after the position where the element ended. This test applies whenever
     *   the first one does not, also when the probe gives no extent in ticks.
     */
    const endPlaybackStopAtEnd = (element: PlaybackMediaElement): void => {
      const stop = get().playbackStop;
      if (stop === null || stop.phase !== "playing") {
        return;
      }
      set({ playbackStop: null });
      if (!attachedSource || calibratedMediaTime === null) {
        return;
      }
      const target = playbackStopTarget(attachedSource, stop.inPts, stop.outPts);
      const startPts = attachedSource.videoStartPts;
      const position = element.currentTime;
      if (
        target === null ||
        startPts === null ||
        endsWithVideo(attachedSource, target) ||
        typeof position !== "number" ||
        !Number.isFinite(position)
      ) {
        return;
      }
      const outTime = ptsToMediaTime(
        stop.outPts,
        startPts,
        calibratedMediaTime,
        attachedSource.videoTimeBase,
      );
      if (
        outTime === null ||
        outTime >= position - NOMINAL_STEP_EDGE_TOLERANCE_SECONDS
      ) {
        return;
      }
      seekToStopFrame(target, null);
    };

    return {
      presentedFrame: initialState?.presentedFrame ?? null,
      calibrationStatus: initialState?.calibrationStatus ?? "unavailable",
      runtimeBrowserDurationSeconds:
        initialState?.runtimeBrowserDurationSeconds ?? null,
      approximateBrowserTimeSeconds:
        initialState?.approximateBrowserTimeSeconds ?? null,
      seekTargetSeconds: initialState?.seekTargetSeconds ?? null,
      hasDeferredNavigation: initialState?.hasDeferredNavigation ?? false,
      playbackStop: initialState?.playbackStop ?? null,
      isPlaying: initialState?.isPlaying ?? false,
      isAttached: initialState?.isAttached ?? false,
      attachedSourceRevisionKey: initialState?.attachedSourceRevisionKey ?? null,
      isReady: initialState?.isReady ?? false,
      error: initialState?.error ?? null,

      attach: (source: PlaybackSource, element: PlaybackMediaElement) => {
        // 1. Validate basic element and source existence
        if (
          !source ||
          typeof source.path !== "string" ||
          !element ||
          typeof element.play !== "function" ||
          typeof element.pause !== "function"
        ) {
          return;
        }

        let hasValidTimeBase = true;
        try {
          assertPositiveTimeBase(source.videoTimeBase);
        } catch {
          hasValidTimeBase = false;
        }

        const newIdentity = getSourceRevisionKey(source);
        const isPrecisionDenied = precisionDeniedSources.has(newIdentity);
        const hasValidStartPts =
          source.videoStartPts !== null && isPtsString(source.videoStartPts);
        const initialCalibrationStatus: CalibrationStatus =
          hasValidStartPts && hasValidTimeBase && !isPrecisionDenied
            ? "calibrating"
            : "unavailable";

        const isElementReady =
          typeof element.readyState === "number" &&
          (typeof HTMLMediaElement !== "undefined"
            ? element.readyState >= HTMLMediaElement.HAVE_METADATA
            : element.readyState >= 1);

        if (attachedElement === element && activeSourceRevisionKey === newIdentity) {
          attachedSource = source;
          if (isElementReady && !get().isReady) {
            set({ isReady: true });
          }
          return;
        }

        if (attachedElement !== null && attachedElement !== element) {
          try {
            attachedElement.pause();
          } catch {
            // Ignore DOM exception on tearing down superseded element
          }
        }

        playSessionId++;
        activeSourceRevisionKey = newIdentity;
        attachedSource = source;
        attachedElement = element;
        calibratedMediaTime = null;
        lastPresentedMediaTime = null;
        lastInferredPts = null;
        // Record where the element stands, so the first RVFC callback can be checked against it.
        // The application reaches attach from the ref callback of a node React has just created,
        // which reports readyState 0, so the guard must have a baseline for that element too.
        const startTime =
          typeof element.currentTime === "number" &&
          Number.isFinite(element.currentTime)
            ? element.currentTime
            : null;
        attachedStartTime = startTime;
        anchorBaselineTime = startTime;
        // The position an element holds before its metadata loads does not report the start of
        // the media timeline, so the origin waits for syncReady.
        browserTimelineOriginSeconds = 0;
        seekedBeforeCalibration = false;
        deferredNavigation = null;
        queuedSeek = null;
        lastAcceptedSeek = null;
        lastScrubAudioTarget = null;

        set({
          presentedFrame: null,
          calibrationStatus: initialCalibrationStatus,
          runtimeBrowserDurationSeconds: null,
          approximateBrowserTimeSeconds: null,
          seekTargetSeconds: null,
          hasDeferredNavigation: false,
          playbackStop: null,
          isPlaying: false,
          isAttached: true,
          attachedSourceRevisionKey: newIdentity,
          isReady: isElementReady,
          error: null,
        });
      },

      detach: (sourceRevisionKey: string, element: PlaybackMediaElement) => {
        if (!attachedSource || !attachedElement || !element) {
          return;
        }

        const currentIdentity = getSourceRevisionKey(attachedSource);
        if (sourceRevisionKey !== currentIdentity) {
          return;
        }

        if (attachedElement !== element) {
          return;
        }

        scrubAudioController.stop();
        lastScrubAudioTarget = null;

        playSessionId++;
        try {
          attachedElement.pause();
        } catch {
          // Ignore DOM exception
        }
        attachedSource = null;
        attachedElement = null;
        activeSourceRevisionKey = null;
        calibratedMediaTime = null;
        lastPresentedMediaTime = null;
        lastInferredPts = null;
        attachedStartTime = null;
        anchorBaselineTime = null;
        browserTimelineOriginSeconds = 0;
        seekedBeforeCalibration = false;
        deferredNavigation = null;
        queuedSeek = null;
        lastAcceptedSeek = null;

        set({
          presentedFrame: null,
          calibrationStatus: "unavailable",
          runtimeBrowserDurationSeconds: null,
          approximateBrowserTimeSeconds: null,
          seekTargetSeconds: null,
          hasDeferredNavigation: false,
          playbackStop: null,
          isPlaying: false,
          isAttached: false,
          attachedSourceRevisionKey: null,
          isReady: false,
        });
      },

      syncReady: (sourceRevisionKey: string, element: PlaybackMediaElement) => {
        if (!attachedSource || !attachedElement) {
          return;
        }

        if (getSourceRevisionKey(attachedSource) !== sourceRevisionKey) {
          return;
        }

        if (attachedElement !== element) {
          return;
        }

        // Loaded metadata is the first moment the browser reports the true start of the media
        // timeline. Take it as the baseline of the anchor guard while the anchor is still open
        // and nothing has moved the element, so a source whose timeline starts away from 0 still
        // calibrates (ADR 003). No seek can precede this point, because every seek action of the
        // store requires isReady, and this call is what grants it.
        //
        // The same reading is the origin of the browser media timeline, which the approximate
        // clock subtracts to reach the source-elapsed axis.
        if (
          calibratedMediaTime === null &&
          !seekedBeforeCalibration &&
          typeof element.currentTime === "number" &&
          Number.isFinite(element.currentTime)
        ) {
          anchorBaselineTime = element.currentTime;
          browserTimelineOriginSeconds = Math.max(0, element.currentTime);
        }

        set({ isReady: true });
      },

      syncUnready: (sourceRevisionKey: string, element: PlaybackMediaElement) => {
        if (!attachedSource || !attachedElement) {
          return;
        }

        if (getSourceRevisionKey(attachedSource) !== sourceRevisionKey) {
          return;
        }

        if (attachedElement !== element) {
          return;
        }

        queuedSeek = null;
        lastAcceptedSeek = null;
        lastScrubAudioTarget = null;
        // A deferred navigation needs a ready element to run on.
        deferredNavigation = null;
        playSessionId++;
        try {
          attachedElement.pause();
        } catch {
          // Ignore DOM exception
        }

        set({
          isReady: false,
          isPlaying: false,
          seekTargetSeconds: null,
          hasDeferredNavigation: false,
          playbackStop: null,
        });
      },

      togglePlayback: () => {
        if (get().isPlaying) {
          get().pause();
        } else {
          get().play();
        }
      },

      play: () => {
        // A playback that the user starts plays with no stop point (ADR 026). playSegment sets
        // its stop point after this call.
        dropPlaybackStop();
        const state = get();
        if (!attachedSource || !attachedElement || !state.isReady) {
          return;
        }

        const pending =
          queuedSeek ?? (lastAcceptedSeek?.scrub === true ? lastAcceptedSeek : null);
        if (pending !== null) {
          const nextMediaTime = pending.mediaTime;
          queuedSeek = null;
          try {
            // A queued seek or issued scrub seek must be flushed as EXACT before playing, so
            // playback starts at the last target and not at a keyframe (ADR 022).
            issueSeek(attachedElement, { mediaTime: nextMediaTime, scrub: false });
          } catch {
            lastAcceptedSeek = null;
            lastScrubAudioTarget = null;
            set({
              isPlaying: false,
              error: "seekFailed",
              seekTargetSeconds: null,
              presentedFrame: null,
            });
            return;
          }
          lastAcceptedSeek = null;
        }

        // A navigation deferred during calibration is dropped, and playback starts where the
        // element stands. play must call the element at once to keep the user activation, so
        // it cannot wait for the anchor, and a seek before the anchor would refuse the
        // calibration for the attachment (ADR 003). What the user loses is the position that
        // the deferred request asked for, however long it waited: no deferred request moved the
        // element, so playback starts from the position it held when the request arrived. The
        // first frames of the playback can then take the anchor.
        const droppedDeferred = deferredNavigation !== null;
        deferredNavigation = null;

        const currentSession = ++playSessionId;
        const currentIdentity = getSourceRevisionKey(attachedSource);
        const targetElement = attachedElement;

        // Optimistically update playing state and clear previous error
        set({
          isPlaying: true,
          error: null,
          ...(droppedDeferred
            ? { seekTargetSeconds: null, hasDeferredNavigation: false }
            : {}),
        });

        lastAcceptedSeek = null;
        lastScrubAudioTarget = null;
        scrubAudioController.stop();

        let result: Promise<void> | void;
        try {
          result = targetElement.play();
        } catch {
          if (
            playSessionId === currentSession &&
            attachedSource &&
            getSourceRevisionKey(attachedSource) === currentIdentity &&
            attachedElement === targetElement &&
            get().isReady
          ) {
            set({ isPlaying: false, error: "playbackFailed", playbackStop: null });
          }
          return;
        }

        if (result && typeof result.then === "function") {
          result
            .then(() => {
              if (
                playSessionId === currentSession &&
                attachedSource &&
                getSourceRevisionKey(attachedSource) === currentIdentity &&
                attachedElement === targetElement &&
                get().isReady
              ) {
                set({ isPlaying: true, error: null });
              }
            })
            .catch(() => {
              if (
                playSessionId === currentSession &&
                attachedSource &&
                getSourceRevisionKey(attachedSource) === currentIdentity &&
                attachedElement === targetElement &&
                get().isReady
              ) {
                // A play that fails ends a segment playback, so its stop point goes too.
                set({ isPlaying: false, error: "playbackFailed", playbackStop: null });
              }
            });
        }
      },

      pause: () => {
        // Space, the pause button and a second Play Segment end a segment playback (ADR 026).
        dropPlaybackStop();
        pauseElement();
      },

      playSegment: (inPts: Pts, outPts: Pts) => {
        const state = get();
        if (
          !attachedSource ||
          !attachedElement ||
          !state.isReady ||
          state.calibrationStatus !== "ready" ||
          calibratedMediaTime === null ||
          !canPlaySegment(attachedSource, inPts, outPts)
        ) {
          return;
        }
        // The seek and the play clear any earlier stop point, so a second segment replaces the
        // first. play calls the element in this same call, which keeps the user activation. A
        // pending seek to the In is flushed as an exact seek before the element plays (ADR 022).
        get().seekToPts(inPts);
        if (get().error !== null) {
          return;
        }
        get().play();
        if (!get().isPlaying) {
          return;
        }
        const stop: PlaybackStop = { inPts, outPts, phase: "playing" };
        set({ playbackStop: stop });
      },

      seekToPts: (targetPts: Pts, options?: SeekOptions) => {
        // Every seek ends a segment playback (ADR 026): a click, a scrub, a trim, Home, End, Go
        // to In and Go to Out.
        dropPlaybackStop();
        const scrub = options?.scrub === true;
        if (!scrub) {
          scrubAudioController.stop();
        }

        // A failed request is the latest request, so it also drops the pending ones: the queued
        // seek and a navigation deferred during calibration (ADR 022).
        const failSeek = (): void => {
          queuedSeek = null;
          lastAcceptedSeek = null;
          lastScrubAudioTarget = null;
          deferredNavigation = null;
          playSessionId++;
          try {
            attachedElement?.pause();
          } catch {
            // Ignore DOM exception
          }
          set({
            isPlaying: false,
            error: "seekFailed",
            seekTargetSeconds: null,
            hasDeferredNavigation: false,
          });
        };

        const state = get();
        // While the anchor is open the mapping is not known yet, but it will be at the first
        // presented frame, so the request is deferred and not refused.
        const deferring = state.calibrationStatus === "calibrating";
        if (
          !attachedSource ||
          !attachedElement ||
          !state.isReady ||
          attachedSource.videoStartPts === null ||
          (!deferring &&
            (state.calibrationStatus !== "ready" || calibratedMediaTime === null))
        ) {
          failSeek();
          return;
        }

        if (!isPtsString(targetPts)) {
          failSeek();
          return;
        }

        const rawElapsed = ptsElapsedSeconds(
          targetPts,
          attachedSource.videoStartPts,
          attachedSource.videoTimeBase,
        );

        if (rawElapsed === null) {
          failSeek();
          return;
        }

        if (deferring) {
          // The display target needs no anchor: it is the elapsed time from videoStartPts.
          deferNavigation({ seek: { kind: "pts", pts: targetPts, scrub }, frames: 0 });
          return;
        }

        const targetMediaTime =
          calibratedMediaTime === null
            ? null
            : ptsToMediaTime(
                targetPts,
                attachedSource.videoStartPts,
                calibratedMediaTime,
                attachedSource.videoTimeBase,
              );

        if (targetMediaTime === null) {
          failSeek();
          return;
        }

        // End off the frame grid (ADR 026): the target is the last tick of the extent. The frame
        // that holds every position from that tick to the end of the element is the last frame,
        // so when the element already stands there with that frame confirmed, a seek would show
        // the same frame and could bring no frame callback (ADR 022). The seek then does nothing,
        // as a nominal step at an edge does off the grid: the test reads the position only.
        //
        // The element stops a seek at its own duration, which can lie before the last tick: an
        // MP4 with B-frames and no edit list reports the composition offset as its start PTS, so
        // the calibrated mapping puts the last tick past the end of the element. The seek of End
        // then reaches the duration and not the tick, so the test compares the position with the
        // earlier of the two. The tolerance covers the rounding of the position that the element
        // reports back after the seek.
        if (options?.extentEnd === true && !scrub) {
          const pending =
            queuedSeek ?? (lastAcceptedSeek?.scrub === true ? lastAcceptedSeek : null);
          const position = attachedElement.currentTime;
          const runtimeDuration = state.runtimeBrowserDurationSeconds;
          const reachable =
            runtimeDuration === null
              ? targetMediaTime
              : Math.min(targetMediaTime, runtimeDuration);
          if (
            !state.isPlaying &&
            state.presentedFrame !== null &&
            state.seekTargetSeconds === null &&
            pending === null &&
            attachedElement.seeking !== true &&
            typeof position === "number" &&
            Number.isFinite(position) &&
            position >= reachable - NOMINAL_STEP_EDGE_TOLERANCE_SECONDS
          ) {
            return;
          }
        }

        if (!dispatchSeek(attachedElement, targetMediaTime, scrub)) {
          return;
        }

        const seekTargetSeconds = Math.max(0, rawElapsed);

        // Do not update inferred PTS optimistically after assigning currentTime.
        // Inferred PTS will update when RVFC fires for the newly presented frame.
        set({
          isPlaying: false,
          error: null,
          presentedFrame: null,
          seekTargetSeconds,
        });
      },

      seekNominal: (deltaFrames: number) => {
        // A frame step ends a segment playback (ADR 026), also a step at an edge.
        dropPlaybackStop();
        if (
          typeof deltaFrames !== "number" ||
          !Number.isSafeInteger(deltaFrames) ||
          deltaFrames === 0
        ) {
          return;
        }

        const state = get();
        if (!attachedSource || !attachedElement || !state.isReady) {
          return;
        }

        const fps = getNominalFrameRate(attachedSource);
        if (!fps) {
          // Disabled when neither frame rate exists
          return;
        }

        if (state.calibrationStatus === "calibrating") {
          // The anchor is still open, so the step is deferred (ADR 003). The net frame count
          // takes one frame for each press (ADR 021), inside the frames that the deferred steps
          // can reach. A press past the first or the last of them is a press at an edge, which
          // moves nothing, as below: it keeps the deferred request, and it still pauses.
          const entry = deferredNavigation ?? { seek: null, frames: 0 };
          const geometry = deferredStepGeometry(entry.seek);
          if (geometry === null) {
            return;
          }
          const frames = Math.min(
            Math.max(entry.frames + deltaFrames, -geometry.startFrame),
            geometry.lastFrame - geometry.startFrame,
          );
          if (!Number.isSafeInteger(frames)) {
            return;
          }
          if (frames === entry.frames) {
            if (state.isPlaying) {
              get().pause();
            }
            return;
          }
          deferNavigation({ seek: entry.seek, frames });
          return;
        }

        stepToFrame(
          { kind: "relative", deltaFrames },
          state,
          attachedSource,
          attachedElement,
          fps,
        );
      },

      seekToFrameIndex: (frameIndex: number) => {
        dropPlaybackStop();
        if (
          typeof frameIndex !== "number" ||
          !Number.isSafeInteger(frameIndex) ||
          frameIndex < 0
        ) {
          return;
        }
        // A jump to a frame, as a click on the ruler is, and not a frame step: it stops the cue
        // and requests none (ADR 019).
        scrubAudioController.stop();

        const state = get();
        if (!attachedSource || !attachedElement || !state.isReady) {
          return;
        }
        const fps = getNominalFrameRate(attachedSource);
        if (fps === null || !hasExactFrameGrid(attachedSource)) {
          return;
        }

        if (state.calibrationStatus === "calibrating") {
          // The anchor is still open, so the request is deferred (ADR 003). Frame `frameIndex` of
          // the grid lies that many frames after the calibrated first frame, so the request is a
          // seek to the first frame followed by that many steps. At the anchor the seek to the
          // first frame is dropped, because that frame is on screen, and the steps run as one
          // nominal step from it, which on the grid aims at the middle of frame `frameIndex`, as
          // this action does (ADR 022). A later step adds to the count, and a later seek replaces
          // it. The count stays inside the frames that the deferred steps can reach, as
          // seekNominal keeps it.
          const startPts = attachedSource.videoStartPts;
          if (startPts === null || !isPtsString(startPts)) {
            return;
          }
          const seek: DeferredSeek = { kind: "pts", pts: startPts, scrub: false };
          const geometry = deferredStepGeometry(seek);
          if (geometry === null) {
            return;
          }
          const frames = Math.min(
            frameIndex - geometry.startFrame,
            geometry.lastFrame - geometry.startFrame,
          );
          if (!Number.isSafeInteger(frames) || frames < 0) {
            return;
          }
          deferNavigation({ seek, frames });
          return;
        }

        // Without a calibration the grid has no frame 0.
        if (state.calibrationStatus !== "ready") {
          return;
        }
        stepToFrame(
          { kind: "absolute", frameIndex },
          state,
          attachedSource,
          attachedElement,
          fps,
        );
      },

      seekApproximate: (seconds: number, options?: SeekOptions) => {
        dropPlaybackStop();
        const scrub = options?.scrub === true;
        if (!scrub) {
          scrubAudioController.stop();
        }

        const state = get();
        if (
          !attachedElement ||
          !state.isReady ||
          typeof seconds !== "number" ||
          !Number.isFinite(seconds) ||
          seconds < 0
        ) {
          return;
        }

        // The caller passes seconds elapsed from the start of the source, the axis the ruler and
        // the approximate clock both use, so the origin of the browser media timeline goes back
        // on before the element is moved.
        const target = approximateSeekTarget(seconds);
        if (target === null) {
          return;
        }

        if (state.calibrationStatus === "calibrating") {
          // The ruler takes a click as soon as metadata loads, which is before the anchor, so
          // the seek is deferred until the anchor is taken (ADR 003). A scrub sample replaces the
          // one before it, and the audio of the drag starts with the first seek that runs.
          deferNavigation({
            seek: {
              kind: "approximate",
              seconds,
              scrub,
              keepBrowserTimeline: options?.keepBrowserTimeline === true,
            },
            frames: 0,
          });
          return;
        }

        if (!dispatchSeek(attachedElement, target, scrub)) {
          return;
        }

        // Do not update the approximate clock optimistically after assigning currentTime, for
        // the same reason the inferred PTS waits for RVFC: the element's own `seeked` event
        // reports the position it reached.
        const seekTargetSeconds = Math.max(0, target - browserTimelineOriginSeconds);
        set({
          isPlaying: false,
          error: null,
          presentedFrame: null,
          seekTargetSeconds,
        });
      },

      syncPresentedFrame: (
        sourceRevisionKey: string,
        mediaTime: number,
        _presentedFrames: number | undefined,
        element: PlaybackMediaElement,
      ) => {
        if (!attachedSource || !attachedElement) {
          return;
        }

        if (getSourceRevisionKey(attachedSource) !== sourceRevisionKey) {
          return;
        }

        if (attachedElement !== element) {
          return;
        }

        // A scrub seek (fastSeek) lands on a keyframe rather than the target frame.
        // Clearing seekTargetSeconds when it settles would jump the playhead and timecode
        // from the pointer to that keyframe (possibly seconds away). Therefore, clearing
        // additionally requires lastAcceptedSeek?.scrub !== true (ADR 022). The target is
        // then cleared when the exact seek at release settles. Failure and reset paths
        // still clear it unconditionally.
        const settled =
          attachedElement.seeking !== true &&
          queuedSeek === null &&
          lastAcceptedSeek?.scrub !== true;

        // Write the unavailable state only when it is not already the state, or when
        // clearing a non-null seek target once settled (ADR 022). RVFC fires for every
        // presented frame, and an unchanged partial still allocates a state and notifies everyone.
        const markUnavailable = () => {
          const state = get();
          const shouldClearTarget = settled && state.seekTargetSeconds !== null;
          // A target that stays pending moves to the axis of the approximate clock. The write
          // happens only on the change from ready, which the first test below already covers.
          const retarget = settled ? undefined : timelineAxisTargetOnCalibrationLoss();
          if (
            state.calibrationStatus !== "unavailable" ||
            state.presentedFrame !== null ||
            shouldClearTarget
          ) {
            set({
              calibrationStatus: "unavailable",
              presentedFrame: null,
              // The flag is true only while calibrating. runDeferredNavigation below reads the
              // request itself, not this flag.
              hasDeferredNavigation: false,
              // Without the calibration no presented frame names the last frame of a segment,
              // so a segment playback goes on as a normal playback (ADR 026).
              playbackStop: null,
              ...(settled
                ? { seekTargetSeconds: null }
                : retarget !== undefined
                  ? { seekTargetSeconds: retarget }
                  : {}),
            });
          }
          // A navigation deferred while the anchor was open now runs on the approximate path.
          runDeferredNavigation();
        };

        if (
          typeof mediaTime !== "number" ||
          !Number.isFinite(mediaTime) ||
          mediaTime < 0
        ) {
          // An RVFC callback that reports no usable mediaTime is a property of the source,
          // so the denial holds for every later attachment of it (ADR 003).
          precisionDeniedSources.add(sourceRevisionKey);
          calibratedMediaTime = null;
          lastPresentedMediaTime = null;
          lastInferredPts = null;
          markUnavailable();
          return;
        }

        // If source does not have videoStartPts, precision is unavailable
        if (
          attachedSource.videoStartPts === null ||
          !isPtsString(attachedSource.videoStartPts) ||
          get().calibrationStatus === "unavailable"
        ) {
          markUnavailable();
          return;
        }

        const isFirstCallback = calibratedMediaTime === null;

        if (isFirstCallback) {
          // ADR 003 step 4 anchors videoStartPts on the first frame the element presents after it
          // loads at the beginning of the source. An element that already played and was attached
          // again presents another frame first, and binding videoStartPts to that frame offsets
          // every later inferred PTS. Refuse the anchor and fall back to the approximate clock.
          //
          // The element can also leave the start before the first callback arrives. The ruler
          // and the step keys act as soon as metadata loads, which is before the anchor. The
          // store defers their seeks until the anchor is taken (deferredNavigation), so they
          // leave the element where it is. A seek that still reaches the element before the
          // anchor is recorded, because the browser moves currentTime on its own when metadata
          // loads and a position alone cannot separate the two.
          const hasMovedBeforeAttach =
            attachedStartTime !== null && attachedStartTime > ANCHOR_TOLERANCE_SECONDS;
          const hasMovedAfterAttach =
            anchorBaselineTime !== null &&
            Math.abs(mediaTime - anchorBaselineTime) > ANCHOR_TOLERANCE_SECONDS;

          if (hasMovedBeforeAttach || hasMovedAfterAttach || seekedBeforeCalibration) {
            markUnavailable();
            return;
          }

          // First presented frame establishes calibration anchor
          calibratedMediaTime = mediaTime;
          const initialPts = attachedSource.videoStartPts;
          lastInferredPts = initialPts;
          lastPresentedMediaTime = mediaTime;

          set({
            calibrationStatus: "ready",
            presentedFrame: { mediaTime, inferredSourcePts: initialPts },
            hasDeferredNavigation: false,
            ...(settled ? { seekTargetSeconds: null } : {}),
          });
          // A navigation deferred while the anchor was open now runs on the calibrated path.
          runDeferredNavigation();
          return;
        }

        // Subsequent frame presentation
        if (get().calibrationStatus !== "ready") {
          if (settled && get().seekTargetSeconds !== null) {
            set({ seekTargetSeconds: null });
          }
          return;
        }

        const calibrationAnchor = calibratedMediaTime;
        if (calibrationAnchor === null) {
          markUnavailable();
          return;
        }

        const inferredPts = mediaTimeToPts(
          mediaTime,
          calibrationAnchor,
          attachedSource.videoStartPts,
          attachedSource.videoTimeBase,
        );

        if (inferredPts === null) {
          // The mapping of this source cannot be converted safely, which no later attachment
          // of the same file changes (ADR 003).
          precisionDeniedSources.add(sourceRevisionKey);
          markUnavailable();
          return;
        }

        // Detect duplicate inferred PTS on a distinct presented frame
        const isDistinctPresentation =
          lastPresentedMediaTime !== null && mediaTime !== lastPresentedMediaTime;

        if (isDistinctPresentation && inferredPts === lastInferredPts) {
          // Distinct RVFC presented frames inferred the same source PTS -> disable precision.
          // ADR 003 disables it for that source, so record it against the source revision key.
          precisionDeniedSources.add(sourceRevisionKey);
          markUnavailable();
          return;
        }

        lastPresentedMediaTime = mediaTime;
        lastInferredPts = inferredPts;

        set({
          presentedFrame: { mediaTime, inferredSourcePts: inferredPts },
          ...(settled ? { seekTargetSeconds: null } : {}),
        });

        // A frame that arrives while a seek runs or waits can come from before that seek, such as
        // the seek to the In of a segment playback, so only a settled frame meets the stop.
        if (settled) {
          applyPlaybackStop(inferredPts);
        }
      },

      syncPresentationUnavailable: (
        sourceRevisionKey: string,
        element: PlaybackMediaElement,
      ) => {
        if (
          !attachedSource ||
          !attachedElement ||
          attachedElement !== element ||
          getSourceRevisionKey(attachedSource) !== sourceRevisionKey
        ) {
          return;
        }

        // Read before the status changes: a pending target moves to the axis of the approximate
        // clock only when the calibration held until now.
        const retarget = timelineAxisTargetOnCalibrationLoss();
        calibratedMediaTime = null;
        lastPresentedMediaTime = null;
        lastInferredPts = null;
        set({
          calibrationStatus: "unavailable",
          presentedFrame: null,
          hasDeferredNavigation: false,
          playbackStop: null,
          ...(retarget !== undefined ? { seekTargetSeconds: retarget } : {}),
        });
        // A navigation deferred while the anchor was open now runs on the approximate path.
        runDeferredNavigation();
      },

      syncBrowserDuration: (
        sourceRevisionKey: string,
        element: PlaybackMediaElement,
      ) => {
        if (
          !attachedSource ||
          attachedElement !== element ||
          getSourceRevisionKey(attachedSource) !== sourceRevisionKey
        ) {
          return;
        }
        const duration = element.duration;
        set({
          runtimeBrowserDurationSeconds:
            typeof duration === "number" && Number.isFinite(duration) && duration >= 0
              ? duration
              : null,
        });
      },

      syncBrowserTime: (sourceRevisionKey: string, element: PlaybackMediaElement) => {
        if (
          !attachedSource ||
          attachedElement !== element ||
          getSourceRevisionKey(attachedSource) !== sourceRevisionKey
        ) {
          return;
        }
        const time = element.currentTime;
        // Report seconds elapsed from the start of the source, not the raw position on the
        // browser media timeline, so this clock and an inferred source PTS name one axis. The
        // origin is 0 until metadata loads, which leaves the raw position unchanged.
        const next =
          typeof time === "number" && Number.isFinite(time) && time >= 0
            ? Math.max(0, time - browserTimelineOriginSeconds)
            : null;
        // `timeupdate` fires while the element is paused on some browsers, so an identical
        // write would notify every subscriber for nothing.
        if (get().approximateBrowserTimeSeconds !== next) {
          set({ approximateBrowserTimeSeconds: next });
        }
        // A segment playback on a window that presents no frames stops here (ADR 026).
        applyPlaybackStopBackstop(element);
      },

      syncSeeking: (sourceRevisionKey: string, element: PlaybackMediaElement) => {
        if (
          !attachedSource ||
          attachedElement !== element ||
          getSourceRevisionKey(attachedSource) !== sourceRevisionKey
        ) {
          return;
        }
        // Every seek of the store clears the stop point before it moves the element: each seek
        // action calls dropPlaybackStop, and the seek back of the stop (seekToStopFrame) clears it
        // first. So a seek that starts in the "stopped" phase comes from outside the store, such
        // as the media controls of the system, and the stop is over. Without this, the later
        // frame of that seek could lie in the seek-back window and be pulled back. In the
        // "playing" phase the late `seeking` event of the seek to the In still arrives after
        // playSegment set the stop point, so that phase keeps it.
        if (get().playbackStop?.phase === "stopped") {
          set({ playbackStop: null });
        }
      },

      syncSeeked: (sourceRevisionKey: string, element: PlaybackMediaElement) => {
        if (
          !attachedSource ||
          attachedElement !== element ||
          getSourceRevisionKey(attachedSource) !== sourceRevisionKey
        ) {
          return;
        }

        // A seeked task can run after a newer seek already started (seeking is true again).
        // If the element is seeking, return without touching queuedSeek or seekTargetSeconds:
        // the seeked event of the running seek will arrive and dispatch the queue.
        if (element.seeking === true) {
          return;
        }

        if (queuedSeek !== null) {
          const nextEntry = queuedSeek;
          queuedSeek = null;
          try {
            issueSeek(element, nextEntry);
          } catch {
            lastAcceptedSeek = null;
            lastScrubAudioTarget = null;
            set({
              isPlaying: false,
              error: "seekFailed",
              seekTargetSeconds: null,
              presentedFrame: null,
            });
            return;
          }
          if (nextEntry.scrub) {
            requestScrubBurst(nextEntry.mediaTime);
          }
        } else if (
          lastAcceptedSeek?.scrub !== true &&
          deferredNavigation === null &&
          get().calibrationStatus !== "ready" &&
          get().seekTargetSeconds !== null
        ) {
          // In non-ready calibration states, seeked clears the display target once settled,
          // but a scrub seek must not clear it because fastSeek lands on a keyframe (ADR 022).
          // A deferred navigation has not reached the element, so no seeked event answers it,
          // and its target stays until it runs.
          set({ seekTargetSeconds: null });
        }
      },

      syncPlay: (sourceRevisionKey: string, element: PlaybackMediaElement) => {
        if (!attachedSource || !attachedElement) {
          return;
        }

        if (getSourceRevisionKey(attachedSource) !== sourceRevisionKey) {
          return;
        }

        if (attachedElement !== element) {
          return;
        }

        if (!get().isReady) {
          return;
        }

        // The element started to play without the store, for example from a media key. A
        // navigation deferred during calibration is dropped, as play drops it: the element now
        // moves on its own, so the deferred target no longer shows where it goes.
        const droppedDeferred = deferredNavigation !== null;
        deferredNavigation = null;
        // A segment playback that the store stopped on its last frame is over. A play that
        // starts from the element plays with no stop point (ADR 026). The `play` event of the
        // play that started the segment playback finds the "playing" phase and keeps it.
        const droppedStop = get().playbackStop?.phase === "stopped";
        set({
          isPlaying: true,
          error: null,
          ...(droppedDeferred
            ? { seekTargetSeconds: null, hasDeferredNavigation: false }
            : {}),
          ...(droppedStop ? { playbackStop: null } : {}),
        });
      },

      syncPause: (sourceRevisionKey: string, element: PlaybackMediaElement) => {
        if (!attachedSource || !attachedElement) {
          return;
        }

        if (getSourceRevisionKey(attachedSource) !== sourceRevisionKey) {
          return;
        }

        if (attachedElement !== element) {
          return;
        }

        // While a segment playback runs, a pause from the system ends it (ADR 026). The pause of
        // the stop itself never reaches this test, because the stop moves the phase to "stopped"
        // before it pauses. Two other pauses do not end it. An element that reached its end
        // sends `pause` before `ended`, and the end has its own rule. A `pause` event that finds
        // the element playing again is the late event of the seek to the In, which play
        // followed.
        if (get().playbackStop?.phase === "playing") {
          if (element.ended === true) {
            endPlaybackStopAtEnd(element);
          } else if (element.paused !== false) {
            set({ playbackStop: null });
          }
        }

        playSessionId++;
        set({ isPlaying: false });
      },

      syncEnded: (sourceRevisionKey: string, element: PlaybackMediaElement) => {
        if (!attachedSource || !attachedElement) {
          return;
        }

        if (getSourceRevisionKey(attachedSource) !== sourceRevisionKey) {
          return;
        }

        if (attachedElement !== element) {
          return;
        }

        // A late `ended` event of an earlier end finds the element away from its end, and it
        // does not end a segment playback that started after that end.
        if (element.ended === true) {
          endPlaybackStopAtEnd(element);
        }
        playSessionId++;
        set({ isPlaying: false });
      },

      dismissError: (code?: PlaybackErrorCode) => {
        const current = get().error;
        // A notice passes the code it shows, so its timer cannot clear a newer error that
        // has not rendered yet.
        if (current === null || (code !== undefined && current !== code)) {
          return;
        }
        set({ error: null });
      },

      reset: () => {
        scrubAudioController.stop();
        lastScrubAudioTarget = null;
        playSessionId++;
        if (attachedElement) {
          try {
            attachedElement.pause();
          } catch {
            // Ignore DOM exception
          }
        }
        attachedSource = null;
        attachedElement = null;
        activeSourceRevisionKey = null;
        calibratedMediaTime = null;
        lastPresentedMediaTime = null;
        lastInferredPts = null;
        attachedStartTime = null;
        anchorBaselineTime = null;
        browserTimelineOriginSeconds = 0;
        seekedBeforeCalibration = false;
        deferredNavigation = null;
        queuedSeek = null;
        lastAcceptedSeek = null;
        // precisionDeniedSources is kept: ADR 003 denies precise editing for the source, and a
        // source keeps the same revision key until the file on disk changes.

        set({
          presentedFrame: null,
          calibrationStatus: "unavailable",
          runtimeBrowserDurationSeconds: null,
          approximateBrowserTimeSeconds: null,
          seekTargetSeconds: null,
          hasDeferredNavigation: false,
          playbackStop: null,
          isPlaying: false,
          isAttached: false,
          attachedSourceRevisionKey: null,
          isReady: false,
          error: null,
        });
      },
    };
  });
}

export type PlaybackStore = ReturnType<typeof createPlaybackStore>;

/**
 * Default singleton playback store for production application use.
 */
export const playbackStore: PlaybackStore = createPlaybackStore();

const defaultSelector = (state: PlaybackStoreState): PlaybackStoreState => state;

/**
 * React hook for consuming the production playback store.
 */
export function usePlaybackStore(): PlaybackStoreState;
export function usePlaybackStore<T>(selector: (state: PlaybackStoreState) => T): T;
export function usePlaybackStore<T>(
  selector?: (state: PlaybackStoreState) => T,
): T | PlaybackStoreState {
  return useStore(
    playbackStore,
    (selector ?? defaultSelector) as (state: PlaybackStoreState) => T,
  );
}
