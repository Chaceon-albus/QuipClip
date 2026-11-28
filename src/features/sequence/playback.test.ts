import { describe, expect, it } from "vitest";
import type { ImportMediaResult } from "@/features/media/types";
import { getSourceRevisionKey } from "@/features/media/sourceIdentity";
import { createPlaybackStore, type PlaybackSource } from "@/features/playback";
import { createTimelineStore } from "@/features/timeline/store";
import type { SequenceSource } from "@/features/timeline/sequence";
import { toVirtualPts } from "@/features/timeline/virtualTime";
import type { Clip, Pts, SequenceSegment, TickCount } from "@/types/project";
import {
  createSequencePlayback,
  PROGRAM_PART_TIMEOUT_MS,
  type ProgramTimer,
} from "./playback";
import {
  buildProgramParts,
  type ProgramAction,
  type ProgramPart,
} from "./programParts";

const pts = (value: string) => value as Pts;
const ticks = (value: string) => value as TickCount;

/**
 * A 25 fps source of 10 s whose PTS counts frames, at a path of its own. `extent` replaces the
 * facts of its extent, such as a probe that could not read the last packets.
 */
function source(
  path: string,
  extent: {
    readonly videoEndPts?: Pts | null;
    readonly videoDurationTicks?: TickCount | null;
    readonly approximateDurationSeconds?: number;
  } = {},
): {
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
    ...extent,
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

/** The sequence of `clips` over the sources `a` (for `/a.mp4`) and `B`. */
function harness(clips: readonly Clip[], a: typeof A = A) {
  const playback = createPlaybackStore();
  const timeline = createTimelineStore();
  timeline.getState().insertClips(
    0,
    clips,
    clips.map((clip) => (clip.sourceId === "/a.mp4" ? a.facts : B.facts)),
  );
  timeline.getState().setAttachedClip(clips[0]?.id ?? null);
  const sequence = createSequencePlayback({
    playback,
    timeline,
    media: () => ({ "/a.mp4": a.media, "/b.mp4": B.media }),
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

  it("keeps a seek pending while the new element of its clip has no metadata", () => {
    const h = harness([a1, b1]);
    attach(h.playback, A);
    h.sequence.store.getState().seekToPts(h.virtual("b1", "25"));
    // The preview attaches the element of b1 before its metadata.
    const element = createFakeElement();
    element.readyState = 0;
    const key = getSourceRevisionKey(B.media);
    h.playback.getState().attach(B.playback, element);
    // A second seek in that gap waits too, and does not fail on the element.
    h.sequence.store.getState().seekToPts(h.virtual("b1", "50"));
    expect(h.playback.getState().error).toBeNull();
    expect(h.sequence.store.getState().switching).toBe(true);
    element.readyState = 1;
    h.playback.getState().syncReady(key, element);
    h.playback.getState().syncPresentedFrame(key, 0, 1, element);
    expect(h.playback.getState().error).toBeNull();
    expect(h.playback.getState().seekTargetSeconds).toBe(2);
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

  it("does not go on at the next clip after the pause of a scrub from the system", () => {
    const h = harness([a1, b1]);
    const { element: first, key } = attach(h.playback, A);
    h.playback.getState().play();
    h.playback.getState().syncPlay(key, first);
    // The scrub of the system pauses the element during a seek to its end. The element reports
    // `ended` while the seek runs, so the preview notes no pause at the end.
    first.paused = true;
    h.sequence.notePause(false);
    h.playback.getState().syncPause(key, first);
    expect(h.playback.getState().isPlaying).toBe(false);
    // The seek ends at the end of the element, and its `ended` event comes.
    expect(h.sequence.handleEnded()).toBe(false);
    expect(h.timeline.getState().attachedClipId).toBe("a1");
  });

  it("drops the play intent of a Play Segment across a junction at an end with no playback", () => {
    const h = harness([a1, b1]);
    const { element: first, key } = attach(h.playback, A);
    h.sequence.store
      .getState()
      .playSegment(h.virtual("a1", "200"), h.virtual("b1", "50"));
    h.playback.getState().syncPlay(key, first);
    // The scrub of the system pauses the element during its seek to the end: no pause at the end.
    first.paused = true;
    h.sequence.notePause(false);
    h.playback.getState().syncPause(key, first);
    // The seek settles, and the `ended` event comes with no pause at the end before it.
    expect(h.sequence.handleEnded()).toBe(false);
    expect(h.timeline.getState().attachedClipId).toBe("a1");

    // A later play to the end of a1 goes on at b1 as a plain play, with no stop point.
    h.playback.getState().play();
    h.playback.getState().syncPlay(key, first);
    h.sequence.notePause(true);
    h.playback.getState().syncPause(key, first);
    expect(h.sequence.handleEnded()).toBe(true);
    expect(h.timeline.getState().attachedClipId).toBe("b1");
    attach(h.playback, B);
    expect(h.playback.getState().playbackStop).toBeNull();
  });

  describe("an `ended` event that the preview drops (ADR 074)", () => {
    it("forgets the pause at the end, so a later `ended` event with no pause does not go on", () => {
      const h = harness([a1, b1]);
      const { element: first, key } = attach(h.playback, A);
      h.playback.getState().play();
      h.playback.getState().syncPlay(key, first);
      // The element pauses at its end, and a seek leaves the end before its `ended` event runs.
      // The preview drops that event.
      first.paused = true;
      h.sequence.notePause(true);
      h.playback.getState().syncPause(key, first);
      expect(h.playback.getState().isPlaying).toBe(false);
      h.sequence.forgetPauseAtEnd();
      // A later seek moves the paused element to its end, and its `ended` event comes with no
      // `pause` before it. Nothing played.
      expect(h.sequence.handleEnded()).toBe(false);
      expect(h.timeline.getState().attachedClipId).toBe("a1");
    });

    it("keeps the play intent of a Play Segment across a junction, whose own end goes on", () => {
      const h = harness([a1, b1]);
      const { element: first, key } = attach(h.playback, A);
      // The segment starts at 8 s of a1 and ends at 2 s of b1.
      h.sequence.store
        .getState()
        .playSegment(h.virtual("a1", "200"), h.virtual("b1", "50"));
      expect(h.playback.getState().isPlaying).toBe(true);
      h.playback.getState().syncPlay(key, first);
      // A late `ended` event of an earlier end of a1: the preview drops it, and the playback of
      // the segment goes on in a1.
      h.sequence.forgetPauseAtEnd();
      expect(h.timeline.getState().attachedClipId).toBe("a1");
      expect(h.playback.getState().isPlaying).toBe(true);

      // The playback reaches the end of a1, and goes on in b1 up to the Out.
      h.sequence.notePause(true);
      h.playback.getState().syncPause(key, first);
      expect(h.sequence.handleEnded()).toBe(true);
      expect(h.timeline.getState().attachedClipId).toBe("b1");
      attach(h.playback, B);
      expect(h.playback.getState().playbackStop).toEqual({
        inPts: "0",
        outPts: "50",
        phase: "playing",
      });
    });
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

  it("steps past the last frame of a clip whose extent is too long", () => {
    // The probe read no end, and the stream duration says 260 frames, 10.4 s. The element ends
    // after frame 249, at 10 s.
    const long = source("/a.mp4", {
      videoEndPts: null,
      videoDurationTicks: ticks("260"),
      approximateDurationSeconds: 10.4,
    });
    const h = harness([a1, b1], long);
    const { element, key } = attach(h.playback, long);
    h.playback.getState().syncBrowserDuration(key, element);
    h.playback.getState().syncPresentedFrame(key, 249 / 25, 2, element);
    // The first step seeks to the end of the element, which shows frame 249 again, as the step
    // of one source does. The store cannot step on from there, so the next step goes to b1.
    expect(h.sequence.store.getState().seekNominal(1)).toBe("stepped");
    expect(h.timeline.getState().attachedClipId).toBe("a1");
    expect(h.sequence.store.getState().seekNominal(1)).toBe("stepped");
    expect(h.timeline.getState().attachedClipId).toBe("b1");
  });

  it("keeps the last frame of an exact clip that the store cannot reach", () => {
    // The range of a1 ends at frame 250, but the stream duration of the probe says 249 frames.
    // The store stops at frame 248. The step must not cross and skip frame 249 of the range.
    const exact = source("/a.mp4", {
      videoDurationTicks: ticks("249"),
      approximateDurationSeconds: 9.96,
    });
    const h = harness([a1, b1], exact);
    const { element, key } = attach(h.playback, exact);
    h.playback.getState().syncBrowserDuration(key, element);
    h.playback.getState().syncPresentedFrame(key, 248 / 25, 2, element);
    expect(h.sequence.store.getState().seekNominal(1)).toBe("edge");
    expect(h.timeline.getState().attachedClipId).toBe("a1");
  });

  it("passes the edge of the one clip through, with nothing to cross to", () => {
    const h = harness([a1]);
    const { element, key } = attach(h.playback, A);
    h.playback.getState().syncBrowserDuration(key, element);
    h.playback.getState().syncPresentedFrame(key, 249 / 25, 2, element);
    expect(h.sequence.store.getState().seekNominal(1)).toBe("edge");
    expect(h.timeline.getState().attachedClipId).toBe("a1");
  });

  it("seeks to a frame of the grid of a clip after the attach of that clip", () => {
    const h = harness([a1, b1]);
    attach(h.playback, A);
    h.sequence.seekToClipFrame("b1", 25);
    expect(h.timeline.getState().attachedClipId).toBe("b1");
    attach(h.playback, B);
    // Frame 25 of b1 starts 1 s into b1: the display target names its nominal start.
    expect(h.playback.getState().seekTargetSeconds).toBe(1);
    expect(h.sequence.store.getState().seekTargetSeconds).toBe(11);
  });

  it("does nothing for a frame seek on another clip or at an index that is not a frame", () => {
    const h = harness([a1, b1]);
    attach(h.playback, A);
    h.sequence.seekToClipFrame("missing", 5);
    h.sequence.seekToClipFrame("b1", -1);
    h.sequence.seekToClipFrame("b1", 1.5);
    expect(h.timeline.getState().attachedClipId).toBe("a1");
    expect(h.playback.getState().seekTargetSeconds).toBeNull();
  });

  it("reports a step that cannot run", () => {
    const h = harness([a1, b1]);
    expect(h.sequence.store.getState().seekNominal(1)).toBe("none");
    expect(h.timeline.getState().attachedClipId).toBe("a1");
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

  describe("the recalibration (ADR 063)", () => {
    /** An element of `which` with its metadata, before its first frame. */
    function attachLoaded(
      playback: ReturnType<typeof createPlaybackStore>,
      which: typeof A,
    ) {
      const element = createFakeElement();
      const key = getSourceRevisionKey(which.media);
      playback.getState().attach(which.playback, element);
      playback.getState().syncReady(key, element);
      return { element, key };
    }

    /**
     * Brings the source of `which` to the recoverable state: a seek waits for the anchor, and two
     * waits run out, one for each element. Returns the element on screen.
     */
    function reachRecoverable(
      playback: ReturnType<typeof createPlaybackStore>,
      which: typeof A,
    ) {
      const first = attachLoaded(playback, which);
      playback.getState().seekApproximate(3);
      playback.getState().syncAnchorWaitExpired(first.key, first.element);
      playback.getState().detach(first.key, first.element);
      const next = attachLoaded(playback, which);
      playback.getState().syncAnchorWaitExpired(next.key, next.element);
      expect(playback.getState().canRecalibrate).toBe(true);
      return next;
    }

    it("maps canRecalibrate and isRecalibrating, and passes recalibrate with the attached key", () => {
      const h = harness([a1, b1]);
      const shown = reachRecoverable(h.playback, A);
      expect(h.sequence.store.getState().canRecalibrate).toBe(true);
      // On a sequence the key of the interface is the key of the sequence.
      const sequenceKey = h.sequence.store.getState().attachedSourceRevisionKey;
      expect(sequenceKey).not.toBe(shown.key);

      h.sequence.store.getState().recalibrate(sequenceKey ?? "");
      expect(h.playback.getState().reloadGeneration).toBe(2);
      expect(h.sequence.store.getState().isRecalibrating).toBe(true);
      expect(h.sequence.store.getState().canRecalibrate).toBe(false);
      // Not a cold switch, and the clip on screen stays.
      expect(h.sequence.store.getState().switching).toBe(false);
      expect(h.timeline.getState().attachedClipId).toBe("a1");

      // The detach of the old element is not a change of the source for the interface.
      h.playback.getState().detach(shown.key, shown.element);
      expect(h.sequence.store.getState().attachedSourceRevisionKey).toBe(sequenceKey);
      const next = attachLoaded(h.playback, A);
      h.playback.getState().syncPresentedFrame(next.key, 0, 1, next.element);
      // The position of the store, in seconds of the clip, maps onto the virtual axis.
      expect(next.element.currentTime).toBe(3);
      expect(h.sequence.store.getState().seekTargetSeconds).toBe(3);
    });

    it("passes the key through with one clip", () => {
      const h = harness([a1]);
      const shown = reachRecoverable(h.playback, A);
      h.sequence.store.getState().recalibrate("an old key");
      expect(h.playback.getState().reloadGeneration).toBe(1);
      h.sequence.store.getState().recalibrate(shown.key);
      expect(h.playback.getState().reloadGeneration).toBe(2);
    });

    it("drops a navigation that waits for an attach, as a navigation of the user does", () => {
      const h = harness([a1, b1]);
      reachRecoverable(h.playback, A);
      h.sequence.store.getState().seekToPts(h.virtual("b1", "25"));
      expect(h.timeline.getState().attachedClipId).toBe("b1");
      expect(h.sequence.store.getState().switching).toBe(true);

      const key = h.sequence.store.getState().attachedSourceRevisionKey;
      h.sequence.store.getState().recalibrate(key ?? "");
      expect(h.timeline.getState().attachedClipId).toBe("a1");
      expect(h.sequence.store.getState().switching).toBe(false);
      expect(h.playback.getState().isRecalibrating).toBe(true);
    });

    it("keeps a cold switch in progress while a recalibration replaces the new element", () => {
      const h = harness([a1, b1]);
      attach(h.playback, A);
      h.sequence.store.getState().seekToPts(h.virtual("b1", "25"));
      const first = attachLoaded(h.playback, B);
      // The seek waits for the anchor of b1.
      expect(h.playback.getState().hasDeferredNavigation).toBe(true);
      expect(h.sequence.store.getState().switching).toBe(true);

      h.playback.getState().syncAnchorWaitExpired(first.key, first.element);
      expect(h.sequence.store.getState().switching).toBe(true);
      // The detach of the old element reports "unavailable".
      h.playback.getState().detach(first.key, first.element);
      expect(h.playback.getState().calibrationStatus).toBe("unavailable");
      expect(h.sequence.store.getState().switching).toBe(true);
      const next = attachLoaded(h.playback, B);
      expect(h.sequence.store.getState().switching).toBe(true);
      expect(h.timeline.getState().attachedClipId).toBe("b1");

      h.playback.getState().syncPresentedFrame(next.key, 0, 1, next.element);
      expect(h.sequence.store.getState().switching).toBe(false);
      expect(next.element.currentTime).toBe(1);
      expect(h.sequence.store.getState().seekTargetSeconds).toBe(11);
    });

    it("passes the queries and the end of the wait through", () => {
      const h = harness([a1]);
      const first = attachLoaded(h.playback, A);
      h.playback.getState().seekApproximate(3);
      h.sequence.store.getState().syncAnchorWaitExpired(first.key, first.element);
      expect(h.playback.getState().isRecalibrating).toBe(true);
      expect(
        h.sequence.store.getState().isRetiredElement(first.key, first.element),
      ).toBe(true);
      expect(h.sequence.store.getState().refusesTransportForReload()).toBe(true);
    });

    /**
     * Retires the element of a1 with a manual recalibration, and then seeks to b1, a navigation
     * that waits for the attach of b1. With `detachOld`, the retired element then leaves before
     * any element of b1 attaches, so no element is attached. Returns the target of the request
     * of the reload.
     */
    function retireThenSeekToB(
      h: ReturnType<typeof harness>,
      detachOld = false,
    ): number | null {
      const shown = reachRecoverable(h.playback, A);
      const key = h.sequence.store.getState().attachedSourceRevisionKey;
      h.sequence.store.getState().recalibrate(key ?? "");
      expect(h.playback.getState().refusesTransportForReload()).toBe(true);
      const request = h.playback.getState().seekTargetSeconds;
      h.sequence.store.getState().seekToPts(h.virtual("b1", "25"));
      expect(h.timeline.getState().attachedClipId).toBe("b1");
      expect(h.sequence.store.getState().switching).toBe(true);
      if (detachOld) {
        h.playback.getState().detach(shown.key, shown.element);
        expect(h.playback.getState().isAttached).toBe(false);
        expect(h.sequence.store.getState().switching).toBe(true);
      }
      return request;
    }

    const refusedCommands = [
      [
        "a second recalibration",
        (h: ReturnType<typeof harness>) => {
          const key = h.sequence.store.getState().attachedSourceRevisionKey;
          h.sequence.store.getState().recalibrate(key ?? "");
        },
      ],
      ["play", (h: ReturnType<typeof harness>) => h.sequence.store.getState().play()],
      [
        "toggle playback",
        (h: ReturnType<typeof harness>) => h.sequence.store.getState().togglePlayback(),
      ],
      [
        "a frame step",
        (h: ReturnType<typeof harness>) => {
          expect(h.sequence.store.getState().seekNominal(1)).toBe("none");
        },
      ],
      [
        "a segment playback that crosses a junction",
        (h: ReturnType<typeof harness>) =>
          h.sequence.store
            .getState()
            .playSegment(h.virtual("a1", "50"), h.virtual("b1", "50")),
      ],
    ] as const;

    it.each(refusedCommands)(
      "keeps the navigation of the sequence for %s that the store refuses",
      (_name, command) => {
        const h = harness([a1, b1]);
        const request = retireThenSeekToB(h);
        command(h);
        expect(h.timeline.getState().attachedClipId).toBe("b1");
        expect(h.sequence.store.getState().switching).toBe(true);
        expect(h.playback.getState().seekTargetSeconds).toBe(request);
        expect(h.playback.getState().reloadGeneration).toBe(2);
      },
    );

    it.each(refusedCommands)(
      "keeps the navigation of the sequence for %s while no element is attached during the reload",
      (_name, command) => {
        const h = harness([a1, b1]);
        const request = retireThenSeekToB(h, true);
        command(h);
        expect(h.timeline.getState().attachedClipId).toBe("b1");
        expect(h.sequence.store.getState().switching).toBe(true);
        expect(h.playback.getState().seekTargetSeconds).toBe(request);
        expect(h.playback.getState().reloadGeneration).toBe(2);
      },
    );

    it("keeps a cold switch in progress after a failed request while the replacement loads", () => {
      const h = harness([a1, b1]);
      attach(h.playback, A);
      h.sequence.store.getState().seekToPts(h.virtual("b1", "25"));
      const first = attachLoaded(h.playback, B);
      h.playback.getState().syncAnchorWaitExpired(first.key, first.element);
      expect(h.playback.getState().isRecalibrating).toBe(true);

      h.playback.getState().seekToPts(pts("not a pts"));
      expect(h.playback.getState().error).toBe("seekFailed");
      expect(h.sequence.store.getState().switching).toBe(true);
    });

    /** Attaches a new element of `which` whose metadata has not loaded. */
    function attachUnready(
      playback: ReturnType<typeof createPlaybackStore>,
      which: typeof A,
    ) {
      const element = createFakeElement();
      element.readyState = 0;
      const key = getSourceRevisionKey(which.media);
      playback.getState().attach(which.playback, element);
      return { element, key };
    }

    it("keeps a ruler seek on the last clip when the clip before it leaves during the retry", () => {
      const h = harness([a1, b1]);
      attach(h.playback, A);
      h.sequence.store.getState().seekToPts(h.virtual("b1", "25"));
      const first = attachLoaded(h.playback, B);
      h.playback.getState().syncAnchorWaitExpired(first.key, first.element);
      h.playback.getState().detach(first.key, first.element);
      const next = attachUnready(h.playback, B);
      // The clip menu removes a1, so the sequence holds one clip.
      h.timeline.getState().removeClip(0);
      expect(h.timeline.getState().clips).toHaveLength(1);

      // A click on the ruler at 6 s of b1.
      h.sequence.store.getState().seekToPts(pts("150"));
      expect(h.playback.getState().error).toBeNull();

      next.element.readyState = 1;
      h.playback.getState().syncReady(next.key, next.element);
      h.playback.getState().syncPresentedFrame(next.key, 0, 1, next.element);
      expect(next.element.currentTime).toBe(6);
    });

    it.each([
      [
        "an automatic recalibration",
        (h: ReturnType<typeof harness>) => {
          const first = attachLoaded(h.playback, A);
          h.playback.getState().seekApproximate(3);
          h.playback.getState().syncAnchorWaitExpired(first.key, first.element);
          return first;
        },
      ],
      [
        "a manual recalibration",
        (h: ReturnType<typeof harness>) => {
          const shown = reachRecoverable(h.playback, A);
          h.sequence.store.getState().recalibrate(shown.key);
          return shown;
        },
      ],
    ])(
      "ends at the sought position after %s and a seek before the new element is ready",
      (_name, start) => {
        const h = harness([a1]);
        const old = start(h);
        expect(h.playback.getState().isRecalibrating).toBe(true);
        h.playback.getState().detach(old.key, old.element);
        const next = attachUnready(h.playback, A);

        h.sequence.store.getState().seekToPts(pts("150"));
        expect(h.playback.getState().error).toBeNull();

        next.element.readyState = 1;
        h.playback.getState().syncReady(next.key, next.element);
        h.playback.getState().syncPresentedFrame(next.key, 0, 1, next.element);
        expect(next.element.currentTime).toBe(6);
      },
    );
  });

  describe("the replacement of the element for a new audio stream (ADR 070)", () => {
    it("passes the key of the source through, also on a sequence", () => {
      const h = harness([a1, b1]);
      const shown = attach(h.playback, A);
      h.sequence.store.getState().replacePreviewElement("an old key");
      expect(h.playback.getState().reloadGeneration).toBe(0);
      h.sequence.store.getState().replacePreviewElement(shown.key);
      expect(h.playback.getState().reloadGeneration).toBe(1);
      expect(h.sequence.store.getState().isRecalibrating).toBe(true);
      // Not a cold switch, and the clip on screen stays.
      expect(h.sequence.store.getState().switching).toBe(false);
      expect(h.timeline.getState().attachedClipId).toBe("a1");
    });

    it("keeps a navigation that waits for the attach of a clip", () => {
      const h = harness([a1, b1]);
      const shown = attach(h.playback, A);
      h.sequence.store.getState().seekToPts(h.virtual("b1", "25"));
      expect(h.sequence.store.getState().switching).toBe(true);
      h.sequence.store.getState().replacePreviewElement(shown.key);
      expect(h.timeline.getState().attachedClipId).toBe("b1");
      expect(h.sequence.store.getState().switching).toBe(true);
      attach(h.playback, B);
      expect(h.playback.getState().seekTargetSeconds).toBe(1);
    });

    it("ends a segment playback that crosses a junction, because the store stops it", () => {
      const h = harness([a1, b1]);
      const shown = attach(h.playback, A);
      h.sequence.store
        .getState()
        .playSegment(h.virtual("a1", "50"), h.virtual("b1", "50"));
      h.sequence.store.getState().replacePreviewElement(shown.key);
      expect(h.playback.getState().isPlaying).toBe(false);
      // A late end of the old element does not go on at the next clip.
      h.sequence.notePause(true);
      expect(h.sequence.handleEnded()).toBe(false);
      expect(h.timeline.getState().attachedClipId).toBe("a1");
    });

    /** Attaches an element of `which` whose metadata has not loaded. */
    function attachUnloaded(
      playback: ReturnType<typeof createPlaybackStore>,
      which: typeof A,
    ) {
      const element = createFakeElement();
      element.readyState = 0;
      const key = getSourceRevisionKey(which.media);
      playback.getState().attach(which.playback, element);
      return { element, key };
    }

    /** The detach of `old` and a replacement element of `which` with its metadata. */
    function replaceLoaded(
      playback: ReturnType<typeof createPlaybackStore>,
      which: typeof A,
      old: { element: ReturnType<typeof createFakeElement>; key: string },
    ) {
      playback.getState().detach(old.key, old.element);
      const next = attachUnloaded(playback, which);
      next.element.readyState = 1;
      playback.getState().syncReady(next.key, next.element);
      return next;
    }

    it("does not play again after a change at a junction while the next element loads", () => {
      const h = harness([a1, b1]);
      const { element: first, key } = attach(h.playback, A);
      h.playback.getState().play();
      h.playback.getState().syncPlay(key, first);
      h.sequence.notePause(true);
      h.playback.getState().syncPause(key, first);
      expect(h.sequence.handleEnded()).toBe(true);
      // The element of b1 attaches with no metadata, and the user chooses another track.
      const incoming = attachUnloaded(h.playback, B);
      h.sequence.store.getState().replacePreviewElement(incoming.key);
      expect(h.playback.getState().reloadGeneration).toBe(1);
      expect(h.sequence.store.getState().switching).toBe(true);

      const next = replaceLoaded(h.playback, B, incoming);
      h.playback.getState().syncPresentedFrame(next.key, 0, 1, next.element);
      // The navigation ran as a seek to the first frame of b1, with no play.
      expect(h.sequence.store.getState().switching).toBe(false);
      expect(h.timeline.getState().attachedClipId).toBe("b1");
      expect(h.playback.getState().presentedFrame?.inferredSourcePts).toBe("0");
      expect(next.element.paused).toBe(true);
      expect(h.playback.getState().isPlaying).toBe(false);
    });

    it("turns a Play Segment that waits for the attach into a seek to its In", () => {
      const h = harness([a1, b1]);
      attach(h.playback, A);
      // A segment of b1 alone, while a1 is on screen: it waits for the attach of b1.
      h.sequence.store
        .getState()
        .playSegment(h.virtual("b1", "25"), h.virtual("b1", "50"));
      const incoming = attachUnloaded(h.playback, B);
      h.sequence.store.getState().replacePreviewElement(incoming.key);

      const next = replaceLoaded(h.playback, B, incoming);
      h.playback.getState().syncPresentedFrame(next.key, 0, 1, next.element);
      expect(next.element.currentTime).toBe(1);
      expect(next.element.paused).toBe(true);
      expect(h.playback.getState().isPlaying).toBe(false);
      expect(h.playback.getState().playbackStop).toBeNull();
    });

    it("keeps the play of a navigation that waits when the store refuses the replacement", () => {
      const h = harness([a1, b1]);
      const { element: first, key } = attach(h.playback, A);
      h.playback.getState().play();
      h.playback.getState().syncPlay(key, first);
      h.sequence.notePause(true);
      h.playback.getState().syncPause(key, first);
      expect(h.sequence.handleEnded()).toBe(true);
      // Another source, and no element of b1 yet: the store refuses, and nothing changes here.
      h.sequence.store.getState().replacePreviewElement("an old key");
      const incoming = getSourceRevisionKey(B.media);
      h.sequence.store.getState().replacePreviewElement(incoming);
      expect(h.playback.getState().reloadGeneration).toBe(0);

      const element = createFakeElement();
      element.readyState = 0;
      h.playback.getState().attach(B.playback, element);
      element.readyState = 1;
      h.playback.getState().syncReady(incoming, element);
      h.playback.getState().syncPresentedFrame(incoming, 0, 1, element);
      expect(element.paused).toBe(false);
    });

    it("keeps the navigation as a seek when a second change finds the element retired", () => {
      const h = harness([a1, b1]);
      const { element: first, key } = attach(h.playback, A);
      h.playback.getState().play();
      h.playback.getState().syncPlay(key, first);
      h.sequence.notePause(true);
      h.playback.getState().syncPause(key, first);
      h.sequence.handleEnded();
      const incoming = attachUnloaded(h.playback, B);
      h.sequence.store.getState().replacePreviewElement(incoming.key);
      // A second change while the element is retired: refused, and the navigation stays a seek.
      h.sequence.store.getState().replacePreviewElement(incoming.key);
      expect(h.playback.getState().reloadGeneration).toBe(1);
      const next = replaceLoaded(h.playback, B, incoming);
      h.playback.getState().syncPresentedFrame(next.key, 0, 1, next.element);
      expect(next.element.paused).toBe(true);
    });

    it("ends at the sought position after a seek before the new element is ready", () => {
      const h = harness([a1]);
      const shown = attach(h.playback, A);
      h.sequence.store.getState().replacePreviewElement(shown.key);
      h.playback.getState().detach(shown.key, shown.element);
      const next = createFakeElement();
      next.readyState = 0;
      h.playback.getState().attach(A.playback, next);

      // The seek waits as a navigation of the one clip, and replaces the request of the reload.
      h.sequence.store.getState().seekToPts(pts("150"));
      expect(h.playback.getState().error).toBeNull();

      next.readyState = 1;
      h.playback.getState().syncReady(shown.key, next);
      h.playback.getState().syncPresentedFrame(shown.key, 0, 1, next);
      expect(next.currentTime).toBe(6);
    });

    /**
     * The decode failure of the element of `which` before its metadata: the pane marks it
     * unready, and the element leaves the tree.
     */
    function failUnloaded(
      playback: ReturnType<typeof createPlaybackStore>,
      which: typeof A,
    ) {
      const failed = attachUnloaded(playback, which);
      playback.getState().syncUnready(failed.key, failed.element);
      playback.getState().detach(failed.key, failed.element);
      expect(playback.getState().isAttached).toBe(false);
    }

    /** The element that mounts again after the retry, with its metadata. */
    function attachRetried(
      playback: ReturnType<typeof createPlaybackStore>,
      which: typeof A,
    ) {
      const element = createFakeElement();
      element.readyState = 0;
      const key = getSourceRevisionKey(which.media);
      playback.getState().attach(which.playback, element);
      element.readyState = 1;
      playback.getState().syncReady(key, element);
      playback.getState().syncPresentedFrame(key, 0, 1, element);
      return { element, key };
    }

    it("does not play again when the retry of a failed clip at a junction mounts it", () => {
      const h = harness([a1, b1]);
      const { element: first, key } = attach(h.playback, A);
      h.playback.getState().play();
      h.playback.getState().syncPlay(key, first);
      h.sequence.notePause(true);
      h.playback.getState().syncPause(key, first);
      expect(h.sequence.handleEnded()).toBe(true);
      // The chosen track of b1 fails before its metadata, and the user chooses another one.
      failUnloaded(h.playback, B);
      h.sequence.dropPlayIntent();

      const retried = attachRetried(h.playback, B);
      // The seek to the first frame of b1 ran, with no play.
      expect(h.sequence.store.getState().switching).toBe(false);
      expect(h.timeline.getState().attachedClipId).toBe("b1");
      expect(h.playback.getState().presentedFrame?.inferredSourcePts).toBe("0");
      expect(retried.element.paused).toBe(true);
      expect(h.playback.getState().isPlaying).toBe(false);
    });

    it("ends a waiting Play Segment across a junction when the retry mounts its clip", () => {
      const h = harness([a1, b1]);
      h.timeline.getState().setAttachedClip("b1");
      attach(h.playback, B);
      // The segment starts at 8 s of a1 and ends in b1: it waits for the attach of a1.
      h.sequence.store
        .getState()
        .playSegment(h.virtual("a1", "200"), h.virtual("b1", "50"));
      expect(h.timeline.getState().attachedClipId).toBe("a1");
      failUnloaded(h.playback, A);
      h.sequence.dropPlayIntent();

      const retried = attachRetried(h.playback, A);
      expect(retried.element.currentTime).toBe(8);
      expect(retried.element.paused).toBe(true);
      expect(h.playback.getState().isPlaying).toBe(false);
      // The Out across the junction is gone, so a late end does not go on at b1.
      h.sequence.notePause(true);
      expect(h.sequence.handleEnded()).toBe(false);
      expect(h.timeline.getState().attachedClipId).toBe("a1");
    });
  });
});

describe("the program play (ADR 074)", () => {
  /**
   * A media element that plays: `advanceTo` moves the position as playback does, with no seek,
   * and only an assignment of `currentTime` counts as a seek. It counts its pauses.
   */
  function createPlayingElement(duration = 10) {
    let time = 0;
    const element = {
      seeking: false,
      paused: true,
      ended: false,
      readyState: 1,
      duration,
      muted: false,
      playbackRate: 1,
      pauseCalls: 0,
      get currentTime() {
        return time;
      },
      set currentTime(value: number) {
        time = Math.min(value, duration);
        element.seeking = true;
        element.ended = false;
      },
      advanceTo: (value: number) => {
        time = value;
      },
      play: (): Promise<void> => {
        element.paused = false;
        return Promise.resolve();
      },
      pause: () => {
        element.pauseCalls += 1;
        element.paused = true;
      },
    };
    return element;
  }

  /**
   * A timer that runs when the test moves the clock. With `keepCancelled`, a cancel does
   * nothing, so a test can see that the callback of an old timer changes nothing.
   */
  function fakeTimer(keepCancelled = false) {
    const timers: { at: number; callback: () => void; done: boolean }[] = [];
    let now = 0;
    const timer: ProgramTimer = (callback, ms) => {
      const entry = { at: now + ms, callback, done: false };
      timers.push(entry);
      return () => {
        if (!keepCancelled) {
          entry.done = true;
        }
      };
    };
    const advance = (ms: number): void => {
      now += ms;
      for (const entry of [...timers]) {
        if (!entry.done && entry.at <= now) {
          entry.done = true;
          entry.callback();
        }
      }
    };
    const active = (): number => timers.filter((entry) => !entry.done).length;
    return { timer, advance, active };
  }

  /** Lets the microtasks of the run and of the play promises run. */
  async function settle(): Promise<void> {
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }
  }

  function seg(
    id: string,
    inClipId: string,
    inPts: string,
    outClipId: string,
    outPts: string,
  ): SequenceSegment {
    return { id, inClipId, inPts: pts(inPts), outClipId, outPts: pts(outPts) };
  }

  /** A 25 fps source of 40 s whose PTS counts frames. */
  const C = source("/c.mp4", {
    videoEndPts: pts("1000"),
    videoDurationTicks: ticks("1000"),
    approximateDurationSeconds: 40,
  });
  const c1: Clip = { id: "c1", sourceId: "/c.mp4" };

  /**
   * The sequence of `clips` and `segments` over `sources`, as a project open gives it, with a
   * fake timer (`fakeTimer`, with `keepCancelled`).
   */
  function program(
    clips: readonly Clip[],
    segments: readonly SequenceSegment[],
    sources: readonly (typeof A)[] = [A, B],
    keepCancelled = false,
  ) {
    const media = Object.fromEntries(
      sources.map((entry) => [entry.media.path, entry.media]),
    );
    const playback = createPlaybackStore();
    const timeline = createTimelineStore();
    timeline.getState().loadSequence(
      clips,
      sources.map((entry) => entry.facts),
      segments,
    );
    const clock = fakeTimer(keepCancelled);
    const sequence = createSequencePlayback({
      playback,
      timeline,
      media: () => media,
      timer: clock.timer,
    });
    const parts = (
      action: ProgramAction = "program",
      current: string | null = null,
    ): ProgramPart[] => buildProgramParts(action, timeline.getState(), media, current);
    const virtual = (clipId: string, value: string): Pts => {
      const axis = timeline.getState().virtual;
      const result = axis && toVirtualPts(axis, { clipId, pts: pts(value) });
      if (!result) throw new Error("virtual");
      return result;
    };
    /**
     * Attaches an element of `which`, as the preview does after the attach of its clip. With
     * `calibrate`, its first frame comes and calibrates the source. With `lengthAfterFrame`, the
     * length of the element comes after that first frame, in the same task. `frame(k)` plays to
     * frame k and presents it, and `seeked(k)` ends the running seek on frame k. `landed()` ends
     * the running seek with no frame, as in a hidden window, and `tick(s)` moves the element to
     * `s` seconds with a `timeupdate`.
     */
    const show = (
      which: typeof A,
      {
        calibrate = true,
        duration = which.playback.approximateDurationSeconds ?? 10,
        lengthAfterFrame = false,
      }: { calibrate?: boolean; duration?: number; lengthAfterFrame?: boolean } = {},
    ) => {
      const element = createPlayingElement(duration);
      const key = getSourceRevisionKey(which.media);
      let presented = 0;
      playback.getState().attach(which.playback, element);
      playback.getState().syncReady(key, element);
      if (!lengthAfterFrame) {
        playback.getState().syncBrowserDuration(key, element);
      }
      const present = (value: string): void => {
        playback
          .getState()
          .syncPresentedFrame(key, Number(value) / 25, ++presented, element);
      };
      if (calibrate) {
        present("0");
      }
      if (lengthAfterFrame) {
        playback.getState().syncBrowserDuration(key, element);
      }
      const tick = (seconds: number): void => {
        element.advanceTo(seconds);
        playback.getState().syncBrowserTime(key, element);
      };
      return {
        element,
        key,
        present,
        tick,
        seeked: (value: string): void => {
          element.seeking = false;
          playback.getState().syncSeeked(key, element);
          present(value);
        },
        landed: (): void => {
          element.seeking = false;
          playback.getState().syncBrowserTime(key, element);
          playback.getState().syncSeeked(key, element);
        },
        frame: (value: string): void => {
          element.advanceTo(Number(value) / 25 + 0.001);
          present(value);
        },
      };
    };
    const runState = () => sequence.store.getState().programRun;
    return { playback, timeline, sequence, clock, parts, virtual, show, runState };
  }

  type Program = ReturnType<typeof program>;
  type Screen = ReturnType<Program["show"]>;

  /** Two segments on a1 and one on b1. */
  function threeSegments(): Program {
    return program(
      [a1, b1],
      [
        seg("s1", "a1", "50", "a1", "100"),
        seg("s2", "a1", "150", "a1", "200"),
        seg("s3", "b1", "25", "b1", "75"),
      ],
    );
  }

  /** Starts Play Program on a1 and plays its first part past the seek to its start. */
  function playingFirstPart(h: Program): Screen {
    const a = h.show(A);
    expect(h.sequence.startProgramPlay("program", h.parts())).toBe(true);
    a.seeked("50");
    a.frame("60");
    expect(h.playback.getState().isPlaying).toBe(true);
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: false });
    return a;
  }

  /** Expects the end of a run before the end of its last part. */
  function expectEndedEarly(h: Program): void {
    expect(h.runState()).toBeNull();
    expect(h.playback.getState().isPlaying).toBe(false);
    expect(h.playback.getState().playbackStop).toBeNull();
  }

  it("plays two parts on one clip, each to its stop, and ends after the last", async () => {
    const h = program(
      [a1, b1],
      [seg("s1", "a1", "50", "a1", "100"), seg("s2", "a1", "150", "a1", "200")],
    );
    const a = h.show(A);
    expect(h.runState()).toBeNull();
    const parts = h.parts();
    expect(parts).toHaveLength(2);
    expect(h.sequence.startProgramPlay("program", parts)).toBe(true);
    expect(h.runState()).toEqual({ action: "program", part: 1, count: 2 });
    expect(h.playback.getState().playbackStop).toEqual({
      inPts: "50",
      outPts: "100",
      phase: "playing",
    });
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: false });
    expect(a.element.currentTime).toBe(2);

    a.seeked("50");
    const state = h.runState();
    a.frame("70");
    // A change of the playback that is no change of the run keeps the object of the state.
    expect(h.runState()).toBe(state);
    a.frame("99");
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
    // The run goes on at the next part in a task of its own, not inside the call of the store.
    expect(h.runState()?.part).toBe(1);
    expect(h.playback.getState().playbackStop?.phase).toBe("stopped");
    await settle();
    expect(h.runState()).toEqual({ action: "program", part: 2, count: 2 });
    expect(h.playback.getState().playbackStop).toEqual({
      inPts: "150",
      outPts: "200",
      phase: "playing",
    });
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: false });
    expect(a.element.currentTime).toBe(6);

    a.seeked("150");
    const pauses = a.element.pauseCalls;
    a.frame("199");
    await settle();
    expect(h.runState()).toBeNull();
    // The run changes nothing after its last part: the stop point stays, as after Play Segment.
    expect(h.playback.getState().playbackStop?.phase).toBe("stopped");
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: true });
    expect(h.playback.getState().isPlaying).toBe(false);
    expect(a.element.pauseCalls).toBe(pauses + 1);
    expect(h.clock.active()).toBe(0);
  });

  it("plays the parts of a timeline of one clip", async () => {
    const h = program(
      [a1],
      [seg("s1", "a1", "50", "a1", "100"), seg("s2", "a1", "150", "a1", "200")],
    );
    const a = h.show(A);
    h.sequence.startProgramPlay("program", h.parts());
    a.seeked("50");
    a.frame("99");
    await settle();
    expect(h.runState()).toEqual({ action: "program", part: 2, count: 2 });
    expect(a.element.currentTime).toBe(6);
    a.seeked("150");
    a.frame("199");
    await settle();
    expect(h.runState()).toBeNull();
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: true });
  });

  it("attaches the clip of the next part, and asks for the part once it is calibrated", async () => {
    const h = program(
      [a1, b1],
      [seg("s1", "a1", "50", "a1", "100"), seg("s2", "b1", "25", "b1", "75")],
    );
    const a = h.show(A);
    h.sequence.startProgramPlay("program", h.parts());
    a.seeked("50");
    a.frame("99");
    await settle();
    expect(h.runState()).toEqual({ action: "program", part: 2, count: 2 });
    expect(h.timeline.getState().attachedClipId).toBe("b1");
    expect(h.sequence.store.getState().switching).toBe(true);

    // The element of b1 attaches, and its metadata and its length come. The attach that the run
    // asked for is no change of the program, and its new element is no failure.
    const b = h.show(B, { calibrate: false });
    h.timeline.getState().setBrowserDuration("/b.mp4", 10);
    await settle();
    expect(h.runState()?.part).toBe(2);
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
    // The first frame calibrates the source. The run asks for the part in the microtask after
    // that store call, never inside it.
    const calls: string[] = [];
    const playSegment = h.playback.getState().playSegment;
    h.playback.setState({
      playSegment: (inPts, outPts) => {
        calls.push("playSegment");
        playSegment(inPts, outPts);
      },
    });
    calls.push("frame");
    b.present("0");
    calls.push("returned");
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
    await settle();
    expect(calls).toEqual(["frame", "returned", "playSegment"]);
    expect(h.playback.getState().playbackStop).toEqual({
      inPts: "25",
      outPts: "75",
      phase: "playing",
    });
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: false });
    expect(b.element.currentTime).toBe(1);

    b.seeked("25");
    b.frame("74");
    await settle();
    expect(h.runState()).toBeNull();
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: true });
  });

  it.each([
    ["the pause on the last frame", (_h: Program, a: Screen) => a.frame("99")],
    [
      "the seek back from a frame after the last frame",
      (_h: Program, a: Screen) => a.frame("100"),
    ],
    [
      "the stop of the clock",
      (h: Program, a: Screen) => {
        a.element.advanceTo(100 / 25 + 0.1);
        h.playback.getState().syncBrowserTime(a.key, a.element);
      },
    ],
  ])("goes on at the next part after %s", async (_name, stop) => {
    const h = threeSegments();
    const a = playingFirstPart(h);
    stop(h, a);
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
    await settle();
    expect(h.runState()?.part).toBe(2);
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: false });
    expect(h.playback.getState().playbackStop).toEqual({
      inPts: "150",
      outPts: "200",
      phase: "playing",
    });
  });

  it("moves on only at the stop of part two, after the late events of the seek back of part one", async () => {
    const h = threeSegments();
    const a = playingFirstPart(h);
    // A frame after the last frame: the store seeks back to frame 99 and publishes "reached".
    a.frame("100");
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
    await settle();
    expect(h.runState()?.part).toBe(2);
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: false });

    // The late events of the seek back of part one: its `seeking`, its `seeked` and its frame.
    h.playback.getState().syncSeeking(a.key, a.element);
    a.element.seeking = false;
    h.playback.getState().syncSeeked(a.key, a.element);
    a.present("99");
    await settle();
    expect(h.runState()?.part).toBe(2);
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: false });
    expect(h.playback.getState().playbackStop).toEqual({
      inPts: "150",
      outPts: "200",
      phase: "playing",
    });

    // The seek of part two ends, and part two plays to its stop.
    expect(a.element.currentTime).toBe(6);
    a.seeked("150");
    a.frame("170");
    await settle();
    expect(h.runState()?.part).toBe(2);
    a.frame("199");
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: true });
    await settle();
    expect(h.runState()?.part).toBe(3);
  });

  it("goes on at the next part after the end of the media, and not at the next clip", async () => {
    const h = program(
      [a1, b1],
      [seg("s1", "a1", "200", "a1", "250"), seg("s2", "b1", "0", "b1", "50")],
    );
    const a = h.show(A);
    h.sequence.startProgramPlay("program", h.parts());
    a.seeked("200");
    a.frame("248");
    // The element reaches the end of the media. The pane notes the pause at the end, the store
    // syncs it, and the `ended` event does not go on at the next clip while the run exists.
    a.element.advanceTo(10);
    a.element.paused = true;
    a.element.ended = true;
    h.sequence.notePause(true);
    h.playback.getState().syncPause(a.key, a.element);
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
    expect(h.sequence.handleEnded()).toBe(false);
    h.playback.getState().syncEnded(a.key, a.element);
    expect(h.timeline.getState().attachedClipId).toBe("a1");

    await settle();
    expect(h.runState()?.part).toBe(2);
    expect(h.timeline.getState().attachedClipId).toBe("b1");
    const b = h.show(B);
    await settle();
    expect(h.playback.getState().playbackStop).toEqual({
      inPts: "0",
      outPts: "50",
      phase: "playing",
    });
    expect(b.element.paused).toBe(false);
  });

  it("does not go on at the next clip at the end of a clip that plays while the run loads", async () => {
    const h = program([a1, b1], [seg("s1", "b1", "25", "b1", "75")]);
    const a = h.show(A);
    h.playback.getState().play();
    h.playback.getState().syncPlay(a.key, a.element);
    h.sequence.startProgramPlay("program", h.parts());
    expect(h.timeline.getState().attachedClipId).toBe("b1");
    // a1 plays to its end before the element of b1 attaches.
    a.element.advanceTo(10);
    a.element.paused = true;
    a.element.ended = true;
    h.sequence.notePause(true);
    h.playback.getState().syncPause(a.key, a.element);
    expect(h.sequence.handleEnded()).toBe(false);
    h.playback.getState().syncEnded(a.key, a.element);
    await settle();
    expect(h.runState()?.part).toBe(1);
    // The part of the run, and not the first frame of b1, plays on b1.
    const b = h.show(B);
    await settle();
    expect(h.playback.getState().playbackStop).toEqual({
      inPts: "25",
      outPts: "75",
      phase: "playing",
    });
    expect(b.element.currentTime).toBe(1);
  });

  it("does not go on when the run ended in the task that reached the stop", async () => {
    const h = threeSegments();
    const a = playingFirstPart(h);
    a.frame("99");
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
    h.sequence.store.getState().seekToPts(h.virtual("a1", "10"));
    await settle();
    expect(h.runState()).toBeNull();
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
    expect(h.playback.getState().playbackStop).toBeNull();
    expect(a.element.currentTime).toBeCloseTo(10 / 25, 9);
  });

  it("takes reached in the timer before it fails, and one time for a part", async () => {
    const h = threeSegments();
    const a = h.show(A);
    h.sequence.startProgramPlay("program", h.parts());
    a.seeked("50");
    a.frame("99");
    // The timer runs before the read of the run: it finds "reached" and goes on.
    h.clock.advance(PROGRAM_PART_TIMEOUT_MS);
    expect(h.runState()?.part).toBe(2);
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: false });
    await settle();
    expect(h.runState()?.part).toBe(2);
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: false });
  });

  it("does nothing for an empty list, also during a run", () => {
    const h = threeSegments();
    h.show(A);
    expect(h.sequence.startProgramPlay("joins", [])).toBe(false);
    expect(h.runState()).toBeNull();
    expect(h.playback.getState().segmentPlayback).toBeNull();
    h.sequence.startProgramPlay("program", h.parts());
    expect(h.sequence.startProgramPlay("joins", [])).toBe(false);
    expect(h.runState()).toEqual({ action: "program", part: 1, count: 3 });
  });

  it("ends a run for a new run, which starts at its own first part", async () => {
    const h = threeSegments();
    const a = playingFirstPart(h);
    const pauses = a.element.pauseCalls;
    const joins = h.parts("joins", "s2");
    expect(h.sequence.startProgramPlay("joins", joins)).toBe(true);
    expect(a.element.pauseCalls).toBeGreaterThan(pauses);
    expect(h.runState()).toEqual({ action: "joins", part: 1, count: joins.length });
    expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: false });
    expect(h.playback.getState().playbackStop).toEqual({
      inPts: "150",
      outPts: "200",
      phase: "playing",
    });
    await settle();
    expect(h.runState()?.action).toBe("joins");
  });

  it("drops the play intent of a Play Segment that crosses a junction", async () => {
    const h = program([a1, b1], [seg("s1", "a1", "50", "a1", "100")]);
    const a = h.show(A);
    h.sequence.store
      .getState()
      .playSegment(h.virtual("a1", "200"), h.virtual("b1", "50"));
    h.sequence.startProgramPlay("program", h.parts());
    a.seeked("50");
    a.frame("99");
    await settle();
    expect(h.runState()).toBeNull();
    // A later play of the user to the end of a1 goes on at b1 as a plain play, with no stop.
    h.playback.getState().play();
    h.playback.getState().syncPlay(a.key, a.element);
    h.sequence.notePause(true);
    h.playback.getState().syncPause(a.key, a.element);
    expect(h.sequence.handleEnded()).toBe(true);
    h.show(B);
    expect(h.playback.getState().playbackStop).toBeNull();
  });

  describe("the user takes the playback", () => {
    it("ends the run with the exported action: a pause, and no stop point, during the seek", async () => {
      const h = threeSegments();
      const a = h.show(A);
      h.sequence.startProgramPlay("program", h.parts());
      // The seek to the start of the part still runs.
      expect(a.element.seeking).toBe(true);
      expect(h.sequence.endProgramPlay()).toBe(true);
      expectEndedEarly(h);
      expect(a.element.paused).toBe(true);
      expect(h.sequence.endProgramPlay()).toBe(false);
      // The seek ends, and the frames of the segment change nothing.
      a.seeked("50");
      a.frame("99");
      await settle();
      expect(h.runState()).toBeNull();
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: false });
      expect(h.clock.active()).toBe(0);
    });

    it("turns the request that waits for the attach into a seek to the start of its part with no play", async () => {
      const h = threeSegments();
      const a = playingFirstPart(h);
      a.frame("99");
      await settle();
      expect(h.runState()?.part).toBe(2);
      a.seeked("150");
      a.frame("199");
      await settle();
      expect(h.runState()?.part).toBe(3);
      expect(h.timeline.getState().attachedClipId).toBe("b1");

      expect(h.sequence.endProgramPlay()).toBe(true);
      expect(h.runState()).toBeNull();
      // The clip that loads stays, and its request runs as a seek with no play.
      expect(h.timeline.getState().attachedClipId).toBe("b1");
      const b = h.show(B);
      expect(b.element.currentTime).toBe(1);
      expect(b.element.paused).toBe(true);
      expect(h.playback.getState().isPlaying).toBe(false);
      expect(h.playback.getState().playbackStop).toBeNull();
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: true });
    });

    it("does not stop the first-frame prime of the clip that loads", async () => {
      const h = program(
        [a1, b1],
        [seg("s1", "a1", "50", "a1", "100"), seg("s2", "b1", "25", "b1", "75")],
      );
      const a = h.show(A);
      h.sequence.startProgramPlay("program", h.parts());
      a.seeked("50");
      a.frame("99");
      await settle();
      const b = h.show(B, { calibrate: false });
      h.playback.getState().primeFirstFrame(b.key, b.element, () => false);
      expect(b.element.paused).toBe(false);
      expect(b.element.muted).toBe(true);

      expect(h.sequence.endProgramPlay()).toBe(true);
      expect(b.element.paused).toBe(false);
      // The first frame ends the prime, and the seek to the start of the part runs.
      b.present("0");
      expect(b.element.paused).toBe(true);
      expect(b.element.currentTime).toBe(1);
      expect(h.playback.getState().isPlaying).toBe(false);
      expect(h.playback.getState().playbackStop).toBeNull();
    });

    const takeovers: readonly (readonly [string, (h: Program, a: Screen) => void])[] = [
      [
        "seekToPts",
        (h) => h.sequence.store.getState().seekToPts(h.virtual("a1", "10")),
      ],
      ["seekApproximate", (h) => h.sequence.store.getState().seekApproximate(1)],
      ["seekNominal", (h) => void h.sequence.store.getState().seekNominal(1)],
      ["seekToFrameIndex", (h) => h.sequence.store.getState().seekToFrameIndex(10)],
      [
        "playSegment",
        (h) =>
          h.sequence.store
            .getState()
            .playSegment(h.virtual("a1", "0"), h.virtual("a1", "25")),
      ],
      ["play", (h) => h.sequence.store.getState().play()],
      ["pause", (h) => h.sequence.store.getState().pause()],
      ["togglePlayback", (h) => h.sequence.store.getState().togglePlayback()],
      ["resumeAfterSeek", (h) => h.sequence.store.getState().resumeAfterSeek()],
      ["recalibrate", (h, a) => h.sequence.store.getState().recalibrate(a.key)],
      [
        "reloadStalledPreview",
        (h, a) => h.sequence.store.getState().reloadStalledPreview(a.key),
      ],
      ["reset", (h) => h.sequence.store.getState().reset()],
      ["seekToClipFrame", (h) => h.sequence.seekToClipFrame("a1", 10)],
      ["dropNavigation", (h) => h.sequence.dropNavigation()],
      ["dropPlayIntent", (h) => h.sequence.dropPlayIntent()],
    ];

    it.each(takeovers)(
      "ends the run when another caller calls %s, with the pause first",
      async (_name, action) => {
        const h = threeSegments();
        const a = playingFirstPart(h);
        const writes: { stop: unknown; isPlaying: boolean; pauses: number }[] = [];
        h.playback.subscribe((state) => {
          writes.push({
            stop: state.playbackStop,
            isPlaying: state.isPlaying,
            pauses: a.element.pauseCalls,
          });
        });
        const pauses = a.element.pauseCalls;
        action(h, a);
        expect(h.runState()).toBeNull();
        // The end of the run comes before the action: the pause of the store drops the stop
        // point, and then pauses the element.
        expect(writes[0]?.stop).toBeNull();
        expect(writes[1]).toEqual({ stop: null, isPlaying: false, pauses: pauses + 1 });
        // The run does not go on: no later part of it plays.
        a.frame("99");
        await settle();
        h.clock.advance(PROGRAM_PART_TIMEOUT_MS);
        expect(h.runState()).toBeNull();
        expect(h.playback.getState().playbackStop?.inPts).not.toBe("150");
        expect(h.timeline.getState().attachedClipId).toBe("a1");
      },
    );
  });

  describe("the program changes", () => {
    const changes: readonly (readonly [string, (h: Program) => void])[] = [
      [
        "a segment is made",
        (h) => {
          h.timeline.getState().markIn(h.virtual("a1", "210"));
          h.timeline.getState().markOut(h.virtual("a1", "230"));
        },
      ],
      [
        "a segment is changed",
        (h) =>
          h.timeline.getState().trimSegmentEdge("s2", "out", h.virtual("a1", "210")),
      ],
      [
        "a segment is removed",
        (h) => {
          h.timeline.getState().selectSegment("s2");
          h.timeline.getState().deleteSelectedSegments();
        },
      ],
      [
        "the export order changes",
        (h) => void h.timeline.getState().reorderExportSegments(["s2", "s1", "s3"]),
      ],
      [
        "a clip joins the sequence",
        (h) =>
          void h.timeline
            .getState()
            .insertClips(2, [{ id: "a2", sourceId: "/a.mp4" }], [A.facts]),
      ],
      ["a clip leaves the sequence", (h) => h.timeline.getState().removeClip(1)],
      [
        "the placement of the clips changes",
        (h) => h.timeline.getState().moveClip(1, 0),
      ],
      [
        "a project opens",
        (h) =>
          void h.timeline
            .getState()
            .loadSequence(
              [a1, b1],
              [A.facts, B.facts],
              h.timeline.getState().sequenceSegments,
            ),
      ],
    ];

    it.each(changes)("ends the run when %s", async (_name, change) => {
      const h = threeSegments();
      playingFirstPart(h);
      const key = JSON.stringify(h.timeline.getState().sequenceSegments);
      const clips = h.timeline.getState().clips;
      const generation = h.timeline.getState().generation;
      change(h);
      // The change took effect.
      expect(
        JSON.stringify(h.timeline.getState().sequenceSegments) !== key ||
          h.timeline.getState().clips !== clips ||
          h.timeline.getState().generation !== generation,
      ).toBe(true);
      await settle();
      expectEndedEarly(h);
    });

    it("ends the run at an Undo of an edit of the program", async () => {
      const h = threeSegments();
      expect(h.timeline.getState().reorderExportSegments(["s1", "s3", "s2"])).toBe(
        "reordered",
      );
      expect(h.timeline.getState().canUndo).toBe(true);
      playingFirstPart(h);
      h.timeline.getState().undo();
      await settle();
      expectEndedEarly(h);
    });

    it("does not end the run for the selection, a name or the length of an element", async () => {
      const h = threeSegments();
      playingFirstPart(h);
      h.timeline.getState().selectSegment("s2");
      h.timeline.getState().toggleSegmentSelection("s3");
      h.timeline.getState().renameSegment("s1", "Intro");
      h.timeline.getState().setBrowserDuration("/a.mp4", 10);
      await settle();
      expect(h.runState()?.part).toBe(1);
      expect(h.playback.getState().playbackStop?.phase).toBe("playing");
    });
  });

  describe("the run fails", () => {
    it("when the seek to the start of a part does not end in 10 seconds", async () => {
      const h = threeSegments();
      const a = h.show(A);
      h.sequence.startProgramPlay("program", h.parts());
      h.clock.advance(PROGRAM_PART_TIMEOUT_MS - 1);
      expect(h.runState()?.part).toBe(1);
      h.clock.advance(1);
      expectEndedEarly(h);
      expect(a.element.paused).toBe(true);
      await settle();
      expect(h.runState()).toBeNull();
    });

    /**
     * Plays `screen` with no frame, as in a hidden window: a `timeupdate` each 250 ms of the
     * fake timer, from `from` seconds to `to` seconds of the element.
     */
    async function playHidden(
      h: Program,
      screen: Screen,
      from: number,
      to: number,
    ): Promise<void> {
      for (
        let quarter = Math.round(from * 4);
        quarter <= Math.round(to * 4);
        quarter += 1
      ) {
        h.clock.advance(250);
        screen.tick(quarter / 4);
        await settle();
      }
    }

    /** The sequence a1, c1 with `parts` segments on c1, and the element of c1 on screen. */
    function onLongClip(segments: readonly SequenceSegment[], keepCancelled = false) {
      const h = program([a1, c1], segments, [A, C], keepCancelled);
      h.timeline.getState().setAttachedClip("c1");
      const c = h.show(C);
      return { h, c };
    }

    it("not for a part of 25 seconds in a hidden window, which the clock of the store stops", async () => {
      const { h, c } = onLongClip([
        seg("s1", "c1", "25", "c1", "650"),
        seg("s2", "c1", "700", "c1", "750"),
      ]);
      h.sequence.startProgramPlay("program", h.parts());
      expect(c.element.currentTime).toBe(1);
      // The seek ends with no frame: the display target of the seek stays set.
      c.landed();
      expect(h.playback.getState().seekTargetSeconds).toBe(1);
      expect(h.playback.getState().approximateBrowserTimeSeconds).toBe(1);
      await playHidden(h, c, 1.25, 26);
      expect(h.runState()).toEqual({ action: "program", part: 1, count: 2 });
      // The clock passes the Out at 26 s, and the store stops the playback.
      h.clock.advance(100);
      c.tick(26.1);
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
      await settle();
      expect(h.runState()?.part).toBe(2);
      expect(h.playback.getState().playbackStop).toEqual({
        inPts: "700",
        outPts: "750",
        phase: "playing",
      });
    });

    it("10 seconds after the last change of the clock when the play of the element never starts", async () => {
      const h = threeSegments();
      const a = h.show(A);
      a.element.play = () => new Promise<void>(() => undefined);
      h.sequence.startProgramPlay("program", h.parts());
      expect(h.playback.getState().isPlaying).toBe(true);
      h.clock.advance(5_000);
      // A frame of the seek clears the display target, and the clock takes the landing.
      a.seeked("50");
      a.tick(2);
      expect(h.playback.getState().seekTargetSeconds).toBeNull();
      await settle();
      h.clock.advance(PROGRAM_PART_TIMEOUT_MS - 1);
      expect(h.runState()?.part).toBe(1);
      const pauses = a.element.pauseCalls;
      h.clock.advance(1);
      expectEndedEarly(h);
      expect(a.element.pauseCalls).toBe(pauses + 1);
    });

    it("10 seconds after a gap skip that replaced the seek, and not at 10 seconds", async () => {
      const h = threeSegments();
      const a = h.show(A);
      h.sequence.startProgramPlay("program", h.parts());
      // The seek waits at 2.00 s.
      a.tick(2);
      await settle();
      h.clock.advance(9_900);
      // A gap skip moves the seek to 3.00 s, and then nothing moves.
      a.tick(3);
      await settle();
      // 10 s after the request: the run goes on.
      h.clock.advance(100);
      expect(h.runState()?.part).toBe(1);
      // 19.9 s after the request, 10 s after the gap skip: the run fails.
      h.clock.advance(9_899);
      expect(h.runState()?.part).toBe(1);
      h.clock.advance(1);
      expectEndedEarly(h);
    });

    it("not when the seek lands at the clock that the store holds, and the part then plays", async () => {
      const { h, c } = onLongClip([
        seg("s1", "c1", "50", "c1", "400"),
        seg("s2", "c1", "700", "c1", "750"),
      ]);
      // The element stands at 2 s, the start of the part.
      c.tick(2);
      h.sequence.startProgramPlay("program", h.parts());
      // The seek lands where the clock stands: the store writes no clock.
      c.landed();
      expect(h.playback.getState().approximateBrowserTimeSeconds).toBe(2);
      await playHidden(h, c, 2.25, 16);
      h.clock.advance(100);
      c.tick(16.1);
      await settle();
      expect(h.runState()?.part).toBe(2);
    });

    /**
     * Part one on a1 completes at 0 s, and the clip of part two, b1, loads for 9.9 s. Its element
     * stands at 1 s, the start of part two, before its first frame, so the seek to the start
     * changes no clock. The store accepts part two at 9.9 s.
     */
    async function acceptedAfterSlowLoad() {
      const h = program(
        [a1, b1],
        [seg("s1", "a1", "50", "a1", "100"), seg("s2", "b1", "25", "b1", "75")],
      );
      const a = h.show(A);
      h.sequence.startProgramPlay("program", h.parts());
      a.seeked("50");
      a.frame("99");
      await settle();
      expect(h.runState()?.part).toBe(2);
      h.clock.advance(9_000);
      const b = h.show(B, { calibrate: false });
      b.tick(1);
      h.clock.advance(900);
      b.present("0");
      await settle();
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: false });
      expect(h.playback.getState().approximateBrowserTimeSeconds).toBe(1);
      return { h, b };
    }

    it("not when the store accepts a part at 9.9 s and its clock first changes at 10.2 s", async () => {
      const { h, b } = await acceptedAfterSlowLoad();
      // The seek lands on the clock that the store holds, and the element plays.
      b.landed();
      h.clock.advance(100);
      expect(h.runState()?.part).toBe(2);
      h.clock.advance(200);
      b.tick(1.3);
      await settle();
      await playHidden(h, b, 1.5, 3);
      expect(h.runState()?.part).toBe(2);
      // The clock passes the Out at 3 s, and the last part completes.
      b.tick(3.1);
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: true });
      await settle();
      expect(h.runState()).toBeNull();
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: true });
    });

    it("10 seconds after the acceptance at 9.9 s of a part whose clock never changes", async () => {
      const { h, b } = await acceptedAfterSlowLoad();
      b.landed();
      await settle();
      h.clock.advance(9_999);
      expect(h.runState()?.part).toBe(2);
      h.clock.advance(1);
      expectEndedEarly(h);
    });

    it("not again for a write of the store that keeps the clock of the acceptance", async () => {
      const { h, b } = await acceptedAfterSlowLoad();
      h.clock.advance(5_000);
      // The seek lands with a frame at 14.9 s: the store writes, and the clock stays at 1 s.
      b.seeked("25");
      expect(h.playback.getState().approximateBrowserTimeSeconds).toBe(1);
      await settle();
      h.clock.advance(4_999);
      expect(h.runState()?.part).toBe(2);
      h.clock.advance(1);
      expectEndedEarly(h);
    });

    it("not again for a change of the clock before the store accepted the part", async () => {
      const h = program([a1, b1], [seg("s1", "b1", "25", "b1", "75")]);
      const a = h.show(A);
      h.playback.getState().play();
      h.playback.getState().syncPlay(a.key, a.element);
      h.sequence.startProgramPlay("program", h.parts());
      expect(h.timeline.getState().attachedClipId).toBe("b1");
      // a1 still plays while the element of b1 never becomes ready.
      for (let quarter = 1; quarter < 40; quarter += 1) {
        h.clock.advance(250);
        a.tick(quarter / 4);
        await settle();
      }
      expect(h.runState()?.part).toBe(1);
      h.clock.advance(250);
      expectEndedEarly(h);
    });

    it.each([
      [9_000, false],
      [10_000, true],
    ])(
      "for a part of 30 seconds whose clock stops for %i ms in the middle: fails %s",
      async (stall, fails) => {
        const { h, c } = onLongClip([
          seg("s1", "c1", "25", "c1", "775"),
          seg("s2", "c1", "800", "c1", "850"),
        ]);
        h.sequence.startProgramPlay("program", h.parts());
        c.landed();
        await playHidden(h, c, 1.25, 15);
        // A stall of the page: no `timeupdate` for a while.
        h.clock.advance(stall);
        await settle();
        if (fails) {
          expectEndedEarly(h);
          return;
        }
        expect(h.runState()?.part).toBe(1);
        await playHidden(h, c, 15.25, 31);
        h.clock.advance(100);
        c.tick(31.1);
        await settle();
        expect(h.runState()?.part).toBe(2);
      },
    );

    it("not by the timer of a part that completed, or of a run that ended", async () => {
      const { h, c } = onLongClip(
        [
          seg("s1", "c1", "25", "c1", "50"),
          seg("s2", "c1", "100", "c1", "125"),
          seg("s3", "c1", "200", "c1", "225"),
        ],
        true,
      );
      h.sequence.startProgramPlay("program", h.parts());
      h.clock.advance(5_000);
      // Part one completes at 5 s, and part two starts with a watchdog of its own.
      c.seeked("25");
      c.frame("49");
      await settle();
      expect(h.runState()?.part).toBe(2);
      // The watchdog of part one runs out at 10 s, and changes nothing.
      h.clock.advance(5_000);
      expect(h.runState()?.part).toBe(2);
      h.clock.advance(4_999);
      expect(h.runState()?.part).toBe(2);
      // The run ends, and a new run starts at 15 s.
      expect(h.sequence.endProgramPlay()).toBe(true);
      h.sequence.startProgramPlay("program", h.parts());
      expect(h.runState()?.part).toBe(1);
      // The watchdog of part two of the old run runs out at 15 s, and changes nothing.
      h.clock.advance(1);
      expect(h.runState()).toEqual({ action: "program", part: 1, count: 3 });
      h.clock.advance(9_998);
      expect(h.runState()?.part).toBe(1);
      h.clock.advance(1);
      expectEndedEarly(h);
    });

    it("when the clip of a part shows no first frame in 10 seconds, and keeps its load", async () => {
      const h = program(
        [a1, b1],
        [seg("s1", "a1", "50", "a1", "100"), seg("s2", "b1", "25", "b1", "75")],
      );
      const a = h.show(A);
      h.sequence.startProgramPlay("program", h.parts());
      a.seeked("50");
      a.frame("99");
      await settle();
      const b = h.show(B, { calibrate: false });
      h.playback.getState().primeFirstFrame(b.key, b.element, () => false);
      h.clock.advance(PROGRAM_PART_TIMEOUT_MS);
      expect(h.runState()).toBeNull();
      // The prime goes on, and the request runs as a seek to the start of the part.
      expect(b.element.paused).toBe(false);
      b.present("0");
      expect(b.element.currentTime).toBe(1);
      expect(b.element.paused).toBe(true);
      expect(h.playback.getState().playbackStop).toBeNull();
    });

    it("when the stop point goes and the store did not publish reached", async () => {
      const h = threeSegments();
      const a = playingFirstPart(h);
      // A pause from the system, away from the end of the media.
      a.element.paused = true;
      h.playback.getState().syncPause(a.key, a.element);
      expect(h.playback.getState().playbackStop).toBeNull();
      await settle();
      expectEndedEarly(h);
    });

    it("when the playback has an error", async () => {
      const h = threeSegments();
      const a = h.show(A);
      a.element.play = () => {
        a.element.paused = false;
        return Promise.reject(new Error("refused"));
      };
      h.sequence.startProgramPlay("program", h.parts());
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: false });
      await settle();
      expect(h.playback.getState().error).toBe("playbackFailed");
      expectEndedEarly(h);
    });

    it("when the playback has a decode stall", async () => {
      const h = threeSegments();
      const a = playingFirstPart(h);
      expect(h.playback.getState().syncDecodeStall(a.key, a.element)).toBe(true);
      await settle();
      expectEndedEarly(h);
    });

    it("when the element is loaded again for another audio track", async () => {
      const h = threeSegments();
      const a = playingFirstPart(h);
      h.sequence.store.getState().replacePreviewElement(a.key);
      expect(h.playback.getState().reloadGeneration).toBe(1);
      await settle();
      expectEndedEarly(h);
    });

    it("when the element of the clip that loads is loaded again", async () => {
      const h = program(
        [a1, b1],
        [seg("s1", "a1", "50", "a1", "100"), seg("s2", "b1", "25", "b1", "75")],
      );
      const a = h.show(A);
      h.sequence.startProgramPlay("program", h.parts());
      a.seeked("50");
      a.frame("99");
      await settle();
      const b = h.show(B, { calibrate: false });
      h.sequence.store.getState().replacePreviewElement(b.key);
      expect(h.playback.getState().reloadGeneration).toBe(1);
      await settle();
      expect(h.runState()).toBeNull();
      expect(h.timeline.getState().attachedClipId).toBe("b1");
    });

    it("when the store does not accept a part", async () => {
      const h = threeSegments();
      const a = h.show(A);
      // A part that holds no frame.
      const empty: ProgramPart = {
        segmentId: "s1",
        clipId: "a1",
        sourceId: "/a.mp4",
        startPts: pts("50"),
        endPts: pts("50"),
      };
      expect(h.sequence.startProgramPlay("program", [empty])).toBe(true);
      expect(h.runState()).toEqual({ action: "program", part: 1, count: 1 });
      await settle();
      expect(h.runState()).toBeNull();
      expect(h.playback.getState().segmentPlayback).toBeNull();
      expect(a.element.paused).toBe(true);
    });

    it("when the start of a part is not before the end of the media", async () => {
      const h = threeSegments();
      // The element ends at 5 s, and the second part starts at 6 s.
      const a = h.show(A, { duration: 5 });
      h.sequence.startProgramPlay("program", h.parts());
      a.seeked("50");
      a.frame("99");
      await settle();
      expect(h.runState()).toBeNull();
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
      expect(a.element.currentTime).toBeLessThan(5);
    });

    it("when the length of the element of the next clip comes after its calibration, before the start", async () => {
      const h = program(
        [a1, b1],
        [seg("s1", "a1", "50", "a1", "100"), seg("s2", "b1", "150", "b1", "200")],
      );
      const a = h.show(A);
      h.sequence.startProgramPlay("program", h.parts());
      a.seeked("50");
      a.frame("99");
      await settle();
      expect(h.runState()?.part).toBe(2);
      // In one task, the first frame calibrates b1, and then its length of 5 s comes. The part
      // starts at 6 s.
      const b = h.show(B, { duration: 5, lengthAfterFrame: true });
      await settle();
      expect(h.runState()).toBeNull();
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
      expect(h.playback.getState().playbackStop).toBeNull();
      expect(b.element.paused).toBe(true);
    });

    it("when a reload of ADR 063 replaces the element of the clip that the part waits for", async () => {
      const h = program(
        [a1, b1],
        [seg("s1", "a1", "50", "a1", "100"), seg("s2", "b1", "25", "b1", "75")],
      );
      const a = h.show(A);
      h.sequence.startProgramPlay("program", h.parts());
      a.seeked("50");
      a.frame("99");
      await settle();
      const b = h.show(B, { calibrate: false });
      // Only a seek that the store defers during the calibration lets the wait for the first
      // frame run out. No caller of the sequence playback can make one during a run, so the test
      // seeks on the store itself.
      h.playback.getState().seekApproximate(3);
      expect(h.playback.getState().hasDeferredNavigation).toBe(true);
      h.playback.getState().syncAnchorWaitExpired(b.key, b.element);
      expect(h.playback.getState().reloadGeneration).toBe(1);
      expect(h.playback.getState().isRecalibrating).toBe(true);
      await settle();
      expect(h.runState()).toBeNull();
      expect(h.timeline.getState().attachedClipId).toBe("b1");

      // The new element gets the seek to the start of the part, with no play.
      h.playback.getState().detach(b.key, b.element);
      const next = h.show(B);
      await settle();
      expect(next.element.currentTime).toBe(1);
      expect(next.element.paused).toBe(true);
      expect(h.playback.getState().isPlaying).toBe(false);
      expect(h.playback.getState().playbackStop).toBeNull();
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
    });

    it.each([
      [
        "the program changes",
        (h: Program) =>
          void h.timeline.getState().reorderExportSegments(["s2", "s1", "s3"]),
      ],
      [
        "a reload starts",
        (h: Program) =>
          h.sequence.store
            .getState()
            .replacePreviewElement(
              h.playback.getState().attachedSourceRevisionKey ?? "",
            ),
      ],
    ])("when %s in the task that reached the stop", async (_name, change) => {
      const h = threeSegments();
      const a = playingFirstPart(h);
      let asked = 0;
      const playSegment = h.playback.getState().playSegment;
      h.playback.setState({
        playSegment: (inPts, outPts) => {
          asked += 1;
          playSegment(inPts, outPts);
        },
      });
      a.frame("99");
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
      change(h);
      await settle();
      // The run did not ask for the next part.
      expect(asked).toBe(0);
      expect(h.runState()).toBeNull();
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
      expect(h.playback.getState().isPlaying).toBe(false);
    });
  });

  describe("the preview gives up an element", () => {
    function waitingForB() {
      const h = program(
        [a1, b1],
        [seg("s1", "a1", "50", "a1", "100"), seg("s2", "b1", "25", "b1", "75")],
      );
      const a = h.show(A);
      h.sequence.startProgramPlay("program", h.parts());
      a.seeked("50");
      a.frame("99");
      return { h, a };
    }

    it("ends the run at once when the element of the clip of the waiting part fails", async () => {
      const { h } = waitingForB();
      await settle();
      expect(h.runState()?.part).toBe(2);
      const b = h.show(B, { calibrate: false });
      // The path of a fatal failure of the pane: the element is marked unready, and it leaves
      // the tree.
      h.playback.getState().syncUnready(b.key, b.element);
      h.sequence.notePreviewFailure(b.key);
      expect(h.runState()).toBeNull();
      h.playback.getState().detach(b.key, b.element);
      await settle();
      h.clock.advance(PROGRAM_PART_TIMEOUT_MS);
      expect(h.runState()).toBeNull();

      // The user loads the clip again: its request runs as a seek with no play.
      const again = h.show(B);
      await settle();
      expect(again.element.currentTime).toBe(1);
      expect(again.element.paused).toBe(true);
      expect(h.playback.getState().isPlaying).toBe(false);
      expect(h.playback.getState().playbackStop).toBeNull();
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 1, reached: true });
    });

    it("does nothing for a failure of another source", async () => {
      const { h, a } = waitingForB();
      await settle();
      h.sequence.notePreviewFailure(a.key);
      expect(h.runState()?.part).toBe(2);
    });

    it("takes the usual cold switch for no failure", async () => {
      const { h, a } = waitingForB();
      await settle();
      // The old element leaves before the new one attaches.
      h.playback.getState().detach(a.key, a.element);
      await settle();
      expect(h.runState()?.part).toBe(2);
      const b = h.show(B);
      await settle();
      expect(h.runState()?.part).toBe(2);
      expect(h.playback.getState().segmentPlayback).toEqual({ id: 2, reached: false });
      b.seeked("25");
      b.frame("74");
      await settle();
      expect(h.runState()).toBeNull();
    });
  });
});
