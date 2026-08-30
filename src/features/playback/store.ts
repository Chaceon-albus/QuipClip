/**
 * Playback store managing active media element attachment, readiness lifecycle,
 * synchronous playback, frame stepping, and seek error state.
 *
 * Implements ADR-003 midpoint frame seek math and strict source-element concurrency guards.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { getMediaSourceIdentity } from "@/features/media";
import { midpointSecondsAtFrame } from "@/lib/time";
import type {
  PlaybackMediaElement,
  PlaybackSource,
  PlaybackState,
  PlaybackStoreState,
} from "./types";

/**
 * Clamps an integer or BigInt frame target to the valid frame range [0, frameCount - 1].
 * Uses BigInt internally to prevent floating-point overflow when target is near Number.MAX_SAFE_INTEGER.
 * If frameCount <= 0 or not a safe integer, returns 0.
 */
export function clampFrameIndex(target: number | bigint, frameCount: number): number {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    return 0;
  }

  const maxFrameBig = BigInt(frameCount - 1);
  const targetBig = typeof target === "bigint" ? target : BigInt(target);

  if (targetBig < 0n) {
    return 0;
  }
  if (targetBig > maxFrameBig) {
    return frameCount - 1;
  }
  return Number(targetBig);
}

/**
 * Factory function creating a vanilla Zustand store instance for playback state.
 *
 * The attached HTMLVideoElement/PlaybackMediaElement and active PlaybackSource are kept
 * strictly in the store factory closure to ensure that the public state remains fully serializable.
 *
 * @param initialState Optional initial state overrides for testing.
 */
export function createPlaybackStore(
  initialState?: Partial<PlaybackState>,
): StoreApi<PlaybackStoreState> {
  let attachedSource: PlaybackSource | null = null;
  let attachedElement: PlaybackMediaElement | null = null;
  let activeSourceIdentity: string | null = null;
  let playSessionId = 0;

  return createStore<PlaybackStoreState>()((set, get) => ({
    currentFrame: initialState?.currentFrame ?? 0,
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

      // 2. Validate source frameCount and timebase
      if (
        !Number.isSafeInteger(source.frameCount) ||
        source.frameCount < 0 ||
        !source.avgFrameRate ||
        !Number.isSafeInteger(source.avgFrameRate.n) ||
        source.avgFrameRate.n <= 0 ||
        !Number.isSafeInteger(source.avgFrameRate.d) ||
        source.avgFrameRate.d <= 0
      ) {
        return;
      }

      const newIdentity = getMediaSourceIdentity(source);
      const isElementReady =
        typeof element.readyState === "number" &&
        (typeof HTMLMediaElement !== "undefined"
          ? element.readyState >= HTMLMediaElement.HAVE_METADATA
          : element.readyState >= 1);

      if (attachedElement === element && activeSourceIdentity === newIdentity) {
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
      const isIdentityChanging = activeSourceIdentity !== newIdentity;
      activeSourceIdentity = newIdentity;
      attachedSource = source;
      attachedElement = element;

      if (isIdentityChanging) {
        set({
          currentFrame: 0,
          isPlaying: false,
          isAttached: true,
          isReady: isElementReady,
          error: null,
        });
      } else {
        set({
          isPlaying: false,
          isAttached: true,
          isReady: isElementReady,
          error: null,
        });
      }
    },

    detach: (sourceIdentity: string, element: PlaybackMediaElement) => {
      if (!attachedSource || !attachedElement || !element) {
        return;
      }

      const currentIdentity = getMediaSourceIdentity(attachedSource);
      if (sourceIdentity !== currentIdentity) {
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

      set({
        isPlaying: false,
        isAttached: false,
        isReady: false,
      });
    },

    syncReady: (sourceIdentity: string, element: PlaybackMediaElement) => {
      if (!attachedSource || !attachedElement) {
        return;
      }

      if (getMediaSourceIdentity(attachedSource) !== sourceIdentity) {
        return;
      }

      if (attachedElement !== element) {
        return;
      }

      set({ isReady: true });
    },

    syncUnready: (sourceIdentity: string, element: PlaybackMediaElement) => {
      if (!attachedSource || !attachedElement) {
        return;
      }

      if (getMediaSourceIdentity(attachedSource) !== sourceIdentity) {
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
      if (
        !attachedSource ||
        !attachedElement ||
        !state.isReady ||
        attachedSource.frameCount <= 0
      ) {
        return;
      }

      const currentSession = ++playSessionId;
      const currentIdentity = getMediaSourceIdentity(attachedSource);
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
          getMediaSourceIdentity(attachedSource) === currentIdentity &&
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
              getMediaSourceIdentity(attachedSource) === currentIdentity &&
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
              getMediaSourceIdentity(attachedSource) === currentIdentity &&
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

    stepFrames: (delta: number) => {
      if (typeof delta !== "number" || !Number.isSafeInteger(delta)) {
        return;
      }

      const state = get();
      if (
        !attachedSource ||
        !attachedElement ||
        !state.isReady ||
        attachedSource.frameCount <= 0
      ) {
        return;
      }

      playSessionId++;
      try {
        attachedElement.pause();
      } catch {
        // Ignore DOM exception
      }

      const current = get().currentFrame;
      const targetBig = BigInt(current) + BigInt(delta);
      const target = clampFrameIndex(targetBig, attachedSource.frameCount);
      const midpoint = midpointSecondsAtFrame(target, attachedSource.avgFrameRate);

      try {
        attachedElement.currentTime = midpoint;
      } catch {
        set({
          isPlaying: false,
          error: "seekFailed",
        });
        return;
      }

      set({
        currentFrame: target,
        isPlaying: false,
        error: null,
      });
    },

    seekToFrame: (targetFrame: number) => {
      if (typeof targetFrame !== "number" || !Number.isSafeInteger(targetFrame)) {
        return;
      }

      const state = get();
      if (
        !attachedSource ||
        !attachedElement ||
        !state.isReady ||
        attachedSource.frameCount <= 0
      ) {
        return;
      }

      playSessionId++;
      try {
        attachedElement.pause();
      } catch {
        // Ignore DOM exception
      }

      const target = clampFrameIndex(targetFrame, attachedSource.frameCount);
      const midpoint = midpointSecondsAtFrame(target, attachedSource.avgFrameRate);

      try {
        attachedElement.currentTime = midpoint;
      } catch {
        set({
          isPlaying: false,
          error: "seekFailed",
        });
        return;
      }

      set({
        currentFrame: target,
        isPlaying: false,
        error: null,
      });
    },

    syncRenderedFrame: (
      sourceIdentity: string,
      frame: number,
      element: PlaybackMediaElement,
    ) => {
      if (!attachedSource || !attachedElement) {
        return;
      }

      if (getMediaSourceIdentity(attachedSource) !== sourceIdentity) {
        return;
      }

      if (attachedElement !== element) {
        return;
      }

      if (typeof frame !== "number" || !Number.isSafeInteger(frame)) {
        return;
      }

      const clamped = clampFrameIndex(frame, attachedSource.frameCount);
      set({ currentFrame: clamped });
    },

    syncPlay: (sourceIdentity: string, element: PlaybackMediaElement) => {
      if (!attachedSource || !attachedElement) {
        return;
      }

      if (getMediaSourceIdentity(attachedSource) !== sourceIdentity) {
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

    syncPause: (sourceIdentity: string, element: PlaybackMediaElement) => {
      if (!attachedSource || !attachedElement) {
        return;
      }

      if (getMediaSourceIdentity(attachedSource) !== sourceIdentity) {
        return;
      }

      if (attachedElement !== element) {
        return;
      }

      playSessionId++;
      set({ isPlaying: false });
    },

    syncEnded: (sourceIdentity: string, element: PlaybackMediaElement) => {
      if (!attachedSource || !attachedElement) {
        return;
      }

      if (getMediaSourceIdentity(attachedSource) !== sourceIdentity) {
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
      activeSourceIdentity = null;

      set({
        currentFrame: 0,
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
