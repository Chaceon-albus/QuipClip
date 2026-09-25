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
  /**
   * `HTMLMediaElement.paused`. The stop of a segment playback reads it at a `pause` event, to
   * tell a pause that still holds from the late `pause` event of a seek that play followed. It
   * also reads it in a frame callback in the "stopped" phase: an element that plays again was
   * started from outside the store, before its `play` event ran.
   */
  paused?: boolean;
  /**
   * `HTMLMediaElement.ended`. The element sends `pause` before `ended` when it reaches its end,
   * and the stop of a segment playback reads the end at the first of the two.
   */
  ended?: boolean;
}

/**
 * The stop point of a segment playback (Play Segment, ADR 026): the store plays the half-open
 * segment `[inPts, outPts)` (ADR 002) and stops on its last frame, the frame before `outPts`.
 *
 * - `playing`: the playback runs toward the stop. Each presented frame is tested against it.
 * - `stopped`: the store stopped the playback with a pause alone, on the frame at `restPts`. A
 *   settled frame that the browser presents after that pause is tested once more:
 *   - The frame of the stop shown again keeps the stop: on the frame grid a frame with the index
 *     of the last frame, and off the grid a frame that starts at or after `restPts` and before
 *     the Out. After an early prediction off the grid, such a later frame lies in the segment at
 *     or before the real last frame.
 *   - A frame after the last frame and at or before the end of the seek-back window,
 *     `windowEndSeconds`, gets one seek back to the last frame, and the stop point goes. The
 *     browser presents such a frame from a position that the element reached before the pause
 *     took effect.
 *   - Any other frame comes from a seek that the store did not make, and the stop point goes
 *     with no seek. That includes a frame past the window and a frame before the stop.
 *
 *   A seek that starts in this phase comes from outside the store and clears the stop point
 *   (syncSeeking), and so does a frame callback that finds the element playing again.
 *
 * It is display and transport state only. It never enters the project, and no edit reads it.
 */
export type PlaybackStop =
  | {
      readonly phase: "playing";
      readonly inPts: Pts;
      readonly outPts: Pts;
    }
  | {
      readonly phase: "stopped";
      readonly inPts: Pts;
      readonly outPts: Pts;
      /** The PTS of the frame on screen when the store paused. */
      readonly restPts: Pts;
      /**
       * The end of the seek-back window, in seconds from `videoStartPts`: the Out plus 0.1 s, or
       * plus one nominal interval when that is longer. When the element paused after the Out and
       * that is later, it is the position where the element paused plus the same distance. Null
       * when the Out has no safe elapsed time, and there is no window.
       */
      readonly windowEndSeconds: number | null;
    };

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
   * the same call runs after the anchor. End passes it when it seeks on the approximate clock,
   * on a source whose probe gives no extent in ticks (ADR 026), so End goes to the same place
   * before and after the anchor, and a second End finds the element at the end.
   */
  readonly keepBrowserTimeline?: boolean;
  /**
   * For `seekToPts` only. The target is the last tick of the source extent, the seek of End off
   * the frame grid (ADR 026). The seek then does nothing when the element already stands at or
   * after the position that the seek can reach, the calibration is ready, a frame is on screen,
   * no seek is pending and the element does not play: the frame on screen then holds the last
   * tick, and a seek to it may bring no frame callback (ADR 022). The position that the seek can
   * reach is the media time of the target, or the duration that the element reports when that
   * is earlier, because the element stops a seek at its duration. Both compare within
   * NOMINAL_STEP_EDGE_TOLERANCE_SECONDS. Off the grid no frame boundary tells the caller which
   * frame holds that tick, so only the position of the element, which the store alone knows on
   * the calibrated axis, can find it. A seek that the store defers during calibration runs
   * without the option: at the anchor the element stands at the first frame.
   */
  readonly extentEnd?: boolean;
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
  /**
   * The stop point of a segment playback (`playSegment`), or null when playback has no stop
   * point. These clear it:
   *
   * - every other transport action, every seek that the store makes (a click, a scrub, a trim,
   *   a step, Home, End, Go to In, Go to Out, a typed timecode), a source change, a loss of
   *   readiness or of the calibration, and a failed play;
   * - a pause that the element makes on its own in the "playing" phase, and a play that it makes
   *   on its own in the "stopped" phase;
   * - the end of the media in the "playing" phase;
   * - the seek back of the stop itself, from a frame past the last frame or from the backstop,
   *   and the pause of the backstop when the segment ends with the video;
   * - a seek that starts in the "stopped" phase, which comes from outside the store. A seek from
   *   outside the store while the segment plays, in the "playing" phase, does not clear it: the
   *   store cannot tell its `seeking` event from the late one of the seek to the In. A frame past
   *   the last frame that such a seek shows is then pulled back to the last frame;
   * - in the "stopped" phase, a frame callback that finds the element playing again;
   * - in the "stopped" phase, a settled frame that is neither a frame of the stop nor in the
   *   seek-back window: a frame past the window, or a frame before the stop (see PlaybackStop).
   *
   * A playback that the user starts later therefore plays with no stop point. It is not a
   * display target: the playhead and the timecode never read it (ADR 022).
   */
  readonly playbackStop: PlaybackStop | null;
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
   * Plays the half-open segment `[inPts, outPts)` of the attached source and stops on its last
   * frame, the frame before `outPts` (Play Segment, ADR 026). It seeks to `inPts` with
   * `seekToPts`, plays as `play` does, so the sound and the mute preference are those of normal
   * playback and no cue sounds (ADR 019), and it sets `playbackStop`.
   *
   * The stop reads the presented frames (ADR 003). On the frame grid (hasExactFrameGrid) the
   * last frame is known by its index, and the store pauses on it. Off the grid the store pauses
   * with no seek on the frame at the last tick before the Out, or on the frame that the Out lies
   * less than one and a half nominal intervals after. A presented frame past the last frame
   * seeks back to the last frame: on the grid by its index, and off the grid to the last tick
   * before the Out. After the pause, a later frame seeks back only while it lies in the seek-back
   * window, and a frame past the window clears the stop with no seek. Off the grid, a later frame
   * that still starts before the Out keeps the stop (see PlaybackStop). The element `ended` event
   * ends the playback at the end of the media, and a `timeupdate` far past the Out stops a
   * playback that presents no frames, as a hidden window does.
   *
   * It needs an attached, ready element, a ready calibration, and a segment that holds a frame
   * (canPlaySegment): on the frame grid, a last frame at or after the frame of the In. Otherwise
   * it does nothing. When the seek to `inPts` fails, it does not play.
   */
  playSegment: (inPts: Pts, outPts: Pts) => void;

  /**
   * Seeks to a target PTS in source video time base using checked inverse calibrated mapping.
   * Does not update inferred PTS optimistically after setting currentTime; waits for RVFC.
   * Accepts optional SeekOptions for playhead scrubbing (ADR 022).
   * While the calibration is "calibrating", the request is deferred and not refused: it runs
   * on the calibrated mapping when the calibration is ready, and at its elapsed seconds on the
   * approximate clock when the calibration is unavailable.
   * With `extentEnd`, a seek from the end of the extent, where the frame on screen already holds
   * the target, does nothing (see SeekOptions).
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
   * Synchronizes state when the matching video element starts a seek (onSeeking event).
   * In the "stopped" phase of a segment playback it clears the stop point (ADR 026): every seek
   * that the store makes clears the stop point first, so a seek that starts in that phase comes
   * from outside the store, such as the media controls of the system. It changes nothing else.
   */
  syncSeeking: (sourceRevisionKey: string, element: PlaybackMediaElement) => void;

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
