import { describe, expect, it, vi } from "vitest";
import { getSourceRevisionKey } from "@/features/media";
import { createPlaybackStore, type PlaybackSource } from "@/features/playback";
import type { ScrubCue } from "@/features/playback/cue";
import type {
  MseControllerEvents,
  MseSource,
  MseVideoElement,
} from "@/features/playback/mse/controller";
import type { PcmCue } from "@/features/playback/mse/pcmCue";
import type { Pts } from "@/types/project";
import {
  createMediaSourceOwner,
  createMediaSourceStoreActions,
  type MediaSourceTarget,
} from "./mediaSourceOwner";

const SOURCE: MseSource = {
  path: "/media/live.flv",
  size: 10,
  mtime: 1,
  container: "flv",
  formatStartTime: null,
  videoStartSeconds: 1234.567,
  durationSeconds: 240,
  audio: "copy",
  audioCodec: "aac",
  pcm: true,
  rescanConfig: false,
};

const TARGET: MediaSourceTarget = {
  sourceRevisionKey: "live",
  source: SOURCE,
  hasAudio: true,
};

/** A video element with the events that the owner and the controller use. */
function fakeElement(): HTMLVideoElement & { fire: (type: string) => void } {
  const listeners = new Map<string, Set<() => void>>();
  const element = {
    currentTime: 0,
    addEventListener: (type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    fire: (type: string) => {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    },
  };
  return element as unknown as HTMLVideoElement & { fire: (type: string) => void };
}

function fakeCue(): PcmCue & { added: unknown[][] } {
  const added: unknown[][] = [];
  return {
    added,
    request: vi.fn(),
    stop: vi.fn(),
    addPcm: (...args: unknown[]) => {
      added.push(args);
    },
    endPcm: vi.fn(),
    ensure: vi.fn(),
    prime: vi.fn(),
    setMuted: vi.fn(),
    destroy: vi.fn(),
  };
}

function setup(repairsLateSeeks = true) {
  const controllers: {
    element: MseVideoElement;
    source: MseSource;
    events: MseControllerEvents;
    destroy: ReturnType<typeof vi.fn>;
  }[] = [];
  const cues: ReturnType<typeof fakeCue>[] = [];
  const installed: (ScrubCue | null)[] = [];
  let ready = true;
  const waiting: (() => void)[] = [];
  const store = {
    syncExpectedFirstFrame: vi.fn(),
    syncPresentationUnavailable: vi.fn(),
    denySourcePrecision: vi.fn(),
    seekOverGap: vi.fn(),
    repairSeek: vi.fn(),
    whenReady: (run: () => void) => {
      if (ready) {
        run();
        return () => undefined;
      }
      waiting.push(run);
      return () => {
        const index = waiting.indexOf(run);
        if (index >= 0) {
          waiting.splice(index, 1);
        }
      };
    },
  };
  const pane = {
    onNonMonotonic: vi.fn(),
    onAudioOmitted: vi.fn(),
    onFailure: vi.fn(),
  };
  const warn = vi.fn();
  const gestures = new Set<() => void>();
  const owner = createMediaSourceOwner({
    createController: (element, source, events) => {
      const destroy = vi.fn();
      controllers.push({ element, source, events, destroy });
      return { destroy };
    },
    createCue: (source, muted) => {
      void source;
      const cue = fakeCue();
      if (muted) {
        cue.setMuted(true);
      }
      cues.push(cue);
      return cue;
    },
    setScrubCue: (cue) => installed.push(cue),
    listenForGestures: (callback) => {
      gestures.add(callback);
      return () => gestures.delete(callback);
    },
    store,
    pane,
    repairsLateSeeks,
    warn,
  });
  return {
    owner,
    controllers,
    cues,
    installed,
    gesture: () => {
      for (const callback of [...gestures]) {
        callback();
      }
    },
    gestureCount: () => gestures.size,
    store,
    pane,
    warn,
    setReady: (value: boolean) => {
      ready = value;
      if (value) {
        for (const run of waiting.splice(0)) {
          run();
        }
      }
    },
  };
}

describe("createMediaSourceOwner", () => {
  it("starts the controller and installs the cue of the element", () => {
    const { owner, controllers, cues, installed } = setup();
    const element = fakeElement();
    owner.attach(element, TARGET, false);
    expect(controllers).toHaveLength(1);
    expect(controllers[0]?.element).toBe(element);
    expect(controllers[0]?.source).toBe(SOURCE);
    expect(installed).toEqual([cues[0]]);
    expect(owner.element()).toBe(element);

    owner.attach(element, TARGET, false);
    expect(controllers).toHaveLength(1);
  });

  it("starts no cue for a source without audio or with its audio left out", () => {
    const { owner, cues, installed } = setup();
    owner.attach(fakeElement(), { ...TARGET, hasAudio: false }, false);
    owner.attach(
      fakeElement(),
      { ...TARGET, source: { ...SOURCE, audio: "omit" } },
      false,
    );
    expect(cues).toHaveLength(0);
    expect(installed).toEqual([]);
  });

  it("repairs a late seek 100 ms after its seeked, or after a second without one", () => {
    vi.useFakeTimers();
    try {
      const { owner, controllers, store } = setup();
      const element = Object.assign(fakeElement(), { seeking: true });
      owner.attach(element, TARGET, false);
      controllers[0]?.events.onSeekDataArrived?.(64.533, true);
      vi.advanceTimersByTime(500);
      element.seeking = false;
      element.fire("seeked");
      vi.advanceTimersByTime(99);
      expect(store.repairSeek).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(store.repairSeek).toHaveBeenCalledWith("live", element, 64.533, true);
      element.fire("seeked");
      vi.advanceTimersByTime(2000);
      expect(store.repairSeek).toHaveBeenCalledTimes(1);

      // A seek that never ends gets the repair after a second.
      element.seeking = true;
      controllers[0]?.events.onSeekDataArrived?.(10, false);
      vi.advanceTimersByTime(999);
      expect(store.repairSeek).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(store.repairSeek).toHaveBeenLastCalledWith("live", element, 10, false);

      // A seek that already ended gets it after 100 ms.
      element.seeking = false;
      controllers[0]?.events.onSeekDataArrived?.(12, true);
      vi.advanceTimersByTime(100);
      expect(store.repairSeek).toHaveBeenLastCalledWith("live", element, 12, true);

      // Another web view lands right, and a released element gets none.
      const other = setup(false);
      other.owner.attach(fakeElement(), TARGET, false);
      other.controllers[0]?.events.onSeekDataArrived?.(64.533, true);
      vi.advanceTimersByTime(2000);
      expect(other.store.repairSeek).not.toHaveBeenCalled();
      controllers[0]?.events.onSeekDataArrived?.(20, true);
      owner.detach(element);
      vi.advanceTimersByTime(2000);
      expect(store.repairSeek).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("connects the reports to the store and the pane", () => {
    const { owner, controllers, cues, store, pane, warn } = setup();
    const element = fakeElement();
    owner.attach(element, TARGET, false);
    const events = controllers[0]?.events;
    events?.onExpectedFirstFrame(0.08);
    expect(store.syncExpectedFirstFrame).toHaveBeenCalledWith("live", element, 0.08);
    events?.onFirstFrameMismatch("the tag is at 1 ms");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(store.syncPresentationUnavailable).toHaveBeenCalledWith("live", element);
    events?.onNonMonotonic();
    expect(store.denySourcePrecision).toHaveBeenCalledWith("live", element);
    expect(pane.onNonMonotonic).toHaveBeenCalledWith("live");
    events?.onAudioOmitted();
    expect(pane.onAudioOmitted).toHaveBeenCalledWith("live");
    events?.onFailure({ kind: "ffmpegMissing" });
    expect(pane.onFailure).toHaveBeenCalledWith("live", element, {
      kind: "ffmpegMissing",
    });
    const bytes = new Uint8Array([1, 2]);
    events?.onPcm?.(3, 1234.5, bytes);
    expect(cues[0]?.added).toEqual([[3, 1234.5, bytes]]);
    const end = {
      status: "failed" as const,
      reachedEnd: false,
      next: null,
      bytesRead: 0,
      nonMonotonic: false,
      damaged: false,
      detail: "Decoder not found",
    };
    events?.onPcmEnd?.(end);
    expect(cues[0]?.endPcm).toHaveBeenCalledWith(end);
  });

  it("seeks over a gap once the store is ready", () => {
    const { owner, controllers, store, setReady } = setup();
    setReady(false);
    owner.attach(fakeElement(), TARGET, false);
    controllers[0]?.events.onStartGap(0.08);
    expect(store.seekOverGap).not.toHaveBeenCalled();
    setReady(true);
    expect(store.seekOverGap).toHaveBeenCalledWith(0.08);
  });

  it("drops a gap seek when another seek took the element out of the gap", () => {
    const { owner, controllers, store, setReady } = setup();
    setReady(false);
    const element = fakeElement();
    owner.attach(element, TARGET, false);
    controllers[0]?.events.onStartGap(0.08);
    // The seek of a reload ran first.
    element.currentTime = 120;
    setReady(true);
    expect(store.seekOverGap).not.toHaveBeenCalled();
  });

  it("drops a gap seek that waits when the element leaves", () => {
    const { owner, controllers, store, setReady } = setup();
    setReady(false);
    const element = fakeElement();
    owner.attach(element, TARGET, false);
    controllers[0]?.events.onStartGap(0.08);
    owner.detach(element);
    setReady(true);
    expect(store.seekOverGap).not.toHaveBeenCalled();
  });

  it("stops everything when the element leaves, and ignores the reports of a stopped one", () => {
    const { owner, controllers, cues, installed, store } = setup();
    const element = fakeElement();
    owner.attach(element, TARGET, false);
    owner.detach(fakeElement());
    expect(controllers[0]?.destroy).not.toHaveBeenCalled();

    owner.detach(element);
    expect(controllers[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(cues[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(installed).toEqual([cues[0], null]);
    expect(owner.element()).toBeNull();
    controllers[0]?.events.onExpectedFirstFrame(0.08);
    expect(store.syncExpectedFirstFrame).not.toHaveBeenCalled();
  });

  it("stops the previous element when another one attaches", () => {
    const { owner, controllers } = setup();
    owner.attach(fakeElement(), TARGET, false);
    owner.attach(fakeElement(), TARGET, false);
    expect(controllers[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(controllers).toHaveLength(2);
  });

  it("asks for the PCM at each seek target on MPEG-TS and Matroska only", () => {
    const { owner, cues } = setup();
    const ts = fakeElement();
    owner.attach(ts, { ...TARGET, source: { ...SOURCE, container: "mpegTs" } }, false);
    ts.currentTime = 42;
    ts.fire("seeking");
    expect(cues[0]?.ensure).toHaveBeenCalledWith(42);
    owner.detach(ts);
    ts.fire("seeking");
    expect(cues[0]?.ensure).toHaveBeenCalledTimes(1);

    const flv = fakeElement();
    owner.attach(flv, TARGET, false);
    flv.fire("seeking");
    expect(cues[1]?.ensure).not.toHaveBeenCalled();
  });

  it("starts the AudioContext of the cue at each gesture while the cue is installed", () => {
    const { owner, cues, gesture, gestureCount } = setup();
    const element = fakeElement();
    owner.attach(element, TARGET, false);
    gesture();
    expect(cues[0]?.prime).toHaveBeenCalledTimes(1);
    owner.detach(element);
    expect(gestureCount()).toBe(0);

    owner.attach(fakeElement(), { ...TARGET, hasAudio: false }, false);
    expect(gestureCount()).toBe(0);
  });

  it("passes the mute state to the cue", () => {
    const { owner, cues } = setup();
    owner.attach(fakeElement(), TARGET, true);
    expect(cues[0]?.setMuted).toHaveBeenCalledWith(true);
    owner.setMuted(false);
    expect(cues[0]?.setMuted).toHaveBeenLastCalledWith(false);
  });
});

describe("the seek over the start gap, with the playback store", () => {
  const FLV: PlaybackSource = {
    path: SOURCE.path,
    size: SOURCE.size,
    mtime: SOURCE.mtime,
    videoTimeBase: { n: 1, d: 1000 },
    videoStartPts: "1234567" as Pts,
    avgFrameRate: { n: 25, d: 1 },
    rFrameRate: { n: 25, d: 1 },
    approximateDurationSeconds: 240,
    mediaSource: true,
    anchorMediaTime: 0,
  };
  const key = getSourceRevisionKey(FLV);

  /** An element for the owner and for the store. */
  function element() {
    return Object.assign(fakeElement(), {
      readyState: 0,
      seeking: false,
      paused: true,
      ended: false,
      duration: 240,
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
    });
  }

  function setupWithStore() {
    const store = createPlaybackStore();
    const controllers: MseControllerEvents[] = [];
    const owner = createMediaSourceOwner({
      createController: (_element, _source, events) => {
        controllers.push(events);
        return { destroy: vi.fn() };
      },
      createCue: () => fakeCue(),
      setScrubCue: vi.fn(),
      listenForGestures: () => () => undefined,
      store: createMediaSourceStoreActions(store),
      pane: { onNonMonotonic: vi.fn(), onAudioOmitted: vi.fn(), onFailure: vi.fn() },
      repairsLateSeeks: true,
      warn: vi.fn(),
    });
    const target = { ...TARGET, sourceRevisionKey: key };
    return { store, owner, controllers, target };
  }

  it("runs after the metadata when the gap shows before it", async () => {
    const { store, owner, controllers, target } = setupWithStore();
    const video = element();
    store.getState().attach(FLV, video);
    owner.attach(video, target, false);
    controllers[0]?.onStartGap(0.08);
    expect(video.currentTime).toBe(0);

    video.readyState = 1;
    store.getState().syncReady(key, video);
    await Promise.resolve();
    expect(video.currentTime).toBeCloseTo(0.08, 6);
  });

  it("leaves the seek of a reload after a stall to its target", async () => {
    const { store, owner, controllers, target } = setupWithStore();
    const stalled = element();
    store.getState().attach(FLV, stalled);
    stalled.readyState = 1;
    store.getState().syncReady(key, stalled);
    store.getState().syncPresentedFrame(key, 0, 1, stalled);
    store.getState().play();
    stalled.currentTime = 10;
    store.getState().syncBrowserTime(key, stalled);
    expect(store.getState().syncDecodeStall(key, stalled)).toBe(true);
    // The user seeks to 5 s, which reloads the preview.
    store.getState().seekToPts("1239567" as Pts);
    store.getState().detach(key, stalled);

    // The new controller loads the start of the file and reports its gap before the metadata
    // of the new element. The metadata then runs the seek of the reload at once.
    const next = element();
    store.getState().attach(FLV, next);
    owner.attach(next, target, false);
    controllers[0]?.onStartGap(0.08);
    next.readyState = 1;
    store.getState().syncReady(key, next);
    expect(next.currentTime).toBe(5);
    await Promise.resolve();
    expect(next.currentTime).toBe(5);
  });
});
