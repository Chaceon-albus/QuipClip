/**
 * Timeline store of a sequence of clips: the clips, the anchored segments, the pending In mark,
 * the selection, and the history of undo and redo (ADR 007, ADR 045, ADR 052).
 *
 * The truth is anchored: each boundary is a clip and a source PTS (ADR 052). The interface reads
 * a derived view in which the sequence is one virtual source (`virtualTime.ts`), under the field
 * names that it read before: `sourceId`, `segments` and `pendingInPts`. The edit actions take a
 * virtual PTS of the frame on screen and turn it back into an edit point on the attached clip,
 * never by a guess between clips.
 *
 * Every segment operation names its target through `currentSegmentId`, so no operation has to
 * guess a segment from the playhead. Delete names its targets through `selectedSegmentIds`,
 * which can hold several segments (ADR 045).
 *
 * Implements ADR 002 (rational time / exclusive out points), ADR 007 and ADR 052.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { isPtsString } from "@/lib/time";
import type { Clip, EditPoint, Pts, Segment, SequenceSegment } from "@/types/project";
import {
  canonicalIn,
  canonicalOut,
  compareEditPoints,
  insertClips as insertClipsInto,
  isValidSequenceSegment,
  layoutSequence,
  moveClip as moveClipIn,
  removeClip as removeClipFrom,
  type SequenceSource,
  type SequenceSources,
} from "./sequence";
import type {
  SegmentEdge,
  TimelineState,
  TimelineStoreState,
  TimelineTruth,
} from "./types";
import { buildVirtualTimeline, fromVirtualPts, toVirtualPts } from "./virtualTime";

/**
 * The prefix of the virtual source ID of the sequence. The ID is `sequence:<generation>`, so the
 * view state that a new source reset before (the zoom, the scroll, the fade baseline) resets when
 * the sequence gets its first clip, and not when a clip operation changes it (ADR 052).
 */
export const SEQUENCE_SOURCE_ID = "sequence";

/** The virtual source ID of a generation of the sequence. */
export function sequenceSourceIdOf(generation: number): string {
  return `${SEQUENCE_SOURCE_ID}:${generation}`;
}

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
 * The identifier of the one clip of a source while the sequence holds one file (ADR 027). A
 * source that comes back gets the same clip, and so the segments of that clip.
 */
export function singleClipIdOf(sourceId: string): string {
  return `clip:${sourceId}`;
}

interface TimelineHistoryEntry {
  clips: readonly Clip[];
  sequenceSegments: readonly SequenceSegment[];
  pendingIn: EditPoint | null;
  /** The selection, which also gives the current segment (`selectionOf`). */
  selectedSegmentIds: readonly string[];
}

/**
 * Captures the restorable state of one edit. Every push site uses this factory, so the
 * entry shape lives in one place.
 */
function historyEntry(state: TimelineTruth & TimelineState): TimelineHistoryEntry {
  return {
    clips: state.clips,
    sequenceSegments: state.sequenceSegments,
    pendingIn: state.pendingIn,
    selectedSegmentIds: state.selectedSegmentIds,
  };
}

/**
 * The two selection fields for a list of selected identifiers. Every write of the selection
 * goes through it, so `currentSegmentId` is the only selected segment while exactly one is
 * selected, and null otherwise (ADR 045).
 */
function selectionOf(
  ids: readonly string[],
): Pick<TimelineState, "selectedSegmentIds" | "currentSegmentId"> {
  return {
    selectedSegmentIds: ids,
    currentSegmentId: ids.length === 1 ? (ids[0] ?? null) : null,
  };
}

const NO_SELECTION = selectionOf([]);

function sourcesOf(truth: Pick<TimelineTruth, "sequenceSources">): SequenceSources {
  return new Map(Object.entries(truth.sequenceSources));
}

function browserDurationsOf(
  truth: Pick<TimelineTruth, "browserDurations">,
): ReadonlyMap<string, number> {
  return new Map(Object.entries(truth.browserDurations));
}

/** True when a segment lies on the sequence and keeps every rule of ADR 052. */
function isLive(segment: SequenceSegment, truth: TimelineTruth): boolean {
  return isValidSequenceSegment(segment, truth.clips, sourcesOf(truth));
}

function sameEditPoint(a: EditPoint, b: EditPoint): boolean {
  return a.clipId === b.clipId && a.pts === b.pts;
}

/**
 * The derived view of the truth: the virtual axis, the virtual source, and the segments and the
 * pending In as virtual PTS. Every write of the truth goes through it.
 */
function derive(
  truth: TimelineTruth,
): Omit<
  TimelineState,
  | keyof TimelineTruth
  | "currentSegmentId"
  | "selectedSegmentIds"
  | "canUndo"
  | "canRedo"
> {
  if (truth.clips.length === 0) {
    return {
      virtual: null,
      sourceId: null,
      sourceRevisionKey: null,
      segments: [],
      pendingInPts: null,
    };
  }
  const sources = sourcesOf(truth);
  const virtual = buildVirtualTimeline(truth.clips, sources, browserDurationsOf(truth));
  const sourceId = sequenceSourceIdOf(truth.generation);
  const segments: Segment[] = [];
  if (virtual !== null) {
    for (const segment of truth.sequenceSegments) {
      if (!isValidSequenceSegment(segment, truth.clips, sources)) {
        continue;
      }
      const inPts = toVirtualPts(virtual, {
        clipId: segment.inClipId,
        pts: segment.inPts,
      });
      const outPts = toVirtualPts(virtual, {
        clipId: segment.outClipId,
        pts: segment.outPts,
      });
      if (inPts !== null && outPts !== null) {
        segments.push({ id: segment.id, sourceId, inPts, outPts });
      }
    }
  }
  return {
    virtual,
    sourceId,
    sourceRevisionKey: sourceId,
    segments,
    pendingInPts:
      virtual === null || truth.pendingIn === null
        ? null
        : toVirtualPts(virtual, truth.pendingIn),
  };
}

/**
 * The derived view `next` with the segment objects of `previous` kept wherever they are equal, and
 * the list of `previous` kept when every segment is equal.
 */
function shareDerived(
  previous: TimelineState,
  next: ReturnType<typeof derive>,
): ReturnType<typeof derive> {
  const byId = new Map(previous.segments.map((segment) => [segment.id, segment]));
  const segments = next.segments.map((segment) => {
    const old = byId.get(segment.id);
    return old !== undefined &&
      old.sourceId === segment.sourceId &&
      old.inPts === segment.inPts &&
      old.outPts === segment.outPts
      ? old
      : segment;
  });
  const sameList =
    segments.length === previous.segments.length &&
    segments.every((segment, index) => segment === previous.segments[index]);
  return { ...next, segments: sameList ? previous.segments : segments };
}

function truthOf(state: TimelineState): TimelineTruth {
  return {
    clips: state.clips,
    sequenceSegments: state.sequenceSegments,
    pendingIn: state.pendingIn,
    sequenceSources: state.sequenceSources,
    browserDurations: state.browserDurations,
    attachedClipId: state.attachedClipId,
    generation: state.generation,
  };
}

/** Replaces one segment in place, preserving the array order that is the export order. */
function replaceSegmentAt(
  segments: readonly SequenceSegment[],
  index: number,
  segment: SequenceSegment,
): SequenceSegment[] {
  const next = [...segments];
  next[index] = segment;
  return next;
}

/** A segment of the truth with its index, resolved only while it is live. */
interface AnchoredTarget {
  readonly index: number;
  readonly segment: SequenceSegment;
}

function findLiveSegment(
  truth: TimelineTruth,
  id: string | null,
): AnchoredTarget | null {
  if (id === null) {
    return null;
  }
  const index = truth.sequenceSegments.findIndex((segment) => segment.id === id);
  const segment = truth.sequenceSegments[index];
  if (segment === undefined || !isLive(segment, truth)) {
    return null;
  }
  return { index, segment };
}

/** The live segments among `ids`, in project array order. */
function liveSelection(truth: TimelineTruth, ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return truth.sequenceSegments
    .filter((segment) => wanted.has(segment.id) && isLive(segment, truth))
    .map((segment) => segment.id);
}

/**
 * Factory function creating a vanilla Zustand store instance for timeline state.
 *
 * Undo/redo history stacks are maintained in the store factory closure to ensure
 * that the public store state remains strictly serializable.
 *
 * @param dependencies Injected dependencies for testing (e.g. deterministic ID generator).
 * @param initialTruth Optional initial truth and selection for testing.
 */
export function createTimelineStore(
  dependencies: TimelineStoreDependencies = {},
  initialTruth?: Partial<TimelineTruth> &
    Partial<Pick<TimelineState, "selectedSegmentIds" | "currentSegmentId">>,
): StoreApi<TimelineStoreState> {
  const generateId = dependencies.generateId ?? generateSegmentId;

  let undoStack: TimelineHistoryEntry[] = [];
  let redoStack: TimelineHistoryEntry[] = [];

  const emptyTruth: TimelineTruth = {
    clips: [],
    sequenceSegments: [],
    pendingIn: null,
    sequenceSources: {},
    browserDurations: {},
    attachedClipId: null,
    generation: 0,
  };

  return createStore<TimelineStoreState>()((set, get) => {
    /**
     * Writes truth fields, and the derived view with them. The derived view keeps the objects of
     * the view before when nothing they depend on changed, so a selector of `segments` sees one
     * list until a segment, a clip or an extent changes, as it did before ADR 052.
     */
    const write = (
      patch: Partial<TimelineTruth> &
        Partial<
          Pick<
            TimelineState,
            "selectedSegmentIds" | "currentSegmentId" | "canUndo" | "canRedo"
          >
        >,
    ): void => {
      const state = get();
      const next: TimelineTruth = { ...truthOf(state), ...patch };
      const sameInputs =
        next.clips === state.clips &&
        next.sequenceSegments === state.sequenceSegments &&
        next.sequenceSources === state.sequenceSources &&
        next.browserDurations === state.browserDurations &&
        next.generation === state.generation;
      if (sameInputs) {
        const pendingInPts =
          next.pendingIn === state.pendingIn
            ? state.pendingInPts
            : state.virtual === null || next.pendingIn === null
              ? null
              : toVirtualPts(state.virtual, next.pendingIn);
        set({ ...patch, pendingInPts });
        return;
      }
      set({ ...patch, ...shareDerived(state, derive(next)) });
    };

    /** Pushes the state before an edit, and clears the redo stack. */
    const pushHistory = (): void => {
      undoStack.push(historyEntry(get()));
      redoStack = [];
    };

    /**
     * The edit point of a virtual PTS of the frame on screen: on the attached clip, or on the one
     * clip of a sequence of one clip. Null when no clip is known or the PTS is not on its grid.
     */
    const pointOnScreen = (pts: Pts): EditPoint | null => {
      const state = get();
      if (!isPtsString(pts) || state.virtual === null) {
        return null;
      }
      const clipId =
        state.attachedClipId !== null &&
        state.clips.some((clip) => clip.id === state.attachedClipId)
          ? state.attachedClipId
          : state.clips.length === 1
            ? (state.clips[0]?.id ?? null)
            : null;
      return clipId === null ? null : fromVirtualPts(state.virtual, pts, clipId);
    };

    /**
     * Moves one boundary of a live segment, with one history entry. Mark In and Mark Out on a
     * current segment, and the commit of a trim (ADR 030), share this one rule, so the three paths
     * accept and refuse the same values. A repeated boundary makes no change and no history
     * entry. A move that breaks a rule of ADR 052 makes no change either. The replacement keeps
     * the array order, which is the export order (ADR 007).
     */
    const moveBoundary = (
      target: AnchoredTarget,
      edge: SegmentEdge,
      point: EditPoint,
    ): void => {
      const state = get();
      const { index, segment } = target;
      const current: EditPoint =
        edge === "in"
          ? { clipId: segment.inClipId, pts: segment.inPts }
          : { clipId: segment.outClipId, pts: segment.outPts };
      if (sameEditPoint(current, point)) {
        return;
      }
      const moved: SequenceSegment =
        edge === "in"
          ? { ...segment, inClipId: point.clipId, inPts: point.pts }
          : { ...segment, outClipId: point.clipId, outPts: point.pts };
      if (!isLive(moved, state)) {
        return;
      }
      pushHistory();
      write({
        sequenceSegments: replaceSegmentAt(state.sequenceSegments, index, moved),
        canUndo: true,
        canRedo: false,
      });
    };

    /**
     * Ends whatever segment is in progress, so the next Mark In starts a new one. Both fields
     * describe the segment being built, so both end together, and a selection of several
     * segments ends with them (ADR 045). No history entry.
     */
    const endSegmentInProgress = (): void => {
      write({ ...NO_SELECTION, pendingIn: null });
    };

    /**
     * Completes the pending In mark into a new segment that ends at `out`, with one history entry,
     * and clears the pending mark. Mark Out and Finish Segment share this rule. Returns false,
     * with no change, when no In is pending or the segment would break a rule of ADR 052.
     *
     * The segment goes to the end of the array, which is the export order (ADR 007).
     */
    const completePendingIn = (out: EditPoint, makeCurrent: boolean): boolean => {
      const state = get();
      if (state.pendingIn === null) {
        return false;
      }
      const candidate: SequenceSegment = {
        id: "",
        inClipId: state.pendingIn.clipId,
        inPts: state.pendingIn.pts,
        outClipId: out.clipId,
        outPts: out.pts,
      };
      if (!isLive(candidate, state)) {
        return false;
      }
      // The identifier comes after the checks, so a refused mark uses none (ADR 007).
      const completed: SequenceSegment = { ...candidate, id: generateId() };
      pushHistory();
      write({
        sequenceSegments: [...state.sequenceSegments, completed],
        pendingIn: null,
        ...selectionOf(makeCurrent ? [completed.id] : []),
        canUndo: true,
        canRedo: false,
      });
      return true;
    };

    /**
     * Applies a clip operation of `sequence.ts`, with one history entry. Refuses, with no change, a
     * result that has clips and no virtual axis: its segments would leave the view, and every edit
     * would refuse. Returns whether it applied.
     */
    const applyClipEdit = (
      edited: { clips: readonly Clip[]; sequenceSegments: readonly SequenceSegment[] },
      extra: Partial<TimelineTruth> = {},
    ): boolean => {
      const state = get();
      const next = { ...truthOf(state), ...extra, ...edited };
      if (
        next.clips.length > 0 &&
        buildVirtualTimeline(next.clips, sourcesOf(next), browserDurationsOf(next)) ===
          null
      ) {
        return false;
      }
      const pendingIn =
        next.pendingIn !== null &&
        next.clips.some((clip) => clip.id === next.pendingIn?.clipId)
          ? next.pendingIn
          : null;
      const attachedClipId = nextAttachedClip(
        state.clips,
        next.clips,
        state.attachedClipId,
      );
      pushHistory();
      write({
        ...extra,
        attachedClipId,
        clips: edited.clips,
        sequenceSegments: edited.sequenceSegments,
        pendingIn,
        ...selectionOf(liveSelection({ ...next, pendingIn }, state.selectedSegmentIds)),
        generation:
          state.clips.length === 0 && edited.clips.length > 0
            ? state.generation + 1
            : (extra.generation ?? state.generation),
        canUndo: true,
        canRedo: false,
      });
      return true;
    };

    /** Restores a history entry over the current state. */
    const restore = (entry: TimelineHistoryEntry): void => {
      const state = get();
      const next: TimelineTruth = {
        ...truthOf(state),
        clips: entry.clips,
        sequenceSegments: entry.sequenceSegments,
      };
      const pendingIn =
        entry.pendingIn !== null &&
        entry.clips.some((clip) => clip.id === entry.pendingIn?.clipId)
          ? entry.pendingIn
          : null;
      write({
        attachedClipId: nextAttachedClip(
          state.clips,
          entry.clips,
          state.attachedClipId,
        ),
        clips: entry.clips,
        sequenceSegments: entry.sequenceSegments,
        pendingIn,
        ...selectionOf(liveSelection(next, entry.selectedSegmentIds)),
        generation:
          state.clips.length === 0 && entry.clips.length > 0
            ? state.generation + 1
            : state.generation,
      });
    };

    const initial: TimelineTruth = { ...emptyTruth, ...initialTruth };
    return {
      ...initial,
      ...derive(initial),
      // A test can give the current segment alone, which is a selection of that one segment.
      ...selectionOf(
        initialTruth?.selectedSegmentIds ??
          (initialTruth?.currentSegmentId ? [initialTruth.currentSegmentId] : []),
      ),
      canUndo: false,
      canRedo: false,

      showOnlySource: (source: SequenceSource | null) => {
        const state = get();
        if (source === null) {
          if (state.clips.length === 0) {
            return;
          }
          undoStack = [];
          redoStack = [];
          write({
            clips: [],
            pendingIn: null,
            ...NO_SELECTION,
            canUndo: false,
            canRedo: false,
          });
          return;
        }
        const clipId = singleClipIdOf(source.id);
        if (state.clips.length === 1 && state.clips[0]?.id === clipId) {
          // The same source again. Its facts can be newer, for example after a read of the end
          // of the file that failed before, so they replace the old ones.
          if (state.sequenceSources[source.id] !== source) {
            write({
              sequenceSources: { ...state.sequenceSources, [source.id]: source },
            });
          }
          return;
        }
        // Another file replaces the open one (ADR 027). Its segments stay in the array and come
        // back with its clip. The history of the old file cannot apply to the new one.
        undoStack = [];
        redoStack = [];
        write({
          clips: [{ id: clipId, sourceId: source.id }],
          sequenceSources: { ...state.sequenceSources, [source.id]: source },
          pendingIn: null,
          attachedClipId: clipId,
          ...NO_SELECTION,
          generation: state.generation + 1,
          canUndo: false,
          canRedo: false,
        });
      },

      insertClips: (index, clips, sources) => {
        const state = get();
        const sequenceSources = { ...state.sequenceSources };
        for (const source of sources) {
          sequenceSources[source.id] = source;
        }
        const allSources: SequenceSources = new Map(Object.entries(sequenceSources));
        const edited = insertClipsInto(
          { clips: state.clips, segments: liveSegments(state) },
          index,
          clips,
          allSources,
          generateId,
        );
        if (edited === null || edited.clips === state.clips) {
          return false;
        }
        if (
          layoutSequence(edited.clips, allSources, browserDurationsOf(state)) === null
        ) {
          return false;
        }
        return applyClipEdit(
          {
            clips: edited.clips,
            sequenceSegments: mergeDormant(state, edited.segments),
          },
          { sequenceSources },
        );
      },

      moveClip: (from, to) => {
        const state = get();
        const edited = moveClipIn(
          { clips: state.clips, segments: liveSegments(state) },
          from,
          to,
          sourcesOf(state),
          generateId,
        );
        if (edited === null || edited.clips === state.clips) {
          return;
        }
        applyClipEdit({
          clips: edited.clips,
          sequenceSegments: mergeDormant(state, edited.segments),
        });
      },

      removeClip: (index) => {
        const state = get();
        const edited = removeClipFrom(
          { clips: state.clips, segments: liveSegments(state) },
          index,
          sourcesOf(state),
        );
        if (edited === null) {
          return;
        }
        applyClipEdit({
          clips: edited.clips,
          sequenceSegments: mergeDormant(state, edited.segments),
        });
      },

      clearTimeline: () => {
        const state = get();
        if (state.clips.length === 0 && state.sequenceSegments.length === 0) {
          return;
        }
        applyClipEdit({ clips: [], sequenceSegments: [] });
      },

      setAttachedClip: (clipId) => {
        if (get().attachedClipId !== clipId) {
          write({ attachedClipId: clipId });
        }
      },

      setBrowserDuration: (sourceId, seconds) => {
        const state = get();
        const known = state.browserDurations[sourceId];
        if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
          if (known === undefined) {
            return;
          }
          const next = { ...state.browserDurations };
          delete next[sourceId];
          write({ browserDurations: next });
          return;
        }
        if (known !== seconds) {
          write({
            browserDurations: { ...state.browserDurations, [sourceId]: seconds },
          });
        }
      },

      markIn: (pts: Pts) => {
        const point = pointOnScreen(pts);
        if (point === null) {
          return;
        }
        const state = get();
        const sources = sourcesOf(state);
        // An In at the end of a clip is the start of the next clip (ADR 052).
        const inPoint = canonicalIn(point, state.clips, sources);
        if (inPoint === null) {
          return;
        }
        const current = findLiveSegment(state, state.currentSegmentId);

        // Nothing is current, so the mark starts a segment instead of adjusting one. A
        // selection of several segments ends, because no segment is selected while an In mark
        // is pending (ADR 045). No history entry: the pending mark is not yet a canonical edit.
        if (current === null) {
          write({ ...NO_SELECTION, pendingIn: inPoint });
          return;
        }

        // At or after the exclusive Out, a moved In would leave no frame in the segment
        // (ADR 002). The mark instead finishes the segment and starts the next one at this
        // frame, as one action with one history entry (ADR 007).
        const outPoint: EditPoint = {
          clipId: current.segment.outClipId,
          pts: current.segment.outPts,
        };
        const order = compareEditPoints(inPoint, outPoint, state.clips, sources);
        if (order !== null && order >= 0) {
          pushHistory();
          write({ ...NO_SELECTION, pendingIn: inPoint, canUndo: true, canRedo: false });
          return;
        }
        moveBoundary(current, "in", inPoint);
      },

      markOut: (currentPts: Pts) => {
        const point = pointOnScreen(currentPts);
        if (point === null) {
          return;
        }
        const state = get();
        // An Out on the first frame of a clip is the end of the clip before it (ADR 052). With
        // no known end there, no Out can be written.
        const outPoint = canonicalOut(point, state.clips, sourcesOf(state));
        if (outPoint === null) {
          return;
        }
        const current = findLiveSegment(state, state.currentSegmentId);
        if (current !== null) {
          // On the exclusive Out, a move would change nothing. The mark instead finishes the
          // segment, as Finish Segment does (ADR 007).
          if (
            sameEditPoint(outPoint, {
              clipId: current.segment.outClipId,
              pts: current.segment.outPts,
            })
          ) {
            endSegmentInProgress();
            return;
          }
          moveBoundary(current, "out", outPoint);
          return;
        }

        // The completed segment becomes current, so the next Mark In or Split adjusts it.
        completePendingIn(outPoint, true);
      },

      split: (currentPts: Pts) => {
        const point = pointOnScreen(currentPts);
        if (point === null) {
          return;
        }
        const state = get();
        const current = findLiveSegment(state, state.currentSegmentId);
        if (current === null) {
          return;
        }
        const sources = sourcesOf(state);
        const { index, segment } = current;
        const leftOut = canonicalOut(point, state.clips, sources);
        const rightIn = canonicalIn(point, state.clips, sources);
        if (leftOut === null || rightIn === null) {
          return;
        }
        // The left half keeps the identifier, so the current segment stays current with no
        // selection write here, and undo restores the same target (ADR 007).
        const left: SequenceSegment = {
          ...segment,
          outClipId: leftOut.clipId,
          outPts: leftOut.pts,
        };
        const rightBounds: SequenceSegment = {
          ...segment,
          inClipId: rightIn.clipId,
          inPts: rightIn.pts,
        };
        if (!isLive(left, state) || !isLive(rightBounds, state)) {
          return;
        }
        const right: SequenceSegment = { ...rightBounds, id: generateId() };
        pushHistory();
        write({
          sequenceSegments: [
            ...state.sequenceSegments.slice(0, index),
            left,
            right,
            ...state.sequenceSegments.slice(index + 1),
          ],
          canUndo: true,
          canRedo: false,
        });
      },

      trimSegmentEdge: (segmentId: string, edge: SegmentEdge, pts: Pts) => {
        if (edge !== "in" && edge !== "out") {
          return;
        }
        const point = pointOnScreen(pts);
        if (point === null) {
          return;
        }
        const state = get();
        const target = findLiveSegment(state, segmentId);
        if (target === null) {
          return;
        }
        const sources = sourcesOf(state);
        const boundary =
          edge === "in"
            ? canonicalIn(point, state.clips, sources)
            : canonicalOut(point, state.clips, sources);
        if (boundary === null) {
          return;
        }
        moveBoundary(target, edge, boundary);
      },

      finishSegment: (outPts: Pts | null) => {
        const state = get();
        const current = findLiveSegment(state, state.currentSegmentId);
        // A pending In mark with a valid Out completes a segment, which is not current after
        // it. Every other case only ends what is in progress: a current segment is already
        // canonical, and a pending In mark that no Out can complete is dropped.
        if (current === null && outPts !== null) {
          const point = pointOnScreen(outPts);
          const outPoint =
            point === null ? null : canonicalOut(point, state.clips, sourcesOf(state));
          if (outPoint !== null && completePendingIn(outPoint, false)) {
            return;
          }
        }
        endSegmentInProgress();
      },

      deleteSelectedSegments: () => {
        const state = get();
        const selected = liveSelection(state, state.selectedSegmentIds);
        if (selected.length === 0) {
          return;
        }
        pushHistory();
        // `filter` preserves array order, which is the export order (ADR 007). Nothing
        // becomes selected, so the next Delete or Split cannot act on an unnamed segment.
        const removed = new Set(selected);
        write({
          sequenceSegments: state.sequenceSegments.filter(
            (segment) => !removed.has(segment.id),
          ),
          ...NO_SELECTION,
          canUndo: true,
          canRedo: false,
        });
      },

      selectSegment: (id: string) => {
        const state = get();
        if (findLiveSegment(state, id) === null) {
          return;
        }
        // Selection is not an edit, so it pushes no history entry. It clears the pending
        // mark to hold the invariant that only one segment is ever in progress.
        write({ ...selectionOf([id]), pendingIn: null });
      },

      toggleSegmentSelection: (id: string) => {
        const state = get();
        if (findLiveSegment(state, id) === null) {
          return;
        }
        const selected = new Set(liveSelection(state, state.selectedSegmentIds));
        if (selected.has(id)) {
          selected.delete(id);
        } else {
          selected.add(id);
        }
        // Not an edit, so no history entry. No In mark is pending while a segment is selected.
        write({ ...selectionOf(liveSelection(state, [...selected])), pendingIn: null });
      },

      selectAllSegments: () => {
        const state = get();
        const ids = liveSelection(
          state,
          state.sequenceSegments.map((segment) => segment.id),
        );
        if (ids.length === 0) {
          return;
        }
        // Not an edit, so no history entry. No In mark is pending while a segment is selected.
        write({ ...selectionOf(ids), pendingIn: null });
      },

      undo: () => {
        const previous = undoStack.pop();
        if (previous === undefined) {
          return;
        }
        redoStack.push(historyEntry(get()));
        restore(previous);
        set({ canUndo: undoStack.length > 0, canRedo: true });
      },

      redo: () => {
        const next = redoStack.pop();
        if (next === undefined) {
          return;
        }
        undoStack.push(historyEntry(get()));
        restore(next);
        set({ canUndo: true, canRedo: redoStack.length > 0 });
      },

      clearPendingIn: () => {
        write({ pendingIn: null });
      },

      reset: () => {
        undoStack = [];
        redoStack = [];
        write({
          ...emptyTruth,
          generation: get().generation,
          ...NO_SELECTION,
          canUndo: false,
          canRedo: false,
        });
      },
    };
  });
}

/**
 * The attached clip after the clips change (ADR 052): the same clip while it stays, else the clip
 * that took its place, else the clip before it, and none on an empty sequence. A sequence that
 * had no attached clip attaches its first clip.
 */
function nextAttachedClip(
  before: readonly Clip[],
  after: readonly Clip[],
  attached: string | null,
): string | null {
  if (after.length === 0) {
    return null;
  }
  if (attached !== null && after.some((clip) => clip.id === attached)) {
    return attached;
  }
  const index =
    attached === null ? -1 : before.findIndex((clip) => clip.id === attached);
  return after[index < 0 ? 0 : Math.min(index, after.length - 1)]?.id ?? null;
}

/** The live segments of the truth, the input of a clip operation of `sequence.ts`. */
function liveSegments(truth: TimelineTruth): SequenceSegment[] {
  return truth.sequenceSegments.filter((segment) => isLive(segment, truth));
}

/**
 * The segments after a clip operation: the edited live segments, with each segment that was not
 * live kept in the array after them. Such a segment belongs to a clip that is not on the
 * sequence, the clip of a file that another file replaced (ADR 027), and it comes back with that
 * clip.
 */
function mergeDormant(
  truth: TimelineTruth,
  edited: readonly SequenceSegment[],
): SequenceSegment[] {
  const dormant = truth.sequenceSegments.filter((segment) => !isLive(segment, truth));
  return [...edited, ...dormant];
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
