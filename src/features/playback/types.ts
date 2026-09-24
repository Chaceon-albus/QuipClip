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
  fastSeek?: (time: number) => void;
  duration?: number;
  readyState?: number;
  seeking?: boolean;
}

/**
 * Options for seek actions (ADR 022).
 *
 * `scrub`: true for each sample of a playhead drag; false or absent for a click
 * and for the final seek of a drag.
 */
export interface SeekOptions {
  readonly scrub?: boolean;
  /**
   * For `seekApproximate` only. A seek that the store defers during calibration runs on the
   * calibrated mapping once the calibration is ready, because the ruler of a calibrated source
   * seeks there (ADR 022). With this option it runs on the browser media timeline instead, as
   * the same call runs after the anchor. End passes it (ADR 026), so End goes to the same place
   * before and after the anchor, and a second End finds the element at the end.
   */
  readonly keepBrowserTimeline?: boolean;
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
   * A request deferred during calibration counts as accepted, so the field shows its target.
   * Null when no seek is pending.
   */
  readonly seekTargetSeconds: number | null;
  /**
   * True while a navigation request waits for the calibration anchor (ADR 022). It is only
   * true while `calibrationStatus` is "calibrating". The preview bounds that wait while it is
   * true, and only then, so a source that nobody navigates keeps waiting for its first frame.
   */
  readonly hasDeferredNavigation: boolean;
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
   * Drops a navigation deferred during calibration and plays from where the element stands,
   * because a seek before the calibration anchor would refuse the calibration (ADR 003).
   */
  play: () => void;

  /**
   * Explicitly pauses playback.
   */
  pause: () => void;

  /**
   * Seeks to a target PTS in source video time base using checked inverse calibrated mapping.
   * Does not update inferred PTS optimistically after setting currentTime; waits for RVFC.
   * Accepts optional SeekOptions for playhead scrubbing (ADR 022).
   * While the calibration is "calibrating", the request is deferred and not refused: it runs
   * on the calibrated mapping when the calibration is ready, and at its elapsed seconds on the
   * approximate clock when the calibration is unavailable.
   */
  seekToPts: (targetPts: Pts, options?: SeekOptions) => void;

  /**
   * Seeks by a nominal frame delta hint using valid avgFrameRate then rFrameRate.
   * Disabled when neither frame rate is valid.
   * Clamps the start position and the target on the browser media timeline, from its origin (or
   * the calibrated first frame when that lies later) to the end of the source, and never moves
   * against the step.
   * Does nothing when the clamped target equals the position the step starts from, which is
   * the case at the first and the last position of the source. Such a step still pauses
   * playback. A pending scrub target at the edge still gets one exact seek, because fastSeek
   * lands on a keyframe and not on its target (ADR 022).
   * While the calibration is "calibrating", the step is deferred. Deferred steps add up, one
   * frame for each press (ADR 021), and run as one step when the calibration settles. That step
   * requests the cue once, but the scrub audio element mounts only after the calibration leaves
   * "calibrating", so the controller has no element then and the step makes no sound (ADR 019).
   */
  seekNominal: (deltaFrames: number) => void;

  /**
   * Goes to nominal frame `frameIndex` of the frame grid, counted from the calibrated first frame
   * (ADR 022, ADR 028). A typed frame timecode uses it.
   *
   * It runs the frame step of seekNominal with an absolute target frame: the element seeks to
   * the middle of the frame, the display target is its nominal start, the clamps and the edge
   * rule apply, and a target that is the frame the step would start from (the frame on screen,
   * or the frame of a pending exact seek) does nothing. During playback it only pauses while the
   * element is still inside that frame, and it seeks back to the frame once the element has left
   * it. It is a jump, not a step, so it stops the cue and requests none (ADR 019).
   *
   * It acts only where the grid applies: a nominal rate, a constant rate and an exact grid
   * (hasExactFrameGrid), and a ready calibration. While the calibration is "calibrating", the
   * request is deferred as a seek to the first frame followed by `frameIndex` steps, so it runs on
   * the grid at the anchor (ADR 022). It then runs as that one step, which requests the cue once,
   * as every deferred step does, and no scrub audio element is mounted yet to sound it (ADR 019).
   * Elsewhere, and for an index that is not a non-negative safe integer, it does nothing: off the
   * grid the caller seeks by time (`planTimecodeEntrySeek`).
   */
  seekToFrameIndex: (frameIndex: number) => void;

  /**
   * Requests a checked browser-time seek without creating a canonical edit position.
   * Accepts optional SeekOptions for playhead scrubbing (ADR 022).
   * While the calibration is "calibrating", the seek is deferred and replaces any earlier
   * deferred request. It runs when the calibration settles: on the calibrated mapping when the
   * calibration is ready, unless `keepBrowserTimeline` is set, and on the approximate clock
   * when it is unavailable.
   */
  seekApproximate: (seconds: number, options?: SeekOptions) => void;

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
   * Marks precise presentation mapping unavailable when RVFC is unsupported, or when the
   * preview stops waiting for the first presented frame of a visible element while a
   * navigation is deferred (the bounded wait for the anchor). Playback and approximate browser
   * timing remain available. The deferred navigation then runs on the approximate path.
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
   * Clears the playback or seek error, for the preview notice that shows it. Changes nothing
   * else, and does nothing when no error is set.
   *
   * With a code, it clears the error only while the store still holds that code. A notice
   * passes the code it shows, so its timer cannot clear a newer error that has not rendered.
   */
  dismissError: (code?: PlaybackErrorCode) => void;

  /**
   * Resets playback state and detaches any active media source and element.
   */
  reset: () => void;
}

/**
 * Combined type of playback store state and actions.
 */
export type PlaybackStoreState = PlaybackState & PlaybackActions;
