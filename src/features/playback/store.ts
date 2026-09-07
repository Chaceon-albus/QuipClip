/**
 * Playback store managing active media element attachment, readiness lifecycle,
 * synchronous playback, PTS calibration, RVFC presentation, seekToPts, and nominal seek hints.
 *
 * Implements ADR 002, ADR 003, and ADR 007 with strict source-element concurrency guards.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { getSourceRevisionKey } from "@/features/media";
import {
  assertPositiveTimeBase,
  isPtsString,
  mediaTimeToPts,
  ptsToMediaTime,
} from "@/lib/time";
import type { Pts, Rational } from "@/types/project";
import type {
  CalibrationStatus,
  PlaybackMediaElement,
  PlaybackSource,
  PlaybackState,
  PlaybackStoreState,
} from "./types";

/**
 * Chooses valid avgFrameRate then rFrameRate for nominal navigation hints.
 * Returns null when neither frame rate is valid (ADR 003).
 */
export function getNominalFrameRate(source: PlaybackSource): Rational | null {
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

  return createStore<PlaybackStoreState>()((set, get) => ({
    presentedFrame: initialState?.presentedFrame ?? null,
    calibrationStatus: initialState?.calibrationStatus ?? "unavailable",
    runtimeBrowserDurationSeconds: initialState?.runtimeBrowserDurationSeconds ?? null,
    approximateBrowserTimeSeconds: initialState?.approximateBrowserTimeSeconds ?? null,
    isPlaying: initialState?.isPlaying ?? false,
    isAttached: initialState?.isAttached ?? false,
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
        typeof element.currentTime === "number" && Number.isFinite(element.currentTime)
          ? element.currentTime
          : null;
      attachedStartTime = startTime;
      anchorBaselineTime = startTime;
      // The position an element holds before its metadata loads does not report the start of
      // the media timeline, so the origin waits for syncReady.
      browserTimelineOriginSeconds = 0;
      seekedBeforeCalibration = false;

      set({
        presentedFrame: null,
        calibrationStatus: initialCalibrationStatus,
        runtimeBrowserDurationSeconds: null,
        approximateBrowserTimeSeconds: null,
        isPlaying: false,
        isAttached: true,
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

      set({
        presentedFrame: null,
        calibrationStatus: "unavailable",
        runtimeBrowserDurationSeconds: null,
        approximateBrowserTimeSeconds: null,
        isPlaying: false,
        isAttached: false,
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

      playSessionId++;
      try {
        attachedElement.pause();
      } catch {
        // Ignore DOM exception
      }

      set({
        isReady: false,
        isPlaying: false,
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

      const currentSession = ++playSessionId;
      const currentIdentity = getSourceRevisionKey(attachedSource);
      const targetElement = attachedElement;

      // Optimistically update playing state and clear previous error
      set({ isPlaying: true, error: null });

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

    seekToPts: (targetPts: Pts) => {
      const state = get();
      if (
        !attachedSource ||
        !attachedElement ||
        !state.isReady ||
        state.calibrationStatus !== "ready" ||
        calibratedMediaTime === null ||
        attachedSource.videoStartPts === null
      ) {
        playSessionId++;
        try {
          attachedElement?.pause();
        } catch {
          // Ignore DOM exception
        }
        set({ isPlaying: false, error: "seekFailed" });
        return;
      }

      if (!isPtsString(targetPts)) {
        playSessionId++;
        try {
          attachedElement.pause();
        } catch {
          // Ignore DOM exception
        }
        set({ isPlaying: false, error: "seekFailed" });
        return;
      }

      const targetMediaTime = ptsToMediaTime(
        targetPts,
        attachedSource.videoStartPts,
        calibratedMediaTime,
        attachedSource.videoTimeBase,
      );

      if (targetMediaTime === null) {
        playSessionId++;
        try {
          attachedElement.pause();
        } catch {
          // Ignore DOM exception
        }
        set({ isPlaying: false, error: "seekFailed" });
        return;
      }

      playSessionId++;
      try {
        attachedElement.pause();
      } catch {
        // Ignore DOM exception
      }

      try {
        attachedElement.currentTime = targetMediaTime;
      } catch {
        set({
          isPlaying: false,
          error: "seekFailed",
        });
        return;
      }

      // Do not update inferred PTS optimistically after assigning currentTime.
      // Inferred PTS will update when RVFC fires for the newly presented frame.
      set({
        isPlaying: false,
        error: null,
        presentedFrame: null,
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

      const deltaSeconds = (deltaFrames * fps.d) / fps.n;
      if (!Number.isFinite(deltaSeconds)) {
        return;
      }

      const currentBrowserTime = attachedElement.currentTime;
      if (
        typeof currentBrowserTime !== "number" ||
        !Number.isFinite(currentBrowserTime)
      ) {
        return;
      }

      let targetTime = currentBrowserTime + deltaSeconds;
      if (targetTime < 0) {
        targetTime = 0;
      }
      if (
        typeof attachedSource.approximateDurationSeconds === "number" &&
        Number.isFinite(attachedSource.approximateDurationSeconds) &&
        attachedSource.approximateDurationSeconds > 0
      ) {
        targetTime = Math.min(targetTime, attachedSource.approximateDurationSeconds);
      }

      playSessionId++;
      try {
        attachedElement.pause();
      } catch {
        // Ignore DOM exception
      }

      try {
        attachedElement.currentTime = targetTime;
      } catch {
        set({
          isPlaying: false,
          error: "seekFailed",
        });
        return;
      }

      if (calibratedMediaTime === null) {
        // The element left the position the anchor guard holds as its baseline before the
        // anchor was taken, so the next first callback cannot identify videoStartPts.
        seekedBeforeCalibration = true;
      }

      // Do not update inferred PTS optimistically after assigning currentTime.
      set({
        isPlaying: false,
        error: null,
        presentedFrame: null,
      });
    },

    seekApproximate: (seconds: number) => {
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

      playSessionId++;
      try {
        attachedElement.pause();
        attachedElement.currentTime = target;
      } catch {
        set({ isPlaying: false, error: "seekFailed", presentedFrame: null });
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
      set({ isPlaying: false, error: null, presentedFrame: null });
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

      // Write the unavailable state only when it is not already the state. RVFC fires for every
      // presented frame, and an unchanged partial still allocates a state and notifies everyone.
      const markUnavailable = () => {
        const state = get();
        if (
          state.calibrationStatus !== "unavailable" ||
          state.presentedFrame !== null
        ) {
          set({ calibrationStatus: "unavailable", presentedFrame: null });
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
        });
        return;
      }

      // Subsequent frame presentation
      if (get().calibrationStatus !== "ready") {
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

      calibratedMediaTime = null;
      lastPresentedMediaTime = null;
      lastInferredPts = null;
      set({ calibrationStatus: "unavailable", presentedFrame: null });
    },

    syncBrowserDuration: (sourceRevisionKey: string, element: PlaybackMediaElement) => {
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

    reset: () => {
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
      // precisionDeniedSources is kept: ADR 003 denies precise editing for the source, and a
      // source keeps the same revision key until the file on disk changes.

      set({
        presentedFrame: null,
        calibrationStatus: "unavailable",
        runtimeBrowserDurationSeconds: null,
        approximateBrowserTimeSeconds: null,
        isPlaying: false,
        isAttached: false,
        isReady: false,
        error: null,
      });
    },
  }));
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
