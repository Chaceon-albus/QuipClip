import { describe, expect, it } from "vitest";
import type { VirtualClip, VirtualTimeline } from "@/features/timeline/virtualTime";
import type { Pts, Rational } from "@/types/project";
import {
  resolveFrameBandGrids,
  resolveZoomCeilingRate,
  type ClipGridProbe,
  type ClipGridProbes,
} from "./clipFrameGrids";
import {
  calculateOutFrameBandOnGrids,
  calculatePlayheadFrameBandOnGrids,
  frameBandGridAt,
  type FrameBandPlayback,
} from "./frameBand";

const pts = (value: string) => value as Pts;

const tb90k: Rational = { n: 1, d: 90000 };
const fps25: Rational = { n: 25, d: 1 };
const fps30: Rational = { n: 30, d: 1 };
const fps2997: Rational = { n: 30000, d: 1001 };

function probe(rate: Rational | null, overrides: Partial<ClipGridProbe> = {}) {
  return {
    probe: {
      videoStartPts: pts("0"),
      videoTimeBase: tb90k,
      avgFrameRate: rate,
      rFrameRate: rate,
      ...overrides,
    },
  };
}

function clip(
  index: number,
  sourceId: string,
  startTicks: bigint,
  durationTicks: bigint | null,
  rangeStart: bigint | null = 0n,
): VirtualClip {
  return {
    clipId: `clip-${index}`,
    sourceId,
    index,
    startTicks,
    durationTicks,
    scale: 1n,
    rangeStart,
    exactDuration: true,
  };
}

// Clip A: 25 fps, 10.0011 s, so it is not a whole number of frames and the sequence has no one
// rate. Clip B: 30 fps, 10 s, from 900100 ticks.
const A_TICKS = 900_100n;
const B_TICKS = 900_000n;
const TOTAL_SECONDS = Number(A_TICKS + B_TICKS) / 90000;

function sequence(clips: readonly VirtualClip[]): VirtualTimeline {
  return {
    timeBase: tb90k,
    originPts: pts("0"),
    clips,
    totalTicks: A_TICKS + B_TICKS,
    exact: true,
  };
}

const TWO_CLIPS = sequence([clip(0, "A", 0n, A_TICKS), clip(1, "B", A_TICKS, B_TICKS)]);
const SOURCES: ClipGridProbes = { A: probe(fps25), B: probe(fps30) };
// 24000 px over 20 s is 1200 px/s: 48 px per frame at 25 fps and 40 px at 30 fps.
const WIDE_LANE_PX = 24000;

function gridsOf(overrides: Partial<Parameters<typeof resolveFrameBandGrids>[0]> = {}) {
  return resolveFrameBandGrids({
    virtual: TWO_CLIPS,
    sources: SOURCES,
    gridRate: null,
    canUsePreciseSeek: true,
    totalDurationSeconds: TOTAL_SECONDS,
    laneWidthPx: WIDE_LANE_PX,
    ...overrides,
  });
}

const ready = (presented: string | null, seekTargetSeconds: number | null = null) =>
  ({
    calibrationStatus: "ready",
    seekTargetSeconds,
    presentedFrame:
      presented === null ? null : { mediaTime: 0, inferredSourcePts: pts(presented) },
  }) satisfies FrameBandPlayback;

describe("resolveZoomCeilingRate", () => {
  it("takes the highest rate of the clips of a sequence", () => {
    expect(resolveZoomCeilingRate(TWO_CLIPS, SOURCES, probe(null).probe)).toEqual(
      fps30,
    );
    expect(
      resolveZoomCeilingRate(
        TWO_CLIPS,
        { A: probe(fps2997), B: probe(fps25) },
        probe(null).probe,
      ),
    ).toEqual(fps2997);
  });

  it("skips a clip with no rate, and gives null when no clip has one", () => {
    expect(
      resolveZoomCeilingRate(TWO_CLIPS, { A: probe(null), B: probe(fps25) }, null),
    ).toEqual(fps25);
    expect(
      resolveZoomCeilingRate(TWO_CLIPS, { A: probe(null), B: probe(null) }, null),
    ).toBeNull();
  });

  it("keeps the rate of the probe for one clip", () => {
    const one = sequence([clip(0, "A", 0n, A_TICKS)]);
    expect(resolveZoomCeilingRate(one, SOURCES, probe(fps2997).probe)).toEqual(fps2997);
    expect(resolveZoomCeilingRate(null, SOURCES, null)).toBeNull();
  });
});

describe("resolveFrameBandGrids", () => {
  it("gives the one source one grid with the rate of its exact grid", () => {
    const one = sequence([clip(0, "A", 0n, A_TICKS)]);
    expect(gridsOf({ virtual: one, gridRate: fps25 })).toEqual([{ rate: fps25 }]);
    expect(gridsOf({ virtual: null, gridRate: fps25 })).toEqual([{ rate: fps25 }]);
    expect(gridsOf({ virtual: one, gridRate: null })).toEqual([]);
    // Too narrow: 2000 px over 20 s is 4 px per frame at 25 fps.
    expect(gridsOf({ virtual: one, gridRate: fps25, laneWidthPx: 2000 })).toEqual([]);
  });

  it("gives each clip of a sequence the grid of its own source", () => {
    expect(gridsOf()).toEqual([
      {
        rate: fps25,
        clip: {
          originTicks: 0n,
          videoTimeBase: tb90k,
          startSeconds: 0,
          endSeconds: Number(A_TICKS) / 90000,
        },
      },
      {
        rate: fps30,
        clip: {
          originTicks: A_TICKS,
          videoTimeBase: tb90k,
          startSeconds: Number(A_TICKS) / 90000,
          endSeconds: TOTAL_SECONDS,
        },
      },
    ]);
  });

  it("places frame 0 of a clip that starts inside its source before the clip", () => {
    // Clip B starts at frame 30 of its source (1 s), so frame 0 lies 1 s before the clip.
    const trimmed = sequence([
      clip(0, "A", 0n, A_TICKS),
      clip(1, "B", A_TICKS, B_TICKS, 90_000n),
    ]);
    expect(gridsOf({ virtual: trimmed })[1]?.clip?.originTicks).toBe(A_TICKS - 90_000n);
  });

  it("leaves out a clip off the exact grid and a clip that is too narrow", () => {
    // On a time base of 1/10 s, a frame of 29.97 fps is not a whole number of ticks, and one
    // tick is longer than half a frame, so the grid is not exact.
    const offGrid = gridsOf({
      sources: {
        A: probe(fps25),
        B: probe(fps2997, { videoTimeBase: { n: 1, d: 10 } }),
      },
    });
    expect(offGrid.map((grid) => grid.rate)).toEqual([fps25]);
    expect(gridsOf({ sources: { A: probe(null), B: probe(fps30) } })).toHaveLength(1);
    // The extent is 20.0011 s, so 4000 px gives just under 200 px/s. A frame at 25 fps is then
    // just below 8 px, and a frame at 30 fps is 6.7 px.
    expect(gridsOf({ laneWidthPx: 4000 })).toEqual([]);
  });

  it("shows no band on a sequence while no precise seek is possible", () => {
    expect(gridsOf({ canUsePreciseSeek: false })).toEqual([]);
  });

  it("counts the frames of a clip in its own ticks, with the margin of its own time base", () => {
    // Clip B has a millisecond time base at 29.97 fps, so one of its ticks is 90 ticks of the
    // axis. Its first frame is at 100 ms, and the clip starts at 200 ms of the source.
    const fine = sequence([
      clip(0, "A", 0n, A_TICKS),
      { ...clip(1, "B", A_TICKS, B_TICKS, 200n), scale: 90n },
    ]);
    const grids = gridsOf({
      virtual: fine,
      sources: {
        A: probe(fps25),
        B: probe(fps2997, {
          videoTimeBase: { n: 1, d: 1000 },
          videoStartPts: pts("100"),
        }),
      },
    });
    // Frame 0 of the grid of B lies 100 ms before the clip.
    const origin = A_TICKS - 9_000n;
    expect(grids[1]?.clip?.originTicks).toBe(origin);
    // PTS 300 ms is 200 ms after the first frame: 5.994 frames. The margin of one millisecond
    // tick makes it frame 6, as the timecode of the source names it. The margin of the axis tick
    // would name frame 5.
    const band = calculatePlayheadFrameBandOnGrids(
      ready((A_TICKS + 100n * 90n).toString()),
      pts("0"),
      tb90k,
      grids,
      TOTAL_SECONDS,
    );
    const left = Number(origin) / 90000 + (6 * 1001) / 30000;
    expect(band?.leftPercent).toBeCloseTo((left / TOTAL_SECONDS) * 100, 9);
  });
});

describe("frameBandGridAt", () => {
  const grids = gridsOf();
  const junction = Number(A_TICKS) / 90000;

  it("finds the clip that holds the position, and gives the junction to the later clip", () => {
    expect(frameBandGridAt(grids, 0)?.rate).toEqual(fps25);
    expect(frameBandGridAt(grids, junction - 0.001)?.rate).toEqual(fps25);
    expect(frameBandGridAt(grids, junction)?.rate).toEqual(fps30);
    expect(frameBandGridAt(grids, TOTAL_SECONDS)).toBeNull();
    expect(frameBandGridAt(grids, null)).toBeNull();
  });

  it("finds no grid in a clip that has none", () => {
    const onlyB = gridsOf({ sources: { A: probe(null), B: probe(fps30) } });
    expect(frameBandGridAt(onlyB, 1)).toBeNull();
    expect(frameBandGridAt(onlyB, junction + 1)?.rate).toEqual(fps30);
  });

  it("finds the one grid of the one source everywhere", () => {
    expect(frameBandGridAt([{ rate: fps25 }], 123)).toEqual({ rate: fps25 });
  });
});

describe("the bands on the grid of each clip", () => {
  const grids = gridsOf();
  const junction = Number(A_TICKS) / 90000;
  const percent = (seconds: number) => (seconds / TOTAL_SECONDS) * 100;

  it("draws the playhead band on the grid of the second clip", () => {
    // Frame 5 of clip B at 30 fps: 3000 ticks per frame after the junction.
    const band = calculatePlayheadFrameBandOnGrids(
      ready((A_TICKS + 15_000n).toString()),
      pts("0"),
      tb90k,
      grids,
      TOTAL_SECONDS,
    );
    expect(band?.leftPercent).toBeCloseTo(percent(junction + 5 / 30), 9);
    expect(band?.widthPercent).toBeCloseTo(percent(1 / 30), 9);
  });

  it("reads a seek target on the grid of the clip that holds it", () => {
    const band = calculatePlayheadFrameBandOnGrids(
      ready(null, junction + 5.5 / 30),
      pts("0"),
      tb90k,
      grids,
      TOTAL_SECONDS,
    );
    expect(band?.leftPercent).toBeCloseTo(percent(junction + 5 / 30), 9);
  });

  it("cuts the band of the last frame of a clip at the junction", () => {
    // Frame 250 of clip A starts at 10 s, and the clip ends 0.0011 s later.
    const band = calculatePlayheadFrameBandOnGrids(
      ready("900000"),
      pts("0"),
      tb90k,
      grids,
      TOTAL_SECONDS,
    );
    expect(band?.leftPercent).toBeCloseTo(percent(10), 9);
    expect(band?.widthPercent).toBeCloseTo(percent(junction - 10), 9);
  });

  it("draws the Out band on the grid of the clip under the Out", () => {
    const out = A_TICKS + 15_000n;
    const band = calculateOutFrameBandOnGrids(
      { inPts: pts("90000"), outPts: pts(out.toString()) },
      pts("0"),
      tb90k,
      grids,
      TOTAL_SECONDS,
    );
    expect(band?.leftPercent).toBeCloseTo(percent(Number(out) / 90000), 9);
    expect(band?.widthPercent).toBeCloseTo(percent(1 / 30), 9);
  });

  it("draws the Out band of an Out on the junction on the first frame of the later clip", () => {
    const band = calculateOutFrameBandOnGrids(
      { inPts: pts("90000"), outPts: pts(A_TICKS.toString()) },
      pts("0"),
      tb90k,
      grids,
      TOTAL_SECONDS,
    );
    expect(band?.leftPercent).toBeCloseTo(percent(junction), 9);
    expect(band?.widthPercent).toBeCloseTo(percent(1 / 30), 9);
  });

  it("draws no band where no grid applies", () => {
    expect(
      calculatePlayheadFrameBandOnGrids(ready("900000"), pts("0"), tb90k, [], 20),
    ).toBeNull();
  });
});
