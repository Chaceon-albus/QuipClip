/**
 * Types and interfaces for the playback store, PTS calibration, and RVFC presentation engine.
 *
 * See ADR 002, ADR 003, and ADR 007.
 */

import type { FrameCount, Pts, Rational, TickCount } from "@/types/project";

/**
 * Timing and revision descriptor required to model a playback source attachment.
 */
export interface PlaybackSource {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  readonly videoTimeBase: Rational;
  readonly videoStartPts: Pts | null;
  readonly videoDurationTicks?: TickCount | null;
  readonly approximateDurationSeconds?: number | null;
  readonly avgFrameRate?: Rational | null;
  readonly rFrameRate?: Rational | null;
  readonly reportedFrameCount?: FrameCount | null;
}

/**
 * Minimal video control element interface required by the playback store.
 * Allows pure fake implementations in tests and HTMLVideoElement in the browser.
 */
export interface PlaybackMediaElement {
  play: () => Promise<void> | void;
  pause: () => void;
  currentTime: number;
  duration?: number;
  readyState?: number;
  seeking?: boolean;
}

/**
 * Status of the first-presented-frame PTS calibration.
 *
 * - "calibrating": Awaiting first RVFC callback to associate with videoStartPts.
 * - "ready": Calibrated linear mapping active; inferred source PTS available.
 * - "unavailable": Missing RVFC, missing videoStartPts, invalid metadata, duplicate PTS, or unsafe calculation.
 */
export type CalibrationStatus = "calibrating" | "ready" | "unavailable";

/**
 * Frame presentation fact reported by requestVideoFrameCallback and inferred source PTS.
 */
export interface PresentedFrame {
  /** mediaTime in seconds reported by requestVideoFrameCallback. */
  readonly mediaTime: number;
  /** Inferred presentation timestamp in source video stream time base. */
  readonly inferredSourcePts: Pts;
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
  /** Last confirmed presented frame from RVFC with inferred source PTS, or null. */
  readonly presentedFrame: PresentedFrame | null;
  /** Calibration status of the active source. */
  readonly calibrationStatus: CalibrationStatus;
  /** Finite browser-reported duration used only for runtime layout and approximate seeking. */
  readonly runtimeBrowserDurationSeconds: number | null;
  /**
   * Finite non-negative `HTMLMediaElement.currentTime` of the attached element, on the browser
   * media timeline, or null while no element reports a usable position.
   *
   * This is a presentation clock, never an edit position, and it must never become project
   * state: ADR 003 permits browser `currentTime` to drive an approximate clock and denies it
   * an edit point. `canMarkIn`, `canMarkOut`, and `canSplitCurrentSegment` are the three
   * predicates that keep it out. Each requires `calibrationStatus === "ready"` and reads its
   * PTS from `presentedFrame`, so none of them can reach this field.
   */
  readonly approximateBrowserTimeSeconds: number | null;
  /**
   * Seconds elapsed from the start of the source (the ruler axis, the same axis as
   * approximateBrowserTimeSeconds) of the last accepted seek request; display only; never
   * an edit position; canMarkIn/canMarkOut/canSplitCurrentSegment never read it (ADR 003, ADR 022).
   * Null when no seek is pending.
   */
  readonly seekTargetSeconds: number | null;
  /** True when video is currently playing. */
  readonly isPlaying: boolean;
  /** True when a media element is attached. */
  readonly isAttached: boolean;
  /**
   * Revision key of the source the store is attached to, or null when nothing is attached.
   *
   * A component cannot infer this from `isAttached`: the render that first carries a new
   * source still sees the previous source's store state, so a boolean is stale exactly when
   * it matters (ADR 019).
   */
  readonly attachedSourceRevisionKey: string | null;
  /** True when the attached element has loaded metadata (readyState >= HAVE_METADATA). */
  readonly isReady: boolean;
  /** Local playback or seek error code, or null. */
  readonly error: PlaybackErrorCode | null;
}

/**
 * Public actions exposed by the playback store.
 */
export interface PlaybackActions {
  /**
   * Attaches a media source and its corresponding DOM media element.
   * Prepares first-presented-frame calibration without using seekable.start(0).
   */
  attach: (source: PlaybackSource, element: PlaybackMediaElement) => void;

  /**
   * Detaches the media element for a matching source identity and element.
   * Guarded so a late detach from an old source or element does not detach a newer active source.
   */
  detach: (sourceRevisionKey: string, element: PlaybackMediaElement) => void;

  /**
   * Marks the media element ready once metadata has loaded for the matching source and element.
   */
  syncReady: (sourceRevisionKey: string, element: PlaybackMediaElement) => void;

  /**
   * Marks the media element unready on decode error or readiness loss.
   * Invalidates any pending play sessions.
   */
  syncUnready: (sourceRevisionKey: string, element: PlaybackMediaElement) => void;

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
   * Seeks to a target PTS in source video time base using checked inverse calibrated mapping.
   * Does not update inferred PTS optimistically after setting currentTime; waits for RVFC.
   */
  seekToPts: (targetPts: Pts) => void;

  /**
   * Seeks by a nominal frame delta hint using valid avgFrameRate then rFrameRate.
   * Disabled when neither frame rate is valid.
   */
  seekNominal: (deltaFrames: number) => void;

  /** Requests a checked browser-time seek without creating a canonical edit position. */
  seekApproximate: (seconds: number) => void;

  /**
   * Synchronizes confirmed presented frame from requestVideoFrameCallback.
   * On first frame, calibrates mediaTime to videoStartPts.
   * On later frames, infers PTS via checked slope-one mapping.
   * Detects duplicate inferred PTS for distinct presented frames and marks calibration unavailable.
   */
  syncPresentedFrame: (
    sourceRevisionKey: string,
    mediaTime: number,
    presentedFrames: number | undefined,
    element: PlaybackMediaElement,
  ) => void;

  /**
   * Marks precise presentation mapping unavailable when RVFC is unsupported.
   * Playback and approximate browser timing remain available.
   */
  syncPresentationUnavailable: (
    sourceRevisionKey: string,
    element: PlaybackMediaElement,
  ) => void;

  /** Reads and stores a finite non-negative browser duration for the matching source. */
  syncBrowserDuration: (
    sourceRevisionKey: string,
    element: PlaybackMediaElement,
  ) => void;

  /**
   * Reads and stores the finite non-negative browser `currentTime` for the matching source.
   * Skips an identical write, because `timeupdate` also fires while the element is paused.
   */
  syncBrowserTime: (sourceRevisionKey: string, element: PlaybackMediaElement) => void;

  /**
   * Synchronizes state when the matching video element finishes a seek (onSeeked event).
   * Dispatches the next queued seek if one is pending, or clears the display target when
   * not in the ready state (ADR 022).
   */
  syncSeeked: (sourceRevisionKey: string, element: PlaybackMediaElement) => void;

  /**
   * Synchronizes play state when the matching video element emits an onPlay event.
   */
  syncPlay: (sourceRevisionKey: string, element: PlaybackMediaElement) => void;

  /**
   * Synchronizes pause state when the matching video element emits an onPause event.
   */
  syncPause: (sourceRevisionKey: string, element: PlaybackMediaElement) => void;

  /**
   * Synchronizes state when playback reaches the end of media (onEnded event).
   */
  syncEnded: (sourceRevisionKey: string, element: PlaybackMediaElement) => void;

  /**
   * Resets playback state and detaches any active media source and element.
   */
  reset: () => void;
}

/**
 * Combined type of playback store state and actions.
 */
export type PlaybackStoreState = PlaybackState & PlaybackActions;
