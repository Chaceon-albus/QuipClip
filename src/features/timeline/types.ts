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
   * Identifier of the segment every segment operation names as its target, or null
   * when nothing is current.
   *
   * The identifier is canonical project state. It can name a segment of an inactive
   * source, so it is always read through `findCurrentSegment`, which refuses an
   * unknown identifier and a foreign source (ADR 002 forbids a cross-source PTS
   * comparison).
   *
   * Invariant: while a current segment resolves for the active source,
   * `pendingInPts` is null. The two fields describe the same thing — the segment
   * being built or adjusted — so only one of them is ever in progress.
   */
  readonly currentSegmentId: string | null;

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
   * With no current segment, records the pending In mark and adds no history entry.
   * With a current segment, moves that segment's `inPts` and adds one history entry.
   * Rejects silently, with no history entry, when there is no active source, `pts` is
   * malformed, the move would not leave `inPts < outPts` (ADR 002), or `pts` already
   * equals the stored boundary.
   *
   * @param pts Presentation timestamp in source video time base.
   */
  markIn: (pts: Pts) => void;

  /**
   * Marks an exclusive Out point at the current presentation timestamp (PTS) (ADR 002).
   * Out PTS is stored directly as the first-excluded boundary.
   * Does NOT add one to Out.
   *
   * With no current segment, completes the pending In mark into a newly appended
   * segment, which becomes current, and clears the pending In mark.
   * With a current segment, moves that segment's `outPts`.
   * Rejects silently under the same conditions as `markIn`.
   *
   * @param currentPts Presentation timestamp in source video time base (must satisfy inPts < currentPts).
   */
  markOut: (currentPts: Pts) => void;

  /**
   * Splits the current segment at the current presentation timestamp (PTS) when `currentPts`
   * is strictly inside it (`inPts < currentPts < outPts`).
   * Replaces the segment with two adjacent segments [inPts, currentPts) and [currentPts, outPts),
   * preserving the left segment ID and assigning a newly generated right segment ID.
   * The left half keeps the identifier, so it stays current.
   * Does nothing when no current segment resolves.
   *
   * @param currentPts Presentation timestamp strictly inside the current segment.
   */
  split: (currentPts: Pts) => void;

  /**
   * Ends whatever segment is in progress, so the next Mark In starts a new one.
   * Clears both `currentSegmentId` and `pendingInPts`, because both describe the segment
   * being built. Adds no history entry: a completed segment is already canonical.
   */
  newSegment: () => void;

  /**
   * Removes the current segment and leaves nothing current.
   * Does not select a neighbour, so the next Delete or Split cannot act on a segment the
   * user did not name. Preserves the array order of the remaining segments, which is the
   * export order (ADR 007).
   * Does nothing when no current segment resolves.
   */
  deleteSegment: () => void;

  /**
   * Makes an existing segment of the active source current, and clears the pending In mark.
   * Refuses an unknown identifier and a segment of another source.
   * Adds no history entry: selection is not an edit.
   *
   * @param id Identifier of a segment of the active source.
   */
  selectSegment: (id: string) => void;

  /**
   * Undoes the last segment edit.
   * Restores the pending In mark of that edit only while the active source identity is
   * the one the edit was made on, otherwise clears it.
   * Restores the current segment identifier of that edit only while the restored array
   * still holds that segment and it belongs to the source active now.
   */
  undo: () => void;

  /**
   * Redoes the last undone edit.
   * Restores the pending In mark and the current segment identifier under the same
   * conditions as `undo`.
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
