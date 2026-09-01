import { describe, expect, it, vi } from "vitest";
import { getSourceRevisionKey } from "@/features/media";
import type { Pts } from "@/types/project";
import { createPlaybackStore, getNominalFrameRate } from "./store";
import type { PlaybackMediaElement, PlaybackSource } from "./types";

/**
 * Creates a minimal fake video element for isolated unit testing.
 */
function createFakeVideo(options?: {
  playImpl?: () => Promise<void> | void;
  pauseImpl?: () => void;
  initialCurrentTime?: number;
  throwOnCurrentTimeSet?: boolean;
  readyState?: number;
  duration?: number;
}): PlaybackMediaElement & {
  playCalls: number;
  pauseCalls: number;
  readyState: number;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
} {
  let currentTimeVal = options?.initialCurrentTime ?? 0;
  let readyStateVal = options?.readyState ?? 0;

  const fake = {
    playCalls: 0,
    pauseCalls: 0,
    get readyState() {
      return readyStateVal;
    },
    set readyState(val: number) {
      readyStateVal = val;
    },
    get currentTime() {
      return currentTimeVal;
    },
    duration: options?.duration ?? Number.NaN,
    set currentTime(val: number) {
      if (options?.throwOnCurrentTimeSet) {
        throw new DOMException(
          "The element cannot be seeked in its current state.",
          "InvalidStateError",
        );
      }
      currentTimeVal = val;
    },
    play: vi.fn(() => {
      fake.playCalls++;
      if (options?.playImpl) {
        return options.playImpl();
      }
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      fake.pauseCalls++;
      if (options?.pauseImpl) {
        options.pauseImpl();
      }
    }),
  };
  return fake;
}

/**
 * Flushes pending microtasks.
 */
async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Playback Store & PTS Presentation Engine", () => {
  const tb25 = { n: 1, d: 25 };
  const tbNtsc = { n: 1001, d: 30000 };
  const fps25 = { n: 25, d: 1 };
  const fpsNtsc = { n: 30000, d: 1001 };

  const sourceA: PlaybackSource = {
    path: "/media/clipA.mp4",
    size: 1048576,
    mtime: 1724976000,
    videoTimeBase: tb25,
    videoStartPts: "0" as Pts,
    avgFrameRate: fps25,
    rFrameRate: fps25,
    approximateDurationSeconds: 10.0,
  };

  const sourceB: PlaybackSource = {
    path: "/media/clipB.mp4",
    size: 2097152,
    mtime: 1724976500,
    videoTimeBase: tbNtsc,
    videoStartPts: "1000" as Pts,
    avgFrameRate: fpsNtsc,
    rFrameRate: fpsNtsc,
    approximateDurationSeconds: 15.0,
  };

  const identityA = getSourceRevisionKey(sourceA);
  const identityB = getSourceRevisionKey(sourceB);

  describe("Initial State & No-Media No-Op", () => {
    it("initializes with default serializable public state", () => {
      const store = createPlaybackStore();
      const state = store.getState();

      expect(state.presentedFrame).toBeNull();
      expect(state.calibrationStatus).toBe("unavailable");
      expect(state.runtimeBrowserDurationSeconds).toBeNull();
      expect(state.isPlaying).toBe(false);
      expect(state.isAttached).toBe(false);
      expect(state.isReady).toBe(false);
      expect(state.error).toBeNull();
    });

    it("safely ignores actions when no media is attached without throwing", () => {
      const store = createPlaybackStore();
      const fakeVideo = createFakeVideo();

      expect(() => {
        store.getState().play();
        store.getState().pause();
        store.getState().togglePlayback();
        store.getState().seekToPts("0" as Pts);
        store.getState().seekNominal(1);
        store.getState().seekNominal(-1);
        store.getState().syncReady("some-id", fakeVideo);
        store.getState().syncUnready("some-id", fakeVideo);
        store.getState().syncPresentedFrame("some-id", 0.0, 1, fakeVideo);
        store.getState().syncPlay("some-id", fakeVideo);
        store.getState().syncPause("some-id", fakeVideo);
        store.getState().syncEnded("some-id", fakeVideo);
        store.getState().detach("some-id", fakeVideo);
        store.getState().reset();
      }).not.toThrow();

      expect(store.getState().presentedFrame).toBeNull();
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().isAttached).toBe(false);
      expect(store.getState().isReady).toBe(false);
      expect(store.getState().error).toBeNull();
    });
  });

  describe("Attachment, Readiness Lifecycle & Source Validation", () => {
    it("attaches unready in calibrating state when videoStartPts exists", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      expect(store.getState().isAttached).toBe(true);
      expect(store.getState().isReady).toBe(false);
      expect(store.getState().calibrationStatus).toBe("calibrating");
      expect(store.getState().presentedFrame).toBeNull();

      // syncReady with matching source and element
      store.getState().syncReady(identityA, video);
      expect(store.getState().isReady).toBe(true);
    });

    it("rejects syncReady with mismatched source identity or mismatched element", () => {
      const store = createPlaybackStore();
      const video1 = createFakeVideo();
      const video2 = createFakeVideo();

      store.getState().attach(sourceA, video1);

      // Mismatched source identity
      store.getState().syncReady(identityB, video1);
      expect(store.getState().isReady).toBe(false);

      // Mismatched element
      store.getState().syncReady(identityA, video2);
      expect(store.getState().isReady).toBe(false);

      // Correct source identity and element
      store.getState().syncReady(identityA, video1);
      expect(store.getState().isReady).toBe(true);
    });

    it("keeps playback attached but makes precise editing unavailable for an invalid videoTimeBase", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      // Non-positive timebase numerator
      store.getState().attach({ ...sourceA, videoTimeBase: { n: 0, d: 25 } }, video);
      expect(store.getState().isAttached).toBe(true);
      expect(store.getState().calibrationStatus).toBe("unavailable");
      store.getState().reset();

      // Non-positive timebase denominator
      store.getState().attach({ ...sourceA, videoTimeBase: { n: 1, d: 0 } }, video);
      expect(store.getState().isAttached).toBe(true);
      expect(store.getState().calibrationStatus).toBe("unavailable");
      store.getState().reset();

      // Fractional timebase component
      store.getState().attach({ ...sourceA, videoTimeBase: { n: 1.5, d: 25 } }, video);
      expect(store.getState().isAttached).toBe(true);
      expect(store.getState().calibrationStatus).toBe("unavailable");
    });

    it("syncUnready clears readiness and playing, and invalidates pending play session", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPlay(identityA, video);
      expect(store.getState().isPlaying).toBe(true);
      expect(store.getState().isReady).toBe(true);

      // Mismatched syncUnready is ignored
      store.getState().syncUnready(identityB, video);
      expect(store.getState().isReady).toBe(true);
      expect(store.getState().isPlaying).toBe(true);

      // Matching syncUnready
      store.getState().syncUnready(identityA, video);
      expect(store.getState().isReady).toBe(false);
      expect(store.getState().isPlaying).toBe(false);
    });

    it("detach clears attachment, readiness, playing, and calibration", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");

      store.getState().detach(identityA, video);
      expect(store.getState().isAttached).toBe(false);
      expect(store.getState().isReady).toBe(false);
      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();
    });

    it("synchronously derives readiness when attached element readyState >= HAVE_METADATA", () => {
      const store = createPlaybackStore();
      const readyVideo = createFakeVideo({ readyState: 1 });

      store.getState().attach(sourceA, readyVideo);
      expect(store.getState().isAttached).toBe(true);
      expect(store.getState().isReady).toBe(true);
    });

    it("guards detachment against mismatched element instance or old source identity", () => {
      const store = createPlaybackStore();
      const video1 = createFakeVideo();
      const video2 = createFakeVideo();

      store.getState().attach(sourceA, video1);
      store.getState().syncReady(identityA, video1);

      // Detach called with wrong element
      store.getState().detach(identityA, video2);
      expect(store.getState().isAttached).toBe(true);
      expect(store.getState().isReady).toBe(true);

      // Detach called with wrong source identity
      store.getState().detach(identityB, video1);
      expect(store.getState().isAttached).toBe(true);
      expect(store.getState().isReady).toBe(true);
    });

    it("source replacement pauses previous element, clears readiness, and resets calibration", () => {
      const store = createPlaybackStore();
      const video1 = createFakeVideo();
      const video2 = createFakeVideo();

      store.getState().attach(sourceA, video1);
      store.getState().syncReady(identityA, video1);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video1);
      expect(store.getState().calibrationStatus).toBe("ready");

      // Replace with source B
      store.getState().attach(sourceB, video2);
      expect(video1.pauseCalls).toBe(1);
      expect(store.getState().calibrationStatus).toBe("calibrating");
      expect(store.getState().presentedFrame).toBeNull();
      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().isAttached).toBe(true);
      expect(store.getState().isReady).toBe(false);
    });
  });

  describe("PTS Calibration & Inferred PTS from RVFC", () => {
    it("calibrates first presented frame to videoStartPts and infers later PTS with slope-one mapping", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      expect(store.getState().calibrationStatus).toBe("calibrating");
      expect(store.getState().presentedFrame).toBeNull();

      // First RVFC callback at mediaTime 0.0
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame).toEqual({
        mediaTime: 0.0,
        inferredSourcePts: "0",
      });

      // Second RVFC callback 1.0s later (25 ticks delta at tb25)
      store.getState().syncPresentedFrame(identityA, 1.0, 26, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame).toEqual({
        mediaTime: 1.0,
        inferredSourcePts: "25",
      });

      // Third RVFC callback at 2.04s (51 ticks delta at tb25)
      store.getState().syncPresentedFrame(identityA, 2.04, 52, video);
      expect(store.getState().presentedFrame).toEqual({
        mediaTime: 2.04,
        inferredSourcePts: "51",
      });
    });

    it("calibrates correctly with nonzero videoStartPts and nonzero initial mediaTime (no seekable origin)", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      // sourceB has videoStartPts "1000"
      store.getState().attach(sourceB, video);
      store.getState().syncReady(identityB, video);

      // Browser begins playback at mediaTime 1.5s
      store.getState().syncPresentedFrame(identityB, 1.5, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame).toEqual({
        mediaTime: 1.5,
        inferredSourcePts: "1000",
      });

      // Next frame at mediaTime 2.501s (~30 frames later in 1001/30000 timebase = ~30 ticks)
      const deltaSeconds = (30 * 1001) / 30000;
      store.getState().syncPresentedFrame(identityB, 1.5 + deltaSeconds, 31, video);
      expect(store.getState().presentedFrame).toEqual({
        mediaTime: 1.5 + deltaSeconds,
        inferredSourcePts: "1030",
      });
    });

    it("calibrates correctly with negative videoStartPts (ADR 002)", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      const negativeSource: PlaybackSource = {
        ...sourceA,
        videoStartPts: "-50" as Pts,
      };
      const negIdentity = getSourceRevisionKey(negativeSource);

      store.getState().attach(negativeSource, video);
      store.getState().syncReady(negIdentity, video);

      // First callback
      store.getState().syncPresentedFrame(negIdentity, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame).toEqual({
        mediaTime: 0.0,
        inferredSourcePts: "-50",
      });

      // 1.0s later (25 ticks at tb25): -50 + 25 = -25
      store.getState().syncPresentedFrame(negIdentity, 1.0, 26, video);
      expect(store.getState().presentedFrame).toEqual({
        mediaTime: 1.0,
        inferredSourcePts: "-25",
      });

      // 2.0s later (50 ticks at tb25): -50 + 50 = 0
      store.getState().syncPresentedFrame(negIdentity, 2.0, 51, video);
      expect(store.getState().presentedFrame).toEqual({
        mediaTime: 2.0,
        inferredSourcePts: "0",
      });
    });
  });

  describe("Missing start_pts & Missing RVFC", () => {
    it("handles missing start_pts by setting calibrationStatus to unavailable while allowing playback", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      const noStartPtsSource: PlaybackSource = {
        ...sourceA,
        videoStartPts: null,
      };
      const identity = getSourceRevisionKey(noStartPtsSource);

      store.getState().attach(noStartPtsSource, video);
      store.getState().syncReady(identity, video);

      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();

      // RVFC callback does not make calibration ready
      store.getState().syncPresentedFrame(identity, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();

      // Playback still works
      store.getState().play();
      expect(store.getState().isPlaying).toBe(true);
      expect(video.playCalls).toBe(1);

      store.getState().pause();
      expect(store.getState().isPlaying).toBe(false);

      // seekToPts fails
      store.getState().seekToPts("0" as Pts);
      expect(store.getState().error).toBe("seekFailed");
    });

    it("handles missing RVFC without corrupting playback state", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentationUnavailable(identityA, video);

      // Element plays and pauses without any RVFC calls
      store.getState().play();
      expect(store.getState().isPlaying).toBe(true);

      store.getState().pause();
      expect(store.getState().isPlaying).toBe(false);

      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();
    });
  });

  describe("Duplicate Inferred PTS Detection & Precision Loss", () => {
    it("detects a later distinct presented frame that maps to the same inferred PTS and makes precision unavailable", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // 1. Initial calibration callback
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");

      // A distinct mediaTime identifies a distinct presentation even without presentedFrames.
      store.getState().syncPresentedFrame(identityA, 0.00001, undefined, video);

      // Calibration becomes unavailable
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();

      // Subsequent frame callbacks do not restore precision
      store.getState().syncPresentedFrame(identityA, 1.0, 26, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();
    });

    it("does not trigger duplicate detection when mediaTime identifies the same presentation", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");

      store.getState().syncPresentedFrame(identityA, 0.0, 2, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
    });

    it.each([Number.NaN, Infinity, -1])(
      "makes calibration unavailable for invalid RVFC mediaTime %s",
      (mediaTime) => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        store.getState().attach(sourceA, video);
        store.getState().syncReady(identityA, video);

        store.getState().syncPresentedFrame(identityA, mediaTime, undefined, video);
        expect(store.getState().calibrationStatus).toBe("unavailable");
        expect(store.getState().presentedFrame).toBeNull();
      },
    );

    it("makes ready calibration unavailable when inference conversion fails", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0, undefined, video);
      expect(store.getState().calibrationStatus).toBe("ready");

      store.getState().syncPresentedFrame(identityA, Number.MAX_VALUE, undefined, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();
    });
  });

  describe("seekToPts & Pending Seek Until RVFC", () => {
    it("seeks to target PTS via inverse mapping without updating inferred PTS optimistically", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // Calibrate at 0.0
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");

      // Seek to PTS 50 (at tb25: 50 * 1/25 = 2.0s)
      store.getState().seekToPts("50" as Pts);
      expect(video.currentTime).toBeCloseTo(2.0, 9);
      expect(video.pauseCalls).toBe(1);

      expect(store.getState().presentedFrame).toBeNull();

      // RVFC fires for the sought frame
      store.getState().syncPresentedFrame(identityA, 2.0, 51, video);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("50");
    });

    it("reports seekFailed when targetPts is invalid string or causes arithmetic failure", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // Invalid PTS formats
      store.getState().seekToPts("invalid" as Pts);
      expect(store.getState().error).toBe("seekFailed");

      store.getState().seekToPts("+50" as Pts);
      expect(store.getState().error).toBe("seekFailed");

      store.getState().seekToPts("01" as Pts);
      expect(store.getState().error).toBe("seekFailed");
    });

    it("reports seekFailed when seekToPts is called before calibration is ready", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // Still in calibrating state
      store.getState().seekToPts("25" as Pts);
      expect(store.getState().error).toBe("seekFailed");
    });

    it("reports seekFailed when video.currentTime setter throws", () => {
      const throwingVideo = createFakeVideo({ throwOnCurrentTimeSet: true });
      const store = createPlaybackStore();

      store.getState().attach(sourceA, throwingVideo);
      store.getState().syncReady(identityA, throwingVideo);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, throwingVideo);

      store.getState().seekToPts("25" as Pts);
      expect(store.getState().error).toBe("seekFailed");
    });
  });

  describe("Nominal Seek Hints", () => {
    it("chooses avgFrameRate then rFrameRate and steps currentTime by nominal frame duration", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // +1 frame hint at 25 fps -> +0.04s
      store.getState().seekNominal(1);
      expect(video.currentTime).toBeCloseTo(0.04, 9);
      expect(video.pauseCalls).toBe(1);

      // +5 frames hint -> +0.20s -> 0.24s
      store.getState().seekNominal(5);
      expect(video.currentTime).toBeCloseTo(0.24, 9);

      // -2 frames hint -> -0.08s -> 0.16s
      store.getState().seekNominal(-2);
      expect(video.currentTime).toBeCloseTo(0.16, 9);
    });

    it("falls back to rFrameRate when avgFrameRate is unavailable", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      const rFrameOnlySource: PlaybackSource = {
        ...sourceA,
        avgFrameRate: null,
        rFrameRate: fpsNtsc,
      };
      const identity = getSourceRevisionKey(rFrameOnlySource);

      store.getState().attach(rFrameOnlySource, video);
      store.getState().syncReady(identity, video);

      store.getState().seekNominal(1);
      expect(video.currentTime).toBeCloseTo(1001 / 30000, 9);
    });

    it("is disabled (no-op) when neither avgFrameRate nor rFrameRate exists", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      const noFpsSource: PlaybackSource = {
        ...sourceA,
        avgFrameRate: null,
        rFrameRate: null,
      };
      const identity = getSourceRevisionKey(noFpsSource);

      store.getState().attach(noFpsSource, video);
      store.getState().syncReady(identity, video);

      store.getState().seekNominal(1);
      expect(video.currentTime).toBe(0);
      expect(video.pauseCalls).toBe(0);
    });

    it("getNominalFrameRate pure helper correctly chooses valid rate or returns null", () => {
      expect(getNominalFrameRate(sourceA)).toEqual(fps25);
      expect(
        getNominalFrameRate({
          ...sourceA,
          avgFrameRate: null,
          rFrameRate: fpsNtsc,
        }),
      ).toEqual(fpsNtsc);
      expect(
        getNominalFrameRate({
          ...sourceA,
          avgFrameRate: null,
          rFrameRate: null,
        }),
      ).toBeNull();
    });

    it("clamps nominal seek to lower bound 0 and does not update presentedFrame optimistically", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 0.02 });

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // Seek -10 frames from 0.02s -> clamps to 0
      store.getState().seekNominal(-10);
      expect(video.currentTime).toBe(0);
      expect(store.getState().presentedFrame).toBeNull();
    });

    it("clears a previously presented frame until nominal seek RVFC arrives", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0, 1, video);

      store.getState().seekNominal(1);
      expect(store.getState().presentedFrame).toBeNull();
      store.getState().syncPresentedFrame(identityA, 0.04, 2, video);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("1");
    });
  });

  describe("Runtime Browser Duration and Approximate Seek", () => {
    it("stores only finite non-negative browser duration", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 12.5 });
      store.getState().attach(sourceA, video);
      store.getState().syncBrowserDuration(identityA, video);
      expect(store.getState().runtimeBrowserDurationSeconds).toBe(12.5);

      video.duration = Infinity;
      store.getState().syncBrowserDuration(identityA, video);
      expect(store.getState().runtimeBrowserDurationSeconds).toBeNull();
    });

    it("seeks approximately without creating or retaining inferred PTS", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 10 });
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      store.getState().syncBrowserDuration(identityA, video);

      store.getState().seekApproximate(20);
      expect(video.currentTime).toBe(10);
      expect(store.getState().presentedFrame).toBeNull();
      expect(store.getState().calibrationStatus).toBe("ready");
    });

    it("rejects invalid approximate seek values", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      store.getState().seekApproximate(Number.NaN);
      store.getState().seekApproximate(Infinity);
      store.getState().seekApproximate(-1);
      expect(video.currentTime).toBe(0);
      expect(video.pauseCalls).toBe(0);
    });
  });

  describe("Exact Element Guards & Stale Event Rejection", () => {
    it("ignores old element events after same-identity element replacement", () => {
      const store = createPlaybackStore();
      const video1 = createFakeVideo();
      const video2 = createFakeVideo();

      // 1. Attach video1 and mark ready
      store.getState().attach(sourceA, video1);
      store.getState().syncReady(identityA, video1);
      expect(store.getState().isReady).toBe(true);

      // 2. Replace element with video2 under same source identity
      store.getState().attach(sourceA, video2);
      expect(store.getState().isReady).toBe(false);

      // 3. Stale events from video1 must be rejected
      store.getState().syncReady(identityA, video1);
      expect(store.getState().isReady).toBe(false);

      store.getState().syncPlay(identityA, video1);
      expect(store.getState().isPlaying).toBe(false);

      store.getState().syncPresentedFrame(identityA, 1.0, 26, video1);
      expect(store.getState().presentedFrame).toBeNull();

      store.getState().syncPause(identityA, video1);
      store.getState().syncEnded(identityA, video1);
      store.getState().detach(identityA, video1);
      expect(store.getState().isAttached).toBe(true);

      // 4. Mark video2 ready
      store.getState().syncReady(identityA, video2);
      expect(store.getState().isReady).toBe(true);

      // 5. video2 events now work
      store.getState().syncPlay(identityA, video2);
      expect(store.getState().isPlaying).toBe(true);

      store.getState().syncPresentedFrame(identityA, 0.0, 1, video2);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
    });
  });

  describe("Synchronous Play Activation & Session Invalidation", () => {
    it("calls video.play() synchronously from togglePlayback() and play() when ready", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      // Play should no-op before readiness
      store.getState().play();
      expect(video.playCalls).toBe(0);

      // Mark ready
      store.getState().syncReady(identityA, video);

      store.getState().togglePlayback();
      expect(video.playCalls).toBe(1);
      expect(store.getState().isPlaying).toBe(true);

      store.getState().pause();
      expect(video.pauseCalls).toBe(1);
      expect(store.getState().isPlaying).toBe(false);

      store.getState().play();
      expect(video.playCalls).toBe(2);
    });

    it("handles resolved play promise and maintains isPlaying true", async () => {
      let resolvePlay!: () => void;
      const playPromise = new Promise<void>((res) => {
        resolvePlay = res;
      });

      const video = createFakeVideo({
        playImpl: () => playPromise,
      });

      const store = createPlaybackStore();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      store.getState().play();
      expect(store.getState().isPlaying).toBe(true);

      resolvePlay();
      await playPromise;
      await flushAsync();

      expect(store.getState().isPlaying).toBe(true);
      expect(store.getState().error).toBeNull();
    });

    it("catches rejected play promise and sets localized error code", async () => {
      let rejectPlay!: (err: unknown) => void;
      const playPromise = new Promise<void>((_, rej) => {
        rejectPlay = rej;
      });

      const video = createFakeVideo({
        playImpl: () => playPromise,
      });

      const store = createPlaybackStore();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      store.getState().play();

      rejectPlay(
        new DOMException("The play() request was rejected.", "NotAllowedError"),
      );
      try {
        await playPromise;
      } catch {
        // Expected promise rejection
      }
      await flushAsync();

      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().error).toBe("playbackFailed");
    });

    it("invalidates pending play promise on pause()", async () => {
      let rejectPlay!: (err: unknown) => void;
      const playPromise = new Promise<void>((_, rej) => {
        rejectPlay = rej;
      });

      const video = createFakeVideo({
        playImpl: () => playPromise,
      });

      const store = createPlaybackStore();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      store.getState().play();

      // Pause immediately
      store.getState().pause();
      expect(store.getState().isPlaying).toBe(false);

      rejectPlay(new DOMException("Interrupted by pause()", "AbortError"));
      try {
        await playPromise;
      } catch {
        // Expected
      }
      await flushAsync();

      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().error).toBeNull();
    });

    it("invalidates pending play promise on seekNominal()", async () => {
      let resolvePlay1!: () => void;
      const playPromise1 = new Promise<void>((res) => {
        resolvePlay1 = res;
      });

      const video = createFakeVideo({
        playImpl: () => playPromise1,
      });

      const store = createPlaybackStore();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      store.getState().play();

      // Nominal seek while play is pending
      store.getState().seekNominal(1);
      expect(store.getState().isPlaying).toBe(false);

      resolvePlay1();
      await playPromise1;
      await flushAsync();

      // Late resolve must NOT resume playing
      expect(store.getState().isPlaying).toBe(false);
    });

    it("handles repeated play calls, ensuring only the latest play session takes effect", async () => {
      let resolvePlay1!: () => void;
      let rejectPlay2!: (err: unknown) => void;

      const playPromise1 = new Promise<void>((res) => {
        resolvePlay1 = res;
      });
      const playPromise2 = new Promise<void>((_, rej) => {
        rejectPlay2 = rej;
      });

      let callCount = 0;
      const video = createFakeVideo({
        playImpl: () => {
          callCount++;
          return callCount === 1 ? playPromise1 : playPromise2;
        },
      });

      const store = createPlaybackStore();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // First play call
      store.getState().play();
      // Second play call
      store.getState().play();

      // First promise resolves later -> ignored because session 1 was superseded
      resolvePlay1();
      await playPromise1;
      await flushAsync();

      expect(store.getState().isPlaying).toBe(true);

      // Second promise rejects -> session 2 is active, so it reports error
      rejectPlay2(new DOMException("Error", "NotAllowedError"));
      try {
        await playPromise2;
      } catch {
        // Expected
      }
      await flushAsync();

      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().error).toBe("playbackFailed");
    });

    it("clamps nominal seek to approximateDurationSeconds when specified", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 9.98 });

      // sourceA has approximateDurationSeconds: 10.0
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // Seek +10 frames (0.40s) from 9.98s -> 10.38s, clamped to 10.0s
      store.getState().seekNominal(10);
      expect(video.currentTime).toBe(10.0);
    });

    it("handles large PTS values within signed i64 range safely", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      const largeSource: PlaybackSource = {
        path: "/media/large.mp4",
        size: 1000,
        mtime: 1000,
        videoTimeBase: { n: 1, d: 1000 },
        videoStartPts: "1000000000000" as Pts,
      };
      const largeIdentity = getSourceRevisionKey(largeSource);

      store.getState().attach(largeSource, video);
      store.getState().syncReady(largeIdentity, video);

      // Calibrate at 0.0s
      store.getState().syncPresentedFrame(largeIdentity, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("1000000000000");

      // Seek to PTS 1000000005000 (delta 5000 ticks at 1/1000 = 5.0s)
      store.getState().seekToPts("1000000005000" as Pts);
      expect(video.currentTime).toBeCloseTo(5.0, 9);
    });

    it("clears error on next successful seek, nominal seek, or source change", async () => {
      const video = createFakeVideo({
        playImpl: () => Promise.reject(new Error("Playback failed")),
      });

      const store = createPlaybackStore();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // Trigger playback error
      store.getState().play();
      await flushAsync();
      expect(store.getState().error).toBe("playbackFailed");

      // Nominal seek clears error
      store.getState().seekNominal(1);
      expect(store.getState().error).toBeNull();

      // Trigger error again
      store.getState().play();
      await flushAsync();
      expect(store.getState().error).toBe("playbackFailed");

      // PTS seek clears error
      store.getState().seekToPts("25" as Pts);
      expect(store.getState().error).toBeNull();

      // Trigger error again
      store.getState().play();
      await flushAsync();
      expect(store.getState().error).toBe("playbackFailed");

      // Source replacement clears error
      store.getState().attach(sourceB, createFakeVideo());
      expect(store.getState().error).toBeNull();
    });
  });
});
