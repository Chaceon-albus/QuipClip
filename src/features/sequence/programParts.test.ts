import { describe, expect, it } from "vitest";
import type { ImportMediaResult } from "@/features/media/types";
import { createTimelineStore } from "@/features/timeline/store";
import type { SequenceSource } from "@/features/timeline/sequence";
import type { Clip, Pts, Rational, SequenceSegment, TickCount } from "@/types/project";
import {
  buildProgramParts,
  joinTicks,
  programKey,
  programSegments,
  programStartIndex,
  type ProgramPart,
} from "./programParts";
import type { MediaBySource } from "./virtualMedia";

const pts = (value: string) => value as Pts;

/**
 * A source at `path` with the time base `timeBase`, the frame rate `fps`, and an extent of
 * `ticks` ticks from PTS 0.
 */
function source(
  path: string,
  timeBase: Rational,
  fps: Rational,
  ticks: string,
): { media: ImportMediaResult; facts: SequenceSource } {
  const probe = {
    videoTimeBase: timeBase,
    videoStartPts: pts("0"),
    videoEndPts: pts(ticks),
    videoDurationTicks: ticks as TickCount,
    approximateDurationSeconds: (Number(ticks) * timeBase.n) / timeBase.d,
    avgFrameRate: fps,
    rFrameRate: fps,
    reportedFrameCount: null,
  };
  const media = {
    path,
    fileName: path.slice(1),
    size: 1024,
    mtime: 1_724_976_000,
    probe: {
      ...probe,
      width: 1920,
      height: 1080,
      sampleAspectRatio: null,
      rotation: 0,
      audio: null,
    },
  } as unknown as ImportMediaResult;
  return { media, facts: { id: path, ...probe } };
}

/** 25 fps on 1/25, 10 s: PTS k is frame k, and 2 s are 50 ticks. */
const A = source("/a.mp4", { n: 1, d: 25 }, { n: 25, d: 1 }, "250");
const B = source("/b.mp4", { n: 1, d: 25 }, { n: 25, d: 1 }, "250");
/** 29.97 fps on 1001/30000: a tick is a frame, and 2 s are 59.94 ticks, so 59. */
const N = source("/n.mp4", { n: 1001, d: 30000 }, { n: 30000, d: 1001 }, "600");
/** 29.97 fps on 1/1000: an exact grid whose margin is one tick. 2 s are 2000 ticks. */
const M = source("/m.mp4", { n: 1, d: 1000 }, { n: 30000, d: 1001 }, "10010");

const a1: Clip = { id: "a1", sourceId: "/a.mp4" };
const b1: Clip = { id: "b1", sourceId: "/b.mp4" };
const n1: Clip = { id: "n1", sourceId: "/n.mp4" };
const m1: Clip = { id: "m1", sourceId: "/m.mp4" };

const ALL = [A, B, N, M];
const media: MediaBySource = Object.fromEntries(
  ALL.map((entry) => [entry.facts.id, entry.media]),
);

function segment(
  id: string,
  inClipId: string,
  inPts: string,
  outClipId: string,
  outPts: string,
): SequenceSegment {
  return { id, inClipId, inPts: pts(inPts), outClipId, outPts: pts(outPts) };
}

/** The timeline state of `clips` and `segments`, as a project open gives it. */
function timelineOf(clips: readonly Clip[], segments: readonly SequenceSegment[]) {
  const timeline = createTimelineStore();
  timeline.getState().loadSequence(
    clips,
    ALL.map((entry) => entry.facts),
    segments,
  );
  return timeline;
}

/** The parts as `[segment, clip, start, end]`, for a short comparison. */
function short(parts: readonly ProgramPart[]): string[][] {
  return parts.map((part) => [part.segmentId, part.clipId, part.startPts, part.endPts]);
}

describe("the program (ADR 074)", () => {
  it("holds the segments of the export in the export order, with their pieces", () => {
    const timeline = timelineOf(
      [a1, b1],
      [segment("s2", "b1", "25", "b1", "75"), segment("s1", "a1", "200", "b1", "50")],
    );
    expect(programSegments(timeline.getState())).toEqual([
      {
        segmentId: "s2",
        pieces: [{ clipId: "b1", sourceId: "/b.mp4", inPts: "25", outPts: "75" }],
      },
      {
        segmentId: "s1",
        pieces: [
          { clipId: "a1", sourceId: "/a.mp4", inPts: "200", outPts: "250" },
          { clipId: "b1", sourceId: "/b.mp4", inPts: "0", outPts: "50" },
        ],
      },
    ]);
  });

  it("holds one piece on the one clip for each segment of one clip", () => {
    const timeline = timelineOf([a1], [segment("s1", "a1", "50", "a1", "100")]);
    expect(programSegments(timeline.getState())).toEqual([
      {
        segmentId: "s1",
        pieces: [{ clipId: "a1", sourceId: "/a.mp4", inPts: "50", outPts: "100" }],
      },
    ]);
  });

  it("is empty with no clip", () => {
    expect(programSegments(createTimelineStore().getState())).toEqual([]);
  });
});

describe("Play Program (ADR 074)", () => {
  it("has one part for each segment on one clip", () => {
    const timeline = timelineOf(
      [a1, b1],
      [segment("s1", "a1", "50", "a1", "100"), segment("s2", "b1", "25", "b1", "75")],
    );
    expect(
      short(buildProgramParts("program", timeline.getState(), media, null)),
    ).toEqual([
      ["s1", "a1", "50", "100"],
      ["s2", "b1", "25", "75"],
    ]);
  });

  it("has one part for each piece of a segment across a junction", () => {
    const timeline = timelineOf([a1, b1], [segment("s1", "a1", "200", "b1", "50")]);
    const parts = buildProgramParts("program", timeline.getState(), media, null);
    expect(parts).toEqual([
      {
        segmentId: "s1",
        clipId: "a1",
        sourceId: "/a.mp4",
        startPts: "200",
        endPts: "250",
      },
      {
        segmentId: "s1",
        clipId: "b1",
        sourceId: "/b.mp4",
        startPts: "0",
        endPts: "50",
      },
    ]);
  });

  it("works on the derived segments of one clip", () => {
    const timeline = timelineOf(
      [a1],
      [segment("s1", "a1", "50", "a1", "100"), segment("s2", "a1", "150", "a1", "200")],
    );
    expect(
      short(buildProgramParts("program", timeline.getState(), media, null)),
    ).toEqual([
      ["s1", "a1", "50", "100"],
      ["s2", "a1", "150", "200"],
    ]);
  });

  it("is empty with no segment", () => {
    const timeline = timelineOf([a1, b1], []);
    expect(buildProgramParts("program", timeline.getState(), media, null)).toEqual([]);
  });
});

describe("Play Joins (ADR 074)", () => {
  it("plays the tail of the first segment, head and tail in the middle, and the head of the last", () => {
    const timeline = timelineOf(
      [a1, b1],
      [
        segment("s1", "a1", "0", "a1", "200"),
        segment("s2", "a1", "210", "b1", "100"),
        segment("s3", "b1", "150", "b1", "250"),
      ],
    );
    expect(short(buildProgramParts("joins", timeline.getState(), media, null))).toEqual(
      [
        ["s1", "a1", "150", "200"],
        // The head is on the first piece and the tail on the last piece of s2.
        ["s2", "a1", "210", "250"],
        ["s2", "b1", "50", "100"],
        ["s3", "b1", "150", "200"],
      ],
    );
  });

  it("plays a short middle segment of one piece as one part, the whole piece", () => {
    const timeline = timelineOf(
      [a1],
      [
        segment("s1", "a1", "0", "a1", "100"),
        // 3 s: the head [125, 175) ends after the start of the tail [150, 200).
        segment("s2", "a1", "125", "a1", "200"),
        segment("s3", "a1", "220", "a1", "250"),
      ],
    );
    expect(short(buildProgramParts("joins", timeline.getState(), media, null))).toEqual(
      [
        ["s1", "a1", "50", "100"],
        ["s2", "a1", "125", "200"],
        ["s3", "a1", "220", "250"],
      ],
    );
  });

  it("plays a head and a tail that only touch as one part", () => {
    const timeline = timelineOf(
      [a1],
      [
        segment("s1", "a1", "0", "a1", "50"),
        // 4 s: the head ends at 150, where the tail starts.
        segment("s2", "a1", "100", "a1", "200"),
        segment("s3", "a1", "210", "a1", "250"),
      ],
    );
    expect(short(buildProgramParts("joins", timeline.getState(), media, null))).toEqual(
      [
        ["s1", "a1", "0", "50"],
        ["s2", "a1", "100", "200"],
        ["s3", "a1", "210", "250"],
      ],
    );
  });

  it("plays a head and a tail with a gap between them as two parts", () => {
    const timeline = timelineOf(
      [a1],
      [
        segment("s1", "a1", "0", "a1", "50"),
        // 4 s and one frame: the head ends at 150, and the tail starts at 151.
        segment("s2", "a1", "100", "a1", "201"),
        segment("s3", "a1", "210", "a1", "250"),
      ],
    );
    expect(short(buildProgramParts("joins", timeline.getState(), media, null))).toEqual(
      [
        ["s1", "a1", "0", "50"],
        ["s2", "a1", "100", "150"],
        ["s2", "a1", "151", "201"],
        ["s3", "a1", "210", "250"],
      ],
    );
  });

  it("plays the whole of a segment shorter than 2 seconds as a tail and as a head", () => {
    const timeline = timelineOf(
      [a1],
      [segment("s1", "a1", "10", "a1", "30"), segment("s2", "a1", "100", "a1", "120")],
    );
    expect(short(buildProgramParts("joins", timeline.getState(), media, null))).toEqual(
      [
        ["s1", "a1", "10", "30"],
        ["s2", "a1", "100", "120"],
      ],
    );
  });

  it("counts 2 seconds in ticks of a time base that does not divide a second, rounded down", () => {
    expect(joinTicks({ n: 1001, d: 30000 })).toBe(59n);
    expect(joinTicks({ n: 1, d: 90000 })).toBe(180000n);
    expect(joinTicks({ n: 3, d: 1 })).toBe(0n);
    expect(joinTicks({ n: 0, d: 1 })).toBeNull();
    const timeline = timelineOf(
      [n1],
      [segment("s1", "n1", "0", "n1", "300"), segment("s2", "n1", "400", "n1", "600")],
    );
    expect(short(buildProgramParts("joins", timeline.getState(), media, null))).toEqual(
      [
        ["s1", "n1", "241", "300"],
        ["s2", "n1", "400", "459"],
      ],
    );
  });

  it("uses the time base of the source of each piece", () => {
    const timeline = timelineOf(
      [a1, m1],
      [segment("s1", "a1", "0", "a1", "250"), segment("s2", "m1", "0", "m1", "8000")],
    );
    expect(short(buildProgramParts("joins", timeline.getState(), media, null))).toEqual(
      [
        ["s1", "a1", "200", "250"],
        ["s2", "m1", "0", "2000"],
      ],
    );
  });

  it("needs two or more segments", () => {
    const timeline = timelineOf([a1], [segment("s1", "a1", "0", "a1", "250")]);
    expect(buildProgramParts("joins", timeline.getState(), media, null)).toEqual([]);
  });
});

describe("a part that holds no frame (ADR 074)", () => {
  it("is left out of both lists", () => {
    // A segment of one tick at the start of frame 30 holds no frame: the margin of the grid is
    // one tick (canPlaySegment).
    const timeline = timelineOf(
      [a1, m1],
      [
        segment("s1", "a1", "0", "a1", "100"),
        segment("s2", "m1", "1001", "m1", "1002"),
      ],
    );
    expect(timeline.getState().sequenceSegments).toHaveLength(2);
    expect(
      short(buildProgramParts("program", timeline.getState(), media, null)),
    ).toEqual([["s1", "a1", "0", "100"]]);
    expect(short(buildProgramParts("joins", timeline.getState(), media, null))).toEqual(
      [["s1", "a1", "50", "100"]],
    );
  });

  it("is left out when its source has no media", () => {
    const timeline = timelineOf([a1, b1], [segment("s1", "a1", "200", "b1", "50")]);
    const onlyA: MediaBySource = { "/a.mp4": A.media };
    expect(
      short(buildProgramParts("program", timeline.getState(), onlyA, null)),
    ).toEqual([["s1", "a1", "200", "250"]]);
  });
});

describe("where a program play starts (ADR 074)", () => {
  const timeline = timelineOf(
    [a1],
    [
      segment("s1", "a1", "0", "a1", "50"),
      segment("s2", "a1", "100", "a1", "150"),
      segment("s3", "a1", "200", "a1", "250"),
    ],
  );
  const program = programSegments(timeline.getState());

  it("starts at the current segment when it is in the program", () => {
    expect(programStartIndex("program", program, "s2")).toBe(1);
    expect(programStartIndex("joins", program, "s2")).toBe(1);
    expect(
      short(buildProgramParts("program", timeline.getState(), media, "s2")),
    ).toEqual([
      ["s2", "a1", "100", "150"],
      ["s3", "a1", "200", "250"],
    ]);
    expect(short(buildProgramParts("joins", timeline.getState(), media, "s2"))).toEqual(
      [
        ["s2", "a1", "100", "150"],
        ["s3", "a1", "200", "250"],
      ],
    );
  });

  it("starts at the first segment with no current segment, or one that is not in the program", () => {
    expect(programStartIndex("program", program, null)).toBe(0);
    expect(programStartIndex("program", program, "missing")).toBe(0);
    expect(programStartIndex("joins", program, "missing")).toBe(0);
  });

  it("plays the last segment alone in Play Program", () => {
    expect(programStartIndex("program", program, "s3")).toBe(2);
    expect(
      short(buildProgramParts("program", timeline.getState(), media, "s3")),
    ).toEqual([["s3", "a1", "200", "250"]]);
  });

  it("takes the last segment as no current segment in Play Joins", () => {
    expect(programStartIndex("joins", program, "s3")).toBe(0);
    expect(short(buildProgramParts("joins", timeline.getState(), media, "s3"))).toEqual(
      [
        ["s1", "a1", "0", "50"],
        ["s2", "a1", "100", "150"],
        ["s3", "a1", "200", "250"],
      ],
    );
  });
});

describe("the key of the program (ADR 074)", () => {
  function twoClips() {
    return timelineOf(
      [a1, b1],
      [segment("s1", "a1", "50", "a1", "100"), segment("s2", "b1", "25", "b1", "75")],
    );
  }

  it("stays for a change that is no change of the program", () => {
    const timeline = twoClips();
    const key = programKey(timeline.getState());
    timeline.getState().setAttachedClip("b1");
    timeline.getState().selectSegment("s2");
    timeline.getState().renameSegment("s2", "Name");
    timeline.getState().setBrowserDuration("/b.mp4", 10);
    expect(programKey(timeline.getState())).toBe(key);
  });

  it.each([
    [
      "an export order",
      (t: ReturnType<typeof twoClips>) =>
        t.getState().reorderExportSegments(["s2", "s1"]),
    ],
    ["a moved clip", (t: ReturnType<typeof twoClips>) => t.getState().moveClip(1, 0)],
    ["a removed clip", (t: ReturnType<typeof twoClips>) => t.getState().removeClip(1)],
    [
      "a removed segment",
      (t: ReturnType<typeof twoClips>) => {
        t.getState().selectSegment("s1");
        t.getState().deleteSelectedSegments();
      },
    ],
    [
      "a new sequence of the same content",
      (t: ReturnType<typeof twoClips>) =>
        t.getState().loadSequence(
          [a1, b1],
          ALL.map((entry) => entry.facts),
          [
            segment("s1", "a1", "50", "a1", "100"),
            segment("s2", "b1", "25", "b1", "75"),
          ],
        ),
    ],
  ])("changes for %s", (_name, change) => {
    const timeline = twoClips();
    const key = programKey(timeline.getState());
    change(timeline);
    expect(programKey(timeline.getState())).not.toBe(key);
  });
});
