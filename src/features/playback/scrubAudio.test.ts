import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScrubAudioController,
  SCRUB_BURST_SECONDS,
  SCRUB_CONTINUATION_TOLERANCE_SECONDS,
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
}

interface TestTimers extends ScrubAudioTimers {
  getArmedTimers: () => ArmedTimer[];
  fire: (handle: number) => void;
  getTimer: (handle: number) => ArmedTimer | undefined;
  count: number;
}

function createTestTimers(): TestTimers {
  let nextId = 1;
  const armed = new Map<number, ArmedTimer>();

  const setTimer = (callback: () => void, milliseconds: number): number => {
    const id = nextId++;
    armed.set(id, { id, callback, milliseconds });
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

  return {
    setTimer,
    clearTimer,
    fire,
    getTimer,
    getArmedTimers,
    get count() {
      return armed.size;
    },
  };
}

interface FakeAudioElement extends ScrubAudioElement {
  playCalls: number;
  pauseCalls: number;
  currentTimeAssignments: number[];
  listeners: Record<ScrubAudioEventType, Set<() => void>>;
  seeking: boolean;
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
    get currentTime() {
      return currentTime;
    },
    // An assignment starts a seek, as it does on a media element.
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

describe("Scrub Audio Controller", () => {
  let timers: TestTimers;
  let element: FakeAudioElement;
  let controller: ReturnType<typeof createScrubAudioController>;

  beforeEach(() => {
    timers = createTestTimers();
    element = createFakeAudioElement();
    controller = createScrubAudioController(timers);
  });

  it("1. assigns currentTime and calls play, and does not pause until one burst after the seek ends and playing fires", () => {
    controller.attach(element);
    controller.request(1.5, 1);

    expect(element.currentTime).toBe(1.5);
    expect(element.currentTimeAssignments).toEqual([1.5]);
    expect(element.playCalls).toBe(1);
    // Pause is called once before seeking to ensure no race with ongoing playback
    expect(element.pauseCalls).toBe(1);

    // Watchdog is armed, but stop timer is not armed yet
    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(false);

    // The seek ends, and then the element plays, as in Chromium
    element.fireSeeked();
    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(false);
    element.firePlaying();

    // Element is still NOT paused immediately after playing event
    expect(element.pauseCalls).toBe(1);

    const stopTimer = timers
      .getArmedTimers()
      .find((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000);
    expect(stopTimer).toBeDefined();

    // Fire stop timer after one burst duration
    timers.fire(stopTimer!.id);
    expect(element.pauseCalls).toBe(2);
  });

  it("2. does not shorten burst on slow seek: playing before the end of the seek, as in WebKit, arms nothing until seeked", () => {
    controller.attach(element);
    controller.request(1.0, 1);

    // WebKit keeps the ready state through the assignment of currentTime, so playing fires
    // at once, while the seek still runs. The burst has not started to sound.
    element.firePlaying();
    expect(element.seeking).toBe(true);
    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(false);

    element.fireSeeked();

    const stopTimer = timers
      .getArmedTimers()
      .find((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000);
    expect(stopTimer).toBeDefined();
    expect(stopTimer?.milliseconds).toBe(SCRUB_BURST_SECONDS * 1000);

    timers.fire(stopTimer!.id);
    expect(element.pauseCalls).toBe(2);
  });

  it("3. extends ongoing forward burst inside tolerance without reassigning currentTime or calling play, pushing stop time later", () => {
    controller.attach(element);
    controller.request(1.0, 1);
    element.fireSeekedAndPlaying();

    const initialStopTimer = timers
      .getArmedTimers()
      .find((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000)!;
    expect(initialStopTimer).toBeDefined();

    // Advance position slightly within tolerance
    element.setCurrentTimeInternal(1.0);
    const playCallsBefore = element.playCalls;
    const pauseCallsBefore = element.pauseCalls;
    const assignmentsBefore = element.currentTimeAssignments.length;

    // Request with distance <= SCRUB_CONTINUATION_TOLERANCE_SECONDS
    const continuationTarget = 1.0 + SCRUB_CONTINUATION_TOLERANCE_SECONDS * 0.5;
    controller.request(continuationTarget, 1);

    expect(element.currentTimeAssignments.length).toBe(assignmentsBefore);
    expect(element.playCalls).toBe(playCallsBefore);
    expect(element.pauseCalls).toBe(pauseCallsBefore);

    // Request at exactly SCRUB_CONTINUATION_TOLERANCE_SECONDS away from currentTime (boundary test)
    element.setCurrentTimeInternal(0);
    const boundaryTarget = SCRUB_CONTINUATION_TOLERANCE_SECONDS;
    controller.request(boundaryTarget, 1);

    expect(element.currentTimeAssignments.length).toBe(assignmentsBefore);
    expect(element.playCalls).toBe(playCallsBefore);
    expect(element.pauseCalls).toBe(pauseCallsBefore);

    // Old stop timer was cleared and replaced with a new one
    expect(timers.getTimer(initialStopTimer.id)).toBeUndefined();
    const newStopTimer = timers
      .getArmedTimers()
      .find((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000)!;
    expect(newStopTimer).toBeDefined();
    expect(newStopTimer.id).not.toBe(initialStopTimer.id);

    timers.fire(newStopTimer.id);
    expect(element.pauseCalls).toBe(pauseCallsBefore + 1);
  });

  it("4. reassigns currentTime and seeks on a forward request outside tolerance", () => {
    controller.attach(element);
    controller.request(1.0, 1);
    element.fireSeekedAndPlaying();

    element.setCurrentTimeInternal(1.0);
    // Distance > SCRUB_CONTINUATION_TOLERANCE_SECONDS
    const outsideTarget = 1.0 + SCRUB_CONTINUATION_TOLERANCE_SECONDS * 2;
    controller.request(outsideTarget, 1);

    expect(element.currentTime).toBe(outsideTarget);
    expect(element.currentTimeAssignments).toEqual([1.0, outsideTarget]);
    expect(element.playCalls).toBe(2);

    // Exactly one timer is armed right after re-seek: the watchdog, and no stale stop timer
    expect(timers.count).toBe(1);
    const armedTimers = timers.getArmedTimers();
    expect(armedTimers).toHaveLength(1);
    expect(armedTimers[0].milliseconds).toBe(
      (SCRUB_BURST_SECONDS + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
    );
    expect(armedTimers.some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000)).toBe(
      false,
    );
  });

  it("5. always reassigns currentTime and seeks on a backward request even inside tolerance", () => {
    controller.attach(element);
    controller.request(1.0, 1);
    element.fireSeekedAndPlaying();

    element.setCurrentTimeInternal(1.0);
    // Distance <= SCRUB_CONTINUATION_TOLERANCE_SECONDS, but direction is -1
    const backwardTarget = 1.0 - SCRUB_CONTINUATION_TOLERANCE_SECONDS * 0.5;
    controller.request(backwardTarget, -1);

    expect(element.currentTime).toBe(backwardTarget);
    expect(element.currentTimeAssignments).toEqual([1.0, backwardTarget]);
    expect(element.playCalls).toBe(2);
  });

  it("6. takes the seek path on a forward request when no burst is active", () => {
    controller.attach(element);
    element.setCurrentTimeInternal(1.0);

    // No active burst; distance 0.02 <= SCRUB_CONTINUATION_TOLERANCE_SECONDS
    controller.request(1.02, 1);

    expect(element.currentTimeAssignments).toEqual([1.02]);
    expect(element.playCalls).toBe(1);
  });

  it("7. pauses the element and clears both timers when stop() is called", () => {
    controller.attach(element);
    controller.request(1.0, 1);
    element.fireSeekedAndPlaying();

    expect(timers.count).toBe(2); // watchdog and stop timers
    const pauseBefore = element.pauseCalls;

    controller.stop();

    expect(element.pauseCalls).toBe(pauseBefore + 1);
    expect(timers.count).toBe(0);
  });

  it("8. does not pause newer burst from a leftover stop timer of a superseded burst", () => {
    controller.attach(element);
    controller.request(1.0, 1);
    element.fireSeekedAndPlaying();

    const oldStopTimer = timers
      .getArmedTimers()
      .find((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000)!;
    expect(oldStopTimer).toBeDefined();

    // Supersede burst with a new request
    controller.request(2.0, 1);

    const pauseBefore = element.pauseCalls;
    // Invoke the old timer callback as if it fired concurrently
    oldStopTimer.callback();

    expect(element.pauseCalls).toBe(pauseBefore);
  });

  it("9. stops the element and makes later requests no-ops when detach() is called with attached element", () => {
    controller.attach(element);
    controller.request(1.0, 1);

    expect(element.listeners.playing.size).toBe(1);
    expect(element.listeners.error.size).toBe(1);

    const pauseBefore = element.pauseCalls;
    controller.detach(element);

    expect(element.pauseCalls).toBe(pauseBefore + 1);
    expect(element.listeners.playing.size).toBe(0);
    expect(element.listeners.error.size).toBe(0);

    const playBefore = element.playCalls;
    controller.request(3.0, 1);
    expect(element.playCalls).toBe(playBefore);
  });

  it("10. changes nothing when detach() is called with a different element", () => {
    const otherElement = createFakeAudioElement();
    controller.attach(element);
    controller.request(1.0, 1);

    controller.detach(otherElement);

    // Original element is still attached and active
    controller.request(2.0, 1);
    expect(element.currentTime).toBe(2.0);
    expect(element.playCalls).toBe(2);
  });

  it("11. disables the controller on error event, and re-enables it on subsequent attach()", () => {
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

  it("12. pauses the element via the watchdog when playing event never arrives", () => {
    controller.attach(element);
    controller.request(1.0, 1);

    const watchdog = timers
      .getArmedTimers()
      .find(
        (t) =>
          t.milliseconds ===
          (SCRUB_BURST_SECONDS + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
      )!;
    expect(watchdog).toBeDefined();

    const pauseBefore = element.pauseCalls;
    timers.fire(watchdog.id);
    expect(element.pauseCalls).toBe(pauseBefore + 1);
  });

  it("13. ignores non-finite, non-number or negative targets and invalid directions", () => {
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

  it("14. does not disable controller on play rejection with AbortError, but disables on other rejection", async () => {
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

  it("15. treats every method as a no-op without throwing when no element is attached", () => {
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

  it("handles continuation before the burst starts by re-arming watchdog and keeping stopHandle null", () => {
    controller.attach(element);
    controller.request(1.0, 1);

    const initialWatchdog = timers
      .getArmedTimers()
      .find(
        (t) =>
          t.milliseconds ===
          (SCRUB_BURST_SECONDS + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
      )!;
    expect(initialWatchdog).toBeDefined();

    element.currentTime = 1.02;
    controller.request(1.05, 1); // Continuation path before playing arrives

    // Verify watchdog was re-armed: initial watchdog is cancelled and a new one is armed
    expect(timers.getTimer(initialWatchdog.id)).toBeUndefined();
    const rearmedWatchdog = timers
      .getArmedTimers()
      .find(
        (t) =>
          t.milliseconds ===
          (SCRUB_BURST_SECONDS + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
      )!;
    expect(rearmedWatchdog).toBeDefined();
    expect(rearmedWatchdog.id).not.toBe(initialWatchdog.id);

    // Stop timer remains un-armed because the seek has not ended and playing has not arrived
    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(false);

    // Later when the seek ends and playing arrives, the stop timer arms
    element.fireSeekedAndPlaying();
    const stopTimer = timers
      .getArmedTimers()
      .find((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000);
    expect(stopTimer).toBeDefined();

    timers.fire(stopTimer!.id);
    expect(element.pauseCalls).toBe(2);
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

    // Issue a further in-tolerance forward request (distance <= 0.1 from getter's 0).
    // If active was set to false, this takes the seek path:
    controller.request(0.05, 1);
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
    expect(SCRUB_WATCHDOG_EXTRA_SECONDS).toBe(0.5);
    expect(SCRUB_CONTINUATION_TOLERANCE_SECONDS).toBe(0.1);
  });

  it("accepts -0 as a valid non-negative target time", () => {
    controller.attach(element);
    controller.request(-0, 1);
    expect(element.playCalls).toBe(1);
    expect(element.currentTime === 0).toBe(true);
    expect(element.currentTimeAssignments).toEqual([-0]);
  });

  it("does not pause element again when a stale stop timer fires after controller.stop()", () => {
    controller.attach(element);
    controller.request(1.0, 1);
    element.fireSeekedAndPlaying();

    const stopTimer = timers
      .getArmedTimers()
      .find((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000)!;
    expect(stopTimer).toBeDefined();

    controller.stop();
    expect(element.pauseCalls).toBe(2); // 1 on request seek, 1 on stop()

    // Firing stale timer callback must not call pause() again
    stopTimer.callback();
    expect(element.pauseCalls).toBe(2);
  });

  it("maintains single play and single currentTime assignment across repeated in-tolerance forward continuations (held key)", async () => {
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

    heldKeyElement.fireSeekedAndPlaying();

    expect(heldKeyElement.playCalls).toBe(2);
    expect(heldKeyElement.currentTimeAssignments).toEqual([0.5, 1.0]);

    // Simulate 10 held-key step events repeating ~30 times/sec (~0.033s increments within tolerance 0.1)
    let currentPos = 1.0;
    for (let i = 1; i <= 10; i++) {
      currentPos += 0.033;
      heldKeyElement.setCurrentTimeInternal(currentPos);
      controller.request(currentPos + 0.01, 1);
    }

    expect(heldKeyElement.playCalls).toBe(2);
    expect(heldKeyElement.currentTimeAssignments).toEqual([0.5, 1.0]);

    const pendingStopTimer = timers
      .getArmedTimers()
      .find((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000);
    expect(pendingStopTimer).toBeDefined();
  });

  it("does not arm a stop timer when seeked and playing fire with no active burst", () => {
    controller.attach(element);
    element.fireSeekedAndPlaying();
    expect(timers.count).toBe(0);

    controller.request(1.0, 1);
    controller.stop();
    expect(timers.count).toBe(0);

    element.fireSeekedAndPlaying();
    expect(timers.count).toBe(0);
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

    // In-tolerance forward request (distance <= 0.1, direction 1)
    throwingPlayElement.setCurrentTimeInternal(1.0);
    controller.request(1.02, 1);

    // If active was left true, this would take continuation and NOT call play() or assign currentTime.
    // Because active was cleared, it takes the seek path:
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

    // Reject the burst with AbortError
    rejectPlay({ name: "AbortError" });
    await Promise.resolve();

    // Subsequent in-tolerance forward request
    elementWithAbort.setCurrentTimeInternal(1.0);
    elementWithAbort.play = vi.fn(() => Promise.resolve());

    controller.request(1.02, 1);

    // If active remained true, continuation path would be taken without seeking or calling play.
    // Because active was cleared, it takes the seek path:
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

    // 1. Attach an element whose play() returns a promise you control.
    controller.attach(controlledElement);

    // 2. Request burst 1. Fire playing.
    controller.request(1.0, 1);
    controlledElement.fireSeekedAndPlaying();
    expect(controlledElement.playCalls).toBe(1);
    expect(controlledElement.currentTimeAssignments).toEqual([1.0]);

    // 3. Supersede it with an OUT-OF-TOLERANCE forward request, so burst 2 takes the seek path.
    controller.request(2.0, 1);
    expect(controlledElement.playCalls).toBe(2);
    expect(controlledElement.currentTimeAssignments).toEqual([1.0, 2.0]);

    // 4. Now reject burst 1's promise with an AbortError and await the microtask queue.
    rejectBurst1({ name: "AbortError" });
    await Promise.resolve();

    // 5. Fire playing for burst 2, then issue an IN-TOLERANCE forward request.
    controlledElement.fireSeekedAndPlaying();
    controller.request(2.05, 1);

    // 6. Assert the continuation path was taken: play() call count unchanged, and no new currentTime assignment.
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
    controller.request(1.0, 1); // Burst 1 (id = 1)

    // Request burst 2, superseding burst 1 (burstId becomes 2)
    elementWithRejection.play = vi.fn(() => Promise.resolve());
    controller.request(2.0, 1);
    elementWithRejection.fireSeekedAndPlaying();

    const pauseCallsBeforeRejection = elementWithRejection.pauseCalls;
    const armedTimersCountBefore = timers.count;
    expect(armedTimersCountBefore).toBeGreaterThan(0);

    // Burst 1 rejects with NotAllowedError after being superseded
    rejectBurst1({ name: "NotAllowedError" });
    await Promise.resolve();

    // After superseded rejection, the newer burst was NOT paused and its timers are still armed
    expect(elementWithRejection.pauseCalls).toBe(pauseCallsBeforeRejection);
    expect(timers.count).toBe(armedTimersCountBefore);
    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(true);
    expect(
      timers
        .getArmedTimers()
        .some(
          (t) =>
            t.milliseconds ===
            (SCRUB_BURST_SECONDS + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
        ),
    ).toBe(true);

    // Burst 3 requested: controller should be disabled even though rejection was from superseded burst
    elementWithRejection.play = vi.fn(() => Promise.resolve());
    controller.request(3.0, 1);
    expect(elementWithRejection.play).not.toHaveBeenCalled();
  });

  it("falls through to seek path without throwing when reading currentTime throws on continuation (N3)", () => {
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

    // Enable getter throwing
    throwOnGet = true;

    // Request continuation: should not throw, should fall through to seek path
    expect(() => controller.request(1.02, 1)).not.toThrow();
    expect(errorElement.currentTimeAssignments).toEqual([1.0, 1.02]);
    expect(errorElement.playCalls).toBe(2);
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
      // A held key: a forward request inside the tolerance continues the burst.
      runElement.setCurrentTimeInternal(1.03);
      runController.request(1.04, 1);
      // A backward request always seeks.
      runController.request(0.9, -1);
      runElement.fireSeekedAndPlaying();
      const stopTimer = runTimers
        .getArmedTimers()
        .find((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000);
      runTimers.fire(stopTimer!.id);

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

  it("does not arm a stop timer on seeked alone", () => {
    controller.attach(element);
    controller.request(1.0, 1);
    element.fireSeeked();

    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(false);
    expect(element.pauseCalls).toBe(1);
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
    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(false);

    // The seek of burst B ends.
    element.fireSeeked();
    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(true);
  });

  it("clears both conditions of the stop timer when a new burst seeks", () => {
    controller.attach(element);
    controller.request(1.0, 1);
    element.fireSeekedAndPlaying();
    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(true);

    // A backward request always seeks. It pauses and plays again, so WebKit sends playing at
    // once, and the stop timer still waits for the end of the new seek.
    controller.request(0.9, -1);
    expect(timers.count).toBe(1);
    element.firePlaying();
    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(false);

    element.fireSeeked();
    const stopTimer = timers
      .getArmedTimers()
      .find((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000);
    expect(stopTimer).toBeDefined();
    const pauseBefore = element.pauseCalls;
    timers.fire(stopTimer!.id);
    expect(element.pauseCalls).toBe(pauseBefore + 1);
  });

  it("listens to seeked on the attached element and stops listening on detach", () => {
    controller.attach(element);
    expect(element.listeners.seeked.size).toBe(1);
    controller.detach(element);
    expect(element.listeners.seeked.size).toBe(0);
  });

  it("clears both conditions for a new seek in the Chromium order too: seeked alone arms nothing", () => {
    controller.attach(element);
    controller.request(1.0, 1);
    element.fireSeekedAndPlaying();

    controller.request(0.9, -1);
    element.fireSeeked();
    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(false);

    element.firePlaying();
    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(true);
  });

  it("arms the stop timer on playing when the assignment started no seek, as before the metadata loads", () => {
    controller.attach(element);
    controller.request(0, -1);
    // Before the metadata loads, an assignment of currentTime only stores the start position.
    // No seek starts, so the element never reports seeking and never sends seeked.
    element.seeking = false;

    element.firePlaying();
    const stopTimer = timers
      .getArmedTimers()
      .find((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000);
    expect(stopTimer).toBeDefined();
    timers.fire(stopTimer!.id);
    expect(element.pauseCalls).toBe(2);
  });

  it("keeps the WebKit order through the continuation path: the stop timer arms at the end of the seek", () => {
    controller.attach(element);
    controller.request(1.0, 1);
    // WebKit: playing at once, while the seek runs.
    element.firePlaying();

    // A held key: a forward request inside the tolerance continues the burst. The element
    // reports the target of its seek as its position.
    controller.request(1.03, 1);
    expect(element.currentTimeAssignments).toEqual([1.0]);
    expect(element.playCalls).toBe(1);
    expect(
      timers
        .getArmedTimers()
        .some((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000),
    ).toBe(false);

    element.fireSeeked();
    const stopTimer = timers
      .getArmedTimers()
      .find((t) => t.milliseconds === SCRUB_BURST_SECONDS * 1000);
    expect(stopTimer).toBeDefined();
    timers.fire(stopTimer!.id);
    expect(element.pauseCalls).toBe(2);
  });
});
