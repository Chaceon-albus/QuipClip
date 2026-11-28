/**
 * The fact that a pointer holds a gesture that seeks the playback (ADR 074): a press, a scrub
 * or a trim on the timeline, from the press to each end of the gesture, or a frame step button
 * that is pressed and held, from the press to the end of its repeat.
 *
 * Such a gesture seeks again later with no new act of the user: a scrub sample, an auto-scroll
 * step, the final sample of a cancel, the resume of a drag, a repeat of a held step. Each of
 * those seeks would end a program play that started during the gesture. So Play Program and
 * Play Joins do nothing while the fact holds (`POINTER_SEEK_LOCKED_ACTIONS`), as they do
 * nothing while a drag trims a segment edge. The other actions do not read it.
 *
 * Each gesture holds the fact under its own key, so the end of one gesture does not end
 * another. The module has no React, DOM or store dependency, so the tests need no document.
 */

export interface PointerSeekHold {
  /** A gesture with the key `key` started. A second call with the same key changes nothing. */
  readonly hold: (key: string) => void;
  /** The gesture with the key `key` ended. A key that holds nothing changes nothing. */
  readonly release: (key: string) => void;
  /** True while one gesture or more holds the fact. */
  readonly isHeld: () => boolean;
  /** Calls `listener` after each change of `isHeld`. Returns the function that removes it. */
  readonly subscribe: (listener: () => void) => () => void;
}

export function createPointerSeekHold(): PointerSeekHold {
  const keys = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    hold: (key) => {
      const wasHeld = keys.size > 0;
      keys.add(key);
      if (!wasHeld) {
        notify();
      }
    },
    release: (key) => {
      if (keys.delete(key) && keys.size === 0) {
        notify();
      }
    },
    isHeld: () => keys.size > 0,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The fact of the application. */
export const pointerSeekHold: PointerSeekHold = createPointerSeekHold();

/** The key of the gesture of the timeline. */
export const TIMELINE_GESTURE_KEY = "timeline";

/** The key of a held frame step button, by the frames of its step. */
export function frameStepHoldKey(delta: number): string {
  return `frameStep:${delta}`;
}
