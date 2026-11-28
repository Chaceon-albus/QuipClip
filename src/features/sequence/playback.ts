/**
 * The playback of a sequence of clips, as one virtual source (ADR 052).
 *
 * The playback store attaches one source at a time and reports every position relative to that
 * source: a source PTS, or seconds from its first frame. The interface works on the virtual axis of
 * the sequence (`virtualTime.ts`). This store has the shape of the playback store, so the interface
 * reads it with the same selectors, and it maps each value:
 *
 * - a PTS of the attached clip becomes a virtual PTS;
 * - seconds of the attached clip get the start of that clip on the sequence;
 * - a seek to a virtual position finds its clip. A seek on the attached clip goes to the playback
 *   store, once the element of that clip is ready. A seek on another clip attaches that clip first,
 *   and the seek runs after the attach, once the new element is ready: a cold switch (ADR 052);
 * - at the end of a clip, playback goes on at the first frame of the next clip (`handleEnded`).
 *
 * With one clip, every value and every request passes through unchanged.
 *
 * It also runs a program play (ADR 074): a list of parts that it plays one after another, each
 * as a segment playback of the playback store (`startProgramPlay`).
 *
 * The preview itself (`PreviewPane`) keeps the playback store: it owns the media element and the
 * attach of the real source.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { mediaStore } from "@/features/media/store";
import { getSourceRevisionKey } from "@/features/media/sourceIdentity";
import { getNominalFrameRate, playbackStore } from "@/features/playback/store";
import type { PlaybackStore } from "@/features/playback/store";
import type {
  FrameIndexSeekOptions,
  FrameStepOptions,
  FrameStepOutcome,
  PlaybackState,
  PlaybackStop,
  PlaybackStoreState,
  SeekOptions,
} from "@/features/playback/types";
import { layoutSequence, locate } from "@/features/timeline/sequence";
import { timelineStore, type TimelineStore } from "@/features/timeline/store";
import type { TimelineState } from "@/features/timeline/types";
import {
  clipAtVirtualPts,
  clipStartSeconds,
  fromVirtualPts,
  toVirtualPts,
  type VirtualClip,
  type VirtualTimeline,
} from "@/features/timeline/virtualTime";
import { ptsFromBigInt, ptsToBigInt, ptsToMediaTime } from "@/lib/time";
import type { Pts } from "@/types/project";
import { mediaBySourceOf } from "./media";
import { programKey, type ProgramAction, type ProgramPart } from "./programParts";
import { sequenceNominalRate, type MediaBySource } from "./virtualMedia";

/**
 * The watchdog of a part of a program play (ADR 074): the time with no progress after which the
 * part fails. It starts when the run asks for the part, and again when the store accepts the
 * part. After the acceptance, each change of the clock of the element that the store publishes
 * starts it again, so a part that plays never fails by it, however long the part is. Before the
 * acceptance, nothing else starts it again.
 */
export const PROGRAM_PART_TIMEOUT_MS = 10_000;

/** The mapping between the clip that the playback store shows and the virtual axis. */
interface ClipMapping {
  readonly clipId: string;
  readonly timeline: VirtualTimeline;
  readonly clip: VirtualClip;
  /** The sequence seconds where the clip starts. */
  readonly offsetSeconds: number;
}

/** A navigation that waits for the attach of its clip. */
type Navigation = { readonly clipId: string } & (
  | { readonly kind: "pts"; readonly pts: Pts; readonly options?: SeekOptions }
  | {
      readonly kind: "seconds";
      readonly seconds: number;
      readonly options?: SeekOptions;
    }
  | {
      readonly kind: "frame";
      readonly frameIndex: number;
      readonly options?: FrameIndexSeekOptions;
    }
  | { readonly kind: "segment"; readonly inPts: Pts; readonly outPts: Pts }
  | {
      // A part of a program play (ADR 074): the run asks the playback store for a segment
      // playback of `[inPts, outPts)` once the element and the calibration are ready.
      readonly kind: "part";
      readonly inPts: Pts;
      readonly outPts: Pts;
      readonly partToken: number;
    }
);

/**
 * A navigation that waits for an attach, as a seek with no play: a play that waits loses its
 * play, and a Play Segment or a part of a program play that waits becomes a seek to its start.
 * The replacement of the element for a new audio stream stops the playback, which does not
 * start again (ADR 070), and so does the end of a program play (ADR 074).
 */
function withoutPlay(navigation: Navigation): {
  readonly navigation: Navigation;
  readonly play: false;
} {
  return {
    navigation:
      navigation.kind === "segment" || navigation.kind === "part"
        ? { kind: "pts", clipId: navigation.clipId, pts: navigation.inPts }
        : navigation,
    play: false,
  };
}

/**
 * Starts a timer of `ms` milliseconds that calls `callback`, and returns the function that
 * cancels it.
 */
export type ProgramTimer = (callback: () => void, ms: number) => () => void;

const defaultTimer: ProgramTimer = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

/** Dependencies of `createSequencePlayback`, injected for tests. */
export interface SequencePlaybackDependencies {
  readonly playback: PlaybackStore;
  readonly timeline: TimelineStore;
  /** The media of every source of the session, by source ID. */
  readonly media: () => MediaBySource;
  /** The timer of the parts of a program play (PROGRAM_PART_TIMEOUT_MS). `setTimeout` by default. */
  readonly timer?: ProgramTimer;
}

/**
 * The program play that runs, for the interface (ADR 074): its action, the number of the part
 * that plays or loads, counted from 1, and the count of the parts of its list.
 */
export interface ProgramRunState {
  readonly action: ProgramAction;
  readonly part: number;
  readonly count: number;
}

/**
 * The state of the sequence playback: the state of the playback store on the virtual axis,
 * `switching`, true during a cold switch (`SequencePlayback.isSwitching`), and `programRun`, the
 * program play that runs, or null with no run (ADR 074).
 */
export type SequencePlaybackState = PlaybackStoreState & {
  readonly switching: boolean;
  readonly programRun: ProgramRunState | null;
};

/** The store of the sequence playback, and the hook of the end of the media element. */
export interface SequencePlayback {
  readonly store: StoreApi<SequencePlaybackState>;
  /**
   * The preview calls this at the `ended` event of its element. When the element played to the
   * end of a clip that another clip follows, playback goes on at the first frame of that clip,
   * and it returns true: the preview then does not sync the end to the playback store, because
   * the playback goes on. It returns false otherwise, and the preview syncs the end as before.
   */
  readonly handleEnded: () => boolean;
  /**
   * The preview calls this at each `pause` event of its element, before the playback store syncs
   * it, with true when the element is at its end: it reports `ended` and no seek (isAtMediaEnd,
   * ADR 074). The element sends `pause` before `ended` at its end, and the pause ends the playing
   * state, so this records that the element was playing when it reached the end.
   */
  readonly notePause: (ended: boolean) => void;
  /**
   * The preview calls this when it drops an `ended` event of its element: an event that finds the
   * element away from its end (ADR 074). It forgets what `notePause` recorded of the pause before
   * that event, so a later `ended` event that no pause came before, as at the end of a seek of a
   * paused element, does not go on at the next clip. It does not change the play intent of a Play
   * Segment that crosses a junction: that playback goes on, and its own end goes on at the next
   * clip.
   */
  readonly forgetPauseAtEnd: () => void;
  /**
   * True during a cold switch: from a navigation to another clip until the source of that clip is
   * calibrated, unless the playback store reports an error. A navigation that waits for an element
   * with no metadata yet counts too. The timeline reads it, so a scrub or a trim that crosses a
   * junction is not cancelled while the new clip loads.
   */
  readonly isSwitching: () => boolean;
  /**
   * Goes to nominal frame `frameIndex` of the grid of clip `clipId`: the frame that
   * `seekToFrameIndex` of the playback store names, counted from the first frame of the source
   * of the clip (ADR 022). The drag trim on the grid of a clip seeks with it (ADR 052). A clip
   * that is not attached is attached first, and the seek runs after the attach. A negative index,
   * an index that is not a safe integer, or a clip that is not on the sequence does nothing.
   */
  readonly seekToClipFrame: (clipId: string, frameIndex: number) => void;
  /**
   * Drops a navigation that waits for the attach of its clip, so the clip on screen stays
   * attached and keeps its frame. A trim that ends on the frame on screen calls it (ADR 030): the
   * scrub of its drag can have started a cold switch that would otherwise move the playhead after
   * the trim. Does nothing while no navigation waits.
   */
  readonly dropNavigation: () => void;
  /**
   * Ends the play intent of the sequence, and keeps its navigation (ADR 070). A segment playback
   * that crosses a junction ends. A navigation that waits for the attach of its clip stays as a
   * seek with no play: a play loses its play, and a Play Segment becomes a seek to its In. The
   * preview calls it before it mounts the element of a failed source again for a new audio
   * stream, because the playback does not start again after a change of the stream.
   */
  readonly dropPlayIntent: () => void;
  /**
   * Starts a program play (ADR 074) of `parts`, the list that `buildProgramParts` made for
   * `action`. It ends a run that exists, drops the play intent of a Play Segment that crosses a
   * junction, and starts the first part: the clip of the part attaches when it is not on screen,
   * and the run asks the playback store for a segment playback of the part once the element and
   * its calibration are ready. Each part goes on at the next part when the store reports that it
   * reached its stop, and the run ends after the last part. Returns true when the run started.
   * With an empty list it does nothing and returns false.
   */
  readonly startProgramPlay: (
    action: ProgramAction,
    parts: readonly ProgramPart[],
  ) => boolean;
  /**
   * Ends the program play that runs, as the user takes the playback (ADR 074): it pauses, drops
   * the stop point of the part, and a request of the run that waits for the attach of a clip
   * becomes a seek to the start of its part with no play. Each entry point of the user calls it
   * before it plans its command. Returns true when a run ended, and false with no run.
   */
  readonly endProgramPlay: () => boolean;
  /**
   * The preview calls this when it gives up the element of `sourceRevisionKey`, the revision key
   * of the source of its element, on its path of a fatal failure: the element does not decode,
   * and it leaves the tree. When the part of a program play is on a clip of that source, the run
   * ends as a failure (ADR 074), with the three effects of each end before the last part. A
   * request of the run that waits for that element stays as a seek with no play, so a new
   * element of the source that loads later plays nothing. With no run, or another source, it
   * does nothing.
   */
  readonly notePreviewFailure: (sourceRevisionKey: string) => void;
}

/** The facts of the playback store that a failure of a program play compares (ADR 074). */
interface ProgramRunWatch {
  readonly error: PlaybackState["error"];
  readonly decodeStall: PlaybackState["decodeStall"];
  readonly reloadGeneration: number;
}

function watchOf(real: PlaybackState): ProgramRunWatch {
  return {
    error: real.error,
    decodeStall: real.decodeStall,
    reloadGeneration: real.reloadGeneration,
  };
}

/**
 * A program play that runs (ADR 074). The stage of the part that plays or loads:
 *
 * - `loading`: the run asked for the part, and it waits for the attach of its clip, for the
 *   element or for the calibration;
 * - `accepted`: the store accepted the segment playback of the part with the number `acceptedId`;
 * - `refused`: the start of the part does not lie before the end of the media, or the store did
 *   not accept the part. The next read ends the run;
 * - `completed`: the store reported that the part reached its stop.
 */
interface ProgramRun {
  readonly action: ProgramAction;
  readonly parts: readonly ProgramPart[];
  index: number;
  partToken: number;
  stage: "loading" | "accepted" | "refused" | "completed";
  acceptedId: number | null;
  /** True when the store published "reached" for `acceptedId`. */
  reached: boolean;
  /**
   * The clock of the element (`approximateBrowserTimeSeconds`) at the last write of the store
   * that the run saw since the store accepted the part (`notePlaybackChange`).
   */
  clock: number | null;
  /** Cancels the watchdog of the part (PROGRAM_PART_TIMEOUT_MS). */
  cancelTimer: (() => void) | null;
  /** The part token of the read that waits in a microtask, or null. */
  scheduledToken: number | null;
  /** The facts of the store at the last read (watchOf). */
  watch: ProgramRunWatch;
  /** The program when the run started (`programKey`). */
  readonly program: string;
}

/**
 * The state fields of the playback store, without its actions. The sequence playback has actions
 * of its own, and a copy of the actions of the playback store would replace them.
 */
function stateOf(real: PlaybackState): PlaybackState {
  return {
    presentedFrame: real.presentedFrame,
    calibrationStatus: real.calibrationStatus,
    runtimeBrowserDurationSeconds: real.runtimeBrowserDurationSeconds,
    approximateBrowserTimeSeconds: real.approximateBrowserTimeSeconds,
    seekTargetSeconds: real.seekTargetSeconds,
    hasDeferredNavigation: real.hasDeferredNavigation,
    playbackStop: real.playbackStop,
    segmentPlayback: real.segmentPlayback,
    isPlaying: real.isPlaying,
    isAttached: real.isAttached,
    attachedSourceRevisionKey: real.attachedSourceRevisionKey,
    isReady: real.isReady,
    error: real.error,
    decodeStall: real.decodeStall,
    reloadGeneration: real.reloadGeneration,
    canRecalibrate: real.canRecalibrate,
    isRecalibrating: real.isRecalibrating,
  };
}

function isSequence(timeline: TimelineState): boolean {
  return timeline.clips.length > 1 && timeline.virtual !== null;
}

function findVirtualClip(
  timeline: VirtualTimeline,
  clipId: string,
): VirtualClip | null {
  return timeline.clips.find((clip) => clip.clipId === clipId) ?? null;
}

/** The exclusive end PTS of a clip on its own grid, or null when its extent is not known. */
function clipEndPts(clip: VirtualClip): bigint | null {
  if (clip.rangeStart === null || clip.durationTicks === null) {
    return null;
  }
  return clip.rangeStart + clip.durationTicks / clip.scale;
}

/**
 * The source PTS on `clip` of a virtual PTS: the tick of the clip that holds it. A frame that the
 * preview presents is on the grid of its clip; a PTS from a pixel need not be.
 */
function nearestSourcePts(
  timeline: VirtualTimeline,
  clip: VirtualClip,
  pts: Pts,
): Pts | null {
  const exact = fromVirtualPts(timeline, pts, clip.clipId);
  if (exact !== null) {
    return exact.pts;
  }
  if (clip.rangeStart === null) {
    return null;
  }
  // A position inside a tick of the clip names that tick, so the division rounds down. A
  // rounding up could name the end boundary of the clip for a position just before it.
  const offset = ptsToBigInt(pts) - ptsToBigInt(timeline.originPts) - clip.startTicks;
  const quotient = offset / clip.scale;
  const floor =
    offset < 0n && quotient * clip.scale !== offset ? quotient - 1n : quotient;
  return ptsFromBigInt(clip.rangeStart + floor);
}

/**
 * Creates the sequence playback over the playback store and the timeline store.
 */
export function createSequencePlayback(
  dependencies: SequencePlaybackDependencies,
): SequencePlayback {
  const { playback, timeline } = dependencies;
  let pending: { navigation: Navigation; play: boolean } | null = null;
  // The Out of a Play Segment that crosses a junction, as a virtual PTS, while it plays.
  let playingTo: Pts | null = null;
  // The clip whose source the playback store reports now. It follows the attached clip only when
  // the playback store attached that clip's source, so the frames of the old source keep their
  // mapping during a switch.
  let mappedClipId: string | null = null;
  const timer = dependencies.timer ?? defaultTimer;
  // The program play that runs, or null (ADR 074).
  let programRun: ProgramRun | null = null;
  // The last token of a part. Each part of each run gets a new one.
  let lastPartToken = 0;
  // The state of the run for the interface, kept while its fields stay the same.
  let programRunMemo: ProgramRunState | null = null;

  const mediaOfClip = (clipId: string) => {
    const clip = timeline.getState().clips.find((entry) => entry.id === clipId);
    return clip === undefined ? undefined : dependencies.media()[clip.sourceId];
  };

  const revisionKeyOfClip = (clipId: string): string | null => {
    const media = mediaOfClip(clipId);
    const key = media === undefined ? "" : getSourceRevisionKey(media);
    return key === "" ? null : key;
  };

  /** The nominal frame interval of a clip in its own ticks, or null. */
  const intervalTicksOf = (clipId: string): bigint | null => {
    const media = mediaOfClip(clipId);
    const rate = media === undefined ? null : getNominalFrameRate(media.probe);
    if (media === undefined || rate === null || rate.n <= 0) {
      return null;
    }
    // ticks = 1 / (rate * time base) = (rate.d * tb.d) / (rate.n * tb.n), rounded.
    const numerator = BigInt(rate.d) * BigInt(media.probe.videoTimeBase.d);
    const denominator = BigInt(rate.n) * BigInt(media.probe.videoTimeBase.n);
    return denominator === 0n ? null : (numerator + denominator / 2n) / denominator;
  };

  const mappingOf = (state: TimelineState): ClipMapping | null => {
    if (!isSequence(state) || state.virtual === null) {
      return null;
    }
    const realKey = playback.getState().attachedSourceRevisionKey;
    const wanted = state.attachedClipId;
    if (wanted !== null && realKey !== null && revisionKeyOfClip(wanted) === realKey) {
      mappedClipId = wanted;
    }
    if (
      mappedClipId === null ||
      !state.clips.some((clip) => clip.id === mappedClipId)
    ) {
      return null;
    }
    const clip = findVirtualClip(state.virtual, mappedClipId);
    const offsetSeconds =
      clip === null ? null : clipStartSeconds(state.virtual, mappedClipId);
    if (clip === null || offsetSeconds === null) {
      return null;
    }
    return { clipId: mappedClipId, timeline: state.virtual, clip, offsetSeconds };
  };

  const toVirtual = (mapping: ClipMapping, pts: Pts): Pts | null =>
    toVirtualPts(mapping.timeline, { clipId: mapping.clipId, pts });

  const mapStop = (
    mapping: ClipMapping,
    stop: PlaybackStop | null,
  ): PlaybackStop | null => {
    if (stop === null) {
      return null;
    }
    const inPts = toVirtual(mapping, stop.inPts);
    const outPts = toVirtual(mapping, stop.outPts);
    if (inPts === null || outPts === null) {
      return null;
    }
    if (stop.phase === "playing") {
      return { phase: "playing", inPts, outPts };
    }
    const restPts = toVirtual(mapping, stop.restPts);
    return restPts === null
      ? null
      : {
          phase: "stopped",
          inPts,
          outPts,
          restPts,
          windowEndSeconds:
            stop.windowEndSeconds === null
              ? null
              : stop.windowEndSeconds + mapping.offsetSeconds,
        };
  };

  // The last mapped objects, kept while the object of the playback store and the mapping are the
  // same, so a selector of them sees one object until something changes.
  let frameMemo: {
    real: PlaybackState["presentedFrame"];
    key: string;
    mapped: PlaybackState["presentedFrame"];
  } | null = null;
  let stopMemo: {
    real: PlaybackState["playbackStop"];
    key: string;
    mapped: PlaybackState["playbackStop"];
  } | null = null;
  let stallMemo: {
    real: PlaybackState["decodeStall"];
    key: string;
    mapped: PlaybackState["decodeStall"];
  } | null = null;

  /** The state of the playback store on the virtual axis. */
  const mapState = (real: PlaybackState, state: TimelineState): PlaybackState => {
    const mapping = mappingOf(state);
    if (mapping === null) {
      if (!isSequence(state)) {
        return real;
      }
      // A sequence whose clip on screen is not known yet, before the first attach of a clip or
      // after the attached clip left: a source position would read as a virtual one, so no
      // position shows.
      return {
        ...real,
        presentedFrame: null,
        seekTargetSeconds: null,
        approximateBrowserTimeSeconds: null,
        playbackStop: null,
        attachedSourceRevisionKey: real.isAttached ? state.sourceRevisionKey : null,
      };
    }
    // The mapping of a clip changes when the clip, its place, or the axis changes.
    const key = `${mapping.clipId}:${mapping.clip.startTicks}:${mapping.timeline.originPts}:${mapping.timeline.timeBase.n}/${mapping.timeline.timeBase.d}`;
    const add = (seconds: number | null): number | null =>
      seconds === null ? null : seconds + mapping.offsetSeconds;
    const framePts =
      real.presentedFrame === null
        ? null
        : toVirtual(mapping, real.presentedFrame.inferredSourcePts);
    const total = mapping.timeline.totalTicks;
    const totalSeconds =
      total === null
        ? null
        : (Number(total) * mapping.timeline.timeBase.n) / mapping.timeline.timeBase.d;
    if (
      frameMemo === null ||
      frameMemo.real !== real.presentedFrame ||
      frameMemo.key !== key
    ) {
      frameMemo = {
        real: real.presentedFrame,
        key,
        mapped:
          real.presentedFrame === null || framePts === null
            ? null
            : { ...real.presentedFrame, inferredSourcePts: framePts },
      };
    }
    if (
      stopMemo === null ||
      stopMemo.real !== real.playbackStop ||
      stopMemo.key !== key
    ) {
      stopMemo = {
        real: real.playbackStop,
        key,
        mapped: mapStop(mapping, real.playbackStop),
      };
    }
    if (
      stallMemo === null ||
      stallMemo.real !== real.decodeStall ||
      stallMemo.key !== key
    ) {
      stallMemo = {
        real: real.decodeStall,
        key,
        mapped:
          real.decodeStall === null
            ? null
            : {
                ...real.decodeStall,
                atSeconds: real.decodeStall.atSeconds + mapping.offsetSeconds,
              },
      };
    }
    return {
      ...real,
      presentedFrame: frameMemo.mapped,
      seekTargetSeconds: add(real.seekTargetSeconds),
      approximateBrowserTimeSeconds: add(real.approximateBrowserTimeSeconds),
      runtimeBrowserDurationSeconds:
        totalSeconds !== null && Number.isFinite(totalSeconds) ? totalSeconds : null,
      playbackStop: stopMemo.mapped,
      // A trim, a scrub or a stop belongs to the sequence: an attach of another clip is not a new
      // source for them (ADR 030 note of 2026-10-28). Nor is the new element of a recalibration
      // of the clip on screen (ADR 063).
      attachedSourceRevisionKey:
        real.isAttached || pending !== null || settling || real.isRecalibrating
          ? state.sourceRevisionKey
          : null,
      decodeStall: stallMemo.mapped,
    };
  };

  const run = (navigation: Navigation): void => {
    const real = playback.getState();
    switch (navigation.kind) {
      case "pts":
        real.seekToPts(navigation.pts, navigation.options);
        return;
      case "seconds":
        real.seekApproximate(navigation.seconds, navigation.options);
        return;
      case "frame":
        real.seekToFrameIndex(navigation.frameIndex, navigation.options);
        return;
      case "segment":
        real.playSegment(navigation.inPts, navigation.outPts);
        return;
      case "part":
        startPartOnStore(navigation);
        return;
    }
  };

  /**
   * True when the run needs the calibration of the clip before it asks for the part: the store
   * refuses a segment playback while the calibration is open (ADR 074).
   */
  const waitsForCalibration = (navigation: Navigation): boolean =>
    navigation.kind === "part" &&
    playback.getState().calibrationStatus === "calibrating";

  /**
   * The one clip of the timeline while a recalibration replaces its element and the new element
   * has no metadata yet, or null (ADR 063). The store refuses a seek in that time, and a failed
   * seek would also drop the request of the reload. A seek of the user then waits as a navigation
   * of that clip until the new element is ready, as a seek on a clip of a sequence does, and it
   * replaces the request of the reload there as the latest request.
   */
  const onlyClipWhileReplacementLoads = (state: TimelineState): string | null => {
    const real = playback.getState();
    const only = state.clips.length === 1 ? state.clips[0] : undefined;
    return only !== undefined && real.isRecalibrating && !real.isReady ? only.id : null;
  };

  /** Runs a navigation on the playback store now, or after the attach of its clip. */
  const navigate = (navigation: Navigation, play = false): void => {
    const state = timeline.getState();
    const real = playback.getState();
    const realKey = real.attachedSourceRevisionKey;
    state.setAttachedClip(navigation.clipId);
    if (
      realKey !== null &&
      revisionKeyOfClip(navigation.clipId) === realKey &&
      real.isReady &&
      !waitsForCalibration(navigation)
    ) {
      // The playback store shows the source of this clip already, and its element is ready:
      // two clips of one source share an element, so the seek needs no attach. An element that
      // is not ready yet, as a new element of a cold switch before its metadata, keeps the
      // navigation pending below, because a seek before it is ready fails (`flushPending`).
      mappedClipId = navigation.clipId;
      pending = null;
      run(navigation);
      if (play) {
        playback.getState().play();
      }
      return;
    }
    pending = { navigation, play };
    refresh();
  };

  /** Runs a pending navigation once the playback store attached the source of its clip. */
  /** True when the pending navigation can run now on the element that the store attached. */
  const pendingCanRun = (): boolean => {
    if (pending === null) {
      return false;
    }
    const real = playback.getState();
    const { navigation, play } = pending;
    if (
      !real.isAttached ||
      real.attachedSourceRevisionKey !== revisionKeyOfClip(navigation.clipId)
    ) {
      return false;
    }
    // A new element reports `readyState` 0, and a seek before it is ready fails. A play drops a
    // seek that waits for the calibration, and a segment playback is refused during it, so those
    // wait for the anchor of the new source too.
    if (!real.isReady) {
      return false;
    }
    return !(
      (play || navigation.kind === "segment" || navigation.kind === "part") &&
      real.calibrationStatus === "calibrating"
    );
  };

  const flushPending = (): void => {
    if (pending === null || !pendingCanRun()) {
      return;
    }
    const real = playback.getState();
    const { navigation, play } = pending;
    if (navigation.kind === "part") {
      // A part of a program play never starts inside a notification of a store: the read of
      // the run starts it in a task of its own (ADR 074), after the store call that made the
      // element ready returned, so it reads the length of the element at that time.
      if (programRun !== null) {
        scheduleRead(programRun);
      }
      return;
    }
    pending = null;
    settling = true;
    mappedClipId = navigation.clipId;
    run(navigation);
    if (play) {
      real.play();
    }
  };

  // True when the element paused at its end while it played: the pause that the element sends
  // before `ended` (`notePause`).
  let endedWhilePlaying = false;
  // True when that pause ended a segment playback of the playback store (`notePause`).
  let endedInSegment = false;

  // True from a navigation to another clip until that clip's source is calibrated: a cold switch.
  // Only the gestures of the timeline read it (`isSwitching`), so a scrub or a trim that crosses
  // a junction goes on and waits for the frame of the new clip (ADR 030 note of 2026-10-28). The
  // transport still sees a source that is not ready, so Play and a frame step stay off.
  //
  // A recalibration of that clip (ADR 063) replaces its element, and the detach of the old
  // element reports "unavailable" before the new element calibrates. The switch stays in progress
  // while the store reports `isRecalibrating`, so the gesture keeps its exact release seek.
  let settling = false;
  const isSwitching = (): boolean => {
    const real = playback.getState();
    // A failed request ends a switch, except while a recalibration replaces the element: the
    // failure drops only the request, and the new element still loads (ADR 063).
    if (real.error !== null && !real.isRecalibrating) {
      return false;
    }
    return (
      pending !== null ||
      (settling && (real.calibrationStatus === "calibrating" || real.isRecalibrating))
    );
  };

  /**
   * A navigation from the interface ends a Play Segment that crosses a junction, and drops a
   * navigation that waits for an attach: the clip on screen stays attached.
   */
  const userNavigates = (): void => {
    playingTo = null;
    endedWhilePlaying = false;
    if (pending !== null) {
      pending = null;
      if (mappedClipId !== null) {
        timeline.getState().setAttachedClip(mappedClipId);
      }
    }
  };

  /**
   * Ends the play intent of the sequence and keeps its navigation (ADR 070): a segment playback
   * that crosses a junction ends, and a navigation that waits for an attach stays as a seek with
   * no play (`withoutPlay`).
   */
  const stripPlayIntent = (): void => {
    playingTo = null;
    endedWhilePlaying = false;
    if (pending !== null) {
      pending = withoutPlay(pending.navigation);
    }
  };

  // The depth of the actions of the interface that run (`asNavigation`).
  let actionDepth = 0;

  /**
   * Runs an action of the interface, and maps the state once, at the end of the outermost action.
   * While it runs, `refresh` maps nothing: the writes of the action to the timeline store and to
   * the playback store, and a drop of a pending navigation (`userNavigates`), all publish as one
   * state. So no listener sees the state between the drop of one navigation and the navigation
   * that replaces it: the trim session would take that state for the end of the switch. The map at
   * the end also follows a drop that no store write follows, so `switching` cannot stay stale.
   */
  const asNavigation =
    <A extends unknown[], R>(action: (...args: A) => R) =>
    (...args: A): R => {
      actionDepth += 1;
      try {
        return action(...args);
      } finally {
        actionDepth -= 1;
        if (actionDepth === 0) {
          refresh();
        }
      }
    };

  /**
   * An action of another caller than the run (ADR 074): it first ends a program play that runs,
   * as the user takes the playback (`endProgramPlay`), and then runs. The run never calls the
   * actions of this store: it calls the playback store and the navigation of this module
   * directly. So each call of a wrapped action comes from another caller.
   */
  const endsRun =
    <A extends unknown[], R>(action: (...args: A) => R) =>
    (...args: A): R => {
      if (programRun !== null) {
        endProgramPlay();
      }
      return action(...args);
    };

  /** An action of the interface (`asNavigation`) that another caller than the run calls. */
  const asUserAction = <A extends unknown[], R>(action: (...args: A) => R) =>
    asNavigation(endsRun(action));

  /** The state of the run for the interface, or null with no run. */
  const programRunState = (): ProgramRunState | null => {
    const run = programRun;
    if (run === null) {
      programRunMemo = null;
      return null;
    }
    const part = run.index + 1;
    const count = run.parts.length;
    if (
      programRunMemo === null ||
      programRunMemo.action !== run.action ||
      programRunMemo.part !== part ||
      programRunMemo.count !== count
    ) {
      programRunMemo = { action: run.action, part, count };
    }
    return programRunMemo;
  };

  const store = createStore<SequencePlaybackState>()(() => ({
    switching: false,
    programRun: null,
    ...mapState(stateOf(playback.getState()), timeline.getState()),

    seekToPts: asUserAction((pts: Pts, options?: SeekOptions) => {
      userNavigates();
      const state = timeline.getState();
      if (!isSequence(state) || state.virtual === null) {
        const clipId = onlyClipWhileReplacementLoads(state);
        if (clipId !== null) {
          navigate({ kind: "pts", clipId, pts, options });
          return;
        }
        playback.getState().seekToPts(pts, options);
        return;
      }
      const clip = clipAtVirtualPts(state.virtual, pts);
      const sourcePts =
        clip === null ? null : nearestSourcePts(state.virtual, clip, pts);
      if (clip === null || sourcePts === null) {
        return;
      }
      navigate({ kind: "pts", clipId: clip.clipId, pts: sourcePts, options });
    }),

    seekApproximate: asUserAction((seconds: number, options?: SeekOptions) => {
      userNavigates();
      const state = timeline.getState();
      if (!isSequence(state)) {
        const clipId = onlyClipWhileReplacementLoads(state);
        if (clipId !== null) {
          navigate({ kind: "seconds", clipId, seconds, options });
          return;
        }
        playback.getState().seekApproximate(seconds, options);
        return;
      }
      const layout = layoutSequence(
        state.clips,
        new Map(Object.entries(state.sequenceSources)),
        new Map(Object.entries(state.browserDurations)),
      );
      const location = layout === null ? null : locate(layout, Math.max(0, seconds));
      if (location === null) {
        return;
      }
      navigate({
        kind: "seconds",
        clipId: location.clipId,
        seconds: location.elapsedSeconds,
        options,
      });
    }),

    seekNominal: asUserAction(
      (deltaFrames: number, options?: FrameStepOptions): FrameStepOutcome => {
        // The store refuses a step while its element is stalled or being replaced, so the
        // navigation of the sequence stays as it is (refusesTransportForReload, ADR 063).
        if (playback.getState().refusesTransportForReload()) {
          return "none";
        }
        userNavigates();
        const state = timeline.getState();
        const mapping = mappingOf(state);
        const frame = playback.getState().presentedFrame;
        const range = mapping?.clip.rangeStart ?? null;
        const interval = mapping === null ? null : intervalTicksOf(mapping.clipId);
        const next =
          mapping === null ? undefined : mapping.timeline.clips[mapping.clip.index + 1];
        if (mapping !== null && frame !== null && range !== null && interval !== null) {
          // A step past the last frame of a clip goes to the first frame of the next clip, and a
          // step back from the first frame goes to the last frame of the clip before it (ADR 052).
          const pts = ptsToBigInt(frame.inferredSourcePts);
          const end = clipEndPts(mapping.clip);
          const previous =
            mapping.clip.index > 0
              ? mapping.timeline.clips[mapping.clip.index - 1]
              : undefined;
          // The last frame starts one interval before the end. Half an interval of slack keeps a
          // frame whose PTS is rounded, as in a millisecond time base, on the right side. Only an
          // exact extent names that end. An estimate can lie before or after the last frame, so
          // the step of such a clip goes to the playback store, and the clip ends where that store
          // cannot step on (below).
          if (
            deltaFrames > 0 &&
            mapping.clip.exactDuration &&
            next?.rangeStart != null &&
            end !== null &&
            pts * 2n >= end * 2n - interval * 3n
          ) {
            navigate({
              kind: "pts",
              clipId: next.clipId,
              pts: ptsFromBigInt(next.rangeStart),
            });
            return "stepped";
          }
          const previousEnd = previous === undefined ? null : clipEndPts(previous);
          if (
            // The first frame shown can lie after the start of the range (ADR 046), so a step
            // back crosses from within half an interval of it.
            deltaFrames < 0 &&
            previous !== undefined &&
            previousEnd !== null &&
            pts * 2n <= range * 2n + interval
          ) {
            // One tick before the end lies in the last frame, and the seek shows that frame.
            navigate({
              kind: "pts",
              clipId: previous.clipId,
              pts: ptsFromBigInt(previousEnd - 1n),
            });
            return "stepped";
          }
        }
        const outcome = playback.getState().seekNominal(deltaFrames, options);
        // On a clip whose extent is an estimate, a forward step that the playback store cannot
        // make ends the clip. The store stops at its own end of the source: the end of the element,
        // or an earlier end that the probe gives. When another clip follows, the step goes on at
        // the first frame of that clip. A clip with an exact extent keeps the rule above, because
        // the store can stop before the last frame of the range, and a step there must not skip it.
        if (
          outcome === "edge" &&
          deltaFrames > 0 &&
          mapping !== null &&
          !mapping.clip.exactDuration &&
          next?.rangeStart != null
        ) {
          navigate({
            kind: "pts",
            clipId: next.clipId,
            pts: ptsFromBigInt(next.rangeStart),
          });
          return "stepped";
        }
        return outcome;
      },
    ),

    seekToFrameIndex: asUserAction(
      (frameIndex: number, options?: FrameIndexSeekOptions) => {
        userNavigates();
        const state = timeline.getState();
        if (!isSequence(state) || state.virtual === null) {
          const clipId = onlyClipWhileReplacementLoads(state);
          if (clipId !== null) {
            navigate({ kind: "frame", clipId, frameIndex, options });
            return;
          }
          playback.getState().seekToFrameIndex(frameIndex, options);
          return;
        }
        // A frame index of the sequence count exists only on one common rate, where every clip
        // starts on a whole frame (`sequenceNominalRate`). The index then becomes a frame index of
        // its clip.
        const rate = sequenceNominalRate(state, dependencies.media());
        if (rate === null || !Number.isSafeInteger(frameIndex) || frameIndex < 0) {
          return;
        }
        // The middle of the frame, so a float error at a junction cannot give the clip before.
        const seconds = ((frameIndex + 0.5) * rate.d) / rate.n;
        const layout = layoutSequence(
          state.clips,
          new Map(Object.entries(state.sequenceSources)),
          new Map(Object.entries(state.browserDurations)),
        );
        const location = layout === null ? null : locate(layout, seconds);
        const start =
          location === null ? null : clipStartSeconds(state.virtual, location.clipId);
        if (location === null || start === null) {
          return;
        }
        const clipFrames = Math.round((start * rate.n) / rate.d);
        navigate({
          kind: "frame",
          clipId: location.clipId,
          frameIndex: frameIndex - clipFrames,
          options,
        });
      },
    ),

    playSegment: asUserAction((inPts: Pts, outPts: Pts) => {
      // The store refuses Play Segment while its element is stalled or being replaced. The seek
      // to the In of a segment that crosses a junction would otherwise replace the request of
      // the reload.
      if (playback.getState().refusesTransportForReload()) {
        return;
      }
      userNavigates();
      const state = timeline.getState();
      if (!isSequence(state) || state.virtual === null) {
        playback.getState().playSegment(inPts, outPts);
        return;
      }
      const inClip = clipAtVirtualPts(state.virtual, inPts);
      const sourceIn =
        inClip === null ? null : fromVirtualPts(state.virtual, inPts, inClip.clipId);
      if (inClip === null || sourceIn === null) {
        return;
      }
      const sourceOut = fromVirtualPts(state.virtual, outPts, inClip.clipId);
      const end = clipEndPts(inClip);
      if (sourceOut !== null && (end === null || ptsToBigInt(sourceOut.pts) <= end)) {
        navigate({
          kind: "segment",
          clipId: inClip.clipId,
          inPts: sourceIn.pts,
          outPts: sourceOut.pts,
        });
        return;
      }
      // A segment that crosses a junction plays from its In, and the playback goes on across the
      // junction until its Out (`handleEnded`).
      navigate({ kind: "pts", clipId: inClip.clipId, pts: sourceIn.pts }, true);
      playingTo = outPts;
    }),

    // Every other action and every sync of the element goes to the playback store unchanged. A
    // reload of a stalled element, `resumeAfterSeek` and `reset` first end a program play that
    // runs (`endsRun`), and so do the actions of the interface above (`asUserAction`).
    attach: (...args) => playback.getState().attach(...args),
    detach: (...args) => playback.getState().detach(...args),
    syncReady: (...args) => playback.getState().syncReady(...args),
    syncUnready: (...args) => playback.getState().syncUnready(...args),
    primeFirstFrame: (...args) => playback.getState().primeFirstFrame(...args),
    syncDecodeStall: (...args) => playback.getState().syncDecodeStall(...args),
    reloadStalledPreview: endsRun((sourceRevisionKey: string) => {
      // With one clip the key passes through, so the playback store refuses an old one. On a
      // sequence the key of the interface is the key of the sequence, so the attached key stands.
      const key = isSequence(timeline.getState())
        ? playback.getState().attachedSourceRevisionKey
        : sourceRevisionKey;
      if (key !== null) {
        playback.getState().reloadStalledPreview(key);
      }
    }),
    // A recalibration is a navigation of the user (ADR 063): it ends a segment playback that
    // crosses a junction and drops a navigation that waits for an attach, so the clip on screen
    // stays. It is not a cold switch, and it keeps the mapped clip. The key passes as for
    // `reloadStalledPreview`. The store reads the position from its own state, in seconds of the
    // attached source, so no sequence time enters the request.
    recalibrate: asUserAction((sourceRevisionKey: string) => {
      // A recalibration that the store refuses changes nothing here either, so a navigation
      // that waits for an attach stays.
      if (!playback.getState().canRecalibrate) {
        return;
      }
      userNavigates();
      const key = isSequence(timeline.getState())
        ? playback.getState().attachedSourceRevisionKey
        : sourceRevisionKey;
      if (key !== null) {
        playback.getState().recalibrate(key);
      }
    }),
    // The replacement of the element for a new audio stream (ADR 070). The preview passes the
    // revision key of the source of its element, not the key of the interface, so the key passes
    // through and the playback store refuses an old one. It is not a navigation of the user: a
    // navigation that waits for the attach of a clip stays, and it runs on the new element. The
    // store stops the playback, and the playback does not start again: a segment playback that
    // crosses a junction ends here too, and a navigation that waits keeps its seek and loses its
    // play. A replacement that the store refuses changes nothing here.
    replacePreviewElement: asNavigation((sourceRevisionKey: string) => {
      const generation = playback.getState().reloadGeneration;
      playback.getState().replacePreviewElement(sourceRevisionKey);
      if (playback.getState().reloadGeneration !== generation) {
        stripPlayIntent();
      }
    }),
    isRetiredElement: (...args) => playback.getState().isRetiredElement(...args),
    refusesTransportForReload: () => playback.getState().refusesTransportForReload(),
    syncAnchorWaitExpired: (...args) =>
      playback.getState().syncAnchorWaitExpired(...args),
    togglePlayback: asUserAction(() => {
      // The store plays nothing while its element is stalled or being replaced (ADR 063).
      if (playback.getState().refusesTransportForReload()) {
        return;
      }
      userNavigates();
      playback.getState().togglePlayback();
    }),
    play: asUserAction(() => {
      if (playback.getState().refusesTransportForReload()) {
        return;
      }
      userNavigates();
      playback.getState().play();
    }),
    pause: asUserAction(() => {
      userNavigates();
      playback.getState().pause();
    }),
    resumeAfterSeek: endsRun(() => playback.getState().resumeAfterSeek()),
    syncPresentedFrame: (...args) => playback.getState().syncPresentedFrame(...args),
    syncPresentationUnavailable: (...args) =>
      playback.getState().syncPresentationUnavailable(...args),
    syncExpectedFirstFrame: (...args) =>
      playback.getState().syncExpectedFirstFrame(...args),
    denySourcePrecision: (...args) => playback.getState().denySourcePrecision(...args),
    syncFrameTable: (...args) => playback.getState().syncFrameTable(...args),
    repairSeek: (...args) => playback.getState().repairSeek(...args),
    syncBrowserDuration: (...args) => playback.getState().syncBrowserDuration(...args),
    syncBrowserTime: (...args) => playback.getState().syncBrowserTime(...args),
    syncSeeking: (...args) => playback.getState().syncSeeking(...args),
    syncSeeked: (...args) => playback.getState().syncSeeked(...args),
    syncPlay: (...args) => playback.getState().syncPlay(...args),
    syncPause: (...args) => playback.getState().syncPause(...args),
    syncEnded: (...args) => playback.getState().syncEnded(...args),
    dismissError: (...args) => playback.getState().dismissError(...args),
    calibrationAnchorMediaTime: () => playback.getState().calibrationAnchorMediaTime(),
    reset: endsRun(() => playback.getState().reset()),
  }));

  /**
   * Maps the state again after a change of either store. Nothing notifies the interface when no
   * mapped field changed: a write of the timeline alone, such as an edit, must not look like a
   * change of the playback to a listener of this store (the trim session waits on it). During an
   * action of the interface it maps nothing, and the action maps once at its end (`asNavigation`).
   */
  const refresh = (): void => {
    if (actionDepth > 0) {
      return;
    }
    const clips = timeline.getState().clips;
    if (
      pending !== null &&
      !clips.some((clip) => clip.id === pending?.navigation.clipId)
    ) {
      // The clip of the navigation left the sequence, so its attach never comes.
      pending = null;
    }
    flushPending();
    const settledState = playback.getState();
    if (
      settling &&
      settledState.calibrationStatus !== "calibrating" &&
      !settledState.isRecalibrating
    ) {
      settling = false;
    }
    const next = {
      ...mapState(stateOf(playback.getState()), timeline.getState()),
      switching: isSwitching(),
      programRun: programRunState(),
    };
    const current = store.getState();
    const changed = (Object.keys(next) as (keyof typeof next)[]).some(
      (field) => !Object.is(next[field], current[field]),
    );
    if (changed) {
      store.setState(next);
    }
  };
  playback.subscribe(refresh);
  timeline.subscribe(refresh);
  playback.subscribe(() => notePlaybackChange());
  timeline.subscribe(() => {
    if (programRun !== null) {
      scheduleRead(programRun);
    }
  });

  const notePause = (ended: boolean): void => {
    const real = playback.getState();
    endedWhilePlaying = ended && real.isPlaying;
    // A segment playback that reaches the end of its clip ends there: its Out is the end of that
    // clip, and the playback store stops it at the end of the element.
    endedInSegment = ended && real.playbackStop?.phase === "playing";
  };

  const forgetPauseAtEnd = (): void => {
    endedWhilePlaying = false;
    endedInSegment = false;
  };

  const handleEnded = (): boolean => {
    // While a program play runs, the run alone decides what plays next (ADR 074). The end of a
    // clip does not go on at the next clip, and the store then syncs the end, as it does for a
    // segment playback.
    if (programRun !== null) {
      endedWhilePlaying = false;
      endedInSegment = false;
      playingTo = null;
      return false;
    }
    const state = timeline.getState();
    const mapping = mappingOf(state);
    const played = endedWhilePlaying || playback.getState().isPlaying;
    const segmentEnded = endedInSegment;
    endedWhilePlaying = false;
    endedInSegment = false;
    // The continuation on the next clip needs an element that played to its end. An end with no
    // playback, as after a scrub of the system to the end, continues nothing, and the play intent
    // of a Play Segment across the junction goes with it (ADR 074). The play intent only gives
    // the Out on the next clip.
    if (!played) {
      playingTo = null;
      return false;
    }
    if (mapping === null || (segmentEnded && playingTo === null)) {
      return false;
    }
    const next = mapping.timeline.clips[mapping.clip.index + 1];
    if (next === undefined || next.rangeStart === null) {
      playingTo = null;
      return false;
    }
    const start = ptsFromBigInt(next.rangeStart);
    const out =
      playingTo === null
        ? null
        : fromVirtualPts(mapping.timeline, playingTo, next.clipId);
    const end = clipEndPts(next);
    if (out !== null && (end === null || ptsToBigInt(out.pts) <= end)) {
      // The Out of the segment lies on this clip: the playback store stops there, as it does for
      // a segment on one clip.
      playingTo = null;
      navigate({ kind: "segment", clipId: next.clipId, inPts: start, outPts: out.pts });
      return true;
    }
    navigate({ kind: "pts", clipId: next.clipId, pts: start }, true);
    return true;
  };

  const seekToClipFrame = asUserAction((clipId: string, frameIndex: number): void => {
    if (
      !Number.isSafeInteger(frameIndex) ||
      frameIndex < 0 ||
      !timeline.getState().clips.some((clip) => clip.id === clipId)
    ) {
      return;
    }
    userNavigates();
    navigate({ kind: "frame", clipId, frameIndex });
  });

  const dropNavigation = asUserAction((): void => {
    if (pending !== null) {
      userNavigates();
    }
  });

  const dropPlayIntent = asUserAction((): void => {
    stripPlayIntent();
  });

  // The key of the program (`programKey`) of the last timeline inputs that a run compared.
  let programMemo: {
    readonly clips: TimelineState["clips"];
    readonly sequenceSegments: TimelineState["sequenceSegments"];
    readonly sequenceSources: TimelineState["sequenceSources"];
    readonly segments: TimelineState["segments"];
    readonly sourceId: TimelineState["sourceId"];
    readonly generation: number;
    readonly key: string;
  } | null = null;

  /**
   * The key of the program of the timeline now. It is computed again only when an input of the
   * program changed identity, so the reads of a run at each frame stay cheap.
   */
  const programKeyNow = (): string => {
    const state = timeline.getState();
    const memo = programMemo;
    if (
      memo !== null &&
      memo.clips === state.clips &&
      memo.sequenceSegments === state.sequenceSegments &&
      memo.sequenceSources === state.sequenceSources &&
      memo.segments === state.segments &&
      memo.sourceId === state.sourceId &&
      memo.generation === state.generation
    ) {
      return memo.key;
    }
    const key = programKey(state);
    programMemo = {
      clips: state.clips,
      sequenceSegments: state.sequenceSegments,
      sequenceSources: state.sequenceSources,
      segments: state.segments,
      sourceId: state.sourceId,
      generation: state.generation,
      key,
    };
    return key;
  };

  /** True when the store published "reached" for the accepted part of `run`. */
  const hasReached = (run: ProgramRun, real: PlaybackState): boolean =>
    run.stage === "accepted" &&
    (run.reached ||
      (real.segmentPlayback !== null &&
        real.segmentPlayback.id === run.acceptedId &&
        real.segmentPlayback.reached));

  /** True when the stop point of the accepted part of `run` is still set. */
  const holdsStop = (run: ProgramRun, real: PlaybackState): boolean =>
    real.playbackStop !== null && real.segmentPlayback?.id === run.acceptedId;

  /**
   * Starts the watchdog of the current part of `run` (PROGRAM_PART_TIMEOUT_MS), and cancels the
   * one before it. Each run and each part has one watchdog at most, and a watchdog whose run or
   * part is no longer current does nothing (`onPartTimer`).
   */
  const startWatchdog = (run: ProgramRun): void => {
    run.cancelTimer?.();
    const token = run.partToken;
    run.cancelTimer = timer(() => onPartTimer(run, token), PROGRAM_PART_TIMEOUT_MS);
  };

  /**
   * True when the playback failed since the last read: a new error, a new decode stall, or a new
   * element of a reload, as for another audio track (ADR 070) or a recalibration (ADR 063). The
   * attach of another clip changes none of these.
   */
  const failedSince = (watch: ProgramRunWatch, real: PlaybackState): boolean =>
    (real.error !== null && real.error !== watch.error) ||
    (real.decodeStall !== null && real.decodeStall !== watch.decodeStall) ||
    real.reloadGeneration !== watch.reloadGeneration;

  /**
   * Ends the run before the end of its last part, and does the three things of ADR 074: it
   * pauses, it drops the stop point of the part, and a request of the run that waits for the
   * attach of a clip becomes a seek to the start of its part with no play (`withoutPlay`). The
   * pause of the store drops the stop point, also while the seek to the start of the part runs.
   * It is left out while the request waits on the element of its own clip and nothing plays:
   * that element loads, and the pause would stop its first-frame prime (ADR 003). Returns false
   * with no run.
   */
  const endRunEarly = (): boolean => {
    const run = programRun;
    if (run === null) {
      return false;
    }
    programRun = null;
    run.cancelTimer?.();
    run.cancelTimer = null;
    if (pending !== null && pending.navigation.kind === "part") {
      pending = withoutPlay(pending.navigation);
    }
    const real = playback.getState();
    const loads =
      pending !== null &&
      real.attachedSourceRevisionKey !== null &&
      real.attachedSourceRevisionKey === revisionKeyOfClip(pending.navigation.clipId) &&
      !real.isPlaying;
    if (!loads) {
      real.pause();
    }
    return true;
  };

  const endProgramPlay = asNavigation((): boolean => endRunEarly());

  const notePreviewFailure = asNavigation((sourceRevisionKey: string): void => {
    const run = programRun;
    const part = run === null ? undefined : run.parts[run.index];
    if (part !== undefined && revisionKeyOfClip(part.clipId) === sourceRevisionKey) {
      endRunEarly();
    }
  });

  /**
   * Reads the state of the stores for `run` in a microtask of its own, after the call of the store
   * that made the change returned. One read waits at most for each part, and a read for an
   * earlier part, or after the run ended, does nothing.
   */
  const scheduleRead = (run: ProgramRun): void => {
    if (run.scheduledToken === run.partToken) {
      return;
    }
    const token = run.partToken;
    run.scheduledToken = token;
    queueMicrotask(() => {
      if (run.scheduledToken === token) {
        run.scheduledToken = null;
      }
      if (programRun !== run || run.partToken !== token) {
        return;
      }
      readRun(run);
    });
  };

  /**
   * A change of the playback store during a run. It notes "reached" for the accepted part at
   * once, so a later write in the same task cannot hide it, and it leaves the rest to the read.
   *
   * It is also the watchdog of progress (ADR 074): it sees each write of the store, and while
   * the store holds the stop point and the number of the accepted part, a clock of the element
   * that is not the clock of the write before starts PROGRAM_PART_TIMEOUT_MS again. The
   * acceptance of the part starts it again too (`startPartOnStore`). Nothing else does: a frame,
   * a play, the display target and a clock before the acceptance do not. The comparison starts
   * from the clock when the store accepted the part.
   */
  const notePlaybackChange = (): void => {
    const run = programRun;
    if (run === null) {
      return;
    }
    const real = playback.getState();
    if (hasReached(run, real)) {
      run.reached = true;
    }
    if (run.stage === "accepted" && holdsStop(run, real)) {
      const clock = real.approximateBrowserTimeSeconds;
      if (clock !== run.clock) {
        run.clock = clock;
        startWatchdog(run);
      }
    }
    scheduleRead(run);
  };

  /**
   * Starts the part of `run` that waits for its element, once that element and its calibration
   * are ready (`pendingCanRun`). Only the read of the run calls it, in a task of its own.
   */
  const startWaitingPart = (run: ProgramRun): void => {
    const waiting = pending;
    if (run.stage !== "loading" || waiting === null || !pendingCanRun()) {
      return;
    }
    const navigation = waiting.navigation;
    if (navigation.kind !== "part" || navigation.partToken !== run.partToken) {
      return;
    }
    pending = null;
    settling = true;
    mappedClipId = navigation.clipId;
    startPartOnStore(navigation);
  };

  /** The part of `run` completed: the run goes on at the next part, or ends after the last. */
  const completePart = (run: ProgramRun): void => {
    run.stage = "completed";
    run.cancelTimer?.();
    run.cancelTimer = null;
    if (run.index + 1 >= run.parts.length) {
      // The stop point of the last part stays, as after Play Segment (ADR 022).
      programRun = null;
      return;
    }
    startPart(run, run.index + 1);
  };

  /**
   * The checks of a read of the run and of its timer (ADR 074), in this order:
   *
   * 1. a change of the program, and a failure (a new error, a new decode stall, a reload) end
   *    the run, also when the part reached its stop in the same task: the next part does not
   *    start on a program that changed or on a playback that failed;
   * 2. "reached" for the number of the part completes it. It comes before the stop point that
   *    went, so a handler of the store that drops the stop point and then publishes "reached" is
   *    one event;
   * 3. a part that the store refused ends the run;
   * 4. a stop point that went ends the run.
   *
   * Returns true when the run ended or the part completed.
   */
  const checkRun = (run: ProgramRun, real: PlaybackState): boolean => {
    if (programKeyNow() !== run.program) {
      endRunEarly();
      return true;
    }
    const watch = run.watch;
    run.watch = watchOf(real);
    if (failedSince(watch, real)) {
      endRunEarly();
      return true;
    }
    if (hasReached(run, real)) {
      completePart(run);
      return true;
    }
    if (run.stage === "refused") {
      endRunEarly();
      return true;
    }
    if (run.stage === "accepted" && !holdsStop(run, real)) {
      endRunEarly();
      return true;
    }
    return false;
  };

  /**
   * The read of a run, in a microtask of its own (`scheduleRead`). After the checks, a part that
   * waits for its element starts when that element and its calibration are ready.
   */
  const readRun = asNavigation((run: ProgramRun): void => {
    if (!checkRun(run, playback.getState())) {
      startWaitingPart(run);
    }
  });

  /**
   * The end of the watchdog of a part: no progress for PROGRAM_PART_TIMEOUT_MS. It runs the
   * checks of a read first, and a part that did not complete then fails the run.
   */
  const onPartTimer = asNavigation((run: ProgramRun, token: number): void => {
    if (programRun !== run || run.partToken !== token) {
      return;
    }
    if (checkRun(run, playback.getState())) {
      return;
    }
    endRunEarly();
  });

  /** Starts part `index` of `run`: its timer, and the navigation to its clip. */
  const startPart = (run: ProgramRun, index: number): void => {
    const part = run.parts[index];
    if (part === undefined) {
      return;
    }
    lastPartToken += 1;
    const token = lastPartToken;
    run.index = index;
    run.partToken = token;
    run.stage = "loading";
    run.acceptedId = null;
    run.reached = false;
    run.clock = null;
    startWatchdog(run);
    navigate({
      kind: "part",
      clipId: part.clipId,
      inPts: part.startPts,
      outPts: part.endPts,
      partToken: token,
    });
  };

  /**
   * True unless the start of the part lies at or after the end of the media that the element
   * reports. With no length of the element, or no anchor, nothing is known here, and the store
   * decides.
   */
  const startsBeforeMediaEnd = (navigation: {
    clipId: string;
    inPts: Pts;
  }): boolean => {
    const real = playback.getState();
    const duration = real.runtimeBrowserDurationSeconds;
    const anchor = real.calibrationAnchorMediaTime();
    const probe = mediaOfClip(navigation.clipId)?.probe;
    if (
      duration === null ||
      anchor === null ||
      probe === undefined ||
      probe.videoStartPts === null
    ) {
      return true;
    }
    const time = ptsToMediaTime(
      navigation.inPts,
      probe.videoStartPts,
      anchor,
      probe.videoTimeBase,
    );
    return time === null || time < duration;
  };

  /**
   * Asks the playback store for the segment playback of a part, once the element of its clip and
   * the calibration are ready: at once in the task that starts the part when its clip is on
   * screen and ready (`navigate`), or else in the read of the run (`startWaitingPart`), never
   * inside a notification of a store. The part started when the store accepted it: the
   * run keeps the number of `segmentPlayback`. A part that the store refuses, and a part whose
   * start is not before the end of the media, end the run at the next read.
   */
  function startPartOnStore(navigation: Navigation & { kind: "part" }): void {
    const run = programRun;
    const real = playback.getState();
    if (
      run === null ||
      run.partToken !== navigation.partToken ||
      run.stage !== "loading"
    ) {
      // A request of a run that ended: a seek to its start, with no play.
      real.seekToPts(navigation.inPts);
      return;
    }
    if (!startsBeforeMediaEnd(navigation)) {
      run.stage = "refused";
      scheduleRead(run);
      return;
    }
    const before = real.segmentPlayback;
    real.playSegment(navigation.inPts, navigation.outPts);
    if (programRun !== run || run.partToken !== navigation.partToken) {
      return;
    }
    const after = playback.getState().segmentPlayback;
    if (after !== null && after.id !== before?.id && !after.reached) {
      const accepted = playback.getState();
      run.stage = "accepted";
      run.acceptedId = after.id;
      run.watch = watchOf(accepted);
      // The acceptance is progress: the watchdog starts again, and it compares each later clock
      // with the clock at the acceptance of this part.
      run.clock = accepted.approximateBrowserTimeSeconds;
      startWatchdog(run);
    } else {
      run.stage = "refused";
    }
    scheduleRead(run);
  }

  const startProgramPlay = asNavigation(
    (action: ProgramAction, parts: readonly ProgramPart[]): boolean => {
      if (parts.length === 0) {
        return false;
      }
      endRunEarly();
      // The run alone decides what plays next: the play intent of a Play Segment across a
      // junction goes (ADR 052).
      playingTo = null;
      endedWhilePlaying = false;
      endedInSegment = false;
      const run: ProgramRun = {
        action,
        parts: [...parts],
        index: 0,
        partToken: 0,
        stage: "loading",
        acceptedId: null,
        reached: false,
        clock: null,
        cancelTimer: null,
        scheduledToken: null,
        watch: watchOf(playback.getState()),
        program: programKeyNow(),
      };
      programRun = run;
      startPart(run, 0);
      return true;
    },
  );

  return {
    store,
    handleEnded,
    notePause,
    forgetPauseAtEnd,
    isSwitching,
    seekToClipFrame,
    dropNavigation,
    dropPlayIntent,
    startProgramPlay,
    endProgramPlay,
    notePreviewFailure,
  };
}

/** The production sequence playback, over the production stores. */
export const sequencePlayback: SequencePlayback = createSequencePlayback({
  playback: playbackStore,
  timeline: timelineStore,
  media: () => mediaBySourceOf(mediaStore.getState()),
});

/**
 * Starts a manual recalibration of the clip on screen (ADR 063), for the buttons of the status
 * bar and of the preview timecode. It passes the key of the interface, and the sequence playback
 * maps it to the attached source. The store does nothing unless `canRecalibrate` is true.
 */
export function recalibratePreview(
  playback: SequencePlayback = sequencePlayback,
): void {
  const state = playback.store.getState();
  if (state.attachedSourceRevisionKey !== null) {
    state.recalibrate(state.attachedSourceRevisionKey);
  }
}

const defaultSelector = (state: SequencePlaybackState): SequencePlaybackState => state;

/**
 * React hook for the production sequence playback. It takes the selectors of the playback store.
 */
export function useSequencePlaybackStore(): SequencePlaybackState;
export function useSequencePlaybackStore<T>(
  selector: (state: SequencePlaybackState) => T,
): T;
export function useSequencePlaybackStore<T>(
  selector?: (state: SequencePlaybackState) => T,
): T | SequencePlaybackState {
  return useStore(
    sequencePlayback.store,
    (selector ?? defaultSelector) as (state: SequencePlaybackState) => T,
  );
}
