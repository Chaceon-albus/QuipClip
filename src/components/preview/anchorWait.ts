/**
 * A bounded wait for the calibration anchor while a navigation waits for it (ADR 003, ADR 022).
 *
 * The playback store defers a navigation until the first presented frame takes the calibration
 * anchor. If the element never presents a frame, as in the case that `resolvePictureCheck`
 * describes, that navigation would never run, and the status bar would say "Preparing the
 * preview..." for good. The store holds no timers, so the pane bounds the wait.
 *
 * The wait runs only while the store reports a deferred navigation (`hasDeferredNavigation`).
 * It starts at the first deferred request and stops when the request runs or is dropped. With
 * nothing deferred, the calibration stays open for as long as it takes: a first frame that comes
 * late still anchors it, and so do the first frames of a playback. When the wait runs out, the
 * pane reports frame callbacks as unavailable. The store then runs the deferred navigation on
 * the approximate path, and precise editing stays off for that attachment.
 *
 * The wait counts only while the document is visible, because a hidden or minimized window
 * presents no frames. Each return to visible starts the whole wait again.
 */

import type { StoreApi } from "zustand/vanilla";
import type {
  PlaybackMediaElement,
  PlaybackState,
  PlaybackStoreState,
} from "@/features/playback";

/**
 * How long a deferred navigation waits for the first presented frame of a visible element.
 *
 * The two ways out cost different things. The give-up turns off precise editing for the rest of
 * the attachment, and a frame that comes later cannot turn it on again. A longer wait costs only
 * time: the playhead already shows the target, the status bar says "Preparing the preview...",
 * and play ends the wait at once, because play drops the request and its first frames can take
 * the anchor. The value therefore leans long. A first frame normally follows the metadata within
 * a few hundred milliseconds, and within a few seconds from a slow drive. Eight seconds covers
 * that with room, and it stays below the ten seconds after which a user stops waiting for the
 * answer to an action.
 */
export const DEFERRED_NAVIGATION_ANCHOR_WAIT_MS = 8000;

/**
 * The phase of the wait.
 *
 * - `idle`: no navigation is deferred.
 * - `waiting`: a navigation is deferred, the document is visible, and the timer runs.
 * - `paused`: a navigation is deferred and the document is hidden. No timer runs.
 * - `done`: the wait ran out. Nothing more happens until the wait is disarmed.
 */
export type AnchorWaitPhase = "idle" | "waiting" | "paused" | "done";

/** An input of the wait. */
export type AnchorWaitEvent =
  /** A navigation is deferred. A wait that runs already keeps its start. */
  | { readonly type: "arm"; readonly visible: boolean }
  /** No navigation is deferred any more: it ran, or it was dropped. */
  | { readonly type: "disarm" }
  /** The visibility of the document changed. */
  | { readonly type: "visibility"; readonly visible: boolean }
  /** The timer ran. */
  | { readonly type: "timeout" };

/** The next phase, what to do with the timer, and whether the wait ran out now. */
export interface AnchorWaitStep {
  readonly phase: AnchorWaitPhase;
  /** `start`: start a whole wait. `stop`: stop the running timer. `none`: leave it. */
  readonly timer: "start" | "stop" | "none";
  readonly giveUp: boolean;
}

/** The step of the wait for an input. */
export function stepAnchorWait(
  phase: AnchorWaitPhase,
  event: AnchorWaitEvent,
): AnchorWaitStep {
  switch (event.type) {
    case "arm":
      if (phase !== "idle") {
        return { phase, timer: "none", giveUp: false };
      }
      return event.visible
        ? { phase: "waiting", timer: "start", giveUp: false }
        : { phase: "paused", timer: "none", giveUp: false };
    case "disarm":
      return {
        phase: "idle",
        timer: phase === "waiting" ? "stop" : "none",
        giveUp: false,
      };
    case "visibility":
      if (phase === "waiting" && !event.visible) {
        return { phase: "paused", timer: "stop", giveUp: false };
      }
      if (phase === "paused" && event.visible) {
        return { phase: "waiting", timer: "start", giveUp: false };
      }
      return { phase, timer: "none", giveUp: false };
    case "timeout":
      // A timer that runs after the phase changed is stale.
      if (phase !== "waiting") {
        return { phase, timer: "none", giveUp: false };
      }
      return { phase: "done", timer: "none", giveUp: true };
  }
}

/** Injected timers, so a test drives the wait without a real clock. */
export interface AnchorWaitTimers {
  readonly setTimer: (callback: () => void, milliseconds: number) => number;
  readonly clearTimer: (handle: number) => void;
}

/** The wait for the element that the pane holds now. */
export interface AnchorWaitController<E> {
  /** A navigation is deferred for the element. A different element starts a new wait. */
  readonly arm: (element: E, visible: boolean) => void;
  /** No navigation is deferred, or the element left the tree. The wait ends without a result. */
  readonly disarm: () => void;
  /** The visibility of the document changed. */
  readonly visibility: (visible: boolean) => void;
}

/** Creates the wait. `onGiveUp` receives the element whose wait ran out. */
export function createAnchorWaitController<E>(
  timers: AnchorWaitTimers,
  onGiveUp: (element: E) => void,
): AnchorWaitController<E> {
  let element: E | null = null;
  let phase: AnchorWaitPhase = "idle";
  let timer: number | null = null;

  const stopTimer = (): void => {
    if (timer !== null) {
      timers.clearTimer(timer);
      timer = null;
    }
  };

  const apply = (event: AnchorWaitEvent): void => {
    const step = stepAnchorWait(phase, event);
    phase = step.phase;
    if (step.timer === "stop") {
      stopTimer();
    } else if (step.timer === "start") {
      stopTimer();
      const handle = timers.setTimer(() => {
        // A timer that another wait replaced, or that a stop missed, does nothing.
        if (timer !== handle) {
          return;
        }
        timer = null;
        apply({ type: "timeout" });
      }, DEFERRED_NAVIGATION_ANCHOR_WAIT_MS);
      timer = handle;
    }
    if (step.giveUp && element !== null) {
      onGiveUp(element);
    }
  };

  return {
    arm: (next, visible) => {
      if (element !== next) {
        stopTimer();
        element = next;
        phase = "idle";
      }
      apply({ type: "arm", visible });
    },
    disarm: () => {
      apply({ type: "disarm" });
      stopTimer();
      element = null;
    },
    visibility: (visible) => {
      if (element !== null) {
        apply({ type: "visibility", visible });
      }
    },
  };
}

/** The playback facts that decide whether the wait runs. */
export type AnchorWaitPlayback = Pick<
  PlaybackState,
  "hasDeferredNavigation" | "calibrationStatus"
>;

/** True while the wait runs: a navigation waits for the anchor of the open calibration. */
export function shouldWaitForAnchor(state: AnchorWaitPlayback): boolean {
  return state.hasDeferredNavigation && state.calibrationStatus === "calibrating";
}

/**
 * Keeps the wait in step with the store: armed for the element that `getElement` returns while
 * `shouldWaitForAnchor` holds, and disarmed otherwise. Returns the function that stops following.
 */
export function followDeferredNavigation<E>(
  store: Pick<StoreApi<PlaybackStoreState>, "getState" | "subscribe">,
  controller: AnchorWaitController<E>,
  getElement: () => E | null,
  isVisible: () => boolean,
): () => void {
  const follow = (state: AnchorWaitPlayback): void => {
    const element = getElement();
    if (shouldWaitForAnchor(state) && element !== null) {
      controller.arm(element, isVisible());
    } else {
      controller.disarm();
    }
  };
  follow(store.getState());
  return store.subscribe((state, previous) => {
    if (shouldWaitForAnchor(state) !== shouldWaitForAnchor(previous)) {
      follow(state);
    }
  });
}

/**
 * Reports the end of the wait to the store: frame callbacks are not available for the element.
 * It reports nothing when no navigation waits for the anchor any more, or when the source is not
 * the active one. The store also refuses the report for an element that it does not hold.
 */
export function reportAnchorWaitExpired(
  store: Pick<StoreApi<PlaybackStoreState>, "getState">,
  element: PlaybackMediaElement,
  isSourceActive: (sourceRevisionKey: string) => boolean,
): void {
  const state = store.getState();
  const key = state.attachedSourceRevisionKey;
  if (key === null || !shouldWaitForAnchor(state) || !isSourceActive(key)) {
    return;
  }
  state.syncPresentationUnavailable(key, element);
}
