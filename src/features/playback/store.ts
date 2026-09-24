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
  isPtsString,
  mediaTimeToPts,
  ptsElapsedSeconds,
  ptsToMediaTime,
  rationalsEqual,
} from "@/lib/time";
import { frameBoundaryMarginSeconds, isFrameGridExact } from "@/lib/timecode";
import type { Pts, Rational } from "@/types/project";
import { scrubAudioController } from "./scrubAudio";
import type {
  CalibrationStatus,
  PlaybackErrorCode,
  PlaybackMediaElement,
  PlaybackSource,
  PlaybackState,
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
  // True when the element was seeked after the attach and before the calibration anchor was
  // taken. The frame such a seek presents is not the frame videoStartPts names.
  let seekedBeforeCalibration = false;
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

    return {
      presentedFrame: initialState?.presentedFrame ?? null,
      calibrationStatus: initialState?.calibrationStatus ?? "unavailable",
      runtimeBrowserDurationSeconds:
        initialState?.runtimeBrowserDurationSeconds ?? null,
      approximateBrowserTimeSeconds:
        initialState?.approximateBrowserTimeSeconds ?? null,
      seekTargetSeconds: initialState?.seekTargetSeconds ?? null,
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
        queuedSeek = null;
        lastAcceptedSeek = null;
        lastScrubAudioTarget = null;

        set({
          presentedFrame: null,
          calibrationStatus: initialCalibrationStatus,
          runtimeBrowserDurationSeconds: null,
          approximateBrowserTimeSeconds: null,
          seekTargetSeconds: null,
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
        queuedSeek = null;
        lastAcceptedSeek = null;

        set({
          presentedFrame: null,
          calibrationStatus: "unavailable",
          runtimeBrowserDurationSeconds: null,
          approximateBrowserTimeSeconds: null,
          seekTargetSeconds: null,
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
            attachedElement.currentTime = nextMediaTime;
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

        const currentSession = ++playSessionId;
        const currentIdentity = getSourceRevisionKey(attachedSource);
        const targetElement = attachedElement;

        // Optimistically update playing state and clear previous error
        set({ isPlaying: true, error: null });

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
            set({ isPlaying: false, error: "playbackFailed" });
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
                set({ isPlaying: false, error: "playbackFailed" });
              }
            });
        }
      },

      pause: () => {
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
      },

      seekToPts: (targetPts: Pts, options?: SeekOptions) => {
        const scrub = options?.scrub === true;
        if (!scrub) {
          scrubAudioController.stop();
        }

        const state = get();
        if (
          !attachedSource ||
          !attachedElement ||
          !state.isReady ||
          state.calibrationStatus !== "ready" ||
          calibratedMediaTime === null ||
          attachedSource.videoStartPts === null
        ) {
          queuedSeek = null;
          lastAcceptedSeek = null;
          lastScrubAudioTarget = null;
          playSessionId++;
          try {
            attachedElement?.pause();
          } catch {
            // Ignore DOM exception
          }
          set({ isPlaying: false, error: "seekFailed", seekTargetSeconds: null });
          return;
        }

        if (!isPtsString(targetPts)) {
          queuedSeek = null;
          lastAcceptedSeek = null;
          lastScrubAudioTarget = null;
          playSessionId++;
          try {
            attachedElement.pause();
          } catch {
            // Ignore DOM exception
          }
          set({ isPlaying: false, error: "seekFailed", seekTargetSeconds: null });
          return;
        }

        const targetMediaTime = ptsToMediaTime(
          targetPts,
          attachedSource.videoStartPts,
          calibratedMediaTime,
          attachedSource.videoTimeBase,
        );

        if (targetMediaTime === null) {
          queuedSeek = null;
          lastAcceptedSeek = null;
          lastScrubAudioTarget = null;
          playSessionId++;
          try {
            attachedElement.pause();
          } catch {
            // Ignore DOM exception
          }
          set({ isPlaying: false, error: "seekFailed", seekTargetSeconds: null });
          return;
        }

        const rawElapsed = ptsElapsedSeconds(
          targetPts,
          attachedSource.videoStartPts,
          attachedSource.videoTimeBase,
        );

        if (rawElapsed === null) {
          queuedSeek = null;
          lastAcceptedSeek = null;
          lastScrubAudioTarget = null;
          playSessionId++;
          try {
            attachedElement.pause();
          } catch {
            // Ignore DOM exception
          }
          set({ isPlaying: false, error: "seekFailed", seekTargetSeconds: null });
          return;
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

        const pending =
          queuedSeek ?? (lastAcceptedSeek?.scrub === true ? lastAcceptedSeek : null);
        const currentBrowserTime = pending?.mediaTime ?? attachedElement.currentTime;
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

        // The bounds are positions on the browser media timeline, the axis of currentTime, which
        // ADR 003 does not require to start at 0. The lower bound is the start of that timeline,
        // or the calibrated first frame when it lies later, because no frame precedes the one
        // videoStartPts names. A target below the start would never equal the position the next
        // press reads back, because the browser moves it to the start, so each press would seek
        // again.
        const lowerBound =
          calibratedOrigin === null
            ? browserTimelineOriginSeconds
            : Math.max(browserTimelineOriginSeconds, calibratedOrigin);
        // The probe prefers the duration of the video stream, which counts from the first video
        // frame, so the approximate duration goes on the lower bound. The element stops a seek at
        // its own duration, an end position that caps any overshoot of that sum and that can be
        // rounded to the clock of the web view. Clamp to it as seekApproximate does, so that the
        // element reports back exactly the clamp value and the edge check below fires on the
        // next step. When the stream duration is invalid, the probe falls back to the container
        // duration, which counts from the container start, so the sum can overshoot by the
        // distance from the origin to the first frame; the element duration caps that overshoot
        // when the element reports one. Without either duration there is no upper bound.
        const approximateDuration = attachedSource.approximateDurationSeconds;
        const approximateEnd =
          typeof approximateDuration === "number" &&
          Number.isFinite(approximateDuration) &&
          approximateDuration > 0
            ? lowerBound + approximateDuration
            : Number.POSITIVE_INFINITY;
        const upperBound =
          state.runtimeBrowserDurationSeconds === null
            ? approximateEnd
            : Math.min(approximateEnd, state.runtimeBrowserDurationSeconds);

        // The step starts from the start position moved into the bounds. A step forward from a
        // position before the calibrated first frame therefore reaches the frame after it, and
        // not the frame already on screen, which can produce no RVFC callback (ADR 022). Each
        // clamp applies the lower bound last, so a step never seeks before the start of the
        // media when bad metadata puts the upper bound below it.
        const stepStart = Math.max(
          Math.min(currentBrowserTime, upperBound),
          lowerBound,
        );

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
          calibratedOrigin !== null &&
          !hasVariableFrameRate(attachedSource) &&
          isFrameGridExact(fps, attachedSource.videoTimeBase)
            ? calibratedOrigin
            : null;
        let grid: {
          readonly startFrame: number;
          readonly targetFrame: number;
          readonly frameIndexAt: (browserTime: number) => number;
        } | null = null;
        let unclampedTarget: number;
        if (gridOrigin === null) {
          unclampedTarget = stepStart + (deltaFrames * fps.d) / fps.n;
        } else {
          // The frame boundary margin of the timecode (ADR 028), from the same rate and time
          // base, so the step and the timecode name the same frame for the same position. It is
          // one tick when the interval is not a whole number of ticks, so a frame start that the
          // container rounded early, also against a rounded first PTS, still counts as its own
          // frame. On an exact grid it is less than half an interval minus 1 us, so the middle
          // target of the step before never reads as the next frame.
          const marginSeconds = frameBoundaryMarginSeconds(
            fps,
            attachedSource.videoTimeBase,
          );
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
          const targetFrame = startFrame + deltaFrames;
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
          ((deltaFrames > 0 && targetTime < currentBrowserTime) ||
            (deltaFrames < 0 && targetTime > currentBrowserTime))
        ) {
          targetTime = currentBrowserTime;
        }

        // A step at the first or the last frame of the source cannot move it. Such a step does
        // nothing to the position. It dispatches no seek, keeps presentedFrame and
        // seekTargetSeconds, and requests no cue. A seek that lands on the frame already on
        // screen can produce no RVFC callback (ADR 022), so dispatching it would leave
        // presentedFrame null and the edit actions disabled, and each press would play the
        // ADR 019 cue again at the same position. Before the anchor is taken, it would also refuse
        // the calibration (ADR 003). ADR 021 makes each key press one step; at an edge there is
        // no frame to step to, so a press that does not move keeps that rule.
        //
        // Two tests find that step:
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
        // A pending scrub target does not count: fastSeek lands on a keyframe and not on its
        // target, so an exact seek is still required (ADR 022).
        if (
          pending?.scrub !== true &&
          (Math.abs(targetTime - currentBrowserTime) <
            NOMINAL_STEP_EDGE_TOLERANCE_SECONDS ||
            (grid !== null && grid.frameIndexAt(targetTime) === grid.startFrame))
        ) {
          // A frame step means that the user stops to look at frames (ADR 019, ADR 022), so an
          // edge press during playback still pauses, as the seek path does. pause stops the cue
          // and invalidates a pending play promise, and it does not touch presentedFrame.
          if (state.isPlaying) {
            get().pause();
          }
          return;
        }

        // seekNominal stays exact (it assigns currentTime through the helper with scrub false).
        // Its existing audio request stays unchanged (ADR 019, ADR 022).
        if (!dispatchSeek(attachedElement, targetTime, false)) {
          return;
        }

        if (calibratedMediaTime === null) {
          // The element left the position the anchor guard holds as its baseline before the
          // anchor was taken, so the next first callback cannot identify videoStartPts.
          seekedBeforeCalibration = true;
        }

        scrubAudioController.request(targetTime, deltaFrames > 0 ? 1 : -1);

        // Do not update inferred PTS optimistically after assigning currentTime.
        //
        // On the frame grid, the display target is the nominal start of the target frame, while
        // the element seeks to its middle. The presented frame then reports its real start, which
        // lies within one tick of that nominal start, so the playhead and the pending In region
        // do not move back when the frame arrives, and a held key moves them one frame for each
        // press (ADR 022). The timecode names the target frame from its nominal start (ADR 028).
        // A target that the end position pulled back shows the nominal start of the frame that
        // contains it, for the same reason. A target that the lower bound raised shows as it is.
        //
        // Off the grid, the target shows as it is. It counts from the calibrated first frame
        // while a calibration holds, the origin of the elapsed seconds of the presented frame and
        // of seekToPts, and from the start of the timeline, the origin of the approximate clock,
        // without one.
        let seekTargetSeconds: number;
        if (grid !== null && targetTime === unclampedTarget) {
          seekTargetSeconds = Math.max(0, (grid.targetFrame * fps.d) / fps.n);
        } else if (grid !== null && targetTime < unclampedTarget) {
          seekTargetSeconds = Math.max(
            0,
            (grid.frameIndexAt(targetTime) * fps.d) / fps.n,
          );
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
      },

      seekApproximate: (seconds: number, options?: SeekOptions) => {
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
        let target = seconds + browserTimelineOriginSeconds;
        if (state.runtimeBrowserDurationSeconds !== null) {
          target = Math.min(target, state.runtimeBrowserDurationSeconds);
        }
        if (!Number.isFinite(target) || target < 0) {
          return;
        }

        if (!dispatchSeek(attachedElement, target, scrub)) {
          return;
        }

        if (calibratedMediaTime === null) {
          // The element left the position the anchor guard holds as its baseline before the
          // anchor was taken, so the next first callback cannot identify videoStartPts.
          seekedBeforeCalibration = true;
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
              ...(settled
                ? { seekTargetSeconds: null }
                : retarget !== undefined
                  ? { seekTargetSeconds: retarget }
                  : {}),
            });
          }
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
          // becomes clickable as soon as metadata loads, so an approximate or nominal seek can
          // precede the anchor. Such a seek is recorded, because the browser moves currentTime
          // on its own when metadata loads and a position alone cannot separate the two.
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
            ...(settled ? { seekTargetSeconds: null } : {}),
          });
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
          ...(retarget !== undefined ? { seekTargetSeconds: retarget } : {}),
        });
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
        if (get().approximateBrowserTimeSeconds === next) {
          return;
        }
        set({ approximateBrowserTimeSeconds: next });
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
          get().calibrationStatus !== "ready" &&
          get().seekTargetSeconds !== null
        ) {
          // In non-ready calibration states, seeked clears the display target once settled,
          // but a scrub seek must not clear it because fastSeek lands on a keyframe (ADR 022).
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

        set({ isPlaying: true, error: null });
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
