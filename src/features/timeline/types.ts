/**
 * Domain types, store state, and action signatures for the timeline of a sequence of clips.
 *
 * See ADR 002, ADR 003, ADR 007, ADR 010 and ADR 052.
 * The truth is anchored: each boundary is a clip and a source PTS (ADR 052). The interface reads
 * a derived view in which the sequence is one virtual source (`virtualTime.ts`). With one clip,
 * a virtual PTS is the source PTS of that clip.
 */

import type { Clip, EditPoint, Pts, Segment, SequenceSegment } from "@/types/project";
import type { SequenceSource } from "./sequence";
import type { VirtualTimeline } from "./virtualTime";

/**
 * One boundary of a half-open segment `[inPts, outPts)` (ADR 002): `in` names `inPts`, and
 * `out` names `outPts`, the first frame after the segment.
 */
export type SegmentEdge = "in" | "out";

/**
 * The anchored truth of the timeline (ADR 052). Every edit changes these fields, and the history
 * of undo and redo stores them.
 */
export interface TimelineTruth {
  /** The clips of the sequence in sequence order. */
  readonly clips: readonly Clip[];
  /** The segments in project array order, which is the export order (ADR 007). */
  readonly sequenceSegments: readonly SequenceSegment[];
  /** The pending In mark awaiting a matching Out mark, or null. */
  readonly pendingIn: EditPoint | null;
  /**
   * The timing facts of every source that a clip named during the session, by source ID. A
   * source stays after its last clip leaves, so an Undo finds it again (ADR 052).
   */
  readonly sequenceSources: Readonly<Record<string, SequenceSource>>;
  /**
   * A finite media element duration by source ID, the last extent fallback of ADR 007. It is
   * kept for every source of the session, not only for the attached one.
   */
  readonly browserDurations: Readonly<Record<string, number>>;
  /**
   * The clip whose source the preview attached, or null. A virtual PTS from the interface goes
   * back to an edit point on this clip (ADR 052).
   */
  readonly attachedClipId: string | null;
  /**
   * Counts the times the sequence got its first clip, or got a new single source. The derived
   * revision key changes with it, so the view state of a new sequence starts fresh.
   */
  readonly generation: number;
}

/**
 * Public, strictly serializable state of the timeline store.
 */
export interface TimelineState extends TimelineTruth {
  /** The virtual axis of the sequence, or null for an empty sequence or one with no axis. */
  readonly virtual: VirtualTimeline | null;

  /**
   * The virtual source of the sequence, or null while the sequence has no clip. Every derived
   * segment carries it as its `sourceId`.
   */
  readonly sourceId: string | null;

  /**
   * The revision key of the virtual source, or null while the sequence has no clip. It changes
   * with `generation`, and not with a clip operation.
   */
  readonly sourceRevisionKey: string | null;

  /**
   * The segments as virtual source segments, in project array order (ADR 007). Derived from
   * `sequenceSegments`. A segment whose clips are not on the sequence is not in this list.
   */
  readonly segments: Segment[];

  /** The pending In mark as a virtual PTS, or null. Derived from `pendingIn`. */
  readonly pendingInPts: Pts | null;

  /**
   * Identifier of the segment every segment operation names as its target, or null
   * when nothing is current.
   *
   * Invariant: while a current segment resolves, `pendingIn` is null. The two fields describe
   * the same thing — the segment being built or adjusted — so only one of them is ever in
   * progress.
   *
   * Invariant: it is the only selected segment while exactly one segment is selected, and
   * null in every other case (`selectedSegmentIds`).
   */
  readonly currentSegmentId: string | null;

  /**
   * Identifiers of the selected segments, in project array order (ADR 045). A plain click
   * selects one segment. The primary modifier with a click adds or removes one, and primary+A
   * selects every segment of the sequence.
   *
   * A selection of one segment makes that segment current. A selection of several segments
   * leaves nothing current, so Mark In, Mark Out, Split and the boundary seeks do not guess
   * between them (ADR 007). Delete removes every selected segment.
   *
   * Invariant: while any segment is selected, `pendingIn` is null.
   */
  readonly selectedSegmentIds: readonly string[];

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
   * Makes the sequence the one clip of `source`, or empty for null. The clip of a source has a
   * fixed identifier, so a source that comes back finds the segments of its clip again. A
   * different source starts a new generation, clears the pending In mark, the selection and the
   * history. The same source changes nothing. This is the import of one file that replaces the
   * open one (ADR 027); several sources use `insertClips`.
   */
  showOnlySource: (source: SequenceSource | null) => void;

  /**
   * Inserts clips at junction `index` (ADR 052), with one history entry, and records the timing
   * facts of their sources. A segment that crosses the junction is split there first. Refuses an
   * index out of range, a known clip identifier, and a sequence that `layoutSequence` refuses.
   * Returns whether it inserted.
   */
  insertClips: (
    index: number,
    clips: readonly Clip[],
    sources: readonly SequenceSource[],
  ) => boolean;

  /**
   * Moves clip `from` to junction `to` (ADR 052), with one history entry. Each segment that
   * crosses a junction of the clip or the target junction is split there first. A move to either
   * junction of the clip itself changes nothing and adds no history entry.
   */
  moveClip: (from: number, to: number) => void;

  /**
   * Removes clip `index` (ADR 052), with one history entry. The segments on it go, and a segment
   * with one end on it keeps the part outside it. A pending In on the clip is cleared.
   */
  removeClip: (index: number) => void;

  /** Removes every clip and every segment, with one history entry (ADR 052). */
  clearTimeline: () => void;

  /** Records the clip whose source the preview attached, or null. */
  setAttachedClip: (clipId: string | null) => void;

  /** Records a finite media element duration of a source, or forgets it with null (ADR 007). */
  setBrowserDuration: (sourceId: string, seconds: number | null) => void;

  /**
   * Marks an inclusive In point at the given presentation timestamp (PTS).
   *
   * With no current segment, records the pending In mark, clears a selection of several
   * segments, and adds no history entry.
   * With a current segment and `pts` before its `outPts`, moves that segment's `inPts` and
   * adds one history entry.
   * With a current segment and `pts` at or after its `outPts`, finishes that segment and
   * records the pending In mark at `pts`, as one action with one history entry. Undo then
   * makes the segment current again and clears the pending In mark.
   * Rejects silently, with no history entry, when the sequence has no clip, `pts` is malformed or
   * not a frame of the attached clip, a boundary move would break a rule of ADR 052, or `pts`
   * already equals the stored boundary. A segment whose stored PTS does not parse is not on the
   * sequence, so it is never current.
   *
   * @param pts Virtual PTS of the frame on screen. It goes back to an edit point on the attached
   *   clip (ADR 052).
   */
  markIn: (pts: Pts) => void;

  /**
   * Marks an exclusive Out point at the current presentation timestamp (PTS) (ADR 002).
   * Out PTS is stored directly as the first-excluded boundary.
   * Does NOT add one to Out.
   *
   * With no current segment, completes the pending In mark into a newly appended
   * segment, which becomes current, and clears the pending In mark.
   * With a current segment and `currentPts` not equal to its `outPts`, moves that segment's
   * `outPts`.
   * With a current segment and `currentPts` equal to its `outPts`, finishes that segment, as
   * `finishSegment` does: nothing is current after it, and no history entry is added.
   * Rejects silently under the same conditions as `markIn`.
   *
   * @param currentPts Virtual PTS of the frame on screen (must lie after the In).
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
   * Moves one boundary of a named segment to `pts`, and adds one history entry, so one undo
   * restores the old boundary. The drag trim of a segment edge commits with it (ADR 030).
   *
   * The move has the semantics of a boundary move by Mark In and Mark Out on a current
   * segment: it rejects silently, with no history entry, when the sequence has no clip, `pts`
   * is malformed, the move would not leave `inPts < outPts` (ADR 002), or `pts` already equals
   * the stored boundary. It also rejects an unknown identifier and a segment of another
   * source, as `findCurrentSegment` does. An In edge moved to or after the Out is rejected
   * too. Only Mark In finishes the segment there.
   *
   * The segment is named by its identifier and not through `currentSegmentId`, because the
   * selection can change between the start of a trim and the frame that commits it. The
   * action changes neither `currentSegmentId` nor `pendingInPts`.
   *
   * @param segmentId Identifier of a segment on the sequence.
   * @param edge The boundary to move: `in` for `inPts`, `out` for `outPts`.
   * @param pts Virtual PTS of the frame on screen.
   */
  trimSegmentEdge: (segmentId: string, edge: SegmentEdge, pts: Pts) => void;

  /**
   * Ends whatever segment is in progress, so the next Mark In starts a new one. Clears both
   * `currentSegmentId` and `pendingInPts`, because both describe the segment being built. It
   * also clears a selection of several segments (ADR 045).
   *
   * With a pending In mark and an `outPts` after it, first completes the pending mark into a
   * newly appended segment that ends at `outPts`, with one history entry, as Mark Out does. The
   * new segment is not current. Undo then restores the pending In mark.
   * In every other case adds no history entry: a current segment is already canonical, and a
   * pending In mark that `outPts` cannot complete (null, malformed, or at or before the In) is
   * dropped.
   *
   * @param outPts The Out for a pending In mark: the PTS of the frame on screen, or null to drop
   *   the pending mark (`planFinishSegment`).
   */
  finishSegment: (outPts: Pts | null) => void;

  /**
   * Removes every selected segment on the sequence, with one history entry, and leaves
   * nothing selected (ADR 045). Undo restores the segments and selects them again.
   * Does not select a neighbour, so the next Delete or Split cannot act on a segment the
   * user did not name. Preserves the array order of the remaining segments, which is the
   * export order (ADR 007).
   * Does nothing when no selected segment resolves.
   */
  deleteSelectedSegments: () => void;

  /**
   * Selects only an existing segment on the sequence, which makes it current, and clears
   * the pending In mark.
   * Refuses an unknown identifier and a segment that is not on the sequence.
   * Adds no history entry: selection is not an edit.
   *
   * @param id Identifier of a segment on the sequence.
   */
  selectSegment: (id: string) => void;

  /**
   * Adds a segment on the sequence to the selection, or removes it when it is selected
   * (ADR 045), and clears the pending In mark. The selection stays in project array order.
   * Refuses an unknown identifier and a segment that is not on the sequence.
   * Adds no history entry: selection is not an edit.
   *
   * @param id Identifier of a segment on the sequence.
   */
  toggleSegmentSelection: (id: string) => void;

  /**
   * Selects every segment on the sequence (ADR 045), and clears the pending In mark.
   * Does nothing when the sequence has no segment.
   * Adds no history entry: selection is not an edit.
   */
  selectAllSegments: () => void;

  /**
   * Undoes the last segment edit.
   * Restores the clips and the segments of that edit, and its pending In mark only while its
   * clip is on the restored sequence.
   * Restores the selection of that edit, and so its current segment, only for the segments
   * that the restored array still holds and that lie on the restored sequence.
   */
  undo: () => void;

  /**
   * Redoes the last undone edit.
   * Restores the pending In mark and the selection under the same conditions as `undo`.
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
