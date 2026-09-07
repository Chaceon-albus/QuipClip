/**
 * Timeline store managing single-source timeline state, mark-in/out editing,
 * segment splitting, undo/redo history stacks, and active source transitions.
 *
 * Every segment operation names its target through `currentSegmentId`, so no operation
 * has to guess a segment from the playhead.
 *
 * Implements ADR 002 (rational time / exclusive out points) and
 * ADR 007 (single-track source-time timeline).
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { isPtsInsideSegment, isPtsString, isValidSegmentRange } from "@/lib/time";
import type { Pts, Segment } from "@/types/project";
import { findCurrentSegment, splitSegment } from "./math";
import type { TimelineState, TimelineStoreState } from "./types";

/**
 * Dependencies that can be injected into the timeline store factory for testing.
 */
export interface TimelineStoreDependencies {
  /**
   * Function to generate segment identifiers.
   * Defaults to `generateSegmentId`.
   */
  generateId?: () => string;
}

/**
 * Generates a UUID segment ID.
 */
export function generateSegmentId(): string {
  return crypto.randomUUID();
}

interface TimelineHistoryEntry {
  segments: Segment[];
  pendingInPts: Pts | null;
  currentSegmentId: string | null;
  /**
   * Active source identity at the time the entry was pushed.
   * The pending In mark is source-view state, so it is only restored while the
   * identity still matches. Canonical segments are project state and always restore.
   */
  sourceId: string | null;
  sourceRevisionKey: string | null;
}

/**
 * Captures the restorable state of one edit. Every push site uses this factory, so the
 * entry shape lives in one place.
 */
function historyEntry(state: TimelineState): TimelineHistoryEntry {
  return {
    segments: state.segments,
    pendingInPts: state.pendingInPts,
    currentSegmentId: state.currentSegmentId,
    sourceId: state.sourceId,
    sourceRevisionKey: state.sourceRevisionKey,
  };
}

/**
 * Reads the pending In mark of a history entry, but only while it belongs to the
 * source identity that is active now. A PTS from another source's timeline would
 * otherwise become the pending In mark of the current source.
 */
function restorablePendingIn(
  entry: TimelineHistoryEntry,
  state: TimelineState,
): Pts | null {
  if (
    entry.sourceId !== state.sourceId ||
    entry.sourceRevisionKey !== state.sourceRevisionKey
  ) {
    return null;
  }

  return entry.pendingInPts;
}

/**
 * Reads the current segment identifier of a history entry, but only while the segment it
 * names survives in the restored array and belongs to the source that is active now.
 *
 * Keyed on `sourceId` alone, and deliberately NOT on the revision key: canonical segments
 * survive a revision change, while a pending PTS mark does not. That is why this rule and
 * `restorablePendingIn` are asymmetric.
 */
function restorableCurrentSegmentId(
  entry: TimelineHistoryEntry,
  state: TimelineState,
  restoredSegments: readonly Segment[],
): string | null {
  if (entry.currentSegmentId === null || entry.sourceId !== state.sourceId) {
    return null;
  }
  return findCurrentSegment(restoredSegments, entry.currentSegmentId, state.sourceId)
    ? entry.currentSegmentId
    : null;
}

/** Replaces one segment in place, preserving the array order that is the export order. */
function replaceSegmentAt(
  segments: readonly Segment[],
  index: number,
  segment: Segment,
): Segment[] {
  const next = [...segments];
  next[index] = segment;
  return next;
}

/**
 * Factory function creating a vanilla Zustand store instance for timeline state.
 *
 * Undo/redo history stacks are maintained in the store factory closure to ensure
 * that the public store state remains strictly serializable.
 *
 * @param dependencies Injected dependencies for testing (e.g. deterministic ID generator).
 * @param initialState Optional initial state overrides for testing.
 */
export function createTimelineStore(
  dependencies: TimelineStoreDependencies = {},
  initialState?: Partial<TimelineState>,
): StoreApi<TimelineStoreState> {
  const generateId = dependencies.generateId ?? generateSegmentId;

  let undoStack: TimelineHistoryEntry[] = [];
  let redoStack: TimelineHistoryEntry[] = [];

  return createStore<TimelineStoreState>()((set, get) => ({
    sourceId: initialState?.sourceId ?? null,
    sourceRevisionKey: initialState?.sourceRevisionKey ?? null,
    segments: initialState?.segments ? [...initialState.segments] : [],
    pendingInPts: initialState?.pendingInPts ?? null,
    currentSegmentId: initialState?.currentSegmentId ?? null,
    canUndo: initialState?.canUndo ?? false,
    canRedo: initialState?.canRedo ?? false,

    setSource: (sourceId: string | null, sourceRevisionKey: string | null) => {
      // Clearing the source changes only source-view transient state.
      if (
        sourceId === null ||
        sourceId === "" ||
        sourceRevisionKey === null ||
        sourceRevisionKey === ""
      ) {
        set({
          sourceId: null,
          sourceRevisionKey: null,
          pendingInPts: null,
        });
        return;
      }

      const current = get();

      // Preserve the pending mark only while the active source revision is unchanged.
      if (
        current.sourceId === sourceId &&
        current.sourceRevisionKey === sourceRevisionKey
      ) {
        return;
      }

      // Canonical segments and edit history belong to the project, not the source view.
      set({
        sourceId,
        sourceRevisionKey,
        pendingInPts: null,
      });
    },

    markIn: (pts: Pts) => {
      const state = get();
      if (!state.sourceId || !isPtsString(pts)) {
        return;
      }

      const current = findCurrentSegment(
        state.segments,
        state.currentSegmentId,
        state.sourceId,
      );

      // Nothing is current, so the mark starts a segment instead of adjusting one.
      // No history entry: the pending mark is not yet a canonical edit.
      if (current === null) {
        set({ pendingInPts: pts });
        return;
      }

      // A canonical PTS is a canonical decimal string (ADR 010), so string equality is
      // exact. A repeated boundary must not fill the undo stack while the user scrubs.
      if (pts === current.segment.inPts) {
        return;
      }
      if (!isValidSegmentRange(pts, current.segment.outPts)) {
        return;
      }

      undoStack.push(historyEntry(state));
      redoStack = [];

      set({
        segments: replaceSegmentAt(state.segments, current.index, {
          ...current.segment,
          inPts: pts,
        }),
        canUndo: true,
        canRedo: false,
      });
    },

    markOut: (currentPts: Pts) => {
      const state = get();
      if (!state.sourceId || !isPtsString(currentPts)) {
        return;
      }

      const current = findCurrentSegment(
        state.segments,
        state.currentSegmentId,
        state.sourceId,
      );

      if (current !== null) {
        if (currentPts === current.segment.outPts) {
          return;
        }
        if (!isValidSegmentRange(current.segment.inPts, currentPts)) {
          return;
        }

        undoStack.push(historyEntry(state));
        redoStack = [];

        set({
          segments: replaceSegmentAt(state.segments, current.index, {
            ...current.segment,
            outPts: currentPts,
          }),
          canUndo: true,
          canRedo: false,
        });
        return;
      }

      if (state.pendingInPts === null) {
        return;
      }
      if (!isValidSegmentRange(state.pendingInPts, currentPts)) {
        return;
      }

      const completedSegment: Segment = {
        id: generateId(),
        sourceId: state.sourceId,
        inPts: state.pendingInPts,
        outPts: currentPts,
      };

      undoStack.push(historyEntry(state));
      redoStack = [];

      // The completed segment becomes current, so the next Mark In or Split adjusts it.
      set({
        segments: [...state.segments, completedSegment],
        pendingInPts: null,
        currentSegmentId: completedSegment.id,
        canUndo: true,
        canRedo: false,
      });
    },

    split: (currentPts: Pts) => {
      const state = get();
      if (!state.sourceId || !isPtsString(currentPts)) {
        return;
      }

      const current = findCurrentSegment(
        state.segments,
        state.currentSegmentId,
        state.sourceId,
      );
      if (current === null) {
        return;
      }

      const { index, segment } = current;
      if (!isPtsInsideSegment(currentPts, segment.inPts, segment.outPts)) {
        return;
      }

      // `splitSegment` gives the left half the original ID, so the current segment stays
      // current with no selection write here, and undo restores the same target.
      const [leftSeg, rightSeg] = splitSegment(segment, currentPts, generateId());

      undoStack.push(historyEntry(state));
      redoStack = [];

      set({
        segments: [
          ...state.segments.slice(0, index),
          leftSeg,
          rightSeg,
          ...state.segments.slice(index + 1),
        ],
        canUndo: true,
        canRedo: false,
      });
    },

    newSegment: () => {
      // Both fields describe the segment being built, so both end together.
      set({ currentSegmentId: null, pendingInPts: null });
    },

    deleteSegment: () => {
      const state = get();
      const current = findCurrentSegment(
        state.segments,
        state.currentSegmentId,
        state.sourceId,
      );
      if (current === null) {
        return;
      }

      undoStack.push(historyEntry(state));
      redoStack = [];

      // `filter` preserves array order, which is the export order (ADR 007). Nothing
      // becomes current, so the next Delete or Split cannot act on an unnamed segment.
      set({
        segments: state.segments.filter((segment) => segment.id !== current.segment.id),
        currentSegmentId: null,
        canUndo: true,
        canRedo: false,
      });
    },

    selectSegment: (id: string) => {
      const state = get();
      if (findCurrentSegment(state.segments, id, state.sourceId) === null) {
        return;
      }

      // Selection is not an edit, so it pushes no history entry. It clears the pending
      // mark to hold the invariant that only one segment is ever in progress.
      set({ currentSegmentId: id, pendingInPts: null });
    },

    undo: () => {
      if (undoStack.length === 0) {
        return;
      }

      const state = get();
      const previous = undoStack.pop()!;
      redoStack.push(historyEntry(state));

      set({
        segments: previous.segments,
        pendingInPts: restorablePendingIn(previous, state),
        currentSegmentId: restorableCurrentSegmentId(
          previous,
          state,
          previous.segments,
        ),
        canUndo: undoStack.length > 0,
        canRedo: true,
      });
    },

    redo: () => {
      if (redoStack.length === 0) {
        return;
      }

      const state = get();
      const next = redoStack.pop()!;
      undoStack.push(historyEntry(state));

      set({
        segments: next.segments,
        pendingInPts: restorablePendingIn(next, state),
        currentSegmentId: restorableCurrentSegmentId(next, state, next.segments),
        canUndo: true,
        canRedo: redoStack.length > 0,
      });
    },

    clearPendingIn: () => {
      set({ pendingInPts: null });
    },

    reset: () => {
      undoStack = [];
      redoStack = [];
      set({
        sourceId: null,
        sourceRevisionKey: null,
        segments: [],
        pendingInPts: null,
        currentSegmentId: null,
        canUndo: false,
        canRedo: false,
      });
    },
  }));
}

export type TimelineStore = ReturnType<typeof createTimelineStore>;

/**
 * Singleton timeline store for production application use.
 */
export const timelineStore: TimelineStore = createTimelineStore();

const defaultSelector = (state: TimelineStoreState): TimelineStoreState => state;

/**
 * React hook for consuming the production timeline store.
 */
export function useTimelineStore(): TimelineStoreState;
export function useTimelineStore<T>(selector: (state: TimelineStoreState) => T): T;
export function useTimelineStore<T>(
  selector?: (state: TimelineStoreState) => T,
): T | TimelineStoreState {
  return useStore(
    timelineStore,
    (selector ?? defaultSelector) as (state: TimelineStoreState) => T,
  );
}
