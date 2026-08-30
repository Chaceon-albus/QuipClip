/**
 * Domain types, store state, and action signatures for single-source timeline editing.
 *
 * See ADR 002, ADR 007, and ADR 010.
 */

import type { Segment } from "@/types/project";

/**
 * Public, strictly serializable state of the timeline store.
 */
export interface TimelineState {
  /**
   * Active media source identity token, or null if no media source is loaded.
   */
  readonly sourceId: string | null;

  /**
   * Total number of frames in the active media stream (0 if none).
   */
  readonly frameCount: number;

  /**
   * Completed timeline segments in source order.
   * Export order for a single source is array order (ADR 007).
   */
  readonly segments: Segment[];

  /**
   * Inclusive frame index of a pending In mark awaiting a matching Out mark,
   * or null if no In mark is pending.
   */
  readonly pendingInFrame: number | null;

  /**
   * True if there is an edit action in history available to undo.
   */
  readonly canUndo: boolean;

  /**
   * True if there is an undone edit action available to redo.
   */
  readonly canRedo: boolean;
}

/**
 * Public actions exposed by the timeline store.
 */
export interface TimelineActions {
  /**
   * Activates a media source on the timeline.
   * Preserves edits, pending In, and history only when source identity AND frameCount are unchanged;
   * a changed frameCount or different source identity resets segments, pending In, and undo/redo history.
   *
   * @param sourceId Canonical source identity token (non-empty string, or null/empty to clear).
   * @param frameCount Total frame count of the source (nonnegative safe integer).
   */
  setSource: (sourceId: string | null, frameCount: number) => void;

  /**
   * Marks an inclusive In point at the given rendered frame index.
   *
   * @param frame Rendered frame index on the source frame grid (0 <= frame < frameCount).
   */
  markIn: (frame: number) => void;

  /**
   * Marks a visible Out point at the current rendered frame, computing the exclusive
   * boundary as `min(currentFrame + 1, frameCount)` per ADR-002 Rule 3.
   * Completes a segment if `inFrame < outFrame` and clears the pending In mark.
   *
   * @param currentFrame Visible rendered frame index (0 <= currentFrame < frameCount).
   */
  markOut: (currentFrame: number) => void;

  /**
   * Splits a completed segment at the current frame when `currentFrame` is strictly
   * inside the segment (`inFrame < currentFrame < outFrame`).
   * Replaces the segment with two adjacent segments, preserving the left segment ID
   * and assigning a newly generated right segment ID.
   *
   * @param currentFrame Visible rendered frame index strictly inside a segment.
   */
  split: (currentFrame: number) => void;

  /**
   * Undoes the last completed mark-out or split edit.
   */
  undo: () => void;

  /**
   * Redoes the last undone edit.
   */
  redo: () => void;

  /**
   * Clears any active pending In mark without modifying completed segments or history.
   */
  clearPendingIn: () => void;

  /**
   * Resets the timeline store back to its initial idle state and clears history.
   */
  reset: () => void;
}

/**
 * Combined type of timeline store state and actions.
 */
export type TimelineStoreState = TimelineState & TimelineActions;
