import { describe, expect, it } from "vitest";
import type { ImportMediaResult } from "@/features/media/types";
import { getSourceRevisionKey } from "@/features/media/sourceIdentity";
import { createPlaybackStore, type PlaybackSource } from "@/features/playback";
import { createSequencePlayback } from "@/features/sequence/playback";
import { createTimelineStore } from "@/features/timeline/store";
import type { SequenceSource } from "@/features/timeline/sequence";
import { toVirtualPts } from "@/features/timeline/virtualTime";
import type { Clip, Pts, TickCount } from "@/types/project";
import { dispatchEndedEvent, dispatchPauseEvent } from "./pauseEndedEvents";

/**
 * The `pause` and `ended` events of the preview element through both dispatch functions, the
 * real playback store and the real sequence playback (ADR 052, ADR 074). The calls follow the
 * handlers of the preview pane.
 */

/** A 25 fps source of 10 s whose PTS counts frames, at a path of its own. */
function source(path: string): {
  media: ImportMediaResult;
  playback: PlaybackSource;
  facts: SequenceSource;
} {
  const probe = {
    videoTimeBase: { n: 1, d: 25 },
    videoStartPts: "0" as Pts,
    videoEndPts: "250" as Pts,
    videoDurationTicks: "250" as TickCount,
    approximateDurationSeconds: 10,
    avgFrameRate: { n: 25, d: 1 },
    rFrameRate: { n: 25, d: 1 },
    reportedFrameCount: null,
  };
  const media = {
    path,
    fileName: path.slice(1),
    size: 1024,
    mtime: 1_724_976_000,
    probe: {
      ...probe,
      width: 1920,
      height: 1080,
      sampleAspectRatio: null,
      rotation: 0,
      audio: null,
    },
  } as unknown as ImportMediaResult;
  return {
    media,
    playback: { path, size: 1024, mtime: 1_724_976_000, ...probe },
    facts: { id: path, ...probe },
  };
}

const A = source("/a.mp4");
const B = source("/b.mp4");
const a1: Clip = { id: "a1", sourceId: "/a.mp4" };
const b1: Clip = { id: "b1", sourceId: "/b.mp4" };

/** A media element whose `paused`, `ended` and `seeking` the test sets between the events. */
function createElement(duration = 10) {
  const element = {
    seeking: false,
    paused: true,
    ended: false,
    readyState: 1,
    duration,
    currentTime: 0,
    play: () => {
      element.paused = false;
      return Promise.resolve();
    },
    pause: () => {
      element.paused = true;
    },
  };
  return element;
}

/**
 * The sequence a1, b1, with the element of a1 attached and calibrated, and a play on a1: a plain
 * play, or with `segment` a Play Segment from 8 s of a1 to 2 s of b1, which crosses the junction.
 * The event functions call the stores as the handlers of the preview pane do.
 */
function playingOnFirstClip({ segment = false }: { segment?: boolean } = {}) {
  const playback = createPlaybackStore();
  const timeline = createTimelineStore();
  timeline.getState().insertClips(0, [a1, b1], [A.facts, B.facts]);
  timeline.getState().setAttachedClip("a1");
  const sequence = createSequencePlayback({
    playback,
    timeline,
    media: () => ({ "/a.mp4": A.media, "/b.mp4": B.media }),
  });
  const element = createElement();
  const key = getSourceRevisionKey(A.media);
  playback.getState().attach(A.playback, element);
  playback.getState().syncReady(key, element);
  playback.getState().syncPresentedFrame(key, 0, 1, element);
  const virtual = (clipId: string, value: string): Pts => {
    const axis = timeline.getState().virtual;
    const result = axis && toVirtualPts(axis, { clipId, pts: value as Pts });
    if (!result) throw new Error("virtual");
    return result;
  };
  if (segment) {
    sequence.store.getState().playSegment(virtual("a1", "200"), virtual("b1", "50"));
    expect(element.currentTime).toBe(8);
  } else {
    playback.getState().play();
  }
  playback.getState().syncPlay(key, element);
  expect(playback.getState().isPlaying).toBe(true);
  expect(element.paused).toBe(false);

  const events = {
    pause: () =>
      dispatchPauseEvent(element, {
        notePause: sequence.notePause,
        syncPause: () => playback.getState().syncPause(key, element),
      }),
    ended: () =>
      dispatchEndedEvent(element, {
        handleEnded: sequence.handleEnded,
        syncEnded: () => playback.getState().syncEnded(key, element),
        dropEnded: sequence.forgetPauseAtEnd,
      }),
    seeking: () => playback.getState().syncSeeking(key, element),
    seeked: () => {
      playback.getState().syncBrowserTime(key, element);
      playback.getState().syncSeeked(key, element);
    },
  };
  /** Attaches the element of b1 after a navigation to it, and lets its first frame calibrate. */
  const attachSecond = () => {
    const next = createElement();
    const nextKey = getSourceRevisionKey(B.media);
    playback.getState().attach(B.playback, next);
    playback.getState().syncReady(nextKey, next);
    playback.getState().syncPresentedFrame(nextKey, 0, 1, next);
    return next;
  };
  return { playback, timeline, element, key, events, attachSecond };
}

/** The element reaches the end of the media while it plays. */
function reachEnd(element: ReturnType<typeof createElement>): void {
  element.currentTime = 10;
  element.paused = true;
  element.ended = true;
}

/**
 * The scrub of the system in WebKit moves the element to its end while it plays: the element
 * reports `seeking`, `paused` and `ended` from the target of the seek.
 */
function scrubToEnd(element: ReturnType<typeof createElement>): void {
  element.currentTime = 10;
  element.seeking = true;
  element.paused = true;
  element.ended = true;
}

/** The scrub of the system to the end while it plays, to the `seeked` of its seek. */
function scrubToEndAndSettle(h: ReturnType<typeof playingOnFirstClip>): void {
  scrubToEnd(h.element);
  h.events.seeking();
  h.events.pause();
  h.element.seeking = false;
  h.events.seeked();
}

describe("the pause and ended events through both stores (ADR 074)", () => {
  it("goes on at the next clip at a real end", () => {
    const h = playingOnFirstClip();
    reachEnd(h.element);
    h.events.pause();
    h.events.ended();
    expect(h.timeline.getState().attachedClipId).toBe("b1");
  });

  it("stays on the clip, paused, after a scrub of the system to the end with no `ended` event", () => {
    const h = playingOnFirstClip();
    scrubToEnd(h.element);
    h.events.seeking();
    h.events.pause();
    h.element.seeking = false;
    h.events.seeked();
    expect(h.timeline.getState().attachedClipId).toBe("a1");
    expect(h.element.paused).toBe(true);
    expect(h.playback.getState().isPlaying).toBe(false);
  });

  it("stays on the clip, paused, when the `ended` event of the scrub comes after the seek", () => {
    const h = playingOnFirstClip();
    scrubToEnd(h.element);
    h.events.seeking();
    h.events.pause();
    h.element.seeking = false;
    h.events.seeked();
    // The element reports `ended` and no seek: the event passes to both stores.
    h.events.ended();
    expect(h.timeline.getState().attachedClipId).toBe("a1");
    expect(h.element.paused).toBe(true);
    expect(h.playback.getState().isPlaying).toBe(false);
  });

  it("drops an `ended` event of the scrub that comes while the seek runs", () => {
    const h = playingOnFirstClip();
    scrubToEnd(h.element);
    h.events.seeking();
    h.events.pause();
    h.events.ended();
    h.element.seeking = false;
    h.events.seeked();
    expect(h.timeline.getState().attachedClipId).toBe("a1");
    expect(h.element.paused).toBe(true);
    expect(h.playback.getState().isPlaying).toBe(false);
  });

  it("a limit of ADR 074: a real end that a seek of the system to the same end overlaps stays on the clip", () => {
    const h = playingOnFirstClip();
    // The element reaches its end, and both its `pause` and its `ended` event find a seek of the
    // system to that same end running. The end reads as a pause from outside.
    reachEnd(h.element);
    h.element.seeking = true;
    h.events.seeking();
    h.events.pause();
    h.events.ended();
    h.element.seeking = false;
    h.events.seeked();
    expect(h.timeline.getState().attachedClipId).toBe("a1");
    expect(h.element.paused).toBe(true);
    expect(h.playback.getState().isPlaying).toBe(false);
  });
});

describe("a Play Segment across a junction through both stores (ADR 052, ADR 074)", () => {
  it("goes on at b1 with the stop point at the Out when a1 really ends", () => {
    const h = playingOnFirstClip({ segment: true });
    reachEnd(h.element);
    h.events.pause();
    h.events.ended();
    expect(h.timeline.getState().attachedClipId).toBe("b1");
    const next = h.attachSecond();
    expect(next.paused).toBe(false);
    expect(h.playback.getState().playbackStop).toEqual({
      inPts: "0",
      outPts: "50",
      phase: "playing",
    });
  });

  /**
   * After an end with no playback, a later real play to the end of a1 goes on at b1 as a plain
   * play: the play intent of the segment is gone.
   */
  function expectPlainContinuation(h: ReturnType<typeof playingOnFirstClip>): void {
    h.playback.getState().seekToPts("200" as Pts);
    h.element.ended = false;
    h.events.seeked();
    h.playback.getState().play();
    h.playback.getState().syncPlay(h.key, h.element);
    reachEnd(h.element);
    h.events.pause();
    h.events.ended();
    expect(h.timeline.getState().attachedClipId).toBe("b1");
    const next = h.attachSecond();
    expect(next.paused).toBe(false);
    expect(h.playback.getState().playbackStop).toBeNull();
  }

  it("stays on a1, paused, at an `ended` event after a scrub of the system to its end", () => {
    const h = playingOnFirstClip({ segment: true });
    scrubToEndAndSettle(h);
    // The seek settled, and the element reports `ended` and no seek: the event is current, and
    // no pause at the end came before it.
    h.events.ended();
    expect(h.timeline.getState().attachedClipId).toBe("a1");
    expect(h.element.paused).toBe(true);
    expect(h.playback.getState().isPlaying).toBe(false);
    expectPlainContinuation(h);
  });

  it("stays on a1, paused, at that `ended` event after the preview dropped an earlier one", () => {
    const h = playingOnFirstClip({ segment: true });
    // A late `ended` event of an earlier end: the element is away from its end.
    h.events.ended();
    expect(h.timeline.getState().attachedClipId).toBe("a1");
    expect(h.playback.getState().isPlaying).toBe(true);
    scrubToEndAndSettle(h);
    h.events.ended();
    expect(h.timeline.getState().attachedClipId).toBe("a1");
    expect(h.element.paused).toBe(true);
    expect(h.playback.getState().isPlaying).toBe(false);
    expectPlainContinuation(h);
  });
});
