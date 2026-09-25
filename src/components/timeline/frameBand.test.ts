import { describe, expect, it } from "vitest";
import { getSourceRevisionKey } from "@/features/media";
import {
  createPlaybackStore,
  getDisplayedElapsedSeconds,
  type PlaybackMediaElement,
  type PlaybackSource,
} from "@/features/playback";
import {
  FRAME_BAND_MIN_WIDTH_PX,
  TIMELINE_GUTTER_WIDTH_PX,
  calculateContentWidthPx,
  calculateMaxZoom,
  calculatePlayheadLayout,
  calculateSegmentLayout,
} from "@/features/timeline";
import {
  formatFrameTimecode,
  formatSourceRelativeTime,
  type TimecodeDisplay,
} from "@/lib/timecode";
import type { Pts, Rational, Segment, TickCount } from "@/types/project";
import {
  calculateFrameWidthPx,
  calculateOutFrameBand,
  calculatePlayheadFrameBand,
  resolveDisplayedFrameIndex,
  resolveFrameBandRate,
  type FrameBandPlayback,
} from "./frameBand";

const pts = (value: string) => value as Pts;

const fps25: Rational = { n: 25, d: 1 };
const fps24: Rational = { n: 24, d: 1 };
const fps2997: Rational = { n: 30000, d: 1001 };
const tb90k: Rational = { n: 1, d: 90000 };
// Matroska stores each PTS rounded to the millisecond.
const tbMs: Rational = { n: 1, d: 1000 };

const ready = (
  presented: string | null,
  seekTargetSeconds: number | null = null,
): FrameBandPlayback => ({
  calibrationStatus: "ready",
  seekTargetSeconds,
  presentedFrame:
    presented === null ? null : { mediaTime: 0, inferredSourcePts: pts(presented) },
});

describe("resolveFrameBandRate: the width threshold", () => {
  it("measures one nominal frame on screen", () => {
    // 200 px/s: 8.33 px per frame at 24 fps, 8 px at 25 fps and 6.67 px at 29.97 fps.
    expect(calculateFrameWidthPx(fps24, 10, 2000)).toBeCloseTo(8.333, 3);
    expect(calculateFrameWidthPx(fps25, 10, 2000)).toBe(8);
    expect(calculateFrameWidthPx(fps2997, 10, 2000)).toBeCloseTo(6.673, 3);
  });

  it("shows the bands from FRAME_BAND_MIN_WIDTH_PX", () => {
    expect(FRAME_BAND_MIN_WIDTH_PX).toBe(8);
    expect(resolveFrameBandRate(fps24, 10, 2000)).toBe(fps24);
    expect(resolveFrameBandRate(fps25, 10, 2000)).toBe(fps25);
    // A rounding error just below 8 px still counts as 8 px.
    expect(resolveFrameBandRate(fps25, 10, 2000 * (1 - 1e-12))).toBe(fps25);
    expect(resolveFrameBandRate(fps25, 10, 1990)).toBeNull();
    expect(resolveFrameBandRate(fps2997, 10, 2000)).toBeNull();
    expect(resolveFrameBandRate(fps2997, 10, 2400)).toBe(fps2997);
  });

  it.each([
    { name: "24 fps", rate: { n: 24, d: 1 } },
    { name: "25 fps", rate: { n: 25, d: 1 } },
    { name: "29.97 fps", rate: { n: 30000, d: 1001 } },
    { name: "60 fps", rate: { n: 60, d: 1 } },
    { name: "120 fps", rate: { n: 120, d: 1 } },
  ])("shows the bands at the zoom ceiling of a $name source", ({ rate }) => {
    // The lane width of the panel at the largest zoom of a 30 s source at 1024 and 1440 px.
    for (const viewportWidthPx of [1024, 1440]) {
      const zoom = calculateMaxZoom(30, viewportWidthPx, rate);
      const laneWidthPx =
        calculateContentWidthPx(zoom, viewportWidthPx) - TIMELINE_GUTTER_WIDTH_PX;
      expect(resolveFrameBandRate(rate, 30, laneWidthPx)).toBe(rate);
    }
  });

  it("shows no band off the exact grid", () => {
    // The panel gives no grid rate for a variable rate, a coarse time base, or a calibration
    // that is not ready (`resolveTrimGridRate` and `canUsePreciseSeek`).
    expect(resolveFrameBandRate(null, 10, 1_000_000)).toBeNull();
  });

  it("shows no band without a usable extent or lane", () => {
    expect(resolveFrameBandRate(fps25, null, 2000)).toBeNull();
    expect(resolveFrameBandRate(fps25, 0, 2000)).toBeNull();
    expect(resolveFrameBandRate(fps25, Number.NaN, 2000)).toBeNull();
    expect(resolveFrameBandRate(fps25, 10, 0)).toBeNull();
    expect(resolveFrameBandRate({ n: 0, d: 1 }, 10, 2000)).toBeNull();
  });
});

describe("resolveDisplayedFrameIndex: the frame that the timecode names", () => {
  it("names the frame of a pending seek target, with the margin of ADR 028", () => {
    // Frame 04 of second 1 at 25 fps starts at 1.16 s, and the nearest double lies below it.
    expect(resolveDisplayedFrameIndex(ready(null, 1.16), pts("0"), tb90k, fps25)).toBe(
      29n,
    );
    // A scrub target in the middle of a frame names that frame. A frame step shows the nominal
    // start of its frame (ADR 022), which the test with a real store below covers.
    expect(resolveDisplayedFrameIndex(ready(null, 1.18), pts("0"), tb90k, fps25)).toBe(
      29n,
    );
    // The target wins over the presented frame.
    expect(
      resolveDisplayedFrameIndex(ready("900000", 1.18), pts("0"), tb90k, fps25),
    ).toBe(29n);
  });

  it("names the presented frame by its exact tick delta", () => {
    // 29.97 fps on a millisecond time base: frame 1 starts at 33.37 ms, and its PTS is 33.
    expect(resolveDisplayedFrameIndex(ready("33"), pts("0"), tbMs, fps2997)).toBe(1n);
    // Frame 30 starts at 1001 ms.
    expect(resolveDisplayedFrameIndex(ready("1001"), pts("0"), tbMs, fps2997)).toBe(
      30n,
    );
    // The delta counts from the start PTS, which can be negative.
    expect(
      resolveDisplayedFrameIndex(ready("89091"), pts("-1001"), tb90k, fps2997),
    ).toBe(30n);
  });

  it("agrees with the preview timecode at every presented frame", () => {
    const display: TimecodeDisplay = {
      format: "frames",
      rate: fps2997,
      videoTimeBase: tbMs,
    };
    for (let frame = 0; frame < 200; frame += 1) {
      // The PTS of frame `frame` rounded to the millisecond, as Matroska writes it.
      const ms = Math.round((frame * 1001) / 30);
      const index = resolveDisplayedFrameIndex(
        ready(String(ms)),
        pts("0"),
        tbMs,
        fps2997,
      );
      expect(index).toBe(BigInt(frame));
      // The middle of that nominal frame shows the same timecode as the presented frame.
      const middle = ((frame + 0.5) * 1001) / 30000;
      expect(formatFrameTimecode(middle, fps2997, tbMs)).toBe(
        formatSourceRelativeTime(pts(String(ms)), pts("0"), tbMs, display),
      );
    }
  });

  it("names no frame without a ready calibration or before the first frame", () => {
    expect(
      resolveDisplayedFrameIndex(
        { ...ready("1000"), calibrationStatus: "calibrating" },
        pts("0"),
        tbMs,
        fps2997,
      ),
    ).toBeNull();
    expect(
      resolveDisplayedFrameIndex(
        { ...ready(null, 1.0), calibrationStatus: "unavailable" },
        pts("0"),
        tbMs,
        fps2997,
      ),
    ).toBeNull();
    expect(resolveDisplayedFrameIndex(ready("-5"), pts("0"), tbMs, fps2997)).toBeNull();
    expect(resolveDisplayedFrameIndex(ready(null), pts("0"), tbMs, fps2997)).toBeNull();
    expect(resolveDisplayedFrameIndex(ready("100"), null, tbMs, fps2997)).toBeNull();
    // A negative target is not a display target, so the presented frame applies.
    expect(resolveDisplayedFrameIndex(ready("1001", -1), pts("0"), tbMs, fps2997)).toBe(
      30n,
    );
  });
});

describe("calculatePlayheadFrameBand", () => {
  it("starts at the playhead of each frame step of a real playback store", () => {
    // 29.97 fps on a millisecond time base, as Matroska writes it: the grid is exact, and each
    // frame PTS lies up to half a tick from its nominal start.
    const source: PlaybackSource = {
      path: "/media/band.mkv",
      size: 1,
      mtime: 1,
      videoTimeBase: tbMs,
      videoStartPts: pts("0"),
      videoDurationTicks: "10010" as TickCount,
      approximateDurationSeconds: 10.01,
      avgFrameRate: fps2997,
      rFrameRate: fps2997,
    };
    const total = 10.01;
    const key = getSourceRevisionKey(source);
    const element: PlaybackMediaElement = {
      currentTime: 0,
      seeking: false,
      readyState: 1,
      duration: total,
      play: () => Promise.resolve(),
      pause: () => {},
    };
    const store = createPlaybackStore();
    store.getState().attach(source, element);
    store.getState().syncReady(key, element);
    store.getState().syncPresentedFrame(key, 0, 1, element);
    expect(store.getState().calibrationStatus).toBe("ready");

    const bandAndPlayhead = () => {
      const state = store.getState();
      const band = calculatePlayheadFrameBand(state, pts("0"), tbMs, fps2997, total);
      const playhead = calculatePlayheadLayout(
        getDisplayedElapsedSeconds(state, pts("0"), tbMs),
        total,
      );
      return { band, playhead };
    };

    for (let frame = 1; frame <= 90; frame++) {
      store.getState().seekNominal(1);
      // While the step is pending, the playhead shows the nominal start of the target frame,
      // and the band starts there.
      const pending = bandAndPlayhead();
      expect(store.getState().seekTargetSeconds).not.toBeNull();
      expect(pending.band?.leftPercent).toBeCloseTo(pending.playhead.percent, 10);
      expect(pending.band?.leftPercent).toBeCloseTo(
        ((frame * 1001) / 30000 / total) * 100,
        10,
      );

      // The browser presents the frame, whose PTS is its start rounded to the millisecond.
      element.seeking = false;
      store.getState().syncSeeked(key, element);
      store
        .getState()
        .syncPresentedFrame(
          key,
          Math.round((frame * 1001) / 30) / 1000,
          frame + 1,
          element,
        );
      const presented = bandAndPlayhead();
      expect(store.getState().seekTargetSeconds).toBeNull();
      // The band keeps its place, and the playhead stands within one tick of its left edge.
      expect(presented.band).toStrictEqual(pending.band);
      expect(
        Math.abs(
          (presented.playhead.percent - (presented.band?.leftPercent ?? 0)) *
            total *
            10,
        ),
      ).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("runs from the nominal start of the frame to the start of the next frame", () => {
    // Frame 29 at 25 fps: [1.16 s, 1.2 s) of a 10 s extent.
    const band = calculatePlayheadFrameBand(
      ready("104400"),
      pts("0"),
      tb90k,
      fps25,
      10,
    );
    expect(band).not.toBeNull();
    expect(band?.leftPercent).toBeCloseTo(11.6, 10);
    expect(band?.widthPercent).toBeCloseTo(0.4, 10);
    expect(band?.left).toBe(`${band?.leftPercent}%`);
    expect(band?.width).toBe(`${band?.widthPercent}%`);
  });

  it("starts at the nominal start when the frame PTS lies after it", () => {
    // Frame 1 at 29.97 fps starts at 33.37 ms, and a millisecond PTS of 34 lies after it.
    const band = calculatePlayheadFrameBand(ready("34"), pts("0"), tbMs, fps2997, 1);
    expect(band?.leftPercent).toBeCloseTo((1001 / 30000) * 100, 10);
    expect(band?.widthPercent).toBeCloseTo((1001 / 30000) * 100, 10);
  });

  it("is clamped to the extent, and absent past it", () => {
    // The last frame of a 10.01 s extent at 25 fps starts at 10 s.
    const last = calculatePlayheadFrameBand(
      ready("900000"),
      pts("0"),
      tb90k,
      fps25,
      10.01,
    );
    expect(last?.leftPercent).toBeCloseTo((10 / 10.01) * 100, 10);
    expect((last?.leftPercent ?? 0) + (last?.widthPercent ?? 0)).toBeCloseTo(100, 10);
    // A frame that starts at the end of the extent has no band.
    expect(
      calculatePlayheadFrameBand(ready("900000"), pts("0"), tb90k, fps25, 10),
    ).toBeNull();
    expect(
      calculatePlayheadFrameBand(ready("0"), pts("0"), tb90k, fps25, null),
    ).toBeNull();
  });
});

describe("calculateOutFrameBand", () => {
  const segment = (inPts: string, outPts: string): Segment => ({
    id: "a",
    sourceId: "source-1",
    inPts: pts(inPts),
    outPts: pts(outPts),
  });

  it("runs from the Out to the start of the frame after the Out frame", () => {
    // Out on frame 30 at 29.97 fps, on a whole-tick grid (3003 ticks per frame).
    const band = calculateOutFrameBand(
      segment("0", "90090"),
      pts("0"),
      tb90k,
      fps2997,
      10,
    );
    expect(band?.leftPercent).toBeCloseTo((1.001 / 10) * 100, 10);
    expect(band?.widthPercent).toBeCloseTo((1001 / 30000 / 10) * 100, 10);
  });

  it("meets the right edge of the segment", () => {
    const seg = segment("33", "1001");
    const layout = calculateSegmentLayout(seg, pts("0"), tbMs, 5);
    const band = calculateOutFrameBand(seg, pts("0"), tbMs, fps2997, 5);
    expect(band?.leftPercent).toBeCloseTo(layout.leftPercent + layout.widthPercent, 10);
    // It ends at the nominal start of frame 31, 1034.37 ms.
    expect((band?.leftPercent ?? 0) + (band?.widthPercent ?? 0)).toBeCloseTo(
      ((31 * 1001) / 30000 / 5) * 100,
      10,
    );
  });

  it("has no band for an Out at or after the end of the extent", () => {
    expect(
      calculateOutFrameBand(segment("0", "900000"), pts("0"), tb90k, fps25, 10),
    ).toBeNull();
    expect(
      calculateOutFrameBand(segment("0", "990000"), pts("0"), tb90k, fps25, 10),
    ).toBeNull();
  });

  it("clamps the band of the last frame to the extent", () => {
    // The Out names the last frame of a 10.01 s extent, and the extent ends inside that frame.
    const band = calculateOutFrameBand(
      segment("0", "900000"),
      pts("0"),
      tb90k,
      fps25,
      10.01,
    );
    expect((band?.leftPercent ?? 0) + (band?.widthPercent ?? 0)).toBeCloseTo(100, 10);
  });

  it("has no band for invalid input", () => {
    expect(
      calculateOutFrameBand(segment("100", "100"), pts("0"), tb90k, fps25, 10),
    ).toBeNull();
    expect(
      calculateOutFrameBand(segment("-900", "-100"), pts("0"), tb90k, fps25, 10),
    ).toBeNull();
    expect(
      calculateOutFrameBand(segment("0", "3600"), null, tb90k, fps25, 10),
    ).toBeNull();
    expect(
      calculateOutFrameBand(segment("0", "3600"), pts("0"), null, fps25, 10),
    ).toBeNull();
    expect(
      calculateOutFrameBand(segment("0", "3600"), pts("0"), tb90k, fps25, null),
    ).toBeNull();
  });
});
