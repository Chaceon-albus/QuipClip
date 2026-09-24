import { describe, expect, it } from "vitest";
import { getSourceRevisionKey } from "@/features/media";
import {
  createPlaybackStore,
  type PlaybackMediaElement,
  type PlaybackSource,
} from "@/features/playback";
import type { Pts } from "@/types/project";
import {
  DEFERRED_NAVIGATION_ANCHOR_WAIT_MS,
  createAnchorWaitController,
  followDeferredNavigation,
  reportAnchorWaitExpired,
  shouldWaitForAnchor,
  stepAnchorWait,
  type AnchorWaitEvent,
  type AnchorWaitPhase,
  type AnchorWaitStep,
} from "./anchorWait";

const WAIT = DEFERRED_NAVIGATION_ANCHOR_WAIT_MS;

/** A clock that runs the timers of the controller when the test moves it. */
function createFakeClock() {
  let now = 0;
  let nextHandle = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    timers: {
      setTimer: (callback: () => void, milliseconds: number): number => {
        const handle = nextHandle++;
        pending.set(handle, { at: now + milliseconds, callback });
        return handle;
      },
      clearTimer: (handle: number): void => {
        pending.delete(handle);
      },
    },
    advance(milliseconds: number): void {
      const until = now + milliseconds;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) {
          break;
        }
        const [handle, entry] = due;
        pending.delete(handle);
        now = entry.at;
        entry.callback();
      }
      now = until;
    },
    get pendingCount(): number {
      return pending.size;
    },
  };
}

describe("anchorWait", () => {
  it("waits eight seconds of visible time", () => {
    expect(DEFERRED_NAVIGATION_ANCHOR_WAIT_MS).toBe(8000);
  });

  describe("stepAnchorWait", () => {
    const visible: AnchorWaitEvent = { type: "visibility", visible: true };
    const hidden: AnchorWaitEvent = { type: "visibility", visible: false };

    it.each<[AnchorWaitPhase, AnchorWaitEvent, AnchorWaitStep]>([
      // A deferral starts the wait, or holds it while the document is hidden
      [
        "idle",
        { type: "arm", visible: true },
        { phase: "waiting", timer: "start", giveUp: false },
      ],
      [
        "idle",
        { type: "arm", visible: false },
        { phase: "paused", timer: "none", giveUp: false },
      ],
      // A wait that runs keeps its start, and a wait that ran out stays out
      [
        "waiting",
        { type: "arm", visible: true },
        { phase: "waiting", timer: "none", giveUp: false },
      ],
      [
        "done",
        { type: "arm", visible: true },
        { phase: "done", timer: "none", giveUp: false },
      ],
      // The end of the deferral ends the wait
      ["waiting", { type: "disarm" }, { phase: "idle", timer: "stop", giveUp: false }],
      ["paused", { type: "disarm" }, { phase: "idle", timer: "none", giveUp: false }],
      ["done", { type: "disarm" }, { phase: "idle", timer: "none", giveUp: false }],
      // A hidden document stops the clock, and a visible one starts a whole wait again
      ["waiting", hidden, { phase: "paused", timer: "stop", giveUp: false }],
      ["paused", visible, { phase: "waiting", timer: "start", giveUp: false }],
      ["waiting", visible, { phase: "waiting", timer: "none", giveUp: false }],
      ["idle", visible, { phase: "idle", timer: "none", giveUp: false }],
      // The timer gives up only while the wait runs
      ["waiting", { type: "timeout" }, { phase: "done", timer: "none", giveUp: true }],
      [
        "paused",
        { type: "timeout" },
        { phase: "paused", timer: "none", giveUp: false },
      ],
      ["idle", { type: "timeout" }, { phase: "idle", timer: "none", giveUp: false }],
    ])("goes from %s on %o to %o", (phase, event, step) => {
      expect(stepAnchorWait(phase, event)).toStrictEqual(step);
    });
  });

  describe("shouldWaitForAnchor", () => {
    it("waits only while a navigation is deferred and the calibration is open", () => {
      expect(
        shouldWaitForAnchor({
          hasDeferredNavigation: true,
          calibrationStatus: "calibrating",
        }),
      ).toBe(true);
      expect(
        shouldWaitForAnchor({
          hasDeferredNavigation: false,
          calibrationStatus: "calibrating",
        }),
      ).toBe(false);
      expect(
        shouldWaitForAnchor({
          hasDeferredNavigation: true,
          calibrationStatus: "ready",
        }),
      ).toBe(false);
    });
  });

  describe("createAnchorWaitController", () => {
    function setup() {
      const clock = createFakeClock();
      const gaveUp: string[] = [];
      const controller = createAnchorWaitController<string>(clock.timers, (element) => {
        gaveUp.push(element);
      });
      return { clock, gaveUp, controller };
    }

    it("gives up once when the wait runs out", () => {
      const { clock, gaveUp, controller } = setup();
      controller.arm("video", true);

      clock.advance(WAIT - 1);
      expect(gaveUp).toStrictEqual([]);
      clock.advance(1);
      expect(gaveUp).toStrictEqual(["video"]);
      expect(clock.pendingCount).toBe(0);

      controller.arm("video", true);
      controller.visibility(false);
      controller.visibility(true);
      clock.advance(WAIT * 2);
      expect(gaveUp).toStrictEqual(["video"]);
    });

    it("keeps the start of the first deferral when more requests follow", () => {
      const { clock, gaveUp, controller } = setup();
      controller.arm("video", true);
      clock.advance(WAIT - 1000);
      controller.arm("video", true);
      clock.advance(1000);
      expect(gaveUp).toStrictEqual(["video"]);
    });

    it("ends without a result when disarmed", () => {
      const { clock, gaveUp, controller } = setup();
      controller.arm("video", true);
      clock.advance(WAIT - 1);
      controller.disarm();
      clock.advance(WAIT * 2);
      expect(gaveUp).toStrictEqual([]);
      expect(clock.pendingCount).toBe(0);
    });

    it("starts a whole wait for a deferral after a disarm", () => {
      const { clock, gaveUp, controller } = setup();
      controller.arm("video", true);
      clock.advance(WAIT - 1000);
      controller.disarm();
      controller.arm("video", true);
      clock.advance(WAIT - 1);
      expect(gaveUp).toStrictEqual([]);
      clock.advance(1);
      expect(gaveUp).toStrictEqual(["video"]);
    });

    it("counts only visible time, and starts a whole wait at each return to visible", () => {
      const { clock, gaveUp, controller } = setup();
      controller.arm("video", false);
      clock.advance(WAIT * 10);
      expect(gaveUp).toStrictEqual([]);

      controller.visibility(true);
      clock.advance(WAIT - 1000);
      controller.visibility(false);
      clock.advance(WAIT * 10);
      expect(gaveUp).toStrictEqual([]);

      controller.visibility(true);
      clock.advance(WAIT - 1);
      expect(gaveUp).toStrictEqual([]);
      clock.advance(1);
      expect(gaveUp).toStrictEqual(["video"]);
    });

    it("starts again for a new element", () => {
      const { clock, gaveUp, controller } = setup();
      controller.arm("first", true);
      clock.advance(WAIT - 1000);
      controller.arm("second", true);
      clock.advance(1000);
      expect(gaveUp).toStrictEqual([]);
      clock.advance(WAIT - 1000);
      expect(gaveUp).toStrictEqual(["second"]);
    });
  });

  // The pane follows the store with followDeferredNavigation, and it reports the end of the
  // wait with reportAnchorWaitExpired.
  describe("with the playback store", () => {
    const source: PlaybackSource = {
      path: "/media/late-frame.mp4",
      size: 1024,
      mtime: 1_724_976_000,
      videoTimeBase: { n: 1, d: 25 },
      videoStartPts: "0" as Pts,
      approximateDurationSeconds: 10,
      avgFrameRate: { n: 25, d: 1 },
      rFrameRate: { n: 25, d: 1 },
    };
    const key = getSourceRevisionKey(source);

    function setup({ visible = true, active = true } = {}) {
      const clock = createFakeClock();
      const store = createPlaybackStore();
      let sets = 0;
      let time = 0;
      const element: PlaybackMediaElement & { readonly sets: number } = {
        readyState: 1,
        seeking: false,
        get currentTime() {
          return time;
        },
        set currentTime(value: number) {
          time = value;
          sets++;
        },
        get sets() {
          return sets;
        },
        play: () => Promise.resolve(),
        pause: () => {},
      };
      const controller = createAnchorWaitController<PlaybackMediaElement>(
        clock.timers,
        (from) => {
          reportAnchorWaitExpired(store, from, () => active);
        },
      );
      store.getState().attach(source, element);
      store.getState().syncReady(key, element);
      const stopFollowing = followDeferredNavigation(
        store,
        controller,
        () => element,
        () => visible,
      );
      return { clock, store, element, controller, stopFollowing };
    }

    it("never gives up while nothing is deferred, so a late first frame still anchors", () => {
      const { clock, store, element } = setup();
      clock.advance(WAIT * 100);
      expect(store.getState().calibrationStatus).toBe("calibrating");
      expect(clock.pendingCount).toBe(0);

      store.getState().syncPresentedFrame(key, 0, 1, element);
      expect(store.getState().calibrationStatus).toBe("ready");
    });

    it("arms at the first deferral, and the give-up runs it on the approximate path", () => {
      const { clock, store, element } = setup();
      clock.advance(WAIT * 10);
      store.getState().seekNominal(1);
      expect(store.getState().hasDeferredNavigation).toBe(true);
      expect(clock.pendingCount).toBe(1);

      clock.advance(WAIT - 1);
      expect(store.getState().calibrationStatus).toBe("calibrating");
      clock.advance(1);
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().hasDeferredNavigation).toBe(false);
      expect(element.sets).toBe(1);
      expect(element.currentTime).toBeCloseTo(0.04, 9);
      expect(clock.pendingCount).toBe(0);
    });

    it("disarms when play drops the deferral, and the playback can still take the anchor", () => {
      const { clock, store, element } = setup();
      store.getState().seekNominal(1);
      clock.advance(WAIT - 1000);

      store.getState().play();
      expect(store.getState().hasDeferredNavigation).toBe(false);
      expect(clock.pendingCount).toBe(0);
      clock.advance(WAIT * 10);
      expect(store.getState().calibrationStatus).toBe("calibrating");

      store.getState().syncPresentedFrame(key, 0, 1, element);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(element.sets).toBe(0);
    });

    it.each([
      [
        "the element starts to play on its own",
        (
          store: ReturnType<typeof createPlaybackStore>,
          element: PlaybackMediaElement,
        ) => store.getState().syncPlay(key, element),
      ],
      [
        "a loss of readiness",
        (
          store: ReturnType<typeof createPlaybackStore>,
          element: PlaybackMediaElement,
        ) => store.getState().syncUnready(key, element),
      ],
      [
        "a detach",
        (
          store: ReturnType<typeof createPlaybackStore>,
          element: PlaybackMediaElement,
        ) => store.getState().detach(key, element),
      ],
      [
        "a reset",
        (store: ReturnType<typeof createPlaybackStore>) => store.getState().reset(),
      ],
      [
        "a new attach",
        (store: ReturnType<typeof createPlaybackStore>) =>
          store.getState().attach(
            { ...source, path: "/media/other.mp4" },
            {
              currentTime: 0,
              play: () => Promise.resolve(),
              pause: () => {},
            },
          ),
      ],
      [
        "a refused first callback",
        // A first callback with no usable time ends the calibration, and the deferral runs
        // on the approximate path.
        (
          store: ReturnType<typeof createPlaybackStore>,
          element: PlaybackMediaElement,
        ) => store.getState().syncPresentedFrame(key, Number.NaN, 1, element),
      ],
      [
        "a failed seek",
        (store: ReturnType<typeof createPlaybackStore>) =>
          store.getState().seekToPts("+5" as Pts),
      ],
    ])("disarms when %s drops the deferral", (_name, drop) => {
      const { clock, store, element } = setup();
      store.getState().seekNominal(1);
      expect(clock.pendingCount).toBe(1);

      drop(store, element);
      expect(store.getState().hasDeferredNavigation).toBe(false);
      expect(clock.pendingCount).toBe(0);
    });

    it("disarms when the anchor runs the deferral", () => {
      const { clock, store, element } = setup();
      store.getState().seekNominal(1);
      clock.advance(WAIT - 1);

      store.getState().syncPresentedFrame(key, 0, 1, element);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(clock.pendingCount).toBe(0);
      clock.advance(WAIT * 2);
      expect(store.getState().calibrationStatus).toBe("ready");
      // The step ran on the frame grid, to the middle of frame 1
      expect(element.currentTime).toBeCloseTo(0.06, 9);
    });

    it("starts a whole new wait for a deferral after a dropped one", () => {
      const { clock, store } = setup();
      store.getState().seekNominal(1);
      clock.advance(WAIT - 1000);
      store.getState().play();

      // A step during the playback pauses it and defers again
      store.getState().seekNominal(1);
      clock.advance(WAIT - 1);
      expect(store.getState().calibrationStatus).toBe("calibrating");
      clock.advance(1);
      expect(store.getState().calibrationStatus).toBe("unavailable");
    });

    it("holds the wait while the document is hidden", () => {
      const { clock, store } = setup({ visible: false });
      store.getState().seekNominal(1);
      clock.advance(WAIT * 10);
      expect(store.getState().calibrationStatus).toBe("calibrating");
    });

    it("reports nothing for a source that is no longer the active one", () => {
      const { clock, store } = setup({ active: false });
      store.getState().seekNominal(1);
      clock.advance(WAIT);
      expect(store.getState().calibrationStatus).toBe("calibrating");
    });

    it("stops following when the pane unmounts", () => {
      const { clock, store, controller, stopFollowing } = setup();
      stopFollowing();
      controller.disarm();
      store.getState().seekNominal(1);
      expect(clock.pendingCount).toBe(0);
    });
  });
});
