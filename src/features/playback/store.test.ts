import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { getSourceRevisionKey } from "@/features/media";
import { canMarkIn } from "@/features/timeline";
import * as timeLib from "@/lib/time";
import type { Pts } from "@/types/project";
import { scrubAudioController } from "./scrubAudio";
import {
  createPlaybackStore,
  getNominalFrameRate,
  hasNominalFrameRate,
  type PlaybackStore,
} from "./store";
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
  seeking?: boolean;
  autoSeeking?: boolean;
  fastSeek?: ((time: number) => void) | boolean;
  throwOnFastSeek?: boolean;
}): PlaybackMediaElement & {
  playCalls: number;
  pauseCalls: number;
  readyState: number;
  seeking: boolean;
  throwOnCurrentTimeSet: boolean;
  currentTimeSets: number;
  fastSeek?: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
} {
  let currentTimeVal = options?.initialCurrentTime ?? 0;
  let readyStateVal = options?.readyState ?? 0;
  let seekingVal = options?.seeking ?? false;
  let currentTimeSets = 0;

  const fastSeekSpy =
    options?.fastSeek !== undefined && options?.fastSeek !== false
      ? vi.fn((val: number) => {
          if (options?.throwOnFastSeek) {
            throw new DOMException(
              "The element cannot be seeked in its current state.",
              "InvalidStateError",
            );
          }
          if (typeof options.fastSeek === "function") {
            options.fastSeek(val);
          }
          if (options?.autoSeeking !== false) {
            seekingVal = true;
          }
        })
      : undefined;

  const fake = {
    playCalls: 0,
    pauseCalls: 0,
    throwOnCurrentTimeSet: options?.throwOnCurrentTimeSet ?? false,
    get currentTimeSets() {
      return currentTimeSets;
    },
    get readyState() {
      return readyStateVal;
    },
    set readyState(val: number) {
      readyStateVal = val;
    },
    get seeking() {
      return seekingVal;
    },
    set seeking(val: boolean) {
      seekingVal = val;
    },
    get currentTime() {
      return currentTimeVal;
    },
    duration: options?.duration ?? Number.NaN,
    set currentTime(val: number) {
      currentTimeSets++;
      if (fake.throwOnCurrentTimeSet) {
        throw new DOMException(
          "The element cannot be seeked in its current state.",
          "InvalidStateError",
        );
      }
      currentTimeVal = val;
      if (options?.autoSeeking !== false) {
        seekingVal = true;
      }
    },
    ...(fastSeekSpy ? { fastSeek: fastSeekSpy } : {}),
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
 * Simulates the media element finishing a seek and dispatching the onSeeked event.
 */
function fireSeeked(
  store: PlaybackStore,
  sourceRevisionKey: string,
  element: PlaybackMediaElement,
): void {
  element.seeking = false;
  store.getState().syncSeeked(sourceRevisionKey, element);
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
      expect(state.approximateBrowserTimeSeconds).toBeNull();
      expect(state.seekTargetSeconds).toBeNull();
      expect(state.isPlaying).toBe(false);
      expect(state.isAttached).toBe(false);
      expect(state.attachedSourceRevisionKey).toBeNull();
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
        store.getState().seekApproximate(1);
        store.getState().syncReady("some-id", fakeVideo);
        store.getState().syncUnready("some-id", fakeVideo);
        store.getState().syncPresentedFrame("some-id", 0.0, 1, fakeVideo);
        store.getState().syncSeeked("some-id", fakeVideo);
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
      expect(store.getState().attachedSourceRevisionKey).toBeNull();
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
      expect(store.getState().attachedSourceRevisionKey).toBe(identityA);
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
      expect(store.getState().attachedSourceRevisionKey).toBeNull();
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
      expect(store.getState().attachedSourceRevisionKey).toBe(identityA);
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
      expect(store.getState().attachedSourceRevisionKey).toBe(identityA);
      expect(store.getState().isReady).toBe(true);

      // Detach called with wrong source identity
      store.getState().detach(identityB, video1);
      expect(store.getState().isAttached).toBe(true);
      expect(store.getState().attachedSourceRevisionKey).toBe(identityA);
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
      expect(store.getState().attachedSourceRevisionKey).toBe(identityB);
      expect(store.getState().isReady).toBe(false);
    });

    it("tracks attachedSourceRevisionKey across attach, detach, and reset", () => {
      const store = createPlaybackStore();
      const video1 = createFakeVideo();
      const video2 = createFakeVideo();

      expect(store.getState().attachedSourceRevisionKey).toBeNull();

      store.getState().attach(sourceA, video1);
      expect(store.getState().attachedSourceRevisionKey).toBe(identityA);

      // Re-attaching same source and element preserves attachedSourceRevisionKey
      store.getState().attach(sourceA, video1);
      expect(store.getState().attachedSourceRevisionKey).toBe(identityA);

      // Guarded detach does not clear attachedSourceRevisionKey
      store.getState().detach(identityB, video1);
      expect(store.getState().attachedSourceRevisionKey).toBe(identityA);
      store.getState().detach(identityA, video2);
      expect(store.getState().attachedSourceRevisionKey).toBe(identityA);

      // Matching detach clears attachedSourceRevisionKey
      store.getState().detach(identityA, video1);
      expect(store.getState().attachedSourceRevisionKey).toBeNull();

      // Replacement updates attachedSourceRevisionKey
      store.getState().attach(sourceA, video1);
      expect(store.getState().attachedSourceRevisionKey).toBe(identityA);
      store.getState().attach(sourceB, video2);
      expect(store.getState().attachedSourceRevisionKey).toBe(identityB);

      // Reset clears attachedSourceRevisionKey
      store.getState().reset();
      expect(store.getState().attachedSourceRevisionKey).toBeNull();
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

      // The media timeline of this source starts at 1.5s. An element without metadata reports
      // 0, and the browser moves currentTime to the start of the timeline when it loads the
      // metadata, which is the event syncReady models.
      video.readyState = 1;
      video.currentTime = 1.5;
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

      store
        .getState()
        .syncPresentedFrame(identityA, Number.MAX_VALUE, undefined, video);
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
      const video = createFakeVideo({ autoSeeking: false });

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

    it("hasNominalFrameRate pure predicate validates presence of usable frame rate", () => {
      // valid avgFrameRate -> true
      expect(hasNominalFrameRate(sourceA)).toBe(true);
      expect(
        hasNominalFrameRate({
          avgFrameRate: fps25,
          rFrameRate: null,
        }),
      ).toBe(true);

      // only rFrameRate valid -> true
      expect(
        hasNominalFrameRate({
          avgFrameRate: null,
          rFrameRate: fpsNtsc,
        }),
      ).toBe(true);

      // both null -> false
      expect(
        hasNominalFrameRate({
          avgFrameRate: null,
          rFrameRate: null,
        }),
      ).toBe(false);

      // {n:0,d:1} -> false
      expect(
        hasNominalFrameRate({
          avgFrameRate: { n: 0, d: 1 },
          rFrameRate: null,
        }),
      ).toBe(false);

      // {n:1,d:0} -> false
      expect(
        hasNominalFrameRate({
          avgFrameRate: { n: 1, d: 0 },
          rFrameRate: null,
        }),
      ).toBe(false);

      // non-safe-integer numerator -> false
      expect(
        hasNominalFrameRate({
          avgFrameRate: { n: 29.97, d: 1 },
          rFrameRate: null,
        }),
      ).toBe(false);
      expect(
        hasNominalFrameRate({
          avgFrameRate: { n: Number.NaN, d: 1 },
          rFrameRate: null,
        }),
      ).toBe(false);

      // null and undefined input -> false
      expect(hasNominalFrameRate(null)).toBe(false);
      expect(hasNominalFrameRate(undefined)).toBe(false);
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

  describe("Approximate Browser Time Clock", () => {
    it("stores only a finite non-negative browser time", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 3.5 });
      store.getState().attach(sourceA, video);

      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(3.5);

      video.currentTime = Number.NaN;
      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBeNull();

      video.currentTime = 4;
      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(4);

      video.currentTime = -1;
      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBeNull();
    });

    it("refuses a write for the wrong revision key or a different element", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 2 });
      const otherVideo = createFakeVideo({ initialCurrentTime: 9 });
      store.getState().attach(sourceA, video);

      store.getState().syncBrowserTime(identityB, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBeNull();

      store.getState().syncBrowserTime(identityA, otherVideo);
      expect(store.getState().approximateBrowserTimeSeconds).toBeNull();

      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(2);
    });

    it("skips an identical write, because timeupdate also fires while paused", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 2 });
      store.getState().attach(sourceA, video);
      store.getState().syncBrowserTime(identityA, video);

      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);

      store.getState().syncBrowserTime(identityA, video);
      store.getState().syncBrowserTime(identityA, video);
      expect(listener).not.toHaveBeenCalled();

      video.currentTime = 2.04;
      store.getState().syncBrowserTime(identityA, video);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it("nulls the clock on attach, detach and reset", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 2 });

      store.getState().attach(sourceA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBeNull();

      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(2);

      store.getState().detach(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBeNull();

      const secondVideo = createFakeVideo({ initialCurrentTime: 5 });
      store.getState().attach(sourceA, secondVideo);
      store.getState().syncBrowserTime(identityA, secondVideo);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(5);

      store.getState().reset();
      expect(store.getState().approximateBrowserTimeSeconds).toBeNull();
    });

    // A decode error does not move the clock, so syncUnready must leave it alone.
    it("keeps the clock through syncUnready", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      // The element plays past the start of the timeline before it fails to decode
      video.currentTime = 2;
      store.getState().syncBrowserTime(identityA, video);

      store.getState().syncUnready(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(2);
    });

    // The element's own `seeked` event reports the position it reached, exactly as RVFC
    // reports the presented frame instead of seekToPts updating presentedFrame.
    it("does not write the clock from seekApproximate", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 10 });
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncBrowserDuration(identityA, video);

      store.getState().seekApproximate(4);
      expect(video.currentTime).toBe(4);
      expect(store.getState().approximateBrowserTimeSeconds).toBeNull();

      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(4);
    });
  });

  // ADR 003 does not require the browser media timeline to start at 0, and every other
  // position the timeline reports is seconds elapsed from the start of the source. The clock
  // and the approximate seek carry the origin so both sit on that one axis.
  describe("Browser Timeline Origin", () => {
    /**
     * Mounts a source whose browser media timeline starts at `origin`.
     *
     * React creates the node, so the element reports 0 at attach time; the browser moves
     * currentTime to the start of the timeline when metadata loads, which is the reading
     * syncReady takes.
     */
    function attachWithOrigin(
      store: ReturnType<typeof createPlaybackStore>,
      origin: number,
      duration?: number,
    ) {
      const video = createFakeVideo({ duration });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      video.currentTime = origin;
      video.seeking = false;
      store.getState().syncReady(identityA, video);
      return video;
    }

    it("keeps the raw position while metadata has not loaded", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 5 });
      store.getState().attach(sourceA, video);

      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(5);
    });

    it("reports elapsed source seconds for a timeline that starts away from 0", () => {
      const store = createPlaybackStore();
      const video = attachWithOrigin(store, 5, 65);

      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(0);

      video.currentTime = 12;
      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(7);
    });

    it("offsets an approximate seek by the origin, so the seek and the clock agree", () => {
      const store = createPlaybackStore();
      const video = attachWithOrigin(store, 5, 65);
      store.getState().syncBrowserDuration(identityA, video);

      store.getState().seekApproximate(10);
      expect(video.currentTime).toBe(15);

      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(10);
    });

    it("clamps an offset approximate seek to the browser duration", () => {
      const store = createPlaybackStore();
      const video = attachWithOrigin(store, 5, 65);
      store.getState().syncBrowserDuration(identityA, video);

      store.getState().seekApproximate(100);
      expect(video.currentTime).toBe(65);
    });

    // The three seek actions null presentedFrame, so a calibrated source falls back to this
    // clock for the length of every seek. A missing origin would jump the playhead forward
    // and snap it back when RVFC lands.
    it("agrees with the inferred PTS of a calibrated source at the same position", () => {
      const store = createPlaybackStore();
      const video = attachWithOrigin(store, 5, 65);

      store.getState().syncPresentedFrame(identityA, 5, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      // videoStartPts of sourceA, which is elapsed second 0 of the source
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");

      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(0);
    });

    it("takes the origin again for the next attachment", () => {
      const store = createPlaybackStore();
      const video = attachWithOrigin(store, 5, 65);
      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(0);

      store.getState().detach(identityA, video);
      const secondVideo = attachWithOrigin(store, 2);

      secondVideo.currentTime = 3;
      store.getState().syncBrowserTime(identityA, secondVideo);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(1);
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

  describe("Calibration Anchor Guard", () => {
    it("refuses the anchor when a re-attached element already played past the start", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ readyState: 1 });

      // Load and calibrate normally
      store.getState().attach(sourceA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");

      // The user plays to 42.4s
      video.currentTime = 42.4;
      store.getState().syncPresentedFrame(identityA, 42.4, 1061, video);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("1060");

      // The same file is imported again: the element is detached and re-attached where it stands
      store.getState().detach(identityA, video);
      store.getState().attach(sourceA, video);
      expect(store.getState().calibrationStatus).toBe("calibrating");

      // The first callback after the re-attach reports the position the element already reached.
      // It must not become the anchor of videoStartPts.
      store.getState().syncPresentedFrame(identityA, 42.4, 1062, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();

      // A later callback does not restore precision either
      store.getState().syncPresentedFrame(identityA, 43.4, 1087, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();
    });

    it("accepts the anchor when the re-attached element still stands where it was attached", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ readyState: 1 });

      store.getState().attach(sourceA, video);
      store.getState().detach(identityA, video);
      store.getState().attach(sourceA, video);

      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
    });

    it("refuses the anchor when the element moved between the attach and the first callback", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ readyState: 1 });

      store.getState().attach(sourceA, video);

      // The element was seeked before the frame callback loop reported anything
      video.currentTime = 42.4;
      store.getState().syncPresentedFrame(identityA, 42.4, 1061, video);

      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();
    });

    it("takes the baseline from the timeline start the browser reports with the metadata", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      // sourceB reports videoStartPts "1000" and its browser timeline starts at 1.5s, while an
      // element without metadata still reports currentTime 0. The baseline recorded at the
      // attach would refuse the first callback at 1.5, so loading the metadata takes it again.
      store.getState().attach(sourceB, video);
      video.readyState = 1;
      video.currentTime = 1.5;
      store.getState().syncReady(identityB, video);
      store.getState().syncPresentedFrame(identityB, 1.5, 1, video);

      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("1000");
    });

    it("refuses the anchor when an element without metadata moved before the first callback", () => {
      const store = createPlaybackStore();
      // The application attaches the node React has just created, which reports readyState 0
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);

      // The element left the start before the frame callback loop reported anything
      video.currentTime = 42.4;
      store.getState().syncPresentedFrame(identityA, 42.4, 1061, video);

      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();
    });

    it("refuses the anchor after a ruler click that precedes the first presented frame", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 600 });

      // React mounts the node, so the element carries no metadata yet
      store.getState().attach(sourceA, video);
      expect(store.getState().calibrationStatus).toBe("calibrating");

      // Loaded metadata makes the ruler clickable
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncBrowserDuration(identityA, video);

      // The user clicks the ruler at half of a 10-minute clip before the first RVFC callback
      store.getState().seekApproximate(300);
      expect(video.currentTime).toBe(300);

      // The first callback reports the frame that seek presented. Binding videoStartPts to it
      // would write PTS 0 for a picture five minutes into the source.
      store.getState().syncPresentedFrame(identityA, 300, 1, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();
    });

    it("refuses the anchor after a nominal step that precedes the first presented frame", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);

      // One frame at 25 fps stays well inside the tolerance, so only the recorded seek
      // separates this callback from a true first frame
      store.getState().seekNominal(1);
      expect(video.currentTime).toBeCloseTo(0.04, 9);

      store.getState().syncPresentedFrame(identityA, 0.04, 1, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();
    });

    it("keeps calibration ready for a seek that follows the anchor", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 600 });

      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncBrowserDuration(identityA, video);

      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");

      store.getState().seekApproximate(300);
      store.getState().syncPresentedFrame(identityA, 300, 2, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("7500");
    });

    it("clears the recorded seek when the element is attached again", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 600 });

      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncBrowserDuration(identityA, video);
      store.getState().seekApproximate(300);

      // A new import returns the element to the start of the source
      store.getState().detach(identityA, video);
      video.currentTime = 0;
      store.getState().attach(sourceA, video);

      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
    });
  });

  describe("Precision Denial Held Against the Source (ADR 003)", () => {
    it("keeps a duplicate-PTS denial across a re-attachment of the same source", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      store.getState().syncPresentedFrame(identityA, 0.00001, 2, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");

      // Re-import of the same file: the element is detached and attached again
      store.getState().detach(identityA, video);
      store.getState().attach(sourceA, video);

      expect(store.getState().calibrationStatus).toBe("unavailable");
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();
    });

    it("keeps an invalid mediaTime denial across a re-attachment of the same source", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncPresentedFrame(identityA, Number.NaN, 1, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");

      store.getState().detach(identityA, video);
      store.getState().attach(sourceA, video);

      expect(store.getState().calibrationStatus).toBe("unavailable");
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().presentedFrame).toBeNull();
    });

    it("keeps an unsafe conversion denial across a re-attachment of the same source", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      store.getState().syncPresentedFrame(identityA, Number.MAX_VALUE, 2, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");

      store.getState().detach(identityA, video);
      store.getState().attach(sourceA, video);

      expect(store.getState().calibrationStatus).toBe("unavailable");
    });

    it("denies precision for the failing source only, and not for another source", () => {
      const store = createPlaybackStore();
      const videoA = createFakeVideo();

      store.getState().attach(sourceA, videoA);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, videoA);
      store.getState().syncPresentedFrame(identityA, 0.00001, 2, videoA);
      expect(store.getState().calibrationStatus).toBe("unavailable");

      const videoB = createFakeVideo();
      store.getState().attach(sourceB, videoB);
      expect(store.getState().calibrationStatus).toBe("calibrating");
    });

    it("tries a source again once the file on disk has a new revision key", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      store.getState().syncPresentedFrame(identityA, 0.00001, 2, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");

      // The file changed on disk, so its revision key changed
      const editedSource: PlaybackSource = { ...sourceA, mtime: sourceA.mtime + 60 };
      store.getState().attach(editedSource, createFakeVideo());
      expect(store.getState().calibrationStatus).toBe("calibrating");
    });
  });

  describe("Unavailable State Store Writes", () => {
    it("does not write to the store for later callbacks once calibration is unavailable", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      const noStartPtsSource: PlaybackSource = { ...sourceA, videoStartPts: null };
      const identity = getSourceRevisionKey(noStartPtsSource);

      store.getState().attach(noStartPtsSource, video);
      store.getState().syncReady(identity, video);

      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);

      store.getState().syncPresentedFrame(identity, 0.0, 1, video);
      store.getState().syncPresentedFrame(identity, 0.04, 2, video);
      store.getState().syncPresentedFrame(identity, 0.08, 3, video);

      expect(listener).not.toHaveBeenCalled();
      expect(store.getState().calibrationStatus).toBe("unavailable");
      expect(store.getState().presentedFrame).toBeNull();

      unsubscribe();
    });
  });

  describe("Scrub Audio Controller Integration (ADR 019)", () => {
    let requestSpy: MockInstance<typeof scrubAudioController.request>;
    let stopSpy: MockInstance<typeof scrubAudioController.stop>;

    beforeEach(() => {
      requestSpy = vi.spyOn(scrubAudioController, "request");
      stopSpy = vi.spyOn(scrubAudioController, "stop");
    });

    afterEach(() => {
      requestSpy.mockRestore();
      stopSpy.mockRestore();
    });

    it("calls request with the same target seconds assigned to the element and direction 1 on forward seekNominal", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 2.0 });

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // sourceA has fps25 ({ n: 25, d: 1 }), so 1 frame = 1/25 = 0.04s.
      // Target time = 2.0 + 0.04 = 2.04s.
      store.getState().seekNominal(1);

      expect(video.currentTime).toBe(2.04);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(2.04, 1);
    });

    it("calls request with the same target seconds assigned to the element and direction -1 on backward seekNominal", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 2.0 });

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // sourceA has fps25 ({ n: 25, d: 1 }), so -1 frame = -0.04s.
      // Target time = 2.0 - 0.04 = 1.96s.
      store.getState().seekNominal(-1);

      expect(video.currentTime).toBe(1.96);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(1.96, -1);
    });

    it("calls request with 0 and direction -1 when stepping backward clamps to 0", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 0.01 });

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // sourceA has fps25 (0.04s per frame). Stepping backward from 0.01 clamps to 0.
      store.getState().seekNominal(-1);

      expect(video.currentTime).toBe(0);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(0, -1);
    });

    it("calls request with approximateDurationSeconds and direction 1 when stepping forward clamps to upper bound", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 9.99 });

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // sourceA has approximateDurationSeconds 10.0 and fps25 (0.04s per frame).
      // Stepping forward from 9.99 clamps to 10.0.
      store.getState().seekNominal(1);

      expect(video.currentTime).toBe(sourceA.approximateDurationSeconds);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(sourceA.approximateDurationSeconds, 1);
    });

    it("does not call request when the currentTime assignment throws", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({
        initialCurrentTime: 2.0,
        throwOnCurrentTimeSet: true,
      });

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      store.getState().seekNominal(1);

      expect(requestSpy).not.toHaveBeenCalled();
      expect(store.getState().error).toBe("seekFailed");
    });

    it("does not call request when seekNominal returns early with no usable frame rate or unready state", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 2.0 });

      // 1. Source without usable frame rates
      const noFpsSource: PlaybackSource = {
        ...sourceA,
        avgFrameRate: null,
        rFrameRate: null,
      };
      const noFpsIdentity = getSourceRevisionKey(noFpsSource);
      store.getState().attach(noFpsSource, video);
      store.getState().syncReady(noFpsIdentity, video);

      store.getState().seekNominal(1);
      expect(requestSpy).not.toHaveBeenCalled();

      // 2. Not ready
      const storeUnready = createPlaybackStore();
      const videoUnready = createFakeVideo({ initialCurrentTime: 2.0 });
      storeUnready.getState().attach(sourceA, videoUnready);
      storeUnready.getState().seekNominal(1);
      expect(requestSpy).not.toHaveBeenCalled();

      // 3. No media attached
      const storeEmpty = createPlaybackStore();
      storeEmpty.getState().seekNominal(1);
      expect(requestSpy).not.toHaveBeenCalled();

      // 4. Invalid delta frames
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().seekNominal(0);
      store.getState().seekNominal(1.5);
      store.getState().seekNominal(Number.NaN);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it("calls stop on play, pause, seekToPts, seekApproximate, detach and reset", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");

      // 1. play calls stop before targetElement.play
      stopSpy.mockClear();
      video.play.mockClear();
      store.getState().play();
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(stopSpy.mock.invocationCallOrder[0]).toBeLessThan(
        video.play.mock.invocationCallOrder[0],
      );

      // 2. pause calls stop
      stopSpy.mockClear();
      store.getState().pause();
      expect(stopSpy).toHaveBeenCalledTimes(1);

      // 3. seekToPts calls stop
      stopSpy.mockClear();
      store.getState().seekToPts("25" as Pts);
      expect(stopSpy).toHaveBeenCalledTimes(1);

      // 4. seekApproximate calls stop
      stopSpy.mockClear();
      store.getState().seekApproximate(3.5);
      expect(stopSpy).toHaveBeenCalledTimes(1);

      // Guarded detach: non-matching revision key or different element leaves stopSpy uncalled
      const otherVideo = createFakeVideo();
      stopSpy.mockClear();
      store.getState().detach(identityB, video);
      expect(stopSpy).not.toHaveBeenCalled();

      stopSpy.mockClear();
      store.getState().detach(identityA, otherVideo);
      expect(stopSpy).not.toHaveBeenCalled();

      // 5. detach calls stop
      stopSpy.mockClear();
      store.getState().detach(identityA, video);
      expect(stopSpy).toHaveBeenCalledTimes(1);

      // 6. reset calls stop
      store.getState().attach(sourceA, video);
      stopSpy.mockClear();
      store.getState().reset();
      expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it("calls stop on seekToPts and seekApproximate even on early-return failure paths", () => {
      const store = createPlaybackStore();

      // Uncalibrated / unattached store: seekToPts returns early with seekFailed
      stopSpy.mockClear();
      store.getState().seekToPts("0" as Pts);
      expect(stopSpy).toHaveBeenCalledTimes(1);

      // seekApproximate with invalid seconds returns early
      stopSpy.mockClear();
      store.getState().seekApproximate(-1);
      expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it("does not call stop during seekNominal", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 2.0 });

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      stopSpy.mockClear();
      store.getState().seekNominal(1);
      expect(stopSpy).not.toHaveBeenCalled();

      store.getState().seekNominal(-1);
      expect(stopSpy).not.toHaveBeenCalled();
    });
  });

  describe("ADR 022: Playhead Scrub Display Target and Coalesced Seeks", () => {
    it("assigns currentTime and sets seekTargetSeconds on a non-seeking element (precise path)", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");

      store.getState().seekToPts("50" as Pts); // 50 / 25 = 2.0s
      expect(video.currentTime).toBe(2.0);
      expect(store.getState().seekTargetSeconds).toBe(2.0);
      expect(video.seeking).toBe(true);
    });

    it("assigns currentTime and sets seekTargetSeconds on a non-seeking element on ruler axis with origin (approximate path)", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 65 });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      video.currentTime = 5;
      video.seeking = false;
      store.getState().syncReady(identityA, video);
      store.getState().syncBrowserDuration(identityA, video);

      // Seek 10s on ruler axis
      store.getState().seekApproximate(10);
      // Browser element moves by 10 + 5 = 15
      expect(video.currentTime).toBe(15);
      // seekTargetSeconds is on the ruler axis: 15 - 5 = 10
      expect(store.getState().seekTargetSeconds).toBe(10);
    });

    it("does not assign currentTime while element.seeking is true but sets the target, and replaces queue on subsequent seek", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 1.0 });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 1.0, 1, video);

      // Seek is already in flight on the element
      video.seeking = true;

      // First seek request: target 75 (3.0s)
      store.getState().seekToPts("75" as Pts);
      expect(video.currentTime).toBe(1.0); // Not assigned!
      expect(store.getState().seekTargetSeconds).toBe(3.0);

      // Second seek request: target 100 (4.0s) - replaces queue (latest wins)
      store.getState().seekToPts("100" as Pts);
      expect(video.currentTime).toBe(1.0); // Still not assigned!
      expect(store.getState().seekTargetSeconds).toBe(4.0);
    });

    it("syncSeeked applies the queued seek and keeps the target", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      video.seeking = true;
      store.getState().seekToPts("75" as Pts);
      store.getState().seekToPts("100" as Pts); // target 4.0s
      expect(video.currentTime).toBe(0.0);

      // Video finishes the previous seek
      fireSeeked(store, identityA, video);

      // Queued seek (4.0s) is now applied to currentTime, and target is preserved
      expect(video.currentTime).toBe(4.0);
      expect(store.getState().seekTargetSeconds).toBe(4.0);
      expect(video.seeking).toBe(true);
    });

    it("in the ready state, an RVFC callback while seeking or while a seek is queued keeps the target; one after the seek settled clears it", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 0.0 });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");

      // Seek while element is seeking
      video.seeking = true;
      store.getState().seekToPts("50" as Pts); // 2.0s
      expect(store.getState().seekTargetSeconds).toBe(2.0);

      // RVFC arrives while seeking = true -> target is kept
      store.getState().syncPresentedFrame(identityA, 0.5, 2, video);
      expect(store.getState().seekTargetSeconds).toBe(2.0);

      // Next seek arrives, still seeking
      store.getState().seekToPts("75" as Pts); // 3.0s
      expect(store.getState().seekTargetSeconds).toBe(3.0);

      // Seeked event fires and dispatches queued seek
      fireSeeked(store, identityA, video);
      expect(video.currentTime).toBe(3.0);
      expect(video.seeking).toBe(true);

      // RVFC arrives while new seek is in flight -> target kept
      store.getState().syncPresentedFrame(identityA, 2.0, 3, video);
      expect(store.getState().seekTargetSeconds).toBe(3.0);

      // Seek settles
      fireSeeked(store, identityA, video);
      expect(store.getState().seekTargetSeconds).toBe(3.0);

      // RVFC callback after seek settled clears seekTargetSeconds
      store.getState().syncPresentedFrame(identityA, 3.0, 4, video);
      expect(store.getState().seekTargetSeconds).toBeNull();
    });

    it("when not ready, syncSeeked with no queue clears the target", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 60 });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      // Mark calibration unavailable
      store.getState().syncPresentationUnavailable(identityA, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");

      store.getState().seekApproximate(5.0);
      expect(store.getState().seekTargetSeconds).toBe(5.0);

      // syncSeeked with no queued seek clears target when not ready
      fireSeeked(store, identityA, video);
      expect(store.getState().seekTargetSeconds).toBeNull();
    });

    it("play() applies a queued seek before play", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);

      video.seeking = true;
      store.getState().seekApproximate(4.0);
      expect(video.currentTime).toBe(0.0);
      expect(store.getState().seekTargetSeconds).toBe(4.0);

      // play() should apply the queued seek before calling play()
      store.getState().play();
      expect(video.currentTime).toBe(4.0);
      expect(video.playCalls).toBe(1);
      // Target remains set for display until presentation settles
      expect(store.getState().seekTargetSeconds).toBe(4.0);
    });

    it("detach, reset and a failed seek clear the target and the queue", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 1.0 });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 1.0, 1, video);

      // 1. detach clears target and queue
      video.seeking = true;
      store.getState().seekToPts("50" as Pts);
      expect(store.getState().seekTargetSeconds).toBe(2.0);
      store.getState().detach(identityA, video);
      expect(store.getState().seekTargetSeconds).toBeNull();

      // 2. reset clears target and queue
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      video.seeking = true;
      store.getState().seekApproximate(5.0);
      expect(store.getState().seekTargetSeconds).toBe(5.0);
      store.getState().reset();
      expect(store.getState().seekTargetSeconds).toBeNull();

      // 3. failed seek clears target and queue
      const throwingVideo = createFakeVideo({ throwOnCurrentTimeSet: true });
      store.getState().attach(sourceA, throwingVideo);
      throwingVideo.readyState = 1;
      store.getState().syncReady(identityA, throwingVideo);
      store.getState().seekApproximate(3.0);
      expect(store.getState().error).toBe("seekFailed");
      expect(store.getState().seekTargetSeconds).toBeNull();
    });

    it("seekNominal builds on the queued target, not on currentTime", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video); // 25 fps, 1 frame = 0.04s
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      video.currentTime = 1.0;
      video.seeking = false;

      video.seeking = true;
      // First step: 1 frame forward from currentTime 1.0 -> target 1.04s
      store.getState().seekNominal(1);
      expect(video.currentTime).toBe(1.0); // Not assigned because seeking === true
      expect(store.getState().seekTargetSeconds).toBeCloseTo(1.04, 5);

      // Second step: 1 frame forward from queued target 1.04 -> target 1.08s
      store.getState().seekNominal(1);
      expect(video.currentTime).toBe(1.0);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(1.08, 5);

      // Seeked event applies the latest target
      fireSeeked(store, identityA, video);
      expect(video.currentTime).toBeCloseTo(1.08, 5);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(1.08, 5);
    });

    it("presentedFrame stays null after a seek (ADR 003) and the edit predicates are unaffected", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ initialCurrentTime: 0.0 });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame).not.toBeNull();
      // With presentedFrame present, canMarkIn is true
      expect(canMarkIn("ready", store.getState().presentedFrame, true)).toBe(true);

      // Seek to PTS 50 (2.0s)
      store.getState().seekToPts("50" as Pts);
      expect(store.getState().seekTargetSeconds).toBe(2.0);

      // presentedFrame stays null after a seek until RVFC fires (ADR 003)
      expect(store.getState().presentedFrame).toBeNull();

      // Edit predicates read presentedFrame only and remain disabled during pending seek
      expect(canMarkIn("ready", store.getState().presentedFrame, true)).toBe(false);

      // Seek settles
      fireSeeked(store, identityA, video);

      // Once RVFC presents the new frame, presentedFrame is restored and edit predicates become active
      store.getState().syncPresentedFrame(identityA, 2.0, 2, video);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("50");
      expect(canMarkIn("ready", store.getState().presentedFrame, true)).toBe(true);
    });

    it("a stale seeked that arrives while a newer seek is running does not assign currentTime and keeps the queue and the target", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // First seek is dispatched
      store.getState().seekToPts("25" as Pts); // 1.0s
      expect(video.currentTime).toBe(1.0);
      expect(video.seeking).toBe(true);

      // Newer seek is requested while element is seeking -> queued
      store.getState().seekToPts("75" as Pts); // 3.0s
      expect(video.currentTime).toBe(1.0);
      expect(store.getState().seekTargetSeconds).toBe(3.0);

      // A stale seeked task arrives while the element is still actively seeking (seeking === true)
      store.getState().syncSeeked(identityA, video);
      expect(video.currentTime).toBe(1.0);
      expect(store.getState().seekTargetSeconds).toBe(3.0);

      // When the running seek actually completes, fireSeeked dispatches the queued seek
      fireSeeked(store, identityA, video);
      expect(video.currentTime).toBe(3.0);
      expect(store.getState().seekTargetSeconds).toBe(3.0);
    });

    it("syncUnready clears the target and the queue", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);

      video.seeking = true;
      store.getState().seekApproximate(5.0);
      expect(store.getState().seekTargetSeconds).toBe(5.0);

      store.getState().syncUnready(identityA, video);
      expect(store.getState().isReady).toBe(false);
      expect(store.getState().seekTargetSeconds).toBeNull();

      // Later seeked event finds the queue empty
      fireSeeked(store, identityA, video);
      expect(video.currentTime).toBe(0.0);
    });

    it("attach of a new element clears the target and the queue", () => {
      const store = createPlaybackStore();
      const video1 = createFakeVideo();
      store.getState().attach(sourceA, video1);
      video1.readyState = 1;
      store.getState().syncReady(identityA, video1);

      video1.seeking = true;
      store.getState().seekApproximate(6.0);
      expect(store.getState().seekTargetSeconds).toBe(6.0);

      const video2 = createFakeVideo();
      store.getState().attach(sourceA, video2);
      expect(store.getState().seekTargetSeconds).toBeNull();

      video2.readyState = 1;
      store.getState().syncReady(identityA, video2);
      fireSeeked(store, identityA, video2);
      expect(video2.currentTime).toBe(0.0);
    });

    it("syncSeeked ignores a foreign element and a stale sourceRevisionKey", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);

      video.seeking = true;
      store.getState().seekApproximate(8.0);
      expect(store.getState().seekTargetSeconds).toBe(8.0);

      // Ignored for stale sourceRevisionKey
      store.getState().syncSeeked("stale-revision-key", video);
      expect(video.currentTime).toBe(0.0);
      expect(store.getState().seekTargetSeconds).toBe(8.0);

      // Ignored for foreign element
      const foreignVideo = createFakeVideo();
      store.getState().syncSeeked(identityA, foreignVideo);
      expect(video.currentTime).toBe(0.0);
      expect(store.getState().seekTargetSeconds).toBe(8.0);

      // Applies for matching element and key
      fireSeeked(store, identityA, video);
      expect(video.currentTime).toBe(8.0);
      expect(store.getState().seekTargetSeconds).toBe(8.0);
    });

    it("play() with a queued seek whose assignment throws sets seekFailed and does not play", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      video.seeking = true;
      store.getState().seekApproximate(4.0);
      expect(store.getState().seekTargetSeconds).toBe(4.0);

      video.throwOnCurrentTimeSet = true;
      store.getState().play();

      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().error).toBe("seekFailed");
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(store.getState().presentedFrame).toBeNull();
      expect(video.playCalls).toBe(0);

      // Queue is cleared; subsequent seeked should not try to re-apply
      video.throwOnCurrentTimeSet = false;
      fireSeeked(store, identityA, video);
      expect(video.currentTime).toBe(0.0);
    });

    it("presentedFrame stays null when a seek is queued (not assigned)", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().presentedFrame).not.toBeNull();

      video.seeking = true;
      store.getState().seekToPts("50" as Pts);

      expect(video.currentTime).toBe(0.0);
      expect(store.getState().presentedFrame).toBeNull();
      expect(store.getState().seekTargetSeconds).toBe(2.0);
    });

    it("seekToPts with an unconvertible elapsed value does not move the element", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      const elapsedSpy = vi
        .spyOn(timeLib, "ptsElapsedSeconds")
        .mockReturnValueOnce(null);

      store.getState().seekToPts("50" as Pts);

      expect(video.currentTime).toBe(0.0);
      expect(store.getState().error).toBe("seekFailed");
      expect(store.getState().seekTargetSeconds).toBeNull();

      elapsedSpy.mockRestore();
    });
  });

  describe("Scrub Mode: Keyframe Preview & Audio (ADR 022)", () => {
    let requestSpy: MockInstance<typeof scrubAudioController.request>;
    let stopSpy: MockInstance<typeof scrubAudioController.stop>;

    beforeEach(() => {
      requestSpy = vi.spyOn(scrubAudioController, "request");
      stopSpy = vi.spyOn(scrubAudioController, "stop");
    });

    afterEach(() => {
      requestSpy.mockRestore();
      stopSpy.mockRestore();
    });

    it("scrub seek with fastSeek available calls fastSeek and does not assign currentTime; without fastSeek it assigns currentTime", () => {
      // 1. With fastSeek: calls fastSeek and does NOT assign currentTime
      const storeWithFast = createPlaybackStore();
      const videoWithFast = createFakeVideo({ fastSeek: true });
      storeWithFast.getState().attach(sourceA, videoWithFast);
      videoWithFast.readyState = 1;
      storeWithFast.getState().syncReady(identityA, videoWithFast);
      storeWithFast.getState().syncPresentedFrame(identityA, 0.0, 1, videoWithFast);

      storeWithFast.getState().seekApproximate(3.0, { scrub: true });
      expect(videoWithFast.fastSeek).toHaveBeenCalledTimes(1);
      expect(videoWithFast.fastSeek).toHaveBeenCalledWith(3.0);
      expect(videoWithFast.currentTimeSets).toBe(0);
      expect(videoWithFast.currentTime).toBe(0.0);
      expect(videoWithFast.seeking).toBe(true);

      // 2. Without fastSeek: falls back to assigning currentTime
      const storeWithoutFast = createPlaybackStore();
      const videoWithoutFast = createFakeVideo();
      storeWithoutFast.getState().attach(sourceA, videoWithoutFast);
      videoWithoutFast.readyState = 1;
      storeWithoutFast.getState().syncReady(identityA, videoWithoutFast);
      storeWithoutFast
        .getState()
        .syncPresentedFrame(identityA, 0.0, 1, videoWithoutFast);

      storeWithoutFast.getState().seekApproximate(3.0, { scrub: true });
      expect(videoWithoutFast.fastSeek).toBeUndefined();
      expect(videoWithoutFast.currentTimeSets).toBe(1);
      expect(videoWithoutFast.currentTime).toBe(3.0);
      expect(videoWithoutFast.seeking).toBe(true);
    });

    it("exact seek never calls fastSeek", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // exact seekApproximate (options omitted)
      store.getState().seekApproximate(2.0);
      expect(video.fastSeek).not.toHaveBeenCalled();
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBe(2.0);

      // exact seekApproximate (scrub: false)
      fireSeeked(store, identityA, video);
      store.getState().seekApproximate(3.0, { scrub: false });
      expect(video.fastSeek).not.toHaveBeenCalled();
      expect(video.currentTimeSets).toBe(2);
      expect(video.currentTime).toBe(3.0);

      // exact seekToPts
      fireSeeked(store, identityA, video);
      store.getState().seekToPts("25" as Pts); // 1.0s
      expect(video.fastSeek).not.toHaveBeenCalled();
      expect(video.currentTimeSets).toBe(3);
      expect(video.currentTime).toBe(1.0);

      // exact seekNominal
      fireSeeked(store, identityA, video);
      store.getState().seekNominal(1);
      expect(video.fastSeek).not.toHaveBeenCalled();
      expect(video.currentTimeSets).toBe(4);
      expect(video.currentTime).toBeCloseTo(1.04, 5);
    });

    it("a scrub seek queued while seeking, then flushed by seeked, uses fastSeek at flush time", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      video.seeking = true;

      // Scrub seek while seeking -> queued
      store.getState().seekApproximate(4.0, { scrub: true });
      expect(video.fastSeek).not.toHaveBeenCalled();
      expect(video.currentTimeSets).toBe(0);

      // Flushed by seeked
      fireSeeked(store, identityA, video);
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.fastSeek).toHaveBeenCalledWith(4.0);
      expect(video.currentTimeSets).toBe(0);
    });

    it("an exact seek to the same time as the previous scrub seek is not dropped (it assigns currentTime)", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // Scrub seek to 2.5 uses fastSeek
      store.getState().seekApproximate(2.5, { scrub: true });
      expect(video.fastSeek).toHaveBeenCalledWith(2.5);
      expect(video.currentTimeSets).toBe(0);

      fireSeeked(store, identityA, video);

      // Exact seek to same time 2.5 (e.g. pointer release of drag gesture)
      store.getState().seekApproximate(2.5, { scrub: false });
      // Must not be dropped: assigns currentTime!
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBe(2.5);
    });

    it("drag release: scrub seek issued (fastSeek), then an exact seekToPts while seeking (queued), then fireSeeked flushes it: currentTime assigned once more and fastSeek not called again", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // Scrub seek issued (uses fastSeek)
      store.getState().seekToPts("25" as Pts, { scrub: true });
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.fastSeek).toHaveBeenCalledWith(1.0);
      expect(video.currentTimeSets).toBe(0);
      expect(video.seeking).toBe(true);

      // Exact seekToPts while seeking -> queued
      store.getState().seekToPts("50" as Pts);
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.currentTimeSets).toBe(0);

      // Flushed by seeked: currentTime is assigned once more and fastSeek is not called again
      fireSeeked(store, identityA, video);
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBe(2.0);
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
    });

    it("drag release flushed by play() instead: currentTime assigned, fastSeek not called again", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // Scrub seek issued (uses fastSeek)
      store.getState().seekToPts("25" as Pts, { scrub: true });
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.fastSeek).toHaveBeenCalledWith(1.0);
      expect(video.currentTimeSets).toBe(0);
      expect(video.seeking).toBe(true);

      // Exact seekToPts while seeking -> queued
      store.getState().seekToPts("50" as Pts);
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.currentTimeSets).toBe(0);

      // Flushed by play() instead: currentTime assigned, fastSeek not called
      store.getState().play();
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBe(2.0);
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.playCalls).toBe(1);
    });

    it("a queued scrub replaced by an exact seek is flushed as exact", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      video.seeking = true;

      // First request: scrub seek queued
      store.getState().seekApproximate(3.0, { scrub: true });
      expect(video.fastSeek).not.toHaveBeenCalled();
      expect(video.currentTimeSets).toBe(0);

      // Replaced by exact seek while still seeking
      store.getState().seekApproximate(4.0, { scrub: false });
      expect(video.fastSeek).not.toHaveBeenCalled();
      expect(video.currentTimeSets).toBe(0);

      // Flushed by seeked: flushed as exact
      fireSeeked(store, identityA, video);
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBe(4.0);
      expect(video.fastSeek).not.toHaveBeenCalled();
    });

    it("a settled scrub seek (RVFC after seeked, and for a non-ready source, seeked) does NOT clear seekTargetSeconds; the settled exact seek after it DOES clear it", () => {
      // 1. Ready source: RVFC after seeked does not clear seekTargetSeconds for scrub, but clears for exact
      const storeReady = createPlaybackStore();
      const videoReady = createFakeVideo({ fastSeek: true });
      storeReady.getState().attach(sourceA, videoReady);
      videoReady.readyState = 1;
      storeReady.getState().syncReady(identityA, videoReady);
      storeReady.getState().syncPresentedFrame(identityA, 0.0, 1, videoReady);

      // Scrub seek to 2.0
      storeReady.getState().seekApproximate(2.0, { scrub: true });
      expect(storeReady.getState().seekTargetSeconds).toBe(2.0);

      // Seeked fires
      fireSeeked(storeReady, identityA, videoReady);
      expect(storeReady.getState().seekTargetSeconds).toBe(2.0);

      // RVFC fires for presented frame: settled scrub seek does NOT clear seekTargetSeconds
      storeReady.getState().syncPresentedFrame(identityA, 2.0, 2, videoReady);
      expect(storeReady.getState().seekTargetSeconds).toBe(2.0);

      // Exact seek to 2.5
      storeReady.getState().seekApproximate(2.5, { scrub: false });
      expect(storeReady.getState().seekTargetSeconds).toBe(2.5);

      // Seeked fires
      fireSeeked(storeReady, identityA, videoReady);
      expect(storeReady.getState().seekTargetSeconds).toBe(2.5);

      // RVFC fires: settled exact seek DOES clear seekTargetSeconds
      storeReady.getState().syncPresentedFrame(identityA, 2.5, 3, videoReady);
      expect(storeReady.getState().seekTargetSeconds).toBeNull();

      // 2. Non-ready source: seeked does not clear seekTargetSeconds for scrub, but clears for exact
      const storeUnready = createPlaybackStore();
      const videoUnready = createFakeVideo({ fastSeek: true });
      const unreadySource: PlaybackSource = {
        ...sourceA,
        videoStartPts: null, // calibration unavailable
      };
      const unreadyIdentity = getSourceRevisionKey(unreadySource);
      storeUnready.getState().attach(unreadySource, videoUnready);
      videoUnready.readyState = 1;
      storeUnready.getState().syncReady(unreadyIdentity, videoUnready);
      expect(storeUnready.getState().calibrationStatus).toBe("unavailable");

      // Scrub seek to 3.0
      storeUnready.getState().seekApproximate(3.0, { scrub: true });
      expect(storeUnready.getState().seekTargetSeconds).toBe(3.0);

      // Seeked fires: non-ready settled scrub seek does NOT clear seekTargetSeconds
      fireSeeked(storeUnready, unreadyIdentity, videoUnready);
      expect(storeUnready.getState().seekTargetSeconds).toBe(3.0);

      // Exact seek to 3.0
      storeUnready.getState().seekApproximate(3.0, { scrub: false });
      expect(storeUnready.getState().seekTargetSeconds).toBe(3.0);

      // Seeked fires: settled exact seek DOES clear seekTargetSeconds
      fireSeeked(storeUnready, unreadyIdentity, videoUnready);
      expect(storeUnready.getState().seekTargetSeconds).toBeNull();
    });

    it("a repeated scrub request with the same time as the previous accepted scrub is dropped, proving drop in queued state", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // 1. Not seeking: scrub to 2.0 is accepted
      store.getState().seekApproximate(2.0, { scrub: true });
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.fastSeek).toHaveBeenCalledWith(2.0);

      // Repeated scrub with same time is dropped (no dispatch, no state change)
      video.seeking = false;
      const stateWriteSpy = vi.fn();
      const unsubscribe = store.subscribe(stateWriteSpy);

      store.getState().seekApproximate(2.0, { scrub: true });
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.currentTimeSets).toBe(0);
      expect(stateWriteSpy).not.toHaveBeenCalled();

      // 2. While seeking: issue scrub to 1.0 (T), queue scrub to 3.0 (U)
      video.seeking = true;
      store.getState().seekApproximate(3.0, { scrub: true });
      expect(stateWriteSpy).toHaveBeenCalledTimes(1);
      expect(store.getState().seekTargetSeconds).toBe(3.0);
      stateWriteSpy.mockClear();

      // Repeated scrub to 3.0 (U) while seeking is dropped: no state write occurs
      store.getState().seekApproximate(3.0, { scrub: true });
      expect(stateWriteSpy).not.toHaveBeenCalled();

      // Flushing flushes U exactly once
      fireSeeked(store, identityA, video);
      expect(video.fastSeek).toHaveBeenCalledTimes(2);
      expect(video.fastSeek).toHaveBeenLastCalledWith(3.0);

      unsubscribe();
    });

    it("the audio request happens when a scrub seek is issued, not when it is queued; the direction is correct for forward and backward moves; no request for a zero move", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // 1. Audio request does NOT happen when queued
      video.seeking = true;
      store.getState().seekApproximate(2.0, { scrub: true });
      expect(requestSpy).not.toHaveBeenCalled();

      // 2. Audio request happens when flushed (issued) on seeked. Initial move has direction 1.
      fireSeeked(store, identityA, video);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(2.0, 1);

      // 3. Forward move to 3.0 (issued directly since not seeking) -> direction 1
      video.seeking = false;
      store.getState().seekApproximate(3.0, { scrub: true });
      expect(requestSpy).toHaveBeenCalledTimes(2);
      expect(requestSpy).toHaveBeenLastCalledWith(3.0, 1);

      // 4. Backward move to 1.5 -> direction -1
      video.seeking = false;
      store.getState().seekApproximate(1.5, { scrub: true });
      expect(requestSpy).toHaveBeenCalledTimes(3);
      expect(requestSpy).toHaveBeenLastCalledWith(1.5, -1);

      // 5. Zero move: duplicate scrub request with same time is dropped, so no audio request
      video.seeking = false;
      store.getState().seekApproximate(1.5, { scrub: true });
      expect(requestSpy).toHaveBeenCalledTimes(3);
    });

    it("makes the zero-move audio branch reachable: issue scrub T, queue scrub U, queue scrub T, flush: no audio request", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // 1. Issue scrub T (2.0) directly: requests audio burst at 2.0 with direction 1
      video.seeking = false;
      store.getState().seekApproximate(2.0, { scrub: true });
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(2.0, 1);
      expect(video.seeking).toBe(true);

      // 2. Queue scrub U (3.0): queued while seeking, no audio request yet
      store.getState().seekApproximate(3.0, { scrub: true });
      expect(requestSpy).toHaveBeenCalledTimes(1);

      // 3. Queue scrub T (2.0): replaces U with T, not dropped because last was U (3.0)
      store.getState().seekApproximate(2.0, { scrub: true });
      expect(requestSpy).toHaveBeenCalledTimes(1);

      // 4. Flush queued seek (which is 2.0, equal to lastScrubAudioTarget 2.0)
      // Hits mediaTime === lastScrubAudioTarget branch in requestScrubBurst: zero-move skips audio!
      fireSeeked(store, identityA, video);
      expect(requestSpy).toHaveBeenCalledTimes(1);
    });

    it("exact accepted seek sets lastScrubAudioTarget so first scrub measures direction from pointer down and zero move makes no sound", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // Pointer down: exact seek to 2.0
      store.getState().seekApproximate(2.0, { scrub: false });
      expect(requestSpy).not.toHaveBeenCalled();

      // First scrub after pointer down moves backward to 1.5 -> direction -1 from 2.0
      video.seeking = false;
      store.getState().seekApproximate(1.5, { scrub: true });
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(1.5, -1);

      // Pointer down exact seek to 3.0
      video.seeking = false;
      store.getState().seekApproximate(3.0, { scrub: false });

      // First scrub moves forward to 3.5 -> direction 1 from 3.0
      video.seeking = false;
      store.getState().seekApproximate(3.5, { scrub: true });
      expect(requestSpy).toHaveBeenCalledTimes(2);
      expect(requestSpy).toHaveBeenLastCalledWith(3.5, 1);

      // Pointer down exact seek to 4.0
      video.seeking = false;
      store.getState().seekApproximate(4.0, { scrub: false });

      // Scrub to exactly 4.0 (zero move from pointer down): dropped as duplicate of last accepted, no audio
      video.seeking = false;
      store.getState().seekApproximate(4.0, { scrub: true });
      expect(requestSpy).toHaveBeenCalledTimes(2);
    });

    it("an exact seekToPts / seekApproximate stops the cue (scrubAudioController.stop is called), a scrub one does not", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // Scrub seekApproximate does not call stop()
      stopSpy.mockClear();
      video.seeking = false;
      store.getState().seekApproximate(2.0, { scrub: true });
      expect(stopSpy).not.toHaveBeenCalled();

      // Scrub seekToPts does not call stop()
      stopSpy.mockClear();
      video.seeking = false;
      store.getState().seekToPts("25" as Pts, { scrub: true });
      expect(stopSpy).not.toHaveBeenCalled();

      // Exact seekApproximate calls stop()
      stopSpy.mockClear();
      video.seeking = false;
      store.getState().seekApproximate(3.0);
      expect(stopSpy).toHaveBeenCalled();

      // Exact seekToPts calls stop()
      stopSpy.mockClear();
      video.seeking = false;
      store.getState().seekToPts("50" as Pts);
      expect(stopSpy).toHaveBeenCalled();
    });

    it("play() flushing a queued scrub seek flushes as exact, does not request audio, and resets lastAcceptedSeek", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // Queue a scrub seek while seeking
      video.seeking = true;
      store.getState().seekApproximate(4.0, { scrub: true });
      expect(requestSpy).not.toHaveBeenCalled();
      expect(video.currentTimeSets).toBe(0);

      // play() flushes the queued seek as EXACT (currentTime, not fastSeek)
      stopSpy.mockClear();
      store.getState().play();

      // Flushed by play() must NOT request audio
      expect(requestSpy).not.toHaveBeenCalled();
      expect(stopSpy).toHaveBeenCalled();
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBe(4.0);
      expect(video.fastSeek).not.toHaveBeenCalled();
      expect(video.playCalls).toBe(1);

      // play() resets lastAcceptedSeek to null, so a subsequent scrub seek at 4.0 is not dropped
      video.seeking = false;
      store.getState().seekApproximate(4.0, { scrub: true });
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.fastSeek).toHaveBeenCalledWith(4.0);
    });

    it("play() after an issued (not queued) fastSeek scrub assigns currentTime to the scrub target", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // Element is at 1.0s, not seeking
      video.currentTime = 1.0;
      video.seeking = false;
      const initialSets = video.currentTimeSets;

      // Issue a scrub seek while not seeking
      store.getState().seekApproximate(4.0, { scrub: true });
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.fastSeek).toHaveBeenCalledWith(4.0);
      expect(video.currentTimeSets).toBe(initialSets);
      expect(video.currentTime).toBe(1.0);

      // play() assigns currentTime to the pending scrub target (4.0) as an exact seek
      stopSpy.mockClear();
      requestSpy.mockClear();
      store.getState().play();

      expect(requestSpy).not.toHaveBeenCalled();
      expect(stopSpy).toHaveBeenCalled();
      expect(video.currentTimeSets).toBe(initialSets + 1);
      expect(video.currentTime).toBe(4.0);
      expect(video.playCalls).toBe(1);

      // lastAcceptedSeek is cleared by play(), so a subsequent scrub seek at 4.0 is not dropped
      video.seeking = false;
      store.getState().seekApproximate(4.0, { scrub: true });
      expect(video.fastSeek).toHaveBeenCalledTimes(2);
      expect(video.fastSeek).toHaveBeenLastCalledWith(4.0);
    });

    it("seekNominal after an issued scrub steps from the scrub target, not from currentTime", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);

      // Element is at 1.0s
      video.currentTime = 1.0;
      video.seeking = false;

      // Issue a scrub seek to 4.0: fastSeek is called, currentTime remains 1.0
      store.getState().seekApproximate(4.0, { scrub: true });
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.fastSeek).toHaveBeenCalledWith(4.0);
      expect(video.currentTime).toBe(1.0);

      // seekNominal(1 frame) should step from the pending scrub target (4.0), not currentTime (1.0).
      // sourceA has 25fps (1 frame = 0.04s), so target should be 4.04s, not 1.04s.
      video.seeking = false;
      store.getState().seekNominal(1);
      expect(video.currentTime).toBeCloseTo(4.04, 5);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(4.04, 5);

      // Stepping backward (-2 frames = -0.08s) after an issued scrub to 4.0 steps to 3.92s
      video.currentTime = 1.0;
      video.seeking = false;
      store.getState().seekApproximate(4.0, { scrub: true });
      video.seeking = false;
      store.getState().seekNominal(-2);
      expect(video.currentTime).toBeCloseTo(3.92, 5);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(3.92, 5);
    });

    it("a throwing fastSeek results in seekFailed and clears seekTargetSeconds and presentedFrame", () => {
      // 1. Issued immediately when not seeking
      const store1 = createPlaybackStore();
      const video1 = createFakeVideo({ fastSeek: true, throwOnFastSeek: true });
      store1.getState().attach(sourceA, video1);
      video1.readyState = 1;
      store1.getState().syncReady(identityA, video1);
      store1.getState().syncPresentedFrame(identityA, 0.0, 1, video1);

      store1.getState().seekApproximate(2.0, { scrub: true });
      expect(store1.getState().error).toBe("seekFailed");
      expect(store1.getState().seekTargetSeconds).toBeNull();
      expect(store1.getState().presentedFrame).toBeNull();
      expect(store1.getState().isPlaying).toBe(false);

      // 2. Flushed from queuedSeek
      const store2 = createPlaybackStore();
      const video2 = createFakeVideo({ fastSeek: true, throwOnFastSeek: true });
      store2.getState().attach(sourceA, video2);
      video2.readyState = 1;
      store2.getState().syncReady(identityA, video2);
      store2.getState().syncPresentedFrame(identityA, 0.0, 1, video2);

      video2.seeking = true;
      store2.getState().seekApproximate(3.0, { scrub: true });
      expect(store2.getState().seekTargetSeconds).toBe(3.0);
      expect(store2.getState().error).toBeNull();

      fireSeeked(store2, identityA, video2);
      expect(store2.getState().error).toBe("seekFailed");
      expect(store2.getState().seekTargetSeconds).toBeNull();
      expect(store2.getState().presentedFrame).toBeNull();
      expect(store2.getState().isPlaying).toBe(false);
    });

    it("scrub seekToPts calls fastSeek and sets seekTargetSeconds with presentedFrame null", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().presentedFrame).not.toBeNull();

      store.getState().seekToPts("50" as Pts, { scrub: true }); // 2.0s
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.fastSeek).toHaveBeenCalledWith(2.0);
      expect(video.currentTimeSets).toBe(0);
      expect(store.getState().seekTargetSeconds).toBe(2.0);
      expect(store.getState().presentedFrame).toBeNull();
    });

    it("attach (including after reset or detach) and syncUnready reset closure state so a scrub at previous time is not dropped", () => {
      // 1. Re-attaching after reset() resets closure state
      const store1 = createPlaybackStore();
      const video1 = createFakeVideo({ fastSeek: true });
      store1.getState().attach(sourceA, video1);
      video1.readyState = 1;
      store1.getState().syncReady(identityA, video1);
      store1.getState().syncPresentedFrame(identityA, 0.0, 1, video1);

      store1.getState().seekApproximate(2.0, { scrub: true });
      expect(video1.fastSeek).toHaveBeenCalledTimes(1);
      expect(video1.fastSeek).toHaveBeenCalledWith(2.0);

      // Element finishes seek, then reset() is called
      video1.seeking = false;
      store1.getState().reset();
      expect(store1.getState().seekTargetSeconds).toBeNull();

      // Re-attach same source and element
      store1.getState().attach(sourceA, video1);
      video1.readyState = 1;
      store1.getState().syncReady(identityA, video1);
      store1.getState().syncPresentedFrame(identityA, 0.0, 1, video1);

      // Scrub at the same time 2.0 is NOT dropped as duplicate
      store1.getState().seekApproximate(2.0, { scrub: true });
      expect(video1.fastSeek).toHaveBeenCalledTimes(2);
      expect(video1.fastSeek).toHaveBeenLastCalledWith(2.0);

      // 2. Re-attaching after detach() resets closure state
      const store2 = createPlaybackStore();
      const video2 = createFakeVideo({ fastSeek: true });
      store2.getState().attach(sourceA, video2);
      video2.readyState = 1;
      store2.getState().syncReady(identityA, video2);
      store2.getState().syncPresentedFrame(identityA, 0.0, 1, video2);

      store2.getState().seekApproximate(3.0, { scrub: true });
      expect(video2.fastSeek).toHaveBeenCalledTimes(1);

      // Element finishes seek, then detach() is called
      video2.seeking = false;
      store2.getState().detach(identityA, video2);

      // Re-attach
      store2.getState().attach(sourceA, video2);
      video2.readyState = 1;
      store2.getState().syncReady(identityA, video2);
      store2.getState().syncPresentedFrame(identityA, 0.0, 1, video2);

      // Scrub at 3.0 is NOT dropped
      store2.getState().seekApproximate(3.0, { scrub: true });
      expect(video2.fastSeek).toHaveBeenCalledTimes(2);
      expect(video2.fastSeek).toHaveBeenLastCalledWith(3.0);

      // 3. syncUnready()
      const store3 = createPlaybackStore();
      const video3 = createFakeVideo({ fastSeek: true });
      store3.getState().attach(sourceA, video3);
      video3.readyState = 1;
      store3.getState().syncReady(identityA, video3);
      store3.getState().syncPresentedFrame(identityA, 0.0, 1, video3);

      store3.getState().seekApproximate(4.0, { scrub: true });
      expect(video3.fastSeek).toHaveBeenCalledTimes(1);

      // Element finishes seek, then syncUnready() is called
      video3.seeking = false;
      store3.getState().syncUnready(identityA, video3);
      expect(store3.getState().seekTargetSeconds).toBeNull();
      store3.getState().syncReady(identityA, video3);

      // Scrub at 4.0 is NOT dropped
      store3.getState().seekApproximate(4.0, { scrub: true });
      expect(video3.fastSeek).toHaveBeenCalledTimes(2);
      expect(video3.fastSeek).toHaveBeenLastCalledWith(4.0);

      // 4. attach() with a new element resets closure state
      const store4 = createPlaybackStore();
      const video4a = createFakeVideo({ fastSeek: true });
      const video4b = createFakeVideo({ fastSeek: true });
      store4.getState().attach(sourceA, video4a);
      video4a.readyState = 1;
      store4.getState().syncReady(identityA, video4a);
      store4.getState().syncPresentedFrame(identityA, 0.0, 1, video4a);

      store4.getState().seekApproximate(5.0, { scrub: true });
      expect(video4a.fastSeek).toHaveBeenCalledTimes(1);

      store4.getState().attach(sourceA, video4b);
      video4b.readyState = 1;
      store4.getState().syncReady(identityA, video4b);
      store4.getState().syncPresentedFrame(identityA, 0.0, 1, video4b);

      // Scrub at 5.0 is NOT dropped on video4b
      store4.getState().seekApproximate(5.0, { scrub: true });
      expect(video4b.fastSeek).toHaveBeenCalledTimes(1);
      expect(video4b.fastSeek).toHaveBeenCalledWith(5.0);
    });
  });
});
