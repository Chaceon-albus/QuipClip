import { describe, expect, it } from "vitest";
import type { ImportMediaResult } from "@/features/media/types";
import type { SequenceSource } from "@/features/timeline/sequence";
import type { Preset } from "@/features/settings/types";
import type { Clip, Pts, SequenceSegment } from "@/types/project";
import { buildSequenceExportRequest, sequenceExportPieces } from "./sequenceRequest";

const pts = (value: string) => value as Pts;

function facts(id: string, end: string): SequenceSource {
  return {
    id,
    videoTimeBase: { n: 1, d: 1000 },
    videoStartPts: pts("0"),
    videoEndPts: pts(end),
    videoDurationTicks: null,
    approximateDurationSeconds: null,
  };
}

const sources = new Map([
  ["A", facts("A", "10000")],
  ["B", facts("B", "5000")],
]);
const media = {
  A: { path: "/a.mp4", size: 10, mtime: 1 } as ImportMediaResult,
  B: { path: "/b.mp4", size: 20, mtime: 2 } as ImportMediaResult,
};
const a1: Clip = { id: "a1", sourceId: "A" };
const b1: Clip = { id: "b1", sourceId: "B" };
const a2: Clip = { id: "a2", sourceId: "A" };

function segment(
  id: string,
  inClipId: string,
  inPts: string,
  outClipId: string,
  outPts: string,
): SequenceSegment {
  return { id, inClipId, inPts: pts(inPts), outClipId, outPts: pts(outPts) };
}

const preset = {} as Preset;

describe("sequence export request (ADR 052, ADR 053)", () => {
  it("expands each segment in array order and names each source once", () => {
    const result = sequenceExportPieces(
      [a1, b1, a2],
      [
        segment("late", "b1", "1000", "a2", "2000"),
        segment("early", "a1", "100", "a1", "200"),
      ],
      sources,
    );
    expect(result).toEqual({
      pieces: [
        { sourceId: "B", inPts: "1000", outPts: "5000" },
        { sourceId: "A", inPts: "0", outPts: "2000" },
        { sourceId: "A", inPts: "100", outPts: "200" },
      ],
      sourceIds: ["B", "A"],
      segmentCount: 2,
    });
  });

  it("skips a segment that is not on the sequence", () => {
    const result = sequenceExportPieces(
      [a1],
      [
        segment("gone", "b1", "0", "b1", "100"),
        segment("kept", "a1", "0", "a1", "100"),
      ],
      sources,
    );
    expect(result.segmentCount).toBe(1);
    expect(result.sourceIds).toEqual(["A"]);
  });

  it("builds the request with the revisions, or with none after Export anyway", () => {
    const options = {
      clips: [a1, b1],
      segments: [segment("s", "a1", "9000", "b1", "1000")],
      sources,
      media,
      outputPath: " /out.mp4 ",
      preset,
      streams: "videoAndAudio" as const,
      audioMode: "encode" as const,
    };
    expect(buildSequenceExportRequest({ ...options, checkRevisions: true })).toEqual({
      sources: [
        { id: "A", path: "/a.mp4", expectedRevision: { size: 10, mtime: 1 } },
        { id: "B", path: "/b.mp4", expectedRevision: { size: 20, mtime: 2 } },
      ],
      pieces: [
        { sourceId: "A", inPts: "9000", outPts: "10000" },
        { sourceId: "B", inPts: "0", outPts: "1000" },
      ],
      segmentCount: 1,
      outputPath: "/out.mp4",
      preset,
      streams: "videoAndAudio",
      audioMode: "encode",
    });
    expect(
      buildSequenceExportRequest({ ...options, checkRevisions: false })?.sources,
    ).toEqual([
      { id: "A", path: "/a.mp4" },
      { id: "B", path: "/b.mp4" },
    ]);
    expect(
      buildSequenceExportRequest({ ...options, checkRevisions: true, outputPath: " " }),
    ).toBeNull();
    expect(
      buildSequenceExportRequest({
        ...options,
        checkRevisions: true,
        media: { A: media.A },
      }),
    ).toBeNull();
  });
});
