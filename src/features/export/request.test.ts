import { describe, expect, it } from "vitest";
import { createPresetDraft } from "@/features/settings/presetDocument";
import type { Pts, Segment } from "@/types/project";
import { buildExportRequest } from "./request";
import { EXPORT_AUDIO_MODES, EXPORT_STREAMS } from "./types";

describe("Export Request Builder", () => {
  const activeSourceId = "source-1";
  const otherSourceId = "source-2";
  const sourcePath = "/media/input.mp4";
  const outputPath = "/media/output.mp4";
  const preset = createPresetDraft("h264-mp4", "H.264");

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

  it("filters segments to the active source and sends one piece of that source for each", () => {
    const segments: Segment[] = [
      createSegment("seg-1", activeSourceId, "100", "200"),
      createSegment("seg-2", otherSourceId, "300", "400"),
      createSegment("seg-3", activeSourceId, "500", "600"),
    ];

    const result = buildExportRequest({
      preset,
      sourcePath,
      outputPath,
      activeSourceId,
      streams: "videoAndAudio",
      audioMode: "encode",
      segments,
    });

    expect(result).toEqual({
      sources: [{ id: activeSourceId, path: "/media/input.mp4" }],
      pieces: [
        { sourceId: activeSourceId, inPts: "100", outPts: "200" },
        { sourceId: activeSourceId, inPts: "500", outPts: "600" },
      ],
      segmentCount: 2,
      outputPath: "/media/output.mp4",
      preset,
      streams: "videoAndAudio",
      audioMode: "encode",
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
      preset,
      sourcePath,
      outputPath,
      activeSourceId,
      streams: "videoAndAudio",
      audioMode: "encode",
      segments,
    });

    expect(result).not.toBeNull();
    expect(result?.pieces).toEqual([
      { sourceId: activeSourceId, inPts: "8000", outPts: "9000" },
      { sourceId: activeSourceId, inPts: "1000", outPts: "2000" },
      { sourceId: activeSourceId, inPts: "4000", outPts: "5000" },
    ]);
    expect(result?.segmentCount).toBe(3);
  });

  it("resolves sourcePath from media object when sourcePath is omitted", () => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];

    const result = buildExportRequest({
      preset,
      media: { path: "/media/from-media-store.mp4" },
      outputPath,
      activeSourceId,
      streams: "videoAndAudio",
      audioMode: "encode",
      segments,
    });

    expect(result).toEqual({
      preset,
      sources: [{ id: activeSourceId, path: "/media/from-media-store.mp4" }],
      pieces: [{ sourceId: activeSourceId, inPts: "0", outPts: "1000" }],
      segmentCount: 1,
      outputPath: "/media/output.mp4",
      streams: "videoAndAudio",
      audioMode: "encode",
    });
  });

  it("prefers explicit sourcePath over media.path if both are supplied", () => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];

    const result = buildExportRequest({
      preset,
      sourcePath: "/media/explicit.mp4",
      media: { path: "/media/from-media.mp4" },
      outputPath,
      activeSourceId,
      streams: "videoAndAudio",
      audioMode: "encode",
      segments,
    });

    expect(result?.sources).toEqual([
      { id: activeSourceId, path: "/media/explicit.mp4" },
    ]);
  });

  it("falls back to media.path when sourcePath is an empty string", () => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];

    const result = buildExportRequest({
      preset,
      sourcePath: "",
      media: { path: "/media/fallback.mp4" },
      outputPath,
      activeSourceId,
      streams: "videoAndAudio",
      audioMode: "encode",
      segments,
    });

    expect(result).not.toBeNull();
    expect(result?.sources[0]?.path).toBe("/media/fallback.mp4");
  });

  it("forwards trimmed outputPath when outputPath contains surrounding whitespace", () => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];

    const result = buildExportRequest({
      preset,
      sourcePath,
      outputPath: "  /media/trimmed-output.mp4  ",
      activeSourceId,
      streams: "videoAndAudio",
      audioMode: "encode",
      segments,
    });

    expect(result).not.toBeNull();
    expect(result?.outputPath).toBe("/media/trimmed-output.mp4");
  });

  it("forwards the whole preset unchanged", () => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];
    const custom = {
      ...createPresetDraft("custom", "Custom"),
      videoEncoder: "libx265",
    };

    const result = buildExportRequest({
      preset: custom,
      sourcePath,
      outputPath,
      activeSourceId,
      streams: "videoAndAudio",
      audioMode: "encode",
      segments,
    });

    // The preset of the request is the one the caller passed: the backend reads no other.
    expect(result?.preset).toEqual(custom);
  });

  it("forwards the expected source revision when the caller gives one", () => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];
    const base = {
      preset,
      sourcePath,
      outputPath,
      activeSourceId,
      segments,
      streams: "videoAndAudio" as const,
      audioMode: "encode" as const,
    };

    const revision = { size: 4096, mtime: 1_700_000_000 };
    expect(
      buildExportRequest({ ...base, expectedSourceRevision: revision })?.sources[0]
        ?.expectedRevision,
    ).toStrictEqual(revision);
    // No revision, or null for a changed source that the user accepted, sends none.
    expect(buildExportRequest(base)?.sources[0]).not.toHaveProperty("expectedRevision");
    expect(
      buildExportRequest({ ...base, expectedSourceRevision: null })?.sources[0],
    ).not.toHaveProperty("expectedRevision");
  });

  it.each(EXPORT_STREAMS)("forwards the stream choice '%s' unchanged", (streams) => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];

    const result = buildExportRequest({
      preset,
      sourcePath,
      outputPath,
      activeSourceId,
      segments,
      streams,
      audioMode: "encode",
    });

    expect(result?.streams).toBe(streams);
  });

  it.each(EXPORT_AUDIO_MODES)("forwards the audio mode '%s' unchanged", (audioMode) => {
    const segments: Segment[] = [createSegment("seg-1", activeSourceId, "0", "1000")];

    const result = buildExportRequest({
      preset,
      sourcePath,
      outputPath,
      activeSourceId,
      segments,
      streams: "videoAndAudio",
      audioMode,
    });

    expect(result?.audioMode).toBe(audioMode);
  });

  describe("Returns null when requirements are not met", () => {
    const validSegments: Segment[] = [
      createSegment("seg-1", activeSourceId, "0", "1000"),
    ];

    it("returns null when no media source path is available", () => {
      expect(
        buildExportRequest({
          preset,
          sourcePath: null,
          media: null,
          outputPath,
          activeSourceId,
          streams: "videoAndAudio",
          audioMode: "encode",
          segments: validSegments,
        }),
      ).toBeNull();

      expect(
        buildExportRequest({
          preset,
          sourcePath: "",
          outputPath,
          activeSourceId,
          streams: "videoAndAudio",
          audioMode: "encode",
          segments: validSegments,
        }),
      ).toBeNull();
    });

    it("returns null when outputPath is missing or empty", () => {
      expect(
        buildExportRequest({
          preset,
          sourcePath,
          outputPath: null,
          activeSourceId,
          streams: "videoAndAudio",
          audioMode: "encode",
          segments: validSegments,
        }),
      ).toBeNull();

      expect(
        buildExportRequest({
          preset,
          sourcePath,
          outputPath: "   ",
          activeSourceId,
          streams: "videoAndAudio",
          audioMode: "encode",
          segments: validSegments,
        }),
      ).toBeNull();
    });

    it("returns null when activeSourceId is missing or empty", () => {
      expect(
        buildExportRequest({
          preset,
          sourcePath,
          outputPath,
          activeSourceId: null,
          streams: "videoAndAudio",
          audioMode: "encode",
          segments: validSegments,
        }),
      ).toBeNull();

      expect(
        buildExportRequest({
          preset,
          sourcePath,
          outputPath,
          activeSourceId: "",
          streams: "videoAndAudio",
          audioMode: "encode",
          segments: validSegments,
        }),
      ).toBeNull();
    });

    it("returns null when segments array is empty or missing", () => {
      expect(
        buildExportRequest({
          preset,
          sourcePath,
          outputPath,
          activeSourceId,
          streams: "videoAndAudio",
          audioMode: "encode",
          segments: [],
        }),
      ).toBeNull();

      expect(
        buildExportRequest({
          preset,
          sourcePath,
          outputPath,
          activeSourceId,
          streams: "videoAndAudio",
          audioMode: "encode",
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
          preset,
          sourcePath,
          outputPath,
          activeSourceId,
          streams: "videoAndAudio",
          audioMode: "encode",
          segments: otherSegments,
        }),
      ).toBeNull();
    });
  });
});
