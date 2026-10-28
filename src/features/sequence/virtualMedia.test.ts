import { describe, expect, it } from "vitest";
import type { ImportMediaResult } from "@/features/media/types";
import { createTimelineStore } from "@/features/timeline/store";
import type { SequenceSource } from "@/features/timeline/sequence";
import type { Clip, Pts, Rational, TickCount } from "@/types/project";
import { attachedMediaOf, sequenceNominalRate, virtualMediaOf } from "./virtualMedia";

const pts = (value: string) => value as Pts;
const ticks = (value: string) => value as TickCount;

function source(
  id: string,
  timeBase: Rational,
  endPts: string | null,
  rate: Rational | null,
  realRate: Rational | null = rate,
): { media: ImportMediaResult; facts: SequenceSource } {
  const probe = {
    videoTimeBase: timeBase,
    videoStartPts: pts("0"),
    videoEndPts: endPts === null ? null : pts(endPts),
    videoDurationTicks: endPts === null ? null : ticks(endPts),
    approximateDurationSeconds: 10,
    avgFrameRate: rate,
    rFrameRate: realRate,
    reportedFrameCount: null,
  };
  const media = {
    path: `/${id}`,
    fileName: id,
    size: 1,
    mtime: 1,
    probe: {
      ...probe,
      width: 1920,
      height: 1080,
      sampleAspectRatio: null,
      rotation: 0,
      audio: null,
    },
  } as unknown as ImportMediaResult;
  return { media, facts: { id, ...probe } };
}

const fps30 = { n: 30, d: 1 };
// 10 s at 30 fps in 1/15360 and in 1/90000: whole frames.
const A = source("A", { n: 1, d: 15360 }, "153600", fps30);
const B = source("B", { n: 1, d: 90000 }, "900000", fps30);
// 10.01 s at 30 fps: not a whole number of frames.
const C = source("C", { n: 1, d: 1000 }, "10010", fps30);
// A variable rate: the average and the real rate differ.
const V = source("V", { n: 1, d: 1000 }, "10000", { n: 2997, d: 100 }, fps30);
const media = { A: A.media, B: B.media, C: C.media, V: V.media };

function timelineOf(clips: readonly Clip[], attached: string | null) {
  const store = createTimelineStore();
  const facts = { A: A.facts, B: B.facts, C: C.facts, V: V.facts };
  store.getState().insertClips(
    0,
    clips,
    clips.map((clip) => facts[clip.sourceId as keyof typeof facts]),
  );
  store.getState().setAttachedClip(attached);
  return store.getState();
}

const a1: Clip = { id: "a1", sourceId: "A" };
const b1: Clip = { id: "b1", sourceId: "B" };
const c1: Clip = { id: "c1", sourceId: "C" };
const v1: Clip = { id: "v1", sourceId: "V" };

describe("virtual media", () => {
  it("is the media of the one clip, the same object", () => {
    const timeline = timelineOf([a1], "a1");
    expect(virtualMediaOf(timeline, media)).toBe(A.media);
  });

  it("describes the virtual axis of several clips, with the file facts of the attached one", () => {
    const timeline = timelineOf([a1, b1], "b1");
    const result = virtualMediaOf(timeline, media);
    expect(result?.path).toBe("/B");
    expect(result?.probe).toMatchObject({
      videoTimeBase: { n: 1, d: 5760000 },
      videoStartPts: "0",
      videoDurationTicks: "115200000",
      videoEndPts: "115200000",
      approximateDurationSeconds: 20,
      avgFrameRate: fps30,
      rFrameRate: fps30,
      reportedFrameCount: null,
    });
    expect(attachedMediaOf(timeline, media)).toBe(B.media);
  });

  it("shows milliseconds when a clip before the last is not a whole number of frames", () => {
    expect(sequenceNominalRate(timelineOf([c1, a1], "c1"), media)).toBeNull();
    // As the last clip, its extent sets no start.
    expect(sequenceNominalRate(timelineOf([a1, c1], "a1"), media)).toEqual(fps30);
  });

  it("shows milliseconds with a variable frame rate or two rates", () => {
    expect(sequenceNominalRate(timelineOf([a1, v1], "a1"), media)).toBeNull();
    const D = source("D", { n: 1, d: 25 }, "250", { n: 25, d: 1 });
    const store = createTimelineStore();
    store
      .getState()
      .insertClips(0, [a1, { id: "d1", sourceId: "D" }], [A.facts, D.facts]);
    expect(sequenceNominalRate(store.getState(), { ...media, D: D.media })).toBeNull();
  });
});
