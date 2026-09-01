/**
 * Timeline store managing single-source timeline state, mark-in/out editing,
 * segment splitting, undo/redo history stacks, and active source transitions.
 *
 * Implements ADR 002 (rational time / exclusive out points) and
 * ADR 007 (single-track source-time timeline).
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { isPtsString, isValidSegmentRange } from "@/lib/time";
import type { Pts, Segment } from "@/types/project";
import { findSplittableSegmentIndex, splitSegment } from "./math";
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

  let undoStack: Segment[][] = [];
  let redoStack: Segment[][] = [];

  return createStore<TimelineStoreState>()((set, get) => ({
    sourceId: initialState?.sourceId ?? null,
    sourceRevisionKey: initialState?.sourceRevisionKey ?? null,
    segments: initialState?.segments ? [...initialState.segments] : [],
    pendingInPts: initialState?.pendingInPts ?? null,
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

      // 2. Validate inputs
      if (typeof sourceId !== "string" || typeof sourceRevisionKey !== "string") {
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

      set({ pendingInPts: pts });
    },

    markOut: (currentPts: Pts) => {
      const state = get();
      if (!state.sourceId || state.pendingInPts === null || !isPtsString(currentPts)) {
        return;
      }

      if (!isValidSegmentRange(state.pendingInPts, currentPts)) {
        return;
      }

      const inPts = state.pendingInPts;
      const outPts = currentPts;

      const newSegment: Segment = {
        id: generateId(),
        sourceId: state.sourceId,
        inPts,
        outPts,
      };

      undoStack.push(state.segments);
      redoStack = [];

      const nextSegments = [...state.segments, newSegment];

      set({
        segments: nextSegments,
        pendingInPts: null,
        canUndo: true,
        canRedo: false,
      });
    },

    split: (currentPts: Pts) => {
      const state = get();
      if (!state.sourceId || !isPtsString(currentPts)) {
        return;
      }

      const targetIndex = findSplittableSegmentIndex(
        state.segments,
        currentPts,
        state.sourceId,
      );
      if (targetIndex === -1) {
        return;
      }

      const targetSeg = state.segments[targetIndex];
      const [leftSeg, rightSeg] = splitSegment(targetSeg, currentPts, generateId());

      undoStack.push(state.segments);
      redoStack = [];

      const nextSegments = [
        ...state.segments.slice(0, targetIndex),
        leftSeg,
        rightSeg,
        ...state.segments.slice(targetIndex + 1),
      ];

      set({
        segments: nextSegments,
        canUndo: true,
        canRedo: false,
      });
    },

    undo: () => {
      if (undoStack.length === 0) {
        return;
      }

      const state = get();
      const previousSegments = undoStack.pop()!;
      redoStack.push(state.segments);

      set({
        segments: previousSegments,
        canUndo: undoStack.length > 0,
        canRedo: true,
      });
    },

    redo: () => {
      if (redoStack.length === 0) {
        return;
      }

      const state = get();
      const nextSegments = redoStack.pop()!;
      undoStack.push(state.segments);

      set({
        segments: nextSegments,
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
