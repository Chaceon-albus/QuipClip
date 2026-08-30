/**
 * Types and interfaces for the playback store and frame-stepping engine.
 *
 * See ADR 002, ADR 003, and ADR 007.
 */

import type { Rational } from "@/types/project";

/**
 * Minimal media descriptor required to model a playback source attachment.
 */
export interface PlaybackSource {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  readonly avgFrameRate: Rational;
  readonly frameCount: number;
}

/**
 * Minimal video control element interface required by the playback store.
 * Allows pure fake implementations in tests and HTMLVideoElement in the browser.
 */
export interface PlaybackMediaElement {
  play: () => Promise<void> | void;
  pause: () => void;
  currentTime: number;
  readyState?: number;
}

/**
 * Stable error codes for local playback and seek errors.
 */
export const PLAYBACK_ERROR_CODES = ["playbackFailed", "seekFailed"] as const;

export type PlaybackErrorCode = (typeof PLAYBACK_ERROR_CODES)[number];

/**
 * Serializable public state of the playback store.
 */
export interface PlaybackState {
  readonly currentFrame: number;
  readonly isPlaying: boolean;
  readonly isAttached: boolean;
  readonly isReady: boolean;
  readonly error: PlaybackErrorCode | null;
}

/**
 * Public actions exposed by the playback store.
 */
export interface PlaybackActions {
  /**
   * Attaches a media source and its corresponding DOM media element.
   * Starts in an unready state (isReady: false) unless the element is already ready.
   * Validates source frameCount and timebase before attaching.
   */
  attach: (source: PlaybackSource, element: PlaybackMediaElement) => void;

  /**
   * Detaches the media element for a matching source identity and element.
   * Guarded so a late detach from an old source or element does not detach a newer active source.
   */
  detach: (sourceIdentity: string, element: PlaybackMediaElement) => void;

  /**
   * Marks the media element ready once metadata has loaded for the matching source and element.
   */
  syncReady: (sourceIdentity: string, element: PlaybackMediaElement) => void;

  /**
   * Marks the media element unready on decode error or readiness loss.
   * Invalidates any pending play sessions.
   */
  syncUnready: (sourceIdentity: string, element: PlaybackMediaElement) => void;

  /**
   * Toggles playback. Synchronously invokes video.play() to preserve user activation.
   * Catches async promise rejection to set a localized error code.
   */
  togglePlayback: () => void;

  /**
   * Explicitly starts playback. Synchronously calls video.play().
   */
  play: () => void;

  /**
   * Explicitly pauses playback.
   */
  pause: () => void;

  /**
   * Steps playback forward or backward by a safe integer frame delta.
   * Invalidates pending play sessions, pauses unconditionally, clamps target safely,
   * sets currentTime to midpoint, updates currentFrame, and clears previous errors.
   */
  stepFrames: (delta: number) => void;

  /**
   * Seeks directly to an absolute safe integer frame index.
   * Invalidates pending play sessions, pauses unconditionally, clamps target safely,
   * sets currentTime to midpoint, updates currentFrame, and clears previous errors.
   */
  seekToFrame: (targetFrame: number) => void;

  /**
   * Synchronizes the confirmed painted frame from RVFC or fallback readback.
   * Stale readbacks from non-matching source identities or mismatched elements are ignored.
   */
  syncRenderedFrame: (
    sourceIdentity: string,
    frame: number,
    element: PlaybackMediaElement,
  ) => void;

  /**
   * Synchronizes play state when the matching video element emits an onPlay event.
   */
  syncPlay: (sourceIdentity: string, element: PlaybackMediaElement) => void;

  /**
   * Synchronizes pause state when the matching video element emits an onPause event.
   */
  syncPause: (sourceIdentity: string, element: PlaybackMediaElement) => void;

  /**
   * Synchronizes state when playback reaches the end of media (onEnded event).
   */
  syncEnded: (sourceIdentity: string, element: PlaybackMediaElement) => void;

  /**
   * Resets playback state and detaches any active media source and element.
   */
  reset: () => void;
}

/**
 * Combined type of playback store state and actions.
 */
export type PlaybackStoreState = PlaybackState & PlaybackActions;
