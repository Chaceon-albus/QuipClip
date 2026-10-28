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
 *   store. A seek on another clip attaches that clip first, and the seek runs after the attach: a
 *   cold switch (ADR 052);
 * - at the end of a clip, playback goes on at the first frame of the next clip (`handleEnded`).
 *
 * With one clip, every value and every request passes through unchanged.
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
import { ptsFromBigInt, ptsToBigInt } from "@/lib/time";
import type { Pts } from "@/types/project";
import { mediaBySourceOf } from "./media";
import { sequenceNominalRate, type MediaBySource } from "./virtualMedia";

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
);

/** Dependencies of `createSequencePlayback`, injected for tests. */
export interface SequencePlaybackDependencies {
  readonly playback: PlaybackStore;
  readonly timeline: TimelineStore;
  /** The media of every source of the session, by source ID. */
  readonly media: () => MediaBySource;
}

/**
 * The state of the sequence playback: the state of the playback store on the virtual axis, and
 * `switching`, true during a cold switch (`SequencePlayback.isSwitching`).
 */
export type SequencePlaybackState = PlaybackStoreState & {
  readonly switching: boolean;
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
   * it, with `element.ended`. The element sends `pause` before `ended` at its end, and the pause
   * ends the playing state, so this records that the element was playing when it reached the end.
   */
  readonly notePause: (ended: boolean) => void;
  /**
   * True during a cold switch: from a navigation to another clip until the source of that clip is
   * calibrated, unless the playback store reports an error. The timeline reads it, so a scrub or a
   * trim that crosses a junction is not cancelled while the new clip loads.
   */
  readonly isSwitching: () => boolean;
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
    isPlaying: real.isPlaying,
    isAttached: real.isAttached,
    attachedSourceRevisionKey: real.attachedSourceRevisionKey,
    isReady: real.isReady,
    error: real.error,
    decodeStall: real.decodeStall,
    reloadGeneration: real.reloadGeneration,
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
      // source for them (ADR 030 note of 2026-10-28).
      attachedSourceRevisionKey:
        real.isAttached || pending !== null || settling
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
    }
  };

  /** Runs a navigation on the playback store now, or after the attach of its clip. */
  const navigate = (navigation: Navigation, play = false): void => {
    const state = timeline.getState();
    const realKey = playback.getState().attachedSourceRevisionKey;
    state.setAttachedClip(navigation.clipId);
    if (realKey !== null && revisionKeyOfClip(navigation.clipId) === realKey) {
      // The playback store shows the source of this clip already: two clips of one source share
      // an element, so the seek needs no attach.
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
  const flushPending = (): void => {
    if (pending === null) {
      return;
    }
    const real = playback.getState();
    const { navigation, play } = pending;
    if (
      !real.isAttached ||
      real.attachedSourceRevisionKey !== revisionKeyOfClip(navigation.clipId)
    ) {
      return;
    }
    // A new element reports `readyState` 0, and a seek before it is ready fails. A play drops a
    // seek that waits for the calibration, and a segment playback is refused during it, so those
    // wait for the anchor of the new source too.
    if (!real.isReady) {
      return;
    }
    if (
      (play || navigation.kind === "segment") &&
      real.calibrationStatus === "calibrating"
    ) {
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
  let settling = false;
  const isSwitching = (): boolean => {
    const real = playback.getState();
    if (real.error !== null) {
      return false;
    }
    return pending !== null || (settling && real.calibrationStatus === "calibrating");
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

  const store = createStore<SequencePlaybackState>()(() => ({
    switching: false,
    ...mapState(stateOf(playback.getState()), timeline.getState()),

    seekToPts: (pts: Pts, options?: SeekOptions) => {
      userNavigates();
      const state = timeline.getState();
      if (!isSequence(state) || state.virtual === null) {
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
    },

    seekApproximate: (seconds: number, options?: SeekOptions) => {
      userNavigates();
      const state = timeline.getState();
      if (!isSequence(state)) {
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
    },

    seekNominal: (deltaFrames: number, options?: FrameStepOptions) => {
      userNavigates();
      const state = timeline.getState();
      const mapping = mappingOf(state);
      const frame = playback.getState().presentedFrame;
      const range = mapping?.clip.rangeStart ?? null;
      const interval = mapping === null ? null : intervalTicksOf(mapping.clipId);
      if (mapping !== null && frame !== null && range !== null && interval !== null) {
        // A step past the last frame of a clip goes to the first frame of the next clip, and a
        // step back from the first frame goes to the last frame of the clip before it (ADR 052).
        const pts = ptsToBigInt(frame.inferredSourcePts);
        const end = clipEndPts(mapping.clip);
        const next = mapping.timeline.clips[mapping.clip.index + 1];
        const previous =
          mapping.clip.index > 0
            ? mapping.timeline.clips[mapping.clip.index - 1]
            : undefined;
        // The last frame starts one interval before the end. Half an interval of slack keeps a
        // frame whose PTS is rounded, as in a millisecond time base, on the right side.
        if (
          deltaFrames > 0 &&
          next?.rangeStart != null &&
          end !== null &&
          pts * 2n >= end * 2n - interval * 3n
        ) {
          navigate({
            kind: "pts",
            clipId: next.clipId,
            pts: ptsFromBigInt(next.rangeStart),
          });
          return;
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
          return;
        }
      }
      playback.getState().seekNominal(deltaFrames, options);
    },

    seekToFrameIndex: (frameIndex: number, options?: FrameIndexSeekOptions) => {
      userNavigates();
      const state = timeline.getState();
      if (!isSequence(state) || state.virtual === null) {
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

    playSegment: (inPts: Pts, outPts: Pts) => {
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
    },

    // Every other action and every sync of the element goes to the playback store unchanged.
    attach: (...args) => playback.getState().attach(...args),
    detach: (...args) => playback.getState().detach(...args),
    syncReady: (...args) => playback.getState().syncReady(...args),
    syncUnready: (...args) => playback.getState().syncUnready(...args),
    syncDecodeStall: (...args) => playback.getState().syncDecodeStall(...args),
    reloadStalledPreview: (sourceRevisionKey) => {
      // With one clip the key passes through, so the playback store refuses an old one. On a
      // sequence the key of the interface is the key of the sequence, so the attached key stands.
      const key = isSequence(timeline.getState())
        ? playback.getState().attachedSourceRevisionKey
        : sourceRevisionKey;
      if (key !== null) {
        playback.getState().reloadStalledPreview(key);
      }
    },
    togglePlayback: () => {
      userNavigates();
      playback.getState().togglePlayback();
    },
    play: () => {
      userNavigates();
      playback.getState().play();
    },
    pause: () => {
      userNavigates();
      playback.getState().pause();
    },
    resumeAfterSeek: () => playback.getState().resumeAfterSeek(),
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
    reset: () => playback.getState().reset(),
  }));

  /**
   * Maps the state again after a change of either store. Nothing notifies the interface when no
   * mapped field changed: a write of the timeline alone, such as an edit, must not look like a
   * change of the playback to a listener of this store (the trim session waits on it).
   */
  const refresh = (): void => {
    const clips = timeline.getState().clips;
    if (
      pending !== null &&
      !clips.some((clip) => clip.id === pending?.navigation.clipId)
    ) {
      // The clip of the navigation left the sequence, so its attach never comes.
      pending = null;
    }
    flushPending();
    if (settling && playback.getState().calibrationStatus !== "calibrating") {
      settling = false;
    }
    const next = {
      ...mapState(stateOf(playback.getState()), timeline.getState()),
      switching: isSwitching(),
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

  const notePause = (ended: boolean): void => {
    const real = playback.getState();
    endedWhilePlaying = ended && real.isPlaying;
    // A segment playback that reaches the end of its clip ends there: its Out is the end of that
    // clip, and the playback store stops it at the end of the element.
    endedInSegment = ended && real.playbackStop?.phase === "playing";
  };

  const handleEnded = (): boolean => {
    const state = timeline.getState();
    const mapping = mappingOf(state);
    const played = endedWhilePlaying || playback.getState().isPlaying;
    const segmentEnded = endedInSegment;
    endedWhilePlaying = false;
    endedInSegment = false;
    if (
      mapping === null ||
      (!played && playingTo === null) ||
      (segmentEnded && playingTo === null)
    ) {
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

  return { store, handleEnded, notePause, isSwitching };
}

/** The production sequence playback, over the production stores. */
export const sequencePlayback: SequencePlayback = createSequencePlayback({
  playback: playbackStore,
  timeline: timelineStore,
  media: () => mediaBySourceOf(mediaStore.getState()),
});

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
