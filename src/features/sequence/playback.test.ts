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
});
