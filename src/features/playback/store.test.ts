import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  APPROXIMATE_SHORTCUT_SEEK_OPTIONS,
  EXTENT_END_SEEK_OPTIONS,
} from "@/components/layout/shortcutCommands";
import { getSourceRevisionKey } from "@/features/media";
import { canMarkIn } from "@/features/timeline";
import * as timeLib from "@/lib/time";
import {
  formatElapsedTimecode,
  formatFrameTimecodeFromTicks,
  frameBoundaryMarginSeconds,
  isFrameGridExact,
} from "@/lib/timecode";
import type { Pts, Rational, TickCount } from "@/types/project";
import { getDisplayedElapsedSeconds } from "./presentation";
import { scrubAudioController } from "./scrubAudio";
import {
  createPlaybackStore,
  getNominalFrameRate,
  hasNominalFrameRate,
  hasVariableFrameRate,
  type PlaybackStore,
} from "./store";
import { resolveTimecodeDisplay } from "./timecodeDisplay";
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
  /** Stops a seek at `duration`, as a browser does with a time past the end of the media. */
  clampToDuration?: boolean;
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
      currentTimeVal =
        options?.clampToDuration === true && Number.isFinite(fake.duration)
          ? Math.min(val, fake.duration)
          : val;
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

    it("reports seekFailed when seekToPts is called on a source that cannot calibrate", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentationUnavailable(identityA, video);

      store.getState().seekToPts("25" as Pts);
      expect(store.getState().error).toBe("seekFailed");
      expect(video.currentTimeSets).toBe(0);
    });

    it("defers seekToPts while the calibration is still open, and reports no error", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // Still in calibrating state. The display target needs no anchor.
      store.getState().seekToPts("25" as Pts);
      expect(store.getState().error).toBeNull();
      expect(video.currentTimeSets).toBe(0);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(1.0, 9);
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

  describe("seekToPts to the End of the Extent (ADR 026)", () => {
    // End off the frame grid: 10 s on 1/90000 at a variable rate, with an audio lead of 0.5 s.
    // The last tick is PTS 899999, and the last frame starts before it, at PTS 897030.
    const vfrSource: PlaybackSource = {
      path: "/media/phone.mp4",
      size: 4096,
      mtime: 1724977000,
      videoTimeBase: { n: 1, d: 90000 },
      videoStartPts: "0" as Pts,
      videoDurationTicks: "900000" as TickCount,
      approximateDurationSeconds: 10,
      avgFrameRate: { n: 2997, d: 100 },
      rFrameRate: { n: 30, d: 1 },
    };
    const vfrKey = getSourceRevisionKey(vfrSource);
    const LEAD = 0.5;
    const LAST_TICK = "899999" as Pts;
    const LAST_TICK_TIME = LEAD + 899999 / 90000;
    const LAST_FRAME_TIME = LEAD + 897030 / 90000;

    /** A calibrated source whose element stands at the last tick, with the last frame on screen. */
    function atExtentEnd() {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 10.6 });
      store.getState().attach(vfrSource, video);
      store.getState().syncReady(vfrKey, video);
      store.getState().syncPresentedFrame(vfrKey, LEAD, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");

      store.getState().seekToPts(LAST_TICK, EXTENT_END_SEEK_OPTIONS);
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBeCloseTo(LAST_TICK_TIME, 9);
      fireSeeked(store, vfrKey, video);
      store.getState().syncPresentedFrame(vfrKey, LAST_FRAME_TIME, 2, video);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("897030");
      expect(store.getState().seekTargetSeconds).toBeNull();
      return { store, video };
    }

    it("does nothing when the element already stands at the last tick with its frame on screen", () => {
      const { store, video } = atExtentEnd();
      const frame = store.getState().presentedFrame;

      store.getState().seekToPts(LAST_TICK, EXTENT_END_SEEK_OPTIONS);
      expect(video.currentTimeSets).toBe(1);
      expect(store.getState().presentedFrame).toBe(frame);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(store.getState().error).toBeNull();
    });

    it("does nothing when the element stands after the last tick, as at the end of playback", () => {
      const { store, video } = atExtentEnd();
      store.getState().play();
      // The element plays on to the end of its audio, and the last video frame stays.
      video.currentTime = 10.6;
      video.seeking = false;
      store.getState().syncEnded(vfrKey, video);
      expect(store.getState().isPlaying).toBe(false);
      const sets = video.currentTimeSets;

      store.getState().seekToPts(LAST_TICK, EXTENT_END_SEEK_OPTIONS);
      expect(video.currentTimeSets).toBe(sets);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("897030");
    });

    it("seeks from a position before the last tick", () => {
      const { store, video } = atExtentEnd();
      store.getState().seekToPts("450000" as Pts);
      fireSeeked(store, vfrKey, video);
      store.getState().syncPresentedFrame(vfrKey, LEAD + 5, 3, video);
      const sets = video.currentTimeSets;

      store.getState().seekToPts(LAST_TICK, EXTENT_END_SEEK_OPTIONS);
      expect(video.currentTimeSets).toBe(sets + 1);
      expect(video.currentTime).toBeCloseTo(LAST_TICK_TIME, 9);
    });

    it("seeks from the last tick while a seek is pending, the source plays, or without the option", () => {
      // A pending seek: the element is moving away from the last tick.
      const pending = atExtentEnd();
      pending.store.getState().seekToPts("450000" as Pts);
      pending.store.getState().seekToPts(LAST_TICK, EXTENT_END_SEEK_OPTIONS);
      fireSeeked(pending.store, vfrKey, pending.video);
      expect(pending.video.currentTimeSets).toBe(3);
      expect(pending.video.currentTime).toBeCloseTo(LAST_TICK_TIME, 9);

      // Playback: the frame on screen changes, and the seek also stops the playback.
      const playing = atExtentEnd();
      playing.store.getState().play();
      playing.store.getState().seekToPts(LAST_TICK, EXTENT_END_SEEK_OPTIONS);
      expect(playing.video.currentTimeSets).toBe(2);
      expect(playing.store.getState().isPlaying).toBe(false);

      // Without the option the store seeks onto the frame on screen, which clears it.
      const plain = atExtentEnd();
      plain.store.getState().seekToPts(LAST_TICK);
      expect(plain.video.currentTimeSets).toBe(2);
      expect(plain.store.getState().presentedFrame).toBeNull();
    });

    describe("an element whose duration ends before the last tick", () => {
      // An MP4 with B-frames and no edit list reports the composition offset as its start PTS,
      // so the calibrated mapping puts the last tick past the end of the element. The element
      // stops the seek of End at its duration.
      const DURATION = 10.45;

      function attachShort() {
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration: DURATION, clampToDuration: true });
        store.getState().attach(vfrSource, video);
        store.getState().syncReady(vfrKey, video);
        store.getState().syncBrowserDuration(vfrKey, video);
        store.getState().syncPresentedFrame(vfrKey, LEAD, 1, video);
        expect(store.getState().runtimeBrowserDurationSeconds).toBe(DURATION);
        return { store, video };
      }

      it("two Ends make one seek", () => {
        const { store, video } = attachShort();
        store.getState().seekToPts(LAST_TICK, EXTENT_END_SEEK_OPTIONS);
        expect(video.currentTimeSets).toBe(1);
        expect(video.currentTime).toBe(DURATION);
        fireSeeked(store, vfrKey, video);
        store.getState().syncPresentedFrame(vfrKey, LEAD + 893700 / 90000, 2, video);
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("893700");

        store.getState().seekToPts(LAST_TICK, EXTENT_END_SEEK_OPTIONS);
        expect(video.currentTimeSets).toBe(1);
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("893700");
        expect(store.getState().seekTargetSeconds).toBeNull();
      });

      it("End after the end of playback makes no seek", () => {
        const { store, video } = attachShort();
        store.getState().play();
        video.currentTime = DURATION;
        video.seeking = false;
        store.getState().syncPresentedFrame(vfrKey, LEAD + 893700 / 90000, 2, video);
        store.getState().syncEnded(vfrKey, video);
        const sets = video.currentTimeSets;

        store.getState().seekToPts(LAST_TICK, EXTENT_END_SEEK_OPTIONS);
        expect(video.currentTimeSets).toBe(sets);
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("893700");
      });

      it("seeks from a position before the duration", () => {
        const { store, video } = attachShort();
        store.getState().seekToPts("450000" as Pts);
        fireSeeked(store, vfrKey, video);
        store.getState().syncPresentedFrame(vfrKey, LEAD + 5, 2, video);

        store.getState().seekToPts(LAST_TICK, EXTENT_END_SEEK_OPTIONS);
        expect(video.currentTimeSets).toBe(2);
        expect(video.currentTime).toBe(DURATION);
      });
    });

    it("defers as any seek while the calibration is open", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 10.6 });
      store.getState().attach(vfrSource, video);
      store.getState().syncReady(vfrKey, video);

      store.getState().seekToPts(LAST_TICK, EXTENT_END_SEEK_OPTIONS);
      expect(video.currentTimeSets).toBe(0);
      expect(store.getState().hasDeferredNavigation).toBe(true);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(899999 / 90000, 9);

      store.getState().syncPresentedFrame(vfrKey, LEAD, 1, video);
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBeCloseTo(LAST_TICK_TIME, 9);
    });
  });

  describe("dismissError", () => {
    it("clears a seek error and keeps the attachment and calibration", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      store.getState().seekToPts("invalid" as Pts);
      expect(store.getState().error).toBe("seekFailed");
      const before = store.getState();

      store.getState().dismissError();

      const after = store.getState();
      expect(after.error).toBeNull();
      expect(after.isAttached).toBe(true);
      expect(after.isReady).toBe(true);
      expect(after.attachedSourceRevisionKey).toBe(identityA);
      expect(after.calibrationStatus).toBe(before.calibrationStatus);
      expect(after.presentedFrame).toBe(before.presentedFrame);
    });

    it("clears the error only while the store still holds the code it names", () => {
      const store = createPlaybackStore({ error: "seekFailed" });
      const listener = vi.fn();
      store.subscribe(listener);

      // A timer of an older notice names a code that the store no longer holds.
      store.getState().dismissError("playbackFailed");
      expect(store.getState().error).toBe("seekFailed");
      expect(listener).not.toHaveBeenCalled();

      store.getState().dismissError("seekFailed");
      expect(store.getState().error).toBeNull();
    });

    it("clears any error when no code is named", () => {
      const store = createPlaybackStore({ error: "playbackFailed" });

      store.getState().dismissError();

      expect(store.getState().error).toBeNull();
    });

    it("does not notify subscribers when no error is set", () => {
      const store = createPlaybackStore();
      const listener = vi.fn();
      store.subscribe(listener);

      store.getState().dismissError();

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("Nominal Seek Hints", () => {
    it("chooses avgFrameRate then rFrameRate and steps currentTime by nominal frame duration", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ autoSeeking: false });

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      // A source that never calibrates steps on the approximate clock (ADR 021).
      store.getState().syncPresentationUnavailable(identityA, video);

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
      store.getState().syncPresentationUnavailable(identity, video);

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
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      // The element moves on after metadata loaded, so the timeline origin stays 0. It stands
      // inside frame 5 and presents that frame.
      video.currentTime = 0.22;
      video.seeking = false;
      store.getState().syncPresentedFrame(identityA, 0.2, 2, video);

      // Seek -10 frames from frame 5 -> clamps to 0
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
      store.getState().syncPresentationUnavailable(identityA, video);

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
      store.getState().syncPresentationUnavailable(identityA, video);

      store.getState().seekApproximate(10);
      expect(video.currentTime).toBe(15);

      store.getState().syncBrowserTime(identityA, video);
      expect(store.getState().approximateBrowserTimeSeconds).toBe(10);
    });

    it("clamps an offset approximate seek to the browser duration", () => {
      const store = createPlaybackStore();
      const video = attachWithOrigin(store, 5, 65);
      store.getState().syncBrowserDuration(identityA, video);
      store.getState().syncPresentationUnavailable(identityA, video);

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
      const video = createFakeVideo();

      // sourceA has approximateDurationSeconds: 10.0
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentationUnavailable(identityA, video);
      // The element moves on after metadata loaded, so the timeline origin stays 0.
      video.currentTime = 9.98;
      video.seeking = false;

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

    it("keeps the anchor after a ruler click that precedes the first presented frame", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 600 });

      // React mounts the node, so the element carries no metadata yet
      store.getState().attach(sourceA, video);
      expect(store.getState().calibrationStatus).toBe("calibrating");

      // Loaded metadata makes the ruler clickable
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncBrowserDuration(identityA, video);

      // The user clicks the ruler at half of a 10-minute clip before the first RVFC callback.
      // The seek waits for the anchor, so the element stays at the start.
      store.getState().seekApproximate(300);
      expect(video.currentTimeSets).toBe(0);
      expect(store.getState().seekTargetSeconds).toBe(300);

      // The first callback reports the first frame, which anchors videoStartPts. The click
      // then runs.
      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(video.currentTime).toBe(300);
      expect(store.getState().presentedFrame).toBeNull();

      store.getState().syncPresentedFrame(identityA, 300, 2, video);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("7500");
    });

    it("keeps the anchor after a nominal step that precedes the first presented frame", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);

      // The step waits for the anchor, so the first callback is still the first frame
      store.getState().seekNominal(1);
      expect(video.currentTimeSets).toBe(0);

      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      // The step runs on the frame grid, to the middle of frame 1
      expect(video.currentTime).toBeCloseTo(0.06, 9);

      store.getState().syncPresentedFrame(identityA, 0.04, 2, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("1");
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
      // A source that never calibrates steps on the approximate clock (ADR 021).
      store.getState().syncPresentationUnavailable(identityA, video);

      // sourceA has fps25 ({ n: 25, d: 1 }), so 1 frame = 1/25 = 0.04s.
      // Target time = 2.0 + 0.04 = 2.04s.
      store.getState().seekNominal(1);

      expect(video.currentTime).toBe(2.04);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(2.04, 1);
    });

    it("calls request with the same target seconds assigned to the element and direction -1 on backward seekNominal", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      // A source that never calibrates steps on the approximate clock (ADR 021).
      store.getState().syncPresentationUnavailable(identityA, video);
      // The element moves on after metadata loaded, so the timeline origin stays 0.
      video.currentTime = 2.0;
      video.seeking = false;

      // sourceA has fps25 ({ n: 25, d: 1 }), so -1 frame = -0.04s.
      // Target time = 2.0 - 0.04 = 1.96s.
      store.getState().seekNominal(-1);

      expect(video.currentTime).toBe(1.96);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(1.96, -1);
    });

    it("calls request with 0 and direction -1 when stepping backward clamps to 0", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      // A source that never calibrates steps on the approximate clock (ADR 021).
      store.getState().syncPresentationUnavailable(identityA, video);
      // The element moves on after metadata loaded, so the timeline origin stays 0.
      video.currentTime = 0.01;
      video.seeking = false;

      // sourceA has fps25 (0.04s per frame). Stepping backward from 0.01 clamps to 0.
      store.getState().seekNominal(-1);

      expect(video.currentTime).toBe(0);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(0, -1);
    });

    it("calls request with approximateDurationSeconds and direction 1 when stepping forward clamps to upper bound", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      // A source that never calibrates steps on the approximate clock (ADR 021).
      store.getState().syncPresentationUnavailable(identityA, video);
      // The element moves on after metadata loaded, so the timeline origin stays 0.
      video.currentTime = 9.99;
      video.seeking = false;

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
      // A source that never calibrates steps on the approximate clock (ADR 021).
      store.getState().syncPresentationUnavailable(identityA, video);

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
      store.getState().syncPresentationUnavailable(identityA, video);

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
      store.getState().syncPresentationUnavailable(identityA, video);

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
      store.getState().syncPresentationUnavailable(identityA, video);
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
      store.getState().syncPresentationUnavailable(identityA, throwingVideo);
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
      store.getState().syncPresentationUnavailable(identityA, video);
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
      store.getState().syncPresentationUnavailable(identityA, video);

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
      expect(video.currentTime).toBeCloseTo(1.06, 5);
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
      // sourceA has 25fps (1 frame = 0.04s), and 4.0 s is frame 100, so the element seeks to the
      // middle of frame 101, 4.06 s, not 1.06 s. The display target is the nominal start of
      // frame 101.
      video.seeking = false;
      store.getState().seekNominal(1);
      expect(video.currentTime).toBeCloseTo(4.06, 5);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(4.04, 5);

      // Stepping backward 2 frames after an issued scrub to 4.0 (frame 100) seeks to the middle
      // of frame 98, 3.94 s, and displays its nominal start
      video.currentTime = 1.0;
      video.seeking = false;
      store.getState().seekApproximate(4.0, { scrub: true });
      video.seeking = false;
      store.getState().seekNominal(-2);
      expect(video.currentTime).toBeCloseTo(3.94, 5);
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

  describe("Nominal Step at the Source Edges", () => {
    let requestSpy: MockInstance<typeof scrubAudioController.request>;

    beforeEach(() => {
      requestSpy = vi.spyOn(scrubAudioController, "request");
    });

    afterEach(() => {
      requestSpy.mockRestore();
    });

    /** Attaches sourceA (25 fps, 10 s) and calibrates it on the frame at 0 s. */
    function attachCalibrated(
      store: PlaybackStore,
      video: ReturnType<typeof createFakeVideo>,
    ): void {
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
    }

    /** Completes the running seek and reports the frame the element presented. */
    function settle(
      store: PlaybackStore,
      video: ReturnType<typeof createFakeVideo>,
      mediaTime: number,
      presentedFrames: number,
    ): void {
      fireSeeked(store, identityA, video);
      store.getState().syncPresentedFrame(identityA, mediaTime, presentedFrames, video);
    }

    it("a step back at the first position dispatches no seek, keeps presentedFrame and requests no cue", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrated(store, video);
      const presented = store.getState().presentedFrame;
      expect(presented?.inferredSourcePts).toBe("0");
      const pauseCallsBefore = video.pauseCalls;

      store.getState().seekNominal(-1);
      store.getState().seekNominal(-5);

      expect(video.currentTimeSets).toBe(0);
      expect(video.currentTime).toBe(0);
      expect(video.seeking).toBe(false);
      expect(video.pauseCalls).toBe(pauseCallsBefore);
      expect(store.getState().presentedFrame).toBe(presented);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(store.getState().error).toBeNull();
      expect(canMarkIn("ready", store.getState().presentedFrame, true)).toBe(true);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it("a step forward at the last position dispatches no seek, keeps presentedFrame and requests no cue", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrated(store, video);

      // Reach the upper bound of the clamp (approximateDurationSeconds 10.0). The element
      // presents the last frame, PTS 249 at 25 fps.
      store.getState().seekToPts("250" as Pts);
      expect(video.currentTime).toBe(sourceA.approximateDurationSeconds);
      settle(store, video, 9.96, 2);
      const presented = store.getState().presentedFrame;
      expect(presented?.inferredSourcePts).toBe("249");
      expect(store.getState().seekTargetSeconds).toBeNull();
      const setsBefore = video.currentTimeSets;
      const pauseCallsBefore = video.pauseCalls;

      store.getState().seekNominal(1);
      store.getState().seekNominal(3);

      expect(video.currentTimeSets).toBe(setsBefore);
      expect(video.currentTime).toBe(sourceA.approximateDurationSeconds);
      expect(video.seeking).toBe(false);
      expect(video.pauseCalls).toBe(pauseCallsBefore);
      expect(store.getState().presentedFrame).toBe(presented);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it("treats a position less than the tolerance from the edge as the edge", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      // The element moves on after metadata loaded, so the timeline origin stays 0.
      video.currentTime = 1e-7;
      video.seeking = false;
      const setsBefore = video.currentTimeSets;

      store.getState().seekNominal(-1);

      expect(video.currentTimeSets).toBe(setsBefore);
      expect(video.currentTime).toBe(1e-7);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it("treats a position less than the tolerance from the last position as the edge", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      // The upper bound is the approximate duration, 10 s, on a timeline that starts at 0.
      video.currentTime = 10 - 1e-7;
      video.seeking = false;
      const setsBefore = video.currentTimeSets;

      store.getState().seekNominal(1);

      expect(video.currentTimeSets).toBe(setsBefore);
      expect(video.currentTime).toBe(10 - 1e-7);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it("a step at an edge before the anchor does not count as a seek before calibration", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      expect(store.getState().calibrationStatus).toBe("calibrating");

      store.getState().seekNominal(-1);
      expect(video.currentTimeSets).toBe(0);

      // The element never left the start, so the first callback still anchors videoStartPts.
      store.getState().syncPresentedFrame(identityA, 0.0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
    });

    it("a step away from either edge still seeks and requests a cue", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrated(store, video);

      // A press toward the edge first does nothing, and it leaves the next step intact. The step
      // seeks to the middle of frame 1 and displays its nominal start.
      store.getState().seekNominal(-1);
      store.getState().seekNominal(1);
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBeCloseTo(0.06, 9);
      expect(store.getState().presentedFrame).toBeNull();
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenLastCalledWith(video.currentTime, 1);

      // Go to the upper bound, press toward it, then step back from it.
      settle(store, video, 0.04, 2);
      store.getState().seekToPts("250" as Pts);
      settle(store, video, 9.96, 3);
      requestSpy.mockClear();
      const setsBefore = video.currentTimeSets;

      // The element stands at the upper bound, 10 s, and presents frame 249. The step back starts
      // from that frame, so it seeks to the middle of frame 248 and displays its nominal start.
      store.getState().seekNominal(1);
      store.getState().seekNominal(-1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(video.currentTime).toBeCloseTo(9.94, 9);
      expect(store.getState().presentedFrame).toBeNull();
      expect(store.getState().seekTargetSeconds).toBeCloseTo(9.92, 9);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenLastCalledWith(video.currentTime, -1);
    });

    it("quick presses toward the first frame during a pending seek end on it without a trailing seek", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrated(store, video);

      // Start two frames from the edge.
      store.getState().seekToPts("2" as Pts);
      settle(store, video, 0.08, 2);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("2");
      const setsBefore = video.currentTimeSets;

      // First press: the element is idle, so the seek to the middle of frame 1 (0.06 s) runs at
      // once.
      store.getState().seekNominal(-1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(video.currentTime).toBeCloseTo(0.06, 9);
      expect(video.seeking).toBe(true);

      // Second press: the element still seeks, so the seek to the middle of frame 0 (0.02 s) is
      // queued. The display target is the nominal start of frame 0.
      store.getState().seekNominal(-1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(store.getState().seekTargetSeconds).toBe(0);

      // Later presses build on the queued target, which lies in the first frame. The clamp pulls
      // their targets to the start of that same frame, so they do nothing.
      store.getState().seekNominal(-1);
      store.getState().seekNominal(-1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(store.getState().seekTargetSeconds).toBe(0);
      expect(requestSpy.mock.calls).toHaveLength(2);
      expect(requestSpy.mock.calls[0][0]).toBeCloseTo(0.06, 9);
      expect(requestSpy.mock.calls[0][1]).toBe(-1);
      expect(requestSpy.mock.calls[1][0]).toBeCloseTo(0.02, 9);
      expect(requestSpy.mock.calls[1][1]).toBe(-1);

      // The seeked event of the running seek starts the queued seek to the first frame.
      fireSeeked(store, identityA, video);
      expect(video.currentTimeSets).toBe(setsBefore + 2);
      expect(video.currentTime).toBeCloseTo(0.02, 9);

      // The seek to 0 settles on the first frame.
      settle(store, video, 0.0, 3);
      const presented = store.getState().presentedFrame;
      expect(presented?.inferredSourcePts).toBe("0");
      expect(store.getState().seekTargetSeconds).toBeNull();

      // A further press at the edge dispatches nothing.
      store.getState().seekNominal(-1);
      fireSeeked(store, identityA, video);
      expect(video.currentTimeSets).toBe(setsBefore + 2);
      expect(store.getState().presentedFrame).toBe(presented);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(requestSpy.mock.calls).toHaveLength(2);
    });

    it("a step away from the edge during a pending seek to the edge replaces the queued seek", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrated(store, video);
      store.getState().seekToPts("1" as Pts);
      settle(store, video, 0.04, 2);
      const setsBefore = video.currentTimeSets;

      // The seek to the first frame (its middle, 0.02 s) runs, and the next seek toward the
      // edge is absorbed. The display target is the nominal start of frame 0.
      store.getState().seekNominal(-1);
      expect(video.currentTime).toBeCloseTo(0.02, 9);
      expect(video.seeking).toBe(true);
      expect(store.getState().seekTargetSeconds).toBe(0);
      store.getState().seekNominal(-1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(store.getState().seekTargetSeconds).toBe(0);

      // While the element still seeks, a step forward queues the middle of frame 1 (0.06 s), and
      // a step back replaces it with a queued seek to the first frame.
      store.getState().seekNominal(1);
      expect(requestSpy.mock.lastCall?.[0]).toBeCloseTo(0.06, 9);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);
      store.getState().seekNominal(-1);
      expect(requestSpy.mock.lastCall?.[0]).toBeCloseTo(0.02, 9);
      expect(store.getState().seekTargetSeconds).toBe(0);

      // A step away from the queued edge target still replaces the queued seek.
      store.getState().seekNominal(1);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);
      expect(requestSpy.mock.lastCall?.[0]).toBeCloseTo(0.06, 9);
      expect(requestSpy.mock.lastCall?.[1]).toBe(1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);

      // The seeked event starts the latest queued seek, not the one to the edge.
      fireSeeked(store, identityA, video);
      expect(video.currentTimeSets).toBe(setsBefore + 2);
      expect(video.currentTime).toBeCloseTo(0.06, 9);
    });

    it("a pending scrub target at the edge does not absorb an exact step (ADR 022)", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ fastSeek: true });
      attachCalibrated(store, video);
      store.getState().seekToPts("5" as Pts);
      settle(store, video, 0.2, 2);
      const setsBefore = video.currentTimeSets;

      // A scrub seek to 0 is issued through fastSeek, which can land on a keyframe away
      // from 0, so a step toward the edge must still send one exact seek to 0.
      store.getState().seekApproximate(0, { scrub: true });
      expect(video.fastSeek).toHaveBeenCalledWith(0);
      requestSpy.mockClear();

      store.getState().seekNominal(-1);
      expect(requestSpy).toHaveBeenCalledWith(0, -1);
      expect(store.getState().seekTargetSeconds).toBe(0);

      // The exact seek was queued behind the running scrub seek, and it assigns currentTime.
      expect(video.currentTimeSets).toBe(setsBefore);
      fireSeeked(store, identityA, video);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(video.currentTime).toBe(0);

      // The exact seek is now the last request, so a further press at the edge does nothing.
      requestSpy.mockClear();
      store.getState().seekNominal(-1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it("an edge press during playback pauses, dispatches no seek and keeps presentedFrame", async () => {
      const stopSpy = vi.spyOn(scrubAudioController, "stop");
      try {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachCalibrated(store, video);
        const presented = store.getState().presentedFrame;

        store.getState().play();
        expect(store.getState().isPlaying).toBe(true);
        expect(video.playCalls).toBe(1);
        const pauseCallsBefore = video.pauseCalls;
        stopSpy.mockClear();

        store.getState().seekNominal(-1);

        expect(store.getState().isPlaying).toBe(false);
        expect(video.pauseCalls).toBe(pauseCallsBefore + 1);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(video.currentTimeSets).toBe(0);
        expect(store.getState().presentedFrame).toBe(presented);
        expect(store.getState().seekTargetSeconds).toBeNull();
        expect(requestSpy).not.toHaveBeenCalled();

        // The pause invalidated the play session, so the resolved play promise does not
        // report playback again.
        await flushAsync();
        expect(store.getState().isPlaying).toBe(false);

        // A paused edge press does not pause the element again.
        store.getState().seekNominal(-1);
        expect(video.pauseCalls).toBe(pauseCallsBefore + 1);
      } finally {
        stopSpy.mockRestore();
      }
    });

    it("clamps to the duration the element reports when it is shorter than the probe duration", () => {
      const store = createPlaybackStore();
      // The probe reports 10.0 s, and the element reports 9.8 s.
      const video = createFakeVideo({ duration: 9.8 });
      attachCalibrated(store, video);
      store.getState().syncBrowserDuration(identityA, video);
      expect(store.getState().runtimeBrowserDurationSeconds).toBe(9.8);

      store.getState().seekToPts("240" as Pts);
      settle(store, video, 9.6, 2);
      const setsBefore = video.currentTimeSets;

      // Ten frames from 9.6 s pass both durations. The target is the duration of the element,
      // which is the position the element reports back when the seek stops at its end.
      store.getState().seekNominal(10);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(video.currentTime).toBe(9.8);
      expect(store.getState().seekTargetSeconds).toBe(9.8);
      expect(requestSpy).toHaveBeenLastCalledWith(9.8, 1);

      // The element presents its last frame, and the next press is at the edge.
      settle(store, video, 9.76, 3);
      const presented = store.getState().presentedFrame;
      expect(presented?.inferredSourcePts).toBe("244");
      requestSpy.mockClear();

      store.getState().seekNominal(1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(store.getState().presentedFrame).toBe(presented);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it("keeps the probe duration as the bound when the element reports a longer duration", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 10.5 });
      attachCalibrated(store, video);
      store.getState().syncBrowserDuration(identityA, video);

      store.getState().seekToPts("240" as Pts);
      settle(store, video, 9.6, 2);

      store.getState().seekNominal(20);
      expect(video.currentTime).toBe(sourceA.approximateDurationSeconds);
    });

    it("known gap without the extent in ticks: a step forward from the real last frame still seeks once to the upper bound", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrated(store, video);

      // Settle on the real last frame of the 10 s source: PTS 249 at 9.96 s.
      store.getState().seekToPts("249" as Pts);
      settle(store, video, 9.96, 2);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("249");
      const setsBefore = video.currentTimeSets;

      // The upper bound is the duration (10.0 s), one frame interval after the start of the
      // last frame, so this step is not at the edge and it seeks. In a real element that seek
      // shows the same frame and can produce no RVFC callback (ADR 022), so presentedFrame
      // stays null and the edit actions stay disabled. sourceA reports no videoDurationTicks,
      // so the store cannot find the last frame: ADR 003 lists final-frame boundary discovery
      // as future work. With the extent in ticks the step is at the edge (see "A Step Forward
      // from the Last Frame of the Extent"). This test pins the behaviour without it.
      store.getState().seekNominal(1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(video.currentTime).toBe(sourceA.approximateDurationSeconds);
      expect(store.getState().presentedFrame).toBeNull();
      expect(store.getState().seekTargetSeconds).toBe(
        sourceA.approximateDurationSeconds,
      );
      expect(requestSpy).toHaveBeenLastCalledWith(
        sourceA.approximateDurationSeconds,
        1,
      );

      // The seek settles with no frame callback. The next press is at the edge and does
      // nothing, so presentedFrame stays null.
      fireSeeked(store, identityA, video);
      store.getState().seekNominal(1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(store.getState().presentedFrame).toBeNull();
    });

    describe("A Step Forward from the Last Frame of the Extent (ADR 026)", () => {
      /** sourceA with its extent in ticks: 250 frames on 1/25, the last one is frame 249. */
      const gridSource: PlaybackSource = {
        ...sourceA,
        videoDurationTicks: "250" as TickCount,
      };
      /** 10 s on 1/90000 at a variable rate, so off the grid. The last tick is PTS 899999. */
      const vfrSource: PlaybackSource = {
        ...sourceA,
        path: "/media/vfr.mp4",
        videoTimeBase: { n: 1, d: 90000 },
        videoDurationTicks: "900000" as TickCount,
        avgFrameRate: { n: 2997, d: 100 },
        rFrameRate: { n: 30, d: 1 },
      };

      function attach(
        source: PlaybackSource,
        video: ReturnType<typeof createFakeVideo>,
        anchor = 0,
      ): { store: PlaybackStore; key: string } {
        const store = createPlaybackStore();
        const key = getSourceRevisionKey(source);
        store.getState().attach(source, video);
        video.readyState = 1;
        store.getState().syncReady(key, video);
        store.getState().syncPresentedFrame(key, anchor, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");
        return { store, key };
      }

      function settleOn(
        store: PlaybackStore,
        key: string,
        video: ReturnType<typeof createFakeVideo>,
        mediaTime: number,
        presentedFrames: number,
      ): void {
        fireSeeked(store, key, video);
        store.getState().syncPresentedFrame(key, mediaTime, presentedFrames, video);
      }

      it("the known gap is closed: a step forward from the last frame does nothing", () => {
        const video = createFakeVideo();
        const { store, key } = attach(gridSource, video);
        store.getState().seekToPts("249" as Pts);
        settleOn(store, key, video, 9.96, 2);
        const presented = store.getState().presentedFrame;
        const setsBefore = video.currentTimeSets;

        store.getState().seekNominal(1);
        store.getState().seekNominal(10);
        expect(video.currentTimeSets).toBe(setsBefore);
        expect(store.getState().presentedFrame).toBe(presented);
        expect(store.getState().seekTargetSeconds).toBeNull();
        expect(requestSpy).not.toHaveBeenCalled();

        // A step back still moves.
        store.getState().seekNominal(-1);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBeCloseTo(248.5 / 25, 9);
      });

      it("End then → on the grid, also with an audio lead: the step does nothing", () => {
        for (const lead of [0, 0.5]) {
          const video = createFakeVideo({ duration: lead + 10 });
          const { store, key } = attach(gridSource, video, lead);
          store.getState().syncBrowserDuration(key, video);

          // End goes to the middle of the last frame.
          store.getState().seekToFrameIndex(249);
          expect(video.currentTime).toBeCloseTo(lead + 249.5 / 25, 9);
          // While that seek is pending, a step forward is absorbed by it.
          store.getState().seekNominal(1);
          expect(video.currentTimeSets).toBe(1);

          settleOn(store, key, video, lead + 249 / 25, 2);
          expect(store.getState().presentedFrame?.inferredSourcePts).toBe("249");
          const presented = store.getState().presentedFrame;

          store.getState().seekNominal(1);
          expect(video.currentTimeSets).toBe(1);
          expect(store.getState().presentedFrame).toBe(presented);
          expect(store.getState().seekTargetSeconds).toBeNull();
        }
      });

      it("a step from before the last frame that the end clamps still seeks to the end", () => {
        const video = createFakeVideo();
        const { store, key } = attach(gridSource, video);
        store.getState().seekToPts("245" as Pts);
        settleOn(store, key, video, 9.8, 2);
        const setsBefore = video.currentTimeSets;

        store.getState().seekNominal(10);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(10);
        // The display names the last frame, 249, the frame that arrives, and not frame 250,
        // which holds the end position by the margin and does not exist.
        expect(store.getState().seekTargetSeconds).toBeCloseTo(249 / 25, 9);
        settleOn(store, key, video, 249 / 25, 3);
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("249");
      });

      describe("a last frame shorter than an interval", () => {
        // 25 fps on 1/1000, an extent of 376 ticks: frames 0 to 9, and frame 9 covers only
        // 360 to 376, less than half an interval.
        const shortSource: PlaybackSource = {
          ...sourceA,
          path: "/media/short.mp4",
          videoTimeBase: { n: 1, d: 1000 },
          videoDurationTicks: "376" as TickCount,
          approximateDurationSeconds: 0.376,
        };

        function attachShort() {
          const video = createFakeVideo({ duration: 0.376, clampToDuration: true });
          const attached = attach(shortSource, video);
          attached.store.getState().syncBrowserDuration(attached.key, video);
          return { ...attached, video };
        }

        it("End goes to frame 9, and a second step forward does nothing", () => {
          const { store, key, video } = attachShort();
          store.getState().seekToFrameIndex(9);
          expect(video.currentTimeSets).toBe(1);
          // The middle of frame 9 lies past the end, so the seek stops at the end.
          expect(video.currentTime).toBe(0.376);
          expect(store.getState().seekTargetSeconds).toBeCloseTo(0.36, 9);
          settleOn(store, key, video, 0.36, 2);
          expect(store.getState().presentedFrame?.inferredSourcePts).toBe("360");

          store.getState().seekNominal(1);
          expect(video.currentTimeSets).toBe(1);
        });

        it("a step forward from frame 8 reaches frame 9, and a step from frame 9 does nothing", () => {
          const { store, key, video } = attachShort();
          store.getState().seekToPts("320" as Pts);
          settleOn(store, key, video, 0.32, 2);
          expect(store.getState().presentedFrame?.inferredSourcePts).toBe("320");

          store.getState().seekNominal(1);
          expect(video.currentTimeSets).toBe(2);
          expect(video.currentTime).toBe(0.376);
          expect(store.getState().seekTargetSeconds).toBeCloseTo(0.36, 9);
          settleOn(store, key, video, 0.36, 3);
          expect(store.getState().presentedFrame?.inferredSourcePts).toBe("360");

          store.getState().seekNominal(1);
          expect(video.currentTimeSets).toBe(2);
        });

        it("a typed frame 9 from frame 8 goes to frame 9", () => {
          const { store, key, video } = attachShort();
          store.getState().seekToPts("320" as Pts);
          settleOn(store, key, video, 0.32, 2);

          store.getState().seekToFrameIndex(9);
          expect(video.currentTimeSets).toBe(2);
          expect(video.currentTime).toBe(0.376);
        });
      });

      it("End then → off the grid, also with an audio lead: the step does nothing", () => {
        for (const lead of [0, 0.5]) {
          const video = createFakeVideo({ duration: lead + 10 });
          const { store, key } = attach(vfrSource, video, lead);
          store.getState().syncBrowserDuration(key, video);

          store.getState().seekToPts("899999" as Pts, EXTENT_END_SEEK_OPTIONS);
          expect(video.currentTime).toBeCloseTo(lead + 899999 / 90000, 9);
          // The last frame starts before the last tick.
          settleOn(store, key, video, lead + 897030 / 90000, 2);
          expect(store.getState().presentedFrame?.inferredSourcePts).toBe("897030");
          const presented = store.getState().presentedFrame;

          store.getState().seekNominal(1);
          store.getState().seekNominal(10);
          expect(video.currentTimeSets).toBe(1);
          expect(store.getState().presentedFrame).toBe(presented);
          expect(store.getState().seekTargetSeconds).toBeNull();
        }
      });

      it("off the grid, a step from before the last tick that the end clamps still seeks", () => {
        const video = createFakeVideo();
        const { store, key } = attach(vfrSource, video);
        store.getState().seekToPts("898200" as Pts);
        settleOn(store, key, video, 898200 / 90000, 2);
        const setsBefore = video.currentTimeSets;

        // 9.98 s plus one interval passes the end, 10 s, and 9.98 s is before the last tick.
        store.getState().seekNominal(1);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(10);
      });
    });

    it("an element past the upper bound does not step forward, and a step back seeks inside the bounds", () => {
      const store = createPlaybackStore();
      // The probe reports the 10 s video stream, and the element plays the 10.3 s container.
      const video = createFakeVideo({ duration: 10.3 });
      attachCalibrated(store, video);
      store.getState().syncBrowserDuration(identityA, video);

      // Playback ran to the end of the container and shows the last frame.
      video.currentTime = 10.3;
      video.seeking = false;
      store.getState().syncPresentedFrame(identityA, 9.96, 2, video);
      const presented = store.getState().presentedFrame;
      expect(presented?.inferredSourcePts).toBe("249");
      const setsBefore = video.currentTimeSets;

      store.getState().seekNominal(1);
      expect(video.currentTimeSets).toBe(setsBefore);
      expect(video.currentTime).toBe(10.3);
      expect(store.getState().presentedFrame).toBe(presented);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(requestSpy).not.toHaveBeenCalled();

      // The step back starts from the frame on screen, 249, not from 10.3 s or from the upper
      // bound, so it seeks to the middle of frame 248 and the picture changes. It displays the
      // nominal start of frame 248.
      store.getState().seekNominal(-1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(video.currentTime).toBeCloseTo(9.94, 9);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(9.92, 9);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenLastCalledWith(video.currentTime, -1);
    });

    it("a calibrated first frame after the origin bounds a step back, and a step back before it does not move forward", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      // The first frame lies 0.02 s after the start of the timeline, inside the anchor
      // tolerance, so it calibrates.
      store.getState().syncPresentedFrame(identityA, 0.02, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      const firstPresented = store.getState().presentedFrame;

      // The element still stands at the origin, before the first frame. A step back must not
      // seek forward to that frame.
      store.getState().seekNominal(-1);
      store.getState().seekNominal(-3);
      expect(video.currentTimeSets).toBe(0);
      expect(video.currentTime).toBe(0);
      expect(store.getState().presentedFrame).toBe(firstPresented);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(requestSpy).not.toHaveBeenCalled();

      // From a later frame, a long step back stops on the first frame.
      store.getState().seekToPts("5" as Pts);
      settle(store, video, 0.22, 2);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("5");
      const setsBefore = video.currentTimeSets;

      // The display target counts from the calibrated first frame, the origin from which the
      // presented frame reports its elapsed seconds, so it is 0 and not 0.02.
      store.getState().seekNominal(-10);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(video.currentTime).toBe(0.02);
      expect(store.getState().seekTargetSeconds).toBe(0);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenLastCalledWith(0.02, -1);

      // The seek settles on the first frame, and the next step back is at the edge.
      settle(store, video, 0.02, 3);
      const presented = store.getState().presentedFrame;
      expect(presented?.inferredSourcePts).toBe("0");
      requestSpy.mockClear();

      store.getState().seekNominal(-1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(video.currentTime).toBe(0.02);
      expect(store.getState().presentedFrame).toBe(presented);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it("a step forward from a position before the calibrated first frame lands on the frame after it", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(sourceA, video);
      video.readyState = 1;
      store.getState().syncReady(identityA, video);
      // The first frame lies 0.08 s after the start of the timeline, and the element still
      // stands at the origin.
      store.getState().syncPresentedFrame(identityA, 0.08, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");

      // The step starts from the first frame, so it reaches frame 1 and not the frame that is
      // already on screen. The target is the middle of frame 1, 0.08 + 1.5 * 0.04 s.
      store.getState().seekNominal(1);
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBeCloseTo(0.14, 9);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenLastCalledWith(video.currentTime, 1);
      // The display target is the nominal start of frame 1, counted from the calibrated first
      // frame: the frame whose PTS the callback then reports. Counted from the start of the
      // timeline, it would lie in frame 3.
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);

      settle(store, video, 0.12, 2);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("1");
    });

    // The probe prefers the duration of the video stream, which counts from its first frame.
    // The element duration, when the element reports one, is the same end position.
    it.each([10.08, undefined])(
      "counts the approximate duration from the calibrated first frame (element duration %s)",
      (duration) => {
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration });
        store.getState().attach(sourceA, video);
        video.readyState = 1;
        store.getState().syncReady(identityA, video);
        store.getState().syncBrowserDuration(identityA, video);
        expect(store.getState().runtimeBrowserDurationSeconds).toBe(duration ?? null);
        // The first frame lies 0.08 s after the start of the timeline.
        store.getState().syncPresentedFrame(identityA, 0.08, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");

        store.getState().seekToPts("240" as Pts);
        settle(store, video, 9.68, 2);
        requestSpy.mockClear();
        const setsBefore = video.currentTimeSets;

        // Twenty frames from PTS 240 pass the end of the stream, which is 0.08 s + 10 s. The
        // display target counts from the calibrated first frame, so it is the 10 s of the stream.
        store.getState().seekNominal(20);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(10.08);
        expect(store.getState().seekTargetSeconds).toBe(10);
        expect(requestSpy).toHaveBeenLastCalledWith(10.08, 1);

        // The element presents the last frame, PTS 249, and the next press is at the edge.
        settle(store, video, 10.04, 3);
        const presented = store.getState().presentedFrame;
        expect(presented?.inferredSourcePts).toBe("249");
        requestSpy.mockClear();

        store.getState().seekNominal(1);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(store.getState().presentedFrame).toBe(presented);
        expect(store.getState().seekTargetSeconds).toBeNull();
        expect(requestSpy).not.toHaveBeenCalled();
      },
    );

    // ADR 003 does not require the browser media timeline to start at 0. The bounds of a step
    // are positions on that timeline, which is the axis of currentTime.
    describe("On a Browser Timeline That Starts Away from 0", () => {
      /**
       * Attaches a source to an element whose browser media timeline starts at `origin`.
       *
       * React creates the node, so the element reports 0 at attach time; the browser moves
       * currentTime to the start of the timeline when metadata loads, which is the reading
       * syncReady takes. That move counts in currentTimeSets, so a test reads the count after
       * this helper returns.
       */
      function attachAtOrigin(
        store: PlaybackStore,
        origin: number,
        options?: { duration?: number; fastSeek?: boolean; source?: PlaybackSource },
      ): ReturnType<typeof createFakeVideo> {
        const source = options?.source ?? sourceA;
        const video = createFakeVideo({
          duration: options?.duration,
          fastSeek: options?.fastSeek,
        });
        store.getState().attach(source, video);
        video.readyState = 1;
        video.currentTime = origin;
        video.seeking = false;
        store.getState().syncReady(getSourceRevisionKey(source), video);
        return video;
      }

      it("a step back at the origin before the anchor seeks nowhere, and the first frame still calibrates", () => {
        const store = createPlaybackStore();
        const video = attachAtOrigin(store, 5);
        expect(store.getState().calibrationStatus).toBe("calibrating");
        const setsBefore = video.currentTimeSets;

        store.getState().seekNominal(-1);
        expect(video.currentTimeSets).toBe(setsBefore);
        store.getState().seekNominal(-1);
        store.getState().seekNominal(-5);

        expect(video.currentTimeSets).toBe(setsBefore);
        expect(video.currentTime).toBe(5);
        expect(store.getState().seekTargetSeconds).toBeNull();
        expect(requestSpy).not.toHaveBeenCalled();

        // The element never left the start, so the first callback still anchors videoStartPts.
        store.getState().syncPresentedFrame(identityA, 5, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
      });

      it("a long step back clamps to the origin, and the next step back does nothing", () => {
        const store = createPlaybackStore();
        const video = attachAtOrigin(store, 5);
        store.getState().syncPresentedFrame(identityA, 5, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");

        store.getState().seekNominal(1);
        settle(store, video, 5.04, 2);
        store.getState().seekNominal(1);
        settle(store, video, 5.08, 3);
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("2");
        requestSpy.mockClear();
        const setsBefore = video.currentTimeSets;

        store.getState().seekNominal(-10);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(5);
        expect(store.getState().seekTargetSeconds).toBe(0);
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenLastCalledWith(5, -1);

        // The seek settles on the first frame, and the next step back is at the edge.
        settle(store, video, 5, 4);
        const presented = store.getState().presentedFrame;
        expect(presented?.inferredSourcePts).toBe("0");
        expect(store.getState().seekTargetSeconds).toBeNull();
        requestSpy.mockClear();

        store.getState().seekNominal(-1);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(5);
        expect(store.getState().presentedFrame).toBe(presented);
        expect(store.getState().seekTargetSeconds).toBeNull();
        expect(requestSpy).not.toHaveBeenCalled();
      });

      it("a long step forward clamps to the origin plus the approximate duration, and the next step forward does nothing", () => {
        const store = createPlaybackStore();
        const video = attachAtOrigin(store, 5);
        store.getState().syncPresentedFrame(identityA, 5, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");

        store.getState().seekToPts("240" as Pts);
        expect(video.currentTime).toBeCloseTo(14.6, 9);
        settle(store, video, 14.6, 2);
        requestSpy.mockClear();
        const setsBefore = video.currentTimeSets;

        // Twenty frames from elapsed second 9.6 pass the 10 s duration. The bound is browser
        // position 15, not 10.
        store.getState().seekNominal(20);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(15);
        expect(store.getState().seekTargetSeconds).toBe(10);
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenLastCalledWith(15, 1);

        // The element presents the last frame, PTS 249, and the next press is at the edge.
        settle(store, video, 14.96, 3);
        const presented = store.getState().presentedFrame;
        expect(presented?.inferredSourcePts).toBe("249");
        requestSpy.mockClear();

        store.getState().seekNominal(1);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(15);
        expect(store.getState().presentedFrame).toBe(presented);
        expect(store.getState().seekTargetSeconds).toBeNull();
        expect(requestSpy).not.toHaveBeenCalled();
      });

      it("a step forward after playback ran to the end does not move back", () => {
        const store = createPlaybackStore();
        const video = attachAtOrigin(store, 5);
        store.getState().syncPresentedFrame(identityA, 5, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");

        // Playback runs to the end of the source and shows the last frame.
        store.getState().play();
        video.currentTime = 15;
        video.seeking = false;
        store.getState().syncPresentedFrame(identityA, 14.96, 2, video);
        store.getState().syncEnded(identityA, video);
        expect(store.getState().isPlaying).toBe(false);
        const presented = store.getState().presentedFrame;
        expect(presented?.inferredSourcePts).toBe("249");
        const setsBefore = video.currentTimeSets;

        store.getState().seekNominal(1);
        store.getState().seekNominal(5);

        expect(video.currentTimeSets).toBe(setsBefore);
        expect(video.currentTime).toBe(15);
        expect(store.getState().presentedFrame).toBe(presented);
        expect(store.getState().seekTargetSeconds).toBeNull();
        expect(requestSpy).not.toHaveBeenCalled();
      });

      it("a step forward clamps to a shorter element duration, and the next step forward does nothing", () => {
        const store = createPlaybackStore();
        // The origin plus the probe duration is 15 s, and the element ends at 14.8 s.
        const video = attachAtOrigin(store, 5, { duration: 14.8 });
        store.getState().syncBrowserDuration(identityA, video);
        expect(store.getState().runtimeBrowserDurationSeconds).toBe(14.8);
        store.getState().syncPresentedFrame(identityA, 5, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");

        store.getState().seekToPts("240" as Pts);
        settle(store, video, 14.6, 2);
        requestSpy.mockClear();
        const setsBefore = video.currentTimeSets;

        store.getState().seekNominal(10);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(14.8);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(9.8, 9);
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenLastCalledWith(14.8, 1);

        // The element presents its last frame, and the next press is at the edge.
        settle(store, video, 14.76, 3);
        const presented = store.getState().presentedFrame;
        expect(presented?.inferredSourcePts).toBe("244");
        requestSpy.mockClear();

        store.getState().seekNominal(1);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(14.8);
        expect(store.getState().presentedFrame).toBe(presented);
        expect(store.getState().seekTargetSeconds).toBeNull();
        expect(requestSpy).not.toHaveBeenCalled();
      });

      it("without a start PTS the origin is the lower bound", () => {
        const store = createPlaybackStore();
        const noStartSource: PlaybackSource = { ...sourceA, videoStartPts: null };
        const video = attachAtOrigin(store, 5, { source: noStartSource });
        expect(store.getState().calibrationStatus).toBe("unavailable");
        // A first frame after the origin does not bound the step, because nothing calibrated it.
        store.getState().syncPresentedFrame(identityA, 5.02, 1, video);
        expect(store.getState().calibrationStatus).toBe("unavailable");

        store.getState().seekNominal(5);
        expect(video.currentTime).toBeCloseTo(5.2, 9);
        fireSeeked(store, identityA, video);
        requestSpy.mockClear();
        const setsBefore = video.currentTimeSets;

        store.getState().seekNominal(-10);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(5);
        expect(store.getState().seekTargetSeconds).toBe(0);
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenLastCalledWith(5, -1);

        // The seek settles at the origin, and the next step back is at the edge.
        fireSeeked(store, identityA, video);
        expect(store.getState().seekTargetSeconds).toBeNull();
        requestSpy.mockClear();

        store.getState().seekNominal(-1);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(5);
        expect(store.getState().seekTargetSeconds).toBeNull();
        expect(requestSpy).not.toHaveBeenCalled();
      });

      it("a calibration that became unavailable no longer bounds the step with its first frame", () => {
        const store = createPlaybackStore();
        const video = attachAtOrigin(store, 5);
        // The first frame lies 0.02 s after the origin.
        store.getState().syncPresentedFrame(identityA, 5.02, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");
        // A distinct frame that infers the same PTS makes the calibration unavailable (ADR 003).
        store.getState().syncPresentedFrame(identityA, 5.03, 2, video);
        expect(store.getState().calibrationStatus).toBe("unavailable");

        store.getState().seekNominal(5);
        expect(video.currentTime).toBeCloseTo(5.2, 9);
        fireSeeked(store, identityA, video);
        requestSpy.mockClear();
        const setsBefore = video.currentTimeSets;

        // The bound is the origin, not the first frame of the refused calibration.
        store.getState().seekNominal(-10);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(5);
        expect(store.getState().seekTargetSeconds).toBe(0);
        expect(requestSpy).toHaveBeenLastCalledWith(5, -1);
      });

      it("a pending scrub at the origin before the first frame gets one exact seek to the scrub target (ADR 022)", () => {
        const store = createPlaybackStore();
        const video = attachAtOrigin(store, 5, { fastSeek: true });
        // The first frame lies 0.02 s after the origin.
        store.getState().syncPresentedFrame(identityA, 5.02, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");
        store.getState().seekToPts("5" as Pts);
        settle(store, video, 5.22, 2);
        const setsBefore = video.currentTimeSets;

        // A scrub to elapsed second 0 is issued through fastSeek at the origin.
        store.getState().seekApproximate(0, { scrub: true });
        expect(video.fastSeek).toHaveBeenCalledWith(5);
        requestSpy.mockClear();

        // The step starts from the scrub target, which lies before the first frame. It does not
        // move forward to that frame, and it still sends one exact seek to the scrub target.
        store.getState().seekNominal(-1);
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenLastCalledWith(5, -1);
        expect(store.getState().seekTargetSeconds).toBe(0);
        expect(video.currentTimeSets).toBe(setsBefore);
        fireSeeked(store, identityA, video);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBe(5);

        // The exact seek is now the last request, so a further press at the edge does nothing.
        requestSpy.mockClear();
        store.getState().seekNominal(-1);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(requestSpy).not.toHaveBeenCalled();
      });
    });
  });

  // A container such as Matroska stores each PTS rounded to the millisecond, so a real frame can
  // start up to half a millisecond before or after its nominal start. A seek to the nominal start
  // of the next frame then often lands before that frame, and the element presents the frame
  // before it again. These tests simulate the element: it presents the last frame whose PTS is
  // not after the target, which is the frame that contains the target.
  describe("Nominal Step to the Middle of a Frame", () => {
    let requestSpy: MockInstance<typeof scrubAudioController.request>;

    beforeEach(() => {
      requestSpy = vi.spyOn(scrubAudioController, "request");
    });

    afterEach(() => {
      requestSpy.mockRestore();
    });

    // No interval of these rates is a whole number of milliseconds, so the frame boundary margin
    // of the timecode is one tick (ADR 028).
    const tbMs: Rational = { n: 1, d: 1000 };
    const TICK_SECONDS = 0.001;
    const SIMULATED_SECONDS = 10;
    const fps2997: Rational = { n: 30000, d: 1001 };
    const fps23976: Rational = { n: 24000, d: 1001 };
    const fps5994: Rational = { n: 60000, d: 1001 };

    /**
     * Matroska-like sources. `firstFrame` is the nominal frame of the first video frame. A first
     * frame after frame 0 has a rounded first PTS: 67 ms for frame 2 at 29.97 fps (66.73 ms),
     * 42 ms for frame 1 at 23.976 fps (41.71 ms) and 17 ms for frame 1 at 59.94 fps (16.68 ms).
     * Measured from that first PTS, a later frame can start up to one tick before its nominal
     * start.
     */
    const matroskaCases: { label: string; fps: Rational; firstFrame: number }[] = [
      { label: "29.97 fps, first frame 0", fps: fps2997, firstFrame: 0 },
      { label: "23.976 fps, first frame 0", fps: fps23976, firstFrame: 0 },
      { label: "59.94 fps, first frame 0", fps: fps5994, firstFrame: 0 },
      { label: "29.97 fps, first frame 2", fps: fps2997, firstFrame: 2 },
      { label: "23.976 fps, first frame 1", fps: fps23976, firstFrame: 1 },
      { label: "59.94 fps, first frame 1", fps: fps5994, firstFrame: 1 },
    ];

    /** A source with frame PTS values `ptsTicks` in `timeBase`, calibrated on its first frame. */
    interface SimulatedSource {
      readonly source: PlaybackSource;
      readonly identity: string;
      readonly ptsTicks: readonly number[];
      readonly startSeconds: readonly number[];
    }

    /**
     * Frame i is nominal frame firstFrame + i. It starts at its nominal start, rounded to the
     * nearest tick with a tie away from zero, as the FFmpeg rescale in a muxer does. Integer
     * arithmetic keeps the rounding exact.
     *
     * The browser timeline starts at 0 and presents the first frame at its PTS. The browser time
     * of a later frame is the conversion ptsToMediaTime makes from that calibration anchor, so a
     * seek to a PTS lands exactly on the start of its frame.
     */
    function simulateSource(
      fps: Rational,
      timeBase: Rational,
      frameCount: number,
      firstFrame = 0,
    ): SimulatedSource {
      const ptsTicks: number[] = [];
      for (let i = 0; i < frameCount; i++) {
        const numerator = (firstFrame + i) * fps.d * timeBase.d;
        const denominator = fps.n * timeBase.n;
        const quotient = Math.floor(numerator / denominator);
        const remainder = numerator - quotient * denominator;
        ptsTicks.push(2 * remainder >= denominator ? quotient + 1 : quotient);
      }
      const anchor = (ptsTicks[0] * timeBase.n) / timeBase.d;
      const startSeconds = ptsTicks.map(
        (ticks) => anchor + ((ticks - ptsTicks[0]) * timeBase.n) / timeBase.d,
      );
      const source: PlaybackSource = {
        path: `/media/sim-${fps.n}-${fps.d}-${timeBase.d}-${firstFrame}.mkv`,
        size: 4096,
        mtime: 1724977000,
        videoTimeBase: timeBase,
        videoStartPts: String(ptsTicks[0]) as Pts,
        avgFrameRate: fps,
        rFrameRate: fps,
        approximateDurationSeconds: (frameCount * fps.d) / fps.n,
      };
      return { source, identity: getSourceRevisionKey(source), ptsTicks, startSeconds };
    }

    /** The frame the simulated element presents for a target: the one that contains it. */
    function presentedIndex(startSeconds: readonly number[], target: number): number {
      let index = 0;
      while (index + 1 < startSeconds.length && startSeconds[index + 1] <= target) {
        index++;
      }
      return index;
    }

    /** The frame timecode of frame k: its exact nominal start, k * fps.d / fps.n seconds. */
    function frameLabel(fps: Rational, k: number): string {
      return formatFrameTimecodeFromTicks(
        BigInt(k) * BigInt(fps.d),
        { n: 1, d: fps.n },
        fps,
      );
    }

    function attachSimulated(
      store: PlaybackStore,
      sim: SimulatedSource,
      video: ReturnType<typeof createFakeVideo>,
    ): void {
      store.getState().attach(sim.source, video);
      video.readyState = 1;
      store.getState().syncReady(sim.identity, video);
      store.getState().syncPresentedFrame(sim.identity, sim.startSeconds[0], 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
    }

    /** Reports the frame the element presents for its position, as RVFC does. */
    function presentFrameAtPosition(
      store: PlaybackStore,
      sim: SimulatedSource,
      video: ReturnType<typeof createFakeVideo>,
    ): number {
      const index = presentedIndex(sim.startSeconds, video.currentTime);
      store
        .getState()
        .syncPresentedFrame(sim.identity, sim.startSeconds[index], index + 2, video);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe(
        String(sim.ptsTicks[index]),
      );
      return index;
    }

    /** Completes the running seek, and the element presents the frame that contains its target. */
    function settleOnTarget(
      store: PlaybackStore,
      sim: SimulatedSource,
      video: ReturnType<typeof createFakeVideo>,
    ): number {
      fireSeeked(store, sim.identity, video);
      return presentFrameAtPosition(store, sim, video);
    }

    /** Seeks to the start of frame k, as Home or a go-to-mark does, and settles there. */
    function goToFrameStart(
      store: PlaybackStore,
      sim: SimulatedSource,
      video: ReturnType<typeof createFakeVideo>,
      k: number,
    ): void {
      store.getState().seekToPts(String(sim.ptsTicks[k]) as Pts);
      expect(video.currentTime).toBe(sim.startSeconds[k]);
      expect(settleOnTarget(store, sim, video)).toBe(k);
    }

    /** The position the playhead and the pending In region show now (ADR 022). */
    function displayedSeconds(store: PlaybackStore, sim: SimulatedSource): number {
      return getDisplayedElapsedSeconds(
        store.getState(),
        sim.source.videoStartPts,
        sim.source.videoTimeBase,
      );
    }

    /**
     * The timecode the preview shows now: the displayed position of ADR 022, in the frame
     * format that ADR 028 resolves for the source, with its frame boundary margin.
     */
    function displayedLabel(store: PlaybackStore, sim: SimulatedSource): string {
      const display = resolveTimecodeDisplay("frames", sim.source);
      expect(display.format).toBe("frames");
      return formatElapsedTimecode(displayedSeconds(store, sim), display);
    }

    /** The browser target of the last cue, which is the target the element receives. */
    function lastCueTarget(): number {
      const call = requestSpy.mock.lastCall;
      expect(call).toBeDefined();
      return call?.[0] ?? Number.NaN;
    }

    it.each(matroskaCases)(
      "$label: a step from each real frame start presents the next or the previous real frame",
      ({ fps, firstFrame }) => {
        const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
        const sim = simulateSource(fps, tbMs, frameCount, firstFrame);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);

        // Control: the old target, the start position plus one nominal interval, lands before
        // the next real frame for many of these frames.
        let nominalStartRepeats = 0;
        for (let k = 0; k + 1 < frameCount; k++) {
          if (
            presentedIndex(sim.startSeconds, sim.startSeconds[k] + fps.d / fps.n) === k
          ) {
            nominalStartRepeats++;
          }
        }
        expect(nominalStartRepeats).toBeGreaterThan(frameCount / 4);

        for (let k = 0; k + 1 < frameCount; k++) {
          goToFrameStart(store, sim, video, k);
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k));

          store.getState().seekNominal(1);
          expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(k + 1);
          // The display target is the nominal start of the target frame, so the timecode names
          // the frame that the callback then reports (ADR 022, ADR 028), and the playhead moves
          // less than one tick when that frame arrives.
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k + 1));
          const pendingSeconds = displayedSeconds(store, sim);
          expect(settleOnTarget(store, sim, video)).toBe(k + 1);
          expect(store.getState().seekTargetSeconds).toBeNull();
          expect(Math.abs(displayedSeconds(store, sim) - pendingSeconds)).toBeLessThan(
            TICK_SECONDS,
          );
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k + 1));

          if (k > 0) {
            goToFrameStart(store, sim, video, k);
            store.getState().seekNominal(-1);
            expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(k - 1);
            expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k - 1));
            expect(settleOnTarget(store, sim, video)).toBe(k - 1);
          }
        }
      },
    );

    it.each(matroskaCases)(
      "$label: a step while a seek to a real frame start is pending counts from that frame",
      ({ fps, firstFrame }) => {
        const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
        const sim = simulateSource(fps, tbMs, frameCount, firstFrame);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);

        // No frame is on screen for the pending seek, so the start frame comes from its target,
        // a real frame start. Measured from a rounded first PTS, that start can lie up to one
        // tick before its nominal start, and the one-tick margin keeps it in its own frame.
        for (let k = 0; k + 1 < frameCount; k++) {
          const direction = k > 0 && k % 2 === 0 ? -1 : 1;
          store.getState().seekToPts(String(sim.ptsTicks[k]) as Pts);
          expect(video.seeking).toBe(true);
          store.getState().seekNominal(direction);
          expect(presentedIndex(sim.startSeconds, lastCueTarget())).toBe(k + direction);
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k + direction));
          fireSeeked(store, sim.identity, video);
          expect(settleOnTarget(store, sim, video)).toBe(k + direction);
        }
      },
    );

    it.each(matroskaCases)(
      "$label: repeated steps, each after its frame arrives, advance one real frame each, and the playhead never moves back",
      ({ fps, firstFrame }) => {
        const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
        const sim = simulateSource(fps, tbMs, frameCount, firstFrame);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);

        // Each seek settles, and the callback of its frame arrives after the seeked event and
        // clears the display target. Each press therefore starts from the frame on screen. The
        // displayed position moves forward by about one frame for each press, and less than one
        // tick when the frame arrives.
        let settledSeconds = displayedSeconds(store, sim);
        for (let k = 1; k < frameCount; k++) {
          store.getState().seekNominal(1);
          expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(k);
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k));
          const pendingSeconds = displayedSeconds(store, sim);
          expect(pendingSeconds).toBeGreaterThan(settledSeconds);
          expect(settleOnTarget(store, sim, video)).toBe(k);
          settledSeconds = displayedSeconds(store, sim);
          expect(Math.abs(settledSeconds - pendingSeconds)).toBeLessThan(TICK_SECONDS);
        }
        for (let k = frameCount - 2; k >= 0; k--) {
          store.getState().seekNominal(-1);
          expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(k);
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k));
          const pendingSeconds = displayedSeconds(store, sim);
          expect(pendingSeconds).toBeLessThan(settledSeconds);
          expect(settleOnTarget(store, sim, video)).toBe(k);
          settledSeconds = displayedSeconds(store, sim);
          expect(Math.abs(settledSeconds - pendingSeconds)).toBeLessThan(TICK_SECONDS);
        }
        // One cue for each press (ADR 019, ADR 021).
        expect(requestSpy).toHaveBeenCalledTimes(2 * (frameCount - 1));
      },
    );

    // RVFC can report the new frame before the element fires `seeked`. The display target then
    // stays (ADR 022), so the next press has no settled frame on screen, and it starts from the
    // middle target of the step before, which the element reports as currentTime.
    it.each(matroskaCases)(
      "$label: repeated steps from a reached middle target whose frame arrived before seeked advance one real frame each",
      ({ fps, firstFrame }) => {
        const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
        const sim = simulateSource(fps, tbMs, frameCount, firstFrame);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);

        const settleCallbackFirst = (): number => {
          expect(video.seeking).toBe(true);
          const index = presentFrameAtPosition(store, sim, video);
          fireSeeked(store, sim.identity, video);
          expect(store.getState().seekTargetSeconds).not.toBeNull();
          return index;
        };

        store.getState().seekNominal(1);
        expect(settleCallbackFirst()).toBe(1);
        for (let k = 2; k < frameCount; k++) {
          store.getState().seekNominal(1);
          expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(k);
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k));
          expect(settleCallbackFirst()).toBe(k);
        }
        for (let k = frameCount - 2; k >= 0; k--) {
          store.getState().seekNominal(-1);
          expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(k);
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k));
          expect(settleCallbackFirst()).toBe(k);
        }
      },
    );

    // A late frame callback can report the old frame while the seek of a step still runs. The
    // display target is still set, so the next press starts from the pending middle target and
    // not from that old frame. From the old frame it would aim at the pending target itself,
    // and the edge rule would drop the press.
    it.each(matroskaCases)(
      "$label: a press after a late callback of the old frame during a step still moves one frame",
      ({ fps, firstFrame }) => {
        const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
        const sim = simulateSource(fps, tbMs, frameCount, firstFrame);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);

        for (let k = 0; k + 2 < frameCount; k++) {
          goToFrameStart(store, sim, video, k);
          requestSpy.mockClear();
          const setsBefore = video.currentTimeSets;

          // The step to frame k + 1 is in flight.
          store.getState().seekNominal(1);
          expect(video.seeking).toBe(true);
          expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(k + 1);

          // The late callback of frame k arrives while the seek runs. It sets presentedFrame,
          // and the display target stays.
          store
            .getState()
            .syncPresentedFrame(sim.identity, sim.startSeconds[k], k + 2, video);
          expect(store.getState().presentedFrame?.inferredSourcePts).toBe(
            String(sim.ptsTicks[k]),
          );
          expect(store.getState().seekTargetSeconds).not.toBeNull();

          // The next press still moves one frame: it queues the middle of frame k + 2.
          store.getState().seekNominal(1);
          expect(requestSpy).toHaveBeenCalledTimes(2);
          expect(presentedIndex(sim.startSeconds, lastCueTarget())).toBe(k + 2);
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k + 2));
          expect(video.currentTimeSets).toBe(setsBefore + 1);

          // The seeked event starts the queued seek, and the element presents frame k + 2.
          fireSeeked(store, sim.identity, video);
          expect(video.currentTimeSets).toBe(setsBefore + 2);
          expect(settleOnTarget(store, sim, video)).toBe(k + 2);
        }
      },
    );

    it.each(matroskaCases)(
      "$label: presses during a pending seek build on the pending middle target, one frame each",
      ({ fps, firstFrame }) => {
        const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
        const sim = simulateSource(fps, tbMs, frameCount, firstFrame);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);
        const presses = 90;

        // The first press seeks at once. The element then reports seeking until fireSeeked, so
        // every later press replaces the queued seek and steps from its target (ADR 022).
        for (let k = 1; k <= presses; k++) {
          store.getState().seekNominal(1);
          expect(presentedIndex(sim.startSeconds, lastCueTarget())).toBe(k);
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k));
        }
        expect(video.currentTimeSets).toBe(1);
        for (let k = presses - 1; k >= presses - 30; k--) {
          store.getState().seekNominal(-1);
          expect(presentedIndex(sim.startSeconds, lastCueTarget())).toBe(k);
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k));
        }
        expect(video.currentTimeSets).toBe(1);
        expect(requestSpy).toHaveBeenCalledTimes(presses + 30);

        // The seeked event starts the last queued seek, and the element presents its frame.
        fireSeeked(store, sim.identity, video);
        expect(video.currentTimeSets).toBe(2);
        expect(settleOnTarget(store, sim, video)).toBe(presses - 30);
      },
    );

    it.each(matroskaCases)(
      "$label: a step of ten frames is one request that presents the tenth real frame",
      ({ fps, firstFrame }) => {
        const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
        const sim = simulateSource(fps, tbMs, frameCount, firstFrame);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);

        for (let k = 0; k + 10 < frameCount; k++) {
          goToFrameStart(store, sim, video, k);
          requestSpy.mockClear();
          const setsBefore = video.currentTimeSets;

          store.getState().seekNominal(10);
          expect(video.currentTimeSets).toBe(setsBefore + 1);
          expect(requestSpy).toHaveBeenCalledTimes(1);
          expect(requestSpy).toHaveBeenLastCalledWith(video.currentTime, 1);
          expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(k + 10);
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k + 10));
          expect(settleOnTarget(store, sim, video)).toBe(k + 10);

          // Ten frames back from the frame on screen is the frame the step started on.
          store.getState().seekNominal(-10);
          expect(video.currentTimeSets).toBe(setsBefore + 2);
          expect(requestSpy).toHaveBeenCalledTimes(2);
          expect(requestSpy).toHaveBeenLastCalledWith(video.currentTime, -1);
          expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(k);
          expect(settleOnTarget(store, sim, video)).toBe(k);
        }
      },
    );

    // After a click or a drag release, currentTime is the requested position, anywhere in the
    // frame on screen, and it can lie one tick before the next real frame start. The frame on
    // screen, which RVFC reported, is then the start of the step.
    it.each(matroskaCases)(
      "$label: a step after a click one tick before the next real frame start counts from the frame on screen",
      ({ fps, firstFrame }) => {
        const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
        const sim = simulateSource(fps, tbMs, frameCount, firstFrame);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);
        const margin = frameBoundaryMarginSeconds(fps, tbMs);
        const origin = sim.startSeconds[0];

        // Control: the frame of that position after the margin is the next frame for many of
        // these frames.
        let nextFrameCount = 0;
        for (let k = 0; k + 2 < frameCount; k++) {
          const clickSeconds = (sim.ptsTicks[k + 1] - 1 - sim.ptsTicks[0]) / 1000;
          if (Math.floor(((clickSeconds + margin) * fps.n) / fps.d) === k + 1) {
            nextFrameCount++;
          }
        }
        expect(nextFrameCount).toBeGreaterThan(frameCount / 10);

        for (let k = 0; k + 2 < frameCount; k++) {
          const direction = k > 0 && k % 2 === 1 ? -1 : 1;
          // The click asks for the PTS one tick before the next frame starts.
          store.getState().seekToPts(String(sim.ptsTicks[k + 1] - 1) as Pts);
          expect(video.currentTime).toBeCloseTo(
            origin + (sim.ptsTicks[k + 1] - 1 - sim.ptsTicks[0]) / 1000,
            12,
          );
          expect(settleOnTarget(store, sim, video)).toBe(k);

          store.getState().seekNominal(direction);
          expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(
            k + direction,
          );
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k + direction));
          expect(settleOnTarget(store, sim, video)).toBe(k + direction);
        }
      },
    );

    it.each(matroskaCases)(
      "$label: a step after a pause 0.3 ms before the next real frame start counts from the frame on screen",
      ({ fps, firstFrame }) => {
        const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
        const sim = simulateSource(fps, tbMs, frameCount, firstFrame);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);
        const margin = frameBoundaryMarginSeconds(fps, tbMs);
        const origin = sim.startSeconds[0];

        // Control: the frame of that position after the margin is the next frame for most of
        // these frames.
        let nextFrameCount = 0;
        for (let k = 0; k + 2 < frameCount; k++) {
          const pausedSeconds = sim.startSeconds[k + 1] - 0.0003 - origin;
          if (Math.floor(((pausedSeconds + margin) * fps.n) / fps.d) === k + 1) {
            nextFrameCount++;
          }
        }
        expect(nextFrameCount).toBeGreaterThan(frameCount / 2);

        for (let k = 0; k + 2 < frameCount; k++) {
          const direction = k > 0 && k % 2 === 1 ? -1 : 1;
          // Playback presents frame k and pauses 0.3 ms before frame k + 1 starts.
          store.getState().play();
          video.currentTime = sim.startSeconds[k + 1] - 0.0003;
          video.seeking = false;
          expect(presentFrameAtPosition(store, sim, video)).toBe(k);
          store.getState().pause();
          expect(store.getState().seekTargetSeconds).toBeNull();

          store.getState().seekNominal(direction);
          expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(
            k + direction,
          );
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k + direction));
          expect(settleOnTarget(store, sim, video)).toBe(k + direction);
        }
      },
    );

    // Without a calibration no frame grid is known. The start of the timeline is not a frame
    // boundary when the audio starts first, so the step moves the position by the nominal
    // interval, as before the grid existed.
    it("without a calibration, steps on an audio-first source advance one real frame each", () => {
      const fps = fps2997;
      const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
      // The first video frame starts 17 ms after the start of the timeline.
      const startSeconds: number[] = [];
      for (let i = 0; i < frameCount; i++) {
        const numerator = i * fps.d * 1000;
        const quotient = Math.floor(numerator / fps.n);
        const remainder = numerator - quotient * fps.n;
        startSeconds.push(
          (17 + (2 * remainder >= fps.n ? quotient + 1 : quotient)) / 1000,
        );
      }
      const source: PlaybackSource = {
        path: "/media/audio-first.mkv",
        size: 4096,
        mtime: 1724977000,
        videoTimeBase: tbMs,
        videoStartPts: null,
        avgFrameRate: fps,
        rFrameRate: fps,
        approximateDurationSeconds: (frameCount * fps.d) / fps.n,
      };
      const identity = getSourceRevisionKey(source);
      const store = createPlaybackStore();
      const video = createFakeVideo();
      store.getState().attach(source, video);
      video.readyState = 1;
      store.getState().syncReady(identity, video);
      expect(store.getState().calibrationStatus).toBe("unavailable");

      // Control: middle targets on a grid from the start of the timeline repeat or skip a frame
      // for many presses.
      let gridErrors = 0;
      for (let p = 1; p + 1 < frameCount; p++) {
        const before = presentedIndex(startSeconds, ((p - 0.5) * fps.d) / fps.n);
        const after = presentedIndex(startSeconds, ((p + 0.5) * fps.d) / fps.n);
        if (after - before !== 1) {
          gridErrors++;
        }
      }
      expect(gridErrors).toBeGreaterThan(frameCount / 5);

      let previous = presentedIndex(startSeconds, video.currentTime);
      for (let p = 1; p + 1 < frameCount; p++) {
        store.getState().seekNominal(1);
        expect(video.currentTime).toBeCloseTo((p * fps.d) / fps.n, 9);
        const shown = presentedIndex(startSeconds, video.currentTime);
        if (p > 1) {
          expect(shown).toBe(previous + 1);
        }
        previous = shown;
        fireSeeked(store, identity, video);
        expect(store.getState().seekTargetSeconds).toBeNull();
      }
      for (let p = frameCount - 3; p >= 1; p--) {
        store.getState().seekNominal(-1);
        const shown = presentedIndex(startSeconds, video.currentTime);
        expect(shown).toBe(previous - 1);
        previous = shown;
        fireSeeked(store, identity, video);
      }
    });

    /**
     * A calibrated source whose frames start at `ptsTicks` in `timeBase`, with the rates the
     * probe reports. The browser presents the first frame at its PTS.
     */
    function calibratedSourceFromPts(
      ptsTicks: readonly number[],
      timeBase: Rational,
      avgFrameRate: Rational,
      rFrameRate: Rational,
      path: string,
    ): SimulatedSource {
      const anchor = (ptsTicks[0] * timeBase.n) / timeBase.d;
      const startSeconds = ptsTicks.map(
        (ticks) => anchor + ((ticks - ptsTicks[0]) * timeBase.n) / timeBase.d,
      );
      const last = startSeconds[startSeconds.length - 1];
      const source: PlaybackSource = {
        path,
        size: 4096,
        mtime: 1724977000,
        videoTimeBase: timeBase,
        videoStartPts: String(ptsTicks[0]) as Pts,
        avgFrameRate,
        rFrameRate,
        approximateDurationSeconds:
          last - anchor + (avgFrameRate.d / avgFrameRate.n) * 2,
      };
      return { source, identity: getSourceRevisionKey(source), ptsTicks, startSeconds };
    }

    /**
     * Off the frame grid, a step moves the position by the nominal interval. From each real
     * frame start it therefore presents the same frame or the next one, and never skips one.
     */
    function expectRelativeStepsFromEachFrameStart(
      sim: SimulatedSource,
      rate: Rational,
    ): void {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachSimulated(store, sim, video);
      const interval = rate.d / rate.n;
      let skipped = 0;
      for (let k = 0; k + 2 < sim.startSeconds.length; k++) {
        goToFrameStart(store, sim, video, k);
        store.getState().seekNominal(1);
        expect(video.currentTime).toBeCloseTo(sim.startSeconds[k] + interval, 12);
        // The display target is the target itself, counted from the calibrated first frame.
        expect(store.getState().seekTargetSeconds).toBeCloseTo(
          video.currentTime - sim.startSeconds[0],
          12,
        );
        const shown = settleOnTarget(store, sim, video);
        expect(shown === k || shown === k + 1).toBe(true);
        if (shown > k + 1) {
          skipped++;
        }
      }
      expect(skipped).toBe(0);
    }

    /**
     * What single presses from each real frame start would do on the frame grid: round the
     * frame on screen to its nominal frame and aim at the middle of the next one. `wrong`
     * counts the presses that do not present the next frame, and `skipped` the presses that
     * present a later one.
     */
    function gridOutcomes(
      sim: SimulatedSource,
      rate: Rational,
    ): { wrong: number; skipped: number } {
      const origin = sim.startSeconds[0];
      let wrong = 0;
      let skipped = 0;
      for (let k = 0; k + 2 < sim.startSeconds.length; k++) {
        const exact = ((sim.startSeconds[k] - origin) * rate.n) / rate.d;
        const target = origin + ((2 * Math.round(exact) + 3) * rate.d) / (2 * rate.n);
        const shown = presentedIndex(sim.startSeconds, target);
        if (shown !== k + 1) {
          wrong++;
        }
        if (shown > k + 1) {
          skipped++;
        }
      }
      return { wrong, skipped };
    }

    /** PTS of nominal frames `first` to `first + count - 1`, each rounded to the time base. */
    function roundedPts(
      rate: Rational,
      timeBase: Rational,
      first: number,
      count: number,
      keep: (k: number) => boolean = () => true,
    ): number[] {
      const ptsTicks: number[] = [];
      for (let k = first; k < first + count; k++) {
        if (keep(k)) {
          const numerator = k * rate.d * timeBase.d;
          const denominator = rate.n * timeBase.n;
          const quotient = Math.floor(numerator / denominator);
          const remainder = numerator - quotient * denominator;
          ptsTicks.push(2 * remainder >= denominator ? quotient + 1 : quotient);
        }
      }
      return ptsTicks;
    }

    it("at a variable frame rate, a calibrated step keeps the relative target and never skips a frame", () => {
      // A 30 fps stream that drops 5% of its frames at pseudo-random places. The real rate is
      // 30 fps, and the average rate is the kept frames over the duration. The probe reports
      // both, and they differ, so the rate is variable.
      let seed = 12345;
      const random = (): number => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      const rFrameRate: Rational = { n: 30, d: 1 };
      const ptsTicks = roundedPts(
        rFrameRate,
        tbMs,
        0,
        3000,
        (k) => k === 0 || random() >= 0.05,
      );
      const avgFrameRate: Rational = { n: ptsTicks.length, d: 100 };
      const sim = calibratedSourceFromPts(
        ptsTicks,
        tbMs,
        avgFrameRate,
        rFrameRate,
        "/media/dropped.mkv",
      );
      expect(hasVariableFrameRate(sim.source)).toBe(true);
      // Control: the frame grid of the average rate would skip frames for many presses.
      expect(gridOutcomes(sim, avgFrameRate).skipped).toBeGreaterThan(
        sim.startSeconds.length / 20,
      );

      expectRelativeStepsFromEachFrameStart(sim, avgFrameRate);
    });

    it("on a time base where the frame grid is not exact, a calibrated step keeps the relative target", () => {
      // 29.97 fps at 1/50: each PTS is the nominal start rounded to 20 ms, and the first frame
      // is nominal frame 29, at 0.96 s. Measured from that rounded first PTS, a real start can
      // lie more than half a frame from its nominal start.
      const rate = fps2997;
      const timeBase: Rational = { n: 1, d: 50 };
      expect(isFrameGridExact(rate, timeBase)).toBe(false);
      const sim = calibratedSourceFromPts(
        roundedPts(rate, timeBase, 29, 600),
        timeBase,
        rate,
        rate,
        "/media/coarse.avi",
      );
      expect(hasVariableFrameRate(sim.source)).toBe(false);
      // Control: rounding the frame on screen to the nominal grid would name the wrong frame
      // for many presses.
      expect(gridOutcomes(sim, rate).wrong).toBeGreaterThan(
        sim.startSeconds.length / 20,
      );

      expectRelativeStepsFromEachFrameStart(sim, rate);
    });

    // During playback currentTime can run ahead of the frame that RVFC reported last. A step
    // starts from the frame on screen, so its target can lie behind currentTime, and it must
    // still seek. The rule that a step never moves against its direction applies only to a
    // start position outside the bounds.
    describe("A Step from the Frame on Screen Against currentTime", () => {
      const k = 40;

      function playingOnFrame(
        store: PlaybackStore,
        sim: SimulatedSource,
        video: ReturnType<typeof createFakeVideo>,
        currentTime: number,
      ): void {
        attachSimulated(store, sim, video);
        store.getState().play();
        video.currentTime = sim.startSeconds[k];
        video.seeking = false;
        expect(presentFrameAtPosition(store, sim, video)).toBe(k);
        video.currentTime = currentTime;
        video.seeking = false;
        expect(store.getState().isPlaying).toBe(true);
        expect(store.getState().seekTargetSeconds).toBeNull();
        requestSpy.mockClear();
      }

      it("a step forward seeks to the middle of the next frame when currentTime is past it", () => {
        const fps = fps2997;
        const sim = simulateSource(fps, tbMs, 120);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        const nextMiddle = ((2 * (k + 1) + 1) * fps.d) / (2 * fps.n);
        playingOnFrame(store, sim, video, nextMiddle + 0.005);
        const setsBefore = video.currentTimeSets;

        store.getState().seekNominal(1);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBeCloseTo(nextMiddle, 12);
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenLastCalledWith(video.currentTime, 1);
        expect(store.getState().isPlaying).toBe(false);
        expect(settleOnTarget(store, sim, video)).toBe(k + 1);
      });

      it("a step back seeks to the middle of the previous frame when currentTime is before it", () => {
        const fps = fps2997;
        const sim = simulateSource(fps, tbMs, 120);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        const previousMiddle = ((2 * (k - 1) + 1) * fps.d) / (2 * fps.n);
        playingOnFrame(store, sim, video, previousMiddle - 0.005);
        const setsBefore = video.currentTimeSets;

        store.getState().seekNominal(-1);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBeCloseTo(previousMiddle, 12);
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenLastCalledWith(video.currentTime, -1);
        expect(store.getState().isPlaying).toBe(false);
        expect(settleOnTarget(store, sim, video)).toBe(k - 1);
      });
    });

    it("at 29.97 fps, a step back from the middle of the first frame does nothing", () => {
      const fps = fps2997;
      const sim = simulateSource(fps, tbMs, 60);
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachSimulated(store, sim, video);

      // At the calibrated first frame, a step back is at the edge.
      store.getState().seekNominal(-1);
      expect(video.currentTimeSets).toBe(0);

      // Forward to frame 1, then back to the middle of frame 0.
      store.getState().seekNominal(1);
      expect(settleOnTarget(store, sim, video)).toBe(1);
      store.getState().seekNominal(-1);
      expect(video.currentTime).toBeCloseTo((0.5 * fps.d) / fps.n, 12);
      expect(settleOnTarget(store, sim, video)).toBe(0);
      const presented = store.getState().presentedFrame;
      const setsBefore = video.currentTimeSets;
      requestSpy.mockClear();

      // The clamp pulls each target back to the start of frame 0, the frame on screen. A seek
      // there could bring no frame callback (ADR 022), so the presses do nothing.
      store.getState().seekNominal(-1);
      store.getState().seekNominal(-10);
      expect(video.currentTimeSets).toBe(setsBefore);
      expect(store.getState().presentedFrame).toBe(presented);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(requestSpy).not.toHaveBeenCalled();
      expect(canMarkIn("ready", store.getState().presentedFrame, true)).toBe(true);

      // A step forward still moves.
      store.getState().seekNominal(1);
      expect(video.currentTimeSets).toBe(setsBefore + 1);
      expect(settleOnTarget(store, sim, video)).toBe(1);
    });

    it("at 29.97 fps, a step that the end position clamps inside the frame on screen does nothing", () => {
      const fps = fps2997;
      // Sixty frames. The last frame, 59, starts at 1.969 s. The element reports a duration of
      // 1.99 s, which lies inside that frame.
      const sim = simulateSource(fps, tbMs, 60);
      expect(sim.startSeconds[59]).toBe(1.969);
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 1.99 });
      attachSimulated(store, sim, video);
      store.getState().syncBrowserDuration(sim.identity, video);
      expect(store.getState().runtimeBrowserDurationSeconds).toBe(1.99);

      // Ten frames from frame 55 pass the end, so the target clamps to the end position, which
      // presents the last frame. The display target is the nominal start of the frame that
      // contains the end position, so the playhead does not move back when that frame arrives.
      goToFrameStart(store, sim, video, 55);
      store.getState().seekNominal(10);
      expect(video.currentTime).toBe(1.99);
      expect(store.getState().seekTargetSeconds).toBe((59 * fps.d) / fps.n);
      expect(displayedLabel(store, sim)).toBe(frameLabel(fps, 59));
      const pendingSeconds = displayedSeconds(store, sim);
      expect(settleOnTarget(store, sim, video)).toBe(59);
      expect(Math.abs(displayedSeconds(store, sim) - pendingSeconds)).toBeLessThan(
        TICK_SECONDS,
      );
      const setsBefore = video.currentTimeSets;
      requestSpy.mockClear();

      store.getState().seekNominal(1);
      expect(video.currentTimeSets).toBe(setsBefore);
      expect(requestSpy).not.toHaveBeenCalled();

      // Back to frame 58, then forward to the middle of the last frame.
      store.getState().seekNominal(-1);
      expect(settleOnTarget(store, sim, video)).toBe(58);
      store.getState().seekNominal(1);
      expect(video.currentTime).toBeCloseTo((59.5 * fps.d) / fps.n, 12);
      expect(settleOnTarget(store, sim, video)).toBe(59);
      const presented = store.getState().presentedFrame;
      const setsAtLast = video.currentTimeSets;
      requestSpy.mockClear();

      // The clamp pulls the target to 1.99 s. That is a different position in the same frame,
      // so the presses do nothing.
      store.getState().seekNominal(1);
      store.getState().seekNominal(10);
      expect(video.currentTimeSets).toBe(setsAtLast);
      expect(store.getState().presentedFrame).toBe(presented);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(requestSpy).not.toHaveBeenCalled();
    });

    // At an integer rate with a time base whose ticks divide the interval, each frame starts on
    // its nominal start, so the old target was the start of the next frame. The middle target
    // lies in that same frame.
    it.each([
      { label: "1/25", timeBase: { n: 1, d: 25 } },
      { label: "1/1000", timeBase: { n: 1, d: 1000 } },
      { label: "1/12800", timeBase: { n: 1, d: 12800 } },
    ])(
      "at 25 fps with time base $label, a step presents the same frame as before",
      ({ timeBase }) => {
        const fps: Rational = { n: 25, d: 1 };
        const frameCount = 250;
        const sim = simulateSource(fps, timeBase, frameCount);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);

        for (let k = 0; k + 1 < frameCount; k++) {
          goToFrameStart(store, sim, video, k);
          // The old target, (k + 1) / 25, was the nominal start of frame k + 1, and here also
          // its real start.
          expect(sim.startSeconds[k + 1]).toBeCloseTo((k + 1) / 25, 12);

          store.getState().seekNominal(1);
          expect(video.currentTime).toBeCloseTo((k + 1.5) / 25, 12);
          expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(k + 1);
          // The display target is the nominal start, the position the old step displayed.
          expect(store.getState().seekTargetSeconds).toBeCloseTo((k + 1) / 25, 12);
          expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k + 1));
          expect(settleOnTarget(store, sim, video)).toBe(k + 1);

          if (k > 0) {
            goToFrameStart(store, sim, video, k);
            store.getState().seekNominal(-1);
            expect(video.currentTime).toBeCloseTo((k - 0.5) / 25, 12);
            expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(k - 1);
            expect(settleOnTarget(store, sim, video)).toBe(k - 1);
          }
        }
      },
    );

    // While the calibration holds, a step displays its target from the calibrated first frame.
    // Without a calibration, the playhead counts from the start of the timeline.
    describe("A Pending Display Target When the Calibration Stops Holding", () => {
      /** Attaches sourceA (25 fps) whose first frame lies 0.08 s after the timeline start. */
      function attachLateFirstFrame(
        store: PlaybackStore,
        video: ReturnType<typeof createFakeVideo>,
      ): void {
        store.getState().attach(sourceA, video);
        video.readyState = 1;
        store.getState().syncReady(identityA, video);
        store.getState().syncPresentedFrame(identityA, 0.08, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");
      }

      it("moves to the timeline axis when a callback refuses the calibration during the seek", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachLateFirstFrame(store, video);

        store.getState().seekNominal(1);
        expect(video.currentTime).toBeCloseTo(0.14, 9);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);
        expect(video.seeking).toBe(true);

        // A distinct frame that infers the same PTS refuses the calibration (ADR 003) while the
        // seek still runs. The target now counts from the start of the timeline.
        store.getState().syncPresentedFrame(identityA, 0.09, 2, video);
        expect(store.getState().calibrationStatus).toBe("unavailable");
        expect(store.getState().seekTargetSeconds).toBeCloseTo(0.14, 9);

        // The seeked event clears it, as for every seek without a calibration.
        fireSeeked(store, identityA, video);
        expect(store.getState().seekTargetSeconds).toBeNull();
      });

      it("moves to the timeline axis when frame callbacks stop being available during the seek", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachLateFirstFrame(store, video);

        store.getState().seekNominal(2);
        expect(video.currentTime).toBeCloseTo(0.18, 9);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(0.08, 9);

        store.getState().syncPresentationUnavailable(identityA, video);
        expect(store.getState().calibrationStatus).toBe("unavailable");
        expect(store.getState().seekTargetSeconds).toBeCloseTo(0.18, 9);
      });

      it("does not write a target when no seek is pending", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachLateFirstFrame(store, video);
        expect(store.getState().seekTargetSeconds).toBeNull();

        store.getState().syncPresentationUnavailable(identityA, video);
        expect(store.getState().calibrationStatus).toBe("unavailable");
        expect(store.getState().seekTargetSeconds).toBeNull();
      });
    });

    // A typed frame timecode goes to nominal frame J of the grid with the frame step of
    // seekNominal and an absolute target frame (ADR 022, ADR 028).
    describe("seekToFrameIndex", () => {
      let stopSpy: MockInstance<typeof scrubAudioController.stop>;

      beforeEach(() => {
        stopSpy = vi.spyOn(scrubAudioController, "stop");
      });

      afterEach(() => {
        stopSpy.mockRestore();
      });

      /** Sources on an exact grid: Matroska milliseconds, and fine time bases. */
      const gridCases: {
        label: string;
        fps: Rational;
        timeBase: Rational;
        firstFrame: number;
      }[] = [
        ...matroskaCases.map((entry) => ({ ...entry, timeBase: tbMs })),
        { label: "25 fps, 1/1000", fps: fps25, timeBase: tbMs, firstFrame: 0 },
        {
          label: "24 fps, 1/1000",
          fps: { n: 24, d: 1 },
          timeBase: tbMs,
          firstFrame: 0,
        },
        { label: "25 fps, 1/25", fps: fps25, timeBase: tb25, firstFrame: 0 },
        {
          label: "29.97 fps, 1001/30000",
          fps: fps2997,
          timeBase: tbNtsc,
          firstFrame: 0,
        },
        {
          label: "29.97 fps, 1/30000",
          fps: fps2997,
          timeBase: { n: 1, d: 30000 },
          firstFrame: 0,
        },
        {
          label: "29.97 fps, 1/90000",
          fps: fps2997,
          timeBase: { n: 1, d: 90000 },
          firstFrame: 3,
        },
      ];

      it.each(gridCases)(
        "$label: goes to the middle of each frame, shows its timecode, and presents it",
        ({ fps, timeBase, firstFrame }) => {
          const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
          const sim = simulateSource(fps, timeBase, frameCount, firstFrame);
          const store = createPlaybackStore();
          const video = createFakeVideo();
          attachSimulated(store, sim, video);

          for (let k = 0; k < frameCount; k++) {
            // A jump from a frame far away, in both directions.
            const from = (k * 37 + 11) % frameCount;
            if (from === k) {
              continue;
            }
            goToFrameStart(store, sim, video, from);
            requestSpy.mockClear();
            stopSpy.mockClear();
            const setsBefore = video.currentTimeSets;

            store.getState().seekToFrameIndex(k);
            expect(video.currentTimeSets).toBe(setsBefore + 1);
            // The middle of nominal frame k, from the calibrated first frame.
            expect(video.currentTime).toBeCloseTo(
              sim.startSeconds[0] + ((2 * k + 1) * fps.d) / (2 * fps.n),
              9,
            );
            expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(k);
            // The preview shows the typed timecode at once, and a jump sounds no cue.
            expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k));
            expect(requestSpy).not.toHaveBeenCalled();
            expect(stopSpy).toHaveBeenCalled();
            expect(store.getState().presentedFrame).toBeNull();

            expect(settleOnTarget(store, sim, video)).toBe(k);
            expect(store.getState().seekTargetSeconds).toBeNull();
            expect(displayedLabel(store, sim)).toBe(frameLabel(fps, k));
          }
        },
      );

      it("does nothing for the frame on screen while paused", () => {
        const sim = simulateSource(fps2997, tbMs, 300, 2);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);
        goToFrameStart(store, sim, video, 40);
        const frameBefore = store.getState().presentedFrame;
        const setsBefore = video.currentTimeSets;

        store.getState().seekToFrameIndex(40);
        expect(video.currentTimeSets).toBe(setsBefore);
        expect(store.getState().presentedFrame).toBe(frameBefore);
        expect(store.getState().seekTargetSeconds).toBeNull();
      });

      /**
       * Settles on frame 40, starts playback, and lets the element play on to `position`
       * without a seek, as playback moves currentTime before the next frame callback.
       */
      function playFromFrame40To(position: (sim: SimulatedSource) => number) {
        const sim = simulateSource(fps2997, tbMs, 300, 2);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);
        goToFrameStart(store, sim, video, 40);
        store.getState().play();
        expect(store.getState().isPlaying).toBe(true);
        video.currentTime = position(sim);
        video.seeking = false;
        return { sim, store, video, frameBefore: store.getState().presentedFrame };
      }

      it("only pauses during playback while the element is still in the frame on screen", () => {
        const { sim, store, video, frameBefore } = playFromFrame40To(
          (source) => (source.startSeconds[40] + source.startSeconds[41]) / 2,
        );
        expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(40);
        const setsBefore = video.currentTimeSets;

        store.getState().seekToFrameIndex(40);
        // The edge rule of ADR 022: no seek onto the frame on screen, which could bring no frame
        // callback, so presentedFrame stays valid and the marks stay enabled.
        expect(store.getState().isPlaying).toBe(false);
        expect(video.currentTimeSets).toBe(setsBefore);
        expect(store.getState().presentedFrame).toBe(frameBefore);
        expect(store.getState().seekTargetSeconds).toBeNull();
      });

      it("seeks back during playback once the element has moved into the next frame", () => {
        const { sim, store, video } = playFromFrame40To(
          (source) => source.startSeconds[41] + 0.001,
        );
        expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(41);
        const setsBefore = video.currentTimeSets;

        store.getState().seekToFrameIndex(40);
        // Frame 40 is still the frame last reported, but the picture has moved on, so the typed
        // frame is sought: the seek stops playback and goes to the middle of frame 40.
        expect(store.getState().isPlaying).toBe(false);
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(40);
        expect(displayedLabel(store, sim)).toBe(frameLabel(fps2997, 40));
        expect(settleOnTarget(store, sim, video)).toBe(40);
      });

      it("keeps the edge rule for a relative step during playback", () => {
        const sim = simulateSource(fps2997, tbMs, 300, 2);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);
        goToFrameStart(store, sim, video, 0);
        store.getState().play();
        const setsAtStart = video.currentTimeSets;

        // A step back at the first frame only pauses.
        store.getState().seekNominal(-1);
        expect(store.getState().isPlaying).toBe(false);
        expect(video.currentTimeSets).toBe(setsAtStart);
      });

      it("keeps a pending exact seek to the same frame, and replaces a pending scrub seek", () => {
        const sim = simulateSource(fps25, tbMs, 250);
        const store = createPlaybackStore();
        const video = createFakeVideo({ fastSeek: true });
        attachSimulated(store, sim, video);

        // A pending exact step to frame 10 already goes to the frame.
        goToFrameStart(store, sim, video, 9);
        store.getState().seekNominal(1);
        const setsAfterStep = video.currentTimeSets;
        store.getState().seekToFrameIndex(10);
        expect(video.currentTimeSets).toBe(setsAfterStep);
        expect(displayedLabel(store, sim)).toBe(frameLabel(fps25, 10));
        expect(settleOnTarget(store, sim, video)).toBe(10);

        // A scrub seek inside frame 10 lands on a keyframe, so the same frame still needs an
        // exact seek.
        const tenMiddle = (2 * 10 + 1) / (2 * 25);
        store.getState().seekApproximate(0.41, { scrub: true });
        expect(video.fastSeek).toHaveBeenCalledTimes(1);
        const setsAfterScrub = video.currentTimeSets;
        store.getState().seekToFrameIndex(10);
        fireSeeked(store, sim.identity, video);
        expect(video.currentTimeSets).toBe(setsAfterScrub + 1);
        expect(video.currentTime).toBeCloseTo(tenMiddle, 9);
      });

      it("stops at the end of the source", () => {
        const sim = simulateSource(fps25, tbMs, 250);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, sim, video);

        store.getState().seekToFrameIndex(10_000);
        expect(video.currentTime).toBe(10);
        expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(249);
      });

      it("does nothing off the grid, without a calibration, or for an index that is not a frame", () => {
        // 1/24 at 23.976 fps: one tick is almost a whole frame.
        const coarse = simulateSource(fps23976, { n: 1, d: 24 }, 240);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSimulated(store, coarse, video);
        store.getState().seekToFrameIndex(50);
        expect(video.currentTimeSets).toBe(0);

        const noStart = createPlaybackStore();
        const noStartVideo = createFakeVideo({ readyState: 1 });
        noStart.getState().attach({ ...sourceA, videoStartPts: null }, noStartVideo);
        expect(noStart.getState().calibrationStatus).toBe("unavailable");
        noStart.getState().seekToFrameIndex(5);
        expect(noStartVideo.currentTimeSets).toBe(0);

        const exact = simulateSource(fps25, tbMs, 250);
        const exactStore = createPlaybackStore();
        const exactVideo = createFakeVideo();
        attachSimulated(exactStore, exact, exactVideo);
        for (const index of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
          exactStore.getState().seekToFrameIndex(index);
        }
        expect(exactVideo.currentTimeSets).toBe(0);
      });

      it("is deferred while the calibration is open, and runs on the grid at the anchor", () => {
        const sim = simulateSource(fps2997, tbMs, 300, 2);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        store.getState().attach(sim.source, video);
        video.readyState = 1;
        store.getState().syncReady(sim.identity, video);
        expect(store.getState().calibrationStatus).toBe("calibrating");

        store.getState().seekToFrameIndex(100);
        expect(video.currentTimeSets).toBe(0);
        expect(store.getState().hasDeferredNavigation).toBe(true);
        expect(displayedLabel(store, sim)).toBe(frameLabel(fps2997, 100));

        // A step after it adds to it, one frame for each press (ADR 021).
        store.getState().seekNominal(2);
        expect(displayedLabel(store, sim)).toBe(frameLabel(fps2997, 102));

        // The first frame takes the anchor, and one seek goes to the middle of frame 102.
        store
          .getState()
          .syncPresentedFrame(sim.identity, sim.startSeconds[0], 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");
        expect(store.getState().hasDeferredNavigation).toBe(false);
        expect(video.currentTimeSets).toBe(1);
        expect(presentedIndex(sim.startSeconds, video.currentTime)).toBe(102);
        expect(displayedLabel(store, sim)).toBe(frameLabel(fps2997, 102));
        expect(settleOnTarget(store, sim, video)).toBe(102);
      });

      it("is replaced by a later seek while the calibration is open", () => {
        const sim = simulateSource(fps25, tbMs, 250);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        store.getState().attach(sim.source, video);
        video.readyState = 1;
        store.getState().syncReady(sim.identity, video);

        store.getState().seekToFrameIndex(100);
        store.getState().seekToPts(String(sim.ptsTicks[30]) as Pts);
        store
          .getState()
          .syncPresentedFrame(sim.identity, sim.startSeconds[0], 1, video);
        expect(video.currentTimeSets).toBe(1);
        expect(video.currentTime).toBe(sim.startSeconds[30]);
      });

      it("runs on the approximate path when the calibration becomes unavailable", () => {
        const sim = simulateSource(fps25, tbMs, 250);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        store.getState().attach(sim.source, video);
        video.readyState = 1;
        store.getState().syncReady(sim.identity, video);

        store.getState().seekToFrameIndex(100);
        store.getState().syncPresentationUnavailable(sim.identity, video);
        expect(store.getState().calibrationStatus).toBe("unavailable");
        // The first frame and 100 steps from it, on the browser timeline.
        expect(video.currentTimeSets).toBe(1);
        expect(video.currentTime).toBeCloseTo(4, 9);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(4, 9);
      });
    });
  });

  // A navigation that arrives while the calibration anchor is open waits for the anchor, so the
  // element never moves before the first frame callback and the attachment still calibrates
  // (ADR 003). The display target shows where the request goes (ADR 022), the steps add up to
  // one step for each press (ADR 021), and the request runs once when the calibration settles.
  describe("Navigation Deferred During Calibration", () => {
    let requestSpy: MockInstance<typeof scrubAudioController.request>;

    beforeEach(() => {
      requestSpy = vi.spyOn(scrubAudioController, "request");
    });

    afterEach(() => {
      requestSpy.mockRestore();
    });

    /** Loads the metadata of the source, which is before the first frame callback. */
    function attachCalibrating(
      store: PlaybackStore,
      video: ReturnType<typeof createFakeVideo>,
      source: PlaybackSource = sourceA,
    ): void {
      store.getState().attach(source, video);
      video.readyState = 1;
      store.getState().syncReady(getSourceRevisionKey(source), video);
      store.getState().syncBrowserDuration(getSourceRevisionKey(source), video);
      expect(store.getState().calibrationStatus).toBe("calibrating");
    }

    function displayed(store: PlaybackStore, source: PlaybackSource = sourceA): number {
      return getDisplayedElapsedSeconds(
        store.getState(),
        source.videoStartPts,
        source.videoTimeBase,
      );
    }

    function canMarkNow(store: PlaybackStore): boolean {
      const state = store.getState();
      return canMarkIn(state.calibrationStatus, state.presentedFrame, true);
    }

    it("defers a step, shows its target, and runs it once on the frame grid at the anchor", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);
      const pauseCallsBefore = video.pauseCalls;

      store.getState().seekNominal(1);

      // The element stays where the anchor expects it, and the step stops playback as a seek does
      expect(video.currentTimeSets).toBe(0);
      expect(video.pauseCalls).toBe(pauseCallsBefore + 1);
      expect(store.getState().isPlaying).toBe(false);
      // The playhead goes to frame 1 at once, and no frame is confirmed
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);
      expect(displayed(store)).toBeCloseTo(0.04, 9);
      expect(store.getState().presentedFrame).toBeNull();
      expect(canMarkNow(store)).toBe(false);
      // No cue before the step runs
      expect(requestSpy).not.toHaveBeenCalled();

      // The first callback reports the first frame, which anchors videoStartPts
      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");

      // The step runs once, to the middle of frame 1, and requests the cue once from the same
      // target. No scrub audio element is mounted before the calibration settles, so that
      // request makes no sound (ADR 019).
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBeCloseTo(0.06, 9);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(video.currentTime, 1);
      // The playhead does not move, and the marks wait for the frame of the step (ADR 003)
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);
      expect(store.getState().presentedFrame).toBeNull();
      expect(canMarkNow(store)).toBe(false);

      fireSeeked(store, identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.04, 2, video);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("1");
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(canMarkNow(store)).toBe(true);
    });

    it.each([
      [
        "frame callbacks are not available",
        (store: PlaybackStore, video: PlaybackMediaElement) =>
          store.getState().syncPresentationUnavailable(identityA, video),
      ],
      [
        "the first callback reports no usable time",
        (store: PlaybackStore, video: PlaybackMediaElement) =>
          store.getState().syncPresentedFrame(identityA, Number.NaN, 1, video),
      ],
    ])(
      "runs a deferred step on the approximate path when %s",
      (_reason, makeUnavailable) => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachCalibrating(store, video);

        store.getState().seekNominal(1);
        expect(video.currentTimeSets).toBe(0);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);

        makeUnavailable(store, video);
        expect(store.getState().calibrationStatus).toBe("unavailable");

        // One nominal interval from the position of the element, and one cue request
        expect(video.currentTimeSets).toBe(1);
        expect(video.currentTime).toBeCloseTo(0.04, 9);
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenCalledWith(video.currentTime, 1);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);
        expect(canMarkNow(store)).toBe(false);

        // The seeked event settles the approximate path
        fireSeeked(store, identityA, video);
        expect(store.getState().seekTargetSeconds).toBeNull();
      },
    );

    it("adds several steps into one seek and one cue request, one frame for each press", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);

      // A held key: three presses forward, one back, one forward
      store.getState().seekNominal(1);
      store.getState().seekNominal(1);
      store.getState().seekNominal(1);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.12, 9);
      store.getState().seekNominal(-1);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.08, 9);
      store.getState().seekNominal(1);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.12, 9);
      expect(video.currentTimeSets).toBe(0);
      expect(requestSpy).not.toHaveBeenCalled();

      store.getState().syncPresentedFrame(identityA, 0, 1, video);

      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBeCloseTo(0.14, 9);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(video.currentTime, 1);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.12, 9);

      fireSeeked(store, identityA, video);
      store.getState().syncPresentedFrame(identityA, 0.12, 2, video);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("3");
    });

    it("adds a ten-frame step as ten frames", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);

      store.getState().seekNominal(10);
      store.getState().seekNominal(1);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.44, 9);

      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(video.currentTime).toBeCloseTo(0.46, 9);
      expect(requestSpy).toHaveBeenCalledTimes(1);
    });

    it("treats a step back at the start as an edge press that does not take the next step", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);
      const pauseCallsBefore = video.pauseCalls;

      // No frame precedes the first one, so the press moves nothing (ADR 022)
      store.getState().seekNominal(-1);
      expect(video.pauseCalls).toBe(pauseCallsBefore);
      expect(store.getState().seekTargetSeconds).toBeNull();

      store.getState().seekNominal(1);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);

      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(video.currentTime).toBeCloseTo(0.06, 9);
    });

    it("clears the deferred request when the steps return to the start", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);

      store.getState().seekNominal(2);
      store.getState().seekNominal(-5);
      expect(store.getState().seekTargetSeconds).toBeNull();

      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(video.currentTimeSets).toBe(0);
      expect(requestSpy).not.toHaveBeenCalled();
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
      expect(canMarkNow(store)).toBe(true);
    });

    it("stops the deferred steps at the frame that contains the end of the source", () => {
      const shortSource: PlaybackSource = {
        ...sourceA,
        path: "/media/short.mp4",
        approximateDurationSeconds: 0.1,
      };
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video, shortSource);

      // The end, 0.1 s, lies in frame 2
      store.getState().seekNominal(5);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.08, 9);
      // A press past it is an edge press, so the step back after it reaches frame 1
      store.getState().seekNominal(1);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.08, 9);
      store.getState().seekNominal(-1);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);

      store
        .getState()
        .syncPresentedFrame(getSourceRevisionKey(shortSource), 0, 1, video);
      expect(video.currentTime).toBeCloseTo(0.06, 9);
    });

    it.each([
      [
        "an approximate seek to 0",
        (store: PlaybackStore) => store.getState().seekApproximate(0),
      ],
      [
        "a seek to videoStartPts",
        (store: PlaybackStore) => store.getState().seekToPts("0" as Pts),
      ],
    ])(
      "keeps the anchor frame on screen after %s during calibration",
      (_name, seekToStart) => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachCalibrating(store, video);

        // The seek to the start is the latest request, so it replaces the steps
        store.getState().seekNominal(3);
        seekToStart(store);
        expect(store.getState().seekTargetSeconds).toBe(0);
        expect(store.getState().error).toBeNull();

        store.getState().syncPresentedFrame(identityA, 0, 1, video);

        // The anchor frame is the frame the seek asks for, so nothing moves, and that frame
        // stays confirmed for Mark In
        expect(store.getState().calibrationStatus).toBe("ready");
        expect(video.currentTimeSets).toBe(0);
        expect(requestSpy).not.toHaveBeenCalled();
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
        expect(store.getState().seekTargetSeconds).toBeNull();
        expect(canMarkNow(store)).toBe(true);
      },
    );

    it("counts a step after a seek to the start from the anchor frame", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);

      store.getState().seekApproximate(0);
      store.getState().seekNominal(1);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);

      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBeCloseTo(0.06, 9);
      expect(requestSpy).toHaveBeenCalledTimes(1);
    });

    it("runs a deferred seek to the start on the approximate path when the calibration fails", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);

      store.getState().seekApproximate(0);
      store.getState().syncPresentationUnavailable(identityA, video);

      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBe(0);
      expect(store.getState().seekTargetSeconds).toBe(0);
      fireSeeked(store, identityA, video);
      expect(store.getState().seekTargetSeconds).toBeNull();
    });

    it("runs the latest deferred approximate seek once at the anchor", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 600 });
      attachCalibrating(store, video);

      store.getState().seekApproximate(3);
      store.getState().seekApproximate(5, { scrub: true });
      store.getState().seekApproximate(7);
      expect(store.getState().seekTargetSeconds).toBe(7);
      expect(video.currentTimeSets).toBe(0);

      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBe(7);
      expect(store.getState().seekTargetSeconds).toBe(7);
      expect(store.getState().presentedFrame).toBeNull();

      store.getState().syncPresentedFrame(identityA, 7, 2, video);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("175");
    });

    it("runs a deferred scrub sample as a scrub seek, so the drag goes on from a keyframe", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 600, fastSeek: true });
      attachCalibrating(store, video);

      store.getState().seekApproximate(5, { scrub: true });
      expect(video.fastSeek).not.toHaveBeenCalled();

      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(video.fastSeek).toHaveBeenCalledTimes(1);
      expect(video.fastSeek).toHaveBeenCalledWith(5);
      expect(video.currentTimeSets).toBe(0);
    });

    it("clamps the display target of a deferred approximate seek to the browser duration", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 8 });
      attachCalibrating(store, video);

      store.getState().seekApproximate(100);
      expect(store.getState().seekTargetSeconds).toBe(8);
    });

    describe("A Deferred seekToPts", () => {
      /** Loads sourceB on a browser timeline that starts at 1.5 s. */
      function attachSourceBAtOrigin(
        store: PlaybackStore,
        video: ReturnType<typeof createFakeVideo>,
      ): void {
        store.getState().attach(sourceB, video);
        video.readyState = 1;
        video.currentTime = 1.5;
        video.seeking = false;
        store.getState().syncReady(identityB, video);
        expect(store.getState().calibrationStatus).toBe("calibrating");
      }

      // sourceB: time base 1001/30000, videoStartPts 1000. PTS 1300 lies 300 ticks, 10.01 s,
      // after the first frame.
      it("runs on the calibrated mapping at the anchor", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSourceBAtOrigin(store, video);
        const setsBefore = video.currentTimeSets;

        store.getState().seekToPts("1300" as Pts);
        expect(video.currentTimeSets).toBe(setsBefore);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(10.01, 9);

        store.getState().syncPresentedFrame(identityB, 1.5, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBeCloseTo(11.51, 9);

        store.getState().syncPresentedFrame(identityB, video.currentTime, 2, video);
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("1300");
      });

      it("runs on the approximate clock when the calibration fails", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSourceBAtOrigin(store, video);
        const setsBefore = video.currentTimeSets;

        store.getState().seekToPts("1300" as Pts);
        store.getState().syncPresentationUnavailable(identityB, video);

        // The elapsed time goes on the start of the browser timeline, and no error shows
        expect(video.currentTimeSets).toBe(setsBefore + 1);
        expect(video.currentTime).toBeCloseTo(11.51, 9);
        expect(store.getState().error).toBeNull();
        expect(store.getState().seekTargetSeconds).toBeCloseTo(10.01, 9);
      });

      it("drops the deferred request when it fails", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachSourceBAtOrigin(store, video);
        const setsBefore = video.currentTimeSets;

        store.getState().seekNominal(1);
        store.getState().seekToPts("+5" as Pts);
        expect(store.getState().error).toBe("seekFailed");
        expect(store.getState().seekTargetSeconds).toBeNull();

        store.getState().syncPresentedFrame(identityB, 1.5, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");
        expect(video.currentTimeSets).toBe(setsBefore);
        expect(requestSpy).not.toHaveBeenCalled();
      });
    });

    it("counts deferred steps from a deferred seek, and gives the element one seek", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 600, fastSeek: true });
      attachCalibrating(store, video);

      store.getState().seekApproximate(2);
      store.getState().seekNominal(2);
      // The nominal start of frame 52 on the frame grid
      expect(store.getState().seekTargetSeconds).toBeCloseTo(2.08, 9);

      store.getState().syncPresentedFrame(identityA, 0, 1, video);

      // The step counts from the seek target, and the element receives only the step: one
      // seek, to the middle of frame 52
      expect(video.currentTimeSets).toBe(1);
      expect(video.fastSeek).not.toHaveBeenCalled();
      expect(video.currentTime).toBeCloseTo(2.1, 9);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(2.08, 9);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(video.currentTime, 1);

      // The seeked event of that seek starts nothing more
      fireSeeked(store, identityA, video);
      expect(video.currentTimeSets).toBe(1);
      store.getState().syncPresentedFrame(identityA, 2.08, 2, video);
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("52");
      expect(store.getState().seekTargetSeconds).toBeNull();
    });

    it("runs the seek alone when the step after it cannot move from its target", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo({ duration: 10 });
      attachCalibrating(store, video);

      // A click just before the end and one step. Counted from the start of the timeline, the
      // step reaches the frame that contains the end.
      store.getState().seekApproximate(9.98);
      store.getState().seekNominal(1);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(10, 9);

      // The audio leads by 0.5 s, so on the calibrated axis the click lies past the end that
      // the element reports, and the step there is an edge press. The click runs alone, as one
      // seek to its PTS.
      store.getState().syncPresentedFrame(identityA, 0.5, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBeCloseTo(10.5, 9);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(10, 9);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it("shows the relative target of a deferred step on a source off the frame grid", () => {
      const variableSource: PlaybackSource = {
        ...sourceA,
        path: "/media/variable.mp4",
        rFrameRate: { n: 50, d: 1 },
      };
      const gridStore = createPlaybackStore();
      attachCalibrating(gridStore, createFakeVideo({ duration: 600 }));
      const variableStore = createPlaybackStore();
      attachCalibrating(
        variableStore,
        createFakeVideo({ duration: 600 }),
        variableSource,
      );

      for (const store of [gridStore, variableStore]) {
        store.getState().seekApproximate(0.05);
        store.getState().seekNominal(1);
      }

      // On the grid, the nominal start of frame 2. Off it, 0.05 s plus one interval.
      expect(gridStore.getState().seekTargetSeconds).toBeCloseTo(0.08, 9);
      expect(variableStore.getState().seekTargetSeconds).toBeCloseTo(0.09, 9);
    });

    it("counts a deferred step from the calibrated first frame when it lies after the timeline start", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);

      store.getState().seekNominal(1);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);

      // The audio starts before the video, so the first frame is at 0.5 s
      store.getState().syncPresentedFrame(identityA, 0.5, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(video.currentTime).toBeCloseTo(0.56, 9);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);
    });

    it("keeps the deferred target through a seeked event that it did not cause", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);

      store.getState().seekNominal(1);
      fireSeeked(store, identityA, video);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);

      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(video.currentTime).toBeCloseTo(0.06, 9);
    });

    it("drops the deferred request on a source change", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);
      store.getState().seekNominal(2);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.08, 9);

      const videoB = createFakeVideo();
      store.getState().attach(sourceB, videoB);
      expect(store.getState().seekTargetSeconds).toBeNull();
      videoB.readyState = 1;
      store.getState().syncReady(identityB, videoB);

      store.getState().syncPresentedFrame(identityB, 0, 1, videoB);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(videoB.currentTimeSets).toBe(0);
      expect(video.currentTimeSets).toBe(0);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it.each([
      [
        "a detach",
        (store: PlaybackStore, video: ReturnType<typeof createFakeVideo>) => {
          store.getState().detach(identityA, video);
          store.getState().attach(sourceA, video);
        },
      ],
      [
        "a reset",
        (store: PlaybackStore, video: ReturnType<typeof createFakeVideo>) => {
          store.getState().reset();
          store.getState().attach(sourceA, video);
        },
      ],
      [
        "a loss of readiness",
        (store: PlaybackStore, video: ReturnType<typeof createFakeVideo>) => {
          store.getState().syncUnready(identityA, video);
        },
      ],
    ])("drops the deferred request on %s", (_name, drop) => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);
      store.getState().seekNominal(2);

      drop(store, video);
      expect(store.getState().seekTargetSeconds).toBeNull();
      expect(store.getState().calibrationStatus).toBe("calibrating");

      store.getState().syncReady(identityA, video);
      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(video.currentTimeSets).toBe(0);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it("drops the deferred request on the playback toggle and plays from the start", async () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);
      store.getState().seekNominal(2);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.08, 9);

      store.getState().togglePlayback();
      await flushAsync();

      // play calls the element at once and does not seek it before the anchor
      expect(video.playCalls).toBe(1);
      expect(video.currentTimeSets).toBe(0);
      expect(store.getState().isPlaying).toBe(true);
      expect(store.getState().seekTargetSeconds).toBeNull();

      // The first frame of the playback anchors the calibration, and the step does not run
      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
      expect(video.currentTimeSets).toBe(0);
      expect(requestSpy).not.toHaveBeenCalled();
      expect(store.getState().isPlaying).toBe(true);

      store.getState().togglePlayback();
      expect(store.getState().isPlaying).toBe(false);
    });

    it("pauses playback for a step during calibration and defers the step", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);
      store.getState().togglePlayback();
      expect(store.getState().isPlaying).toBe(true);
      const pauseCallsBefore = video.pauseCalls;

      store.getState().seekNominal(1);
      expect(video.pauseCalls).toBe(pauseCallsBefore + 1);
      expect(store.getState().isPlaying).toBe(false);
      expect(video.currentTimeSets).toBe(0);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);
    });

    it("pauses playback for an edge press during calibration", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);
      store.getState().togglePlayback();
      expect(store.getState().isPlaying).toBe(true);

      store.getState().seekNominal(-1);
      expect(store.getState().isPlaying).toBe(false);
      expect(video.currentTimeSets).toBe(0);
      expect(store.getState().seekTargetSeconds).toBeNull();
    });

    it("defers nothing on a source whose calibration is unavailable from the attach", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      const noStartSource: PlaybackSource = {
        ...sourceA,
        path: "/media/no-start.mp4",
        videoStartPts: null,
      };
      store.getState().attach(noStartSource, video);
      video.readyState = 1;
      store.getState().syncReady(getSourceRevisionKey(noStartSource), video);
      expect(store.getState().calibrationStatus).toBe("unavailable");

      store.getState().seekNominal(1);
      expect(video.currentTimeSets).toBe(1);
      expect(video.currentTime).toBeCloseTo(0.04, 9);
      expect(requestSpy).toHaveBeenCalledTimes(1);
    });

    describe("A Deferred Ruler Position When the Audio Leads", () => {
      // The first video frame is presented 0.5 s after the start of the browser timeline. The
      // ruler of a calibrated source counts from that frame, so a deferred click must land
      // where the same click lands after the anchor.
      const LEAD = 0.5;

      it("runs a deferred click at the PTS that the same ruler position names", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration: 600 });
        attachCalibrating(store, video);

        store.getState().seekApproximate(3);
        expect(store.getState().seekTargetSeconds).toBe(3);

        store.getState().syncPresentedFrame(identityA, LEAD, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");

        // PTS 75 is 3 s after the calibrated first frame. The playhead does not move back.
        expect(video.currentTimeSets).toBe(1);
        expect(video.currentTime).toBeCloseTo(LEAD + 3, 9);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(3, 9);

        fireSeeked(store, identityA, video);
        store.getState().syncPresentedFrame(identityA, LEAD + 3, 2, video);
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("75");
      });

      it("counts the steps after a deferred click from that PTS, so they do not jump", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration: 600 });
        attachCalibrating(store, video);

        store.getState().seekApproximate(2);
        store.getState().seekNominal(2);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(2.08, 9);

        store.getState().syncPresentedFrame(identityA, LEAD, 1, video);

        // One seek to the middle of frame 52 on the calibrated grid, and the playhead stays
        expect(video.currentTimeSets).toBe(1);
        expect(video.currentTime).toBeCloseTo(LEAD + 2.1, 9);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(2.08, 9);

        fireSeeked(store, identityA, video);
        store.getState().syncPresentedFrame(identityA, LEAD + 2.08, 2, video);
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("52");
      });

      it("drops a deferred click at 0, whose frame is the anchor on screen", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration: 600 });
        attachCalibrating(store, video);

        store.getState().seekApproximate(0);
        store.getState().syncPresentedFrame(identityA, LEAD, 1, video);

        expect(video.currentTimeSets).toBe(0);
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
        expect(canMarkNow(store)).toBe(true);
      });

      it("keeps a deferred click on the browser timeline when the calibration fails", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration: 600 });
        attachCalibrating(store, video);

        store.getState().seekApproximate(3);
        store.getState().syncPresentationUnavailable(identityA, video);

        expect(video.currentTimeSets).toBe(1);
        expect(video.currentTime).toBe(3);
        expect(store.getState().seekTargetSeconds).toBe(3);
      });
    });

    describe("A Deferred Seek Into the Frame on Screen", () => {
      // 25 fps on a time base of 1/90000: one frame is 3600 ticks, so a target can lie inside
      // frame 0 without being videoStartPts.
      const fineSource: PlaybackSource = {
        ...sourceA,
        path: "/media/fine.mp4",
        videoTimeBase: { n: 1, d: 90000 },
      };
      const fineIdentity = getSourceRevisionKey(fineSource);

      it.each([
        [
          "a ruler position",
          (store: PlaybackStore) => store.getState().seekApproximate(0.02),
        ],
        ["a PTS", (store: PlaybackStore) => store.getState().seekToPts("1800" as Pts)],
      ])("drops %s inside frame 0 on the frame grid", (_name, seekIntoFrameZero) => {
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration: 600 });
        attachCalibrating(store, video, fineSource);

        seekIntoFrameZero(store);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(0.02, 9);

        store.getState().syncPresentedFrame(fineIdentity, 0, 1, video);
        expect(video.currentTimeSets).toBe(0);
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
        expect(store.getState().seekTargetSeconds).toBeNull();
        expect(canMarkNow(store)).toBe(true);
      });

      it("still runs a seek into frame 1", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration: 600 });
        attachCalibrating(store, video, fineSource);

        store.getState().seekToPts("3600" as Pts);
        store.getState().syncPresentedFrame(fineIdentity, 0, 1, video);
        expect(video.currentTimeSets).toBe(1);
        expect(video.currentTime).toBeCloseTo(0.04, 9);
      });

      it("runs a seek inside frame 0 off the frame grid, where no frame boundary is known", () => {
        const variableSource: PlaybackSource = {
          ...fineSource,
          path: "/media/fine-variable.mp4",
          rFrameRate: { n: 50, d: 1 },
        };
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration: 600 });
        attachCalibrating(store, video, variableSource);

        store.getState().seekToPts("1800" as Pts);
        store
          .getState()
          .syncPresentedFrame(getSourceRevisionKey(variableSource), 0, 1, video);
        expect(video.currentTimeSets).toBe(1);
        expect(video.currentTime).toBeCloseTo(0.02, 9);
      });
    });

    it("drops the deferred request when the element starts to play on its own", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();
      attachCalibrating(store, video);
      store.getState().seekNominal(2);
      expect(store.getState().seekTargetSeconds).toBeCloseTo(0.08, 9);

      // A media key starts the element, and the element reports it
      store.getState().syncPlay(identityA, video);
      expect(store.getState().isPlaying).toBe(true);
      expect(store.getState().seekTargetSeconds).toBeNull();

      store.getState().syncPresentedFrame(identityA, 0, 1, video);
      expect(store.getState().calibrationStatus).toBe("ready");
      expect(video.currentTimeSets).toBe(0);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    describe("No Action Moves the Element Before the Anchor", () => {
      // The anchor guard still refuses an anchor after a seek (seekedBeforeCalibration). This
      // checks that no action of the store gives it a reason: each one defers, or it only
      // plays. Home, End, Go to In and Go to Out are the calls that the keyboard layer plans
      // for them while the calibration is open.
      const ACTIONS: readonly [string, (store: PlaybackStore) => void][] = [
        ["a step forward", (store) => store.getState().seekNominal(1)],
        ["a step back", (store) => store.getState().seekNominal(-1)],
        ["ten frames forward", (store) => store.getState().seekNominal(10)],
        ["ten frames back", (store) => store.getState().seekNominal(-10)],
        ["a ruler click", (store) => store.getState().seekApproximate(3)],
        [
          "a scrub sample",
          (store) => store.getState().seekApproximate(4, { scrub: true }),
        ],
        [
          "a scrub sample to a PTS",
          (store) => store.getState().seekToPts("100" as Pts, { scrub: true }),
        ],
        ["a seek to a PTS", (store) => store.getState().seekToPts("50" as Pts)],
        ["Home", (store) => store.getState().seekToPts("0" as Pts)],
        ["End on the frame grid", (store) => store.getState().seekToFrameIndex(249)],
        [
          "End off the frame grid",
          (store) => store.getState().seekToPts("249" as Pts, EXTENT_END_SEEK_OPTIONS),
        ],
        [
          "End without the extent in ticks",
          (store) =>
            store.getState().seekApproximate(10, APPROXIMATE_SHORTCUT_SEEK_OPTIONS),
        ],
        ["a ruler click at the end", (store) => store.getState().seekApproximate(10)],
        ["Go to In", (store) => store.getState().seekToPts("25" as Pts)],
        ["Go to Out", (store) => store.getState().seekToPts("75" as Pts)],
        ["a typed frame timecode", (store) => store.getState().seekToFrameIndex(40)],
        [
          "a typed frame timecode at the first frame",
          (store) => store.getState().seekToFrameIndex(0),
        ],
        ["play", (store) => store.getState().play()],
        ["the playback toggle", (store) => store.getState().togglePlayback()],
      ];

      it.each(ACTIONS)("%s neither seeks nor refuses the anchor", (_name, act) => {
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration: 600, fastSeek: true });
        attachCalibrating(store, video);

        act(store);
        expect(video.currentTimeSets).toBe(0);
        expect(video.fastSeek).not.toHaveBeenCalled();

        // The first frame still anchors the calibration. The deferred request may run then.
        store.getState().syncPresentedFrame(identityA, 0, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");
      });

      it("all of them, one after the other, neither seek nor refuse the anchor", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration: 600, fastSeek: true });
        attachCalibrating(store, video);

        for (const [, act] of ACTIONS) {
          act(store);
        }
        expect(video.currentTimeSets).toBe(0);
        expect(video.fastSeek).not.toHaveBeenCalled();

        store.getState().syncPresentedFrame(identityA, 0, 1, video);
        expect(store.getState().calibrationStatus).toBe("ready");
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
      });
    });

    describe("The Public Report of a Deferred Navigation", () => {
      it("reports a deferral from the first request until it runs at the anchor", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        expect(store.getState().hasDeferredNavigation).toBe(false);
        attachCalibrating(store, video);
        expect(store.getState().hasDeferredNavigation).toBe(false);

        store.getState().seekNominal(1);
        expect(store.getState().hasDeferredNavigation).toBe(true);
        store.getState().seekApproximate(3);
        expect(store.getState().hasDeferredNavigation).toBe(true);

        store.getState().syncPresentedFrame(identityA, 0, 1, video);
        expect(store.getState().hasDeferredNavigation).toBe(false);
      });

      it("reports no deferral when the steps return to the element position", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachCalibrating(store, video);

        store.getState().seekNominal(1);
        store.getState().seekNominal(-1);
        expect(store.getState().hasDeferredNavigation).toBe(false);
        // A press at the edge defers nothing
        store.getState().seekNominal(-1);
        expect(store.getState().hasDeferredNavigation).toBe(false);
      });

      it.each([
        ["play", (store: PlaybackStore) => store.getState().play()],
        [
          "a failed seek",
          (store: PlaybackStore) => store.getState().seekToPts("+5" as Pts),
        ],
        [
          "the calibration failing",
          (store: PlaybackStore, video: PlaybackMediaElement) =>
            store.getState().syncPresentationUnavailable(identityA, video),
        ],
      ])("reports the end of a deferral on %s", (_name, end) => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachCalibrating(store, video);
        store.getState().seekNominal(1);

        end(store, video);
        expect(store.getState().hasDeferredNavigation).toBe(false);
      });
    });

    describe("Deferred Steps at the Last Frame of the Extent (ADR 026)", () => {
      // sourceA with its extent in ticks: 250 frames, and the last one is frame 249. The end
      // position, 10 s, is the start of frame 250, which does not exist.
      const gridSource: PlaybackSource = {
        ...sourceA,
        videoDurationTicks: "250" as TickCount,
      };

      it("End then → before the anchor stays on the last frame, as after the anchor", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachCalibrating(store, video, gridSource);

        store.getState().seekToFrameIndex(249);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(249 / 25, 9);
        store.getState().seekNominal(1);
        store.getState().seekNominal(10);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(249 / 25, 9);
        expect(store.getState().hasDeferredNavigation).toBe(true);

        store.getState().syncPresentedFrame(identityA, 0, 1, video);
        expect(video.currentTimeSets).toBe(1);
        expect(video.currentTime).toBeCloseTo(249.5 / 25, 9);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(249 / 25, 9);
      });

      it("steps before the anchor stop at the last frame of the extent", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachCalibrating(store, video, gridSource);

        store.getState().seekNominal(1000);
        expect(store.getState().seekTargetSeconds).toBeCloseTo(249 / 25, 9);
        store.getState().syncPresentedFrame(identityA, 0, 1, video);
        expect(video.currentTime).toBeCloseTo(249.5 / 25, 9);
      });
    });

    describe("A Deferred Seek That Keeps the Browser Timeline", () => {
      // End seeks on the approximate clock also after the anchor when the probe gives no extent
      // in ticks (ADR 026). Deferred, it keeps that clock, so it lands where the same End lands
      // after the anchor.
      const LEAD = 0.5;

      it("lands where the same call lands after the anchor, also with an audio lead", () => {
        const deferredStore = createPlaybackStore();
        const deferredVideo = createFakeVideo({ duration: 600 });
        attachCalibrating(deferredStore, deferredVideo);
        deferredStore.getState().seekApproximate(3, { keepBrowserTimeline: true });
        expect(deferredStore.getState().seekTargetSeconds).toBe(3);
        deferredStore.getState().syncPresentedFrame(identityA, LEAD, 1, deferredVideo);

        const laterStore = createPlaybackStore();
        const laterVideo = createFakeVideo({ duration: 600 });
        attachCalibrating(laterStore, laterVideo);
        laterStore.getState().syncPresentedFrame(identityA, LEAD, 1, laterVideo);
        laterStore.getState().seekApproximate(3, { keepBrowserTimeline: true });

        expect(deferredVideo.currentTimeSets).toBe(1);
        expect(deferredVideo.currentTime).toBe(3);
        expect(laterVideo.currentTime).toBe(3);
        expect(deferredStore.getState().seekTargetSeconds).toBe(
          laterStore.getState().seekTargetSeconds,
        );
      });

      it("drops such a seek at or before the anchor frame", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration: 600 });
        attachCalibrating(store, video);
        store.getState().seekApproximate(0.2, { keepBrowserTimeline: true });
        store.getState().syncPresentedFrame(identityA, LEAD, 1, video);

        expect(video.currentTimeSets).toBe(0);
        expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");
      });

      it("runs such a seek on the approximate clock when the calibration fails", () => {
        const store = createPlaybackStore();
        const video = createFakeVideo({ duration: 600 });
        attachCalibrating(store, video);
        store.getState().seekApproximate(3, { keepBrowserTimeline: true });
        store.getState().syncPresentationUnavailable(identityA, video);

        expect(video.currentTimeSets).toBe(1);
        expect(video.currentTime).toBe(3);
      });
    });
  });
});
