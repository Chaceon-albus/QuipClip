import { describe, expect, it } from "vitest";
import type { Clip, Pts, Segment, SequenceSegment } from "@/types/project";
import {
  exportSegmentIds,
  isSequenceExport,
  oneClipExportSegments,
  selectExportSegmentCount,
  selectExportSegmentIds,
  sequenceExportSegments,
  type ExportSegmentsInput,
} from "./exportSegments";
import type { SequenceSource } from "./sequence";

const pts = (value: string) => value as Pts;

const source = (id: string, end: string): SequenceSource => ({
  id,
  videoTimeBase: { n: 1, d: 1000 },
  videoStartPts: pts("0"),
  videoEndPts: pts(end),
  videoDurationTicks: null,
  approximateDurationSeconds: null,
});

const on = (
  id: string,
  inClipId: string,
  inPts: string,
  outClipId: string,
  outPts: string,
): SequenceSegment => ({
  id,
  inClipId,
  inPts: pts(inPts),
  outClipId,
  outPts: pts(outPts),
});

const derived = (id: string, sourceId: string): Segment => ({
  id,
  sourceId,
  inPts: pts("0"),
  outPts: pts("10"),
});

const a1: Clip = { id: "a1", sourceId: "A" };
const b1: Clip = { id: "b1", sourceId: "B" };
const SOURCES = { A: source("A", "10000"), B: source("B", "5000") };

/** A state of several clips: `x`, a dormant segment, a segment across the junction, and `y`. */
function severalClips(): ExportSegmentsInput {
  return {
    clips: [a1, b1],
    sequenceSources: SOURCES,
    sequenceSegments: [
      on("x", "a1", "0", "a1", "1000"),
      on("dormant", "c1", "0", "c1", "1000"),
      on("cross", "a1", "9000", "b1", "1000"),
      on("y", "b1", "2000", "b1", "3000"),
    ],
    // The derived array does not decide an export of several clips.
    segments: [],
    sourceId: "sequence:1",
  };
}

describe("isSequenceExport", () => {
  it("reads the anchored segments only for several clips, as composeExportRequest", () => {
    expect(isSequenceExport([])).toBe(false);
    expect(isSequenceExport([a1])).toBe(false);
    expect(isSequenceExport([a1, b1])).toBe(true);
  });
});

describe("sequenceExportSegments", () => {
  it("keeps the live segments in array order, each with its pieces", () => {
    const state = severalClips();
    const entries = sequenceExportSegments(
      state.clips,
      state.sequenceSegments,
      new Map(Object.entries(SOURCES)),
    );
    expect(entries.map((entry) => entry.segment.id)).toEqual(["x", "cross", "y"]);
    expect(entries[1]?.pieces).toEqual([
      { clipId: "a1", sourceId: "A", inPts: "9000", outPts: "10000" },
      { clipId: "b1", sourceId: "B", inPts: "0", outPts: "1000" },
    ]);
  });
});

describe("oneClipExportSegments", () => {
  it("keeps the segments of the active source in array order", () => {
    const segments = [derived("a", "s"), derived("old", "t"), derived("b", "s")];
    expect(oneClipExportSegments(segments, "s").map((segment) => segment.id)).toEqual([
      "a",
      "b",
    ]);
    expect(oneClipExportSegments(segments, null)).toEqual([]);
  });
});

describe("exportSegmentIds", () => {
  it("reads the derived segments of the active source for one clip", () => {
    expect(
      exportSegmentIds({
        clips: [a1],
        sequenceSources: SOURCES,
        // The anchored array does not decide an export of one clip.
        sequenceSegments: [on("anchored", "a1", "0", "a1", "1000")],
        segments: [derived("a", "s"), derived("old", "t"), derived("b", "s")],
        sourceId: "s",
      }),
    ).toEqual(["a", "b"]);
  });

  it("reads the live anchored segments for several clips", () => {
    expect(exportSegmentIds(severalClips())).toEqual(["x", "cross", "y"]);
  });

  it("is empty with no clip", () => {
    expect(
      exportSegmentIds({
        clips: [],
        sequenceSources: {},
        sequenceSegments: [],
        segments: [],
        sourceId: null,
      }),
    ).toEqual([]);
  });
});

describe("selectExportSegmentIds", () => {
  it("returns one array while the inputs keep their identity", () => {
    const state = severalClips();
    const first = selectExportSegmentIds(state);
    expect(first).toEqual(["x", "cross", "y"]);
    expect(selectExportSegmentIds({ ...state })).toBe(first);
  });

  it("returns the array before for a new input with the same ids in the same order", () => {
    const state = severalClips();
    const first = selectExportSegmentIds(state);
    // A trim gives a new array of segments, with the same ids.
    const trimmed = {
      ...state,
      sequenceSegments: state.sequenceSegments.map((segment) =>
        segment.id === "y" ? { ...segment, outPts: pts("4000") } : segment,
      ),
    };
    expect(selectExportSegmentIds(trimmed)).toBe(first);
  });

  it("returns a new array for a new order or a new set of ids", () => {
    const state = severalClips();
    const first = selectExportSegmentIds(state);
    const [x, dormant, cross, y] = state.sequenceSegments;
    if (
      x === undefined ||
      dormant === undefined ||
      cross === undefined ||
      y === undefined
    ) {
      throw new Error("missing segment");
    }
    const reordered = selectExportSegmentIds({
      ...state,
      sequenceSegments: [y, dormant, cross, x],
    });
    expect(reordered).not.toBe(first);
    expect(reordered).toEqual(["y", "cross", "x"]);
    expect(selectExportSegmentCount({ ...state, sequenceSegments: [x] })).toBe(1);
  });
});
