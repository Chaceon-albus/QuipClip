import { describe, expect, it, vi } from "vitest";
import { getSourceRevisionKey } from "@/features/media";
import {
  createPlaybackStore,
  type PlaybackMediaElement,
  type PlaybackSource,
  type PlaybackStore,
} from "@/features/playback";
import { createTimelineStore, type TimelineStore } from "@/features/timeline";
import type { Pts, Rational, TickCount } from "@/types/project";
import type { SnapBoundary } from "./scrubSnap";
import { clampTrimPts, TRIM_FRAME_WAIT_MS, type SegmentTrimProbe } from "./segmentTrim";
import {
  createSegmentTrimSession,
  type SegmentTrimClock,
  type SegmentTrimSession,
} from "./segmentTrimSession";

const pts = (value: string) => value as Pts;

const SOURCE_ID = "source-1";
const tb90k: Rational = { n: 1, d: 90_000 };
const fps25: Rational = { n: 25, d: 1 };
/** One nominal frame at 25 fps on a 1/90000 time base. */
const FRAME = 3600;

/** A constant 25 fps on a 1/90000 time base: the frame grid is exact. */
const gridSource: PlaybackSource = {
  path: "/media/clip.mp4",
  size: 1_048_576,
  mtime: 1_724_976_000,
  videoTimeBase: tb90k,
  videoStartPts: pts("0"),
  avgFrameRate: fps25,
  rFrameRate: fps25,
  approximateDurationSeconds: 10,
};

/** A variable rate: no exact frame grid. */
const vfrSource: PlaybackSource = {
  ...gridSource,
  path: "/media/vfr.mp4",
  rFrameRate: { n: 50, d: 1 },
};

/** 23.976 fps on a 1/24 time base: a coarse time base, no exact frame grid. */
const coarseSource: PlaybackSource = {
  ...gridSource,
  path: "/media/coarse.mp4",
  videoTimeBase: { n: 1, d: 24 },
  avgFrameRate: { n: 24000, d: 1001 },
  rFrameRate: { n: 24000, d: 1001 },
};

/** A media element that records each assignment of `currentTime` and starts a seek. */
interface FakeVideo extends PlaybackMediaElement {
  seeking: boolean;
  readonly seeks: number[];
}

function createFakeVideo(): FakeVideo {
  let time = 0;
  const seeks: number[] = [];
  return {
    seeking: false,
    seeks,
    readyState: 4,
    duration: 10,
    get currentTime() {
      return time;
    },
    set currentTime(value: number) {
      time = value;
      seeks.push(value);
      this.seeking = true;
    },
    play: () => Promise.resolve(),
    pause: () => {},
  };
}

/** A clock whose timers run only when the test says so. */
function createManualClock() {
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  let next = 1;
  const clock: SegmentTrimClock = {
    setTimeout: (callback, delayMs) => {
      const handle = next++;
      timers.set(handle, { callback, delayMs });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const runAll = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const { callback } of pending) {
      callback();
    }
  };
  const delays = () => [...timers.values()].map(({ delayMs }) => delayMs);
  return { clock, runAll, delays };
}

interface Harness {
  readonly playback: PlaybackStore;
  readonly timeline: TimelineStore;
  readonly video: FakeVideo;
  readonly session: SegmentTrimSession;
  readonly probe: SegmentTrimProbe;
  readonly timers: ReturnType<typeof createManualClock>;
  /**
   * Finishes every running and queued seek of the element, then reports a frame at
   * `mediaTime` as presented, as the preview does from RVFC.
   */
  readonly present: (mediaTime: number) => void;
  /** Finishes every running and queued seek of the element, with no frame. */
  readonly finishSeeks: () => void;
  /** Hides or shows the document, as the panel reports it to the session. */
  readonly setVisible: (visible: boolean) => void;
  /** The extent of the ruler that the panel passes to the session. */
  readonly total: number;
  readonly segmentA: () => { inPts: string; outPts: string };
}

/**
 * A calibrated source with segment a from frame 25 to 49 (1 s to 2 s), and segment b from frame
 * 75 to 99 (3 s to 4 s). The anchor frame (PTS 0) is on screen, and no seek is pending.
 */
function createHarness(
  options: {
    source?: PlaybackSource;
    calibrate?: boolean;
    visible?: boolean;
    /** Segment a, as In and Out PTS. Frames 25 to 49 of a 25 fps source by default. */
    segmentA?: readonly [string, string];
    /** The extent of the ruler, 10 s by default. */
    total?: number;
  } = {},
): Harness {
  const source = options.source ?? gridSource;
  const [aIn, aOut] = options.segmentA ?? ["90000", "180000"];
  const identity = getSourceRevisionKey(source);
  const playback = createPlaybackStore();
  const video = createFakeVideo();
  playback.getState().attach(source, video);
  playback.getState().syncReady(identity, video);
  if (options.calibrate !== false) {
    playback.getState().syncPresentedFrame(identity, 0, 1, video);
  }

  const timeline = createTimelineStore(
    { generateId: () => "unused" },
    {
      sourceId: SOURCE_ID,
      sourceRevisionKey: identity,
      segments: [
        { id: "a", sourceId: SOURCE_ID, inPts: pts(aIn), outPts: pts(aOut) },
        { id: "b", sourceId: SOURCE_ID, inPts: pts("270000"), outPts: pts("360000") },
      ],
    },
  );

  const timers = createManualClock();
  let visible = options.visible ?? true;
  const session = createSegmentTrimSession({
    playback,
    timeline,
    clock: timers.clock,
    isVisible: () => visible,
  });
  const setVisible = (next: boolean) => {
    visible = next;
    session.visibilityChanged(next);
  };
  let presentedFrames = 1;
  const finishSeeks = () => {
    // Each seeked event can start a queued seek, which then needs its own seeked event.
    for (let guard = 0; video.seeking && guard < 8; guard++) {
      video.seeking = false;
      playback.getState().syncSeeked(identity, video);
    }
  };
  const present = (mediaTime: number) => {
    finishSeeks();
    presentedFrames += 1;
    playback.getState().syncPresentedFrame(identity, mediaTime, presentedFrames, video);
  };
  const segmentA = () => {
    const a = timeline.getState().segments.find((segment) => segment.id === "a");
    if (a === undefined) {
      throw new Error("segment a is missing");
    }
    return { inPts: a.inPts, outPts: a.outPts };
  };
  const probe: SegmentTrimProbe = {
    videoStartPts: source.videoStartPts,
    videoTimeBase: source.videoTimeBase,
    videoDurationTicks: source.videoDurationTicks,
    avgFrameRate: source.avgFrameRate,
    rFrameRate: source.rFrameRate,
  };
  return {
    playback,
    timeline,
    video,
    session,
    probe,
    timers,
    present,
    finishSeeks,
    setVisible,
    total: options.total ?? 10,
    segmentA,
  };
}

function beginOut(h: Harness): void {
  expect(
    h.session.begin({
      segmentId: "a",
      edge: "out",
      hasActiveSource: true,
      totalDurationSeconds: h.total,
      probe: h.probe,
    }),
  ).toBe(true);
}

/** The last `currentTime` that the element received. */
function lastSeek(h: Harness): number | undefined {
  return h.video.seeks[h.video.seeks.length - 1];
}

/** The middle of nominal frame `index`, in seconds: the time that seekToFrameIndex seeks to. */
function frameMiddle(index: number): number {
  return (index * FRAME + FRAME / 2) / 90_000;
}

const snapAt = (value: string): SnapBoundary => {
  const seconds = Number(value) / 90_000;
  return { pts: pts(value), elapsedSeconds: seconds, ratio: seconds / 10 };
};

describe("segmentTrimSession: the start", () => {
  it("selects the segment at the start and changes nothing during the drag", () => {
    const h = createHarness();
    beginOut(h);
    expect(h.timeline.getState().currentSegmentId).toBe("a");
    expect(h.session.getView()).toEqual({
      segmentId: "a",
      edge: "out",
      fixedPts: "90000",
      phase: "dragging",
    });
    expect(h.session.isDragging()).toBe(true);

    h.session.scrub({ pts: pts("270000"), snap: null, writesAtOnce: false });
    expect(h.playback.getState().seekTargetSeconds).toBe(3);
    h.present(3);
    h.session.scrub({ pts: pts("315000"), snap: null, writesAtOnce: false });
    expect(h.segmentA()).toEqual({ inPts: "90000", outPts: "180000" });
    expect(h.timeline.getState().canUndo).toBe(false);
  });

  it("never starts off the exact frame grid: a variable rate or a coarse time base", () => {
    for (const source of [vfrSource, coarseSource]) {
      const h = createHarness({ source });
      const input = {
        segmentId: "a",
        edge: "out" as const,
        hasActiveSource: true,
        totalDurationSeconds: 10,
        probe: h.probe,
      };
      expect(h.session.canBegin(input)).toBe(false);
      expect(h.session.begin(input)).toBe(false);
      // Nothing changed: the edge press stays the click of ADR 007.
      expect(h.timeline.getState().currentSegmentId).toBeNull();
      expect(h.session.getView()).toBeNull();
      expect(h.session.isDragging()).toBe(false);
    }
  });

  it("does not start without a ready calibration, and changes nothing then", () => {
    const h = createHarness({ calibrate: false });
    const input = {
      segmentId: "a",
      edge: "out" as const,
      hasActiveSource: true,
      totalDurationSeconds: 10,
      probe: h.probe,
    };
    expect(h.session.canBegin(input)).toBe(false);
    expect(h.session.begin(input)).toBe(false);
    expect(h.timeline.getState().currentSegmentId).toBeNull();
  });
});

describe("segmentTrimSession: the release", () => {
  it("seeks to the target frame and commits a frame that rounds to it, as one undo step", () => {
    const h = createHarness();
    beginOut(h);
    h.session.scrub({ pts: pts("270000"), snap: null, writesAtOnce: false });
    h.present(3); // frame 75, the frame of the scrub
    // The target 275000 lies in frame 76.
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    // seekToFrameIndex aims at the middle of frame 76, and shows its nominal start.
    expect(lastSeek(h)).toBeCloseTo(frameMiddle(76), 9);
    expect(h.playback.getState().seekTargetSeconds).toBeCloseTo(76 / 25, 9);
    expect(h.session.getView()?.phase).toBe("committing");
    expect(h.segmentA().outPts).toBe("180000");

    h.present(3.04); // frame 76
    expect(h.segmentA()).toEqual({ inPts: "90000", outPts: "273600" });
    expect(h.session.getView()).toBeNull();
    expect(h.session.getNoticeCount()).toBe(0);
    h.timeline.getState().undo();
    expect(h.segmentA()).toEqual({ inPts: "90000", outPts: "180000" });
    expect(h.timeline.getState().canUndo).toBe(false);
  });

  it("writes at once when the frame on screen rounds to the target frame", () => {
    // The scrub target never clears, so a release after a pause on a frame must not wait.
    const h = createHarness();
    beginOut(h);
    h.session.scrub({ pts: pts("273600"), snap: null, writesAtOnce: false });
    h.present(3.04); // frame 76 is on screen, and the scrub target stays
    expect(h.playback.getState().seekTargetSeconds).not.toBeNull();
    h.session.release({ pts: pts("274500"), snap: null, writesAtOnce: false });
    expect(h.segmentA().outPts).toBe("273600");
    expect(h.session.getView()).toBeNull();
    // The seek to frame 76 still ends the drag on that frame, and not on a keyframe.
    expect(lastSeek(h)).toBeCloseTo(frameMiddle(76), 9);
  });

  it("waits through a late frame of another frame, and never writes it", () => {
    // The frame of the scrub, composited before the release seek completed, reaches a callback
    // after it and clears the target.
    const h = createHarness();
    beginOut(h);
    h.session.scrub({ pts: pts("270000"), snap: null, writesAtOnce: false });
    h.present(3);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    h.present(3); // frame 75 again
    expect(h.playback.getState().seekTargetSeconds).toBeNull();
    expect(h.segmentA().outPts).toBe("180000");
    expect(h.session.getView()?.phase).toBe("committing");
    // The frame of the target still commits.
    h.playback
      .getState()
      .syncPresentedFrame(getSourceRevisionKey(gridSource), 3.04, 99, h.video);
    expect(h.segmentA().outPts).toBe("273600");
  });

  it("drops the trim visibly when no frame of the target arrives within 3 s of the release", () => {
    const h = createHarness();
    beginOut(h);
    h.session.scrub({ pts: pts("270000"), snap: null, writesAtOnce: false });
    h.present(3);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    // The bound starts at the release, before any seeked event.
    expect(h.timers.delays()).toEqual([TRIM_FRAME_WAIT_MS]);
    expect(TRIM_FRAME_WAIT_MS).toBe(3000);
    h.present(3); // only a frame of another frame arrives
    h.timers.runAll();
    expect(h.session.getView()).toBeNull();
    expect(h.session.getNoticeCount()).toBe(1);
    expect(h.segmentA().outPts).toBe("180000");
    // A frame that arrives later changes nothing.
    h.playback
      .getState()
      .syncPresentedFrame(getSourceRevisionKey(gridSource), 3.04, 99, h.video);
    expect(h.segmentA().outPts).toBe("180000");
  });

  it("bounds a seek that never completes too", () => {
    const h = createHarness();
    beginOut(h);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    expect(h.video.seeking).toBe(true);
    h.timers.runAll();
    expect(h.session.getNoticeCount()).toBe(1);
    expect(h.session.getView()).toBeNull();
  });

  it("writes a snap at once, and still seeks the element there", () => {
    const h = createHarness();
    beginOut(h);
    h.session.scrub({ pts: pts("260000"), snap: null, writesAtOnce: false });
    h.session.release({
      pts: pts("270000"),
      snap: snapAt("270000"),
      writesAtOnce: true,
    });
    expect(h.segmentA()).toEqual({ inPts: "90000", outPts: "270000" });
    expect(h.session.getView()).toBeNull();
    expect(h.timers.delays()).toEqual([]);
    expect(h.playback.getState().seekTargetSeconds).toBe(3);
  });

  it("writes the frame on screen at once when the target is on screen and no seek is pending", () => {
    const h = createHarness();
    expect(
      h.session.begin({
        segmentId: "a",
        edge: "in",
        hasActiveSource: true,
        totalDurationSeconds: 10,
        probe: h.probe,
      }),
    ).toBe(true);
    const seeksBefore = h.video.seeks.length;
    // The anchor frame, frame 0, is on screen, and the target lies in frame 0.
    h.session.release({ pts: pts("1000"), snap: null, writesAtOnce: false });
    expect(h.video.seeks.length).toBe(seeksBefore);
    expect(h.segmentA()).toEqual({ inPts: "0", outPts: "180000" });
  });

  it("sends no scrub seek after the release", () => {
    const h = createHarness();
    beginOut(h);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    const seeks = h.video.seeks.length;
    h.session.scrub({ pts: pts("300000"), snap: null, writesAtOnce: false });
    expect(h.video.seeks.length).toBe(seeks);
  });
});

describe("segmentTrimSession: the end of the source, snaps and the bound", () => {
  it("stops an Out edge released at or past the end of the source on the last frame", () => {
    // The end of the lane maps to the end of the extent (10 s), where no frame starts. Frame
    // 249, at 9.96 s, is the last frame, and the Out is then the Out that Mark Out on it gives.
    for (const end of ["900000", "990000"]) {
      const h = createHarness();
      beginOut(h);
      h.session.scrub({ pts: pts("450000"), snap: null, writesAtOnce: false });
      h.present(5);
      h.session.release({ pts: pts(end), snap: null, writesAtOnce: false });
      expect(lastSeek(h)).toBeCloseTo(frameMiddle(249), 9);
      expect(h.playback.getState().seekTargetSeconds).toBeCloseTo(249 / 25, 9);
      h.present(9.96);
      expect(h.segmentA()).toEqual({ inPts: "90000", outPts: String(249 * FRAME) });
      expect(h.session.getNoticeCount()).toBe(0);
    }
  });

  it.each([
    {
      label: "29.97 fps on 1/1000",
      timeBase: { n: 1, d: 1000 },
      rate: { n: 30000, d: 1001 },
      extent: "10010",
      segmentA: ["1001", "2002"] as const,
      // Frame 299 starts at 9976.63 ms, stored rounded to 9977.
      lastFrame: 299,
      lastFrameSeconds: 9.977,
      lastFramePts: "9977",
    },
    {
      label: "23.976 fps on 1/600",
      timeBase: { n: 1, d: 600 },
      rate: { n: 24000, d: 1001 },
      extent: "25025",
      segmentA: ["751", "1502"] as const,
      // Frame 999 starts at 41.66625 s, stored rounded to 25000 ticks.
      lastFrame: 999,
      lastFrameSeconds: 25000 / 600,
      lastFramePts: "25000",
    },
  ])(
    "stops an Out edge at the end of the source on the last frame with a margin of one tick: $label",
    (grid) => {
      const source: PlaybackSource = {
        ...gridSource,
        path: `/media/${grid.extent}.mp4`,
        videoTimeBase: grid.timeBase,
        videoDurationTicks: grid.extent as TickCount,
        approximateDurationSeconds:
          (Number(grid.extent) * grid.timeBase.n) / grid.timeBase.d,
        avgFrameRate: grid.rate,
        rFrameRate: grid.rate,
      };
      const h = createHarness({
        source,
        segmentA: grid.segmentA,
        total: source.approximateDurationSeconds ?? 0,
      });
      beginOut(h);
      h.session.release({ pts: pts(grid.extent), snap: null, writesAtOnce: false });
      const middle = ((2 * grid.lastFrame + 1) * grid.rate.d) / (2 * grid.rate.n);
      expect(lastSeek(h)).toBeCloseTo(middle, 9);
      h.present(grid.lastFrameSeconds);
      expect(h.segmentA().outPts).toBe(grid.lastFramePts);
      expect(h.session.getNoticeCount()).toBe(0);
    },
  );

  it("fails visibly on an Out trim to an extent that ends after the last video frame", () => {
    // No videoDurationTicks: the extent of the ruler comes from the container, 10.2 s, and the
    // video ends with frame 249 at 9.96 s. The cap names frame 254, which the source does not
    // have, so the browser shows frame 249, and the trim writes nothing. End and Mark Out reach
    // that Out instead.
    const source: PlaybackSource = {
      ...gridSource,
      path: "/media/container.mkv",
      approximateDurationSeconds: 10.2,
    };
    const h = createHarness({ source, total: 10.2 });
    beginOut(h);
    h.session.release({ pts: pts("918000"), snap: null, writesAtOnce: false });
    expect(lastSeek(h)).toBeCloseTo(frameMiddle(254), 9);
    h.present(9.96);
    expect(h.segmentA().outPts).toBe("180000");
    h.timers.runAll();
    expect(h.session.getNoticeCount()).toBe(1);
    expect(h.session.getView()).toBeNull();
    expect(h.segmentA()).toEqual({ inPts: "90000", outPts: "180000" });
    expect(h.timeline.getState().canUndo).toBe(false);
  });

  it("keeps a stored Out on the last frame when the extent ends at the start of that frame", () => {
    // A WebM file at 25 fps on a 1/1000 time base, with no videoDurationTicks. Its Matroska
    // Duration, 9.96 s, is the start of the last block, frame 249, and not its end. The extent
    // names frame 248 as the last one, and the stored Out on frame 249 raises the cap to it.
    const source: PlaybackSource = {
      ...gridSource,
      path: "/media/short.webm",
      videoTimeBase: { n: 1, d: 1000 },
      approximateDurationSeconds: 9.96,
    };
    const h = createHarness({ source, segmentA: ["4000", "9960"], total: 9.96 });
    beginOut(h);
    const trim = h.session.getDraggingTrim();
    expect(trim?.maxPts).toBe("9960");
    // The first move of the drag, to the end of the lane, does not move the Out back.
    if (trim !== null) {
      expect(clampTrimPts(trim, pts("9960"))).toBe("9960");
    }
    // The release seeks to the middle of frame 249, which the duration clamps to 9.96 s.
    h.session.release({ pts: pts("9960"), snap: null, writesAtOnce: false });
    expect(lastSeek(h)).toBeCloseTo(9.96, 9);
    h.present(9.96);
    expect(h.segmentA()).toEqual({ inPts: "4000", outPts: "9960" });
    expect(h.session.getNoticeCount()).toBe(0);
    expect(h.session.getView()).toBeNull();
  });

  it("seeks to the frame of a snap with seekToFrameIndex, and writes the stored PTS", () => {
    const h = createHarness();
    beginOut(h);
    h.session.scrub({ pts: pts("350000"), snap: null, writesAtOnce: false });
    h.present(3.88);
    // The Out of b, frame 100.
    h.session.release({
      pts: pts("360000"),
      snap: snapAt("360000"),
      writesAtOnce: true,
    });
    expect(h.segmentA().outPts).toBe("360000");
    expect(lastSeek(h)).toBeCloseTo(frameMiddle(100), 9);
    expect(h.playback.getState().seekTargetSeconds).toBeCloseTo(4, 9);
  });

  it("commits a frame of the target that a callback shows while the seek still runs", () => {
    // A late callback of the drag, out of order, shows the frame of the target before the seek
    // of the release completes.
    const h = createHarness();
    beginOut(h);
    h.session.scrub({ pts: pts("270000"), snap: null, writesAtOnce: false });
    h.present(3);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    expect(h.video.seeking).toBe(true);
    h.playback
      .getState()
      .syncPresentedFrame(getSourceRevisionKey(gridSource), 3.04, 99, h.video);
    expect(h.segmentA().outPts).toBe("273600");
    expect(h.session.getView()).toBeNull();
  });

  it("counts only visible time for the bound, and starts it again on each return", () => {
    const h = createHarness();
    beginOut(h);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    expect(h.timers.delays()).toEqual([TRIM_FRAME_WAIT_MS]);
    // The window is minimized: the bound stops, and the trim does not fail.
    h.setVisible(false);
    expect(h.timers.delays()).toEqual([]);
    h.timers.runAll();
    expect(h.session.getView()?.phase).toBe("committing");
    // Back to visible: a whole bound starts again.
    h.setVisible(true);
    expect(h.timers.delays()).toEqual([TRIM_FRAME_WAIT_MS]);
    h.present(3.04);
    expect(h.segmentA().outPts).toBe("273600");
    expect(h.timers.delays()).toEqual([]);
  });

  it("starts the bound only when the document becomes visible after a hidden release", () => {
    const h = createHarness({ visible: false });
    beginOut(h);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    expect(h.timers.delays()).toEqual([]);
    h.setVisible(true);
    expect(h.timers.delays()).toEqual([TRIM_FRAME_WAIT_MS]);
    h.timers.runAll();
    expect(h.session.getNoticeCount()).toBe(1);
  });

  it("returns Escape to where a pending grid step drew the playhead", () => {
    const h = createHarness();
    // A step to frame 1 is pending: the playhead shows its nominal start, 0.04 s.
    h.playback.getState().seekNominal(1);
    expect(h.playback.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);
    beginOut(h);
    h.session.scrub({ pts: pts("270000"), snap: null, writesAtOnce: false });
    h.present(3);
    h.session.cancel();
    expect(h.playback.getState().seekTargetSeconds).toBeCloseTo(0.04, 9);
    expect(lastSeek(h)).toBeCloseTo(frameMiddle(1), 9);
  });
});

describe("segmentTrimSession: drops after the release", () => {
  it("drops the trim visibly when the calibration becomes unavailable", () => {
    const h = createHarness();
    beginOut(h);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    h.playback
      .getState()
      .syncPresentationUnavailable(getSourceRevisionKey(gridSource), h.video);
    expect(h.session.getView()).toBeNull();
    expect(h.session.getNoticeCount()).toBe(1);
    expect(h.timers.delays()).toEqual([]);
    h.present(3.04);
    expect(h.segmentA().outPts).toBe("180000");
  });

  it("drops the trim visibly when the source changes", () => {
    const h = createHarness();
    beginOut(h);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    const other: PlaybackSource = { ...gridSource, path: "/media/other.mp4" };
    h.playback.getState().attach(other, createFakeVideo());
    expect(h.session.getView()).toBeNull();
    expect(h.session.getNoticeCount()).toBe(1);
    expect(h.segmentA().outPts).toBe("180000");
  });

  it("drops the trim visibly when a later seek replaces the seek of the release", () => {
    const h = createHarness();
    beginOut(h);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    h.playback.getState().seekToPts(pts("450000"));
    expect(h.session.getView()).toBeNull();
    expect(h.session.getNoticeCount()).toBe(1);
    h.present(3.04);
    expect(h.segmentA().outPts).toBe("180000");
  });

  it("drops the trim visibly when playback starts", () => {
    const h = createHarness();
    beginOut(h);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    h.playback.getState().play();
    expect(h.session.getView()).toBeNull();
    expect(h.session.getNoticeCount()).toBe(1);
  });

  it("drops the trim visibly when the segment changed before the frame", () => {
    // N3: an undo or an edit during the wait moves the boundary under the trim.
    const h = createHarness();
    beginOut(h);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    h.timeline.getState().trimSegmentEdge("a", "in", pts("100800"));
    const segmentsBefore = h.timeline.getState().segments;
    h.present(3.04);
    expect(h.timeline.getState().segments).toBe(segmentsBefore);
    expect(h.session.getView()).toBeNull();
    expect(h.session.getNoticeCount()).toBe(1);
  });

  it("drops a waiting trim visibly when a new trim starts", () => {
    const h = createHarness();
    beginOut(h);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    expect(
      h.session.begin({
        segmentId: "b",
        edge: "in",
        hasActiveSource: true,
        totalDurationSeconds: 10,
        probe: h.probe,
      }),
    ).toBe(true);
    expect(h.session.getNoticeCount()).toBe(1);
    expect(h.session.getView()).toMatchObject({ segmentId: "b", phase: "dragging" });
    expect(h.timers.delays()).toEqual([]);
    h.present(3.04);
    expect(h.segmentA().outPts).toBe("180000");
  });

  it("drops a dragging trim visibly through fail, with no seek", () => {
    const h = createHarness();
    beginOut(h);
    const seeks = h.video.seeks.length;
    h.session.fail();
    expect(h.session.getView()).toBeNull();
    expect(h.session.getNoticeCount()).toBe(1);
    expect(h.video.seeks.length).toBe(seeks);
  });
});

describe("segmentTrimSession: Escape and a cancelled drag", () => {
  it("cancels with Escape: no change, the gesture ends, and the playhead returns", () => {
    const h = createHarness();
    const canceller = vi.fn();
    h.session.setDragCanceller(canceller);
    beginOut(h);
    h.session.scrub({ pts: pts("270000"), snap: null, writesAtOnce: false });
    h.present(3);
    h.session.cancel();
    expect(canceller).toHaveBeenCalledTimes(1);
    expect(h.session.getView()).toBeNull();
    expect(h.session.getNoticeCount()).toBe(0);
    // The playhead goes back to frame 0, where it stood at the start.
    expect(lastSeek(h)).toBeCloseTo(frameMiddle(0), 9);
    expect(h.playback.getState().seekTargetSeconds).toBe(0);
    h.present(0);
    expect(h.segmentA()).toEqual({ inPts: "90000", outPts: "180000" });
    expect(h.timeline.getState().canUndo).toBe(false);
  });

  it("finds no trim for a sample that the gesture sends after the cancel", () => {
    const h = createHarness();
    h.session.setDragCanceller(() => {
      expect(h.session.getDraggingTrim()).toBeNull();
      h.session.abandon({ pts: pts("315000"), snap: null, writesAtOnce: false });
    });
    beginOut(h);
    h.session.scrub({ pts: pts("270000"), snap: null, writesAtOnce: false });
    const targets: (number | null)[] = [];
    const unsubscribe = h.playback.subscribe((state) => {
      targets.push(state.seekTargetSeconds);
    });
    h.session.cancel();
    unsubscribe();
    // Only the seek back to the start ran, and not the seek of the late sample (3.5 s).
    expect(targets).toEqual([0]);
  });

  it("does nothing for Escape when no trim drags", () => {
    const h = createHarness();
    const canceller = vi.fn();
    h.session.setDragCanceller(canceller);
    h.session.cancel();
    beginOut(h);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    h.session.cancel();
    expect(canceller).not.toHaveBeenCalled();
    expect(h.session.getView()?.phase).toBe("committing");
  });

  it("abandons a cancelled drag with no change, no notice and one exact seek", () => {
    const h = createHarness();
    beginOut(h);
    h.session.scrub({ pts: pts("270000"), snap: null, writesAtOnce: false });
    h.session.abandon({ pts: pts("270000"), snap: null, writesAtOnce: false });
    expect(h.session.getView()).toBeNull();
    expect(h.session.getNoticeCount()).toBe(0);
    // The exact seek settles and clears the display target, which a scrub seek never does.
    h.present(3);
    expect(h.playback.getState().seekTargetSeconds).toBeNull();
    expect(h.segmentA()).toEqual({ inPts: "90000", outPts: "180000" });
  });

  it("notifies its subscribers at the start, the release and the end only", () => {
    const h = createHarness();
    const listener = vi.fn();
    const unsubscribe = h.session.subscribe(listener);
    beginOut(h);
    h.session.scrub({ pts: pts("270000"), snap: null, writesAtOnce: false });
    h.present(3);
    expect(listener).toHaveBeenCalledTimes(1);
    h.session.release({ pts: pts("275000"), snap: null, writesAtOnce: false });
    expect(listener).toHaveBeenCalledTimes(2);
    h.present(3.04);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});
