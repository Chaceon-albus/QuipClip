import { describe, expect, it } from "vitest";
import type { ImportMediaResult } from "@/features/media/types";
import type { SequenceSource } from "@/features/timeline/sequence";
import type { Preset } from "@/features/settings/types";
import type { Clip, Pts, SequenceSegment } from "@/types/project";
import {
  buildSequenceExportRequest,
  countInputRuns,
  exportLimitError,
  MAX_EXPORT_INPUTS,
  MAX_EXPORT_PIECES,
  sequenceExportPieces,
  type RunPiece,
} from "./sequenceRequest";
import inputRunCases from "./inputRunCases.json";

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
  it("counts the runs of every shared case as the backend does (ADR 055)", () => {
    // `src-tauri/src/ffmpeg/export/inputs.rs` runs the same cases against `source_runs`.
    expect(inputRunCases.cases.length).toBeGreaterThanOrEqual(10);
    for (const testCase of inputRunCases.cases) {
      const pieces: RunPiece[] = testCase.pieces.map((piece) => ({
        sourceId: piece.sourceId,
        inPts: pts(piece.inPts),
        outPts: pts(piece.outPts),
      }));
      expect(countInputRuns(pieces), testCase.name).toBe(testCase.runs);
    }
  });

  /** `count` pieces of the source `sourceId`, each 10 ticks long, in source order. */
  function inOrder(count: number, sourceId = "A"): RunPiece[] {
    return Array.from({ length: count }, (_, index) => ({
      sourceId,
      inPts: pts(String(index * 10)),
      outPts: pts(String(index * 10 + 10)),
    }));
  }

  it("refuses the limits of ADR 055 in the order of the backend, each with its limit", () => {
    expect(MAX_EXPORT_PIECES).toBe(256);
    expect(MAX_EXPORT_INPUTS).toBe(85);
    expect(exportLimitError(inOrder(MAX_EXPORT_PIECES), 1)).toBeNull();
    expect(exportLimitError(inOrder(MAX_EXPORT_PIECES + 1), 1)).toMatchObject({
      code: "tooManySegments",
      pieceLimit: MAX_EXPORT_PIECES,
    });
    expect(exportLimitError(inOrder(1), MAX_EXPORT_INPUTS)).toBeNull();
    expect(exportLimitError(inOrder(1), MAX_EXPORT_INPUTS + 1)).toMatchObject({
      code: "tooManySources",
      sourceLimit: MAX_EXPORT_INPUTS,
    });
    const reversed = inOrder(MAX_EXPORT_INPUTS + 1).reverse();
    expect(exportLimitError(reversed, 1)).toMatchObject({
      code: "piecesOutOfOrder",
      inputLimit: MAX_EXPORT_INPUTS,
    });
    // Up to `MAX_EXPORT_INPUTS` pieces, each piece has an input of its own, in any order.
    expect(exportLimitError(reversed.slice(1), 1)).toBeNull();

    // The earlier check wins.
    const tooManyReversed = inOrder(MAX_EXPORT_PIECES + 1).reverse();
    expect(exportLimitError(tooManyReversed, MAX_EXPORT_INPUTS + 1)?.code).toBe(
      "tooManySegments",
    );
    expect(exportLimitError(reversed, MAX_EXPORT_INPUTS + 1)?.code).toBe(
      "tooManySources",
    );
  });

  it("reports a PTS that is not a decimal integer as an invalid segment, not a silent failure", () => {
    const pieces: RunPiece[] = inOrder(MAX_EXPORT_INPUTS + 1);
    pieces[3] = { ...pieces[3], inPts: pts("1.5") };
    expect(exportLimitError(pieces, 1)).toMatchObject({ code: "invalidSegment" });
  });

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
