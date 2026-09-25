/**
 * Scrub audio controller driving a hidden audio element for frame step and drag sound cues.
 *
 * Implements ADR 019: plays a short burst of audio at the new position when stepping
 * frames so the user can hear word boundaries or audio transients.
 *
 * Amends ADR 019 via ADR 022: playhead dragging serves as a second caller for audio bursts.
 * The store, not the controller, tracks the drag direction and skips zero-distance moves.
 *
 * A burst ends on the media clock of the element, not on a wall-clock timer: the element stops
 * when its `currentTime` reaches the latest requested target plus `SCRUB_BURST_SECONDS`. The
 * clock advances only while the element really plays, so a slow start does not shorten the
 * burst. A burst therefore plays 50 milliseconds of media time, and a held key extends it.
 *
 * The controller never reads or writes `muted`. The mute toggle of the transport bar sets it
 * on the element, so a muted cue still seeks, plays and keeps its timers and its continuation
 * rule, and only its sound is silent.
 */

/** Burst duration in seconds (50 ms) of media time, approximating one frame duration to provide an audible cue. */
export const SCRUB_BURST_SECONDS = 0.05;

/**
 * The largest forward distance in seconds (100 ms) from the last requested target for a request
 * to count as the next step of an ongoing forward burst. The element may also be ahead of the
 * new target by no more than this distance. It is ahead only by the part of a burst that it
 * played past the last target, so that bound only guards against a position that jumps.
 */
export const SCRUB_CONTINUATION_TOLERANCE_SECONDS = 0.1;

/** The largest distance in seconds (750 ms) that the element may be behind the target of a frame step that continues the burst. A step farther ahead seeks. */
export const SCRUB_CONTINUATION_MAX_LAG_SECONDS = 0.75;

/** The largest distance in seconds (100 ms) that the element may be behind the target of a drag request that continues the burst, so the sound stays near the pointer (ADR 022). */
export const SCRUB_DRAG_MAX_LAG_SECONDS = 0.1;

/** Extra safety margin in seconds (1 s) that the watchdog adds to the media time the burst still has to play, if the element does not start or its clock does not reach the stop position. */
export const SCRUB_WATCHDOG_EXTRA_SECONDS = 1;

/** The shortest wait in milliseconds between two reads of the media clock while a burst sounds. */
export const SCRUB_CLOCK_CHECK_MIN_MS = 4;

/** The longest wait in milliseconds between two reads of the media clock while a burst sounds. */
export const SCRUB_CLOCK_CHECK_MAX_MS = 16;

/**
 * The rounding margin in seconds of the step and lag comparisons, so a step of exactly the
 * tolerance, such as 1.1 after 1.0, still counts as one.
 */
const TIME_EPSILON_SECONDS = 1e-9;

/** The events of the element that the controller listens to. */
export type ScrubAudioEventType = "playing" | "seeked" | "error";

/**
 * What a request comes from. A frame step (`seekNominal`) may play far behind its target, so a
 * held key stays continuous. A drag of the playhead keeps the sound near the pointer.
 */
export type ScrubAudioRequestKind = "step" | "drag";

/** The narrow media surface the controller needs, so a test can pass a fake. */
export interface ScrubAudioElement {
  play: () => Promise<void> | void;
  pause: () => void;
  currentTime: number;
  readonly seeking: boolean;
  readonly ended: boolean;
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
  request: (
    targetSeconds: number,
    direction: 1 | -1,
    kind?: ScrubAudioRequestKind,
  ) => void;
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

/** Reads `ended`. A read that throws counts as not ended. */
function hasEnded(element: ScrubAudioElement): boolean {
  try {
    return element.ended === true;
  } catch {
    return false;
  }
}

/** Reads `currentTime`, or null when the read throws or gives no finite number. */
function readPosition(element: ScrubAudioElement): number | null {
  try {
    const position = element.currentTime;
    return typeof position === "number" && Number.isFinite(position) ? position : null;
  } catch {
    return null;
  }
}

/**
 * The wait before the next read of the media clock: the media time that remains, clamped to
 * the check limits. While the clock runs at the normal rate, the read after this wait finds the
 * stop position, so the burst does not run long by a whole check interval.
 */
function clockCheckDelayMs(remainingSeconds: number): number {
  return Math.min(
    Math.max(remainingSeconds * 1000, SCRUB_CLOCK_CHECK_MIN_MS),
    SCRUB_CLOCK_CHECK_MAX_MS,
  );
}

export function createScrubAudioController(
  timers: ScrubAudioTimers = defaultTimers,
): ScrubAudioController {
  let attached: ScrubAudioElement | null = null;
  let disabled = false;
  let burstId = 0;
  let active = false;
  // The two conditions of the clock check of the burst: its seek has finished, and the element
  // plays. A seek of a new burst clears both.
  let seekDone = false;
  let playingSeen = false;
  // The latest target that the burst plays toward, and the media time at which it stops.
  let lastTargetSeconds = 0;
  let stopAtSeconds = 0;
  let clockHandle: number | null = null;
  let watchdogHandle: number | null = null;

  const clearTimers = (): void => {
    if (clockHandle !== null) {
      timers.clearTimer(clockHandle);
      clockHandle = null;
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

  /**
   * Starts, or restarts, the watchdog of the burst. It waits for the media time that the burst
   * still has to play, at least one burst, and the margin. The element is behind the stop
   * position by at most one burst and the lag limit, so the wait stays short. The margin is
   * longer than the start of the audio output in Chrome on macOS, where the clock stood almost
   * still for 300 to 455 milliseconds after a seek.
   *
   * @param position The position of the element.
   */
  const armWatchdog = (position: number): void => {
    if (watchdogHandle !== null) {
      timers.clearTimer(watchdogHandle);
    }
    const remainingSeconds = Math.max(stopAtSeconds - position, SCRUB_BURST_SECONDS);
    const id = burstId;
    watchdogHandle = timers.setTimer(
      () => {
        if (id !== burstId) {
          return;
        }
        stop();
      },
      (remainingSeconds + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
    );
  };

  /**
   * Reads the media clock. The element stops when its position reaches the stop position, and
   * otherwise the next read waits for the media time that remains. A clock that does not move,
   * as while the element waits for data, keeps the reads going until the watchdog stops it. An
   * element that reached the end of its media stops the burst, because its clock does not move
   * again.
   */
  const checkClock = (): void => {
    clockHandle = null;
    if (!active || !attached) {
      return;
    }
    const position = readPosition(attached);
    if (position === null || hasEnded(attached)) {
      stop();
      return;
    }
    const remainingSeconds = stopAtSeconds - position;
    if (remainingSeconds <= 0) {
      stop();
      return;
    }
    const id = burstId;
    clockHandle = timers.setTimer(() => {
      // Defends against a timer implementation that does not honour clearTimer.
      if (id !== burstId) {
        return;
      }
      checkClock();
    }, clockCheckDelayMs(remainingSeconds));
  };

  const startClockCheck = (): void => {
    if (!active || !attached || !seekDone || !playingSeen || clockHandle !== null) {
      return;
    }
    // The clock check waits for both the end of the seek and the 'playing' event, so it reads
    // the clock only once the element plays. The stop reads the position of the element, and a
    // read during the seek gives the target of the seek, so an earlier read could not end the
    // burst early. The wait is kept as a precaution, and the watchdog restarts here, so a slow
    // seek does not use up its margin. The order of the two events differs between the web
    // views. Chromium sends 'playing' after 'seeked'. WebKit keeps the ready state through the
    // assignment of currentTime, so it sends 'playing' at once, while the seek still runs.
    const position = readPosition(attached);
    if (position !== null) {
      armWatchdog(position);
    }
    checkClock();
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
    startClockCheck();
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
    startClockCheck();
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

  /**
   * True when a forward request continues the active burst instead of a seek. The request must
   * be the next step from the last target: forward, by no more than
   * `SCRUB_CONTINUATION_TOLERANCE_SECONDS`. The element must also be behind the new target by
   * no more than the lag limit of the request kind, and ahead of it by no more than the
   * tolerance. While a seek runs, the position of the element is the target of that seek.
   *
   * A held arrow key repeats about 30 times each second. At 24 to 30 frames each second, that
   * is 1 to 1.26 times real time. The element starts late, so it plays behind the target by
   * the step rate times the time of its seek and its start. A seek in WebKit took 40 to 150
   * milliseconds in a measurement. In Chrome on macOS, the clock stood almost still for 300 to
   * 455 milliseconds after the seek, so the lag can reach 0.57 seconds at 1.26 times real time.
   * A new seek would only start that wait again, so the lag limit of a frame step must be
   * longer. The limit still stops a key that steps faster than real time from falling behind
   * without end. A drag keeps the tight limit, so the sound stays near the pointer.
   * A backward request can never continue, because audio does not play backwards.
   */
  const continuesBurst = (
    targetSeconds: number,
    direction: 1 | -1,
    kind: ScrubAudioRequestKind,
    position: number,
  ): boolean => {
    if (!active || direction !== 1) {
      return false;
    }
    const maxLagSeconds =
      kind === "drag" ? SCRUB_DRAG_MAX_LAG_SECONDS : SCRUB_CONTINUATION_MAX_LAG_SECONDS;
    const step = targetSeconds - lastTargetSeconds;
    if (
      step < -TIME_EPSILON_SECONDS ||
      step > SCRUB_CONTINUATION_TOLERANCE_SECONDS + TIME_EPSILON_SECONDS
    ) {
      return false;
    }
    const lag = targetSeconds - position;
    return (
      lag >= -SCRUB_CONTINUATION_TOLERANCE_SECONDS - TIME_EPSILON_SECONDS &&
      lag <= maxLagSeconds + TIME_EPSILON_SECONDS
    );
  };

  const request = (
    targetSeconds: number,
    direction: 1 | -1,
    kind: ScrubAudioRequestKind = "step",
  ): void => {
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

    const position = active ? readPosition(attached) : null;
    if (position !== null && continuesBurst(targetSeconds, direction, kind, position)) {
      // The element keeps playing, and the stop position moves to the new target. The clock
      // check reads the stop position on each read, so it needs no restart.
      lastTargetSeconds = targetSeconds;
      stopAtSeconds = targetSeconds + SCRUB_BURST_SECONDS;
      armWatchdog(position);
      return;
    }

    burstId++;
    const id = burstId;
    clearTimers();
    active = true;
    seekDone = false;
    playingSeen = false;
    lastTargetSeconds = targetSeconds;
    stopAtSeconds = targetSeconds + SCRUB_BURST_SECONDS;

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

    armWatchdog(targetSeconds);
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
