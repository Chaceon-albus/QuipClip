/**
 * The pointer release of the timeline gesture, and the click that follows it (ADR 007,
 * ADR 022, ADR 030).
 *
 * The gesture of the timeline panel is a scrub of the playhead, or the trim of a segment edge
 * after a press on an edge hit area. In the trim mode the ruler lane captures the pointer, so
 * the browser sends the click of the release to another element, or to the segment button, or
 * to no element. The release therefore does the work of that click itself, and the click is
 * ignored. This module decides both, with no DOM, so the tests need no document.
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
