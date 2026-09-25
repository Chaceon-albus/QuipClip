import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScrubAudioController,
  SCRUB_BURST_SECONDS,
  SCRUB_CLOCK_CHECK_MAX_MS,
  SCRUB_CLOCK_CHECK_MIN_MS,
  SCRUB_CONTINUATION_MAX_LAG_SECONDS,
  SCRUB_CONTINUATION_TOLERANCE_SECONDS,
  SCRUB_DRAG_MAX_LAG_SECONDS,
  SCRUB_WATCHDOG_EXTRA_SECONDS,
  scrubAudioController,
  type ScrubAudioElement,
  type ScrubAudioEventType,
  type ScrubAudioTimers,
} from "./scrubAudio";

interface ArmedTimer {
  id: number;
  callback: () => void;
  milliseconds: number;
  /** The virtual time in milliseconds at which the timer is due. */
  due: number;
}

interface TestTimers extends ScrubAudioTimers {
  getArmedTimers: () => ArmedTimer[];
  fire: (handle: number) => void;
  getTimer: (handle: number) => ArmedTimer | undefined;
  count: number;
  /** The virtual time in milliseconds. Only `runFor` moves it. */
  readonly now: number;
  /**
   * Fires the armed timers in the order of their due times, for `durationMs` of virtual time.
   * Before each timer, `onTime` receives the virtual time, so a test can move the clock of an
   * element as a function of time.
   */
  runFor: (durationMs: number, onTime: (nowMs: number) => void) => void;
}

function createTestTimers(): TestTimers {
  let nextId = 1;
  let now = 0;
  const armed = new Map<number, ArmedTimer>();

  const setTimer = (callback: () => void, milliseconds: number): number => {
    const id = nextId++;
    armed.set(id, { id, callback, milliseconds, due: now + milliseconds });
    return id;
  };

  const clearTimer = (handle: number): void => {
    armed.delete(handle);
  };

  const fire = (handle: number): void => {
    const entry = armed.get(handle);
    if (!entry) {
      throw new Error(`Timer handle ${handle} not found or already cleared`);
    }
    armed.delete(handle);
    entry.callback();
  };

  const getTimer = (handle: number): ArmedTimer | undefined => armed.get(handle);

  const getArmedTimers = (): ArmedTimer[] => Array.from(armed.values());

  const runFor = (durationMs: number, onTime: (nowMs: number) => void): void => {
    const end = now + durationMs;
    for (;;) {
      let next: ArmedTimer | undefined;
      for (const entry of armed.values()) {
        if (entry.due <= end && (next === undefined || entry.due < next.due)) {
          next = entry;
        }
      }
      if (next === undefined) {
        break;
      }
      now = next.due;
      onTime(now);
      fire(next.id);
    }
    now = end;
    onTime(now);
  };

  return {
    setTimer,
    clearTimer,
    fire,
    getTimer,
    getArmedTimers,
    get count() {
      return armed.size;
    },
    get now() {
      return now;
    },
    runFor,
  };
}

interface FakeAudioElement extends ScrubAudioElement {
  playCalls: number;
  pauseCalls: number;
  currentTimeAssignments: number[];
  listeners: Record<ScrubAudioEventType, Set<() => void>>;
  seeking: boolean;
  ended: boolean;
  setCurrentTimeInternal: (value: number) => void;
  firePlaying: () => void;
  /** Ends the running seek: `seeking` turns false, then 'seeked' fires. */
  fireSeeked: () => void;
  /** The end of the seek and the start of the playback, in the order of Chromium. */
  fireSeekedAndPlaying: () => void;
  fireError: () => void;
}

function createFakeAudioElement(options?: {
  currentTime?: number;
  play?: () => Promise<void> | void;
  pause?: () => void;
}): FakeAudioElement {
  let currentTime = options?.currentTime ?? 0;
  const currentTimeAssignments: number[] = [];
  const listeners: Record<ScrubAudioEventType, Set<() => void>> = {
    playing: new Set<() => void>(),
    seeked: new Set<() => void>(),
    error: new Set<() => void>(),
  };

  const fake: FakeAudioElement = {
    playCalls: 0,
    pauseCalls: 0,
    currentTimeAssignments,
    listeners,
    seeking: false,
    ended: false,
    get currentTime() {
      return currentTime;
    },
    // An assignment starts a seek, as it does on a media element. The element reports the
    // target of the seek as its position from the assignment on.
    set currentTime(value: number) {
      currentTime = value;
      currentTimeAssignments.push(value);
      fake.seeking = true;
    },
    setCurrentTimeInternal: (value: number) => {
      currentTime = value;
    },
    play: vi.fn(() => {
      fake.playCalls++;
      if (options?.play) {
        return options.play();
      }
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      fake.pauseCalls++;
      if (options?.pause) {
        options.pause();
      }
    }),
    addEventListener: vi.fn((type: ScrubAudioEventType, listener: () => void) => {
      listeners[type].add(listener);
    }),
    removeEventListener: vi.fn((type: ScrubAudioEventType, listener: () => void) => {
      listeners[type].delete(listener);
    }),
    firePlaying: () => {
      Array.from(listeners.playing).forEach((cb) => cb());
    },
    fireSeeked: () => {
      fake.seeking = false;
      Array.from(listeners.seeked).forEach((cb) => cb());
    },
    fireSeekedAndPlaying: () => {
      fake.fireSeeked();
      fake.firePlaying();
    },
    fireError: () => {
      Array.from(listeners.error).forEach((cb) => cb());
    },
  };

  return fake;
}

/** The pending read of the media clock: the one timer no longer than the check limit. */
function findClockCheck(timers: TestTimers): ArmedTimer | undefined {
  return timers
    .getArmedTimers()
    .find((t) => t.milliseconds <= SCRUB_CLOCK_CHECK_MAX_MS);
}

/** The pending watchdog: the one timer at least as long as its margin. */
function findWatchdog(timers: TestTimers): ArmedTimer | undefined {
  return timers
    .getArmedTimers()
    .find((t) => t.milliseconds >= SCRUB_WATCHDOG_EXTRA_SECONDS * 1000);
}

/**
 * Plays the fake element at the normal rate: before each read of the clock, its position moves
 * by the wait of that read. Stops when no read is pending or after `limit` reads. Returns the
 * number of reads.
 */
function playAtNormalRate(
  timers: TestTimers,
  element: FakeAudioElement,
  limit = 200,
): number {
  let reads = 0;
  for (; reads < limit; reads++) {
    const check = findClockCheck(timers);
    if (!check) {
      break;
    }
    element.setCurrentTimeInternal(element.currentTime + check.milliseconds / 1000);
    timers.fire(check.id);
  }
  return reads;
}

/** The media time in seconds that a burst plays: one burst after the seek target. */
const burstEnd = (target: number) => target + SCRUB_BURST_SECONDS;

describe("Scrub Audio Controller", () => {
  let timers: TestTimers;
  let element: FakeAudioElement;
  let controller: ReturnType<typeof createScrubAudioController>;

  beforeEach(() => {
    timers = createTestTimers();
    element = createFakeAudioElement();
    controller = createScrubAudioController(timers);
  });

  describe("the seek path and the start of the clock check", () => {
    it("pauses, assigns currentTime and calls play, and arms only the watchdog", () => {
      controller.attach(element);
      controller.request(1.5, 1);

      expect(element.currentTimeAssignments).toEqual([1.5]);
      expect(element.playCalls).toBe(1);
      // Pause is called once before seeking to ensure no race with ongoing playback
      expect(element.pauseCalls).toBe(1);

      expect(timers.count).toBe(1);
      expect(findWatchdog(timers)?.milliseconds).toBe(
        (SCRUB_BURST_SECONDS + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
      );
      expect(findClockCheck(timers)).toBeUndefined();
    });

    it("starts the clock check when playing follows the end of the seek, as in Chromium", () => {
      controller.attach(element);
      controller.request(1.0, 1);

      element.fireSeeked();
      expect(findClockCheck(timers)).toBeUndefined();

      element.firePlaying();
      expect(findClockCheck(timers)).toBeDefined();
      expect(element.pauseCalls).toBe(1);
    });

    it("waits for seeked when playing arrives while the seek runs, as in WebKit", () => {
      controller.attach(element);
      controller.request(1.0, 1);

      // WebKit keeps the ready state through the assignment of currentTime, so playing fires
      // at once, while the seek still runs.
      element.firePlaying();
      expect(element.seeking).toBe(true);
      expect(findClockCheck(timers)).toBeUndefined();

      element.fireSeeked();
      expect(findClockCheck(timers)).toBeDefined();
    });

    it("starts the clock check on playing when the assignment started no seek, as before the metadata loads", () => {
      controller.attach(element);
      controller.request(0, -1);
      // Before the metadata loads, an assignment of currentTime only stores the start position.
      // No seek starts, so the element never reports seeking and never sends seeked.
      element.seeking = false;

      element.firePlaying();
      expect(findClockCheck(timers)).toBeDefined();
      expect(playAtNormalRate(timers, element)).toBeGreaterThan(0);
      expect(element.pauseCalls).toBe(2);
    });

    it("ignores the seeked of a superseded burst that arrives while the seek of the new burst runs", () => {
      controller.attach(element);
      // Burst A seeks. Burst B supersedes it with a backward request, which always seeks.
      controller.request(1.0, 1);
      controller.request(0.9, -1);
      expect(element.currentTimeAssignments).toEqual([1.0, 0.9]);

      // WebKit sends the playing of burst B at once, while its seek runs.
      element.firePlaying();
      // The seeked of burst A arrives. The seek of burst B still runs, so the element still
      // reports seeking.
      expect(element.seeking).toBe(true);
      Array.from(element.listeners.seeked).forEach((cb) => cb());
      expect(findClockCheck(timers)).toBeUndefined();

      // The seek of burst B ends.
      element.fireSeeked();
      expect(findClockCheck(timers)).toBeDefined();
    });

    it("clears both conditions when a new burst seeks, in the WebKit order", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();
      expect(findClockCheck(timers)).toBeDefined();

      // A backward request always seeks. It pauses and plays again, so WebKit sends playing at
      // once, and the clock check still waits for the end of the new seek.
      controller.request(0.9, -1);
      expect(timers.count).toBe(1);
      element.firePlaying();
      expect(findClockCheck(timers)).toBeUndefined();

      element.fireSeeked();
      expect(findClockCheck(timers)).toBeDefined();
    });

    it("clears both conditions when a new burst seeks, in the Chromium order: seeked alone starts nothing", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      controller.request(0.9, -1);
      element.fireSeeked();
      expect(findClockCheck(timers)).toBeUndefined();

      element.firePlaying();
      expect(findClockCheck(timers)).toBeDefined();
    });

    it("starts one clock check only, when playing fires again while the burst sounds", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();
      const first = findClockCheck(timers)!;

      // A stall and a restart send playing again.
      element.firePlaying();
      const checks = timers
        .getArmedTimers()
        .filter((t) => t.milliseconds <= SCRUB_CLOCK_CHECK_MAX_MS);
      expect(checks).toHaveLength(1);
      expect(checks[0].id).toBe(first.id);
    });

    it("starts no clock check when seeked and playing fire with no active burst", () => {
      controller.attach(element);
      element.fireSeekedAndPlaying();
      expect(timers.count).toBe(0);

      controller.request(1.0, 1);
      controller.stop();
      expect(timers.count).toBe(0);

      element.fireSeekedAndPlaying();
      expect(timers.count).toBe(0);
    });
  });

  describe("the stop on the media clock", () => {
    it("stops the element when its clock reaches one burst past the target", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      // Just short of the end, the element keeps playing.
      element.setCurrentTimeInternal(burstEnd(1.0) - 0.001);
      timers.fire(findClockCheck(timers)!.id);
      expect(element.pauseCalls).toBe(1);
      expect(findClockCheck(timers)).toBeDefined();

      element.setCurrentTimeInternal(burstEnd(1.0));
      timers.fire(findClockCheck(timers)!.id);
      expect(element.pauseCalls).toBe(2);
      expect(timers.count).toBe(0);
    });

    it("plays the whole burst after a slow start: a clock that stands still does not end it", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      // Chromium: after the seek, the clock stands almost still for several hundred
      // milliseconds while the audio output starts. Twenty reads at the longest wait.
      for (let i = 0; i < 20; i++) {
        const check = findClockCheck(timers)!;
        expect(check.milliseconds).toBe(SCRUB_CLOCK_CHECK_MAX_MS);
        timers.fire(check.id);
      }
      expect(element.pauseCalls).toBe(1);

      // The output starts. The element plays one burst of media time, then stops.
      playAtNormalRate(timers, element);
      expect(element.pauseCalls).toBe(2);
      expect(element.currentTime).toBeGreaterThanOrEqual(burstEnd(1.0));
      expect(element.currentTime).toBeLessThan(burstEnd(1.0) + 0.005);
    });

    it("waits for the media time that remains, inside the check limits", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();
      expect(findClockCheck(timers)!.milliseconds).toBe(SCRUB_CLOCK_CHECK_MAX_MS);

      element.setCurrentTimeInternal(burstEnd(1.0) - 0.01);
      timers.fire(findClockCheck(timers)!.id);
      expect(findClockCheck(timers)!.milliseconds).toBeCloseTo(10, 6);

      element.setCurrentTimeInternal(burstEnd(1.0) - 0.001);
      timers.fire(findClockCheck(timers)!.id);
      expect(findClockCheck(timers)!.milliseconds).toBe(SCRUB_CLOCK_CHECK_MIN_MS);
    });

    it("stops the element when its clock cannot be read", () => {
      let throwOnGet = false;
      let internalTime = 0;
      const unreadable = createFakeAudioElement();
      Object.defineProperty(unreadable, "currentTime", {
        get: () => {
          if (throwOnGet) {
            throw new Error("InvalidStateError");
          }
          return internalTime;
        },
        set: (val: number) => {
          internalTime = val;
          unreadable.seeking = true;
        },
      });

      controller.attach(unreadable);
      controller.request(1.0, 1);
      unreadable.fireSeekedAndPlaying();
      throwOnGet = true;
      timers.fire(findClockCheck(timers)!.id);
      expect(unreadable.pauseCalls).toBe(2);
      expect(timers.count).toBe(0);
    });

    it("stops the element when its clock gives no finite number", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();
      element.setCurrentTimeInternal(Number.NaN);
      timers.fire(findClockCheck(timers)!.id);
      expect(element.pauseCalls).toBe(2);
    });

    it("stops the element at the next read when its media ended before the stop position", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      // The audio stream is shorter than the video: the element reaches its end and its clock
      // stops short of the stop position.
      element.setCurrentTimeInternal(1.02);
      element.ended = true;
      timers.fire(findClockCheck(timers)!.id);
      expect(element.pauseCalls).toBe(2);
      expect(timers.count).toBe(0);
    });

    it("restarts the watchdog when the clock check starts, so a slow seek does not use up its margin", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      const requestWatchdog = findWatchdog(timers)!;

      element.fireSeekedAndPlaying();
      expect(timers.getTimer(requestWatchdog.id)).toBeUndefined();
      expect(findWatchdog(timers)!.milliseconds).toBe(
        (SCRUB_BURST_SECONDS + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
      );
    });

    /**
     * Runs one burst in virtual time: the seek ends at `seekMs`, the clock then moves 20 ms at
     * once, stands still for `stallMs`, and runs at the normal rate until the pause, as Chrome
     * on macOS did. Returns the positions at the two pauses: the one before the seek and the
     * one that ends the burst.
     */
    const runSlowBurst = (seekMs: number, stallMs: number): number[] => {
      const pausedAt: number[] = [];
      const slow = createFakeAudioElement({
        pause: () => {
          pausedAt.push(slow.currentTime);
        },
      });
      controller.attach(slow);
      controller.request(1.0, 1);
      timers.runFor(seekMs, () => {});
      slow.fireSeekedAndPlaying();
      slow.setCurrentTimeInternal(1.02);
      const runsFrom = seekMs + stallMs;
      timers.runFor(3000, (now) => {
        if (now > runsFrom && pausedAt.length < 2) {
          slow.setCurrentTimeInternal(1.02 + (now - runsFrom) / 1000);
        }
      });
      return pausedAt;
    };

    it("plays the whole burst after a seek of 600 ms: the watchdog restarts when the clock check starts", () => {
      // The watchdog armed at the request is due at 1050 ms. The burst needs 600 + 455 + 30 ms.
      const pausedAt = runSlowBurst(600, 455);
      expect(pausedAt).toHaveLength(2);
      expect(pausedAt[1]).toBeGreaterThanOrEqual(burstEnd(1.0));
      expect(pausedAt[1]).toBeLessThan(burstEnd(1.0) + 0.005);
      expect(timers.count).toBe(0);
    });

    it("plays the whole burst through a start longer than half a second: the margin is longer than the start", () => {
      // After the restart at 60 ms, a margin of 0.5 s would be due at 610 ms, and the burst
      // needs 60 + 560 + 30 ms.
      const pausedAt = runSlowBurst(60, 560);
      expect(pausedAt).toHaveLength(2);
      expect(pausedAt[1]).toBeGreaterThanOrEqual(burstEnd(1.0));
      expect(pausedAt[1]).toBeLessThan(burstEnd(1.0) + 0.005);
    });

    it("restarts the watchdog from the position of the element, not from the last target", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      // WebKit: playing at once. Steps continue during the seek, so the last target moves
      // ahead of the position, which is the target of the seek.
      element.firePlaying();
      for (let i = 1; i <= 6; i++) {
        controller.request(1.0 + i * 0.05, 1);
      }
      element.fireSeeked();

      expect(findWatchdog(timers)!.milliseconds).toBeCloseTo(
        (burstEnd(1.3) - 1.0 + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
        6,
      );
    });

    it("stops the element through the watchdog when its clock never reaches the end", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();
      timers.fire(findClockCheck(timers)!.id);

      timers.fire(findWatchdog(timers)!.id);
      expect(element.pauseCalls).toBe(2);
      expect(timers.count).toBe(0);
    });

    it("stops the element through the watchdog when playing never arrives", () => {
      controller.attach(element);
      controller.request(1.0, 1);

      const watchdog = findWatchdog(timers)!;
      expect(watchdog.milliseconds).toBe(
        (SCRUB_BURST_SECONDS + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
      );
      timers.fire(watchdog.id);
      expect(element.pauseCalls).toBe(2);
    });

    it("does not pause again when a stale clock check fires after stop()", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();
      const check = findClockCheck(timers)!;

      controller.stop();
      expect(element.pauseCalls).toBe(2); // 1 on request seek, 1 on stop()

      element.setCurrentTimeInternal(burstEnd(1.0));
      check.callback();
      expect(element.pauseCalls).toBe(2);
    });

    it("does not stop a newer burst from a leftover clock check of a superseded burst", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();
      const oldCheck = findClockCheck(timers)!;

      // Supersede the burst with a jump forward.
      controller.request(2.0, 1);
      const pauseBefore = element.pauseCalls;
      element.setCurrentTimeInternal(burstEnd(2.0));
      oldCheck.callback();
      expect(element.pauseCalls).toBe(pauseBefore);
    });

    it("pauses the element and clears the clock check and the watchdog on stop()", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      expect(timers.count).toBe(2);
      const pauseBefore = element.pauseCalls;
      controller.stop();

      expect(element.pauseCalls).toBe(pauseBefore + 1);
      expect(timers.count).toBe(0);
    });
  });

  describe("the continuation of a forward burst", () => {
    it("continues on the next step: no seek, no play, no pause, and the stop position moves", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      const step = SCRUB_CONTINUATION_TOLERANCE_SECONDS * 0.5;
      controller.request(1.0 + step, 1);
      expect(element.currentTimeAssignments).toEqual([1.0]);
      expect(element.playCalls).toBe(1);
      expect(element.pauseCalls).toBe(1);

      // The element does not stop at the end of the first burst.
      element.setCurrentTimeInternal(burstEnd(1.0));
      timers.fire(findClockCheck(timers)!.id);
      expect(element.pauseCalls).toBe(1);

      // It stops one burst past the new target.
      element.setCurrentTimeInternal(burstEnd(1.0 + step));
      timers.fire(findClockCheck(timers)!.id);
      expect(element.pauseCalls).toBe(2);
    });

    it("continues on a step of exactly the tolerance", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      controller.request(1.0 + SCRUB_CONTINUATION_TOLERANCE_SECONDS, 1);
      expect(element.currentTimeAssignments).toEqual([1.0]);
    });

    it("seeks on a forward step longer than the tolerance", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      const target = 1.0 + SCRUB_CONTINUATION_TOLERANCE_SECONDS * 2;
      controller.request(target, 1);
      expect(element.currentTimeAssignments).toEqual([1.0, target]);
      expect(element.playCalls).toBe(2);
      // Only the watchdog of the new burst is armed. The clock check waits for its seek.
      expect(timers.count).toBe(1);
      expect(findWatchdog(timers)).toBeDefined();
    });

    it("seeks on a forward request whose target is before the last target", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      controller.request(0.99, 1);
      expect(element.currentTimeAssignments).toEqual([1.0, 0.99]);
    });

    it("always seeks on a backward request, even inside the tolerance", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      const target = 1.0 - SCRUB_CONTINUATION_TOLERANCE_SECONDS * 0.5;
      controller.request(target, -1);
      expect(element.currentTimeAssignments).toEqual([1.0, target]);
      expect(element.playCalls).toBe(2);
    });

    it("takes the seek path on a forward request when no burst is active", () => {
      controller.attach(element);
      element.setCurrentTimeInternal(1.0);

      controller.request(1.02, 1);
      expect(element.currentTimeAssignments).toEqual([1.02]);
      expect(element.playCalls).toBe(1);
    });

    it("continues while the element plays behind the target by more than the tolerance, up to the lag limit", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      // A held key: each step goes one frame forward from the last target. The element started
      // late, so it plays well behind the target, farther than the tolerance.
      let target = 1.0;
      for (let i = 0; i < 9; i++) {
        target += 1 / 30;
        controller.request(target, 1);
      }
      expect(target - element.currentTime).toBeGreaterThan(
        SCRUB_CONTINUATION_TOLERANCE_SECONDS,
      );
      expect(target - element.currentTime).toBeLessThanOrEqual(
        SCRUB_CONTINUATION_MAX_LAG_SECONDS,
      );
      expect(element.currentTimeAssignments).toEqual([1.0]);
      expect(element.playCalls).toBe(1);
    });

    it("continues while the seek still runs, and the lag counts from the target of the seek", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      // WebKit: playing at once, and the seek runs for several steps.
      element.firePlaying();

      // Steps of 30 ms: the loop takes as many as fit inside the lag limit.
      const step = 0.03;
      const continued = Math.floor(SCRUB_CONTINUATION_MAX_LAG_SECONDS / step);
      let target = 1.0;
      for (let i = 0; i < continued; i++) {
        target += step;
        controller.request(target, 1);
      }
      expect(element.currentTimeAssignments).toEqual([1.0]);
      expect(findClockCheck(timers)).toBeUndefined();

      // The next step puts the element farther behind than the lag limit, so it seeks.
      controller.request(target + step, 1);
      expect(element.currentTimeAssignments).toEqual([1.0, target + step]);
    });

    it("seeks when the element has fallen behind the target by more than the lag limit", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();
      controller.request(1.05, 1);

      // A stall: the element stands still while the targets move on, until the next target is
      // farther ahead of it than the lag limit.
      element.setCurrentTimeInternal(1.05 - SCRUB_CONTINUATION_MAX_LAG_SECONDS);
      controller.request(1.1, 1);
      expect(element.currentTimeAssignments).toEqual([1.0, 1.1]);
    });

    it("seeks when the element is ahead of the target by more than the tolerance", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      element.setCurrentTimeInternal(1.03 + SCRUB_CONTINUATION_TOLERANCE_SECONDS * 1.5);
      controller.request(1.03, 1);
      expect(element.currentTimeAssignments).toEqual([1.0, 1.03]);
    });

    it("continues on a step of zero", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      controller.request(1.0, 1);
      expect(element.currentTimeAssignments).toEqual([1.0]);
    });

    it("continues while the element is ahead of the target by exactly the tolerance", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      element.setCurrentTimeInternal(1.03 + SCRUB_CONTINUATION_TOLERANCE_SECONDS);
      controller.request(1.03, 1);
      expect(element.currentTimeAssignments).toEqual([1.0]);
    });

    it("seeks on a backward request whose target is ahead of the last target", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      controller.request(1.03, -1);
      expect(element.currentTimeAssignments).toEqual([1.0, 1.03]);
    });

    it("keeps a drag near the pointer: a drag continues only inside its own lag limit", () => {
      controller.attach(element);
      controller.request(1.0, 1, "drag");
      element.fireSeekedAndPlaying();

      // The element plays 80 ms behind the next drag target.
      element.setCurrentTimeInternal(0.97);
      controller.request(1.05, 1, "drag");
      expect(element.currentTimeAssignments).toEqual([1.0]);

      // 150 ms behind: a frame step would continue, but a drag seeks.
      element.setCurrentTimeInternal(0.95);
      controller.request(1.1, 1, "drag");
      expect(element.currentTimeAssignments).toEqual([1.0, 1.1]);
    });

    it("lets a frame step continue at a lag that makes a drag seek", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      element.setCurrentTimeInternal(0.95);
      controller.request(1.1, 1);
      expect(1.1 - element.currentTime).toBeGreaterThan(SCRUB_DRAG_MAX_LAG_SECONDS);
      expect(element.currentTimeAssignments).toEqual([1.0]);
    });

    it("falls through to the seek path without throwing when reading currentTime throws", () => {
      let throwOnGet = false;
      let internalTime = 0;
      const errorElement = createFakeAudioElement();
      Object.defineProperty(errorElement, "currentTime", {
        get: () => {
          if (throwOnGet) {
            throw new Error("InvalidStateError");
          }
          return internalTime;
        },
        set: (val: number) => {
          internalTime = val;
          errorElement.currentTimeAssignments.push(val);
        },
      });

      controller.attach(errorElement);
      controller.request(1.0, 1);
      expect(errorElement.playCalls).toBe(1);

      throwOnGet = true;
      expect(() => controller.request(1.02, 1)).not.toThrow();
      expect(errorElement.currentTimeAssignments).toEqual([1.0, 1.02]);
      expect(errorElement.playCalls).toBe(2);
    });

    it("re-arms the watchdog for the media time that remains, plus the margin", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();
      const firstWatchdog = findWatchdog(timers)!;

      // The element plays 0.2 s behind the new target.
      element.setCurrentTimeInternal(1.0);
      controller.request(1.0 + SCRUB_CONTINUATION_TOLERANCE_SECONDS, 1);
      element.setCurrentTimeInternal(1.0);
      controller.request(1.2, 1);

      expect(timers.getTimer(firstWatchdog.id)).toBeUndefined();
      const watchdog = findWatchdog(timers)!;
      expect(watchdog.milliseconds).toBeCloseTo(
        (burstEnd(1.2) - 1.0 + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
        6,
      );
    });

    it("plays a held key at real time with one seek and one play, and stops one burst after the last step", async () => {
      let rejectPriorBurst!: (reason: unknown) => void;
      let playCount = 0;
      const heldKeyElement = createFakeAudioElement({
        play: () => {
          playCount++;
          if (playCount === 1) {
            return new Promise<void>((_, reject) => {
              rejectPriorBurst = reject;
            });
          }
          return Promise.resolve();
        },
      });

      controller.attach(heldKeyElement);
      controller.request(0.5, 1);
      controller.request(1.0, 1);

      // A held key in a real browser produces an AbortError rejection on every supersede
      rejectPriorBurst({ name: "AbortError" });
      await Promise.resolve();

      // WebKit: playing at once. The seek runs for four steps of 33 ms.
      heldKeyElement.firePlaying();
      const frame = 1 / 30;
      let target = 1.0;
      for (let i = 0; i < 4; i++) {
        target += frame;
        controller.request(target, 1);
      }
      heldKeyElement.fireSeeked();

      // The element plays at real time, one frame for each step, behind the target by the
      // time of the seek.
      for (let i = 0; i < 20; i++) {
        heldKeyElement.setCurrentTimeInternal(heldKeyElement.currentTime + frame);
        target += frame;
        controller.request(target, 1);
      }
      expect(heldKeyElement.playCalls).toBe(2);
      expect(heldKeyElement.currentTimeAssignments).toEqual([0.5, 1.0]);
      expect(heldKeyElement.pauseCalls).toBe(2);

      // The key is released. The element plays on to one burst past the last target.
      playAtNormalRate(timers, heldKeyElement);
      expect(heldKeyElement.pauseCalls).toBe(3);
      expect(heldKeyElement.currentTime).toBeGreaterThanOrEqual(burstEnd(target));
      expect(heldKeyElement.currentTime).toBeLessThan(burstEnd(target) + 0.005);
    });

    it("seeks again when a held key steps faster than real time and the lag passes the limit", () => {
      controller.attach(element);
      controller.request(1.0, 1);
      element.fireSeekedAndPlaying();

      // 25 frames each second at 30 key repeats each second: 40 ms of media for each 33 ms.
      let target = 1.0;
      let steps = 0;
      while (element.currentTimeAssignments.length === 1 && steps < 200) {
        element.setCurrentTimeInternal(element.currentTime + 1 / 30);
        target += 1 / 25;
        controller.request(target, 1);
        steps++;
      }
      expect(element.currentTimeAssignments).toEqual([1.0, target]);
      // The lag grows 1/150 s for each step, so the one seek comes once it passes the limit.
      expect(steps).toBe(Math.floor(SCRUB_CONTINUATION_MAX_LAG_SECONDS * 150) + 1);
    });
  });

  describe("the element lifecycle and failures", () => {
    it("stops the element and makes later requests no-ops when detach() is called with attached element", () => {
      controller.attach(element);
      controller.request(1.0, 1);

      expect(element.listeners.playing.size).toBe(1);
      expect(element.listeners.seeked.size).toBe(1);
      expect(element.listeners.error.size).toBe(1);

      const pauseBefore = element.pauseCalls;
      controller.detach(element);

      expect(element.pauseCalls).toBe(pauseBefore + 1);
      expect(element.listeners.playing.size).toBe(0);
      expect(element.listeners.seeked.size).toBe(0);
      expect(element.listeners.error.size).toBe(0);

      const playBefore = element.playCalls;
      controller.request(3.0, 1);
      expect(element.playCalls).toBe(playBefore);
    });

    it("changes nothing when detach() is called with a different element", () => {
      const otherElement = createFakeAudioElement();
      controller.attach(element);
      controller.request(1.0, 1);

      controller.detach(otherElement);

      // Original element is still attached and active
      controller.request(2.0, 1);
      expect(element.currentTime).toBe(2.0);
      expect(element.playCalls).toBe(2);
    });

    it("disables the controller on error event, and re-enables it on subsequent attach()", () => {
      controller.attach(element);
      controller.request(1.0, 1);

      const pauseBefore = element.pauseCalls;
      element.fireError();
      expect(element.pauseCalls).toBe(pauseBefore + 1);

      const playBefore = element.playCalls;
      controller.request(2.0, 1);
      expect(element.playCalls).toBe(playBefore); // Ignored while disabled

      // Re-attach re-enables the controller
      controller.attach(element);
      controller.request(2.0, 1);
      expect(element.playCalls).toBe(playBefore + 1);
    });

    it("stops and removes listeners from previous element when attaching a different element", () => {
      const element1 = createFakeAudioElement();
      const element2 = createFakeAudioElement();

      controller.attach(element1);
      controller.request(1.0, 1);

      const pause1Before = element1.pauseCalls;
      controller.attach(element2);

      expect(element1.pauseCalls).toBe(pause1Before + 1);
      expect(element1.listeners.playing.size).toBe(0);
      expect(element1.listeners.seeked.size).toBe(0);
      expect(element1.listeners.error.size).toBe(0);
      expect(element2.listeners.playing.size).toBe(1);
      expect(element2.listeners.seeked.size).toBe(1);
      expect(element2.listeners.error.size).toBe(1);
    });

    it("ignores non-finite, non-number or negative targets and invalid directions", () => {
      controller.attach(element);
      const playBefore = element.playCalls;

      controller.request(NaN, 1);
      controller.request(Infinity, 1);
      controller.request(-Infinity, 1);
      controller.request(-0.01, 1);
      controller.request(-1, 1);
      controller.request("1.0" as unknown as number, 1);
      controller.request(undefined as unknown as number, 1);
      controller.request(null as unknown as number, 1);
      controller.request(1.0, 0 as unknown as 1);
      controller.request(1.0, 2 as unknown as 1);
      controller.request(1.0, "1" as unknown as 1);

      expect(element.playCalls).toBe(playBefore);
    });

    it("accepts -0 as a valid non-negative target time", () => {
      controller.attach(element);
      controller.request(-0, 1);
      expect(element.playCalls).toBe(1);
      expect(element.currentTime === 0).toBe(true);
      expect(element.currentTimeAssignments).toEqual([-0]);
    });

    it("does not disable controller on play rejection with AbortError, but disables on other rejection", async () => {
      let rejectPlay!: (reason: unknown) => void;
      const elementWithAbort = createFakeAudioElement({
        play: () =>
          new Promise<void>((_, reject) => {
            rejectPlay = reject;
          }),
      });

      controller.attach(elementWithAbort);
      controller.request(1.0, 1);
      rejectPlay({ name: "AbortError" });
      await Promise.resolve();

      // Controller should remain enabled; next request should succeed
      elementWithAbort.play = vi.fn(() => Promise.resolve());
      controller.request(2.0, 1);
      expect(elementWithAbort.play).toHaveBeenCalledTimes(1);

      // Now test rejection with another error (e.g. NotAllowedError)
      let rejectPlayOther!: (reason: unknown) => void;
      const elementWithOther = createFakeAudioElement({
        play: () =>
          new Promise<void>((_, reject) => {
            rejectPlayOther = reject;
          }),
      });

      controller.attach(elementWithOther);
      controller.request(1.0, 1);
      rejectPlayOther({ name: "NotAllowedError" });
      await Promise.resolve();

      // Controller should now be disabled; next request should be ignored
      elementWithOther.play = vi.fn(() => Promise.resolve());
      controller.request(2.0, 1);
      expect(elementWithOther.play).not.toHaveBeenCalled();
    });

    it("clears active on synchronous AbortError from play() so next in-tolerance request takes seek path (B1)", () => {
      const abortError = new Error("The play() request was interrupted.");
      abortError.name = "AbortError";

      let shouldThrow = true;
      const throwingPlayElement = createFakeAudioElement({
        play: () => {
          if (shouldThrow) {
            shouldThrow = false;
            throw abortError;
          }
          return Promise.resolve();
        },
      });

      controller.attach(throwingPlayElement);
      controller.request(1.0, 1);

      // No timer is armed after a synchronous AbortError
      expect(timers.count).toBe(0);
      expect(throwingPlayElement.currentTimeAssignments).toEqual([1.0]);
      expect(throwingPlayElement.playCalls).toBe(1);

      // The next step: if active was left true, it would continue without a seek or a play.
      controller.request(1.02, 1);
      expect(throwingPlayElement.currentTimeAssignments).toEqual([1.0, 1.02]);
      expect(throwingPlayElement.playCalls).toBe(2);
    });

    it("clears active on play() promise rejection with AbortError so next in-tolerance request takes seek path (B2)", async () => {
      let rejectPlay!: (reason: unknown) => void;
      const elementWithAbort = createFakeAudioElement({
        play: () =>
          new Promise<void>((_, reject) => {
            rejectPlay = reject;
          }),
      });

      controller.attach(elementWithAbort);
      controller.request(1.0, 1);

      rejectPlay({ name: "AbortError" });
      await Promise.resolve();

      elementWithAbort.play = vi.fn(() => Promise.resolve());
      controller.request(1.02, 1);

      // If active remained true, the request would continue without seeking or calling play.
      expect(elementWithAbort.currentTimeAssignments).toEqual([1.0, 1.02]);
      expect(elementWithAbort.play).toHaveBeenCalledTimes(1);
    });

    it("pins burst-id guard in abort branch: superseded abort does not clear active flag of newer burst (F1)", async () => {
      let rejectBurst1!: (reason: unknown) => void;
      let playCount = 0;
      const controlledElement = createFakeAudioElement({
        play: () => {
          playCount++;
          if (playCount === 1) {
            return new Promise<void>((_, reject) => {
              rejectBurst1 = reject;
            });
          }
          return Promise.resolve();
        },
      });

      controller.attach(controlledElement);

      // Burst 1, then an out-of-tolerance forward request, so burst 2 takes the seek path.
      controller.request(1.0, 1);
      controlledElement.fireSeekedAndPlaying();
      controller.request(2.0, 1);
      expect(controlledElement.playCalls).toBe(2);
      expect(controlledElement.currentTimeAssignments).toEqual([1.0, 2.0]);

      // Burst 1's promise rejects with an AbortError after it was superseded.
      rejectBurst1({ name: "AbortError" });
      await Promise.resolve();

      // Burst 2 still continues on the next step.
      controlledElement.fireSeekedAndPlaying();
      controller.request(2.05, 1);
      expect(controlledElement.playCalls).toBe(2);
      expect(controlledElement.currentTimeAssignments).toEqual([1.0, 2.0]);
    });

    it("disables controller when a superseded burst rejects with a non-AbortError (N5)", async () => {
      let rejectBurst1!: (reason: unknown) => void;
      const elementWithRejection = createFakeAudioElement({
        play: () =>
          new Promise<void>((_, reject) => {
            rejectBurst1 = reject;
          }),
      });

      controller.attach(elementWithRejection);
      controller.request(1.0, 1); // Burst 1

      // Burst 2 supersedes burst 1.
      elementWithRejection.play = vi.fn(() => Promise.resolve());
      controller.request(2.0, 1);
      elementWithRejection.fireSeekedAndPlaying();

      const pauseCallsBeforeRejection = elementWithRejection.pauseCalls;
      const armedBefore = timers.count;
      expect(findClockCheck(timers)).toBeDefined();
      expect(findWatchdog(timers)).toBeDefined();

      rejectBurst1({ name: "NotAllowedError" });
      await Promise.resolve();

      // The newer burst was NOT paused, and its timers are still armed.
      expect(elementWithRejection.pauseCalls).toBe(pauseCallsBeforeRejection);
      expect(timers.count).toBe(armedBefore);

      // Burst 3: the controller is disabled even though the rejection came from burst 1.
      elementWithRejection.play = vi.fn(() => Promise.resolve());
      controller.request(3.0, 1);
      expect(elementWithRejection.play).not.toHaveBeenCalled();
    });

    it("sets active to false and does not throw when currentTime assignment throws", () => {
      let throwOnSet = true;
      let setCalls = 0;
      const throwingElement = createFakeAudioElement();
      Object.defineProperty(throwingElement, "currentTime", {
        get: () => 0,
        set: (val: number) => {
          setCalls++;
          if (throwOnSet) {
            throwOnSet = false;
            throw new Error("InvalidStateError");
          }
          throwingElement.setCurrentTimeInternal(val);
        },
      });

      controller.attach(throwingElement);
      expect(() => controller.request(1.0, 1)).not.toThrow();
      expect(throwingElement.playCalls).toBe(0);
      expect(setCalls).toBe(1);

      // The next forward step takes the seek path, because active was cleared.
      controller.request(1.05, 1);
      expect(setCalls).toBe(2);
      expect(throwingElement.playCalls).toBe(1);
    });

    it("ignores DOMException when pause() throws", () => {
      const throwingPauseElement = createFakeAudioElement({
        pause: () => {
          throw new Error("DOMException");
        },
      });

      controller.attach(throwingPauseElement);
      expect(() => controller.request(1.0, 1)).not.toThrow();
      expect(() => controller.stop()).not.toThrow();
    });

    it("treats every method as a no-op without throwing when no element is attached", () => {
      const unattachedController = createScrubAudioController(timers);

      expect(() => unattachedController.request(1.0, 1)).not.toThrow();
      expect(() => unattachedController.stop()).not.toThrow();
      expect(() => unattachedController.detach(createFakeAudioElement())).not.toThrow();
    });

    it("ignores attach() when element is falsy or lacks play/pause functions", () => {
      const emptyController = createScrubAudioController(timers);

      emptyController.attach(null as unknown as ScrubAudioElement);
      emptyController.attach(undefined as unknown as ScrubAudioElement);
      emptyController.attach({} as unknown as ScrubAudioElement);
      emptyController.attach({
        play: "notAFunction",
        pause: () => {},
      } as unknown as ScrubAudioElement);

      emptyController.request(1.0, 1);
      expect(timers.count).toBe(0);
    });

    it("exports default singleton scrubAudioController", () => {
      expect(scrubAudioController).toBeDefined();
      expect(typeof scrubAudioController.attach).toBe("function");
      expect(typeof scrubAudioController.detach).toBe("function");
      expect(typeof scrubAudioController.request).toBe("function");
      expect(typeof scrubAudioController.stop).toBe("function");
      expect(() => scrubAudioController.stop()).not.toThrow();
    });

    it("pins timing constants fixed by ADR 019", () => {
      expect(SCRUB_BURST_SECONDS).toBe(0.05);
      expect(SCRUB_WATCHDOG_EXTRA_SECONDS).toBe(1);
      expect(SCRUB_CONTINUATION_TOLERANCE_SECONDS).toBe(0.1);
      expect(SCRUB_CONTINUATION_MAX_LAG_SECONDS).toBe(0.75);
      expect(SCRUB_DRAG_MAX_LAG_SECONDS).toBe(0.1);
      expect(SCRUB_CLOCK_CHECK_MIN_MS).toBe(4);
      expect(SCRUB_CLOCK_CHECK_MAX_MS).toBe(16);
    });

    it("runs the same seeks, plays and timers for a muted element, and never changes the mute", () => {
      // The mute toggle sets `muted` on the element. The controller must not read it to skip a
      // burst: the seek, the play, the continuation rule and the timers stay the same, and only
      // the sound is silent.
      const run = (muted: boolean) => {
        const runTimers = createTestTimers();
        const runController = createScrubAudioController(runTimers);
        const runElement = Object.assign(createFakeAudioElement(), { muted });
        const armed: number[] = [];
        const setTimer = runTimers.setTimer;
        runTimers.setTimer = (callback, milliseconds) => {
          armed.push(milliseconds);
          return setTimer(callback, milliseconds);
        };

        runController.attach(runElement);
        runController.request(1.0, 1);
        runElement.fireSeekedAndPlaying();
        // A held key: the next forward step continues the burst.
        runElement.setCurrentTimeInternal(1.03);
        runController.request(1.04, 1);
        // A backward request always seeks.
        runController.request(0.9, -1);
        runElement.fireSeekedAndPlaying();
        playAtNormalRate(runTimers, runElement);

        return {
          muted: runElement.muted,
          currentTimeAssignments: runElement.currentTimeAssignments,
          playCalls: runElement.playCalls,
          pauseCalls: runElement.pauseCalls,
          armed,
        };
      };

      const audible = run(false);
      const silent = run(true);

      expect(silent.muted).toBe(true);
      expect(audible.muted).toBe(false);
      expect(silent.currentTimeAssignments).toEqual([1.0, 0.9]);
      expect(silent.currentTimeAssignments).toEqual(audible.currentTimeAssignments);
      expect(silent.playCalls).toBe(audible.playCalls);
      expect(silent.pauseCalls).toBe(audible.pauseCalls);
      expect(silent.armed).toEqual(audible.armed);
    });
  });
});
