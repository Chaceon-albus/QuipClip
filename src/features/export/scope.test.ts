import { describe, expect, it } from "vitest";
import {
  createOneClipTimelineStore,
  TEST_CLIP_ID,
  TEST_SOURCE,
} from "@/features/timeline/storeTestSupport";
import {
  exportSegmentIds,
  selectExportSegmentCount,
  type ExportSegmentsInput,
} from "@/features/timeline/exportSegments";
import type { SequenceSource } from "@/features/timeline/sequence";
import { totalExportSegments } from "@/features/timeline/segmentTotal";
import { MILLISECONDS_TIMECODE_DISPLAY } from "@/lib/timecode";
import type { Clip, Pts, SequenceSegment } from "@/types/project";
import {
  createSegmentListScope,
  narrowToExportScope,
  resolveExportScope,
  scopeSourceIds,
  WHOLE_EXPORT_SCOPE,
  type ExportScope,
} from "./scope";

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
  name?: string,
): SequenceSegment => ({
  id,
  inClipId,
  inPts: pts(inPts),
  outClipId,
  outPts: pts(outPts),
  ...(name === undefined ? {} : { name }),
});

const a1: Clip = { id: "a1", sourceId: "A" };
const b1: Clip = { id: "b1", sourceId: "B" };

/**
 * Clips a1 (A) and b1 (B): `x` on a1, a dormant segment, `cross` from a1 into b1, and `y` on b1.
 * The export takes x, cross and y, in that order (ADR 066).
 */
function severalClips(
  segments: readonly SequenceSegment[] = [
    on("x", "a1", "0", "a1", "1000", "Intro"),
    on("dormant", "c1", "0", "c1", "1000"),
    on("cross", "a1", "9000", "b1", "1000"),
    on("y", "b1", "2000", "b1", "3000"),
  ],
): ExportSegmentsInput {
  return {
    clips: [a1, b1],
    sequenceSources: { A: source("A", "10000"), B: source("B", "5000") },
    sequenceSegments: [...segments],
    segments: [],
    sourceId: "sequence:1",
  };
}

/** One clip with segments a, b and c, from the production timeline store. */
function oneClip() {
  return createOneClipTimelineStore({
    segments: [
      { id: "a", inPts: pts("0"), outPts: pts("90000") },
      { id: "b", inPts: pts("180000"), outPts: pts("270000") },
      { id: "c", inPts: pts("360000"), outPts: pts("450000") },
    ],
  });
}

const ids = (scope: ExportScope, input: ExportSegmentsInput) =>
  resolveExportScope(input, scope).segments.map((segment) => segment.id);

describe("resolveExportScope", () => {
  it("gives every segment of the export for the whole export, as exportSegmentIds", () => {
    const sequence = severalClips();
    expect(ids(WHOLE_EXPORT_SCOPE, sequence)).toStrictEqual(exportSegmentIds(sequence));
    const state = oneClip().getState();
    expect(ids(WHOLE_EXPORT_SCOPE, state)).toStrictEqual(["a", "b", "c"]);
    expect(resolveExportScope(state, WHOLE_EXPORT_SCOPE).valid).toBe(true);
  });

  it("gives exactly the segments of a list in export order with several clips", () => {
    const sequence = severalClips();
    // The order of the list has no effect.
    const scope = createSegmentListScope(sequence, ["y", "x"]);
    const resolved = resolveExportScope(sequence, scope);
    expect(resolved.valid).toBe(true);
    expect(resolved.segments.map((segment) => segment.id)).toStrictEqual(["x", "y"]);
    // The number is the number among all the segments of the export, as the bar shows it.
    expect(resolved.segments.map((segment) => segment.number)).toStrictEqual([1, 3]);
    expect(resolved.segments[0]?.name).toBe("Intro");
    expect(resolved.segments[1]?.pieces).toStrictEqual([
      { clipId: "b1", sourceId: "B", inPts: "2000", outPts: "3000" },
    ]);
    // A segment across the junction gives a piece on each clip.
    const cross = resolveExportScope(
      sequence,
      createSegmentListScope(sequence, ["cross"]),
    );
    expect(cross.segments[0]?.pieces).toStrictEqual([
      { clipId: "a1", sourceId: "A", inPts: "9000", outPts: "10000" },
      { clipId: "b1", sourceId: "B", inPts: "0", outPts: "1000" },
    ]);
    expect(scopeSourceIds(cross.segments)).toStrictEqual(["A", "B"]);
  });

  it("gives exactly the segments of a list in export order with one clip", () => {
    const state = oneClip().getState();
    const scope = createSegmentListScope(state, ["c", "a"]);
    const resolved = resolveExportScope(state, scope);
    expect(resolved.valid).toBe(true);
    expect(resolved.segments.map((segment) => segment.id)).toStrictEqual(["a", "c"]);
    expect(resolved.segments.map((segment) => segment.number)).toStrictEqual([1, 3]);
    // With one clip, the one piece reads the source of the clip, at the PTS of the segment.
    expect(resolved.segments[1]?.pieces).toStrictEqual([
      {
        clipId: TEST_CLIP_ID,
        sourceId: TEST_SOURCE.id,
        inPts: "360000",
        outPts: "450000",
      },
    ]);
  });

  it("is not valid when a segment of the list is no longer a segment of the export", () => {
    const sequence = severalClips();
    const scope = createSegmentListScope(sequence, ["x", "y"]);
    const without = severalClips([on("x", "a1", "0", "a1", "1000", "Intro")]);
    const resolved = resolveExportScope(without, scope);
    expect(resolved.valid).toBe(false);
    // It still gives the segments that it names, for the facts of the step.
    expect(resolved.segments.map((segment) => segment.id)).toStrictEqual(["x"]);
    // An id that was never a segment of the export.
    expect(
      resolveExportScope(sequence, createSegmentListScope(sequence, ["x", "nothing"]))
        .valid,
    ).toBe(false);
  });

  it("is not valid when a segment of the list gives other pieces than its record", () => {
    const sequence = severalClips();
    const scope = createSegmentListScope(sequence, ["x"]);
    // The Out of x moved.
    const moved = severalClips([on("x", "a1", "0", "a1", "2000")]);
    expect(resolveExportScope(moved, scope).valid).toBe(false);
    // With one clip, a moved Out gives another piece too.
    const store = oneClip();
    const one = store.getState();
    const list = createSegmentListScope(one, ["b"]);
    store.getState().trimSegmentEdge("b", "out", pts("260000"));
    expect(resolveExportScope(store.getState(), list).valid).toBe(false);
    // A rename keeps the frames, so the list stays valid.
    store.getState().renameSegment("a", "Name");
    const named = createSegmentListScope(store.getState(), ["a"]);
    store.getState().renameSegment("a", "Other");
    expect(resolveExportScope(store.getState(), named).valid).toBe(true);
  });
});

describe("narrowToExportScope", () => {
  it("returns the input itself for the whole export", () => {
    const sequence = severalClips();
    expect(narrowToExportScope(sequence, WHOLE_EXPORT_SCOPE)).toBe(sequence);
  });

  it("keeps only the segments of the scope in both arrays, and changes nothing else", () => {
    const sequence = severalClips();
    const scope = createSegmentListScope(sequence, ["cross"]);
    const narrowed = narrowToExportScope(sequence, scope);
    expect(narrowed.sequenceSegments.map((segment) => segment.id)).toStrictEqual([
      "cross",
    ]);
    expect(narrowed.clips).toBe(sequence.clips);
    expect(narrowed.sequenceSources).toBe(sequence.sequenceSources);
    expect(exportSegmentIds(narrowed)).toStrictEqual(["cross"]);

    const state = oneClip().getState();
    const narrowedOne = narrowToExportScope(
      state,
      createSegmentListScope(state, ["b"]),
    );
    expect(narrowedOne.segments.map((segment) => segment.id)).toStrictEqual(["b"]);
    expect(exportSegmentIds(narrowedOne)).toStrictEqual(["b"]);
  });

  it("leaves the readers outside the dialog on the whole export", () => {
    const store = oneClip();
    const before = store.getState();
    const scope = createSegmentListScope(before, ["b"]);
    narrowToExportScope(before, scope);
    resolveExportScope(before, scope);
    const after = store.getState();
    // The store does not change, so the numbers of the bars, the summary, the title bar and
    // the Export Order dialog read the whole export.
    expect(after).toBe(before);
    expect(exportSegmentIds(after)).toStrictEqual(["a", "b", "c"]);
    expect(selectExportSegmentCount(after)).toBe(3);
    const axis = { videoTimeBase: TEST_SOURCE.videoTimeBase, videoStartPts: pts("0") };
    const display = MILLISECONDS_TIMECODE_DISPLAY;
    expect(totalExportSegments(after, axis, display)).toBe(3000n);
    expect(totalExportSegments(narrowToExportScope(after, scope), axis, display)).toBe(
      1000n,
    );

    const sequence = severalClips();
    narrowToExportScope(sequence, createSegmentListScope(sequence, ["y"]));
    expect(exportSegmentIds(sequence)).toStrictEqual(["x", "cross", "y"]);
  });
});
