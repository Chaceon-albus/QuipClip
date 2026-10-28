import { describe, expect, it } from "vitest";
import type { MediaProbe } from "@/features/media/types";
import type { SequenceSource } from "@/features/timeline/sequence";
import type { Pts, SequenceSegment } from "@/types/project";
import { displaySize, exportSourceFacts, outputSummarySource } from "./outputSummary";

function probe(overrides: Partial<MediaProbe>): MediaProbe {
  return {
    width: 1920,
    height: 1080,
    sampleAspectRatio: null,
    rotation: 0,
    avgFrameRate: { n: 30, d: 1 },
    rFrameRate: { n: 30, d: 1 },
    audio: { index: 1, codec: "aac", sampleRate: 48000, channels: 2 },
    ...overrides,
  } as MediaProbe;
}

describe("outputSummarySource (ADR 053)", () => {
  it("gives the probe of one source that is not turned as it is", () => {
    const one = probe({});
    expect(outputSummarySource([one])).toBe(one);
    expect(outputSummarySource([probe({ rotation: 180 })])).toMatchObject({
      width: 1920,
      height: 1080,
    });
    expect(outputSummarySource([probe({ rotation: 90 })])).toMatchObject({
      width: 1080,
      height: 1920,
    });
    expect(outputSummarySource([])).toBeNull();
  });

  it("takes the largest display area, with even sides, and the highest rate", () => {
    const anamorphic = probe({
      width: 720,
      height: 480,
      sampleAspectRatio: { n: 32, d: 27 },
      avgFrameRate: { n: 30000, d: 1001 },
      rFrameRate: { n: 30000, d: 1001 },
    });
    const hd = probe({ avgFrameRate: { n: 60, d: 1 }, rFrameRate: { n: 60, d: 1 } });
    expect(displaySize(anamorphic)).toEqual({ width: 853, height: 480 });
    expect(outputSummarySource([anamorphic, hd])).toMatchObject({
      width: 1920,
      height: 1080,
      avgFrameRate: { n: 60, d: 1 },
    });
    // Alone among sources of another size, the anamorphic source gives an even canvas.
    expect(
      outputSummarySource([anamorphic, probe({ width: 640, height: 360 })]),
    ).toMatchObject({ width: 852, height: 480 });
  });

  it("turns the coded size of sources that share a rotated frame", () => {
    // No canvas, but `ffmpeg` turns the picture before the graph.
    const portrait = probe({ rotation: 270 });
    expect(outputSummarySource([portrait])).toMatchObject({
      width: 1080,
      height: 1920,
    });
    expect(outputSummarySource([portrait, probe({ rotation: 270 })])).toMatchObject({
      width: 1080,
      height: 1920,
    });
  });

  it("turns a portrait source, and the earlier source wins a tie", () => {
    const portrait = probe({ rotation: 90 });
    expect(outputSummarySource([portrait, probe({})])).toMatchObject({
      width: 1080,
      height: 1920,
    });
  });

  it("takes the widest audio, and none when no source has audio", () => {
    const mono = probe({
      audio: { index: 1, codec: "aac", sampleRate: 44100, channels: 1 },
    });
    const surround = probe({
      audio: { index: 1, codec: "ac3", sampleRate: 48000, channels: 6 },
    });
    expect(outputSummarySource([mono, surround])?.audio).toMatchObject({
      sampleRate: 48000,
      channels: 6,
    });
    expect(
      outputSummarySource([probe({ audio: null }), probe({ audio: null })])?.audio,
    ).toBeNull();
  });
});

describe("exportSourceFacts (ADR 053)", () => {
  function facts(id: string): SequenceSource {
    return {
      id,
      videoTimeBase: { n: 1, d: 1000 },
      videoStartPts: "0" as Pts,
      videoEndPts: "5000" as Pts,
      videoDurationTicks: null,
      approximateDurationSeconds: null,
    };
  }
  const silent = probe({ audio: null, formatNames: ["mov", "mp4"] });
  const loud = probe({ formatNames: ["mov", "mp4"] });
  const clips = [
    { id: "a1", sourceId: "A" },
    { id: "b1", sourceId: "B" },
  ];
  const sources = { A: facts("A"), B: facts("B") };
  const imported = { A: { probe: silent }, B: { probe: loud } };
  function on(inClipId: string, outClipId: string): SequenceSegment {
    return {
      id: `${inClipId}-${outClipId}`,
      inClipId,
      inPts: "1000" as Pts,
      outClipId,
      outPts: "2000" as Pts,
    };
  }

  it("keeps the probe and the segment count of one clip", () => {
    const result = exportSourceFacts({
      probe: loud,
      segmentCount: 3,
      clips: [clips[0]],
      segments: [],
      sources,
      imported,
    });
    expect(result).toEqual({ output: loud, copyProbe: loud, copySegmentCount: 3 });
  });

  it("reads the sources of the pieces, not the attached clip", () => {
    // A, without audio, is attached; the one segment lies on B, which has audio.
    const result = exportSourceFacts({
      probe: silent,
      segmentCount: 1,
      clips,
      segments: [on("b1", "b1")],
      sources,
      imported,
    });
    expect(result.output?.audio).not.toBeNull();
    expect(result.copyProbe).toBe(loud);
    expect(result.copySegmentCount).toBe(1);
  });

  it("counts the pieces of a segment across a junction for the copy", () => {
    const result = exportSourceFacts({
      probe: loud,
      segmentCount: 1,
      clips,
      segments: [on("a1", "b1")],
      sources,
      imported,
    });
    expect(result.copyProbe).toBeNull();
    expect(result.copySegmentCount).toBe(2);
    expect(result.output?.audio).not.toBeNull();
  });

  it("has no audio when no source of a piece has an audio stream", () => {
    const result = exportSourceFacts({
      probe: loud,
      segmentCount: 1,
      clips,
      segments: [on("a1", "a1")],
      sources,
      imported,
    });
    expect(result.output?.audio).toBeNull();
  });

  it("falls back to the attached probe with no piece", () => {
    const result = exportSourceFacts({
      probe: loud,
      segmentCount: 0,
      clips,
      segments: [],
      sources,
      imported,
    });
    expect(result).toEqual({ output: loud, copyProbe: null, copySegmentCount: 0 });
  });
});
