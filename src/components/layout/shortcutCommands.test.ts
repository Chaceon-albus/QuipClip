import { describe, expect, it } from "vitest";
import { getSourceRevisionKey } from "@/features/media";
import {
  createPlaybackStore,
  getDisplayedElapsedSeconds,
  type PlaybackMediaElement,
  type PlaybackSource,
} from "@/features/playback";
import { createTimelineStore, createTimelineViewportStore } from "@/features/timeline";
import type { Pts, Segment, TickCount } from "@/types/project";
import { SHORTCUT_ACTIONS, type ShortcutAction } from "./shortcutBindings";
import {
  APPROXIMATE_SHORTCUT_SEEK_OPTIONS,
  EXTENT_END_SEEK_OPTIONS,
  LARGE_FRAME_STEP,
  planShortcutCommand,
  TRIM_LOCKED_ACTIONS,
  type ShortcutCommand,
  type ShortcutProbe,
  type ShortcutSnapshot,
} from "./shortcutCommands";

const pts = (value: string): Pts => value as Pts;
const ticks = (value: string): TickCount => value as TickCount;

const SOURCE_ID = "source-1";

function createProbe(overrides: Partial<ShortcutProbe> = {}): ShortcutProbe {
  return {
    videoStartPts: pts("0"),
    videoTimeBase: { n: 1, d: 90_000 },
    videoDurationTicks: ticks("900000"),
    approximateDurationSeconds: 10.01,
    avgFrameRate: { n: 30, d: 1 },
    rFrameRate: { n: 30, d: 1 },
    ...overrides,
  };
}

function segment(
  id: string,
  inPts: string,
  outPts: string,
  sourceId = SOURCE_ID,
): Segment {
  return { id, sourceId, inPts: pts(inPts), outPts: pts(outPts) };
}

interface SnapshotOverrides {
  readonly probe?: ShortcutProbe | null;
  readonly playback?: Partial<ShortcutSnapshot["playback"]>;
  readonly timeline?: Partial<ShortcutSnapshot["timeline"]>;
  readonly viewport?: Partial<ShortcutSnapshot["viewport"]>;
}

/**
 * A calibrated, attached, ready and paused source at 1 s (PTS 90000), with no segment, no
 * pending In mark and an empty edit history. The timeline is zoomed to 2 of a ceiling of 8,
 * so every zoom action can act.
 */
function createSnapshot(overrides: SnapshotOverrides = {}): ShortcutSnapshot {
  return {
    probe: overrides.probe === undefined ? createProbe() : overrides.probe,
    playback: {
      isAttached: true,
      isReady: true,
      isPlaying: false,
      calibrationStatus: "ready",
      presentedFrame: { mediaTime: 1, inferredSourcePts: pts("90000") },
      seekTargetSeconds: null,
      runtimeBrowserDurationSeconds: 10.02,
      approximateBrowserTimeSeconds: 1,
      ...overrides.playback,
    },
    timeline: {
      sourceId: SOURCE_ID,
      segments: [],
      currentSegmentId: null,
      pendingInPts: null,
      canUndo: false,
      canRedo: false,
      ...overrides.timeline,
    },
    viewport: {
      zoom: 2,
      maxZoom: 8,
      ...overrides.viewport,
    },
  };
}

/** The three ways the source can be inactive. */
const INACTIVE_SNAPSHOTS: readonly [string, ShortcutSnapshot][] = [
  ["no media is open", createSnapshot({ probe: null })],
  ["no element is attached", createSnapshot({ playback: { isAttached: false } })],
  [
    "the element has not loaded metadata",
    createSnapshot({ playback: { isReady: false } }),
  ],
];

/** The actions whose control carries no source condition. */
const SOURCE_FREE_ACTIONS: readonly ShortcutAction[] = ["openMedia", "openSettings"];

/**
 * The actions whose control needs open media only: Export, and the zoom, which is view state
 * over the extent of the probe (ADR 007) and needs no attached element.
 */
const MEDIA_ONLY_ACTIONS: readonly ShortcutAction[] = [
  "export",
  "zoomIn",
  "zoomOut",
  "zoomToFit",
];

/**
 * A media element that records each seek and reports `seeking` until the test settles it. A seek
 * past `duration` stops at it, as it does in a browser.
 */
interface FakeElement extends PlaybackMediaElement {
  seeking: boolean;
  readonly currentTimeSets: number;
}

function createFakeElement(duration = 10): FakeElement {
  let time = 0;
  let sets = 0;
  const element: FakeElement = {
    seeking: false,
    readyState: 1,
    duration,
    get currentTime() {
      return time;
    },
    set currentTime(value: number) {
      time = Math.min(value, duration);
      sets++;
      element.seeking = true;
    },
    get currentTimeSets() {
      return sets;
    },
    play: () => Promise.resolve(),
    pause: () => {},
  };
  return element;
}

/**
 * The real playback and timeline stores on a 25 fps source whose PTS counts frames, with the
 * calibration anchored on PTS 0. `press` plans an action from the store states and runs the
 * planned call the way the keyboard hook does.
 *
 * With `anchored: false`, the metadata has loaded and the first frame has not arrived yet, so
 * the calibration is still open. `anchor` then presents the first frame. `media` replaces probe
 * facts of the source, in the probe and in the source of the playback store alike.
 *
 * The element reports `duration` seconds, 10 by default, and the store reads it as the preview
 * does when metadata loads. With an audio lead the element ends later than the video extent, so
 * a test with a lead passes the lead plus 10 s.
 */
function createStoreHarness({
  anchored = true,
  media = {},
  duration = 10,
}: { anchored?: boolean; media?: Partial<ShortcutProbe>; duration?: number } = {}) {
  const probe: ShortcutProbe = {
    videoStartPts: pts("0"),
    videoTimeBase: { n: 1, d: 25 },
    videoDurationTicks: ticks("250"),
    approximateDurationSeconds: 10,
    avgFrameRate: { n: 25, d: 1 },
    rFrameRate: { n: 25, d: 1 },
    ...media,
  };
  const source: PlaybackSource = {
    path: "/media/clip.mp4",
    size: 1024,
    mtime: 1_724_976_000,
    ...probe,
  };
  const key = getSourceRevisionKey(source);
  const playback = createPlaybackStore();
  let nextId = 0;
  const timeline = createTimelineStore({ generateId: () => `segment-${++nextId}` });
  const element = createFakeElement(duration);
  let presentedFrames = 0;

  playback.getState().attach(source, element);
  playback.getState().syncReady(key, element);
  playback.getState().syncBrowserDuration(key, element);
  timeline.getState().setSource(SOURCE_ID, key);
  // The first presented frame anchors the calibration on videoStartPts (ADR 003). A first frame
  // after 0 on the browser timeline models an audio track that starts before the video.
  const anchor = (mediaTime = 0): void => {
    playback.getState().syncPresentedFrame(key, mediaTime, ++presentedFrames, element);
  };
  if (anchored) {
    anchor();
  }

  const snapshot = (): ShortcutSnapshot => ({
    probe,
    playback: playback.getState(),
    timeline: timeline.getState(),
    viewport: { zoom: 1, maxZoom: 1 },
  });

  const run = (command: ShortcutCommand): void => {
    switch (command.kind) {
      case "playSegment":
        playback.getState().playSegment(command.inPts, command.outPts);
        return;
      case "pause":
        playback.getState().pause();
        return;
      case "seekToPts":
        playback.getState().seekToPts(command.pts, command.options);
        return;
      case "seekToFrameIndex":
        playback.getState().seekToFrameIndex(command.frameIndex);
        return;
      case "seekApproximate":
        playback
          .getState()
          .seekApproximate(command.seconds, APPROXIMATE_SHORTCUT_SEEK_OPTIONS);
        return;
      case "seekNominal":
        playback.getState().seekNominal(command.frames);
        return;
      case "markIn":
        timeline.getState().markIn(command.pts);
        return;
      case "markOut":
        timeline.getState().markOut(command.pts);
        return;
      case "finishSegment":
        timeline.getState().newSegment();
        return;
      default:
        throw new Error(`The harness does not run ${command.kind}`);
    }
  };

  const press = (action: ShortcutAction): ShortcutCommand | null => {
    const command = planShortcutCommand(action, snapshot());
    if (command !== null) {
      run(command);
    }
    return command;
  };

  /**
   * The element finishes the running seek, and the browser presents a frame. The calls follow
   * the `seeked` handler of the preview: the approximate clock first, then the seek state. The
   * frame is at the position of the element, unless `mediaTime` names another one, as at the
   * end of the source, where the last frame starts one interval before the end.
   */
  const presentSeekedFrame = (mediaTime: number = element.currentTime): void => {
    element.seeking = false;
    playback.getState().syncBrowserTime(key, element);
    playback.getState().syncSeeked(key, element);
    playback.getState().syncPresentedFrame(key, mediaTime, ++presentedFrames, element);
  };

  /** A click on the ruler at a frame: one exact seek, then the frame it presents. */
  const clickRulerAt = (target: string): void => {
    playback.getState().seekToPts(pts(target));
    presentSeekedFrame();
  };

  const shownPts = (): string | null =>
    playback.getState().presentedFrame?.inferredSourcePts ?? null;

  /** The position that the playhead and the timecode show (ADR 022). */
  const playheadSeconds = (): number =>
    getDisplayedElapsedSeconds(
      playback.getState(),
      probe.videoStartPts,
      probe.videoTimeBase,
    );

  /** The preview reports that frame callbacks are unavailable (ADR 003). */
  const failCalibration = (): void => {
    playback.getState().syncPresentationUnavailable(key, element);
  };

  return {
    playback,
    timeline,
    element,
    snapshot,
    press,
    anchor,
    presentSeekedFrame,
    clickRulerAt,
    shownPts,
    playheadSeconds,
    failCalibration,
  };
}

describe("planShortcutCommand", () => {
  describe("every action needs an active source, except the app commands and the zoom", () => {
    for (const [name, snapshot] of INACTIVE_SNAPSHOTS) {
      it(`plans nothing but the app commands and the zoom while ${name}`, () => {
        for (const action of SHORTCUT_ACTIONS) {
          const command = planShortcutCommand(action, snapshot);
          if (SOURCE_FREE_ACTIONS.includes(action)) {
            expect(command).not.toBeNull();
          } else if (MEDIA_ONLY_ACTIONS.includes(action)) {
            // The Export button and the zoom buttons need open media only.
            expect(command === null).toBe(snapshot.probe === null);
          } else {
            expect(command).toBeNull();
          }
        }
      });
    }
  });

  describe("the zoom of the timeline", () => {
    it("zooms in, zooms out and fits between the limits", () => {
      const snapshot = createSnapshot({ viewport: { zoom: 2, maxZoom: 8 } });
      expect(planShortcutCommand("zoomIn", snapshot)).toEqual({ kind: "zoomIn" });
      expect(planShortcutCommand("zoomOut", snapshot)).toEqual({ kind: "zoomOut" });
      expect(planShortcutCommand("zoomToFit", snapshot)).toEqual({ kind: "zoomToFit" });
    });

    it("does not zoom in at the ceiling", () => {
      const snapshot = createSnapshot({ viewport: { zoom: 8, maxZoom: 8 } });
      expect(planShortcutCommand("zoomIn", snapshot)).toBeNull();
      expect(planShortcutCommand("zoomOut", snapshot)).toEqual({ kind: "zoomOut" });
      expect(planShortcutCommand("zoomToFit", snapshot)).toEqual({ kind: "zoomToFit" });
    });

    it("does not zoom out or fit at zoom 1, where the whole source fits", () => {
      const snapshot = createSnapshot({ viewport: { zoom: 1, maxZoom: 8 } });
      expect(planShortcutCommand("zoomIn", snapshot)).toEqual({ kind: "zoomIn" });
      expect(planShortcutCommand("zoomOut", snapshot)).toBeNull();
      expect(planShortcutCommand("zoomToFit", snapshot)).toBeNull();
    });

    it("does not zoom an indeterminate extent, whose ceiling is 1", () => {
      const snapshot = createSnapshot({ viewport: { zoom: 1, maxZoom: 1 } });
      for (const action of ["zoomIn", "zoomOut", "zoomToFit"] as const) {
        expect(planShortcutCommand(action, snapshot)).toBeNull();
      }
    });

    it("zooms while a seek is pending and while the source plays", () => {
      for (const snapshot of [
        createSnapshot({ playback: { seekTargetSeconds: 3, presentedFrame: null } }),
        createSnapshot({ playback: { isPlaying: true } }),
        createSnapshot({ playback: { calibrationStatus: "calibrating" } }),
      ]) {
        expect(planShortcutCommand("zoomIn", snapshot)).toEqual({ kind: "zoomIn" });
        expect(planShortcutCommand("zoomOut", snapshot)).toEqual({ kind: "zoomOut" });
      }
    });

    it("a held zoom key stops at each limit on the real viewport store", () => {
      const viewport = createTimelineViewportStore({ maxZoom: 3 });
      const press = (action: ShortcutAction): ShortcutCommand | null => {
        const command = planShortcutCommand(
          action,
          createSnapshot({ viewport: viewport.getState() }),
        );
        if (command?.kind === "zoomIn") viewport.getState().zoomIn();
        if (command?.kind === "zoomOut") viewport.getState().zoomOut();
        if (command?.kind === "zoomToFit") viewport.getState().fit();
        return command;
      };

      // 1.25^5 > 3, so five repeats reach the ceiling, and every repeat after that does
      // nothing.
      for (let repeat = 0; repeat < 5; repeat++) {
        expect(press("zoomIn")).toEqual({ kind: "zoomIn" });
      }
      expect(viewport.getState().zoom).toBe(3);
      expect(press("zoomIn")).toBeNull();

      expect(press("zoomOut")).toEqual({ kind: "zoomOut" });
      expect(viewport.getState().zoom).toBeCloseTo(3 / 1.25, 12);

      expect(press("zoomToFit")).toEqual({ kind: "zoomToFit" });
      expect(viewport.getState().zoom).toBe(1);
      expect(viewport.getState().anchor).toEqual({ kind: "start" });
      expect(press("zoomToFit")).toBeNull();
      expect(press("zoomOut")).toBeNull();
    });
  });

  describe("playback and frame steps", () => {
    it("toggles playback with an active source, with or without a nominal rate", () => {
      expect(planShortcutCommand("togglePlayback", createSnapshot())).toEqual({
        kind: "togglePlayback",
      });
      const noRate = createSnapshot({
        probe: createProbe({ avgFrameRate: null, rFrameRate: null }),
      });
      expect(planShortcutCommand("togglePlayback", noRate)).toEqual({
        kind: "togglePlayback",
      });
    });

    it("toggles playback on a source that never calibrates", () => {
      const uncalibrated = createSnapshot({
        playback: { calibrationStatus: "unavailable", presentedFrame: null },
      });
      expect(planShortcutCommand("togglePlayback", uncalibrated)).toEqual({
        kind: "togglePlayback",
      });
    });

    it("steps one frame with one nominal interval in each direction", () => {
      expect(planShortcutCommand("stepBackOneFrame", createSnapshot())).toEqual({
        kind: "seekNominal",
        frames: -1,
      });
      expect(planShortcutCommand("stepForwardOneFrame", createSnapshot())).toEqual({
        kind: "seekNominal",
        frames: 1,
      });
    });

    it("steps ten frames as one request with ten nominal intervals", () => {
      expect(LARGE_FRAME_STEP).toBe(10);
      expect(planShortcutCommand("stepBackTenFrames", createSnapshot())).toEqual({
        kind: "seekNominal",
        frames: -10,
      });
      expect(planShortcutCommand("stepForwardTenFrames", createSnapshot())).toEqual({
        kind: "seekNominal",
        frames: 10,
      });
    });

    it("steps on a source that never calibrates, as the step buttons do (ADR 021)", () => {
      const uncalibrated = createSnapshot({
        playback: { calibrationStatus: "unavailable", presentedFrame: null },
      });
      expect(planShortcutCommand("stepForwardOneFrame", uncalibrated)).toEqual({
        kind: "seekNominal",
        frames: 1,
      });
      expect(planShortcutCommand("stepBackTenFrames", uncalibrated)).toEqual({
        kind: "seekNominal",
        frames: -10,
      });
    });

    it("steps with the rFrameRate when the avgFrameRate is not valid", () => {
      const rOnly = createSnapshot({ probe: createProbe({ avgFrameRate: null }) });
      expect(planShortcutCommand("stepForwardOneFrame", rOnly)).not.toBeNull();
    });

    it("does not step without a valid nominal frame rate", () => {
      const noRate = createSnapshot({
        probe: createProbe({ avgFrameRate: null, rFrameRate: { n: 0, d: 1 } }),
      });
      for (const action of [
        "stepBackOneFrame",
        "stepForwardOneFrame",
        "stepBackTenFrames",
        "stepForwardTenFrames",
      ] as const) {
        expect(planShortcutCommand(action, noRate)).toBeNull();
      }
    });
  });

  describe("Home and End", () => {
    it("goes to videoStartPts on a calibrated source", () => {
      const snapshot = createSnapshot({
        probe: createProbe({ videoStartPts: pts("-3003") }),
      });
      expect(planShortcutCommand("goToStart", snapshot)).toEqual({
        kind: "seekToPts",
        pts: "-3003",
      });
    });

    it("goes to time zero on the approximate clock when the source never calibrates", () => {
      const snapshot = createSnapshot({
        playback: { calibrationStatus: "unavailable", presentedFrame: null },
      });
      expect(planShortcutCommand("goToStart", snapshot)).toEqual({
        kind: "seekApproximate",
        seconds: 0,
      });
    });

    it("plans Home and End while the calibration is open, for the store to defer", () => {
      // The store defers a seek until the anchor, so a seek in that window no longer refuses
      // precise editing (ADR 022). Home goes to videoStartPts, and End to the last frame, as on
      // a calibrated source.
      const calibrating = createSnapshot({
        playback: { calibrationStatus: "calibrating", presentedFrame: null },
      });
      expect(planShortcutCommand("goToStart", calibrating)).toEqual({
        kind: "seekToPts",
        pts: "0",
      });
      expect(planShortcutCommand("goToEnd", calibrating)).toEqual({
        kind: "seekToFrameIndex",
        frameIndex: 299,
      });
      // Off the frame grid End goes to the last tick while the calibration is open too.
      const vfrCalibrating = createSnapshot({
        probe: createProbe({ avgFrameRate: { n: 2997, d: 100 } }),
        playback: { calibrationStatus: "calibrating", presentedFrame: null },
      });
      expect(planShortcutCommand("goToEnd", vfrCalibrating)).toEqual({
        kind: "seekToPts",
        pts: "899999",
        options: EXTENT_END_SEEK_OPTIONS,
      });
      // The frame step keeps the looser condition of the step buttons (ADR 021).
      expect(planShortcutCommand("stepForwardOneFrame", calibrating)).not.toBeNull();
    });

    it("does nothing on Home when the first frame is already on screen", () => {
      const atStart = createSnapshot({
        playback: { presentedFrame: { mediaTime: 0, inferredSourcePts: pts("0") } },
      });
      expect(planShortcutCommand("goToStart", atStart)).toBeNull();
    });

    it("goes to the start when the first frame is on screen but a seek is pending", () => {
      // The element is moving away from the presented frame, so the seek must still run.
      const leaving = createSnapshot({
        playback: {
          presentedFrame: { mediaTime: 0, inferredSourcePts: pts("0") },
          seekTargetSeconds: 3,
        },
      });
      expect(planShortcutCommand("goToStart", leaving)).toEqual({
        kind: "seekToPts",
        pts: "0",
      });
    });

    it("goes to time zero on the approximate clock when videoStartPts is missing", () => {
      const snapshot = createSnapshot({ probe: createProbe({ videoStartPts: null }) });
      expect(planShortcutCommand("goToStart", snapshot)).toEqual({
        kind: "seekApproximate",
        seconds: 0,
      });
    });

    it("goes to the index of the last frame on the frame grid of a calibrated source", () => {
      // 900000 ticks at 1/90000 is 10 s, 300 frames at 30 fps: the last one is frame 299.
      expect(planShortcutCommand("goToEnd", createSnapshot())).toEqual({
        kind: "seekToFrameIndex",
        frameIndex: 299,
      });
      // The index counts from videoStartPts.
      const offset = createSnapshot({
        probe: createProbe({ videoStartPts: pts("-3003") }),
        playback: { presentedFrame: { mediaTime: 1, inferredSourcePts: pts("87000") } },
      });
      expect(planShortcutCommand("goToEnd", offset)).toEqual({
        kind: "seekToFrameIndex",
        frameIndex: 299,
      });
    });

    it("takes the index of the last frame that starts inside the extent by more than the margin", () => {
      // On these time bases the ADR 028 margin is one tick. The frame that holds the last tick
      // with that margin added is the frame after the last one, which End does not go to.
      const cases: readonly [Partial<ShortcutProbe>, number][] = [
        [
          {
            videoTimeBase: { n: 1, d: 1000 },
            videoDurationTicks: ticks("10010"),
            avgFrameRate: { n: 30000, d: 1001 },
            rFrameRate: { n: 30000, d: 1001 },
          },
          299,
        ],
        [
          {
            videoTimeBase: { n: 1, d: 1000 },
            videoDurationTicks: ticks("10000"),
          },
          299,
        ],
        [
          {
            videoTimeBase: { n: 1, d: 600 },
            videoDurationTicks: ticks("25025"),
            approximateDurationSeconds: 41.75,
            avgFrameRate: { n: 24000, d: 1001 },
            rFrameRate: { n: 24000, d: 1001 },
          },
          999,
        ],
      ];
      for (const [probe, frameIndex] of cases) {
        const snapshot = createSnapshot({
          probe: createProbe(probe),
          playback: { presentedFrame: null },
        });
        expect(planShortcutCommand("goToEnd", snapshot)).toEqual({
          kind: "seekToFrameIndex",
          frameIndex,
        });
      }
    });

    it("goes to the last tick of the extent off the frame grid", () => {
      const lastTick: ShortcutCommand = {
        kind: "seekToPts",
        pts: pts("899999"),
        options: EXTENT_END_SEEK_OPTIONS,
      };
      // A variable frame rate: the average and the real rate differ.
      const vfr = createSnapshot({
        probe: createProbe({ avgFrameRate: { n: 2997, d: 100 } }),
      });
      expect(planShortcutCommand("goToEnd", vfr)).toEqual(lastTick);
      // No nominal rate, so no grid.
      const noRate = createSnapshot({
        probe: createProbe({ avgFrameRate: null, rFrameRate: null }),
      });
      expect(planShortcutCommand("goToEnd", noRate)).toEqual(lastTick);
      // A coarse time base: 1/24 at 23.976 fps, where one tick is almost a whole frame.
      const coarse = createSnapshot({
        probe: createProbe({
          videoTimeBase: { n: 1, d: 24 },
          videoDurationTicks: ticks("240"),
          avgFrameRate: { n: 24000, d: 1001 },
          rFrameRate: { n: 24000, d: 1001 },
        }),
        playback: { presentedFrame: { mediaTime: 1, inferredSourcePts: pts("24") } },
      });
      expect(planShortcutCommand("goToEnd", coarse)).toEqual({
        ...lastTick,
        pts: "239",
      });
      // The last tick counts from videoStartPts.
      const offset = createSnapshot({
        probe: createProbe({
          videoStartPts: pts("-3003"),
          avgFrameRate: { n: 2997, d: 100 },
        }),
        playback: { presentedFrame: { mediaTime: 1, inferredSourcePts: pts("87000") } },
      });
      expect(planShortcutCommand("goToEnd", offset)).toEqual({
        ...lastTick,
        pts: "896996",
      });
    });

    it("goes to the end of the ruler on the approximate clock without a calibration", () => {
      const uncalibrated = createSnapshot({
        playback: { calibrationStatus: "unavailable", presentedFrame: null },
      });
      expect(planShortcutCommand("goToEnd", uncalibrated)).toEqual({
        kind: "seekApproximate",
        seconds: 10,
      });
    });

    it("keeps the approximate clock without the extent in ticks, with the extent rule of the ruler (ADR 007)", () => {
      const noTicks = createSnapshot({
        probe: createProbe({ videoDurationTicks: null }),
      });
      expect(planShortcutCommand("goToEnd", noTicks)).toEqual({
        kind: "seekApproximate",
        seconds: 10.01,
      });
      // An empty extent names no last frame either.
      const emptyExtent = createSnapshot({
        probe: createProbe({ videoDurationTicks: ticks("0") }),
      });
      expect(planShortcutCommand("goToEnd", emptyExtent)).toEqual({
        kind: "seekApproximate",
        seconds: 10.01,
      });
      // Nor does a source without videoStartPts, which also cannot calibrate.
      const noStart = createSnapshot({
        probe: createProbe({ videoStartPts: null }),
        playback: { calibrationStatus: "unavailable", presentedFrame: null },
      });
      expect(planShortcutCommand("goToEnd", noStart)).toEqual({
        kind: "seekApproximate",
        seconds: 10,
      });

      const browserOnly = createSnapshot({
        probe: createProbe({
          videoDurationTicks: null,
          approximateDurationSeconds: null,
        }),
      });
      expect(planShortcutCommand("goToEnd", browserOnly)).toEqual({
        kind: "seekApproximate",
        seconds: 10.02,
      });
    });

    it("does not go to the end of an indeterminate extent", () => {
      const indeterminate = createSnapshot({
        probe: createProbe({
          videoDurationTicks: null,
          approximateDurationSeconds: null,
        }),
        playback: { runtimeBrowserDurationSeconds: null },
      });
      expect(planShortcutCommand("goToEnd", indeterminate)).toBeNull();
    });

    // End on the approximate clock of a calibrated source whose probe gives no extent in
    // ticks. The end of the ruler is the approximate duration, 10 s at 30 fps. The last frame
    // (PTS 897000) starts one interval before it, so End compares the position of the element,
    // not the presented frame.
    const APPROXIMATE_PROBE = createProbe({
      videoDurationTicks: null,
      approximateDurationSeconds: 10,
    });
    const LAST_FRAME = { mediaTime: 299 / 30, inferredSourcePts: pts("897000") };
    const END_SEEK: ShortcutCommand = { kind: "seekApproximate", seconds: 10 };
    const atEndSnapshot = (
      playback: Partial<ShortcutSnapshot["playback"]> = {},
      probe: ShortcutProbe = APPROXIMATE_PROBE,
    ): ShortcutSnapshot =>
      createSnapshot({
        probe,
        playback: {
          presentedFrame: LAST_FRAME,
          approximateBrowserTimeSeconds: 10,
          ...playback,
        },
      });

    it("does nothing on End when the element already stands at the end", () => {
      expect(planShortcutCommand("goToEnd", atEndSnapshot())).toBeNull();
      // Less than half a frame interval from the end, on either side of it.
      for (const position of [10 - 0.4 / 30, 10 + 0.4 / 30]) {
        expect(
          planShortcutCommand(
            "goToEnd",
            atEndSnapshot({ approximateBrowserTimeSeconds: position }),
          ),
        ).toBeNull();
      }
    });

    it("goes to the end from one frame before it", () => {
      const oneFrameBefore = atEndSnapshot({
        approximateBrowserTimeSeconds: 10 - 1 / 30,
      });
      expect(planShortcutCommand("goToEnd", oneFrameBefore)).toEqual(END_SEEK);
    });

    it("goes to the end when a seek is pending, even from the end", () => {
      // The element is moving away from the end, so the seek must still run.
      const leaving = atEndSnapshot({ seekTargetSeconds: 3 });
      expect(planShortcutCommand("goToEnd", leaving)).toEqual(END_SEEK);
    });

    it("goes to the end from the end without a frame, a clock, a calibration or a pause", () => {
      const cases: Partial<ShortcutSnapshot["playback"]>[] = [
        { presentedFrame: null },
        { approximateBrowserTimeSeconds: null },
        { calibrationStatus: "unavailable", presentedFrame: null },
        // The clock is a timeupdate sample during playback, and the seek stops the playback.
        { isPlaying: true },
      ];
      for (const playback of cases) {
        expect(planShortcutCommand("goToEnd", atEndSnapshot(playback))).toEqual(
          END_SEEK,
        );
      }
    });

    it("does nothing on End at the end without a nominal rate, within one microsecond", () => {
      const noRate: ShortcutProbe = {
        ...APPROXIMATE_PROBE,
        avgFrameRate: null,
        rFrameRate: null,
      };
      expect(planShortcutCommand("goToEnd", atEndSnapshot({}, noRate))).toBeNull();
      expect(
        planShortcutCommand(
          "goToEnd",
          atEndSnapshot({ approximateBrowserTimeSeconds: 10 + 1e-7 }, noRate),
        ),
      ).toBeNull();
      // No frame interval is known, so a position one millisecond away still seeks.
      expect(
        planShortcutCommand(
          "goToEnd",
          atEndSnapshot({ approximateBrowserTimeSeconds: 10 - 1e-3 }, noRate),
        ),
      ).toEqual(END_SEEK);
    });

    describe("the last frame on screen (ADR 026)", () => {
      const onScreen = (
        inferredSourcePts: string,
        playback: Partial<ShortcutSnapshot["playback"]> = {},
        probe: ShortcutProbe = createProbe(),
      ): ShortcutSnapshot =>
        createSnapshot({
          probe,
          playback: {
            presentedFrame: {
              mediaTime: 9.9,
              inferredSourcePts: pts(inferredSourcePts),
            },
            // The position of the element does not decide: the rule compares the frame.
            approximateBrowserTimeSeconds: 3,
            ...playback,
          },
        });
      const LAST_INDEX: ShortcutCommand = { kind: "seekToFrameIndex", frameIndex: 299 };

      it("does nothing on the grid when the frame on screen has the index of the last frame", () => {
        expect(planShortcutCommand("goToEnd", onScreen("897000"))).toBeNull();
        // A frame start that the container stored a tick late is the same frame (ADR 028).
        expect(planShortcutCommand("goToEnd", onScreen("897001"))).toBeNull();
        // The frame before it.
        expect(planShortcutCommand("goToEnd", onScreen("894000"))).toEqual(LAST_INDEX);
      });

      it("does nothing on a grid with a one-tick margin at the last of the whole frames", () => {
        // 29.97 fps on 1/1000: frame 299 starts at 9976.6 ms, stored as 9977.
        const matroska = createProbe({
          videoTimeBase: { n: 1, d: 1000 },
          videoDurationTicks: ticks("10010"),
          avgFrameRate: { n: 30000, d: 1001 },
          rFrameRate: { n: 30000, d: 1001 },
        });
        expect(
          planShortcutCommand("goToEnd", onScreen("9977", {}, matroska)),
        ).toBeNull();
        expect(planShortcutCommand("goToEnd", onScreen("9943", {}, matroska))).toEqual({
          kind: "seekToFrameIndex",
          frameIndex: 299,
        });
      });

      it("never moves back from a frame past the last frame of the extent", () => {
        // The source shows a frame that the reported extent leaves out: index 300 on the grid,
        // and a frame after the last tick off the grid.
        expect(planShortcutCommand("goToEnd", onScreen("900000"))).toBeNull();
        expect(planShortcutCommand("goToEnd", onScreen("903000"))).toBeNull();
        const vfr = createProbe({ avgFrameRate: { n: 2997, d: 100 } });
        expect(planShortcutCommand("goToEnd", onScreen("900500", {}, vfr))).toBeNull();
      });

      it("seeks on the grid when a seek is pending or the source plays", () => {
        expect(
          planShortcutCommand("goToEnd", onScreen("897000", { seekTargetSeconds: 3 })),
        ).toEqual(LAST_INDEX);
        // The store then only pauses while the element is inside the last frame.
        expect(
          planShortcutCommand("goToEnd", onScreen("897000", { isPlaying: true })),
        ).toEqual(LAST_INDEX);
      });

      it("does nothing off the grid when the frame on screen starts at the last tick", () => {
        const coarse = createProbe({
          videoTimeBase: { n: 1, d: 24 },
          videoDurationTicks: ticks("240"),
          avgFrameRate: { n: 24000, d: 1001 },
          rFrameRate: { n: 24000, d: 1001 },
        });
        expect(planShortcutCommand("goToEnd", onScreen("239", {}, coarse))).toBeNull();
        expect(
          planShortcutCommand("goToEnd", onScreen("239", { isPlaying: true }, coarse)),
        ).toEqual({
          kind: "seekToPts",
          pts: "239",
          options: EXTENT_END_SEEK_OPTIONS,
        });
      });

      it("leaves a last frame that starts before the last tick to the store off the grid", () => {
        // A variable rate: the frame on screen can be the last frame, but no boundary says so.
        // The store answers from the position of the element (extentEnd).
        const vfr = createProbe({ avgFrameRate: { n: 2997, d: 100 } });
        expect(planShortcutCommand("goToEnd", onScreen("897030", {}, vfr))).toEqual({
          kind: "seekToPts",
          pts: "899999",
          options: EXTENT_END_SEEK_OPTIONS,
        });
      });
    });
  });

  describe("Mark In and Mark Out", () => {
    it("marks In at the PTS of the presented frame", () => {
      expect(planShortcutCommand("markIn", createSnapshot())).toEqual({
        kind: "markIn",
        pts: "90000",
      });
    });

    it("does not mark during a pending seek, which clears the presented frame", () => {
      const pending = createSnapshot({
        playback: { presentedFrame: null },
        timeline: { pendingInPts: pts("0") },
      });
      expect(planShortcutCommand("markIn", pending)).toBeNull();
      expect(planShortcutCommand("markOut", pending)).toBeNull();
    });

    it("does not mark on a source that is not calibrated", () => {
      for (const calibrationStatus of ["calibrating", "unavailable"] as const) {
        const snapshot = createSnapshot({
          playback: { calibrationStatus },
          timeline: { pendingInPts: pts("0") },
        });
        expect(planShortcutCommand("markIn", snapshot)).toBeNull();
        expect(planShortcutCommand("markOut", snapshot)).toBeNull();
      }
    });

    it("applies the canMarkIn rule to a current segment", () => {
      // The playhead at 90000 is inside [0, 180000), so Mark In moves the In boundary.
      const inside = createSnapshot({
        timeline: {
          segments: [segment("a", "0", "180000")],
          currentSegmentId: "a",
        },
      });
      expect(planShortcutCommand("markIn", inside)).toEqual({
        kind: "markIn",
        pts: "90000",
      });

      // The playhead at the Out boundary would leave inPts === outPts.
      const atOut = createSnapshot({
        timeline: {
          segments: [segment("a", "0", "90000")],
          currentSegmentId: "a",
        },
      });
      expect(planShortcutCommand("markIn", atOut)).toBeNull();

      // The playhead at the In boundary would change nothing.
      const atIn = createSnapshot({
        timeline: {
          segments: [segment("a", "90000", "180000")],
          currentSegmentId: "a",
        },
      });
      expect(planShortcutCommand("markIn", atIn)).toBeNull();
    });

    it("marks Out only after a pending In mark that lies before the frame", () => {
      expect(planShortcutCommand("markOut", createSnapshot())).toBeNull();

      const before = createSnapshot({ timeline: { pendingInPts: pts("3000") } });
      expect(planShortcutCommand("markOut", before)).toEqual({
        kind: "markOut",
        pts: "90000",
      });

      const same = createSnapshot({ timeline: { pendingInPts: pts("90000") } });
      expect(planShortcutCommand("markOut", same)).toBeNull();
    });

    it("applies the canMarkOut rule to a current segment", () => {
      const inside = createSnapshot({
        timeline: {
          segments: [segment("a", "0", "180000")],
          currentSegmentId: "a",
        },
      });
      expect(planShortcutCommand("markOut", inside)).toEqual({
        kind: "markOut",
        pts: "90000",
      });

      const atIn = createSnapshot({
        timeline: {
          segments: [segment("a", "90000", "180000")],
          currentSegmentId: "a",
        },
      });
      expect(planShortcutCommand("markOut", atIn)).toBeNull();
    });
  });

  describe("Go to In and Go to Out", () => {
    const withSegment = (overrides: SnapshotOverrides = {}) =>
      createSnapshot({
        ...overrides,
        timeline: {
          segments: [segment("a", "30000", "60000"), segment("b", "120000", "150000")],
          currentSegmentId: "b",
          ...overrides.timeline,
        },
      });

    it("goes to the In and the Out of the named segment", () => {
      expect(planShortcutCommand("goToSegmentIn", withSegment())).toEqual({
        kind: "seekToPts",
        pts: "120000",
      });
      // outPts is the first frame after the half-open segment (ADR 002).
      expect(planShortcutCommand("goToSegmentOut", withSegment())).toEqual({
        kind: "seekToPts",
        pts: "150000",
      });
    });

    it("goes to the pending In mark when no segment is current", () => {
      const pending = createSnapshot({ timeline: { pendingInPts: pts("45000") } });
      expect(planShortcutCommand("goToSegmentIn", pending)).toEqual({
        kind: "seekToPts",
        pts: "45000",
      });
      // A pending mark has no Out.
      expect(planShortcutCommand("goToSegmentOut", pending)).toBeNull();
    });

    it("does nothing with no current segment and no pending In mark", () => {
      expect(planShortcutCommand("goToSegmentIn", createSnapshot())).toBeNull();
      expect(planShortcutCommand("goToSegmentOut", createSnapshot())).toBeNull();
    });

    it("does not go to a segment of another source", () => {
      const foreign = createSnapshot({
        timeline: {
          segments: [segment("x", "30000", "60000", "source-2")],
          currentSegmentId: "x",
        },
      });
      expect(planShortcutCommand("goToSegmentIn", foreign)).toBeNull();
      expect(planShortcutCommand("goToSegmentOut", foreign)).toBeNull();
    });

    it("does not go to a stored PTS that does not parse", () => {
      const malformed = createSnapshot({
        timeline: {
          segments: [segment("a", "+30000", "6e4")],
          currentSegmentId: "a",
        },
      });
      expect(planShortcutCommand("goToSegmentIn", malformed)).toBeNull();
      expect(planShortcutCommand("goToSegmentOut", malformed)).toBeNull();
    });

    it("does not go anywhere on a source that cannot calibrate", () => {
      // seekToPts would report a failed seek there.
      const snapshot = withSegment({
        playback: { calibrationStatus: "unavailable", presentedFrame: null },
      });
      expect(planShortcutCommand("goToSegmentIn", snapshot)).toBeNull();
      expect(planShortcutCommand("goToSegmentOut", snapshot)).toBeNull();
    });

    it("goes while the calibration is open, for the store to defer", () => {
      // The store defers seekToPts until the anchor, and then runs it on the calibrated
      // mapping (ADR 022). No frame is on screen yet, so the target is never the frame there.
      const snapshot = withSegment({
        playback: { calibrationStatus: "calibrating", presentedFrame: null },
      });
      expect(planShortcutCommand("goToSegmentIn", snapshot)).toEqual({
        kind: "seekToPts",
        pts: "120000",
      });
      expect(planShortcutCommand("goToSegmentOut", snapshot)).not.toBeNull();
    });

    it("goes during a pending seek, which needs no presented frame", () => {
      const pendingSeek = withSegment({ playback: { presentedFrame: null } });
      expect(planShortcutCommand("goToSegmentIn", pendingSeek)).toEqual({
        kind: "seekToPts",
        pts: "120000",
      });
    });

    it("does nothing when the In or the Out is the frame on screen", () => {
      const atIn = withSegment({
        playback: {
          presentedFrame: { mediaTime: 4 / 3, inferredSourcePts: pts("120000") },
        },
      });
      expect(planShortcutCommand("goToSegmentIn", atIn)).toBeNull();
      expect(planShortcutCommand("goToSegmentOut", atIn)).toEqual({
        kind: "seekToPts",
        pts: "150000",
      });

      const atOut = withSegment({
        playback: {
          presentedFrame: { mediaTime: 5 / 3, inferredSourcePts: pts("150000") },
        },
      });
      expect(planShortcutCommand("goToSegmentOut", atOut)).toBeNull();
      expect(planShortcutCommand("goToSegmentIn", atOut)).toEqual({
        kind: "seekToPts",
        pts: "120000",
      });
    });

    it("does nothing when the pending In mark is the frame on screen", () => {
      const atPending = createSnapshot({ timeline: { pendingInPts: pts("90000") } });
      expect(planShortcutCommand("goToSegmentIn", atPending)).toBeNull();
    });

    it("goes to the frame on screen when a seek is pending", () => {
      // ADR 022: an RVFC callback for an earlier seek can leave presentedFrame set while the
      // last seek runs. The element then moves, so the return must still seek.
      const leaving = withSegment({
        playback: {
          presentedFrame: { mediaTime: 4 / 3, inferredSourcePts: pts("120000") },
          seekTargetSeconds: 8,
        },
      });
      expect(planShortcutCommand("goToSegmentIn", leaving)).toEqual({
        kind: "seekToPts",
        pts: "120000",
      });
    });
  });

  describe("Play Segment", () => {
    const withSegments = (
      timeline: Partial<ShortcutSnapshot["timeline"]>,
      playback: Partial<ShortcutSnapshot["playback"]> = {},
    ): ShortcutSnapshot => createSnapshot({ timeline, playback });

    it("plays the selected segment, wherever the frame on screen is", () => {
      const snapshot = withSegments({
        segments: [segment("a", "300000", "360000"), segment("b", "60000", "120000")],
        currentSegmentId: "a",
      });
      expect(planShortcutCommand("playSegment", snapshot)).toEqual({
        kind: "playSegment",
        inPts: "300000",
        outPts: "360000",
      });
      // The selection needs no frame on screen, so a pending seek does not stop it.
      expect(
        planShortcutCommand(
          "playSegment",
          withSegments(
            { segments: [segment("a", "300000", "360000")], currentSegmentId: "a" },
            { presentedFrame: null, seekTargetSeconds: 2 },
          ),
        ),
      ).toEqual({ kind: "playSegment", inPts: "300000", outPts: "360000" });
    });

    it("plays the segment that holds the frame on screen when none is selected", () => {
      const segments = [segment("a", "0", "60000"), segment("b", "60000", "120000")];
      // The frame on screen is PTS 90000.
      expect(planShortcutCommand("playSegment", withSegments({ segments }))).toEqual({
        kind: "playSegment",
        inPts: "60000",
        outPts: "120000",
      });
      // Half open: the In belongs to the segment, and the Out does not (ADR 002).
      const atIn = withSegments(
        { segments },
        { presentedFrame: { mediaTime: 0.667, inferredSourcePts: pts("60000") } },
      );
      expect(planShortcutCommand("playSegment", atIn)).toMatchObject({
        inPts: "60000",
      });
      const atOut = withSegments({ segments: [segment("a", "0", "90000")] });
      expect(planShortcutCommand("playSegment", atOut)).toBeNull();
    });

    it("does nothing with no segment there, with overlapping segments there, or with no frame", () => {
      expect(planShortcutCommand("playSegment", withSegments({}))).toBeNull();
      expect(
        planShortcutCommand(
          "playSegment",
          withSegments({ segments: [segment("a", "0", "30000")] }),
        ),
      ).toBeNull();
      // Two segments hold PTS 90000, and ADR 007 refuses a guess between them.
      expect(
        planShortcutCommand(
          "playSegment",
          withSegments({
            segments: [segment("a", "0", "120000"), segment("b", "60000", "180000")],
          }),
        ),
      ).toBeNull();
      // A pending seek clears the frame on screen.
      expect(
        planShortcutCommand(
          "playSegment",
          withSegments(
            { segments: [segment("a", "0", "120000")] },
            { presentedFrame: null, seekTargetSeconds: 1 },
          ),
        ),
      ).toBeNull();
    });

    it("does not use a segment of another source, and does not replace a selection that cannot play", () => {
      // A current segment of another source does not resolve, so the frame on screen decides.
      const foreign = withSegments({
        segments: [
          segment("x", "0", "900000", "source-2"),
          segment("b", "60000", "120000"),
        ],
        currentSegmentId: "x",
      });
      expect(planShortcutCommand("playSegment", foreign)).toMatchObject({
        inPts: "60000",
        outPts: "120000",
      });
      // A selected segment that ends at or before videoStartPts holds no frame.
      const empty = withSegments({
        segments: [segment("a", "-3000", "0"), segment("b", "60000", "120000")],
        currentSegmentId: "a",
      });
      expect(planShortcutCommand("playSegment", empty)).toBeNull();
      // A selected segment after the last frame of the extent (frame 299 of 900000 ticks) has
      // its last frame before the frame of its In, so it does not play either.
      const pastExtent = withSegments({
        segments: [segment("a", "930000", "960000")],
        currentSegmentId: "a",
      });
      expect(planShortcutCommand("playSegment", pastExtent)).toBeNull();
    });

    it("needs a ready calibration", () => {
      const segments = [segment("a", "60000", "120000")];
      for (const calibrationStatus of ["calibrating", "unavailable"] as const) {
        for (const currentSegmentId of [null, "a"]) {
          expect(
            planShortcutCommand(
              "playSegment",
              withSegments(
                { segments, currentSegmentId },
                { calibrationStatus, presentedFrame: null },
              ),
            ),
          ).toBeNull();
        }
      }
    });

    it("pauses on a second press while the segment plays, and plays it again after the stop", () => {
      const segments = [segment("a", "60000", "120000")];
      const playing = withSegments(
        { segments },
        {
          isPlaying: true,
          playbackStop: {
            inPts: pts("60000"),
            outPts: pts("120000"),
            phase: "playing",
          },
        },
      );
      expect(planShortcutCommand("playSegment", playing)).toEqual({ kind: "pause" });

      const stopped = withSegments(
        { segments },
        {
          playbackStop: {
            inPts: pts("60000"),
            outPts: pts("120000"),
            phase: "stopped",
            restPts: pts("117000"),
            windowEndSeconds: 1.4,
          },
        },
      );
      expect(planShortcutCommand("playSegment", stopped)).toEqual({
        kind: "playSegment",
        inPts: "60000",
        outPts: "120000",
      });
    });
  });

  describe("Delete, Escape, undo and redo", () => {
    it("deletes the current segment only", () => {
      expect(planShortcutCommand("deleteSegment", createSnapshot())).toBeNull();
      const current = createSnapshot({
        timeline: { segments: [segment("a", "0", "3000")], currentSegmentId: "a" },
      });
      expect(planShortcutCommand("deleteSegment", current)).toEqual({
        kind: "deleteSegment",
      });
      // A pending In mark is not a segment.
      const pending = createSnapshot({ timeline: { pendingInPts: pts("0") } });
      expect(planShortcutCommand("deleteSegment", pending)).toBeNull();
    });

    it("finishes a current segment or a pending In mark, with the newSegment call", () => {
      expect(planShortcutCommand("finishSegment", createSnapshot())).toBeNull();
      const current = createSnapshot({
        timeline: { segments: [segment("a", "0", "3000")], currentSegmentId: "a" },
      });
      expect(planShortcutCommand("finishSegment", current)).toEqual({
        kind: "finishSegment",
      });
      const pending = createSnapshot({ timeline: { pendingInPts: pts("0") } });
      expect(planShortcutCommand("finishSegment", pending)).toEqual({
        kind: "finishSegment",
      });
    });

    it("cancels a trim with Escape while the drag runs, and never finishes the segment", () => {
      const trimming = createSnapshot({
        timeline: { segments: [segment("a", "0", "3000")], currentSegmentId: "a" },
      });
      expect(
        planShortcutCommand("finishSegment", { ...trimming, isTrimDragging: true }),
      ).toEqual({ kind: "cancelTrim" });
      // The cancel does not need a segment in progress: the key always ends the drag.
      expect(
        planShortcutCommand("finishSegment", {
          ...createSnapshot(),
          isTrimDragging: true,
        }),
      ).toEqual({ kind: "cancelTrim" });
      // With no drag, the key finishes the segment as before.
      expect(
        planShortcutCommand("finishSegment", { ...trimming, isTrimDragging: false }),
      ).toEqual({ kind: "finishSegment" });
      expect(planShortcutCommand("finishSegment", trimming)).toEqual({
        kind: "finishSegment",
      });
    });

    it("takes the edit keys and does nothing while a trim drags", () => {
      // The frame on screen (PTS 90000) lies inside the segment, so each action can act.
      const editable = createSnapshot({
        timeline: {
          segments: [segment("a", "0", "180000")],
          currentSegmentId: "a",
          canUndo: true,
          canRedo: true,
        },
      });
      for (const action of TRIM_LOCKED_ACTIONS) {
        expect(planShortcutCommand(action, editable)).not.toBeNull();
        expect(
          planShortcutCommand(action, { ...editable, isTrimDragging: true }),
        ).toBeNull();
      }
      expect([...TRIM_LOCKED_ACTIONS].sort()).toEqual(
        ["deleteSegment", "markIn", "markOut", "redo", "undo"].sort(),
      );
      // Playback and the steps stay available.
      expect(
        planShortcutCommand("togglePlayback", { ...editable, isTrimDragging: true }),
      ).toEqual({ kind: "togglePlayback" });
    });

    it("gives the trim cancel to no other action", () => {
      const snapshot: ShortcutSnapshot = { ...createSnapshot(), isTrimDragging: true };
      for (const action of SHORTCUT_ACTIONS) {
        if (action === "finishSegment") {
          continue;
        }
        expect(planShortcutCommand(action, snapshot)).not.toEqual({
          kind: "cancelTrim",
        });
      }
    });

    it("undoes and redoes only with a history entry", () => {
      expect(planShortcutCommand("undo", createSnapshot())).toBeNull();
      expect(planShortcutCommand("redo", createSnapshot())).toBeNull();

      const history = createSnapshot({ timeline: { canUndo: true, canRedo: true } });
      expect(planShortcutCommand("undo", history)).toEqual({ kind: "undo" });
      expect(planShortcutCommand("redo", history)).toEqual({ kind: "redo" });
    });

    it("keeps the edit actions that need no frame available during a pending seek", () => {
      const snapshot = createSnapshot({
        playback: { presentedFrame: null },
        timeline: {
          segments: [segment("a", "0", "3000")],
          currentSegmentId: "a",
          canUndo: true,
        },
      });
      expect(planShortcutCommand("deleteSegment", snapshot)).not.toBeNull();
      expect(planShortcutCommand("finishSegment", snapshot)).not.toBeNull();
      expect(planShortcutCommand("undo", snapshot)).not.toBeNull();
    });
  });

  describe("the app commands", () => {
    it("opens media and Settings in every state", () => {
      for (const snapshot of [
        createSnapshot(),
        ...INACTIVE_SNAPSHOTS.map(([, s]) => s),
      ]) {
        expect(planShortcutCommand("openMedia", snapshot)).toEqual({
          kind: "openMedia",
        });
        expect(planShortcutCommand("openSettings", snapshot)).toEqual({
          kind: "openSettings",
        });
      }
    });

    it("exports whenever media is open, as the Export button does", () => {
      expect(planShortcutCommand("export", createSnapshot())).toEqual({
        kind: "export",
      });
      // Open media whose element is not ready still exports: the button reads the media only.
      expect(
        planShortcutCommand("export", createSnapshot({ playback: { isReady: false } })),
      ).toEqual({ kind: "export" });
      expect(planShortcutCommand("export", createSnapshot({ probe: null }))).toBeNull();
    });
  });

  // ADR 026: a seek onto the frame on screen owns the key press and performs nothing. The
  // store would clear presentedFrame, and ADR 022 says that such a seek may bring no frame
  // callback, so the edit actions would stay disabled.
  describe("key sequences on the real stores", () => {
    it("shows why: a seek onto the frame on screen clears the presented frame", () => {
      const h = createStoreHarness();
      expect(h.shownPts()).toBe("0");
      h.playback.getState().seekToPts(pts("0"));
      // No frame callback arrives for the frame already on screen.
      expect(h.playback.getState().presentedFrame).toBeNull();
      expect(planShortcutCommand("markIn", h.snapshot())).toBeNull();
    });

    it("Home, Home, I: the second Home does nothing and I marks the first frame", () => {
      const h = createStoreHarness();
      h.clickRulerAt("25");
      expect(h.shownPts()).toBe("25");

      expect(h.press("goToStart")).toEqual({ kind: "seekToPts", pts: "0" });
      h.presentSeekedFrame();
      expect(h.shownPts()).toBe("0");
      expect(h.playback.getState().seekTargetSeconds).toBeNull();

      const seeks = h.element.currentTimeSets;
      expect(h.press("goToStart")).toBeNull();
      expect(h.element.currentTimeSets).toBe(seeks);
      expect(h.shownPts()).toBe("0");

      expect(h.press("markIn")).toEqual({ kind: "markIn", pts: "0" });
      expect(h.timeline.getState().pendingInPts).toBe("0");
    });

    it("End, End, O: the second End does nothing and O marks an Out at the last frame", () => {
      const h = createStoreHarness();
      h.clickRulerAt("25");
      expect(h.press("markIn")).toEqual({ kind: "markIn", pts: "25" });

      // The extent is 250 frames at 25 fps. End goes to the middle of the last frame, 249, and
      // the playhead shows its start at once.
      expect(h.press("goToEnd")).toEqual({ kind: "seekToFrameIndex", frameIndex: 249 });
      expect(h.element.currentTime).toBeCloseTo(249.5 / 25, 9);
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);
      h.presentSeekedFrame(249 / 25);
      expect(h.shownPts()).toBe("249");
      expect(h.playback.getState().seekTargetSeconds).toBeNull();
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);

      const seeks = h.element.currentTimeSets;
      expect(h.press("goToEnd")).toBeNull();
      expect(h.element.currentTimeSets).toBe(seeks);
      expect(h.shownPts()).toBe("249");

      expect(h.press("markOut")).toEqual({ kind: "markOut", pts: "249" });
      expect(h.timeline.getState().segments).toEqual([
        { id: "segment-1", sourceId: SOURCE_ID, inPts: "25", outPts: "249" },
      ]);
    });

    it("End with an audio lead of 0.5 s lands on the last frame, and the playhead does not jump", () => {
      // The audio starts first, so the first video frame is at 0.5 s on the browser timeline.
      const h = createStoreHarness({ anchored: false, duration: 10.5 });
      h.anchor(0.5);
      expect(h.playback.getState().calibrationStatus).toBe("ready");

      expect(h.press("goToEnd")).toEqual({ kind: "seekToFrameIndex", frameIndex: 249 });
      // The middle of frame 249, counted from the calibrated first frame.
      expect(h.element.currentTime).toBeCloseTo(0.5 + 249.5 / 25, 9);
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);
      h.presentSeekedFrame(0.5 + 249 / 25);
      expect(h.shownPts()).toBe("249");
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);

      const seeks = h.element.currentTimeSets;
      expect(h.press("goToEnd")).toBeNull();
      expect(h.element.currentTimeSets).toBe(seeks);
      expect(h.press("markOut")).toBeNull();
      h.timeline.getState().markIn(pts("25"));
      expect(h.press("markOut")).toEqual({ kind: "markOut", pts: "249" });
    });

    it("End off the grid, on a variable rate with an audio lead: a second End does nothing", () => {
      // 10 s on 1/90000. The rates differ, so End goes to the last tick of the extent, and the
      // browser shows the frame that holds it, which starts before it.
      const h = createStoreHarness({
        anchored: false,
        duration: 10.5,
        media: {
          videoTimeBase: { n: 1, d: 90_000 },
          videoDurationTicks: ticks("900000"),
          avgFrameRate: { n: 2997, d: 100 },
          rFrameRate: { n: 30, d: 1 },
        },
      });
      h.anchor(0.5);

      expect(h.press("goToEnd")).toEqual({
        kind: "seekToPts",
        pts: "899999",
        options: EXTENT_END_SEEK_OPTIONS,
      });
      expect(h.element.currentTime).toBeCloseTo(0.5 + 899_999 / 90_000, 9);
      // The last frame starts at 9.967 s.
      h.presentSeekedFrame(0.5 + 897_030 / 90_000);
      expect(h.shownPts()).toBe("897030");
      // The playhead moved back by less than one frame, and not by the lead.
      expect(h.playheadSeconds()).toBeCloseTo(9.967, 9);

      const seeks = h.element.currentTimeSets;
      expect(h.press("goToEnd")).not.toBeNull();
      expect(h.element.currentTimeSets).toBe(seeks);
      expect(h.shownPts()).toBe("897030");
      expect(h.playback.getState().seekTargetSeconds).toBeNull();

      h.timeline.getState().markIn(pts("90000"));
      expect(h.press("markOut")).toEqual({ kind: "markOut", pts: "897030" });
    });

    it("End off the grid, on a coarse time base: the frame at the last tick stays", () => {
      // 1/24 at 23.976 fps: one tick is almost a whole frame, so the grid is not exact.
      const h = createStoreHarness({
        media: {
          videoTimeBase: { n: 1, d: 24 },
          videoDurationTicks: ticks("240"),
          avgFrameRate: { n: 24000, d: 1001 },
          rFrameRate: { n: 24000, d: 1001 },
        },
      });

      expect(h.press("goToEnd")).toEqual({
        kind: "seekToPts",
        pts: "239",
        options: EXTENT_END_SEEK_OPTIONS,
      });
      h.presentSeekedFrame(239 / 24);
      expect(h.shownPts()).toBe("239");
      expect(h.playheadSeconds()).toBeCloseTo(239 / 24, 9);

      const seeks = h.element.currentTimeSets;
      expect(h.press("goToEnd")).toBeNull();
      expect(h.element.currentTimeSets).toBe(seeks);
    });

    it("End off the grid on an element that ends before the last tick: two Ends make one seek", () => {
      // An MP4 with B-frames and no edit list: the calibrated mapping puts the last tick past
      // the end of the element, and the element stops the seek at its duration.
      const h = createStoreHarness({
        anchored: false,
        duration: 10.45,
        media: {
          videoTimeBase: { n: 1, d: 90_000 },
          videoDurationTicks: ticks("900000"),
          avgFrameRate: { n: 2997, d: 100 },
          rFrameRate: { n: 30, d: 1 },
        },
      });
      h.anchor(0.5);

      expect(h.press("goToEnd")).not.toBeNull();
      expect(h.element.currentTime).toBe(10.45);
      h.presentSeekedFrame(0.5 + 893_700 / 90_000);
      expect(h.shownPts()).toBe("893700");

      const seeks = h.element.currentTimeSets;
      h.press("goToEnd");
      expect(h.element.currentTimeSets).toBe(seeks);
      expect(h.shownPts()).toBe("893700");
    });

    it("End on the grid on an element that ends inside the last frame: two Ends make one seek", () => {
      const h = createStoreHarness({ anchored: false, duration: 10.47 });
      h.anchor(0.5);

      expect(h.press("goToEnd")).toEqual({ kind: "seekToFrameIndex", frameIndex: 249 });
      // The end of the element pulls the target back into the last frame.
      expect(h.element.currentTime).toBe(10.47);
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);
      h.presentSeekedFrame(0.5 + 249 / 25);
      expect(h.shownPts()).toBe("249");

      const seeks = h.element.currentTimeSets;
      expect(h.press("goToEnd")).toBeNull();
      expect(h.element.currentTimeSets).toBe(seeks);
    });

    it("End then → on the grid: the step does nothing, and O marks the last frame", () => {
      const h = createStoreHarness();
      h.clickRulerAt("25");
      h.press("markIn");
      h.press("goToEnd");
      h.presentSeekedFrame(249 / 25);
      expect(h.shownPts()).toBe("249");

      const seeks = h.element.currentTimeSets;
      expect(h.press("stepForwardOneFrame")).toEqual({
        kind: "seekNominal",
        frames: 1,
      });
      expect(h.press("stepForwardTenFrames")).toEqual({
        kind: "seekNominal",
        frames: 10,
      });
      expect(h.element.currentTimeSets).toBe(seeks);
      expect(h.shownPts()).toBe("249");
      expect(h.press("markOut")).toEqual({ kind: "markOut", pts: "249" });
    });

    it("End then → off the grid, with an audio lead: the step does nothing", () => {
      const h = createStoreHarness({
        anchored: false,
        duration: 10.5,
        media: {
          videoTimeBase: { n: 1, d: 90_000 },
          videoDurationTicks: ticks("900000"),
          avgFrameRate: { n: 2997, d: 100 },
          rFrameRate: { n: 30, d: 1 },
        },
      });
      h.anchor(0.5);
      h.press("goToEnd");
      h.presentSeekedFrame(0.5 + 897_030 / 90_000);
      expect(h.shownPts()).toBe("897030");

      const seeks = h.element.currentTimeSets;
      h.press("stepForwardOneFrame");
      expect(h.element.currentTimeSets).toBe(seeks);
      expect(h.shownPts()).toBe("897030");
    });

    it("a last frame shorter than an interval: End goes to it, and → reaches it from the frame before", () => {
      // 25 fps on 1/1000, an extent of 376 ticks: frames 0 to 9, and frame 9 covers only 360 to
      // 376. The element ends with it.
      const h = createStoreHarness({
        duration: 0.376,
        media: {
          videoTimeBase: { n: 1, d: 1000 },
          videoDurationTicks: ticks("376"),
          approximateDurationSeconds: 0.376,
        },
      });

      expect(h.press("goToEnd")).toEqual({ kind: "seekToFrameIndex", frameIndex: 9 });
      expect(h.element.currentTime).toBe(0.376);
      expect(h.playheadSeconds()).toBeCloseTo(0.36, 9);
      h.presentSeekedFrame(0.36);
      expect(h.shownPts()).toBe("360");
      expect(h.press("goToEnd")).toBeNull();

      // → from frame 8 reaches frame 9, and → from frame 9 does nothing.
      h.clickRulerAt("320");
      expect(h.shownPts()).toBe("320");
      h.press("stepForwardOneFrame");
      expect(h.element.currentTime).toBe(0.376);
      expect(h.playheadSeconds()).toBeCloseTo(0.36, 9);
      h.presentSeekedFrame(0.36);
      expect(h.shownPts()).toBe("360");
      const seeks = h.element.currentTimeSets;
      h.press("stepForwardOneFrame");
      expect(h.element.currentTimeSets).toBe(seeks);
      expect(h.shownPts()).toBe("360");
    });

    it("End then → before the anchor stays on the last frame, as End then → after it", () => {
      const h = createStoreHarness({ anchored: false });
      h.press("goToEnd");
      expect(h.press("stepForwardOneFrame")).toEqual({
        kind: "seekNominal",
        frames: 1,
      });
      // The step past the last frame changes nothing: the playhead stays on frame 249.
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);

      h.anchor();
      expect(h.element.currentTimeSets).toBe(1);
      expect(h.element.currentTime).toBeCloseTo(249.5 / 25, 9);
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);
      h.presentSeekedFrame(249 / 25);
      expect(h.shownPts()).toBe("249");
    });

    it("known limit: off the grid, End from inside the last frame seeks onto the frame on screen", () => {
      // The last frame starts at PTS 897030, before the last tick. No frame boundary tells the
      // plan or the store that the element already shows the frame that holds the last tick, so
      // End seeks to that tick. In a real element that seek can bring no frame callback
      // (ADR 022), and Mark Out stays disabled until the next frame arrives. On the frame grid
      // the index of the frame on screen finds the last frame, so this happens off the grid only.
      const h = createStoreHarness({
        media: {
          videoTimeBase: { n: 1, d: 90_000 },
          videoDurationTicks: ticks("900000"),
          avgFrameRate: { n: 2997, d: 100 },
          rFrameRate: { n: 30, d: 1 },
        },
      });
      h.clickRulerAt("897030");
      expect(h.shownPts()).toBe("897030");
      h.timeline.getState().markIn(pts("90000"));
      const seeks = h.element.currentTimeSets;

      expect(h.press("goToEnd")).toEqual({
        kind: "seekToPts",
        pts: "899999",
        options: EXTENT_END_SEEK_OPTIONS,
      });
      expect(h.element.currentTimeSets).toBe(seeks + 1);
      expect(h.playback.getState().presentedFrame).toBeNull();
      expect(h.press("markOut")).toBeNull();
    });

    it("End on a source that cannot calibrate goes to the end of the ruler", () => {
      const h = createStoreHarness({ anchored: false });
      h.failCalibration();
      expect(h.playback.getState().calibrationStatus).toBe("unavailable");

      expect(h.press("goToEnd")).toEqual({ kind: "seekApproximate", seconds: 10 });
      expect(h.element.currentTime).toBe(10);
    });

    it("O then Shift+O: the return does nothing, and Escape then I marks a new In there", () => {
      const h = createStoreHarness();
      expect(h.press("markIn")).toEqual({ kind: "markIn", pts: "0" });
      h.clickRulerAt("50");
      expect(h.press("markOut")).toEqual({ kind: "markOut", pts: "50" });
      expect(h.timeline.getState().segments).toEqual([
        { id: "segment-1", sourceId: SOURCE_ID, inPts: "0", outPts: "50" },
      ]);

      const seeks = h.element.currentTimeSets;
      expect(h.press("goToSegmentOut")).toBeNull();
      expect(h.element.currentTimeSets).toBe(seeks);
      expect(h.shownPts()).toBe("50");

      expect(h.press("finishSegment")).toEqual({ kind: "finishSegment" });
      expect(h.press("markIn")).toEqual({ kind: "markIn", pts: "50" });
      expect(h.timeline.getState().pendingInPts).toBe("50");
    });

    it("I then Shift+I: the return does nothing, and the frame stays markable", () => {
      const h = createStoreHarness();
      h.clickRulerAt("25");
      expect(h.press("markIn")).toEqual({ kind: "markIn", pts: "25" });

      const seeks = h.element.currentTimeSets;
      expect(h.press("goToSegmentIn")).toBeNull();
      expect(h.element.currentTimeSets).toBe(seeks);
      expect(h.shownPts()).toBe("25");
      expect(planShortcutCommand("markIn", h.snapshot())).toEqual({
        kind: "markIn",
        pts: "25",
      });

      // With a current segment: Shift+I from the Out returns to the In, and a second Shift+I
      // there does nothing, while Shift+O still goes back to the Out.
      h.clickRulerAt("75");
      expect(h.press("markOut")).toEqual({ kind: "markOut", pts: "75" });
      expect(h.press("goToSegmentIn")).toEqual({ kind: "seekToPts", pts: "25" });
      h.presentSeekedFrame();
      expect(h.shownPts()).toBe("25");
      expect(h.press("goToSegmentIn")).toBeNull();
      expect(h.shownPts()).toBe("25");
      expect(h.press("goToSegmentOut")).toEqual({ kind: "seekToPts", pts: "75" });
    });

    // ADR 022: while the calibration is open, the store defers each seek until the first frame
    // callback, and the latest request wins.
    it("→ → → Home before the anchor: Home wins, and the first frame stays for Mark In", () => {
      const h = createStoreHarness({ anchored: false });
      expect(h.playback.getState().calibrationStatus).toBe("calibrating");

      for (let press = 0; press < 3; press++) {
        expect(h.press("stepForwardOneFrame")).toEqual({
          kind: "seekNominal",
          frames: 1,
        });
      }
      expect(h.playback.getState().seekTargetSeconds).toBeCloseTo(0.12, 9);
      expect(h.press("goToStart")).toEqual({ kind: "seekToPts", pts: "0" });
      expect(h.playback.getState().seekTargetSeconds).toBe(0);

      h.anchor();
      expect(h.playback.getState().calibrationStatus).toBe("ready");
      // The anchor is the first frame, so the seek to it is dropped and nothing moves
      expect(h.element.currentTimeSets).toBe(0);
      expect(h.shownPts()).toBe("0");
      expect(h.press("markIn")).toEqual({ kind: "markIn", pts: "0" });
    });

    it("→ → → before the anchor: the three steps run as one step of three frames", () => {
      const h = createStoreHarness({ anchored: false });
      for (let press = 0; press < 3; press++) {
        h.press("stepForwardOneFrame");
      }
      h.anchor();
      expect(h.element.currentTimeSets).toBe(1);
      h.presentSeekedFrame(3 / 25);
      expect(h.shownPts()).toBe("3");
    });

    it("End before the anchor goes to the last frame once the anchor arrives", () => {
      const h = createStoreHarness({ anchored: false });
      expect(h.press("goToEnd")).toEqual({ kind: "seekToFrameIndex", frameIndex: 249 });
      expect(h.element.currentTimeSets).toBe(0);
      // The store defers it as the first frame and 249 steps, and shows the last frame at once.
      expect(h.playback.getState().hasDeferredNavigation).toBe(true);
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);

      h.anchor();
      expect(h.element.currentTimeSets).toBe(1);
      expect(h.element.currentTime).toBeCloseTo(249.5 / 25, 9);
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);
      h.presentSeekedFrame(249 / 25);
      expect(h.shownPts()).toBe("249");
    });

    it("End before the anchor with an audio lead: the same last frame, and a second End does nothing", () => {
      const h = createStoreHarness({ anchored: false, duration: 10.5 });
      expect(h.press("goToEnd")).toEqual({ kind: "seekToFrameIndex", frameIndex: 249 });
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);

      // The audio leads, so the first video frame is at 0.5 s on the browser timeline
      h.anchor(0.5);
      expect(h.playback.getState().calibrationStatus).toBe("ready");
      // One seek, to the middle of frame 249 from the calibrated first frame. The playhead does
      // not move when the request runs, nor when the frame arrives.
      expect(h.element.currentTimeSets).toBe(1);
      expect(h.element.currentTime).toBeCloseTo(0.5 + 249.5 / 25, 9);
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);
      h.presentSeekedFrame(0.5 + 249 / 25);
      expect(h.shownPts()).toBe("249");
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);

      const seeks = h.element.currentTimeSets;
      expect(h.press("goToEnd")).toBeNull();
      expect(h.element.currentTimeSets).toBe(seeks);
    });

    it("End before the anchor off the grid goes to the last tick once the anchor arrives", () => {
      const h = createStoreHarness({
        anchored: false,
        duration: 10.5,
        media: { avgFrameRate: { n: 2497, d: 100 } },
      });
      expect(h.press("goToEnd")).toEqual({
        kind: "seekToPts",
        pts: "249",
        options: EXTENT_END_SEEK_OPTIONS,
      });
      expect(h.element.currentTimeSets).toBe(0);
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);

      h.anchor(0.5);
      expect(h.element.currentTimeSets).toBe(1);
      expect(h.element.currentTime).toBeCloseTo(0.5 + 249 / 25, 9);
      h.presentSeekedFrame();
      expect(h.shownPts()).toBe("249");

      const seeks = h.element.currentTimeSets;
      expect(h.press("goToEnd")).toBeNull();
      expect(h.element.currentTimeSets).toBe(seeks);
    });

    it("End before the anchor keeps the approximate clock without the extent in ticks", () => {
      // The end of the ruler is then the approximate duration, and End seeks there on the
      // browser timeline before and after the anchor (keepBrowserTimeline), so a second End
      // finds the element at the end.
      const h = createStoreHarness({
        anchored: false,
        media: { videoDurationTicks: null },
      });
      expect(h.press("goToEnd")).toEqual({ kind: "seekApproximate", seconds: 10 });

      // The audio leads, so the first video frame is at 0.5 s on the browser timeline
      h.anchor(0.5);
      expect(h.playback.getState().calibrationStatus).toBe("ready");
      // The approximate clock of End, as after the anchor: 10 s on the browser timeline
      expect(h.element.currentTimeSets).toBe(1);
      expect(h.element.currentTime).toBeCloseTo(10, 9);
      h.presentSeekedFrame(9.96);
      expect(h.playback.getState().approximateBrowserTimeSeconds).toBe(10);

      const seeks = h.element.currentTimeSets;
      expect(h.press("goToEnd")).toBeNull();
      expect(h.element.currentTimeSets).toBe(seeks);
    });

    it("End before the anchor runs on the approximate clock when the calibration fails", () => {
      const h = createStoreHarness({ anchored: false });
      expect(h.press("goToEnd")).toEqual({ kind: "seekToFrameIndex", frameIndex: 249 });

      h.failCalibration();
      // The first frame and 249 steps, from the start of the browser timeline.
      expect(h.element.currentTimeSets).toBe(1);
      expect(h.element.currentTime).toBeCloseTo(249 / 25, 9);
      expect(h.playheadSeconds()).toBeCloseTo(249 / 25, 9);
    });

    it("Shift+I and Shift+O before the anchor go to the mark once the anchor arrives", () => {
      const h = createStoreHarness({ anchored: false });
      h.timeline.getState().markIn(pts("25"));
      h.timeline.getState().markOut(pts("75"));

      expect(h.press("goToSegmentOut")).toEqual({ kind: "seekToPts", pts: "75" });
      expect(h.press("goToSegmentIn")).toEqual({ kind: "seekToPts", pts: "25" });
      expect(h.element.currentTimeSets).toBe(0);
      expect(h.playback.getState().seekTargetSeconds).toBeCloseTo(1, 9);

      h.anchor();
      expect(h.element.currentTimeSets).toBe(1);
      expect(h.element.currentTime).toBeCloseTo(1, 9);
      h.presentSeekedFrame();
      expect(h.shownPts()).toBe("25");
    });

    describe("Play Segment", () => {
      /**
       * The playback reaches frame k: the browser presents it. On the harness source PTS k is
       * frame k, at k / 25 s. The element position stays where the seek to the In left it, inside
       * the segment.
       */
      const playTo = (
        h: ReturnType<typeof createStoreHarness>,
        from: number,
        to: number,
      ) => {
        for (let k = from; k <= to; k++) {
          h.anchor(k / 25);
        }
      };

      /** A harness with one segment [50, 100), selected. */
      function withSegment() {
        const h = createStoreHarness();
        h.timeline.getState().markIn(pts("50"));
        h.timeline.getState().markOut(pts("100"));
        expect(h.timeline.getState().currentSegmentId).toBe("segment-1");
        return h;
      }

      it("/ plays the selected segment and stops on its last frame, and / plays it again", () => {
        const h = withSegment();
        expect(h.press("playSegment")).toEqual({
          kind: "playSegment",
          inPts: "50",
          outPts: "100",
        });
        expect(h.element.currentTime).toBe(2);
        expect(h.playback.getState().isPlaying).toBe(true);
        h.presentSeekedFrame();
        playTo(h, 51, 99);
        expect(h.playback.getState().isPlaying).toBe(false);
        expect(h.shownPts()).toBe("99");
        expect(h.playheadSeconds()).toBeCloseTo(99 / 25, 9);
        expect(h.element.currentTimeSets).toBe(1);
        // The last frame stays markable.
        expect(planShortcutCommand("markOut", h.snapshot())).toEqual({
          kind: "markOut",
          pts: "99",
        });

        expect(h.press("playSegment")).toMatchObject({ kind: "playSegment" });
        expect(h.element.currentTimeSets).toBe(2);
        expect(h.element.currentTime).toBe(2);
        expect(h.playback.getState().playbackStop?.phase).toBe("playing");
      });

      it("/ / pauses the playback, and the stop point goes", () => {
        const h = withSegment();
        h.press("playSegment");
        h.presentSeekedFrame();
        playTo(h, 51, 70);
        expect(h.press("playSegment")).toEqual({ kind: "pause" });
        expect(h.playback.getState().isPlaying).toBe(false);
        expect(h.playback.getState().playbackStop).toBeNull();
      });

      it("/ then Space pauses, and a later Space plays past the Out", () => {
        const h = withSegment();
        h.press("playSegment");
        h.presentSeekedFrame();
        playTo(h, 51, 70);
        h.playback.getState().togglePlayback();
        expect(h.playback.getState().playbackStop).toBeNull();
        h.playback.getState().togglePlayback();
        playTo(h, 71, 110);
        expect(h.playback.getState().isPlaying).toBe(true);
        expect(h.shownPts()).toBe("110");
      });

      it("/ then → steps, and the step clears the stop", () => {
        const h = withSegment();
        h.press("playSegment");
        h.presentSeekedFrame();
        playTo(h, 51, 70);
        expect(h.press("stepForwardOneFrame")).toEqual({
          kind: "seekNominal",
          frames: 1,
        });
        expect(h.playback.getState().playbackStop).toBeNull();
        expect(h.playback.getState().isPlaying).toBe(false);
      });

      it("/ then a click on the ruler seeks, and the seek clears the stop", () => {
        const h = withSegment();
        h.press("playSegment");
        h.presentSeekedFrame();
        playTo(h, 51, 70);
        h.clickRulerAt("200");
        expect(h.playback.getState().playbackStop).toBeNull();
        expect(h.shownPts()).toBe("200");
      });

      it("/ with no selection plays the segment under the frame on screen, and does nothing outside one", () => {
        const h = withSegment();
        h.press("finishSegment");
        expect(h.timeline.getState().currentSegmentId).toBeNull();
        h.clickRulerAt("200");
        expect(h.press("playSegment")).toBeNull();
        expect(h.playback.getState().isPlaying).toBe(false);

        h.clickRulerAt("75");
        expect(h.press("playSegment")).toEqual({
          kind: "playSegment",
          inPts: "50",
          outPts: "100",
        });
        h.presentSeekedFrame();
        playTo(h, 51, 99);
        expect(h.shownPts()).toBe("99");
        expect(h.playback.getState().isPlaying).toBe(false);
      });

      it("/ before the anchor does nothing, and plays once the anchor arrives", () => {
        const h = createStoreHarness({ anchored: false });
        h.timeline.getState().markIn(pts("50"));
        h.timeline.getState().markOut(pts("100"));
        expect(h.press("playSegment")).toBeNull();
        expect(h.element.currentTimeSets).toBe(0);
        expect(h.playback.getState().playbackStop).toBeNull();

        h.anchor();
        expect(h.press("playSegment")).toMatchObject({ kind: "playSegment" });
        expect(h.element.currentTimeSets).toBe(1);
      });
    });
  });
});
