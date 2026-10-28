import { describe, expect, it } from "vitest";
import type { Clip, Pts, TickCount } from "@/types/project";
import type { SequenceSource, SequenceSources } from "./sequence";
import {
  buildVirtualTimeline,
  clipAtVirtualPts,
  clipStartSeconds,
  fromVirtualPts,
  toVirtualPts,
} from "./virtualTime";

const pts = (value: string) => value as Pts;
const ticks = (value: string) => value as TickCount;

const sourceA: SequenceSource = {
  id: "A",
  videoTimeBase: { n: 1, d: 90000 },
  videoStartPts: pts("-1800"),
  videoEndPts: pts("898200"), // 10 s
  videoDurationTicks: ticks("900000"),
  approximateDurationSeconds: 10,
};
const sourceB: SequenceSource = {
  id: "B",
  videoTimeBase: { n: 1, d: 1000 },
  videoStartPts: pts("0"),
  videoEndPts: pts("5000"), // 5 s
  videoDurationTicks: ticks("5000"),
  approximateDurationSeconds: 5,
};
const sourceC: SequenceSource = {
  id: "C",
  videoTimeBase: { n: 1, d: 12800 },
  videoStartPts: pts("128000"),
  videoEndPts: pts("179200"), // 4 s
  videoDurationTicks: null,
  approximateDurationSeconds: 4,
};
// An extent from an estimate of 2.123456 s only: 2123456 µs, which 1/1000 does not divide.
const sourceN: SequenceSource = {
  id: "N",
  videoTimeBase: { n: 1, d: 1000 },
  videoStartPts: pts("0"),
  videoEndPts: null,
  videoDurationTicks: null,
  approximateDurationSeconds: 2.123456,
};
const sources: SequenceSources = new Map(
  [sourceA, sourceB, sourceC, sourceN].map((source) => [source.id, source]),
);
const a1: Clip = { id: "a1", sourceId: "A" };
const b1: Clip = { id: "b1", sourceId: "B" };
const c1: Clip = { id: "c1", sourceId: "C" };
const n1: Clip = { id: "n1", sourceId: "N" };

describe("buildVirtualTimeline", () => {
  it("keeps the time base and the PTS of a single clip", () => {
    const timeline = buildVirtualTimeline([a1], sources);
    expect(timeline?.timeBase).toEqual({ n: 1, d: 90000 });
    expect(timeline?.originPts).toBe("-1800");
    for (const value of ["-1800", "0", "3003", "898200"]) {
      expect(
        timeline && toVirtualPts(timeline, { clipId: "a1", pts: pts(value) }),
      ).toBe(value);
    }
    expect(timeline?.totalTicks).toBe(900000n);
  });

  it("keeps a single clip with an estimated extent on its own time base", () => {
    const timeline = buildVirtualTimeline([n1], sources);
    expect(timeline?.timeBase).toEqual({ n: 1, d: 1000 });
    expect(timeline && toVirtualPts(timeline, { clipId: "n1", pts: pts("1234") })).toBe(
      "1234",
    );
  });

  it("finds a time base that every clip divides", () => {
    const timeline = buildVirtualTimeline([a1, b1, c1], sources);
    // lcm(90000, 1000, 12800) = 2880000.
    expect(timeline?.timeBase).toEqual({ n: 1, d: 2880000 });
    expect(timeline?.clips.map((clip) => clip.startTicks)).toEqual([
      0n,
      28800000n,
      43200000n,
    ]);
    expect(timeline?.clips.map((clip) => clip.scale)).toEqual([32n, 2880n, 225n]);
    expect(timeline?.totalTicks).toBe(54720000n);
    expect(timeline?.exact).toBe(true);
  });

  it("puts the end of a clip and the start of the next clip on one virtual PTS", () => {
    const timeline = buildVirtualTimeline([a1, b1, c1], sources);
    if (timeline === null) throw new Error("timeline");
    expect(toVirtualPts(timeline, { clipId: "a1", pts: pts("898200") })).toBe(
      toVirtualPts(timeline, { clipId: "b1", pts: pts("0") }),
    );
    expect(toVirtualPts(timeline, { clipId: "b1", pts: pts("5000") })).toBe(
      toVirtualPts(timeline, { clipId: "c1", pts: pts("128000") }),
    );
  });

  it("divides the estimate when it sets a later start", () => {
    const timeline = buildVirtualTimeline([n1, b1], sources);
    // 2123456/1000000 s reduces to 132716/62500, and lcm(1000, 62500) = 125000.
    expect(timeline?.timeBase).toEqual({ n: 1, d: 125000 });
    expect(timeline?.clips[1]?.startTicks).toBe(265432n);
    expect(timeline?.exact).toBe(false);
  });

  it("refuses an empty sequence and an unknown source", () => {
    expect(buildVirtualTimeline([], sources)).toBeNull();
    expect(
      buildVirtualTimeline([{ id: "q", sourceId: "missing" }], sources),
    ).toBeNull();
  });
});

describe("virtual PTS and edit points", () => {
  const timeline = buildVirtualTimeline([a1, b1, c1], sources);
  if (timeline === null) throw new Error("timeline");

  it("goes back to the same edit point on its clip", () => {
    for (const point of [
      { clipId: "a1", pts: pts("-1800") },
      { clipId: "a1", pts: pts("45045") },
      { clipId: "b1", pts: pts("2500") },
      { clipId: "c1", pts: pts("134400") },
    ]) {
      const virtual = toVirtualPts(timeline, point);
      expect(virtual && fromVirtualPts(timeline, virtual, point.clipId)).toEqual(point);
    }
  });

  it("refuses a virtual PTS off the tick grid of the named clip", () => {
    const virtual = toVirtualPts(timeline, { clipId: "b1", pts: pts("1") });
    if (virtual === null) throw new Error("virtual");
    const off = (BigInt(virtual) + 1n).toString() as Pts;
    expect(fromVirtualPts(timeline, off, "b1")).toBeNull();
    expect(fromVirtualPts(timeline, virtual, "zz")).toBeNull();
  });

  it("gives a junction to the later clip", () => {
    const junction = toVirtualPts(timeline, { clipId: "b1", pts: pts("0") });
    if (junction === null) throw new Error("junction");
    expect(clipAtVirtualPts(timeline, junction)?.clipId).toBe("b1");
    const before = (BigInt(junction) - 1n).toString() as Pts;
    expect(clipAtVirtualPts(timeline, before)?.clipId).toBe("a1");
    expect(clipAtVirtualPts(timeline, pts("-99999999"))?.clipId).toBe("a1");
  });

  it("gives the start of each clip in seconds", () => {
    expect(clipStartSeconds(timeline, "a1")).toBe(0);
    expect(clipStartSeconds(timeline, "b1")).toBe(10);
    expect(clipStartSeconds(timeline, "c1")).toBe(15);
    expect(clipStartSeconds(timeline, "zz")).toBeNull();
  });
});
