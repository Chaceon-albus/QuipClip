/**
 * Types and interfaces for the playback store, PTS calibration, and RVFC presentation engine.
 *
 * See ADR 002, ADR 003, and ADR 007.
 */

import type { FrameCount, Pts, Rational, TickCount } from "@/types/project";
import type { FrameTable } from "./frameTable";

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
  /**
   * True when the element plays the source through a MediaSource fed with remux windows (ADR
   * 046). A seek outside the buffered data then waits for a window.
   */
  readonly mediaSource?: boolean;
  /**
   * The media time of `videoStartPts`, when the mapping is known before the first frame. The
   * remux windows of a MediaSource source keep the absolute source timestamps and the page sets
   * `timestampOffset`, so this media time is known by construction, and the store takes the
   * anchor of ADR 003 from it instead of from the first frame callback (ADR 046).
   */
  readonly anchorMediaTime?: number | null;
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
   * started from outside the store, before its `play` event ran. syncPause reads it to keep the
   * playback state at the late `pause` event of a pause that a play followed, and a seek with
   * `keepPlaying` reads it to pause an element that already paused on its own (SeekOptions).
   * In the "playing" phase, the frame test and the clock test of the stop do nothing for an
   * element that reports `paused` and is not at its end (isAtMediaEnd, ADR 074).
   */
  paused?: boolean;
  /**
   * `HTMLMediaElement.ended`. The element sends `pause` before `ended` when it reaches its end,
   * and the stop of a segment playback reads the end at the first of the two. The element is at
   * its end only when it reports `ended` and reports no seek (isAtMediaEnd, ADR 074): WebKit
   * reports `ended` from the target of a pending seek. The preview drops an `ended` event of an
   * element that is not at its end.
   */
  ended?: boolean;
  /**
   * `HTMLMediaElement.buffered`. For a MediaSource source a seek outside these ranges waits for
   * a remux window, and a newer request does not wait behind it (ADR 046).
   */
  buffered?: {
    readonly length: number;
    start: (index: number) => number;
    end: (index: number) => number;
  };
  /**
   * `HTMLMediaElement.muted`. Only the priming play writes it: it mutes the element for the
   * play and gives back the mute state of the user at its end (`primeFirstFrame`).
   */
  muted?: boolean;
  /**
   * `HTMLMediaElement.playbackRate`. Only the priming play writes it, and it gives back the
   * rate from before the play at its end (`primeFirstFrame`).
   */
  playbackRate?: number;
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
 * The last segment playback that the store accepted (ADR 074), and whether it reached its stop.
 *
 * - `id` is a number that the store gives to each segment playback that it accepts: each call of
 *   `playSegment` that sets the stop point. A store never gives the same number two times.
 * - `reached` is false when the store accepts the playback. It becomes true one time, when the
 *   store itself ends that playback because of its stop point: the pause on the last frame, the
 *   seek back from a frame after the last frame, the stop of the clock for a playback that
 *   presents no frame, or the end of the media inside the playback. The store writes it as the
 *   last step of the handler that made the stop, after that handler paused the element and
 *   started its seek back or left it out. A handler whose seek back did not start writes
 *   nothing: the stop point goes with `reached` still false.
 *
 * After a seek, the first frame that leads the position of the element by more than a small
 * distance can come from before the seek to the In. It is in doubt, and it does not stop the
 * playback. A frame that does not lead the position, or a second frame, confirms the playback,
 * and a confirmed playback stops on its frames whatever the position says. When no second frame
 * comes, the backstop of the clock or the end of the media stops it.
 *
 * The end of the media counts only when the element is at its end: it reports `ended` and no
 * seek (isAtMediaEnd). A pause during a seek whose target is the end is a pause from the system.
 *
 * Each other end of a segment playback writes nothing: a pause, a play, a seek, an error, a
 * decode stall, a detach, a reset, a recalibration, and a loss of the calibration. The stop point
 * then goes with `reached` still false. A later frame in the seek-back window (ADR 022) does not
 * write it again.
 *
 * It is display and transport state only. It never enters the project, and no edit reads it.
 */
export interface SegmentPlayback {
  readonly id: number;
  readonly reached: boolean;
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
  /**
   * True when the seek keeps the playback running, as a media player does: the timeline sets it
   * for the seek at pointer down, so a click on the ruler or on the track while the video plays
   * plays on from the new position (ADR 035). It applies only when the store plays, the element
   * does not report `paused`, and the seek is not a scrub seek. The store then does not pause the
   * element, and `isPlaying` stays true: an element that plays seeks when it gets a new
   * `currentTime`, and it plays on from there.
   *
   * Every other rule of the seek holds. The seeks still run one at a time, and the latest request
   * wins: a seek that waits while another seek runs is queued, and `seeked` starts it on the
   * element that still plays. The display target, `presentedFrame` and the frame callbacks
   * follow the rules of any seek. A segment playback ends, and the playback goes on as a normal
   * playback with no stop point (ADR 026). A failed seek pauses the element, as every failed seek
   * does.
   *
   * The option changes nothing while the store does not play, and nothing for a scrub seek. A
   * request that the store defers while the calibration is "calibrating" pauses as before, and
   * it runs without the option when the calibration settles (ADR 003, ADR 022).
   */
  readonly keepPlaying?: boolean;
  /**
   * For `seekApproximate` only. The seek over a gap of a MediaSource source (ADR 046): the gap
   * before the first frame, or a stretch in the middle that the windows skip. It replaces a
   * running seek at once: that seek waits at a position that holds no frame, so it never
   * completes. A request that waits in the queue behind that seek replaces it instead, and the
   * seek over the gap goes. The seek keeps the stop point of a segment playback (ADR 026),
   * because it continues the playback that the user started.
   */
  readonly overGap?: boolean;
}

/**
 * Options for a jump to a frame of the grid (`seekToFrameIndex`). `keepPlaying` is the option of
 * SeekOptions.
 */
export type FrameIndexSeekOptions = Pick<SeekOptions, "keepPlaying">;

/**
 * Options for a frame step (`seekNominal`).
 *
 * `held`: true for each step that repeats a held step: a key repeat of a held step key, and a
 * timer repeat of a held step button (ADR 021). False or absent for a single press, a click and
 * the first step of a hold. A held backward step plays no cue and stops any cue that sounds,
 * because audio does not play backwards and each backward cue would replay a forward snippet
 * (ADR 019). A held forward step requests its cue as a single step does.
 */
export interface FrameStepOptions {
  readonly held?: boolean;
}

/**
 * What a frame step did (`seekNominal`).
 *
 * - `stepped`: the step seeks, or the store keeps it as a deferred step until the calibration
 *   settles.
 * - `edge`: the step starts at the first or the last frame that the store can reach, so it does
 *   not move. The store reaches no further than its bounds of the source: the end of the element,
 *   or an earlier end that the probe gives. The sequence playback reads this for a forward step
 *   on a clip whose extent is an estimate: when another clip follows, the step goes on at the
 *   first frame of that clip (ADR 052).
 * - `none`: the step cannot run. Examples are no attached source, no nominal rate, a decode
 *   stall, and a delta that is not a whole number of frames.
 */
export type FrameStepOutcome = "stepped" | "edge" | "none";

/**
 * Status of the first-presented-frame PTS calibration.
 *
 * - "calibrating": Awaiting first RVFC callback to associate with videoStartPts.
 * - "ready": Calibrated linear mapping active; inferred source PTS available.
 * - "unavailable": Missing RVFC, missing videoStartPts, invalid metadata, duplicate PTS, or unsafe calculation.
 *   When the element never took an anchor, a new element of the same source can calibrate
 *   (`canRecalibrate`, ADR 063).
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
 * A decode error that stopped an element in the middle of the source (`syncDecodeStall`).
 *
 * The source presented frames, and then the element reported an error that it does not recover
 * from: a file whose middle part does not decode, such as a join of two files with different
 * picture sizes by stream copy. A media element does not play or seek again after
 * such an error, so the preview loads a new element for the same source at the next seek
 * (`reloadGeneration`).
 */
export interface DecodeStall {
  /**
   * The position of the element when the error arrived, in seconds from the start of the
   * browser media timeline: the axis of the ruler and of the approximate clock. It comes from
   * `currentTime`, so it is approximate. It is display state only, never an edit position.
   */
  readonly atSeconds: number;
  /**
   * `read` when a remux window of a MediaSource source failed to read the file there (ADR 046),
   * and absent for a decode error of the element.
   */
  readonly cause?: "read";
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
  /**
   * The last segment playback that the store accepted, or null when it accepted none (see
   * SegmentPlayback, ADR 074). A new accepted segment playback replaces it with a new number.
   * Nothing else clears it: a detach and a reset keep it, and a reader compares the number with
   * the number that it got when the store accepted its playback.
   */
  readonly segmentPlayback: SegmentPlayback | null;
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
  /**
   * The decode stall of the attached element, or null while the element can play
   * (`syncDecodeStall`). While it is set:
   *
   * - The element is paused and never moves again. No frame is on screen (`presentedFrame` is
   *   null), and the frame callbacks, `seeked`, `play` and `timeupdate` of the element change
   *   nothing.
   * - The store stays attached and ready, so the timeline can still seek.
   * - `seekToPts`, `seekApproximate` and `seekToFrameIndex` do not touch the element. Each one
   *   keeps its request as the request of a reload, and the latest request wins. The display
   *   target shows that request (`seekTargetSeconds`), and the first request of the stall
   *   raises `reloadGeneration`.
   * - `play`, `playSegment` and `seekNominal` do nothing.
   *
   * An attach, a detach, a loss of readiness (`syncUnready`) and a reset clear it.
   */
  readonly decodeStall: DecodeStall | null;
  /**
   * The count of the reloads that a decode stall or a recalibration started. The preview keys
   * its media elements on the source revision and on this count, so a higher count replaces the
   * element with a new element for the same source. The count only goes up: a seek during a stall
   * raises it once for that stall, and so does a new import of the same file during a stall
   * (`reloadStalledPreview`). A recalibration raises it once (`recalibrate`,
   * `syncAnchorWaitExpired`, ADR 063).
   *
   * The new element calibrates from the start of the source, as a new source does (ADR 003). The
   * request of the reload waits for its metadata, and then for the calibration anchor, as a
   * navigation deferred during calibration does (ADR 022). Only a user request reloads, so a
   * reload that seeks into the part that does not decode stalls again and does not reload by
   * itself. The one exception is the one automatic recalibration of a source when the wait for
   * its first frame runs out (`syncAnchorWaitExpired`).
   */
  readonly reloadGeneration: number;
  /**
   * True while a recalibration can help (ADR 063), and `recalibrate` acts. All of these must
   * hold:
   *
   * - The calibration is recoverable: it is "unavailable" because the wait for the first frame
   *   ran out and the source had no automatic recalibration left (`syncAnchorWaitExpired`), the
   *   source has a valid `videoStartPts` and time base, and the store holds no denial of the
   *   source.
   * - The element is ready (`isReady`).
   * - No decode stall is active (`decodeStall`).
   * - No reload is in progress: a reload of a stall or of a recalibration ends when the new
   *   element has its metadata.
   *
   * Every other cause of "unavailable" is evidence against the anchor or the mapping of the
   * source, or a property of the source or of the web view, so a new element gives nothing safe.
   * A MediaSource source knows its anchor (ADR 046), so no navigation waits for its first frame. The status bar and
   * the badge beside the preview timecode become buttons that start a recalibration while this
   * is true. It is display and transport state only, and no edit reads it.
   */
  readonly canRecalibrate: boolean;
  /**
   * True from the start of a recalibration until its new element is ready (ADR 063): the old
   * element is retired, and then the new element loads. The detach of the old element keeps it,
   * and so do the detach and the attach of the new element before its metadata. An attach of a
   * different source, a loss of readiness of the new element and a reset end it. A failed seek
   * drops only the request of the reload, and the reload goes on. The reload of a decode stall
   * does not set it. The replacement of the element for a new audio stream
   * (`replacePreviewElement`, ADR 070) sets it, as a recalibration does.
   *
   * While it is true, the cue of ADR 019 and the Web Audio cue of ADR 062 do not start, so no
   * cue loads the file beside the new element before its anchor.
   */
  readonly isRecalibrating: boolean;
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
   * Shows the first frame of a native source with a muted play, so the first frame callback can
   * take the calibration anchor (ADR 003). WKWebView presents no frame of a paused element that
   * loaded only its metadata, and no frame at position 0 when the first frame starts after 0,
   * such as after the empty edit at the start of an MP4. The preview calls it on macOS when the
   * metadata loads.
   *
   * The play is muted, at `FIRST_FRAME_PRIMING_RATE`, and does not seek, so the first presented
   * frame is still the first frame after the load. It is not a playback of the user: its `play`
   * event changes nothing, and the play button stays at Play. A navigation during the priming is
   * deferred as during any calibration, but it does not pause the element, and neither does a
   * seek that fails: a paused element would show no frame, and the anchor would never come. The
   * first frame callback pauses the element before it takes the anchor and runs the deferred
   * navigation. The element then gets back its rate and the mute state that `readMuted` reads at
   * that moment. A `play` during the priming keeps the element playing as the playback of the
   * user, with its normal rate and sound. The `pause` action, a stall, a loss of readiness, a
   * detach, a reset, an attach of another source and a report that frame callbacks are
   * unavailable each pause the element and end the priming, and an end of the media ends it. A
   * priming that moves the element past `ANCHOR_TOLERANCE_SECONDS` from the anchor baseline with
   * no frame makes the calibration unavailable, because the anchor guard would refuse the first
   * frame from there. That is evidence that the first callback can come late, so no
   * recalibration follows it (ADR 063). The new element of a recalibration gets its own priming
   * play.
   *
   * Does nothing unless the element is attached, ready, paused and has no stall, the calibration
   * is "calibrating" with no anchor and no seek before it, the source has no known anchor (ADR
   * 046), no priming runs, and the element exposes `muted` and `playbackRate`.
   */
  primeFirstFrame: (
    sourceRevisionKey: string,
    element: PlaybackMediaElement,
    readMuted: () => boolean,
  ) => void;

  /**
   * Marks the media element unready on decode error or readiness loss.
   * Invalidates any pending play sessions.
   */
  syncUnready: (sourceRevisionKey: string, element: PlaybackMediaElement) => void;

  /**
   * Records a decode stall of the matching element (`decodeStall`): the source presented a
   * frame, and then the element reported a media error that it does not recover from. The
   * preview decides that (`classifyDecodeFailure`).
   *
   * The store pauses the element, stops the cue, and drops the queued seek, a deferred
   * navigation and the stop point of a segment playback. `presentedFrame` becomes null and
   * `isPlaying` false, and the approximate clock takes the position of the element. The store
   * stays attached and ready. A second call for the same stall changes nothing.
   *
   * Returns true when the store holds a stall of the element after the call. Returns false, and
   * changes nothing, when the element or the source is not the attached one, or the store does
   * not report the element ready. The caller then treats the error as a failure of the source.
   */
  syncDecodeStall: (
    sourceRevisionKey: string,
    element: PlaybackMediaElement,
    cause?: "read",
  ) => boolean;

  /**
   * Starts the reload of a stalled element of the matching source with no navigation: the new
   * element loads at the start of the source. The preview calls it when the user imports the
   * open file again during a stall, because the element of that file keeps its key and is not
   * replaced otherwise. It does nothing without a stall, and it raises `reloadGeneration` at
   * most once for each stall. A seek during the stall already raised it, and its request is
   * kept.
   */
  reloadStalledPreview: (sourceRevisionKey: string) => void;

  /**
   * Starts a manual recalibration of the attached source (ADR 063): a reload of the preview with
   * no decode stall, so a new element calibrates from its own first frame. It does nothing
   * unless `canRecalibrate` is true and `sourceRevisionKey` is the attached source. It removes
   * no denial of the source.
   *
   * It keeps the position to go back to: the display target when a seek is pending, otherwise
   * the position of the approximate clock, both in seconds from the start of the attached
   * source. That position becomes the request of the reload, as an exact seek, so it runs at the
   * anchor of the new element, or on the approximate clock when that element cannot calibrate.
   * The playback does not start again.
   *
   * The start is one step (the handoff): it ends the playback, the cue, the priming play, the
   * queued seek, a deferred navigation and the stop point of a segment playback, keeps the
   * request and its display target, raises `reloadGeneration` once and sets `isRecalibrating`.
   * It sets no `decodeStall`. Until the pane detaches it, the old element is retired: the store
   * treats it as a stalled element (`decodeStall`), so its events change nothing, a seek replaces
   * the request of the reload, and play, Play Segment and a frame step do nothing.
   *
   * It does not permit a new automatic recalibration of the source (`syncAnchorWaitExpired`).
   */
  recalibrate: (sourceRevisionKey: string) => void;

  /**
   * Replaces the attached element of the source with a new element of the same source, with no
   * decode stall, on the path of a recalibration (ADR 063). The preview calls it when the
   * effective audio stream of a MediaSource source changes (ADR 070): the new element gets a new
   * MediaSource and new windows of that stream. It starts in the one step of `recalibrate`: it
   * ends the playback, the cue, the priming play, the queued seek and the stop point of a segment
   * playback, raises `reloadGeneration` once and sets `isRecalibrating`, and the old element is
   * retired until the pane detaches it. The playback does not start again.
   *
   * The request of the reload is the position of the playhead, so the new element goes back to
   * it:
   *
   * - a navigation that waits for the calibration anchor, with its seek and its steps, and a
   *   scrub seek as an exact seek;
   * - else, while a seek is pending on a ready calibration, the PTS of its destination: the
   *   frame that the seek named, also for a frame seek that aims at the middle of the frame. The
   *   playhead keeps the display target of the seek until the new element shows that frame.
   *   Without a calibration, its display target, as an exact seek in seconds from the start of
   *   the source;
   * - else, on a ready calibration, the PTS of the confirmed frame (`presentedFrame`);
   * - else the position of the approximate clock, as `recalibrate` takes it;
   * - before the element is ready, nothing: the new element loads at the start.
   *
   * The new element of a reload that has no metadata yet goes too, and the request of that reload
   * goes on to the next element. It does nothing in these cases:
   *
   * - The element is stalled (`decodeStall`), or its replacement started already. A seek replaces
   *   a stalled element, and the preview reads the stream for each element that it attaches.
   * - `sourceRevisionKey` is not the attached source, or no element is attached.
   *
   * It removes no denial of the source, and it does not permit a new automatic recalibration
   * (`syncAnchorWaitExpired`).
   */
  replacePreviewElement: (sourceRevisionKey: string) => void;

  /**
   * True when `element` is the attached element of the source and a recalibration retired it
   * (ADR 063): the pane has not detached it yet. The pane drops every media event of such an
   * element, and its frame callbacks, before it calls the sequence playback or the store, and it
   * shows no failure panel for an error of it. It reads and changes nothing.
   */
  isRetiredElement: (
    sourceRevisionKey: string,
    element: PlaybackMediaElement,
  ) => boolean;

  /**
   * True while the store refuses Play, Play Segment and a frame step because the preview element
   * goes or is being replaced (ADR 039, ADR 063):
   *
   * - the attached element is stalled (`decodeStall`), or a recalibration retired it;
   * - a recalibration is in progress (`isRecalibrating`), also while no element is attached
   *   between the detach of the old element and the attach of the new one, and while the new
   *   element has no metadata.
   *
   * The sequence playback reads it before it changes its own navigation for such a command. It
   * reads and changes nothing.
   */
  refusesTransportForReload: () => boolean;

  /**
   * Toggles playback. Synchronously invokes video.play() to preserve user activation.
   * Catches async promise rejection to set a localized error code.
   */
  togglePlayback: () => void;

  /**
   * Explicitly starts playback. Synchronously calls video.play().
   * Drops a navigation deferred during calibration and plays from where the element stands,
   * because a seek before the calibration anchor would refuse the calibration (ADR 003).
   * Does nothing during a decode stall (`decodeStall`).
   */
  play: () => void;

  /**
   * Explicitly pauses playback.
   */
  pause: () => void;

  /**
   * Resumes playback after a seek that paused it, as the release of a drag during playback does
   * (ADR 035). It plays as `play` does, so a pending seek starts at once as an exact seek and the
   * playback starts at its target (ADR 022).
   *
   * It does nothing in these cases:
   *
   * - The store plays already, or no ready element is attached.
   * - A navigation waits for the calibration anchor (`hasDeferredNavigation`). `play` would drop
   *   it, and the playback would start from where the element stands.
   * - The playback would start at or after the end of the element: the target of the pending
   *   seek, or else the position of the element, lies at or after its duration, within
   *   NOMINAL_STEP_EDGE_TOLERANCE_SECONDS, or the element reports `ended` with no pending seek.
   *   `play` on an element at its end starts again from the start of the media, in WebKit and in
   *   Chromium, so a drag that ends at the end of the media would restart the video.
   */
  resumeAfterSeek: () => void;

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
   * It needs an attached, ready element, a ready calibration, no decode stall, and a segment
   * that holds a frame (canPlaySegment): on the frame grid, a last frame at or after the frame
   * of the In. Otherwise it does nothing. When the seek to `inPts` fails, it does not play.
   *
   * When it sets the stop point, it also gives the playback a new number in `segmentPlayback`,
   * with `reached` false, in the same write (ADR 074). A call that sets no stop point leaves
   * `segmentPlayback` as it is.
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
   * A seek pauses playback, except a seek with `keepPlaying` while the store plays, which plays
   * on from the target (see SeekOptions).
   * During a decode stall the request becomes the request of a reload, as an exact seek
   * (`decodeStall`).
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
   * With `held`, a backward step requests no cue and stops the cue, also at the edge, where the
   * step does not move (see FrameStepOptions).
   * Does nothing during a decode stall, because no frame is on screen to step from
   * (`decodeStall`).
   * Returns what the step did (`FrameStepOutcome`).
   */
  seekNominal: (deltaFrames: number, options?: FrameStepOptions) => FrameStepOutcome;

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
   *
   * With `keepPlaying`, a jump while the store plays does not pause (SeekOptions): it seeks and
   * plays on. A target that is the frame on screen, while the element is still inside that
   * frame, then does nothing at all.
   *
   * During a decode stall, on a ready calibration, the request becomes the request of a reload
   * in the form of the deferred request above (`decodeStall`).
   */
  seekToFrameIndex: (frameIndex: number, options?: FrameIndexSeekOptions) => void;

  /**
   * Requests a checked browser-time seek without creating a canonical edit position.
   * Accepts optional SeekOptions for playhead scrubbing (ADR 022).
   * While the calibration is "calibrating", the seek is deferred and replaces any earlier
   * deferred request. It runs when the calibration settles: on the calibrated mapping when the
   * calibration is ready, unless `keepBrowserTimeline` is set, and on the approximate clock
   * when it is unavailable.
   * A seek pauses playback, except a seek with `keepPlaying` while the store plays, which plays
   * on from the target (see SeekOptions).
   * During a decode stall the request becomes the request of a reload, as an exact seek
   * (`decodeStall`).
   */
  seekApproximate: (seconds: number, options?: SeekOptions) => void;

  /**
   * Synchronizes confirmed presented frame from requestVideoFrameCallback.
   * On first frame, calibrates mediaTime to videoStartPts.
   * On later frames, infers PTS via checked slope-one mapping.
   * Detects duplicate inferred PTS for distinct presented frames and marks calibration unavailable.
   * No loss of the calibration here is recoverable (ADR 063): each one is evidence against the
   * anchor or the mapping, or the source cannot calibrate. While a recalibration waits for its
   * new element, the callbacks of the old element change nothing.
   */
  syncPresentedFrame: (
    sourceRevisionKey: string,
    mediaTime: number,
    presentedFrames: number | undefined,
    element: PlaybackMediaElement,
  ) => void;

  /**
   * Marks precise presentation mapping unavailable for the matching element: the web view has no
   * RVFC, the first frame of a MediaSource source did not match its first window (ADR 046), or
   * the priming play moved too far with no frame (`primeFirstFrame`).
   * Playback and approximate browser timing remain available. A deferred navigation then runs on
   * the approximate path. The cause is not recoverable: a new element of the same source would
   * give nothing safe, so `canRecalibrate` stays false (ADR 063). A retired element changes
   * nothing.
   */
  syncPresentationUnavailable: (
    sourceRevisionKey: string,
    element: PlaybackMediaElement,
  ) => void;

  /**
   * The preview reports that the bounded wait for the first presented frame of a visible element
   * ran out while a navigation was deferred (ADR 003, ADR 063). It acts only while a navigation
   * is deferred, the calibration is "calibrating", and the source and the element are the
   * attached ones, and the element is not retired.
   *
   * The first time for a source, it starts a recalibration, in the one step of `recalibrate`:
   * the deferred navigation becomes the request of the reload, with its seek and its steps, and
   * a scrub seek becomes an exact seek. The display target stays, the calibration stays "calibrating", and the allowance of
   * the source is used. The store permits one such automatic recalibration for each source. A
   * calibration of that source that becomes ready permits one more, and so do the attach of a
   * different source and a reset. A manual recalibration does not.
   *
   * When the source has no automatic recalibration left, the calibration becomes "unavailable"
   * with a recoverable cause (`canRecalibrate`), and the deferred navigation runs on the
   * approximate path.
   */
  syncAnchorWaitExpired: (
    sourceRevisionKey: string,
    element: PlaybackMediaElement,
  ) => void;

  /**
   * Gives the media time of the first frame that the first remux window of a MediaSource source
   * presents, which the page reads from its first `moof` (ADR 046). The first frame callback
   * must report that time within half a frame interval, or the calibration becomes unavailable
   * for the attachment. A play or a seek before that callback skips the check, because the
   * callback then can name another frame. An exact seek into the expected frame keeps it. The
   * mismatch is evidence against the mapping, so no recalibration follows it (ADR 063).
   */
  syncExpectedFirstFrame: (
    sourceRevisionKey: string,
    element: PlaybackMediaElement,
    mediaTime: number,
  ) => void;

  /**
   * Turns precise editing off for the source, for as long as the application runs, as ADR 003
   * does for indistinguishable timestamps. The page calls it when the timestamps of a source
   * decrease (ADR 046). No recalibration removes the denial (ADR 063).
   */
  denySourcePrecision: (
    sourceRevisionKey: string,
    element: PlaybackMediaElement,
  ) => void;

  /**
   * Gives the real video frames of the attached element of a MediaSource source, or null when
   * its controller goes (ADR 046). While a calibration holds, a relative frame step moves by these
   * frames, and it keeps the nominal step only where the table does not know a frame (ADR 022).
   * The attach and the detach of an element drop the table.
   */
  syncFrameTable: (
    sourceRevisionKey: string,
    element: PlaybackMediaElement,
    table: FrameTable | null,
  ) => void;

  /**
   * Seeks the element once more for a seek whose data arrived after it began, in WKWebView (ADR
   * 046, measurement 26): 3 ms from `mediaTime`, toward the middle of its nominal frame, or before
   * it when `videoAfter` is false. It does so when the element still aims at `mediaTime`, and
   * when WebKit moved the element while the last seek of the store still names `mediaTime` and
   * neither that seek nor a later play kept a playback running. The store reads the landing as
   * `mediaTime`. A frame too short for the 3 ms gets no repair when the element aims at
   * `mediaTime`, and it gets a seek to `mediaTime` itself after a move. A seek that waits in the
   * queue starts instead. A scrub sample gets one fastSeek 3 ms away.
   */
  repairSeek: (
    sourceRevisionKey: string,
    element: PlaybackMediaElement,
    mediaTime: number,
    videoAfter?: boolean,
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
   * Dispatches the next queued seek if one is pending. Otherwise, unless the last seek was a
   * scrub or a navigation is deferred, it clears the display target: when not in the ready
   * state, and in the ready state when the presented frame holds the position of the element,
   * because the frame callback of the seek can run before the seek ends (ADR 022). In the ready
   * state, a paused element with no presented frame gets back the last frame that a frame
   * callback confirmed when that frame holds the position, because a seek that lands on the frame
   * on screen may bring no frame callback.
   */
  syncSeeked: (sourceRevisionKey: string, element: PlaybackMediaElement) => void;

  /**
   * Synchronizes play state when the matching video element emits an onPlay event.
   */
  syncPlay: (sourceRevisionKey: string, element: PlaybackMediaElement) => void;

  /**
   * Synchronizes pause state when the matching video element emits an onPause event.
   *
   * The event runs as a task after the pause. When it finds the element playing again
   * (`paused` is false), a play followed the pause in the same call, as Play Segment and the
   * release of a drag during playback do (a seek, then play). The store then keeps `isPlaying`
   * and the pending play promise, so the play button does not show Play for one frame. The rule
   * of the segment playback at this event runs first, unchanged (ADR 026).
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
   * The media time of `videoStartPts` while the calibration is ready (ADR 003), or null. It
   * reads the anchor and changes nothing. The anchor stays when a seek clears
   * `presentedFrame`, so the Web Audio cue of a native source can take its origin from it
   * (ADR 062).
   */
  calibrationAnchorMediaTime: () => number | null;

  /**
   * Resets playback state and detaches any active media source and element.
   */
  reset: () => void;
}

/**
 * Combined type of playback store state and actions.
 */
export type PlaybackStoreState = PlaybackState & PlaybackActions;
