import { describe, expect, it } from "vitest";
import type { ImportMediaResult } from "@/features/media/types";
import { getSourceRevisionKey } from "@/features/media/sourceIdentity";
import { createPlaybackStore, type PlaybackSource } from "@/features/playback";
import { createTimelineStore } from "@/features/timeline/store";
import type { SequenceSource } from "@/features/timeline/sequence";
import { toVirtualPts } from "@/features/timeline/virtualTime";
import type { Clip, Pts, TickCount } from "@/types/project";
import { createSequencePlayback } from "./playback";

const pts = (value: string) => value as Pts;
const ticks = (value: string) => value as TickCount;

/** A 25 fps source of 10 s whose PTS counts frames, at a path of its own. */
function source(path: string): {
  media: ImportMediaResult;
  playback: PlaybackSource;
  facts: SequenceSource;
} {
  const probe = {
    videoTimeBase: { n: 1, d: 25 },
    videoStartPts: pts("0"),
    videoEndPts: pts("250"),
    videoDurationTicks: ticks("250"),
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

function createFakeElement(duration = 10) {
  let time = 0;
  const element = {
    seeking: false,
    readyState: 1,
    duration,
    paused: true,
    get currentTime() {
      return time;
    },
    set currentTime(value: number) {
      time = Math.min(value, duration);
      element.seeking = true;
    },
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

const A = source("/a.mp4");
const B = source("/b.mp4");
const a1: Clip = { id: "a1", sourceId: "/a.mp4" };
const b1: Clip = { id: "b1", sourceId: "/b.mp4" };

/** The playback store attached to `which`, calibrated on PTS 0, with a frame on screen. */
function attach(playback: ReturnType<typeof createPlaybackStore>, which: typeof A) {
  const element = createFakeElement();
  const key = getSourceRevisionKey(which.media);
  playback.getState().attach(which.playback, element);
  playback.getState().syncReady(key, element);
  playback.getState().syncPresentedFrame(key, 0, 1, element);
  return { element, key };
}

function harness(clips: readonly Clip[]) {
  const playback = createPlaybackStore();
  const timeline = createTimelineStore();
  timeline.getState().insertClips(
    0,
    clips,
    clips.map((clip) => (clip.sourceId === "/a.mp4" ? A.facts : B.facts)),
  );
  timeline.getState().setAttachedClip(clips[0]?.id ?? null);
  const sequence = createSequencePlayback({
    playback,
    timeline,
    media: () => ({ "/a.mp4": A.media, "/b.mp4": B.media }),
  });
  const virtual = (clipId: string, value: string): Pts => {
    const axis = timeline.getState().virtual;
    const result = axis && toVirtualPts(axis, { clipId, pts: pts(value) });
    if (!result) throw new Error("virtual");
    return result;
  };
  return { playback, timeline, sequence, virtual };
}

describe("sequence playback", () => {
  it("passes every value through with one clip", () => {
    const h = harness([a1]);
    attach(h.playback, A);
    const real = h.playback.getState();
    const mapped = h.sequence.store.getState();
    expect(mapped.presentedFrame).toEqual(real.presentedFrame);
    expect(mapped.attachedSourceRevisionKey).toBe(real.attachedSourceRevisionKey);
    expect(mapped.seekTargetSeconds).toBe(real.seekTargetSeconds);
  });

  it("does not notify for a write of the timeline that changes no playback value", () => {
    const h = harness([a1]);
    attach(h.playback, A);
    let notified = 0;
    h.sequence.store.subscribe(() => {
      notified += 1;
    });
    h.timeline.getState().markIn(pts("10"));
    h.timeline.getState().markOut(pts("20"));
    expect(h.timeline.getState().segments).toHaveLength(1);
    expect(notified).toBe(0);
  });

  it("maps the frame of the attached clip onto the virtual axis", () => {
    const h = harness([a1, b1]);
    h.timeline.getState().setAttachedClip("b1");
    const { element, key } = attach(h.playback, B);
    h.playback.getState().syncPresentedFrame(key, 2, 2, element);
    const frame = h.sequence.store.getState().presentedFrame;
    expect(frame?.inferredSourcePts).toBe(h.virtual("b1", "50"));
    // The sequence key stands for the source, so an attach of another clip is no new source.
    expect(h.sequence.store.getState().attachedSourceRevisionKey).toBe(
      h.timeline.getState().sourceRevisionKey,
    );
  });

  it("attaches another clip for a seek on it and seeks after the attach", () => {
    const h = harness([a1, b1]);
    attach(h.playback, A);
    h.sequence.store.getState().seekToPts(h.virtual("b1", "25"));
    expect(h.timeline.getState().attachedClipId).toBe("b1");
    // The playback store still shows the source of a1, and nothing seeked there.
    expect(h.playback.getState().seekTargetSeconds).toBeNull();

    const { key } = attach(h.playback, B);
    expect(h.playback.getState().attachedSourceRevisionKey).toBe(key);
    expect(h.playback.getState().seekTargetSeconds).toBe(1);
    // On the virtual axis, 1 s into b1 is 11 s into the sequence.
    expect(h.sequence.store.getState().seekTargetSeconds).toBe(11);
  });

  it("reports a cold switch until the new clip is calibrated, and keeps the transport off", () => {
    const h = harness([a1, b1]);
    attach(h.playback, A);
    expect(h.sequence.store.getState().switching).toBe(false);
    h.sequence.store.getState().seekToPts(h.virtual("b1", "25"));
    expect(h.sequence.store.getState().switching).toBe(true);
    // The transport sees the real readiness, so Play and a frame step stay as they are.
    const element = createFakeElement();
    element.readyState = 0;
    const key = getSourceRevisionKey(B.media);
    h.playback.getState().attach(B.playback, element);
    expect(h.sequence.store.getState().isReady).toBe(false);
    expect(h.sequence.store.getState().switching).toBe(true);
    element.readyState = 1;
    h.playback.getState().syncReady(key, element);
    expect(h.sequence.store.getState().switching).toBe(true);
    h.playback.getState().syncPresentedFrame(key, 0, 1, element);
    expect(h.sequence.store.getState().switching).toBe(false);
  });

  it("drops the navigation of a clip that leaves the sequence", () => {
    const h = harness([a1, b1]);
    attach(h.playback, A);
    h.sequence.store.getState().seekToPts(h.virtual("b1", "25"));
    expect(h.sequence.store.getState().switching).toBe(true);
    h.timeline.getState().removeClip(1);
    expect(h.sequence.store.getState().switching).toBe(false);
  });

  it("seeks on the attached clip with no attach", () => {
    const h = harness([a1, b1]);
    attach(h.playback, A);
    h.sequence.store.getState().seekToPts(h.virtual("a1", "75"));
    expect(h.timeline.getState().attachedClipId).toBe("a1");
    expect(h.playback.getState().seekTargetSeconds).toBe(3);
  });

  it("goes on at the first frame of the next clip at the end of a clip", () => {
    const h = harness([a1, b1]);
    const { element: first, key } = attach(h.playback, A);
    h.playback.getState().play();
    h.playback.getState().syncPlay(key, first);
    // The element pauses at its end before it sends `ended`, and the pause ends the playing state.
    h.sequence.notePause(true);
    h.playback.getState().syncPause(key, first);
    expect(h.sequence.handleEnded()).toBe(true);
    expect(h.timeline.getState().attachedClipId).toBe("b1");
    // The new element is not ready at its attach. The seek and the play wait for the anchor.
    const element = createFakeElement();
    element.readyState = 0;
    const next = getSourceRevisionKey(B.media);
    h.playback.getState().attach(B.playback, element);
    expect(element.paused).toBe(true);
    element.readyState = 1;
    h.playback.getState().syncReady(next, element);
    expect(element.paused).toBe(true);
    h.playback.getState().syncPresentedFrame(next, 0, 1, element);
    expect(element.paused).toBe(false);
  });

  it("does not go on after the last clip, or while paused", () => {
    const h = harness([a1, b1]);
    attach(h.playback, A);
    expect(h.sequence.handleEnded()).toBe(false);
    h.timeline.getState().setAttachedClip("b1");
    attach(h.playback, B);
    h.playback.getState().play();
    expect(h.sequence.handleEnded()).toBe(false);
  });

  it("steps from the last frame of a clip to the first frame of the next", () => {
    const h = harness([a1, b1]);
    const { element, key } = attach(h.playback, A);
    // PTS 249 is the last frame of a1.
    h.playback.getState().syncPresentedFrame(key, 249 / 25, 2, element);
    h.sequence.store.getState().seekNominal(1);
    expect(h.timeline.getState().attachedClipId).toBe("b1");
  });

  it("steps from the first frame of a clip back to the last frame of the one before", () => {
    const h = harness([a1, b1]);
    h.timeline.getState().setAttachedClip("b1");
    attach(h.playback, B);
    h.sequence.store.getState().seekNominal(-1);
    expect(h.timeline.getState().attachedClipId).toBe("a1");
    attach(h.playback, A);
    // One tick before the end of a1 lies in its last frame.
    expect(h.playback.getState().seekTargetSeconds).toBeCloseTo(249 / 25, 6);
  });
});
