/**
 * Domain types, store state, and action signatures for single-source timeline editing.
 *
 * See ADR 002, ADR 003, ADR 007, and ADR 010.
 * Edit points are represented as presentation timestamps (PTS) in source video stream timebase.
 */

import type { Pts, Segment } from "@/types/project";

/**
 * Public, strictly serializable state of the timeline store.
 */
export interface TimelineState {
  /**
   * Active media source stable identifier, or null if no media source is loaded.
   */
  readonly sourceId: string | null;

  /**
   * Active media source revision key string (path:size:mtime), or null if no media source is loaded.
   */
  readonly sourceRevisionKey: string | null;

  /**
   * Completed timeline segments in project array order (ADR 007).
   * Export order is array order.
   */
  readonly segments: Segment[];

  /**
   * Presentation timestamp (PTS) of a pending In mark awaiting a matching Out mark,
   * or null if no In mark is pending.
   */
  readonly pendingInPts: Pts | null;

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
   * Canonical ordered segments and undo/redo history are project state and remain unchanged.
   * A changed source or revision clears the source-view pending In mark.
   *
   * @param sourceId Canonical stable source identifier (non-empty string, or null to clear).
   * @param sourceRevisionKey Canonical source revision key string (non-empty string, or null to clear).
   */
  setSource: (sourceId: string | null, sourceRevisionKey: string | null) => void;

  /**
   * Marks an inclusive In point at the given presentation timestamp (PTS).
   *
   * @param pts Presentation timestamp in source video time base.
   */
  markIn: (pts: Pts) => void;

  /**
   * Marks an exclusive Out point at the current presentation timestamp (PTS) (ADR 002).
   * Out PTS is stored directly as the first-excluded boundary.
   * Does NOT add one to Out.
   * Completes a segment if `inPts < outPts` and clears the pending In mark.
   *
   * @param currentPts Presentation timestamp in source video time base (must satisfy inPts < currentPts).
   */
  markOut: (currentPts: Pts) => void;

  /**
   * Splits a completed segment at the current presentation timestamp (PTS) when `currentPts` is strictly
   * inside the segment (`inPts < currentPts < outPts`).
   * Replaces the segment with two adjacent segments [inPts, currentPts) and [currentPts, outPts),
   * preserving the left segment ID and assigning a newly generated right segment ID.
   *
   * @param currentPts Presentation timestamp strictly inside an existing segment.
   */
  split: (currentPts: Pts) => void;

  /**
   * Undoes the last completed mark-out or split edit.
   * Restores the pending In mark of that edit only while the active source identity is
   * the one the edit was made on, otherwise clears it.
   */
  undo: () => void;

  /**
   * Redoes the last undone edit.
   * Restores the pending In mark under the same source identity condition as `undo`.
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
