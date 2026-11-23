import { describe, expect, it } from "vitest";
import type { ImportMediaResult } from "@/features/media/types";
import { createPresetDraft } from "@/features/settings/presetDocument";
import type { SequenceSource } from "@/features/timeline/sequence";
import type { Pts, Segment, SequenceSegment } from "@/types/project";
import {
  composeExportRequest,
  measurementScope,
  type ExportRequestParts,
} from "./exportFlowController";

const SEGMENTS: Segment[] = [
  { id: "s1", sourceId: "a", inPts: "0" as Pts, outPts: "9000" as Pts },
  { id: "s2", sourceId: "a", inPts: "18000" as Pts, outPts: "27000" as Pts },
];

/** The parts of an export of one clip, the attached source `a`. */
function parts(overrides: Partial<ExportRequestParts> = {}): ExportRequestParts {
  return {
    timeline: { clips: [], sequenceSegments: [], sequenceSources: {} },
    sources: {},
    media: { path: "/media/a.mp4", size: 100, mtime: 7, fileName: "a.mp4" },
    segments: SEGMENTS,
    sourceId: "a",
    outputPath: "/out.mp4",
    preset: createPresetDraft("p", "P"),
    streams: "videoAndAudio",
    audioMode: "encode",
    skipSourceRevisionCheck: false,
    ...overrides,
  };
}

describe("the export request of the session", () => {
  it("carries the adjusted gain of the setup step only when it has one (ADR 061)", () => {
    expect(composeExportRequest(parts())).not.toHaveProperty(
      "adjustedAudioGainTenthsDb",
    );
    expect(
      composeExportRequest(parts({ adjustedAudioGainTenthsDb: -17 }))
        ?.adjustedAudioGainTenthsDb,
    ).toBe(-17);
  });

  it("carries the revision of the source unless the user accepted a changed file", () => {
    expect(composeExportRequest(parts())?.sources[0].expectedRevision).toEqual({
      size: 100,
      mtime: 7,
    });
    expect(
      composeExportRequest(parts({ skipSourceRevisionCheck: true }))?.sources[0],
    ).not.toHaveProperty("expectedRevision");
  });
});

describe("the scope of the measurement (ADR 061)", () => {
  it("is the request of the export with no output path, no audio mode and no gain", () => {
    const request = composeExportRequest(parts({ audioMode: "copy" }));
    const scope = measurementScope(parts());
    expect(scope).toEqual({
      sources: request?.sources,
      pieces: request?.pieces,
      segmentCount: request?.segmentCount,
      preset: request?.preset,
      streams: request?.streams,
    });
    expect(Object.keys(scope ?? {}).sort()).toEqual([
      "pieces",
      "preset",
      "segmentCount",
      "sources",
      "streams",
    ]);
  });

  it("has the sources, the revisions and the pieces of an export of several clips", () => {
    const facts = (id: string, end: string): SequenceSource => ({
      id,
      videoTimeBase: { n: 1, d: 1000 },
      videoStartPts: "0" as Pts,
      videoEndPts: end as Pts,
      videoDurationTicks: null,
      approximateDurationSeconds: null,
    });
    const imported = (path: string, size: number, mtime: number) =>
      ({ path, fileName: path.slice(1), size, mtime }) as ImportMediaResult;
    const segment = (
      id: string,
      inClipId: string,
      inPts: string,
      outClipId: string,
      outPts: string,
    ): SequenceSegment => ({
      id,
      inClipId,
      inPts: inPts as Pts,
      outClipId,
      outPts: outPts as Pts,
    });
    // Clips a1 (A), b1 (B) and a2 (A). The first segment crosses from a1 into b1.
    const sequence = parts({
      timeline: {
        clips: [
          { id: "a1", sourceId: "A" },
          { id: "b1", sourceId: "B" },
          { id: "a2", sourceId: "A" },
        ],
        sequenceSources: { A: facts("A", "10000"), B: facts("B", "5000") },
        sequenceSegments: [
          segment("s1", "a1", "9000", "b1", "1000"),
          segment("s2", "a2", "2000", "a2", "3000"),
        ],
      },
      sources: { A: imported("/a.mp4", 10, 1), B: imported("/b.mp4", 20, 2) },
    });
    const request = composeExportRequest(sequence);
    expect(measurementScope(sequence)).toEqual({
      sources: request?.sources,
      pieces: request?.pieces,
      segmentCount: 2,
      preset: request?.preset,
      streams: "videoAndAudio",
    });
    expect(request?.sources).toEqual([
      { id: "A", path: "/a.mp4", expectedRevision: { size: 10, mtime: 1 } },
      { id: "B", path: "/b.mp4", expectedRevision: { size: 20, mtime: 2 } },
    ]);
    expect(request?.pieces).toEqual([
      { sourceId: "A", inPts: "9000", outPts: "10000" },
      { sourceId: "B", inPts: "0", outPts: "1000" },
      { sourceId: "A", inPts: "2000", outPts: "3000" },
    ]);
    // "Export anyway" drops every revision from both.
    const accepted = parts({ ...sequence, skipSourceRevisionCheck: true });
    expect(measurementScope(accepted)?.sources).toEqual([
      { id: "A", path: "/a.mp4" },
      { id: "B", path: "/b.mp4" },
    ]);
  });

  it("is null when no request can be built", () => {
    expect(measurementScope(parts({ segments: [] }))).toBeNull();
    expect(measurementScope(parts({ media: null }))).toBeNull();
  });
});
