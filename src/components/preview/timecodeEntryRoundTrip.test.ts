/**
 * A typed timecode round-trips: typing the value that the preview shows for a frame seeks to
 * that frame, and the preview then shows the same value (ADR 022, ADR 028). The test runs the
 * whole path of the field: `resolveTimecodeEntry`, the store call, the seek of a simulated
 * element, the frame callback, and the value the preview formats (`formatPreviewCurrentTime`).
 */

import { describe, expect, it } from "vitest";
import type { ShortcutProbe } from "@/components/layout/shortcutCommands";
import { getSourceRevisionKey } from "@/features/media";
import {
  createPlaybackStore,
  resolveTimecodeDisplay,
  type PlaybackMediaElement,
  type PlaybackSource,
  type PlaybackStore,
} from "@/features/playback";
import type { TimecodeDisplay, TimecodeFormat } from "@/lib/timecode";
import type { Pts, Rational, TickCount } from "@/types/project";
import { formatPreviewCurrentTime } from "./previewFrame";
import { resolveTimecodeEntry, runTimecodeEntryCommand } from "./timecodeEntrySeek";

/** A media element whose seek completes when the test says so. */
interface FakeVideo extends PlaybackMediaElement {
  currentTime: number;
  seeking: boolean;
  readyState: number;
  seeks: number;
}

function createFakeVideo(): FakeVideo {
  let time = 0;
  const video: FakeVideo = {
    seeking: false,
    readyState: 0,
    seeks: 0,
    duration: Number.NaN,
    get currentTime() {
      return time;
    },
    set currentTime(value: number) {
      time = value;
      video.seeking = true;
      video.seeks++;
    },
    play: () => Promise.resolve(),
    pause: () => undefined,
  };
  return video;
}

/**
 * A source with the PTS of each frame rounded to the nearest tick, as a muxer rescales it. Frame
 * i is nominal frame `firstFrame + i`. The browser presents the first frame at its PTS, and the
 * browser time of a later frame is the time that ptsToMediaTime gives from that anchor.
 */
interface SimulatedSource {
  readonly source: PlaybackSource;
  readonly probe: ShortcutProbe;
  readonly identity: string;
  readonly ptsTicks: readonly number[];
  readonly startSeconds: readonly number[];
}

function simulateSource(
  fps: Rational,
  timeBase: Rational,
  frameCount: number,
  firstFrame: number,
): SimulatedSource {
  const ptsTicks: number[] = [];
  // One more PTS than frames: the end of the last frame.
  for (let i = 0; i <= frameCount; i++) {
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
  const probe: ShortcutProbe = {
    videoTimeBase: timeBase,
    videoStartPts: String(ptsTicks[0]) as Pts,
    videoDurationTicks: String(ptsTicks[frameCount] - ptsTicks[0]) as TickCount,
    approximateDurationSeconds: (frameCount * fps.d) / fps.n,
    avgFrameRate: fps,
    rFrameRate: fps,
  };
  const source: PlaybackSource = {
    path: `/media/round-trip-${fps.n}-${fps.d}-${timeBase.n}-${timeBase.d}-${firstFrame}.mkv`,
    size: 4096,
    mtime: 1724977000,
    ...probe,
  };
  return {
    source,
    probe,
    identity: getSourceRevisionKey(source),
    ptsTicks: ptsTicks.slice(0, frameCount),
    startSeconds: startSeconds.slice(0, frameCount),
  };
}

/** The frame the element presents for a position: the one with the latest start at or before it. */
function presentedIndex(startSeconds: readonly number[], position: number): number {
  let low = 0;
  let high = startSeconds.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (startSeconds[middle] <= position) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** Completes the running seek, and the element presents the frame at its position. */
function settle(store: PlaybackStore, sim: SimulatedSource, video: FakeVideo): number {
  video.seeking = false;
  store.getState().syncSeeked(sim.identity, video);
  const index = presentedIndex(sim.startSeconds, video.currentTime);
  store
    .getState()
    .syncPresentedFrame(sim.identity, sim.startSeconds[index], index + 2, video);
  return index;
}

/** The value that the preview timecode shows now. */
function shownValue(
  store: PlaybackStore,
  sim: SimulatedSource,
  display: TimecodeDisplay,
) {
  const state = store.getState();
  return formatPreviewCurrentTime(
    state.presentedFrame,
    state.calibrationStatus,
    sim.probe.videoStartPts,
    sim.probe.videoTimeBase,
    state.approximateBrowserTimeSeconds ?? 0,
    state.seekTargetSeconds,
    display,
  );
}

/** Types a value in the field and presses Enter. Returns false when nothing was to be done. */
function typeValue(
  store: PlaybackStore,
  sim: SimulatedSource,
  display: TimecodeDisplay,
  text: string,
): boolean {
  const outcome = resolveTimecodeEntry(text, {
    probe: sim.probe,
    playback: store.getState(),
    display,
  });
  expect(outcome.kind, text).toBe("run");
  if (outcome.kind !== "run" || outcome.command === null) {
    return false;
  }
  runTimecodeEntryCommand(outcome.command, store.getState());
  return true;
}

function attachCalibrated(
  store: PlaybackStore,
  sim: SimulatedSource,
  video: FakeVideo,
) {
  store.getState().attach(sim.source, video);
  video.readyState = 1;
  store.getState().syncReady(sim.identity, video);
  store.getState().syncPresentedFrame(sim.identity, sim.startSeconds[0], 1, video);
  expect(store.getState().calibrationStatus).toBe("ready");
}

/** Goes to the start of frame k, as Go to In does, and settles there. */
function goToFrame(
  store: PlaybackStore,
  sim: SimulatedSource,
  video: FakeVideo,
  k: number,
) {
  store.getState().seekToPts(String(sim.ptsTicks[k]) as Pts);
  expect(settle(store, sim, video)).toBe(k);
}

const fps24: Rational = { n: 24, d: 1 };
const fps25: Rational = { n: 25, d: 1 };
const fps30: Rational = { n: 30, d: 1 };
const fps50: Rational = { n: 50, d: 1 };
const fps60: Rational = { n: 60, d: 1 };
const fps23976: Rational = { n: 24000, d: 1001 };
const fps2997: Rational = { n: 30000, d: 1001 };
const fps5994: Rational = { n: 60000, d: 1001 };

const ms: Rational = { n: 1, d: 1000 };
const tb90k: Rational = { n: 1, d: 90000 };

/**
 * Sources on an exact frame grid (ADR 022): the coarse Matroska millisecond, the 1/90000 of
 * MPEG-TS, the rate's own time base, and a first frame after frame 0 with a rounded first PTS.
 */
const gridCases: {
  label: string;
  fps: Rational;
  timeBase: Rational;
  firstFrame: number;
}[] = [
  { label: "24 fps, 1/1000", fps: fps24, timeBase: ms, firstFrame: 0 },
  { label: "25 fps, 1/1000", fps: fps25, timeBase: ms, firstFrame: 0 },
  { label: "30 fps, 1/1000", fps: fps30, timeBase: ms, firstFrame: 1 },
  { label: "50 fps, 1/90000", fps: fps50, timeBase: tb90k, firstFrame: 0 },
  { label: "60 fps, 1/1000", fps: fps60, timeBase: ms, firstFrame: 0 },
  // Above 100 fps FF has three digits.
  { label: "120 fps, 1/1000", fps: { n: 120, d: 1 }, timeBase: ms, firstFrame: 1 },
  { label: "25 fps, 1/25", fps: fps25, timeBase: { n: 1, d: 25 }, firstFrame: 0 },
  { label: "25 fps, 1/12800", fps: fps25, timeBase: { n: 1, d: 12800 }, firstFrame: 0 },
  { label: "23.976 fps, 1/1000", fps: fps23976, timeBase: ms, firstFrame: 1 },
  {
    label: "23.976 fps, 1/24000",
    fps: fps23976,
    timeBase: { n: 1, d: 24000 },
    firstFrame: 0,
  },
  { label: "29.97 fps, 1/1000", fps: fps2997, timeBase: ms, firstFrame: 2 },
  {
    label: "29.97 fps, 1/30000",
    fps: fps2997,
    timeBase: { n: 1, d: 30000 },
    firstFrame: 0,
  },
  { label: "29.97 fps, 1/90000", fps: fps2997, timeBase: tb90k, firstFrame: 0 },
  { label: "59.94 fps, 1/1000", fps: fps5994, timeBase: ms, firstFrame: 1 },
  {
    label: "59.94 fps, 1/60000",
    fps: fps5994,
    timeBase: { n: 1, d: 60000 },
    firstFrame: 0,
  },
];

/** Time bases on which one tick is about half a frame or more, so the grid is not exact. */
const coarseCases: typeof gridCases = [
  {
    label: "23.976 fps, 1/24",
    fps: fps23976,
    timeBase: { n: 1, d: 24 },
    firstFrame: 0,
  },
  { label: "59.94 fps, 1/60", fps: fps5994, timeBase: { n: 1, d: 60 }, firstFrame: 0 },
];

const SIMULATED_SECONDS = 4;
const COARSE_SIMULATED_SECONDS = 12;
const FORMATS: readonly TimecodeFormat[] = ["frames", "milliseconds"];

describe("typed timecode round trip", () => {
  for (const format of FORMATS) {
    it.each(gridCases)(
      `${format}: $label: the value of every frame, typed back, shows that frame and that value`,
      ({ fps, timeBase, firstFrame }) => {
        const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
        const sim = simulateSource(fps, timeBase, frameCount, firstFrame);
        const display = resolveTimecodeDisplay(format, sim.source);
        expect(display.format).toBe(format);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachCalibrated(store, sim, video);

        for (let k = 0; k < frameCount; k++) {
          goToFrame(store, sim, video, k);
          const value = shownValue(store, sim, display);

          // Typed on the frame itself, the value changes nothing (ADR 022, ADR 026).
          const seeksOnFrame = video.seeks;
          expect(typeValue(store, sim, display, value)).toBe(false);
          expect(video.seeks).toBe(seeksOnFrame);

          // Typed from a frame far away, the value goes to the frame.
          goToFrame(store, sim, video, (k + Math.floor(frameCount / 2)) % frameCount);
          expect(typeValue(store, sim, display, value)).toBe(true);
          expect(shownValue(store, sim, display), value).toBe(value);
          expect(settle(store, sim, video), value).toBe(k);
          expect(shownValue(store, sim, display), value).toBe(value);
        }
      },
    );

    it.each(coarseCases)(
      `${format}: $label: a typed value shows the same value, and the frame when the value is its own`,
      ({ fps, timeBase, firstFrame }) => {
        // Long enough for the first repeated value, at frame 250 on these time bases.
        const frameCount = Math.floor((COARSE_SIMULATED_SECONDS * fps.n) / fps.d);
        const sim = simulateSource(fps, timeBase, frameCount, firstFrame);
        const display = resolveTimecodeDisplay(format, sim.source);
        const store = createPlaybackStore();
        const video = createFakeVideo();
        attachCalibrated(store, sim, video);

        // On such a time base the frame display can name two frames with one value and skip
        // the next value (ADR 022, ADR 028). The value of each frame, first.
        const values: string[] = [];
        for (let k = 0; k < frameCount; k++) {
          goToFrame(store, sim, video, k);
          values.push(shownValue(store, sim, display));
        }
        if (format === "frames") {
          // The control: this time base does repeat a frame value.
          expect(new Set(values).size).toBeLessThan(values.length);
        }

        for (let k = 0; k < frameCount; k++) {
          const value = values[k];
          goToFrame(store, sim, video, (k + Math.floor(frameCount / 2)) % frameCount);
          expect(typeValue(store, sim, display, value)).toBe(true);
          const index = settle(store, sim, video);
          expect(shownValue(store, sim, display), value).toBe(value);
          // A value that one frame alone shows goes to that frame. A repeated value goes to the
          // last frame that shows it.
          expect(index, value).toBe(values.lastIndexOf(value));
        }
      },
    );
  }

  it.each(gridCases)(
    "frames: $label: while the calibration is open, a typed value runs at the anchor and shows that frame",
    ({ fps, timeBase, firstFrame }) => {
      const frameCount = Math.floor((SIMULATED_SECONDS * fps.n) / fps.d);
      const sim = simulateSource(fps, timeBase, frameCount, firstFrame);
      const display = resolveTimecodeDisplay("frames", sim.source);
      const reference = createPlaybackStore();
      const referenceVideo = createFakeVideo();
      attachCalibrated(reference, sim, referenceVideo);

      for (let k = 1; k < frameCount; k += 7) {
        goToFrame(reference, sim, referenceVideo, k);
        const value = shownValue(reference, sim, display);

        const store = createPlaybackStore();
        const video = createFakeVideo();
        store.getState().attach(sim.source, video);
        video.readyState = 1;
        store.getState().syncReady(sim.identity, video);
        expect(typeValue(store, sim, display, value)).toBe(true);
        expect(video.seeks).toBe(0);
        expect(shownValue(store, sim, display), value).toBe(value);

        store
          .getState()
          .syncPresentedFrame(sim.identity, sim.startSeconds[0], 1, video);
        expect(video.seeks).toBe(1);
        expect(settle(store, sim, video), value).toBe(k);
        expect(shownValue(store, sim, display), value).toBe(value);
      }
    },
  );
});
