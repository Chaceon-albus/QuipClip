import { describe, expect, it } from "vitest";
import { getSourceRevisionKey } from "@/features/media";
import {
  createPlaybackStore,
  type PlaybackMediaElement,
  type PlaybackSource,
} from "@/features/playback";
import { createTimelineStore, createTimelineViewportStore } from "@/features/timeline";
import type { Pts, Segment, TickCount } from "@/types/project";
import { SHORTCUT_ACTIONS, type ShortcutAction } from "./shortcutBindings";
import {
  APPROXIMATE_SHORTCUT_SEEK_OPTIONS,
  LARGE_FRAME_STEP,
  planShortcutCommand,
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

/** A media element that records each seek and reports `seeking` until the test settles it. */
interface FakeElement extends PlaybackMediaElement {
  seeking: boolean;
  readonly currentTimeSets: number;
}

function createFakeElement(): FakeElement {
  let time = 0;
  let sets = 0;
  const element: FakeElement = {
    seeking: false,
    readyState: 1,
    duration: 10,
    get currentTime() {
      return time;
    },
    set currentTime(value: number) {
      time = value;
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
 * the calibration is still open. `anchor` then presents the first frame.
 */
function createStoreHarness({ anchored = true }: { anchored?: boolean } = {}) {
  const source: PlaybackSource = {
    path: "/media/clip.mp4",
    size: 1024,
    mtime: 1_724_976_000,
    videoTimeBase: { n: 1, d: 25 },
    videoStartPts: pts("0"),
    videoDurationTicks: ticks("250"),
    approximateDurationSeconds: 10,
    avgFrameRate: { n: 25, d: 1 },
    rFrameRate: { n: 25, d: 1 },
  };
  const probe: ShortcutProbe = {
    videoStartPts: pts("0"),
    videoTimeBase: { n: 1, d: 25 },
    videoDurationTicks: ticks("250"),
    approximateDurationSeconds: 10,
    avgFrameRate: { n: 25, d: 1 },
    rFrameRate: { n: 25, d: 1 },
  };
  const key = getSourceRevisionKey(source);
  const playback = createPlaybackStore();
  let nextId = 0;
  const timeline = createTimelineStore({ generateId: () => `segment-${++nextId}` });
  const element = createFakeElement();
  let presentedFrames = 0;

  playback.getState().attach(source, element);
  playback.getState().syncReady(key, element);
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
      case "seekToPts":
        playback.getState().seekToPts(command.pts);
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
      // precise editing (ADR 022). Home goes to videoStartPts, as on a calibrated source, and
      // End goes to the end of the ruler.
      const calibrating = createSnapshot({
        playback: { calibrationStatus: "calibrating", presentedFrame: null },
      });
      expect(planShortcutCommand("goToStart", calibrating)).toEqual({
        kind: "seekToPts",
        pts: "0",
      });
      expect(planShortcutCommand("goToEnd", calibrating)).toEqual({
        kind: "seekApproximate",
        seconds: 10,
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

    it("goes to the end of the ruler on the approximate clock, calibrated or not", () => {
      // The extent comes from videoDurationTicks first: 900000 ticks at 1/90000 is 10 s.
      expect(planShortcutCommand("goToEnd", createSnapshot())).toEqual({
        kind: "seekApproximate",
        seconds: 10,
      });
      const uncalibrated = createSnapshot({
        playback: { calibrationStatus: "unavailable", presentedFrame: null },
      });
      expect(planShortcutCommand("goToEnd", uncalibrated)).toEqual({
        kind: "seekApproximate",
        seconds: 10,
      });
    });

    it("takes the end from the same extent rule as the ruler (ADR 007)", () => {
      const noTicks = createSnapshot({
        probe: createProbe({ videoDurationTicks: null }),
      });
      expect(planShortcutCommand("goToEnd", noTicks)).toEqual({
        kind: "seekApproximate",
        seconds: 10.01,
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

    // The end of the ruler is 10 s at 30 fps. The last frame (PTS 897000) starts one interval
    // before it, so End compares the position of the element, not the presented frame.
    const LAST_FRAME = { mediaTime: 299 / 30, inferredSourcePts: pts("897000") };
    const END_SEEK: ShortcutCommand = { kind: "seekApproximate", seconds: 10 };
    const atEndSnapshot = (
      playback: Partial<ShortcutSnapshot["playback"]> = {},
      probe: ShortcutProbe = createProbe(),
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
      const noRate = createProbe({ avgFrameRate: null, rFrameRate: null });
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

      // The end of the ruler is 250 frames at 25 fps. The element stands at 10 s, and the
      // browser presents the last frame, which starts one interval earlier.
      expect(h.press("goToEnd")).toEqual({ kind: "seekApproximate", seconds: 10 });
      h.presentSeekedFrame(249 / 25);
      expect(h.shownPts()).toBe("249");
      expect(h.playback.getState().approximateBrowserTimeSeconds).toBe(10);
      expect(h.playback.getState().seekTargetSeconds).toBeNull();

      const seeks = h.element.currentTimeSets;
      expect(h.press("goToEnd")).toBeNull();
      expect(h.element.currentTimeSets).toBe(seeks);
      expect(h.shownPts()).toBe("249");

      expect(h.press("markOut")).toEqual({ kind: "markOut", pts: "249" });
      expect(h.timeline.getState().segments).toEqual([
        { id: "segment-1", sourceId: SOURCE_ID, inPts: "25", outPts: "249" },
      ]);
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
      expect(h.press("goToEnd")).toEqual({ kind: "seekApproximate", seconds: 10 });
      expect(h.element.currentTimeSets).toBe(0);
      expect(h.playback.getState().seekTargetSeconds).toBe(10);

      h.anchor();
      expect(h.element.currentTimeSets).toBe(1);
      expect(h.element.currentTime).toBeCloseTo(10, 9);
      h.presentSeekedFrame(249 / 25);
      expect(h.shownPts()).toBe("249");
    });

    it("End before the anchor goes where End goes after it, so a second End does nothing", () => {
      const h = createStoreHarness({ anchored: false });
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
  });
});
