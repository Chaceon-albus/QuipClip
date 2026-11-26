import { describe, expect, it, vi } from "vitest";
import type { ScrubCue } from "@/features/playback/cue";
import type { PcmCue } from "@/features/playback/mse/pcmCue";
import type { Pts, Rational } from "@/types/project";
import {
  createNativeCueOwner,
  nativeMediaTimeOrigin,
  type NativeCueElement,
  type NativeCueTarget,
} from "./nativeCueOwner";

const TIME_BASE: Rational = { n: 1, d: 15360 };

const TARGET: NativeCueTarget = {
  sourceRevisionKey: "clip",
  source: {
    path: "/media/clip.mp4",
    size: 10,
    mtime: 1,
    formatStartTime: { n: 0, d: 1 },
    audioCodec: "aac",
    audioStreamIndex: 1,
  },
  originSeconds: 0.25,
};

/** A video element with the events that the owner uses. */
function fakeElement(currentTime = 134.775): NativeCueElement & {
  currentTime: number;
  fire: (type: "seeking" | "pause") => void;
  listenerCount: () => number;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    currentTime,
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    fire: (type) => {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    },
    listenerCount: () =>
      [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

function fakeCue(): PcmCue {
  return {
    request: vi.fn(),
    stop: vi.fn(),
    addPcm: vi.fn(),
    endPcm: vi.fn(),
    ensure: vi.fn(),
    prime: vi.fn(),
    setGain: vi.fn(),
    destroy: vi.fn(),
  };
}

function setup() {
  const cues: { cue: PcmCue; target: NativeCueTarget; gain: number }[] = [];
  const routed: (ScrubCue | null)[] = [];
  const cleared: ScrubCue[] = [];
  const gestures: (() => void)[] = [];
  const stopGestures = vi.fn();
  const owner = createNativeCueOwner({
    createCue: (target, gain) => {
      const cue = fakeCue();
      cues.push({ cue, target, gain });
      return cue;
    },
    setScrubCue: (cue) => {
      routed.push(cue);
    },
    clearScrubCue: (cue) => {
      cleared.push(cue);
    },
    listenForGestures: (callback) => {
      gestures.push(callback);
      return stopGestures;
    },
  });
  return { owner, cues, routed, cleared, gestures, stopGestures };
}

describe("nativeMediaTimeOrigin (ADR 062)", () => {
  it("is the source time of videoStartPts less the media time of the anchor", () => {
    // videoStartPts 1024 is 1/15 s, and the first frame showed at media time 0.05.
    expect(nativeMediaTimeOrigin(0.05, "1024" as Pts, TIME_BASE)).toBeCloseTo(
      1024 / 15360 - 0.05,
      12,
    );
    expect(nativeMediaTimeOrigin(0, "0" as Pts, TIME_BASE)).toBe(0);
  });

  it("is null without an anchor, a valid start PTS or a valid time base", () => {
    expect(nativeMediaTimeOrigin(null, "1024" as Pts, TIME_BASE)).toBeNull();
    expect(nativeMediaTimeOrigin(Number.NaN, "1024" as Pts, TIME_BASE)).toBeNull();
    expect(nativeMediaTimeOrigin(0.05, null, TIME_BASE)).toBeNull();
    expect(nativeMediaTimeOrigin(0.05, "0" as Pts, { n: 0, d: 1 })).toBeNull();
  });
});

describe("the owner of the Web Audio cue of a native source (ADR 062)", () => {
  it("installs the cue and asks for the PCM of the position at once", () => {
    const { owner, cues, routed } = setup();
    const element = fakeElement();

    owner.attach(element, TARGET, 0.5);

    expect(cues).toHaveLength(1);
    expect(cues[0]?.target).toBe(TARGET);
    expect(cues[0]?.gain).toBe(0.5);
    expect(routed).toEqual([cues[0]?.cue]);
    expect(cues[0]?.cue.ensure).toHaveBeenCalledWith(134.775);
  });

  it("asks for the PCM at each seek and each pause", () => {
    const { owner, cues } = setup();
    const element = fakeElement();
    owner.attach(element, TARGET, 1);
    const ensure = vi.mocked(cues[0]?.cue.ensure);
    ensure?.mockClear();

    element.currentTime = 300.5;
    element.fire("seeking");
    element.currentTime = 310;
    element.fire("pause");
    element.currentTime = Number.NaN;
    element.fire("seeking");

    expect(ensure?.mock.calls).toEqual([[300.5], [310]]);
  });

  it("starts the AudioContext of the cue at a gesture", () => {
    const { owner, cues, gestures } = setup();
    owner.attach(fakeElement(), TARGET, 1);

    gestures[0]?.();
    expect(cues[0]?.cue.prime).toHaveBeenCalledTimes(1);
  });

  it("keeps the cue that runs for a second call with the same element and source", () => {
    const { owner, cues } = setup();
    const element = fakeElement();
    owner.attach(element, TARGET, 1);

    owner.attach(element, { ...TARGET, originSeconds: 0.2500001 }, 1);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.cue.destroy).not.toHaveBeenCalled();
  });

  it("replaces the cue of the same element for another audio stream (ADR 070)", () => {
    const { owner, cues, cleared, routed } = setup();
    const element = fakeElement();
    owner.attach(element, TARGET, 1);
    expect(owner.held()).toEqual({ sourceRevisionKey: "clip", audioStreamIndex: 1 });

    const second = { ...TARGET, source: { ...TARGET.source, audioStreamIndex: 3 } };
    owner.attach(element, second, 1);

    // The old cue goes with its PCM, and a fresh cue reads the windows of stream 3.
    expect(cues).toHaveLength(2);
    expect(cues[0]?.cue.destroy).toHaveBeenCalledTimes(1);
    expect(cleared).toEqual([cues[0]?.cue]);
    expect(cues[1]?.target.source.audioStreamIndex).toBe(3);
    expect(routed).toEqual([cues[0]?.cue, cues[1]?.cue]);
    expect(cues[1]?.cue.ensure).toHaveBeenCalledWith(134.775);
    // The element keeps one listener of each kind.
    expect(element.listenerCount()).toBe(2);
    expect(owner.held()).toEqual({ sourceRevisionKey: "clip", audioStreamIndex: 3 });

    // The same stream again keeps the new cue.
    owner.attach(element, second, 1);
    expect(cues).toHaveLength(2);

    owner.detach(element);
    expect(owner.held()).toBeNull();
  });

  it("stops the previous cue when a new element attaches", () => {
    const { owner, cues, cleared, stopGestures, routed } = setup();
    const first = fakeElement();
    const second = fakeElement(10);
    owner.attach(first, TARGET, 1);

    owner.attach(second, { ...TARGET, sourceRevisionKey: "other" }, 1);

    expect(cues).toHaveLength(2);
    expect(cues[0]?.cue.destroy).toHaveBeenCalledTimes(1);
    expect(cleared).toEqual([cues[0]?.cue]);
    expect(stopGestures).toHaveBeenCalledTimes(1);
    expect(first.listenerCount()).toBe(0);
    expect(routed).toEqual([cues[0]?.cue, cues[1]?.cue]);
    expect(cues[1]?.cue.ensure).toHaveBeenCalledWith(10);
  });

  it("detaches only the element that it holds, and clears the router only for its cue", () => {
    const { owner, cues, cleared } = setup();
    const element = fakeElement();
    owner.attach(element, TARGET, 1);

    owner.detach(fakeElement());
    expect(cues[0]?.cue.destroy).not.toHaveBeenCalled();

    owner.detach(element);
    expect(cues[0]?.cue.destroy).toHaveBeenCalledTimes(1);
    expect(cleared).toEqual([cues[0]?.cue]);
    expect(element.listenerCount()).toBe(0);

    // A pause after the detach asks for nothing.
    element.fire("pause");
    expect(cues[0]?.cue.ensure).toHaveBeenCalledTimes(1);
    owner.detach(element);
    expect(cues[0]?.cue.destroy).toHaveBeenCalledTimes(1);
  });

  it("passes the gain to the cue that it holds", () => {
    const { owner, cues } = setup();
    owner.setGain(0.3);
    owner.attach(fakeElement(), TARGET, 1);

    owner.setGain(0);
    expect(cues[0]?.cue.setGain).toHaveBeenCalledWith(0);
  });
});
