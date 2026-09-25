/**
 * Scrub audio controller driving a hidden audio element for frame step and drag sound cues.
 *
 * Implements ADR 019: plays a short burst of audio at the new position when stepping
 * frames so the user can hear word boundaries or audio transients.
 *
 * Amends ADR 019 via ADR 022: playhead dragging serves as a second caller for audio bursts.
 * The store, not the controller, tracks the drag direction and skips zero-distance moves.
 *
 * The controller never reads or writes `muted`. The mute toggle of the transport bar sets it
 * on the element, so a muted cue still seeks, plays and keeps its timers and its continuation
 * rule, and only its sound is silent.
 */

/** Burst duration in seconds (50 ms), approximating one frame duration to provide an audible cue. */
export const SCRUB_BURST_SECONDS = 0.05;

/** Maximum distance in seconds (100 ms) between target and current position to extend an ongoing forward scrub rather than re-seeking. */
export const SCRUB_CONTINUATION_TOLERANCE_SECONDS = 0.1;

/** Extra safety margin in seconds (500 ms) added to the burst duration for the watchdog timer if the 'playing' or the 'seeked' event does not fire. */
export const SCRUB_WATCHDOG_EXTRA_SECONDS = 0.5;

/** The events of the element that the controller listens to. */
export type ScrubAudioEventType = "playing" | "seeked" | "error";

/** The narrow media surface the controller needs, so a test can pass a fake. */
export interface ScrubAudioElement {
  play: () => Promise<void> | void;
  pause: () => void;
  currentTime: number;
  readonly seeking: boolean;
  addEventListener: (type: ScrubAudioEventType, listener: () => void) => void;
  removeEventListener: (type: ScrubAudioEventType, listener: () => void) => void;
}

/** Injected timers, so a test drives the schedule without a real clock. */
export interface ScrubAudioTimers {
  setTimer: (callback: () => void, milliseconds: number) => number;
  clearTimer: (handle: number) => void;
}

export interface ScrubAudioController {
  attach: (element: ScrubAudioElement) => void;
  detach: (element: ScrubAudioElement) => void;
  request: (targetSeconds: number, direction: 1 | -1) => void;
  stop: () => void;
}

const defaultTimers: ScrubAudioTimers = {
  setTimer: (callback: () => void, milliseconds: number): number => {
    return globalThis.setTimeout(callback, milliseconds) as unknown as number;
  },
  clearTimer: (handle: number): void => {
    globalThis.clearTimeout(handle);
  },
};

function isAbortError(reason: unknown): boolean {
  try {
    if (typeof reason === "object" && reason !== null && "name" in reason) {
      return reason.name === "AbortError";
    }
  } catch {
    return false;
  }
  return false;
}

/** Reads `seeking`. A read that throws counts as no seek. */
function isSeeking(element: ScrubAudioElement): boolean {
  try {
    return element.seeking === true;
  } catch {
    return false;
  }
}

export function createScrubAudioController(
  timers: ScrubAudioTimers = defaultTimers,
): ScrubAudioController {
  let attached: ScrubAudioElement | null = null;
  let disabled = false;
  let burstId = 0;
  let active = false;
  // The two conditions of the stop timer of the burst: its seek has finished, and the element
  // plays. A seek of a new burst clears both.
  let seekDone = false;
  let playingSeen = false;
  let stopHandle: number | null = null;
  let watchdogHandle: number | null = null;

  const clearTimers = (): void => {
    if (stopHandle !== null) {
      timers.clearTimer(stopHandle);
      stopHandle = null;
    }
    if (watchdogHandle !== null) {
      timers.clearTimer(watchdogHandle);
      watchdogHandle = null;
    }
  };

  const stop = (): void => {
    clearTimers();
    active = false;
    burstId++;
    if (attached) {
      try {
        attached.pause();
      } catch {
        // Ignore DOM exception
      }
    }
  };

  const armStopTimer = (): void => {
    if (!active || !seekDone || !playingSeen) {
      return;
    }
    if (stopHandle !== null) {
      timers.clearTimer(stopHandle);
      stopHandle = null;
    }
    // The stop timer MUST wait for both the end of the seek and the 'playing' event, and not
    // start when request calls play(). A media element needs as long to seek and to start as
    // the burst lasts, and a seek in WebKit took 40 to 150 milliseconds in a measurement, so a
    // timer armed earlier cuts the burst to almost nothing. The order of the two events
    // differs between the web views. Chromium sends 'playing' after 'seeked'. WebKit keeps the
    // ready state through the assignment of currentTime, so it sends 'playing' at once, while
    // the seek still runs, and a timer armed on 'playing' alone stopped the element before it
    // made any sound.
    const id = burstId;
    stopHandle = timers.setTimer(() => {
      // Defends against a timer implementation that does not honour clearTimer.
      if (id !== burstId) {
        return;
      }
      stop();
    }, SCRUB_BURST_SECONDS * 1000);
  };

  const onPlaying = (): void => {
    if (!active || !attached) {
      return;
    }
    playingSeen = true;
    // An assignment of currentTime before the metadata loads starts no seek, so no 'seeked'
    // event comes. An element that plays and does not report `seeking` has no seek to wait
    // for. The early 'playing' of WebKit arrives while `seeking` is still true.
    if (!isSeeking(attached)) {
      seekDone = true;
    }
    armStopTimer();
  };

  const onSeeked = (): void => {
    if (!active || !attached) {
      return;
    }
    // A later seek is still running, so this 'seeked' ends an earlier one. The burst waits
    // for the end of its own seek.
    if (isSeeking(attached)) {
      return;
    }
    seekDone = true;
    armStopTimer();
  };

  const onError = (): void => {
    disabled = true;
    stop();
  };

  const attach = (element: ScrubAudioElement): void => {
    if (
      !element ||
      typeof element.play !== "function" ||
      typeof element.pause !== "function"
    ) {
      return;
    }
    if (attached && attached !== element) {
      stop();
      attached.removeEventListener("playing", onPlaying);
      attached.removeEventListener("seeked", onSeeked);
      attached.removeEventListener("error", onError);
      attached = null;
    }
    if (attached !== element) {
      attached = element;
      attached.addEventListener("playing", onPlaying);
      attached.addEventListener("seeked", onSeeked);
      attached.addEventListener("error", onError);
    }
    disabled = false;
  };

  const detach = (element: ScrubAudioElement): void => {
    if (!attached || attached !== element) {
      return;
    }
    stop();
    attached.removeEventListener("playing", onPlaying);
    attached.removeEventListener("seeked", onSeeked);
    attached.removeEventListener("error", onError);
    attached = null;
  };

  const request = (targetSeconds: number, direction: 1 | -1): void => {
    if (!attached || disabled) {
      return;
    }
    if (
      typeof targetSeconds !== "number" ||
      !Number.isFinite(targetSeconds) ||
      targetSeconds < 0
    ) {
      return;
    }
    if (direction !== 1 && direction !== -1) {
      return;
    }

    // A held arrow key repeats about 30 times each second, which is near to real
    // time at 25 to 30 frames each second. The element is already at the right
    // position, so a re-seek would restart it continuously and the result is a
    // stutter. A backward request can never continue, because audio does not play backwards.
    let currentSeconds: number | null = null;
    if (active && direction === 1) {
      try {
        currentSeconds = attached.currentTime;
      } catch {
        // Fall through to the seek path if reading currentTime throws
        currentSeconds = null;
      }
    }

    if (
      currentSeconds !== null &&
      Math.abs(targetSeconds - currentSeconds) <= SCRUB_CONTINUATION_TOLERANCE_SECONDS
    ) {
      const id = burstId;
      if (watchdogHandle !== null) {
        timers.clearTimer(watchdogHandle);
      }
      watchdogHandle = timers.setTimer(
        () => {
          if (id !== burstId) {
            return;
          }
          stop();
        },
        (SCRUB_BURST_SECONDS + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
      );

      if (stopHandle !== null) {
        timers.clearTimer(stopHandle);
        stopHandle = timers.setTimer(() => {
          if (id !== burstId) {
            return;
          }
          stop();
        }, SCRUB_BURST_SECONDS * 1000);
      }
      return;
    }

    burstId++;
    const id = burstId;
    clearTimers();
    active = true;
    seekDone = false;
    playingSeen = false;

    try {
      attached.pause();
    } catch {
      // Ignore DOM exception
    }

    try {
      attached.currentTime = targetSeconds;
    } catch {
      active = false;
      return;
    }

    try {
      const playResult = attached.play();
      if (
        playResult !== null &&
        typeof playResult === "object" &&
        "catch" in playResult &&
        typeof playResult.catch === "function"
      ) {
        playResult.catch((reason: unknown) => {
          if (!isAbortError(reason)) {
            disabled = true;
            if (id === burstId) {
              stop();
            }
            return;
          }
          if (id === burstId) {
            // A burst that was aborted never sounded, so the next request must take the seek
            // path rather than the continuation path.
            active = false;
          }
        });
      }
    } catch (error: unknown) {
      active = false;
      if (!isAbortError(error)) {
        disabled = true;
        stop();
      }
      return;
    }

    watchdogHandle = timers.setTimer(
      () => {
        if (id !== burstId) {
          return;
        }
        stop();
      },
      (SCRUB_BURST_SECONDS + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
    );
  };

  return {
    attach,
    detach,
    request,
    stop,
  };
}

/** The one controller the application uses. Default timers. */
export const scrubAudioController: ScrubAudioController = createScrubAudioController();
