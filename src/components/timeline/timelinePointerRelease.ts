/**
 * The pointer release of the timeline gesture, and the click that follows it (ADR 007,
 * ADR 022, ADR 030).
 *
 * The gesture of the timeline panel is a scrub of the playhead, or the trim of a segment edge
 * after a press on an edge hit area. In the trim mode the ruler lane captures the pointer, so
 * the browser sends the click of the release to another element, or to the segment button, or
 * to no element. The release therefore does the work of that click itself, and the click is
 * ignored. The release of a drag during playback also resumes the playback. This module decides
 * all three, with no DOM, so the tests need no document.
 */

import type { SegmentEdge } from "./segmentEdges";

/** The edge that a trim-mode press named. */
export interface TrimPress {
  readonly segmentId: string;
  readonly edge: SegmentEdge;
}

/** The facts of one pointer release. */
export interface PointerReleaseInput {
  readonly pointerId: number;
  /** The mode of the gesture before the release. */
  readonly mode: "scrub" | "trim";
  /** True while the gesture of this pointer is active. */
  readonly isGestureActive: boolean;
  /** True when the gesture moved past the drag threshold (ADR 022). */
  readonly isDragging: boolean;
  /** The edge of the trim-mode press, or null. */
  readonly trimPress: TrimPress | null;
  /** The pointer of the last trim-mode press, or null after its release. */
  readonly trimPointerId: number | null;
}

/** What one pointer release does. */
export interface PointerReleasePlan {
  /**
   * - `edgeClick`: a trim-mode press ended before the drag threshold. After the end of the
   *   gesture, the release does the click of the edge (`clickSegmentEdge`, ADR 007).
   * - `trimRelease`: the final sample of the gesture commits the trim (ADR 030).
   * - `scrubRelease`: the final sample of the gesture is the exact seek of a drag (ADR 022).
   *   A scrub-mode press with no drag sends nothing more.
   * - `none`: no gesture of this pointer is active, for example after `Escape` ended a trim.
   */
  readonly kind: "edgeClick" | "trimRelease" | "scrubRelease" | "none";
  /** The edge of the click, for `edgeClick`, and null otherwise. */
  readonly edgeClick: TrimPress | null;
  /**
   * True when the release ends the pointer of a trim-mode press. The click that the browser
   * sends after it must do nothing (`SegmentClickGuard`), and the panel forgets the pointer.
   */
  readonly endsTrimPointer: boolean;
}

/** Decides one pointer release of the timeline gesture. */
export function planPointerRelease(input: PointerReleaseInput): PointerReleasePlan {
  const endsTrimPointer =
    input.trimPointerId !== null && input.trimPointerId === input.pointerId;
  if (!input.isGestureActive) {
    return { kind: "none", edgeClick: null, endsTrimPointer };
  }
  if (input.mode === "scrub") {
    return { kind: "scrubRelease", edgeClick: null, endsTrimPointer };
  }
  // The gesture ends only for its own pointer, so another pointer ends no trim-mode press.
  if (!endsTrimPointer) {
    return { kind: "none", edgeClick: null, endsTrimPointer };
  }
  if (input.isDragging) {
    return { kind: "trimRelease", edgeClick: null, endsTrimPointer };
  }
  return {
    kind: input.trimPress === null ? "none" : "edgeClick",
    edgeClick: input.trimPress,
    endsTrimPointer,
  };
}

/** The facts that decide whether a pointer release resumes the playback. */
export interface GestureResumeInput {
  /** The kind of the release (`planPointerRelease`). */
  readonly release: PointerReleasePlan["kind"];
  /**
   * True when the release ended the gesture: the gesture was active before the release, and it
   * is not active after it. The gesture ends only for its own pointer, so the pointer up of
   * another pointer, such as a pen or a mouse during a touch drag, leaves it active.
   */
  readonly endsGesture: boolean;
  /** True when the gesture moved past the drag threshold before the release (ADR 022). */
  readonly isDragging: boolean;
  /**
   * True when the store played at the pointer down of a scrub-mode press. A trim-mode press
   * gives false, also when its trim stops and the rest of its drag scrubs the playhead.
   */
  readonly wasPlayingAtPress: boolean;
  /**
   * True when the store holds a navigation that it deferred during the calibration after the
   * final sample (`hasDeferredNavigation`, ADR 022). The exact seek of the release then waits
   * for the anchor, and `play` would drop it.
   */
  readonly isSeekDeferred: boolean;
  /** True when the final sample failed: the store reports `seekFailed`. */
  readonly hasSeekFailed: boolean;
}

/**
 * True when a pointer release resumes the playback (`resumeAfterSeek`), after the exact seek of
 * the release (ADR 035).
 *
 * A drag during playback pauses it: the scrub samples seek the paused element, so the picture
 * follows the pointer. At the release of the drag, the playback plays on from the release
 * target when it played at the pointer down. All of these must be true:
 *
 * - The release ends a scrub of the playhead (`scrubRelease`). A trim, the click of a segment
 *   edge and a release with no active gesture do not resume. A click on a segment starts no
 *   gesture.
 * - The release ends the gesture. The pointer up of another pointer does not end it, and the
 *   drag goes on.
 * - The gesture is a drag. A click needs no resume: its seek at pointer down kept the playback
 *   running (`keepPlaying`), and its release sends no seek.
 * - The store played at the pointer down of a scrub-mode press.
 * - The seek of the release ran: it is not deferred during the calibration, and it did not fail.
 *   `play` would drop a deferred seek and play from where the element stands, and Play Segment
 *   also does not play after a failed seek.
 *
 * A cancel of the gesture, a window blur and a lost pointer capture are not releases, so they do
 * not resume. `play` starts a queued seek at once as an exact seek (ADR 022), and that stops the
 * seek that runs. At the release no later seek of the gesture follows, so the queued seek of the
 * release is the last one, and the playback starts at its target. The store itself refuses a
 * resume at the end of the media (`resumeAfterSeek`).
 */
export function shouldResumeAfterGesture(input: GestureResumeInput): boolean {
  return (
    input.release === "scrubRelease" &&
    input.endsGesture &&
    input.isDragging &&
    input.wasPlayingAtPress &&
    !input.isSeekDeferred &&
    !input.hasSeekFailed
  );
}

/**
 * The record of the playback state at the press of the active gesture, which the release reads
 * (`GestureResumeInput.wasPlayingAtPress`).
 *
 * - A scrub-mode press that starts a gesture records whether the store plays. It records before
 *   the seek at pointer down: that seek keeps a running playback, and the first scrub sample of
 *   a drag pauses it.
 * - A trim-mode press records false. A trim never resumes the playback, also when it stops and
 *   the rest of its drag scrubs the playhead.
 * - The end of the gesture, by any path, records false.
 */
export interface PressPlaybackRecord {
  /** A scrub-mode press started a gesture while the store played or did not. */
  readonly pressScrub: (isPlaying: boolean) => void;
  /** A trim-mode press started a gesture. */
  readonly pressTrim: () => void;
  /** The gesture ended: a release, a cancel, a lost capture, a blur or an unmount. */
  readonly finish: () => void;
  /** True when the store played at the scrub-mode press of the active gesture. */
  readonly wasPlayingAtPress: () => boolean;
}

/** Creates a record of the playback state at the press. */
export function createPressPlaybackRecord(): PressPlaybackRecord {
  let wasPlaying = false;
  return {
    pressScrub: (isPlaying) => {
      wasPlaying = isPlaying;
    },
    pressTrim: () => {
      wasPlaying = false;
    },
    finish: () => {
      wasPlaying = false;
    },
    wasPlayingAtPress: () => wasPlaying,
  };
}

/**
 * The rule that makes the click after a trim-mode release do nothing.
 *
 * The release arms the guard. The next pointer click on a segment consumes it. Every pointer
 * down in the window clears a guard that no click consumed: the timeline panel listens for it
 * in the capture phase. A pointer click always follows a pointer down, so a guard never takes
 * the click of a later press. A touch tap can send its click long after the release, and the
 * guard still waits for it. A click from the keyboard or from assistive technology has a
 * `detail` of 0 and never consumes the guard.
 */
export interface SegmentClickGuard {
  /** A trim-mode release ended: the next pointer click must do nothing. */
  readonly arm: () => void;
  /** A pointer went down in the window: a guard that no click consumed ends. */
  readonly clear: () => void;
  /**
   * Returns true, and ends the guard, when a click with this `detail` must do nothing.
   *
   * @param detail The `detail` of the click event: the click count of a pointer click, and 0
   *   for a click from the keyboard or from assistive technology.
   */
  readonly consume: (detail: number) => boolean;
}

/** Creates a click guard. */
export function createSegmentClickGuard(): SegmentClickGuard {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    clear: () => {
      armed = false;
    },
    consume: (detail) => {
      if (!armed || detail <= 0) {
        return false;
      }
      armed = false;
      return true;
    },
  };
}
