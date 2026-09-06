import { describe, expect, it } from "vitest";
import type { Pts, Segment } from "@/types/project";
import { buildExportRequest } from "./request";

describe("Export Request Builder", () => {
  const activeSourceId = "source-1";
  const otherSourceId = "source-2";
  const sourcePath = "/media/input.mp4";
  const outputPath = "/media/output.mp4";

  function createSegment(
    id: string,
    sourceId: string,
    inPts: string,
    outPts: string,
  ): Segment {
    return {
      id,
      sourceId,
      inPts: inPts as Pts,
      outPts: outPts as Pts,
    };
  }

  it("filters segments to the active source and drops id and sourceId", () => {
    const segments: Segment[] = [
      createSegment("seg-1", activeSourceId, "100", "200"),
      createSegment("seg-2", otherSourceId, "300", "400"),
      createSegment("seg-3", activeSourceId, "500", "600"),
    ];

    const result = buildExportRequest({
      sourcePath,
      outputPath,
      activeSourceId,
      segments,
      presetId: "h264-mp4",
    });

    expect(result).toEqual({
      sourcePath: "/media/input.mp4",
      outputPath: "/media/output.mp4",
      presetId: "h264-mp4",
      segments: [
        { inPts: "100", outPts: "200" },
        { inPts: "500", outPts: "600" },
      ],
    });
  });

  it("strictly preserves array order and NEVER sorts by PTS (ADR 007)", () => {
    // Array order: later PTS segment appears BEFORE earlier PTS segment
    const segments: Segment[] = [
      createSegment("seg-late", activeSourceId, "8000", "9000"),
      createSegment("seg-early", activeSourceId, "1000", "2000"),
      createSegment("seg-mid", activeSourceId, "4000", "5000"),
    ];

    const result = buildExportRequest({
      sourcePath,
      outputPath,
      activeSourceId,
      segments,
    });

    expect(result).not.toBeNull();
    expect(result?.segments).toEqual([
      { inPts: "8000", outPts: "9000" },
      { inPts: "1000", outPts: "2000" },
      { inPts: "4000", outPts: "5000" },
    ]);
  });

  it("resolves sourcePath from media object when sourcePath is omitted", () => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];

    const result = buildExportRequest({
      media: { path: "/media/from-media-store.mp4" },
      outputPath,
      activeSourceId,
      segments,
    });

    expect(result).toEqual({
      sourcePath: "/media/from-media-store.mp4",
      outputPath: "/media/output.mp4",
      segments: [{ inPts: "0", outPts: "1000" }],
    });
  });

  it("prefers explicit sourcePath over media.path if both are supplied", () => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];

    const result = buildExportRequest({
      sourcePath: "/media/explicit.mp4",
      media: { path: "/media/from-media.mp4" },
      outputPath,
      activeSourceId,
      segments,
    });

    expect(result?.sourcePath).toBe("/media/explicit.mp4");
  });

  it("falls back to media.path when sourcePath is an empty string", () => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];

    const result = buildExportRequest({
      sourcePath: "",
      media: { path: "/media/fallback.mp4" },
      outputPath,
      activeSourceId,
      segments,
    });

    expect(result).not.toBeNull();
    expect(result?.sourcePath).toBe("/media/fallback.mp4");
  });

  it("forwards trimmed outputPath when outputPath contains surrounding whitespace", () => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];

    const result = buildExportRequest({
      sourcePath,
      outputPath: "  /media/trimmed-output.mp4  ",
      activeSourceId,
      segments,
    });

    expect(result).not.toBeNull();
    expect(result?.outputPath).toBe("/media/trimmed-output.mp4");
  });

  it("omits presetId when not provided or empty string", () => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];

    const resUndefined = buildExportRequest({
      sourcePath,
      outputPath,
      activeSourceId,
      segments,
    });
    expect(resUndefined?.presetId).toBeUndefined();

    const resEmpty = buildExportRequest({
      sourcePath,
      outputPath,
      activeSourceId,
      segments,
      presetId: "   ",
    });
    expect(resEmpty?.presetId).toBeUndefined();
  });

  describe("Returns null when requirements are not met", () => {
    const validSegments: Segment[] = [
      createSegment("seg-1", activeSourceId, "0", "1000"),
    ];

    it("returns null when no media source path is available", () => {
      expect(
        buildExportRequest({
          sourcePath: null,
          media: null,
          outputPath,
          activeSourceId,
          segments: validSegments,
        }),
      ).toBeNull();

      expect(
        buildExportRequest({
          sourcePath: "",
          outputPath,
          activeSourceId,
          segments: validSegments,
        }),
      ).toBeNull();
    });

    it("returns null when outputPath is missing or empty", () => {
      expect(
        buildExportRequest({
          sourcePath,
          outputPath: null,
          activeSourceId,
          segments: validSegments,
        }),
      ).toBeNull();

      expect(
        buildExportRequest({
          sourcePath,
          outputPath: "   ",
          activeSourceId,
          segments: validSegments,
        }),
      ).toBeNull();
    });

    it("returns null when activeSourceId is missing or empty", () => {
      expect(
        buildExportRequest({
          sourcePath,
          outputPath,
          activeSourceId: null,
          segments: validSegments,
        }),
      ).toBeNull();

      expect(
        buildExportRequest({
          sourcePath,
          outputPath,
          activeSourceId: "",
          segments: validSegments,
        }),
      ).toBeNull();
    });

    it("returns null when segments array is empty or missing", () => {
      expect(
        buildExportRequest({
          sourcePath,
          outputPath,
          activeSourceId,
          segments: [],
        }),
      ).toBeNull();

      expect(
        buildExportRequest({
          sourcePath,
          outputPath,
          activeSourceId,
          segments: null,
        }),
      ).toBeNull();
    });

    it("returns null when no segments match activeSourceId", () => {
      const otherSegments: Segment[] = [
        createSegment("seg-other", otherSourceId, "0", "1000"),
      ];

      expect(
        buildExportRequest({
          sourcePath,
          outputPath,
          activeSourceId,
          segments: otherSegments,
        }),
      ).toBeNull();
    });
  });
});
