/**
 * The runtime of the drag trim of a segment edge (ADR 030): the one trim that runs, its commit
 * after the release, and a small external store that the trim preview, the trim notice, the
 * segment layer and the window keyboard layer read.
 *
 * Every decision is a pure function of `segmentTrim.ts`. This module runs those functions
 * against the playback store and the timeline store, which it takes as dependencies, so the
 * tests drive it with real stores and a fake media element. It has no DOM and no React
 * dependency. The timeline panel owns the pointer gesture and feeds its samples here.
 *
 * A trim has two phases:
 *
 * - `dragging`: from the drag threshold to the release. Each sample sends a scrub seek. The
 *   stored segment does not change, and no history entry is made.
 * - `committing`: after the release, while the trim waits for the frame that commits it. The
 *   preview still shows the target. The wait ends after at most `TRIM_FRAME_WAIT_MS` of
 *   visible time from the release.
 *
 * The commit is one call of `trimSegmentEdge`, so one trim is one undo step. A trim that ends
 * after its release with no commit is a failed trim: the session counts it (`getNoticeCount`),
 * and the timeline tells the user that the trim was not applied.
 */

import type { StoreApi } from "zustand/vanilla";
import {
  stepAnchorWait,
  type AnchorWaitEvent,
  type AnchorWaitPhase,
} from "@/components/preview/anchorWait";
import { playbackStore, type PlaybackStoreState } from "@/features/playback";
import { timelineStore, type TimelineStoreState } from "@/features/timeline";
import type { Pts } from "@/types/project";
import type { SegmentEdge } from "./segmentEdges";
import {
  beginTrimAwait,
  canCommitTrim,
  isTrimCurrent,
  planSegmentTrimStart,
  planTrimCancel,
  planTrimRelease,
  resolveTrimAwait,
  TRIM_FRAME_WAIT_MS,
  type SegmentTrim,
  type SegmentTrimProbe,
  type TrimAwait,
  type TrimAwaitDecision,
  type TrimSeek,
  type TrimTarget,
} from "./segmentTrim";

/** What the interface shows of the trim that runs. */
export interface SegmentTrimView {
  readonly segmentId: string;
  readonly edge: SegmentEdge;
  /** The stored boundary of the other edge, which the preview holds still. */
  readonly fixedPts: Pts;
  readonly phase: "dragging" | "committing";
}

/** The timers of a session, so a test can drive the bound of the wait. */
export interface SegmentTrimClock {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

/** The stores that a session reads and writes. The production stores satisfy it. */
export interface SegmentTrimSessionStores {
  readonly playback: Pick<StoreApi<PlaybackStoreState>, "getState" | "subscribe">;
  readonly timeline: Pick<StoreApi<TimelineStoreState>, "getState">;
  /** The timers of the bound of the wait. The global timers by default. */
  readonly clock?: SegmentTrimClock;
  /**
   * True while the document is visible. The bound of the wait counts only visible time. The
   * visibility of the document by default, and true where no document exists.
   */
  readonly isVisible?: () => boolean;
}

/** The facts of a press that the timeline panel passes to start a trim. */
export interface SegmentTrimBeginInput {
  readonly segmentId: string;
  readonly edge: SegmentEdge;
  /** True while media is open and its element is attached and ready (`isSourceActive`). */
  readonly hasActiveSource: boolean;
  /** The probe of the open media, or null while no media is open. */
  readonly probe: SegmentTrimProbe | null;
  /** The source extent of the ruler (ADR 007), or null when it is not known. */
  readonly totalDurationSeconds: number | null;
}

/**
 * The session. Its members are function properties and not methods, so a caller can pass
 * `getView`, `getNoticeCount` and `subscribe` to `useSyncExternalStore` without a bound `this`.
 */
export interface SegmentTrimSession {
  /** The trim that runs, as the interface shows it, or null. */
  readonly getView: () => SegmentTrimView | null;
  /**
   * The number of trims that ended after their release with no commit. The trim notice shows
   * its message each time the count goes up.
   */
  readonly getNoticeCount: () => number;
  /** Subscribes to changes of the view and of the notice count. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The trim that the pointer drags, or null when no trim is in its `dragging` phase. */
  readonly getDraggingTrim: () => SegmentTrim | null;
  /** True while a trim is in its `dragging` phase. */
  readonly isDragging: () => boolean;
  /** True when a press with these facts can start a trim (`planSegmentTrimStart`). */
  readonly canBegin: (input: SegmentTrimBeginInput) => boolean;
  /**
   * Starts a trim at the drag threshold, and selects its segment (ADR 030). A trim that still
   * waits for its frame fails first. Returns false, and changes nothing, when the press cannot
   * start a trim.
   */
  readonly begin: (input: SegmentTrimBeginInput) => boolean;
  /** Sends the scrub seek of one sample of the drag (ADR 022). */
  readonly scrub: (target: TrimTarget | null) => void;
  /**
   * Ends the drag at the release, with the target of the release (`planTrimRelease`): it
   * writes at once, waits for the frame that commits it, or fails.
   */
  readonly release: (target: TrimTarget | null) => void;
  /**
   * Ends the drag because the browser cancelled it or the window lost focus. The trim makes no
   * change. The playhead gets the one exact seek of a cancelled drag (ADR 022), so the drag
   * never ends on a keyframe.
   */
  readonly abandon: (target: TrimTarget | null) => void;
  /**
   * `Escape` during the drag: the trim makes no change, the pointer gesture ends, and the
   * playhead returns to its position at the start (ADR 030). Does nothing when no trim drags.
   */
  readonly cancel: () => void;
  /** Ends any trim, in either phase, with no change, no seek and no notice. */
  readonly drop: () => void;
  /**
   * Ends any trim, in either phase, with no change and no seek, and counts it for the notice.
   * The panel calls it when the calibration or the source stops holding during the drag.
   */
  readonly fail: () => void;
  /**
   * Registers the function that ends the pointer gesture of the panel, for `cancel`. The
   * gesture then sends no final seek of its own.
   */
  readonly setDragCanceller: (canceller: (() => void) | null) => void;
  /**
   * The visibility of the document changed. The bound of a waiting trim stops while the
   * document is hidden, and starts again when it is visible.
   */
  readonly visibilityChanged: (visible: boolean) => void;
}

const DEFAULT_CLOCK: SegmentTrimClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** Creates a session on the given stores. */
export function createSegmentTrimSession(
  stores: SegmentTrimSessionStores,
): SegmentTrimSession {
  const { playback, timeline } = stores;
  const clock = stores.clock ?? DEFAULT_CLOCK;
  const isVisible = stores.isVisible ?? isDocumentVisible;
  const listeners = new Set<() => void>();
  let trim: SegmentTrim | null = null;
  let view: SegmentTrimView | null = null;
  let noticeCount = 0;
  // The subscription, the timer and the phase of the bound of a trim that waits for its frame.
  // The bound follows the rule of the wait for the calibration anchor (`stepAnchorWait`): it
  // runs only while the document is visible, and each return to visible starts it again.
  let stopAwait: (() => void) | null = null;
  let boundTimer: unknown = null;
  let boundPhase: AnchorWaitPhase = "idle";
  let dragCanceller: (() => void) | null = null;

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setView = (next: SegmentTrimView | null): void => {
    if (next === view) {
      return;
    }
    view = next;
    notify();
  };

  const viewOf = (current: SegmentTrim, phase: SegmentTrimView["phase"]) => ({
    segmentId: current.segmentId,
    edge: current.edge,
    fixedPts: current.fixedPts,
    phase,
  });

  const stopBoundTimer = (): void => {
    if (boundTimer !== null) {
      clock.clearTimeout(boundTimer);
      boundTimer = null;
    }
  };

  /**
   * One step of the bound of the wait (`stepAnchorWait`). When the bound runs out, the trim
   * fails with the notice.
   */
  const stepBound = (event: AnchorWaitEvent): void => {
    const step = stepAnchorWait(boundPhase, event);
    boundPhase = step.phase;
    if (step.timer !== "none") {
      stopBoundTimer();
    }
    if (step.timer === "start") {
      const handle = clock.setTimeout(() => {
        if (boundTimer !== handle) {
          return;
        }
        boundTimer = null;
        stepBound({ type: "timeout" });
      }, TRIM_FRAME_WAIT_MS);
      boundTimer = handle;
    }
    if (step.giveUp) {
      fail();
    }
  };

  const stopWaiting = (): void => {
    stopAwait?.();
    stopAwait = null;
    stopBoundTimer();
    boundPhase = "idle";
  };

  const drop = (): void => {
    stopWaiting();
    trim = null;
    setView(null);
  };

  /** Ends a released trim with no commit, and counts it for the notice. */
  const fail = (): void => {
    drop();
    noticeCount += 1;
    notify();
  };

  /**
   * Writes the boundary of a released trim, when the stored segment still holds the boundaries
   * of the start (`canCommitTrim`). Otherwise the trim fails.
   */
  const commit = (committed: SegmentTrim, pts: Pts): void => {
    const state = timeline.getState();
    if (!canCommitTrim(committed, state.segments, state.sourceId, pts)) {
      fail();
      return;
    }
    state.trimSegmentEdge(committed.segmentId, committed.edge, pts);
    drop();
  };

  /**
   * Sends a seek of the trim: `seekToPts` to a PTS, or `seekToFrameIndex` to a nominal frame of
   * the grid, which aims at the middle of the frame and shows its nominal start (ADR 022).
   */
  const runSeek = (seek: TrimSeek): void => {
    const state = playback.getState();
    if (seek.kind === "pts") {
      state.seekToPts(seek.pts);
    } else {
      state.seekToFrameIndex(Number(seek.frameIndex));
    }
  };

  /** The trim in its `dragging` phase, or null when none drags. */
  const draggingTrim = (): SegmentTrim | null => {
    if (trim === null || view?.phase !== "dragging") {
      return null;
    }
    return trim;
  };

  const plan = (input: SegmentTrimBeginInput): SegmentTrim | null => {
    const { segments, sourceId } = timeline.getState();
    return planSegmentTrimStart({
      segmentId: input.segmentId,
      edge: input.edge,
      segments,
      sourceId,
      hasActiveSource: input.hasActiveSource,
      playback: playback.getState(),
      probe: input.probe,
      totalDurationSeconds: input.totalDurationSeconds,
    });
  };

  /**
   * Waits for the frame that commits a released trim (`resolveTrimAwait`). The first decision
   * reads the state just after the seek of the release, and each later playback state decides
   * again, so every frame callback checks the frame on screen once more. The bound starts at the
   * release (`TRIM_FRAME_WAIT_MS` of visible time), so a seek that never completes, or a frame
   * that never arrives, ends in the notice and not in a trim that waits for ever.
   */
  const awaitFrame = (awaiting: TrimAwait): void => {
    const decide = (decision: TrimAwaitDecision): void => {
      if (decision.kind === "write") {
        commit(awaiting.trim, decision.pts);
      } else if (decision.kind === "drop") {
        fail();
      }
    };
    stopAwait = playback.subscribe((state) => {
      decide(resolveTrimAwait(awaiting, state));
    });
    stepBound({ type: "arm", visible: isVisible() });
    if (stopAwait !== null) {
      decide(resolveTrimAwait(awaiting, playback.getState()));
    }
  };

  return {
    getView: () => view,

    getNoticeCount: () => noticeCount,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getDraggingTrim: draggingTrim,

    isDragging: () => draggingTrim() !== null,

    canBegin: (input) => plan(input) !== null,

    begin: (input) => {
      const next = plan(input);
      if (next === null) {
        return false;
      }
      if (view?.phase === "committing") {
        fail();
      } else {
        drop();
      }
      trim = next;
      setView(viewOf(next, "dragging"));
      // The press selects the segment (ADR 030). Selection is not an edit, so it adds no
      // history entry, and it clears a pending In mark (ADR 007).
      timeline.getState().selectSegment(next.segmentId);
      return true;
    },

    scrub: (target) => {
      if (draggingTrim() === null || target === null) {
        return;
      }
      playback.getState().seekToPts(target.pts, { scrub: true });
    },

    release: (target) => {
      const released = draggingTrim();
      if (released === null) {
        return;
      }
      // The phase changes before any seek or write, so a sample that one of them causes finds
      // no dragging trim and sends no scrub seek after the release.
      setView(viewOf(released, "committing"));
      const before = playback.getState();
      const releasePlan = planTrimRelease(released, target, before);
      if (releasePlan.kind === "drop") {
        fail();
        return;
      }
      if (releasePlan.kind === "write") {
        if (releasePlan.seek !== null) {
          runSeek(releasePlan.seek);
        }
        commit(released, releasePlan.pts);
        return;
      }
      runSeek({ kind: "frame", frameIndex: releasePlan.frameIndex });
      const awaiting = beginTrimAwait(released, releasePlan, playback.getState());
      if (awaiting === null) {
        fail();
        return;
      }
      awaitFrame(awaiting);
    },

    abandon: (target) => {
      const abandoned = draggingTrim();
      if (abandoned === null) {
        return;
      }
      drop();
      if (target !== null && isTrimCurrent(abandoned, playback.getState())) {
        playback.getState().seekToPts(target.pts);
      }
    },

    cancel: () => {
      const cancelled = draggingTrim();
      if (cancelled === null) {
        return;
      }
      // The trim ends first, so the final sample of the gesture finds no trim and seeks nowhere.
      drop();
      dragCanceller?.();
      const seek = planTrimCancel(cancelled, playback.getState());
      if (seek !== null) {
        runSeek(seek);
      }
    },

    drop,

    fail,

    setDragCanceller: (canceller) => {
      dragCanceller = canceller;
    },

    visibilityChanged: (visible) => {
      if (stopAwait !== null) {
        stepBound({ type: "visibility", visible });
      }
    },
  };
}

/** The session of the application, on the production stores. */
export const segmentTrimSession: SegmentTrimSession = createSegmentTrimSession({
  playback: playbackStore,
  timeline: timelineStore,
});
