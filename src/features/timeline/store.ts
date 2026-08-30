/**
 * Timeline store managing single-source timeline state, mark-in/out editing,
 * segment splitting, undo/redo history stacks, and active source transitions.
 *
 * Implements ADR 002 (rational time / exclusive out points) and
 * ADR 007 (single-track source-time timeline).
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Segment } from "@/types/project";
import {
  calculateExclusiveOutFrame,
  findSplittableSegmentIndex,
  insertSegmentInSourceOrder,
  splitSegment,
} from "./math";
import type { TimelineState, TimelineStoreState } from "./types";

/**
 * Dependencies that can be injected into the timeline store factory for testing.
 */
export interface TimelineStoreDependencies {
  /**
   * Function to generate unique, collision-resistant segment identifiers.
   * Defaults to `generateSegmentId`.
   */
  generateId?: () => string;
}

/**
 * Generates a collision-resistant segment ID.
 */
export function generateSegmentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `seg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
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
    frameCount: initialState?.frameCount ?? 0,
    segments: initialState?.segments ? [...initialState.segments] : [],
    pendingInFrame: initialState?.pendingInFrame ?? null,
    canUndo: initialState?.canUndo ?? false,
    canRedo: initialState?.canRedo ?? false,

    setSource: (sourceId: string | null, frameCount: number) => {
      // 1. Clear / Reset if sourceId is null or empty
      if (sourceId === null || sourceId === "") {
        undoStack = [];
        redoStack = [];
        set({
          sourceId: null,
          frameCount: 0,
          segments: [],
          pendingInFrame: null,
          canUndo: false,
          canRedo: false,
        });
        return;
      }

      // 2. Validate inputs
      if (
        typeof sourceId !== "string" ||
        !Number.isSafeInteger(frameCount) ||
        frameCount < 0
      ) {
        return;
      }

      const current = get();

      // 3. Same source identity AND same frameCount: preserve edits, pendingIn, and history
      if (current.sourceId === sourceId && current.frameCount === frameCount) {
        return;
      }

      // 4. Source changed or frameCount changed (changed edit grid): reset edits and history
      undoStack = [];
      redoStack = [];
      set({
        sourceId,
        frameCount,
        segments: [],
        pendingInFrame: null,
        canUndo: false,
        canRedo: false,
      });
    },

    markIn: (frame: number) => {
      const state = get();
      if (!state.sourceId || state.frameCount <= 0) {
        return;
      }

      if (
        typeof frame !== "number" ||
        !Number.isSafeInteger(frame) ||
        frame < 0 ||
        frame >= state.frameCount
      ) {
        return;
      }

      set({ pendingInFrame: frame });
    },

    markOut: (currentFrame: number) => {
      const state = get();
      if (!state.sourceId || state.frameCount <= 0) {
        return;
      }

      if (state.pendingInFrame === null) {
        return;
      }

      if (
        typeof currentFrame !== "number" ||
        !Number.isSafeInteger(currentFrame) ||
        currentFrame < 0 ||
        currentFrame >= state.frameCount
      ) {
        return;
      }

      if (currentFrame < state.pendingInFrame) {
        return;
      }

      const inFrame = state.pendingInFrame;
      const outFrame = calculateExclusiveOutFrame(currentFrame, state.frameCount);

      if (outFrame <= inFrame) {
        return;
      }

      const newSegment: Segment = {
        id: generateId(),
        sourceId: state.sourceId,
        inFrame,
        outFrame,
      };

      undoStack.push(state.segments);
      redoStack = [];

      const nextSegments = insertSegmentInSourceOrder(state.segments, newSegment);

      set({
        segments: nextSegments,
        pendingInFrame: null,
        canUndo: true,
        canRedo: false,
      });
    },

    split: (currentFrame: number) => {
      const state = get();
      if (!state.sourceId || state.frameCount <= 0) {
        return;
      }

      if (
        typeof currentFrame !== "number" ||
        !Number.isSafeInteger(currentFrame) ||
        currentFrame < 0 ||
        currentFrame >= state.frameCount
      ) {
        return;
      }

      const targetIndex = findSplittableSegmentIndex(state.segments, currentFrame);
      if (targetIndex === -1) {
        return;
      }

      const targetSeg = state.segments[targetIndex];
      const [leftSeg, rightSeg] = splitSegment(targetSeg, currentFrame, generateId());

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
      set({ pendingInFrame: null });
    },

    reset: () => {
      undoStack = [];
      redoStack = [];
      set({
        sourceId: null,
        frameCount: 0,
        segments: [],
        pendingInFrame: null,
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
