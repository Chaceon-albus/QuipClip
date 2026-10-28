import { describe, expect, it } from "vitest";
import type { Clip, Pts, SequenceSegment, TickCount } from "@/types/project";
import {
  canonicalIn,
  canonicalOut,
  clipRange,
  compareEditPoints,
  expandSegment,
  insertClips,
  isValidSequenceSegment,
  layoutSequence,
  locate,
  moveClip,
  removeClip,
  sequenceSegmentDuration,
  splitSegmentsAtJunctions,
  toSequenceSeconds,
  toSequenceTime,
  type SequenceEdit,
  type SequenceSource,
  type SequenceSources,
} from "./sequence";

const pts = (value: string) => value as Pts;
const ticks = (value: string) => value as TickCount;

// Three time bases and three origins, so no test can pass by comparing raw PTS across sources.
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
// No exact end: its extent comes from the reported duration only.
const sourceN: SequenceSource = {
  id: "N",
  videoTimeBase: { n: 1, d: 1000 },
  videoStartPts: pts("0"),
  videoEndPts: null,
  videoDurationTicks: ticks("3000"),
  approximateDurationSeconds: 3,
};
// No start: the clip has no range.
const sourceZ: SequenceSource = {
  id: "Z",
  videoTimeBase: { n: 1, d: 1000 },
  videoStartPts: null,
  videoEndPts: null,
  videoDurationTicks: ticks("2000"),
  approximateDurationSeconds: 2,
};
// No extent at all.
const sourceX: SequenceSource = {
  id: "X",
  videoTimeBase: { n: 1, d: 1000 },
  videoStartPts: pts("0"),
  videoEndPts: null,
  videoDurationTicks: null,
  approximateDurationSeconds: null,
};

const sources: SequenceSources = new Map(
  [sourceA, sourceB, sourceC, sourceN, sourceZ, sourceX].map((source) => [
    source.id,
    source,
  ]),
);

const a1: Clip = { id: "a1", sourceId: "A" };
const a2: Clip = { id: "a2", sourceId: "A" };
const b1: Clip = { id: "b1", sourceId: "B" };
const c1: Clip = { id: "c1", sourceId: "C" };
const n1: Clip = { id: "n1", sourceId: "N" };
const z1: Clip = { id: "z1", sourceId: "Z" };
const x1: Clip = { id: "x1", sourceId: "X" };

const abc = [a1, b1, c1];

function segment(
  id: string,
  inClipId: string,
  inPts: string,
  outClipId: string,
  outPts: string,
): SequenceSegment {
  return { id, inClipId, inPts: pts(inPts), outClipId, outPts: pts(outPts) };
}

function idGenerator(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `new-${next}`;
  };
}

/** Every source interval of an edit, in export order. A clip operation must keep this list. */
function exportedPieces(edit: SequenceEdit) {
  return edit.segments.flatMap((entry) => {
    const pieces = expandSegment(entry, edit.clips, sources);
    if (pieces === null) {
      throw new Error(`segment ${entry.id} is not valid`);
    }
    return pieces;
  });
}

describe("clip ranges", () => {
  it("reads the whole source", () => {
    expect(clipRange(a1, sources)).toEqual({ startPts: "-1800", endPts: "898200" });
    expect(clipRange(n1, sources)).toEqual({ startPts: "0", endPts: null });
  });

  it("has no range without a start or a source", () => {
    expect(clipRange(z1, sources)).toBeNull();
    expect(clipRange({ id: "q", sourceId: "missing" }, sources)).toBeNull();
  });

  it("reads an end that is not after the start as unknown", () => {
    const broken = new Map([["A", { ...sourceA, videoEndPts: pts("-1800") }]]);
    expect(clipRange(a1, broken)).toEqual({ startPts: "-1800", endPts: null });
  });
});

describe("layoutSequence", () => {
  it("adds exact extents across time bases", () => {
    const layout = layoutSequence(abc, sources);
    expect(layout?.placements.map((entry) => entry.startSeconds)).toEqual([0, 10, 15]);
    expect(layout?.placements.map((entry) => entry.start)).toEqual([
      { n: 0n, d: 1n },
      { n: 10n, d: 1n },
      { n: 15n, d: 1n },
    ]);
    expect(layout?.total).toEqual({ n: 19n, d: 1n });
    expect(layout?.totalSeconds).toBe(19);
    expect(layout?.exact).toBe(true);
  });

  it("falls back to the reported extent and marks the layout approximate", () => {
    const layout = layoutSequence([n1, b1], sources);
    expect(layout?.placements[0]?.exactDuration).toBe(false);
    expect(layout?.placements[1]?.startSeconds).toBe(3);
    expect(layout?.exact).toBe(false);
  });

  it("uses a browser duration last", () => {
    const layout = layoutSequence([x1, b1], sources, new Map([["X", 2.5]]));
    expect(layout?.placements[1]?.startSeconds).toBe(2.5);
  });

  it("refuses a clip with no extent before another clip", () => {
    expect(layoutSequence([x1, b1], sources)).toBeNull();
  });

  it("refuses a clip with no extent after another clip too", () => {
    // A later move could put it first, so ADR 052 refuses it anywhere next to another clip.
    expect(layoutSequence([b1, x1], sources)).toBeNull();
  });

  it("leaves the total unknown for a single clip with no extent", () => {
    const layout = layoutSequence([x1], sources);
    expect(layout?.placements[0]?.startSeconds).toBe(0);
    expect(layout?.placements[0]?.duration).toBeNull();
    expect(layout?.total).toBeNull();
    expect(layout?.totalSeconds).toBeNull();
  });

  it("skips a zero extent for the next fallback", () => {
    const zero = new Map([
      [
        "X",
        { ...sourceX, videoDurationTicks: ticks("0"), approximateDurationSeconds: 0 },
      ],
      ["B", sourceB],
    ]);
    expect(layoutSequence([x1, b1], zero)).toBeNull();
    expect(layoutSequence([x1, b1], zero, new Map([["X", 0]]))).toBeNull();
    expect(
      layoutSequence([x1, b1], zero, new Map([["X", 1.5]]))?.placements[1]
        ?.startSeconds,
    ).toBe(1.5);
  });

  it("refuses an unknown source and lays out an empty sequence", () => {
    expect(layoutSequence([{ id: "q", sourceId: "missing" }], sources)).toBeNull();
    expect(layoutSequence([], sources)?.totalSeconds).toBe(0);
  });
});

describe("locate and toSequenceTime", () => {
  const layout = layoutSequence(abc, sources);
  if (layout === null) {
    throw new Error("layout");
  }

  it("gives a junction to the later clip", () => {
    expect(locate(layout, 9.999)).toEqual({
      clipId: "a1",
      index: 0,
      elapsedSeconds: 9.999,
    });
    expect(locate(layout, 10)).toEqual({ clipId: "b1", index: 1, elapsedSeconds: 0 });
    expect(locate(layout, 18)).toEqual({ clipId: "c1", index: 2, elapsedSeconds: 3 });
  });

  it("gives a time after the end to the last clip, and refuses a negative time", () => {
    expect(locate(layout, 25)).toEqual({ clipId: "c1", index: 2, elapsedSeconds: 10 });
    expect(locate(layout, -0.001)).toBeNull();
    expect(locate(layout, Number.NaN)).toBeNull();
    const empty = layoutSequence([], sources);
    expect(empty && locate(empty, 0)).toBeNull();
  });

  it("maps an edit point to exact sequence time", () => {
    expect(
      toSequenceTime(layout, abc, sources, { clipId: "b1", pts: pts("2500") }),
    ).toEqual({
      n: 25n,
      d: 2n,
    });
    expect(
      toSequenceSeconds(layout, abc, sources, { clipId: "c1", pts: pts("134400") }),
    ).toBe(15.5);
    expect(
      toSequenceSeconds(layout, abc, sources, { clipId: "a1", pts: pts("-1800") }),
    ).toBe(0);
    expect(
      toSequenceTime(layout, abc, sources, { clipId: "zz", pts: pts("0") }),
    ).toBeNull();
    // A PTS outside the clip would land in a neighbouring clip, so it has no sequence time.
    expect(
      toSequenceTime(layout, abc, sources, { clipId: "b1", pts: pts("5001") }),
    ).toBeNull();
    expect(
      toSequenceTime(layout, abc, sources, { clipId: "b1", pts: pts("5000") }),
    ).toEqual({
      n: 15n,
      d: 1n,
    });
  });
});

describe("edit point order", () => {
  it("treats the end of a clip and the start of the next clip as one point", () => {
    expect(
      compareEditPoints(
        { clipId: "a1", pts: pts("898200") },
        { clipId: "b1", pts: pts("0") },
        abc,
        sources,
      ),
    ).toBe(0);
  });

  it("orders clips before PTS and PTS on one clip", () => {
    const early = { clipId: "a1", pts: pts("800000") };
    const late = { clipId: "b1", pts: pts("1") };
    expect(compareEditPoints(early, late, abc, sources)).toBeLessThan(0);
    expect(compareEditPoints(late, early, abc, sources)).toBeGreaterThan(0);
    expect(
      compareEditPoints(
        { clipId: "b1", pts: pts("10") },
        { clipId: "b1", pts: pts("20") },
        abc,
        sources,
      ),
    ).toBeLessThan(0);
    expect(
      compareEditPoints(early, { clipId: "zz", pts: pts("0") }, abc, sources),
    ).toBeNull();
  });

  it("keeps the end of the last clip as its own point", () => {
    expect(
      compareEditPoints(
        { clipId: "c1", pts: pts("179200") },
        { clipId: "c1", pts: pts("179199") },
        abc,
        sources,
      ),
    ).toBeGreaterThan(0);
  });
});

describe("the one form of a boundary", () => {
  it("moves an In at the end of a clip to the start of the next clip", () => {
    expect(canonicalIn({ clipId: "a1", pts: pts("898200") }, abc, sources)).toEqual({
      clipId: "b1",
      pts: "0",
    });
    expect(canonicalIn({ clipId: "b1", pts: pts("100") }, abc, sources)).toEqual({
      clipId: "b1",
      pts: "100",
    });
    expect(canonicalIn({ clipId: "c1", pts: pts("179200") }, abc, sources)).toBeNull();
  });

  it("moves an Out on the first frame of a clip to the end of the clip before it", () => {
    expect(canonicalOut({ clipId: "b1", pts: pts("0") }, abc, sources)).toEqual({
      clipId: "a1",
      pts: "898200",
    });
    expect(canonicalOut({ clipId: "b1", pts: pts("1") }, abc, sources)).toEqual({
      clipId: "b1",
      pts: "1",
    });
  });

  it("refuses a point that its clip does not hold", () => {
    expect(canonicalIn({ clipId: "b1", pts: pts("9999") }, abc, sources)).toBeNull();
    expect(canonicalOut({ clipId: "b1", pts: pts("-5") }, abc, sources)).toBeNull();
    expect(canonicalIn({ clipId: "zz", pts: pts("0") }, abc, sources)).toBeNull();
  });

  it("has no next start after a clip whose neighbour has no range", () => {
    expect(
      canonicalIn({ clipId: "a1", pts: pts("898200") }, [a1, z1, b1], sources),
    ).toBeNull();
    // The end of a1 then stays its own point, before every point of b1.
    expect(
      compareEditPoints(
        { clipId: "a1", pts: pts("898200") },
        { clipId: "b1", pts: pts("0") },
        [a1, z1, b1],
        sources,
      ),
    ).toBeLessThan(0);
  });

  it("has no Out on the first frame of the first clip or after an unknown end", () => {
    expect(canonicalOut({ clipId: "a1", pts: pts("-1800") }, abc, sources)).toBeNull();
    expect(canonicalOut({ clipId: "b1", pts: pts("0") }, [n1, b1], sources)).toBeNull();
  });
});

describe("isValidSequenceSegment", () => {
  it("keeps the rules of one clip", () => {
    expect(
      isValidSequenceSegment(segment("s", "b1", "0", "b1", "1"), abc, sources),
    ).toBe(true);
    expect(
      isValidSequenceSegment(segment("s", "b1", "10", "b1", "10"), abc, sources),
    ).toBe(false);
    expect(
      isValidSequenceSegment(segment("s", "b1", "-1", "b1", "10"), abc, sources),
    ).toBe(false);
  });

  it("allows an Out at the end of a clip and refuses the other forms of a junction", () => {
    expect(
      isValidSequenceSegment(segment("s", "b1", "0", "b1", "5000"), abc, sources),
    ).toBe(true);
    expect(
      isValidSequenceSegment(segment("s", "b1", "0", "b1", "5001"), abc, sources),
    ).toBe(false);
    expect(
      isValidSequenceSegment(segment("s", "a1", "898200", "b1", "10"), abc, sources),
    ).toBe(false);
    expect(
      isValidSequenceSegment(segment("s", "a1", "0", "b1", "0"), abc, sources),
    ).toBe(false);
  });

  it("allows a crossing in sequence order only", () => {
    expect(
      isValidSequenceSegment(segment("s", "a1", "0", "c1", "130000"), abc, sources),
    ).toBe(true);
    expect(
      isValidSequenceSegment(segment("s", "b1", "0", "a1", "100"), abc, sources),
    ).toBe(false);
  });

  it("refuses a crossing after an unknown end or through a clip with no range", () => {
    expect(
      isValidSequenceSegment(segment("s", "n1", "0", "b1", "10"), [n1, b1], sources),
    ).toBe(false);
    expect(
      isValidSequenceSegment(
        segment("s", "a1", "0", "b1", "10"),
        [a1, z1, b1],
        sources,
      ),
    ).toBe(false);
  });

  it("does not bound a boundary by an unknown end", () => {
    expect(
      isValidSequenceSegment(segment("s", "n1", "0", "n1", "99999"), [n1], sources),
    ).toBe(true);
  });

  it("refuses unknown clips", () => {
    expect(
      isValidSequenceSegment(segment("s", "q", "0", "b1", "10"), abc, sources),
    ).toBe(false);
  });
});

describe("expandSegment", () => {
  it("gives one piece for a segment on one clip", () => {
    expect(expandSegment(segment("s", "b1", "100", "b1", "200"), abc, sources)).toEqual(
      [{ clipId: "b1", sourceId: "B", inPts: "100", outPts: "200" }],
    );
  });

  it("gives the In part, each whole clip between, and the Out part", () => {
    expect(
      expandSegment(segment("s", "a1", "45000", "c1", "140800"), abc, sources),
    ).toEqual([
      { clipId: "a1", sourceId: "A", inPts: "45000", outPts: "898200" },
      { clipId: "b1", sourceId: "B", inPts: "0", outPts: "5000" },
      { clipId: "c1", sourceId: "C", inPts: "128000", outPts: "140800" },
    ]);
  });

  it("keeps two clips of one source apart", () => {
    // An Out on the first frame of a2 is not the one form, so the segment is not valid.
    expect(
      expandSegment(segment("s", "a1", "800000", "a2", "-1800"), [a1, a2], sources),
    ).toBeNull();
    expect(
      expandSegment(segment("s", "a1", "800000", "a2", "9000"), [a1, a2], sources),
    ).toEqual([
      { clipId: "a1", sourceId: "A", inPts: "800000", outPts: "898200" },
      { clipId: "a2", sourceId: "A", inPts: "-1800", outPts: "9000" },
    ]);
  });

  it("sums the duration of the pieces in their own time bases", () => {
    // 9.5 s of A and 1 s of B.
    expect(
      sequenceSegmentDuration(segment("s", "a1", "43200", "b1", "1000"), abc, sources),
    ).toEqual({ n: 21n, d: 2n });
    expect(
      sequenceSegmentDuration(segment("s", "b1", "9", "b1", "9"), abc, sources),
    ).toBeNull();
  });
});

describe("splitSegmentsAtJunctions", () => {
  it("splits at each crossed junction and keeps the parts in place", () => {
    const segments = [
      segment("before", "b1", "0", "b1", "10"),
      segment("long", "a1", "0", "c1", "130000"),
      segment("after", "c1", "130000", "c1", "140000"),
    ];
    const result = splitSegmentsAtJunctions(
      segments,
      [2, 1, 0, 3],
      abc,
      sources,
      idGenerator(),
    );
    expect(result).toEqual([
      segment("before", "b1", "0", "b1", "10"),
      segment("long", "a1", "0", "a1", "898200"),
      segment("new-1", "b1", "0", "b1", "5000"),
      segment("new-2", "c1", "128000", "c1", "130000"),
      segment("after", "c1", "130000", "c1", "140000"),
    ]);
    expect(result?.every((entry) => isValidSequenceSegment(entry, abc, sources))).toBe(
      true,
    );
  });

  it("does not split a segment that ends or starts on the junction", () => {
    const segments = [
      segment("ends", "a1", "0", "a1", "898200"),
      segment("starts", "b1", "0", "b1", "10"),
    ];
    expect(
      splitSegmentsAtJunctions(segments, [1], abc, sources, idGenerator()),
    ).toEqual(segments);
  });
});

describe("insertClips", () => {
  const edit: SequenceEdit = {
    clips: [a1, b1],
    segments: [
      segment("cross", "a1", "0", "b1", "1000"),
      segment("in-b", "b1", "1000", "b1", "2000"),
    ],
  };

  it("splits a segment across the insertion junction and keeps every piece", () => {
    const result = insertClips(edit, 1, [c1], sources, idGenerator());
    expect(result?.clips.map((clip) => clip.id)).toEqual(["a1", "c1", "b1"]);
    expect(result?.segments.map((entry) => entry.id)).toEqual([
      "cross",
      "new-1",
      "in-b",
    ]);
    expect(result && exportedPieces(result)).toEqual(exportedPieces(edit));
  });

  it("adds at the start and at the end without a split", () => {
    expect(insertClips(edit, 0, [c1], sources, idGenerator())?.segments).toEqual(
      edit.segments,
    );
    expect(
      insertClips(edit, 2, [c1], sources, idGenerator())?.clips.map((clip) => clip.id),
    ).toEqual(["a1", "b1", "c1"]);
  });

  it("refuses an index out of range", () => {
    expect(insertClips(edit, 3, [c1], sources, idGenerator())).toBeNull();
    expect(insertClips(edit, -1, [c1], sources, idGenerator())).toBeNull();
  });

  it("changes nothing for an empty list and refuses a clip ID twice", () => {
    expect(insertClips(edit, 1, [], sources, idGenerator())).toBe(edit);
    expect(
      insertClips(edit, 1, [{ id: "a1", sourceId: "C" }], sources, idGenerator()),
    ).toBeNull();
    expect(insertClips(edit, 1, [c1, c1], sources, idGenerator())).toBeNull();
  });

  it("refuses a segment that is not valid on input", () => {
    const broken: SequenceEdit = {
      clips: [a1, b1],
      segments: [segment("bad", "a1", "898200", "b1", "10")],
    };
    expect(insertClips(broken, 1, [c1], sources, idGenerator())).toBeNull();
    expect(
      splitSegmentsAtJunctions(
        broken.segments,
        [1],
        broken.clips,
        sources,
        idGenerator(),
      ),
    ).toBeNull();
    expect(removeClip(broken, 0, sources)).toBeNull();
  });
});

describe("moveClip", () => {
  const edit: SequenceEdit = {
    clips: abc,
    segments: [
      segment("whole", "a1", "0", "c1", "130000"),
      segment("in-a", "a1", "100", "a1", "200"),
      segment("ab", "a1", "800000", "b1", "2000"),
      segment("bc", "b1", "4000", "c1", "129000"),
    ],
  };

  it("changes nothing for a move to either junction of the clip", () => {
    expect(moveClip(edit, 1, 1, sources, idGenerator())).toBe(edit);
    expect(moveClip(edit, 1, 2, sources, idGenerator())).toBe(edit);
  });

  it("moves a clip to the start and keeps the frames of every segment", () => {
    const result = moveClip(edit, 2, 0, sources, idGenerator());
    expect(result?.clips.map((clip) => clip.id)).toEqual(["c1", "a1", "b1"]);
    expect(result && exportedPieces(result)).toEqual(exportedPieces(edit));
    expect(
      result?.segments.every((entry) =>
        isValidSequenceSegment(entry, result.clips, sources),
      ),
    ).toBe(true);
  });

  it("moves a clip to the end and keeps the frames of every segment", () => {
    const result = moveClip(edit, 0, 3, sources, idGenerator());
    expect(result?.clips.map((clip) => clip.id)).toEqual(["b1", "c1", "a1"]);
    expect(result && exportedPieces(result)).toEqual(exportedPieces(edit));
    // The first part keeps the ID, and the parts stay together in array order.
    // Only the junction after a1 lies inside the sequence. b1 and c1 stay neighbours, so "whole"
    // and "bc" keep their crossing of that junction.
    expect(result?.segments.map((entry) => entry.id)).toEqual([
      "whole",
      "new-1",
      "in-a",
      "ab",
      "new-2",
      "bc",
    ]);
  });

  it("moves to an inner junction of four clips and keeps every frame", () => {
    const d1: Clip = { id: "d1", sourceId: "B" };
    const four: SequenceEdit = {
      clips: [a1, b1, c1, d1],
      segments: [
        segment("all", "a1", "0", "d1", "3000"),
        segment("bc", "b1", "4000", "c1", "129000"),
        segment("cd", "c1", "170000", "d1", "100"),
      ],
    };
    const forward = moveClip(four, 0, 2, sources, idGenerator());
    expect(forward?.clips.map((clip) => clip.id)).toEqual(["b1", "a1", "c1", "d1"]);
    expect(forward && exportedPieces(forward)).toEqual(exportedPieces(four));
    const backward = moveClip(four, 3, 1, sources, idGenerator());
    expect(backward?.clips.map((clip) => clip.id)).toEqual(["a1", "d1", "b1", "c1"]);
    expect(backward && exportedPieces(backward)).toEqual(exportedPieces(four));
    for (const result of [forward, backward]) {
      expect(
        result?.segments.every((entry) =>
          isValidSequenceSegment(entry, result.clips, sources),
        ),
      ).toBe(true);
    }
  });

  it("keeps the placements of two clips of one source apart", () => {
    const twice: SequenceEdit = {
      clips: [a1, b1, a2],
      segments: [
        segment("a1-part", "a1", "100", "a1", "200"),
        segment("b-to-a2", "b1", "4000", "a2", "9000"),
      ],
    };
    const moved = moveClip(twice, 2, 0, sources, idGenerator());
    expect(moved?.clips.map((clip) => clip.id)).toEqual(["a2", "a1", "b1"]);
    expect(moved && exportedPieces(moved)).toEqual(exportedPieces(twice));
    expect(moved?.segments.find((entry) => entry.id === "new-1")?.inClipId).toBe("a2");
    const removed = removeClip(twice, 0, sources);
    expect(removed?.segments.map((entry) => entry.id)).toEqual(["b-to-a2"]);
  });

  it("refuses an index out of range", () => {
    expect(moveClip(edit, 3, 0, sources, idGenerator())).toBeNull();
    expect(moveClip(edit, 0, 4, sources, idGenerator())).toBeNull();
  });
});

describe("removeClip", () => {
  const edit: SequenceEdit = {
    clips: abc,
    segments: [
      segment("only-b", "b1", "100", "b1", "200"),
      segment("ends-in-b", "a1", "800000", "b1", "2000"),
      segment("starts-in-b", "b1", "4000", "c1", "129000"),
      segment("across-b", "a1", "0", "c1", "130000"),
      segment("only-a", "a1", "100", "a1", "200"),
    ],
  };

  it("removes the frames of the clip and keeps every other frame", () => {
    const result = removeClip(edit, 1, sources);
    expect(result?.clips.map((clip) => clip.id)).toEqual(["a1", "c1"]);
    expect(result?.segments).toEqual([
      segment("ends-in-b", "a1", "800000", "a1", "898200"),
      segment("starts-in-b", "c1", "128000", "c1", "129000"),
      segment("across-b", "a1", "0", "c1", "130000"),
      segment("only-a", "a1", "100", "a1", "200"),
    ]);
    expect(
      result?.segments.every((entry) =>
        isValidSequenceSegment(entry, result.clips, sources),
      ),
    ).toBe(true);
  });

  it("moves an In to the next clip when the first clip goes", () => {
    const result = removeClip(edit, 0, sources);
    expect(result?.segments.find((entry) => entry.id === "ends-in-b")).toEqual(
      segment("ends-in-b", "b1", "0", "b1", "2000"),
    );
    expect(result?.segments.find((entry) => entry.id === "only-a")).toBeUndefined();
  });

  it("leaves a valid Out at the end of the clip that becomes the last clip", () => {
    const result = removeClip(edit, 2, sources);
    expect(result?.segments.find((entry) => entry.id === "starts-in-b")).toEqual(
      segment("starts-in-b", "b1", "4000", "b1", "5000"),
    );
    expect(
      result?.segments.every((entry) =>
        isValidSequenceSegment(entry, result.clips, sources),
      ),
    ).toBe(true);
  });

  it("keeps a crossing whose last clip has an unknown end", () => {
    const withUnknownEnd: SequenceEdit = {
      clips: [a1, b1, n1],
      segments: [segment("a-to-n", "a1", "0", "n1", "1000")],
    };
    const result = removeClip(withUnknownEnd, 1, sources);
    expect(result?.segments).toEqual([segment("a-to-n", "a1", "0", "n1", "1000")]);
    expect(
      result?.segments.every((entry) =>
        isValidSequenceSegment(entry, result.clips, sources),
      ),
    ).toBe(true);
  });

  it("refuses an index out of range", () => {
    expect(removeClip(edit, 3, sources)).toBeNull();
  });
});
