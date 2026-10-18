/**
 * The MediaSource controller and the PCM cue of the video element of a MediaSource source
 * (ADR 046), owned by the ref callback of the element.
 *
 * The owner creates both after the playback store attached the element, and destroys both when
 * the element leaves the tree. It connects their reports to the playback store and to the pane,
 * and installs the cue in the router of the store, so the bursts of the store play through Web
 * Audio while the source is open.
 */

import type { PlaybackStore } from "@/features/playback";
import type { ScrubCue } from "@/features/playback/cue";
import type {
  MseController,
  MseControllerEvents,
  MseFailure,
  MseSource,
  MseVideoElement,
} from "@/features/playback/mse/controller";
import type { PcmCue } from "@/features/playback/mse/pcmCue";
import { whenStoreReady } from "./mediaSourceRules";

/** What the owner needs to know of the open source. */
export interface MediaSourceTarget {
  readonly sourceRevisionKey: string;
  readonly source: MseSource;
  readonly hasAudio: boolean;
}

/** The store actions that the reports reach. */
export interface MediaSourceStoreActions {
  readonly syncExpectedFirstFrame: (
    sourceRevisionKey: string,
    element: HTMLVideoElement,
    mediaTime: number,
  ) => void;
  readonly syncPresentationUnavailable: (
    sourceRevisionKey: string,
    element: HTMLVideoElement,
  ) => void;
  readonly denySourcePrecision: (
    sourceRevisionKey: string,
    element: HTMLVideoElement,
  ) => void;
  /** The seek over a gap before the first frame. It keeps a running playback. */
  readonly seekOverGap: (mediaTime: number) => void;
  /**
   * Runs `run` once the store is ready for seeks, at once when it is ready now. Returns a
   * function that cancels a run that waits.
   */
  readonly whenReady: (run: () => void) => () => void;
}

/** The store actions of the owner on the playback store `store`. */
export function createMediaSourceStoreActions(
  store: PlaybackStore,
): MediaSourceStoreActions {
  return {
    syncExpectedFirstFrame: (key, element, mediaTime) =>
      store.getState().syncExpectedFirstFrame(key, element, mediaTime),
    syncPresentationUnavailable: (key, element) =>
      store.getState().syncPresentationUnavailable(key, element),
    denySourcePrecision: (key, element) =>
      store.getState().denySourcePrecision(key, element),
    // The anchor and the origin of the timeline are media time 0, so the media time of the
    // first frame is its position on the timeline.
    seekOverGap: (mediaTime) =>
      store.getState().seekApproximate(mediaTime, { keepPlaying: true, overGap: true }),
    whenReady: (run) => whenStoreReady(store, run),
  };
}

/** What the pane shows for the reports. */
export interface MediaSourcePaneReports {
  readonly onNonMonotonic: (sourceRevisionKey: string) => void;
  readonly onAudioOmitted: (sourceRevisionKey: string) => void;
  readonly onFailure: (
    sourceRevisionKey: string,
    element: HTMLVideoElement,
    failure: MseFailure,
  ) => void;
}

export interface MediaSourceOwnerDependencies {
  readonly createController: (
    element: MseVideoElement,
    source: MseSource,
    events: MseControllerEvents,
  ) => MseController;
  /**
   * Creates the cue of a source. On MPEG-TS and Matroska it reads its own PCM windows of the
   * audio lane.
   */
  readonly createCue: (source: MseSource, muted: boolean) => PcmCue;
  readonly setScrubCue: (cue: ScrubCue | null) => void;
  /**
   * Calls `callback` at each pointer and key gesture of the window, and returns a function that
   * stops it. The cue starts its AudioContext there, because WebKit lets a context start only in
   * a gesture, and a drag requests its bursts from pointer moves, which are none.
   */
  readonly listenForGestures: (callback: () => void) => () => void;
  readonly store: MediaSourceStoreActions;
  readonly pane: MediaSourcePaneReports;
  /** Reports a check of the first frame that failed, with both values. */
  readonly warn: (message: string) => void;
}

export interface MediaSourceOwner {
  /** Starts the MediaSource of `element`. A previous element stops first. */
  readonly attach: (
    element: HTMLVideoElement,
    target: MediaSourceTarget,
    muted: boolean,
  ) => void;
  /** Stops the MediaSource of `element`, if the owner holds it. */
  readonly detach: (element: HTMLVideoElement) => void;
  readonly setMuted: (muted: boolean) => void;
  /** The element that the owner holds, or null. */
  readonly element: () => HTMLVideoElement | null;
}

/** The precision of the test that the element still waits in the gap before the first frame. */
const GAP_EPSILON_SECONDS = 1e-3;

interface Owned {
  readonly element: HTMLVideoElement;
  readonly controller: MseController;
  readonly cue: PcmCue | null;
  readonly onSeeking: (() => void) | null;
  /** Cancels a seek over a gap that waits for the store. */
  cancelGapSeek: (() => void) | null;
  /** Stops the gestures that start the AudioContext of the cue. */
  readonly stopGestures: (() => void) | null;
}

export function createMediaSourceOwner(
  dependencies: MediaSourceOwnerDependencies,
): MediaSourceOwner {
  let owned: Owned | null = null;

  const release = (): void => {
    const current = owned;
    owned = null;
    if (current === null) {
      return;
    }
    current.cancelGapSeek?.();
    current.stopGestures?.();
    if (current.onSeeking !== null) {
      current.element.removeEventListener("seeking", current.onSeeking);
    }
    current.controller.destroy();
    if (current.cue !== null) {
      dependencies.setScrubCue(null);
      current.cue.destroy();
    }
  };

  return {
    attach: (element, target, muted) => {
      if (owned?.element === element) {
        return;
      }
      release();
      const { sourceRevisionKey: key, source } = target;
      // The cue needs PCM, which a source without audio, or with its audio left out, lacks.
      const cue =
        target.hasAudio && source.audio !== "omit"
          ? dependencies.createCue(source, muted)
          : null;
      let current: Owned | null = null;
      const isCurrent = (): boolean => current !== null && owned === current;
      const controller = dependencies.createController(element, source, {
        onExpectedFirstFrame: (mediaTime) => {
          if (isCurrent()) {
            dependencies.store.syncExpectedFirstFrame(key, element, mediaTime);
          }
        },
        onFirstFrameMismatch: (detail) => {
          if (isCurrent()) {
            dependencies.warn(`preview: ${detail}; the calibration is unavailable`);
            dependencies.store.syncPresentationUnavailable(key, element);
          }
        },
        onStartGap: (mediaTime) => {
          if (current === null || !isCurrent()) {
            return;
          }
          // The gap can show before the metadata made the store ready for seeks.
          current.cancelGapSeek?.();
          current.cancelGapSeek = dependencies.store.whenReady(() => {
            // A seek that ran in the meantime, such as the seek of a reload after a stall
            // (ADR 039), took the element out of the gap, and it keeps its target.
            if (isCurrent() && element.currentTime < mediaTime - GAP_EPSILON_SECONDS) {
              dependencies.store.seekOverGap(mediaTime);
            }
          });
        },
        onNonMonotonic: () => {
          if (isCurrent()) {
            dependencies.store.denySourcePrecision(key, element);
            dependencies.pane.onNonMonotonic(key);
          }
        },
        onAudioOmitted: () => {
          if (isCurrent()) {
            dependencies.pane.onAudioOmitted(key);
          }
        },
        onFailure: (failure) => {
          if (isCurrent()) {
            dependencies.pane.onFailure(key, element, failure);
          }
        },
        onPcm: (windowKey, startSeconds, bytes) => {
          if (isCurrent()) {
            cue?.addPcm(windowKey, startSeconds, bytes);
          }
        },
        onPcmEnd: (end) => {
          if (isCurrent()) {
            cue?.endPcm(end);
          }
        },
      });
      // On MPEG-TS and Matroska the cue reads its own PCM windows, so each seek asks for the PCM
      // at its target before a frame step needs it.
      const onSeeking =
        cue !== null && source.container !== "flv"
          ? () => {
              cue.ensure(element.currentTime);
            }
          : null;
      if (onSeeking !== null) {
        element.addEventListener("seeking", onSeeking);
      }
      const stopGestures =
        cue === null ? null : dependencies.listenForGestures(() => cue.prime());
      current = {
        element,
        controller,
        cue,
        onSeeking,
        cancelGapSeek: null,
        stopGestures,
      };
      owned = current;
      if (cue !== null) {
        dependencies.setScrubCue(cue);
      }
    },
    detach: (element) => {
      if (owned?.element === element) {
        release();
      }
    },
    setMuted: (muted) => {
      owned?.cue?.setMuted(muted);
    },
    element: () => owned?.element ?? null,
  };
}
