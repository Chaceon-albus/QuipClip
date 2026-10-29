import { describe, expect, it } from "vitest";
import type { ClipBarLayout } from "@/components/timeline/clipBarLayout";
import type { VirtualClip } from "@/features/timeline/virtualTime";
import type { Pts } from "@/types/project";
import {
  planWaveformColumns,
  type WaveformPlanInput,
  type WaveformSourceView,
} from "./geometry";

const GUTTER = 96;

function virtualClip(
  clipId: string,
  sourceId: string,
  rangeStart: bigint | null = 1000n,
): VirtualClip {
  return {
    clipId,
    sourceId,
    index: 0,
    startTicks: 0n,
    durationTicks: null,
    scale: 1n,
    rangeStart,
    exactDuration: true,
  };
}

function layout(
  clipId: string,
  sourceId: string,
  leftPercent: number,
  widthPercent: number,
): ClipBarLayout {
  return { clipId, sourceId, index: 0, leftPercent, widthPercent };
}

function source(length: number): WaveformSourceView {
  return { originPts: "1000" as Pts, timeBase: { n: 1, d: 1000 }, length };
}

function input(overrides: Partial<WaveformPlanInput>): WaveformPlanInput {
  return {
    layouts: [layout("c1", "s1", 0, 100)],
    clips: [virtualClip("c1", "s1")],
    sources: new Map([["s1", source(1_000_000)]]),
    laneWidthPx: 1000,
    totalDurationSeconds: 100,
    scrollLeftPx: 0,
    viewportWidthPx: 1000 + GUTTER,
    overscanPx: 0,
    dpr: 1,
    ...overrides,
  };
}

function columns(plan: ReturnType<typeof planWaveformColumns>, index = 0) {
  const clip = plan.clips[index];
  if (clip === undefined) {
    throw new Error("no clip");
  }
  return Array.from(
    clip.bucketStarts,
    (start, i) => [start, clip.bucketEnds[i]] as const,
  );
}

describe("planWaveformColumns", () => {
  it("folds many buckets into each column at zoom-out", () => {
    // 10 px for each second: one CSS pixel is 10 buckets.
    const plan = planWaveformColumns(input({}));
    expect(plan.widthDevicePx).toBe(1000);
    expect(plan.canvasLeftPx).toBe(0);
    const cols = columns(plan);
    expect(cols).toHaveLength(1000);
    expect(cols[0]).toEqual([0, 10]);
    expect(cols[1]).toEqual([10, 20]);
    expect(cols[999]).toEqual([9990, 10000]);
    // The columns split the buckets with no gap and no overlap.
    for (let i = 1; i < cols.length; i++) {
      expect(cols[i]?.[0]).toBe(cols[i - 1]?.[1]);
    }
  });

  it("splits the device pixels at a higher pixel ratio", () => {
    const cols = columns(planWaveformColumns(input({ dpr: 2 })));
    expect(cols).toHaveLength(2000);
    expect(cols[0]).toEqual([0, 5]);
    expect(cols[1]).toEqual([5, 10]);
  });

  it("maps each column of a wide bucket to that bucket at zoom-in", () => {
    // 10,000 px for each second: one bucket is 100 px.
    const plan = planWaveformColumns(
      input({
        laneWidthPx: 100_000,
        totalDurationSeconds: 10,
        scrollLeftPx: 250,
        viewportWidthPx: 300 + GUTTER,
      }),
    );
    expect(plan.canvasLeftPx).toBe(250);
    const cols = columns(plan);
    expect(cols).toHaveLength(300);
    expect(cols[0]).toEqual([2, 3]);
    expect(cols[49]).toEqual([2, 3]);
    expect(cols[50]).toEqual([3, 4]);
    expect(cols[149]).toEqual([3, 4]);
    expect(cols[150]).toEqual([4, 5]);
    expect(cols[299]).toEqual([5, 6]);
  });

  it("covers the visible lane plus the overscan of a scrolled viewport", () => {
    const plan = planWaveformColumns(
      input({ scrollLeftPx: 400, viewportWidthPx: 200 + GUTTER, overscanPx: 50 }),
    );
    expect(plan.canvasLeftPx).toBe(350);
    expect(plan.widthDevicePx).toBe(300);
    const clip = plan.clips[0];
    expect(clip?.firstColumn).toBe(0);
    expect(columns(plan)[0]).toEqual([3500, 3510]);
    expect(columns(plan)[299]).toEqual([6490, 6500]);
  });

  it("clamps the canvas to the lane", () => {
    const plan = planWaveformColumns(
      input({ scrollLeftPx: 900, viewportWidthPx: 400 + GUTTER, overscanPx: 50 }),
    );
    expect(plan.canvasLeftPx).toBe(850);
    expect(plan.widthDevicePx).toBe(150);
  });

  it("clamps the columns to the clip edges and the buffer length", () => {
    // A clip from 25 % to 75 %: lane px 250..750, source seconds 0..50.
    const plan = planWaveformColumns(
      input({
        layouts: [layout("c1", "s1", 25.05, 49.9)],
        sources: new Map([["s1", source(3000)]]),
      }),
    );
    const clip = plan.clips[0];
    // The clip starts in the middle of device pixel 250. Its edges round to whole columns, so
    // its first column is 251.
    expect(clip?.firstColumn).toBe(251);
    const cols = columns(plan);
    expect(cols).toHaveLength(499);
    expect(cols[0]).toEqual([5, 15]);
    // Bucket 3000 is past the buffer: those columns hold no data.
    expect(cols[299]).toEqual([2995, 3000]);
    expect(cols[300]).toEqual([3000, 3000]);
    expect(cols[498]).toEqual([3000, 3000]);
  });

  it("ends the last column at the clip end", () => {
    const plan = planWaveformColumns(input({ layouts: [layout("c1", "s1", 0, 50.1)] }));
    const cols = columns(plan);
    expect(cols).toHaveLength(501);
    expect(cols[500]).toEqual([5000, 5010]);
  });

  it("gives the column at a junction to one clip", () => {
    // The junction lies at lane px 333.3, inside device column 333.
    const plan = planWaveformColumns(
      input({
        layouts: [layout("c1", "s1", 0, 33.33), layout("c2", "s1", 33.33, 33.33)],
        clips: [virtualClip("c1", "s1"), virtualClip("c2", "s1")],
      }),
    );
    const [first, second] = plan.clips;
    expect(first.firstColumn + first.bucketStarts.length).toBe(333);
    expect(second.firstColumn).toBe(333);
  });

  it("draws two clips of one source, each from its own start", () => {
    const plan = planWaveformColumns(
      input({
        layouts: [layout("c1", "s1", 0, 50), layout("c2", "s1", 50, 50)],
        clips: [virtualClip("c1", "s1"), virtualClip("c2", "s1")],
      }),
    );
    expect(plan.clips.map((clip) => [clip.clipId, clip.firstColumn])).toEqual([
      ["c1", 0],
      ["c2", 500],
    ]);
    expect(columns(plan, 0)[0]).toEqual([0, 10]);
    expect(columns(plan, 1)[0]).toEqual([0, 10]);
    expect(columns(plan, 1)).toHaveLength(500);
  });

  it("adds the offset of the clip range to the origin", () => {
    // A range that starts 2 s after the origin, as a trimmed clip later gives.
    const plan = planWaveformColumns(
      input({ clips: [virtualClip("c1", "s1", 3000n)] }),
    );
    expect(columns(plan)[0]).toEqual([200, 210]);
  });

  it("skips a clip whose source does not show, or that has no range", () => {
    const hidden = planWaveformColumns(input({ sources: new Map() }));
    expect(hidden.clips).toEqual([]);
    const noRange = planWaveformColumns(
      input({ clips: [virtualClip("c1", "s1", null)] }),
    );
    expect(noRange.clips).toEqual([]);
  });

  it("skips a clip outside the canvas", () => {
    const plan = planWaveformColumns(
      input({
        layouts: [layout("c1", "s1", 0, 10), layout("c2", "s1", 60, 40)],
        clips: [virtualClip("c1", "s1"), virtualClip("c2", "s1")],
        scrollLeftPx: 500,
        viewportWidthPx: 400 + GUTTER,
      }),
    );
    expect(plan.clips.map((clip) => clip.clipId)).toEqual(["c2"]);
    expect(plan.clips[0]?.firstColumn).toBe(100);
  });

  it("returns an empty plan for a lane with no size", () => {
    expect(planWaveformColumns(input({ laneWidthPx: 0 })).clips).toEqual([]);
    expect(planWaveformColumns(input({ totalDurationSeconds: 0 })).clips).toEqual([]);
    expect(planWaveformColumns(input({ dpr: 0 })).clips).toEqual([]);
    expect(planWaveformColumns(input({ viewportWidthPx: GUTTER })).widthDevicePx).toBe(
      0,
    );
  });
});
