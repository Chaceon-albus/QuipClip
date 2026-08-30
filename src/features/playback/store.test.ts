import { describe, expect, it, vi } from "vitest";
import { getMediaSourceIdentity } from "@/features/media";
import { midpointSecondsAtFrame } from "@/lib/time";
import { clampFrameIndex, createPlaybackStore } from "./store";
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

describe("Playback Store & Frame Stepping Engine", () => {
  const fps25 = { n: 25, d: 1 };
  const fpsNtsc = { n: 30000, d: 1001 };

  const sourceA: PlaybackSource = {
    path: "/media/clipA.mp4",
    size: 1048576,
    mtime: 1724976000,
    avgFrameRate: fps25,
    frameCount: 250, // frames [0..249]
  };

  const sourceB: PlaybackSource = {
    path: "/media/clipB.mp4",
    size: 2097152,
    mtime: 1724976500,
    avgFrameRate: fpsNtsc,
    frameCount: 300, // frames [0..299]
  };

  const identityA = getMediaSourceIdentity(sourceA);
  const identityB = getMediaSourceIdentity(sourceB);

  describe("Shared Integer Clamp", () => {
    it("clamps safe integer frame targets accurately", () => {
      expect(clampFrameIndex(0, 250)).toBe(0);
      expect(clampFrameIndex(100, 250)).toBe(100);
      expect(clampFrameIndex(249, 250)).toBe(249);
      expect(clampFrameIndex(250, 250)).toBe(249);
      expect(clampFrameIndex(-10, 250)).toBe(0);
    });

    it("handles boundary frameCount values (0, 1, MAX_SAFE_INTEGER)", () => {
      expect(clampFrameIndex(5, 0)).toBe(0);
      expect(clampFrameIndex(-5, 0)).toBe(0);

      expect(clampFrameIndex(0, 1)).toBe(0);
      expect(clampFrameIndex(1, 1)).toBe(0);
      expect(clampFrameIndex(-1, 1)).toBe(0);

      const maxSafe = Number.MAX_SAFE_INTEGER;
      expect(clampFrameIndex(maxSafe - 1, maxSafe)).toBe(maxSafe - 1);
      expect(clampFrameIndex(maxSafe, maxSafe)).toBe(maxSafe - 1);
      expect(clampFrameIndex(0, maxSafe)).toBe(0);
    });

    it("handles BigInt overflow without floating-point precision loss", () => {
      const hugeTarget = BigInt(Number.MAX_SAFE_INTEGER) + 1000n;
      expect(clampFrameIndex(hugeTarget, 250)).toBe(249);

      const negativeHuge = -BigInt(Number.MAX_SAFE_INTEGER) - 1000n;
      expect(clampFrameIndex(negativeHuge, 250)).toBe(0);
    });
  });

  describe("Initial State & No-Media No-Op", () => {
    it("initializes with default serializable public state", () => {
      const store = createPlaybackStore();
      const state = store.getState();

      expect(state.currentFrame).toBe(0);
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
        store.getState().stepFrames(1);
        store.getState().stepFrames(-1);
        store.getState().seekToFrame(50);
        store.getState().syncReady("some-id", fakeVideo);
        store.getState().syncUnready("some-id", fakeVideo);
        store.getState().syncRenderedFrame("some-id", 20, fakeVideo);
        store.getState().syncPlay("some-id", fakeVideo);
        store.getState().syncPause("some-id", fakeVideo);
        store.getState().syncEnded("some-id", fakeVideo);
        store.getState().detach("some-id", fakeVideo);
        store.getState().reset();
      }).not.toThrow();

      expect(store.getState().currentFrame).toBe(0);
      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().isAttached).toBe(false);
      expect(store.getState().isReady).toBe(false);
      expect(store.getState().error).toBeNull();
    });
  });

  describe("Attachment, Readiness Lifecycle & Source Validation", () => {
    it("attaches unready, and loaded metadata explicitly marks exact source+element ready", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      expect(store.getState().isAttached).toBe(true);
      expect(store.getState().isReady).toBe(false);

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

    it("validates source frameCount and timebase on attachment, rejecting invalid sources", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      // Negative frameCount
      store.getState().attach({ ...sourceA, frameCount: -1 }, video);
      expect(store.getState().isAttached).toBe(false);

      // Fractional frameCount
      store.getState().attach({ ...sourceA, frameCount: 25.5 }, video);
      expect(store.getState().isAttached).toBe(false);

      // NaN frameCount
      store.getState().attach({ ...sourceA, frameCount: NaN }, video);
      expect(store.getState().isAttached).toBe(false);

      // Unsafe integer frameCount
      store
        .getState()
        .attach({ ...sourceA, frameCount: Number.MAX_SAFE_INTEGER + 10 }, video);
      expect(store.getState().isAttached).toBe(false);

      // Non-positive frame rate numerator / denominator
      store.getState().attach({ ...sourceA, avgFrameRate: { n: 0, d: 1 } }, video);
      expect(store.getState().isAttached).toBe(false);

      store.getState().attach({ ...sourceA, avgFrameRate: { n: 25, d: 0 } }, video);
      expect(store.getState().isAttached).toBe(false);

      store.getState().attach({ ...sourceA, avgFrameRate: { n: 25.5, d: 1 } }, video);
      expect(store.getState().isAttached).toBe(false);
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

    it("detach clears attachment, readiness, and playing", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().syncPlay(identityA, video);

      store.getState().detach(identityA, video);
      expect(store.getState().isAttached).toBe(false);
      expect(store.getState().isReady).toBe(false);
      expect(store.getState().isPlaying).toBe(false);
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

      // Detach called with null or invalid element cast is safely ignored
      store.getState().detach(identityA, null as unknown as PlaybackMediaElement);
      expect(store.getState().isAttached).toBe(true);
      expect(store.getState().isReady).toBe(true);
    });

    it("source replacement pauses previous element, clears readiness, and resets frame on identity change", () => {
      const store = createPlaybackStore();
      const video1 = createFakeVideo();
      const video2 = createFakeVideo();

      store.getState().attach(sourceA, video1);
      store.getState().syncReady(identityA, video1);
      store.getState().stepFrames(40);
      expect(store.getState().currentFrame).toBe(40);

      expect(video1.pauseCalls).toBe(1); // Paused during stepFrames

      // Replace with source B
      store.getState().attach(sourceB, video2);
      expect(video1.pauseCalls).toBe(2); // Paused again during teardown
      expect(store.getState().currentFrame).toBe(0);
      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().isAttached).toBe(true);
      expect(store.getState().isReady).toBe(false); // Source B starts unready
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
      expect(store.getState().isReady).toBe(false); // starts unready for video2

      // 3. Stale events from video1 must be rejected
      store.getState().syncReady(identityA, video1);
      expect(store.getState().isReady).toBe(false);

      store.getState().syncPlay(identityA, video1);
      expect(store.getState().isPlaying).toBe(false);

      store.getState().syncRenderedFrame(identityA, 50, video1);
      expect(store.getState().currentFrame).toBe(0);

      store.getState().syncPause(identityA, video1);
      store.getState().syncEnded(identityA, video1);
      store.getState().detach(identityA, video1);
      expect(store.getState().isAttached).toBe(true); // video2 still attached

      // 4. Mark video2 ready
      store.getState().syncReady(identityA, video2);
      expect(store.getState().isReady).toBe(true);

      // 5. video2 events now work
      store.getState().syncPlay(identityA, video2);
      expect(store.getState().isPlaying).toBe(true);

      store.getState().syncRenderedFrame(identityA, 75, video2);
      expect(store.getState().currentFrame).toBe(75);
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

    it("catches synchronous exception thrown by video.play()", () => {
      const video = createFakeVideo({
        playImpl: () => {
          throw new Error("Synchronous play failure");
        },
      });

      const store = createPlaybackStore();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      store.getState().play();

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

    it("invalidates pending play promise on syncPause()", async () => {
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

      // Video element emits syncPause before promise resolves
      store.getState().syncPause(identityA, video);
      expect(store.getState().isPlaying).toBe(false);

      resolvePlay();
      await playPromise;
      await flushAsync();

      // Late resolve must NOT revive playing state
      expect(store.getState().isPlaying).toBe(false);
    });

    it("invalidates pending play promise on syncEnded()", async () => {
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

      store.getState().syncEnded(identityA, video);
      expect(store.getState().isPlaying).toBe(false);

      resolvePlay();
      await playPromise;
      await flushAsync();

      expect(store.getState().isPlaying).toBe(false);
    });

    it("invalidates pending play promise on readiness loss (syncUnready)", async () => {
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

      // Video decode error triggers syncUnready
      store.getState().syncUnready(identityA, video);
      expect(store.getState().isReady).toBe(false);
      expect(store.getState().isPlaying).toBe(false);

      resolvePlay();
      await playPromise;
      await flushAsync();

      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().error).toBeNull();
    });

    it("ignores rejected play promise after readiness loss (syncUnready)", async () => {
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

      // Video decode error triggers syncUnready
      store.getState().syncUnready(identityA, video);
      expect(store.getState().isReady).toBe(false);
      expect(store.getState().isPlaying).toBe(false);

      rejectPlay(new DOMException("Unready", "AbortError"));
      try {
        await playPromise;
      } catch {
        // Expected
      }
      await flushAsync();

      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().error).toBeNull();
    });

    it("invalidates pending play promise on detach()", async () => {
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

      store.getState().detach(identityA, video);

      rejectPlay(new DOMException("Detached", "AbortError"));
      try {
        await playPromise;
      } catch {
        // Expected
      }
      await flushAsync();

      expect(store.getState().error).toBeNull();
      expect(store.getState().isPlaying).toBe(false);
    });

    it("invalidates pending play promise on reset()", async () => {
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
      store.getState().reset();

      rejectPlay(new DOMException("Reset", "AbortError"));
      try {
        await playPromise;
      } catch {
        // Expected
      }
      await flushAsync();

      expect(store.getState().error).toBeNull();
      expect(store.getState().isPlaying).toBe(false);
    });

    it("invalidates pending play promise on same source replacement", async () => {
      let rejectPlay1!: (err: unknown) => void;
      const playPromise1 = new Promise<void>((_, rej) => {
        rejectPlay1 = rej;
      });

      const video1 = createFakeVideo({
        playImpl: () => playPromise1,
      });
      const video2 = createFakeVideo();

      const store = createPlaybackStore();
      store.getState().attach(sourceA, video1);
      store.getState().syncReady(identityA, video1);

      store.getState().play();

      // Replace with video2 on same source
      store.getState().attach(sourceA, video2);

      rejectPlay1(new DOMException("Superseded", "AbortError"));
      try {
        await playPromise1;
      } catch {
        // Expected
      }
      await flushAsync();

      expect(store.getState().error).toBeNull();
      expect(store.getState().isPlaying).toBe(false);
    });

    it("invalidates pending play promise on different source replacement", async () => {
      let rejectPlay1!: (err: unknown) => void;
      const playPromise1 = new Promise<void>((_, rej) => {
        rejectPlay1 = rej;
      });

      const video1 = createFakeVideo({
        playImpl: () => playPromise1,
      });
      const video2 = createFakeVideo();

      const store = createPlaybackStore();
      store.getState().attach(sourceA, video1);
      store.getState().syncReady(identityA, video1);

      store.getState().play();

      // Switch to source B
      store.getState().attach(sourceB, video2);

      rejectPlay1(new DOMException("Source switched", "AbortError"));
      try {
        await playPromise1;
      } catch {
        // Expected
      }
      await flushAsync();

      expect(store.getState().error).toBeNull();
      expect(store.getState().isPlaying).toBe(false);
    });

    it("invalidates pending play promise on stepFrames() and seekToFrame()", async () => {
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

      // Step frame while play is pending
      store.getState().stepFrames(1);
      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().currentFrame).toBe(1);

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
  });

  describe("Frame Stepping, Seeking, Clamping & Midpoint Calculations", () => {
    it("steps forward and backward by signed delta, setting midpoint currentTime at 25 fps", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // Step +1 -> Frame 1
      store.getState().stepFrames(1);
      expect(store.getState().currentFrame).toBe(1);
      expect(video.currentTime).toBeCloseTo((1.5 * 1) / 25, 9);

      // Step +5 -> Frame 6
      store.getState().stepFrames(5);
      expect(store.getState().currentFrame).toBe(6);
      expect(video.currentTime).toBeCloseTo((6.5 * 1) / 25, 9);

      // Step -2 -> Frame 4
      store.getState().stepFrames(-2);
      expect(store.getState().currentFrame).toBe(4);
      expect(video.currentTime).toBeCloseTo((4.5 * 1) / 25, 9);
    });

    it("calculates exact midpoint for NTSC 30000/1001 fps", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceB, video);
      store.getState().syncReady(identityB, video);

      store.getState().stepFrames(0);
      expect(store.getState().currentFrame).toBe(0);
      expect(video.currentTime).toBe((0.5 * 1001) / 30000);

      store.getState().stepFrames(1);
      expect(store.getState().currentFrame).toBe(1);
      expect(video.currentTime).toBe((1.5 * 1001) / 30000);

      store.getState().seekToFrame(99);
      expect(store.getState().currentFrame).toBe(99);
      expect(video.currentTime).toBe((99.5 * 1001) / 30000);
    });

    it("clamps frame step to lower bound 0 and upper bound frameCount - 1", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      store.getState().stepFrames(-1);
      expect(store.getState().currentFrame).toBe(0);
      expect(video.currentTime).toBeCloseTo(midpointSecondsAtFrame(0, fps25), 9);

      store.getState().stepFrames(-100);
      expect(store.getState().currentFrame).toBe(0);

      store.getState().seekToFrame(248);
      expect(store.getState().currentFrame).toBe(248);

      store.getState().stepFrames(10);
      expect(store.getState().currentFrame).toBe(249);
      expect(video.currentTime).toBeCloseTo(midpointSecondsAtFrame(249, fps25), 9);
    });

    it("handles boundary frameCount = 0 and frameCount = 1", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      // Zero-frame source
      const zeroSource: PlaybackSource = {
        ...sourceA,
        frameCount: 0,
      };
      const zeroIdentity = getMediaSourceIdentity(zeroSource);

      store.getState().attach(zeroSource, video);
      store.getState().syncReady(zeroIdentity, video);

      store.getState().stepFrames(1);
      expect(store.getState().currentFrame).toBe(0);
      store.getState().seekToFrame(10);
      expect(store.getState().currentFrame).toBe(0);

      // Single-frame source
      const oneSource: PlaybackSource = {
        ...sourceA,
        frameCount: 1,
      };
      const oneIdentity = getMediaSourceIdentity(oneSource);

      store.getState().attach(oneSource, video);
      store.getState().syncReady(oneIdentity, video);

      store.getState().stepFrames(1);
      expect(store.getState().currentFrame).toBe(0);
      expect(video.currentTime).toBeCloseTo(midpointSecondsAtFrame(0, fps25), 9);

      store.getState().stepFrames(-1);
      expect(store.getState().currentFrame).toBe(0);
    });

    it("handles frameCount = Number.MAX_SAFE_INTEGER and large frame overflow", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      const maxSafeSource: PlaybackSource = {
        ...sourceA,
        frameCount: Number.MAX_SAFE_INTEGER,
      };
      const maxSafeIdentity = getMediaSourceIdentity(maxSafeSource);

      store.getState().attach(maxSafeSource, video);
      store.getState().syncReady(maxSafeIdentity, video);

      // Seek to near max safe integer
      store.getState().seekToFrame(Number.MAX_SAFE_INTEGER - 100);
      expect(store.getState().currentFrame).toBe(Number.MAX_SAFE_INTEGER - 100);

      // Step large delta that would overflow Number.MAX_SAFE_INTEGER if added naively
      store.getState().stepFrames(Number.MAX_SAFE_INTEGER);
      expect(store.getState().currentFrame).toBe(Number.MAX_SAFE_INTEGER - 1);

      // Large negative delta that underflows
      store.getState().stepFrames(-Number.MAX_SAFE_INTEGER);
      expect(store.getState().currentFrame).toBe(0);
    });

    it("rejects invalid delta and targetFrame inputs without corrupting state", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().seekToFrame(20);
      expect(store.getState().currentFrame).toBe(20);

      // Invalid deltas
      store.getState().stepFrames(NaN);
      expect(store.getState().currentFrame).toBe(20);

      store.getState().stepFrames(1.5); // fractional
      expect(store.getState().currentFrame).toBe(20);

      store.getState().stepFrames(Infinity);
      expect(store.getState().currentFrame).toBe(20);

      store.getState().stepFrames(-Infinity);
      expect(store.getState().currentFrame).toBe(20);

      store.getState().stepFrames(Number.MAX_SAFE_INTEGER + 10);
      expect(store.getState().currentFrame).toBe(20);

      // Invalid targetFrames
      store.getState().seekToFrame(NaN);
      expect(store.getState().currentFrame).toBe(20);

      store.getState().seekToFrame(3.14);
      expect(store.getState().currentFrame).toBe(20);

      store.getState().seekToFrame(Infinity);
      expect(store.getState().currentFrame).toBe(20);

      store.getState().seekToFrame(-Infinity);
      expect(store.getState().currentFrame).toBe(20);

      store.getState().seekToFrame(Number.MAX_SAFE_INTEGER + 10);
      expect(store.getState().currentFrame).toBe(20);
    });

    it("rejects invalid syncRenderedFrame frame inputs without corrupting state", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);
      store.getState().seekToFrame(30);

      store.getState().syncRenderedFrame(identityA, NaN, video);
      expect(store.getState().currentFrame).toBe(30);

      store.getState().syncRenderedFrame(identityA, 1.5, video);
      expect(store.getState().currentFrame).toBe(30);

      store.getState().syncRenderedFrame(identityA, Infinity, video);
      expect(store.getState().currentFrame).toBe(30);

      store.getState().syncRenderedFrame(identityA, -Infinity, video);
      expect(store.getState().currentFrame).toBe(30);
    });

    it("unconditionally calls pause on active element when stepping or seeking even if isPlaying is false", () => {
      const store = createPlaybackStore();
      const video = createFakeVideo();

      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      expect(store.getState().isPlaying).toBe(false);
      expect(video.pauseCalls).toBe(0);

      store.getState().stepFrames(1);
      expect(video.pauseCalls).toBe(1);

      store.getState().seekToFrame(10);
      expect(video.pauseCalls).toBe(2);
    });
  });

  describe("Seek Failure & Error Reporting", () => {
    it("handles currentTime setter failure on step and seek without advancing frame, exposing localized seekFailed code", () => {
      const throwingVideo = createFakeVideo({
        throwOnCurrentTimeSet: true,
      });

      const store = createPlaybackStore();
      store.getState().attach(sourceA, throwingVideo);
      store.getState().syncReady(identityA, throwingVideo);

      // Attempt to step
      store.getState().stepFrames(5);
      expect(store.getState().currentFrame).toBe(0); // Frame must NOT advance
      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().error).toBe("seekFailed");

      // Attempt to seek
      store.getState().seekToFrame(50);
      expect(store.getState().currentFrame).toBe(0); // Frame must NOT advance
      expect(store.getState().isPlaying).toBe(false);
      expect(store.getState().error).toBe("seekFailed");
    });

    it("clears error on next successful playback action, step, seek, or source change", async () => {
      const video = createFakeVideo({
        playImpl: () => Promise.reject(new Error("Playback failed")),
      });

      const store = createPlaybackStore();
      store.getState().attach(sourceA, video);
      store.getState().syncReady(identityA, video);

      // Trigger playback error
      store.getState().play();
      await flushAsync();
      expect(store.getState().error).toBe("playbackFailed");

      // Stepping clears error
      store.getState().stepFrames(1);
      expect(store.getState().error).toBeNull();

      // Trigger error again
      store.getState().play();
      await flushAsync();
      expect(store.getState().error).toBe("playbackFailed");

      // Seeking clears error
      store.getState().seekToFrame(20);
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
