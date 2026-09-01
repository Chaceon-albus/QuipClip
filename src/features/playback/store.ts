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

  return createStore<PlaybackStoreState>()((set, get) => ({
    presentedFrame: initialState?.presentedFrame ?? null,
    calibrationStatus: initialState?.calibrationStatus ?? "unavailable",
    runtimeBrowserDurationSeconds: initialState?.runtimeBrowserDurationSeconds ?? null,
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

      const hasValidStartPts =
        source.videoStartPts !== null && isPtsString(source.videoStartPts);
      const initialCalibrationStatus: CalibrationStatus =
        hasValidStartPts && hasValidTimeBase ? "calibrating" : "unavailable";

      const newIdentity = getSourceRevisionKey(source);
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

      set({
        presentedFrame: null,
        calibrationStatus: initialCalibrationStatus,
        runtimeBrowserDurationSeconds: null,
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

      set({
        presentedFrame: null,
        calibrationStatus: "unavailable",
        runtimeBrowserDurationSeconds: null,
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

      let target = seconds;
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

      if (
        typeof mediaTime !== "number" ||
        !Number.isFinite(mediaTime) ||
        mediaTime < 0
      ) {
        calibratedMediaTime = null;
        lastPresentedMediaTime = null;
        lastInferredPts = null;
        set({ calibrationStatus: "unavailable", presentedFrame: null });
        return;
      }

      // If source does not have videoStartPts, precision is unavailable
      if (
        attachedSource.videoStartPts === null ||
        !isPtsString(attachedSource.videoStartPts) ||
        get().calibrationStatus === "unavailable"
      ) {
        set({ calibrationStatus: "unavailable", presentedFrame: null });
        return;
      }

      const isFirstCallback = calibratedMediaTime === null;

      if (isFirstCallback) {
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
        set({ calibrationStatus: "unavailable", presentedFrame: null });
        return;
      }

      const inferredPts = mediaTimeToPts(
        mediaTime,
        calibrationAnchor,
        attachedSource.videoStartPts,
        attachedSource.videoTimeBase,
      );

      if (inferredPts === null) {
        set({ calibrationStatus: "unavailable", presentedFrame: null });
        return;
      }

      // Detect duplicate inferred PTS on a distinct presented frame
      const isDistinctPresentation =
        lastPresentedMediaTime !== null && mediaTime !== lastPresentedMediaTime;

      if (isDistinctPresentation && inferredPts === lastInferredPts) {
        // Distinct RVFC presented frames inferred the same source PTS -> disable precision
        set({ calibrationStatus: "unavailable", presentedFrame: null });
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

      set({
        presentedFrame: null,
        calibrationStatus: "unavailable",
        runtimeBrowserDurationSeconds: null,
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
