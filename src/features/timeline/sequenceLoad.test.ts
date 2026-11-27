import { describe, expect, it } from "vitest";
import { I64_MAX } from "@/lib/time";
import type { Clip, Pts, SequenceSegment, TickCount } from "@/types/project";
import type { SequenceSource } from "./sequence";
import { checkSequenceLoad } from "./sequenceLoad";

const pts = (value: string) => value as Pts;
const ticks = (value: string) => value as TickCount;

/** A source of 10 s in milliseconds, with an exact end unless `end` is null. */
function source(id: string, overrides: Partial<SequenceSource> = {}): SequenceSource {
  return {
    id,
    videoTimeBase: { n: 1, d: 1000 },
    videoStartPts: pts("0"),
    videoEndPts: pts("10000"),
    videoDurationTicks: ticks("10000"),
    approximateDurationSeconds: 10,
    ...overrides,
  };
}

/** A source with no extent at all. */
function sourceWithoutExtent(id: string): SequenceSource {
  return source(id, {
    videoEndPts: null,
    videoDurationTicks: null,
    approximateDurationSeconds: null,
  });
}

function segment(
  id: string,
  inClipId: string,
  inPts: string,
  outClipId: string,
  outPts: string,
): SequenceSegment {
  return { id, inClipId, inPts: pts(inPts), outClipId, outPts: pts(outPts) };
}

const A: Clip = { id: "c1", sourceId: "a" };
const B: Clip = { id: "c2", sourceId: "b" };

describe("checkSequenceLoad", () => {
  it("accepts an empty sequence, and a sequence with segments that keep the rules", () => {
    expect(checkSequenceLoad([], [], [])).toEqual({ ok: true });
    // A source that no clip names is allowed.
    expect(checkSequenceLoad([], [source("a")], [])).toEqual({ ok: true });
    expect(
      checkSequenceLoad(
        [A, B],
        [source("a"), source("b")],
        [
          segment("g1", "c1", "1000", "c1", "2000"),
          // A segment across the junction, with its Out at the end of the last clip.
          { ...segment("g2", "c1", "9000", "c2", "10000"), name: "Intro" },
        ],
      ),
    ).toEqual({ ok: true });
  });

  it("accepts one clip with no extent, as the store does", () => {
    expect(
      checkSequenceLoad(
        [A],
        [sourceWithoutExtent("a")],
        [segment("g1", "c1", "1000", "c1", "2000")],
      ),
    ).toEqual({ ok: true });
  });

  it("refuses repeated identifiers", () => {
    expect(checkSequenceLoad([A], [source("a"), source("a")], [])).toEqual({
      ok: false,
      problem: { kind: "duplicateSource", sourceId: "a" },
    });
    expect(
      checkSequenceLoad([A, { id: "c1", sourceId: "a" }], [source("a")], []),
    ).toEqual({ ok: false, problem: { kind: "duplicateClip", clipId: "c1" } });
    expect(
      checkSequenceLoad(
        [A],
        [source("a")],
        [
          segment("g1", "c1", "1000", "c1", "2000"),
          segment("g1", "c1", "3000", "c1", "4000"),
        ],
      ),
    ).toEqual({ ok: false, problem: { kind: "duplicateSegment", segmentId: "g1" } });
  });

  it("refuses a clip whose source is not in the list", () => {
    expect(checkSequenceLoad([A, B], [source("a")], [])).toEqual({
      ok: false,
      problem: { kind: "unknownSource", clipId: "c2", sourceId: "b" },
    });
  });

  it("names the clip with no extent next to another clip, and its source", () => {
    expect(
      checkSequenceLoad([A, B], [source("a"), sourceWithoutExtent("b")], []),
    ).toEqual({
      ok: false,
      problem: { kind: "clipExtentUnknown", clipId: "c2", sourceId: "b" },
    });
    expect(
      checkSequenceLoad([B, A], [source("a"), sourceWithoutExtent("b")], []),
    ).toEqual({
      ok: false,
      problem: { kind: "clipExtentUnknown", clipId: "c2", sourceId: "b" },
    });
  });

  it("refuses a sequence with no virtual axis", () => {
    // The start of the second clip leaves the range of a PTS.
    const huge = source("a", {
      videoStartPts: pts("0"),
      videoEndPts: pts(I64_MAX.toString()),
      videoTimeBase: { n: 1, d: 1 },
    });
    expect(checkSequenceLoad([A, B], [huge, source("b")], [])).toEqual({
      ok: false,
      problem: { kind: "layoutFailed" },
    });
  });

  it("refuses a segment name that is not valid", () => {
    expect(
      checkSequenceLoad(
        [A],
        [source("a")],
        [{ ...segment("g1", "c1", "1000", "c1", "2000"), name: " padded " }],
      ),
    ).toEqual({ ok: false, problem: { kind: "invalidSegmentName", segmentId: "g1" } });
  });

  it("refuses each segment that breaks a rule of ADR 052", () => {
    const cases: SequenceSegment[] = [
      // Not on the sequence.
      segment("g", "c9", "1000", "c9", "2000"),
      // No frame.
      segment("g", "c1", "2000", "c1", "2000"),
      // In at the end of a clip, and Out at the start of a clip: not the one form.
      segment("g", "c1", "10000", "c2", "1000"),
      segment("g", "c1", "1000", "c2", "0"),
      // Out of the range.
      segment("g", "c1", "-1", "c1", "2000"),
      segment("g", "c2", "1000", "c2", "10001"),
      // The In clip after the Out clip.
      segment("g", "c2", "1000", "c1", "2000"),
    ];
    for (const bad of cases) {
      expect(checkSequenceLoad([A, B], [source("a"), source("b")], [bad])).toEqual({
        ok: false,
        problem: { kind: "invalidSegment", segmentId: "g" },
      });
    }
    // A segment with no clip at all.
    expect(
      checkSequenceLoad([], [], [segment("g", "c1", "1000", "c1", "2000")]),
    ).toEqual({ ok: false, problem: { kind: "invalidSegment", segmentId: "g" } });
    // No segment can cross the end of a clip that has no known end.
    expect(
      checkSequenceLoad(
        [A, B],
        [source("a", { videoEndPts: null }), source("b")],
        [segment("g", "c1", "1000", "c2", "2000")],
      ),
    ).toEqual({ ok: false, problem: { kind: "invalidSegment", segmentId: "g" } });
  });
});
