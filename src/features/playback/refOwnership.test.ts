import { describe, expect, it, vi } from "vitest";
import { getSourceRevisionKey } from "@/features/media";
import type { Pts } from "@/types/project";
import { createPlaybackStore } from "./store";
import { createVideoRefCallback } from "./refOwnership";
import type { PlaybackMediaElement, PlaybackSource } from "./types";

function createFakeVideo(options?: { readyState?: number }): PlaybackMediaElement & {
  playCalls: number;
  pauseCalls: number;
} {
  return {
    playCalls: 0,
    pauseCalls: 0,
    currentTime: 0,
    readyState: options?.readyState ?? 0,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
  };
}

describe("Video Ref Ownership & Binding Helper", () => {
  const sourceA: PlaybackSource = {
    path: "/media/clipA.mp4",
    size: 1048576,
    mtime: 1724976000,
    videoTimeBase: { n: 1, d: 25 },
    videoStartPts: "0" as Pts,
    avgFrameRate: { n: 25, d: 1 },
  };

  const sourceB: PlaybackSource = {
    path: "/media/clipB.mp4",
    size: 2097152,
    mtime: 1724976500,
    videoTimeBase: { n: 1001, d: 30000 },
    videoStartPts: "0" as Pts,
    avgFrameRate: { n: 30000, d: 1001 },
  };

  const identityA = getSourceRevisionKey(sourceA);
  const identityB = getSourceRevisionKey(sourceB);

  it("binds element to videoRef and attaches to playback store on mount", () => {
    const store = createPlaybackStore();
    const videoRef: { current: PlaybackMediaElement | null } = { current: null };

    const callback = createVideoRefCallback<PlaybackMediaElement>({
      getElement: () => videoRef.current,
      setElement: (element) => {
        videoRef.current = element;
      },
      getSource: () => sourceA,
      attach: store.getState().attach,
      detach: store.getState().detach,
    });

    const el1 = createFakeVideo();
    callback(el1);

    expect(videoRef.current).toBe(el1);
    expect(store.getState().isAttached).toBe(true);
    expect(store.getState().isReady).toBe(false);
  });

  it("cleans up videoRef and detaches element from store on unmount (null callback)", () => {
    const store = createPlaybackStore();
    const videoRef: { current: PlaybackMediaElement | null } = { current: null };

    const callback = createVideoRefCallback<PlaybackMediaElement>({
      getElement: () => videoRef.current,
      setElement: (element) => {
        videoRef.current = element;
      },
      getSource: () => sourceA,
      attach: store.getState().attach,
      detach: store.getState().detach,
    });

    const el1 = createFakeVideo();
    callback(el1);
    expect(videoRef.current).toBe(el1);

    callback(null);
    expect(videoRef.current).toBeNull();
    expect(store.getState().isAttached).toBe(false);
  });

  it("same identity attach el1 -> attach el2 -> late cleanup el1 does not detach or clear el2", () => {
    const store = createPlaybackStore();
    const videoRef: { current: PlaybackMediaElement | null } = { current: null };

    const callback1 = createVideoRefCallback<PlaybackMediaElement>({
      getElement: () => videoRef.current,
      setElement: (element) => {
        videoRef.current = element;
      },
      getSource: () => sourceA,
      attach: store.getState().attach,
      detach: store.getState().detach,
    });

    const callback2 = createVideoRefCallback<PlaybackMediaElement>({
      getElement: () => videoRef.current,
      setElement: (element) => {
        videoRef.current = element;
      },
      getSource: () => sourceA,
      attach: store.getState().attach,
      detach: store.getState().detach,
    });

    const el1 = createFakeVideo();
    const el2 = createFakeVideo();

    // 1. First callback mounts el1
    callback1(el1);
    expect(videoRef.current).toBe(el1);
    expect(store.getState().isAttached).toBe(true);
    store.getState().syncReady(identityA, el1);
    expect(store.getState().isReady).toBe(true);

    // 2. Second callback mounts el2 (replacing el1)
    callback2(el2);
    expect(videoRef.current).toBe(el2);
    expect(store.getState().isAttached).toBe(true);
    expect(store.getState().isReady).toBe(false); // New element starts unready
    store.getState().syncReady(identityA, el2);
    expect(store.getState().isReady).toBe(true);

    // 3. Late cleanup of callback1 with null
    callback1(null);

    // videoRef.current must still point to el2
    expect(videoRef.current).toBe(el2);
    // Store must remain attached and ready with el2
    expect(store.getState().isAttached).toBe(true);
    expect(store.getState().isReady).toBe(true);

    // el2 can still be controlled. The step waits for the calibration anchor of el2, and then
    // it moves el2 to the middle of frame 5 on the frame grid.
    store.getState().seekNominal(5);
    expect(el2.currentTime).toBe(0);
    store.getState().syncPresentedFrame(identityA, 0, 1, el2);
    expect(store.getState().calibrationStatus).toBe("ready");
    expect(el2.currentTime).toBeCloseTo(5.5 / 25, 9);
  });

  it("handles React 19 StrictMode attach -> null -> attach lifecycle ordering correctly", () => {
    const store = createPlaybackStore();
    const videoRef: { current: PlaybackMediaElement | null } = { current: null };

    const callback = createVideoRefCallback<PlaybackMediaElement>({
      getElement: () => videoRef.current,
      setElement: (element) => {
        videoRef.current = element;
      },
      getSource: () => sourceA,
      attach: store.getState().attach,
      detach: store.getState().detach,
    });

    const el1 = createFakeVideo();

    // Step 1: Initial mount
    callback(el1);
    expect(videoRef.current).toBe(el1);
    expect(store.getState().isAttached).toBe(true);
    store.getState().syncReady(identityA, el1);
    expect(store.getState().isReady).toBe(true);

    // Step 2: StrictMode simulated unmount
    callback(null);
    expect(videoRef.current).toBeNull();
    expect(store.getState().isAttached).toBe(false);
    expect(store.getState().isReady).toBe(false);

    // Step 3: StrictMode simulated remount with same element
    callback(el1);
    expect(videoRef.current).toBe(el1);
    expect(store.getState().isAttached).toBe(true);
    expect(store.getState().isReady).toBe(false); // Must re-await loaded metadata

    store.getState().syncReady(identityA, el1);
    expect(store.getState().isReady).toBe(true);
  });

  it("handles source identity transition and late detach across sources cleanly", () => {
    const store = createPlaybackStore();
    const videoRef: { current: PlaybackMediaElement | null } = { current: null };

    let currentSource = sourceA;

    const callback1 = createVideoRefCallback<PlaybackMediaElement>({
      getElement: () => videoRef.current,
      setElement: (element) => {
        videoRef.current = element;
      },
      getSource: () => currentSource,
      attach: store.getState().attach,
      detach: store.getState().detach,
    });

    const el1 = createFakeVideo();
    callback1(el1);
    store.getState().syncReady(identityA, el1);

    // Switch media to source B
    currentSource = sourceB;
    const callback2 = createVideoRefCallback<PlaybackMediaElement>({
      getElement: () => videoRef.current,
      setElement: (element) => {
        videoRef.current = element;
      },
      getSource: () => currentSource,
      attach: store.getState().attach,
      detach: store.getState().detach,
    });

    const el2 = createFakeVideo();
    callback2(el2);
    store.getState().syncReady(identityB, el2);

    // Late cleanup for callback 1
    callback1(null);

    expect(videoRef.current).toBe(el2);
    expect(store.getState().isAttached).toBe(true);
    expect(store.getState().isReady).toBe(true);
  });

  it("re-binding equivalent media callback1(readyEl) -> callback1(null) -> callback2(same el) with no second metadata event restores isReady", () => {
    const store = createPlaybackStore();
    const videoRef: { current: PlaybackMediaElement | null } = { current: null };

    // Initial source object
    const sourceInstance1: PlaybackSource = { ...sourceA };

    const callback1 = createVideoRefCallback<PlaybackMediaElement>({
      getElement: () => videoRef.current,
      setElement: (element) => {
        videoRef.current = element;
      },
      getSource: () => sourceInstance1,
      attach: store.getState().attach,
      detach: store.getState().detach,
    });

    // Element is already ready (readyState >= HAVE_METADATA)
    const el1 = createFakeVideo({ readyState: 1 });

    // Step 1: Initial mount with callback1
    callback1(el1);
    expect(videoRef.current).toBe(el1);
    expect(store.getState().isAttached).toBe(true);
    expect(store.getState().isReady).toBe(true); // Synchronously derived from readyState >= HAVE_METADATA

    // Sync presented frame
    store.getState().syncPresentedFrame(identityA, 0.0, 1, el1);
    expect(store.getState().presentedFrame?.inferredSourcePts).toBe("0");

    // Step 2: Media re-imported producing equivalent media with new source object & callback2
    const sourceInstance2: PlaybackSource = { ...sourceA };
    const callback2 = createVideoRefCallback<PlaybackMediaElement>({
      getElement: () => videoRef.current,
      setElement: (element) => {
        videoRef.current = element;
      },
      getSource: () => sourceInstance2,
      attach: store.getState().attach,
      detach: store.getState().detach,
    });

    // The user played to 42.5s before the re-import, and the element keeps its position
    el1.currentTime = 42.5;
    store.getState().syncPresentedFrame(identityA, 42.5, 1063, el1);

    // React calls callback1(null)
    callback1(null);
    expect(videoRef.current).toBeNull();
    expect(store.getState().isAttached).toBe(false);
    expect(store.getState().isReady).toBe(false);

    // React calls callback2(same el1) - no second loadedmetadata event fires
    callback2(el1);
    expect(videoRef.current).toBe(el1);
    expect(store.getState().isAttached).toBe(true);
    expect(store.getState().isReady).toBe(true); // Synchronously restored!

    // The next frame callback reports where the element already stands. It must not become the
    // calibration anchor of videoStartPts (ADR 003 step 4).
    store.getState().syncPresentedFrame(identityA, 42.5, 1064, el1);
    expect(store.getState().presentedFrame).toBeNull();
    expect(store.getState().calibrationStatus).toBe("unavailable");
  });
});
