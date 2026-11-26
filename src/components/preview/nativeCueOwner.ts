/**
 * The PCM cue of a native source on macOS (ADR 062), owned by the preview pane.
 *
 * In WKWebView the hidden `<audio>` element of ADR 019 makes no sound for a single frame step.
 * AVFoundation starts the sound of the element about 250 ms after its seek ends. The element
 * clock moves from the end of the seek, so the burst stops before its first sample plays. A
 * native source on macOS therefore plays its bursts through the PCM cue of ADR 046. That cue
 * reads PCM windows of the audio lane, as the cue of MPEG-TS and Matroska does.
 *
 * The cue needs the source time of media time 0 of the element. A native source has that time
 * only after the calibration of ADR 003. The pane therefore attaches the cue when the
 * calibration is ready. It detaches the cue when the element, the source or the calibration
 * changes.
 */

import type { ScrubCue } from "@/features/playback/cue";
import type { PcmCue } from "@/features/playback/mse/pcmCue";
import { videoStartSeconds } from "@/features/playback/mse/timeline";
import type { Pts, Rational } from "@/types/project";

/** The file that the PCM windows of the cue read. */
export interface NativeCueSource {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  /** The container start time of the probe, for the input seek of a window. */
  readonly formatStartTime: Rational | null;
  /** The codec of the audio stream that the windows decode (`previewAudioStreamOf`). */
  readonly audioCodec: string | null;
  /** The absolute index of that stream, which the request of each window names (ADR 070). */
  readonly audioStreamIndex: number;
}

/** What the owner needs to know of the open source. */
export interface NativeCueTarget {
  readonly sourceRevisionKey: string;
  readonly source: NativeCueSource;
  /** The source time in seconds of media time 0 of the element (`nativeMediaTimeOrigin`). */
  readonly originSeconds: number;
}

/** The part of the video element that the owner uses. */
export interface NativeCueElement {
  readonly currentTime: number;
  addEventListener: (type: "seeking" | "pause", listener: () => void) => void;
  removeEventListener: (type: "seeking" | "pause", listener: () => void) => void;
}

export interface NativeCueOwnerDependencies {
  /** Creates the cue of a source at the gain of its bursts (`PcmCue.setGain`). */
  readonly createCue: (target: NativeCueTarget, gain: number) => PcmCue;
  readonly setScrubCue: (cue: ScrubCue | null) => void;
  /** Removes a cue from the router only while it is the active cue (`clearScrubCue`). */
  readonly clearScrubCue: (cue: ScrubCue) => void;
  /**
   * Calls `callback` at each pointer and key gesture of the window, and returns a function that
   * stops it. The cue starts its AudioContext there, because WebKit lets a context start only in
   * a gesture.
   */
  readonly listenForGestures: (callback: () => void) => () => void;
}

export interface NativeCueOwner {
  /**
   * Starts the cue of `element`. A previous cue stops first. A second call for the same element
   * and source keeps the cue that runs.
   */
  readonly attach: (
    element: NativeCueElement,
    target: NativeCueTarget,
    gain: number,
  ) => void;
  /** Stops the cue of `element`, if the owner holds it. */
  readonly detach: (element: NativeCueElement) => void;
  /** Sets the gain of the cue that the owner holds. */
  readonly setGain: (gain: number) => void;
}

/**
 * Returns the source time in seconds of media time 0 of a native element: the source time of
 * `videoStartPts`, less the media time of the calibration anchor of ADR 003
 * (`calibrationAnchorMediaTime`). Returns null when the anchor, the PTS or the time base is not
 * valid.
 */
export function nativeMediaTimeOrigin(
  anchorMediaTime: number | null,
  videoStartPts: Pts | null,
  videoTimeBase: Rational,
): number | null {
  const start = videoStartSeconds(videoStartPts, videoTimeBase);
  if (start === null || anchorMediaTime === null || !Number.isFinite(anchorMediaTime)) {
    return null;
  }
  const origin = start - anchorMediaTime;
  return Number.isFinite(origin) ? origin : null;
}

/** Reads the position of the element, or null when the read throws or is not finite. */
function positionOf(element: NativeCueElement): number | null {
  try {
    const position = element.currentTime;
    return Number.isFinite(position) ? position : null;
  } catch {
    return null;
  }
}

interface Owned {
  readonly element: NativeCueElement;
  readonly sourceRevisionKey: string;
  readonly cue: PcmCue;
  readonly onMove: () => void;
  readonly stopGestures: () => void;
}

export function createNativeCueOwner(
  dependencies: NativeCueOwnerDependencies,
): NativeCueOwner {
  let owned: Owned | null = null;

  const release = (): void => {
    const current = owned;
    owned = null;
    if (current === null) {
      return;
    }
    current.element.removeEventListener("seeking", current.onMove);
    current.element.removeEventListener("pause", current.onMove);
    current.stopGestures();
    dependencies.clearScrubCue(current.cue);
    current.cue.destroy();
  };

  return {
    attach: (element, target, gain) => {
      if (
        owned !== null &&
        owned.element === element &&
        owned.sourceRevisionKey === target.sourceRevisionKey
      ) {
        return;
      }
      release();
      const cue = dependencies.createCue(target, gain);
      // Each seek and each pause requests the PCM at the new position. The PCM then arrives
      // before a frame step needs it.
      const onMove = (): void => {
        const position = positionOf(element);
        if (position !== null) {
          cue.ensure(position);
        }
      };
      element.addEventListener("seeking", onMove);
      element.addEventListener("pause", onMove);
      const stopGestures = dependencies.listenForGestures(() => cue.prime());
      owned = {
        element,
        sourceRevisionKey: target.sourceRevisionKey,
        cue,
        onMove,
        stopGestures,
      };
      dependencies.setScrubCue(cue);
      // The first step after the calibration finds the PCM of the position where it starts.
      onMove();
    },
    detach: (element) => {
      if (owned?.element === element) {
        release();
      }
    },
    setGain: (gain) => {
      owned?.cue.setGain(gain);
    },
  };
}
