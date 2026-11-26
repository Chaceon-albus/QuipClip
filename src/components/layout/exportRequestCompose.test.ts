import { describe, expect, it } from "vitest";
import type { AudioStreamOverride } from "@/features/media/audioStream";
import type { ImportMediaResult } from "@/features/media/types";
import { loudnessRequestId } from "@/features/loudness/store";
import { createPresetDraft } from "@/features/settings/presetDocument";
import { exportSegmentIds, isSequenceExport } from "@/features/timeline/exportSegments";
import { calculateSegmentLayout } from "@/features/timeline/math";
import { expandSegment, type SequenceSource } from "@/features/timeline/sequence";
import { createTimelineStore } from "@/features/timeline/store";
import type { Pts, Segment, SequenceSegment } from "@/types/project";
import {
  composeExportRequest,
  effectiveStreamsDiffer,
  exportSourceIds,
  measurementScope,
  resolveEffectiveStreams,
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
    audioOverrides: {},
    ...overrides,
  };
}

/** The override of stream 2 of a source (ADR 070). */
const SECOND_STREAM: AudioStreamOverride = {
  index: 2,
  codec: "opus",
  sampleRate: 48000,
  channels: 1,
};

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

describe("the audio stream of a source (ADR 070)", () => {
  it("carries the override of the real source of the one clip, which the request names virtually", () => {
    // With one clip, the request names the virtual source of the sequence.
    const oneClip = parts({
      timeline: {
        clips: [{ id: "c1", sourceId: "a" }],
        sequenceSegments: [],
        sequenceSources: {},
      },
      sourceId: "sequence:1",
      segments: SEGMENTS.map((segment) => ({ ...segment, sourceId: "sequence:1" })),
    });
    const plain = composeExportRequest(oneClip);
    expect(plain?.sources[0].id).toBe("sequence:1");
    expect(plain?.sources[0]).not.toHaveProperty("audioStream");
    const chosen = composeExportRequest({
      ...oneClip,
      audioOverrides: { a: SECOND_STREAM },
    });
    expect(chosen?.sources[0].audioStream).toEqual(SECOND_STREAM);
    // An override of another source does not reach the request.
    expect(
      composeExportRequest({ ...oneClip, audioOverrides: { b: SECOND_STREAM } })
        ?.sources[0],
    ).not.toHaveProperty("audioStream");
    // "Export anyway" keeps the field: it removes only the revision (ADR 024).
    expect(
      composeExportRequest({
        ...oneClip,
        audioOverrides: { a: SECOND_STREAM },
        skipSourceRevisionCheck: true,
      })?.sources[0],
    ).toEqual({ id: "sequence:1", path: "/media/a.mp4", audioStream: SECOND_STREAM });
  });

  it("keys a measurement by the effective stream, so an override of the preferred stream shares it", () => {
    const preferred = { index: 1, codec: "aac", sampleRate: 48000, channels: 2 };
    const oneClip = parts({
      timeline: {
        clips: [{ id: "c1", sourceId: "a" }],
        sequenceSegments: [],
        sequenceSources: {},
      },
      sources: {
        a: {
          path: "/media/a.mp4",
          probe: { audio: preferred, formatNames: ["matroska", "webm"] },
        } as ImportMediaResult,
      },
      sourceId: "sequence:1",
      segments: SEGMENTS.map((segment) => ({ ...segment, sourceId: "sequence:1" })),
    });
    const plain = measurementScope(oneClip);
    const samePreferred = measurementScope({
      ...oneClip,
      audioOverrides: { a: { ...preferred } },
    });
    const second = measurementScope({
      ...oneClip,
      audioOverrides: { a: SECOND_STREAM },
    });
    if (plain === null || samePreferred === null || second === null) {
      throw new Error("the clip gives a request");
    }
    // The request names the virtual source, and its stream is the one of the real source.
    expect(plain.effectiveAudio).toEqual({ "sequence:1": preferred });
    // The wire field stays the override alone.
    expect(plain.sources[0]).not.toHaveProperty("audioStream");
    expect(samePreferred.sources[0].audioStream).toEqual(preferred);
    expect(loudnessRequestId(samePreferred)).toBe(loudnessRequestId(plain));
    expect(loudnessRequestId(second)).not.toBe(loudnessRequestId(plain));
  });

  it("carries the override of each source of several clips, and the measurement keys it", () => {
    const facts = (id: string, end: string): SequenceSource => ({
      id,
      videoTimeBase: { n: 1, d: 1000 },
      videoStartPts: "0" as Pts,
      videoEndPts: end as Pts,
      videoDurationTicks: null,
      approximateDurationSeconds: null,
    });
    const imported = (path: string) =>
      ({ path, fileName: path.slice(1), size: 1, mtime: 1 }) as ImportMediaResult;
    const sequence = parts({
      timeline: {
        clips: [
          { id: "a1", sourceId: "A" },
          { id: "b1", sourceId: "B" },
        ],
        sequenceSources: { A: facts("A", "10000"), B: facts("B", "5000") },
        sequenceSegments: [
          {
            id: "s1",
            inClipId: "a1",
            inPts: "9000" as Pts,
            outClipId: "b1",
            outPts: "1000" as Pts,
          },
        ],
      },
      sources: { A: imported("/a.mp4"), B: imported("/b.mp4") },
    });
    const withOverride = { ...sequence, audioOverrides: { B: SECOND_STREAM } };
    expect(composeExportRequest(withOverride)?.sources).toEqual([
      { id: "A", path: "/a.mp4", expectedRevision: { size: 1, mtime: 1 } },
      {
        id: "B",
        path: "/b.mp4",
        expectedRevision: { size: 1, mtime: 1 },
        audioStream: SECOND_STREAM,
      },
    ]);
    const scope = measurementScope(withOverride);
    expect(scope?.sources[1].audioStream).toEqual(SECOND_STREAM);
    const plainScope = measurementScope(sequence);
    if (scope === null || plainScope === null) {
      throw new Error("the sequence gives a request");
    }
    // The key of a kept result includes the effective stream of each source.
    expect(loudnessRequestId(scope)).not.toBe(loudnessRequestId(plainScope));
    expect(
      loudnessRequestId(
        measurementScope({
          ...sequence,
          audioOverrides: { B: { ...SECOND_STREAM, index: 3 } },
        }) ?? plainScope,
      ),
    ).not.toBe(loudnessRequestId(scope));
  });
});

describe("the effective streams that the confirm step compares (ADR 070)", () => {
  it("names the real sources that a request reads", () => {
    const request = {
      sources: [
        { id: "A", path: "/a.mp4" },
        { id: "B", path: "/b.mp4" },
      ],
    };
    expect(
      exportSourceIds(
        [
          { id: "a1", sourceId: "A" },
          { id: "b1", sourceId: "B" },
        ],
        request,
      ),
    ).toEqual(["A", "B"]);
    // One clip: the request names the virtual source, and the clip names the real one.
    expect(
      exportSourceIds([{ id: "a1", sourceId: "A" }], {
        sources: [{ id: "sequence:1", path: "/a.mp4" }],
      }),
    ).toEqual(["A"]);
  });

  it("resolves the effective stream of each source from its probe and its override", () => {
    const probe = {
      probe: {
        audio: { index: 1, codec: "aac", sampleRate: 48000, channels: 2 },
        formatNames: ["matroska", "webm"],
      },
    } as ImportMediaResult;
    const silent = {
      probe: { audio: null, formatNames: ["mov", "mp4"] },
    } as unknown as ImportMediaResult;
    const flv = {
      probe: { ...probe.probe, formatNames: ["flv"] },
    } as ImportMediaResult;
    const probes = { A: probe, B: probe, S: silent, F: flv };
    expect(
      resolveEffectiveStreams(["A", "B", "S"], probes, { B: SECOND_STREAM }),
    ).toEqual({ A: 1, B: 2, S: null });
    // An FLV holds no override, and a source with no imported probe reads its override alone.
    expect(
      resolveEffectiveStreams(["F", "C"], probes, {
        F: SECOND_STREAM,
        C: SECOND_STREAM,
      }),
    ).toEqual({ F: 1, C: 2 });
    expect(resolveEffectiveStreams(["C"], probes, {})).toEqual({ C: null });
  });

  it("finds a source whose recorded stream differs or was not recorded", () => {
    expect(effectiveStreamsDiffer(["A"], { A: 1, B: 1 }, { A: 1 })).toBe(false);
    expect(effectiveStreamsDiffer(["A"], { A: 1 }, { A: 2 })).toBe(true);
    expect(effectiveStreamsDiffer(["S"], { S: null }, { S: null })).toBe(false);
    expect(effectiveStreamsDiffer(["S"], { S: null }, { S: 1 })).toBe(true);
    // A stream of another source does not count.
    expect(effectiveStreamsDiffer(["A"], { A: 1, B: 1 }, { A: 1, B: 2 })).toBe(false);
    // A source of the export that the step did not record is new, so it counts as a change.
    expect(effectiveStreamsDiffer(["C"], { A: 1 }, { C: 1 })).toBe(true);
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
      // The parts have no clip, so no source of a clip gives an effective stream.
      effectiveAudio: { a: null },
    });
    // The five fields of the request, and the effective streams that only the page reads.
    expect(Object.keys(scope ?? {}).sort()).toEqual([
      "effectiveAudio",
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
      // The imported results of this test carry no probe, so no source has a stream.
      effectiveAudio: { A: null, B: null },
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

describe("the segments of the export (ADR 066)", () => {
  const facts = (id: string, end: string, timeBaseD = 1000): SequenceSource => ({
    id,
    videoTimeBase: { n: 1, d: timeBaseD },
    videoStartPts: "0" as Pts,
    videoEndPts: end as Pts,
    videoDurationTicks: null,
    approximateDurationSeconds: null,
  });
  const imported = (path: string) =>
    ({ path, fileName: path.slice(1), size: 1, mtime: 1 }) as ImportMediaResult;
  const on = (
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

  const PAST_EXTENT: SequenceSource = {
    ...facts("A", "0"),
    videoEndPts: null,
    approximateDurationSeconds: 5,
  };

  /** The request that the session composes for the state of `store`. */
  function composeFrom(store: ReturnType<typeof createTimelineStore>) {
    const state = store.getState();
    return composeExportRequest(
      parts({
        timeline: state,
        sources: {
          A: imported("/a.mp4"),
          B: imported("/b.mp4"),
          C: imported("/c.mp4"),
        },
        segments: state.segments,
        sourceId: state.sourceId,
      }),
    );
  }

  /**
   * The pieces that the request holds for `ids`, in that order: the one piece of each derived
   * segment for one clip, and the pieces of each anchored segment for several clips.
   */
  function piecesOf(
    store: ReturnType<typeof createTimelineStore>,
    ids: readonly string[],
  ) {
    const state = store.getState();
    if (!isSequenceExport(state.clips)) {
      return ids.map((id) => {
        const segment = state.segments.find((candidate) => candidate.id === id);
        return {
          sourceId: state.sourceId,
          inPts: segment?.inPts,
          outPts: segment?.outPts,
        };
      });
    }
    const sources = new Map(Object.entries(state.sequenceSources));
    return ids.flatMap((id) => {
      const segment = state.sequenceSegments.find((candidate) => candidate.id === id);
      return (
        segment === undefined
          ? []
          : (expandSegment(segment, state.clips, sources) ?? [])
      ).map((piece) => ({
        sourceId: piece.sourceId,
        inPts: piece.inPts,
        outPts: piece.outPts,
      }));
    });
  }

  // Each state, and the ids of the segments of its export.
  const states: readonly [
    string,
    () => ReturnType<typeof createTimelineStore>,
    readonly string[],
  ][] = [
    [
      "one clip, with a segment of a file that another file replaced",
      () =>
        createTimelineStore(
          {},
          {
            clips: [{ id: "clip:A", sourceId: "A" }],
            sequenceSources: { A: facts("A", "10000"), B: facts("B", "5000") },
            sequenceSegments: [
              on("s1", "clip:A", "4000", "clip:A", "5000"),
              on("old", "clip:B", "0", "clip:B", "1000"),
              on("s2", "clip:A", "1000", "clip:A", "2000"),
            ],
            generation: 1,
          },
        ),
      ["s1", "s2"],
    ],
    [
      "one clip, with a segment after the estimated extent, which has no width on the lane",
      () =>
        createTimelineStore(
          {},
          {
            clips: [{ id: "clip:A", sourceId: "A" }],
            // No known end, and an estimate of 5 s: a segment at 8 s is valid, and the bar
            // layer clamps it to no width.
            sequenceSources: { A: PAST_EXTENT },
            sequenceSegments: [
              on("past", "clip:A", "8000", "clip:A", "9000"),
              on("s1", "clip:A", "0", "clip:A", "1000"),
            ],
            generation: 1,
          },
        ),
      ["past", "s1"],
    ],
    [
      "several clips, with a segment across a junction and one that is not live",
      () =>
        createTimelineStore(
          {},
          {
            clips: [
              { id: "a1", sourceId: "A" },
              { id: "b1", sourceId: "B" },
            ],
            sequenceSources: {
              A: facts("A", "10000"),
              B: facts("B", "5000"),
              C: facts("C", "5000"),
            },
            sequenceSegments: [
              on("y", "b1", "2000", "b1", "3000"),
              on("dormant", "c1", "0", "c1", "1000"),
              on("cross", "a1", "9000", "b1", "1000"),
              on("x", "a1", "0", "a1", "1000"),
            ],
            generation: 1,
          },
        ),
      ["y", "cross", "x"],
    ],
    [
      "several clips whose common time base is not a safe integer, so derive omits them",
      () =>
        createTimelineStore(
          {},
          {
            clips: [
              { id: "a1", sourceId: "A" },
              { id: "b1", sourceId: "B" },
            ],
            // The least common multiple of the two denominators is not a safe integer, so
            // the sequence has no virtual axis and no derived segment (`buildVirtualTimeline`).
            sequenceSources: {
              A: facts("A", "9007199254740990", 9007199254740991),
              B: facts("B", "9007199254740988", 9007199254740989),
            },
            sequenceSegments: [
              on("b", "b1", "0", "b1", "1000"),
              on("a", "a1", "0", "a1", "1000"),
            ],
            generation: 1,
          },
        ),
      ["b", "a"],
    ],
  ];

  for (const [name, make, expected] of states) {
    it(`are the segments of the composed request, in its order: ${name}`, () => {
      const store = make();
      const ids = exportSegmentIds(store.getState());
      expect(ids).toEqual(expected);
      const request = composeFrom(store);
      expect(request?.segmentCount).toBe(ids.length);
      expect(request?.pieces).toEqual(piecesOf(store, ids));
    });
  }

  it("hold a segment that has no width on the lane, as the request of one clip does", () => {
    const [, make] = states[1] ?? [];
    const state = make?.().getState();
    const past = state?.segments.find((segment) => segment.id === "past");
    expect(past).toBeDefined();
    expect(
      past === undefined
        ? null
        : calculateSegmentLayout(past, "0" as Pts, { n: 1, d: 1000 }, 5).widthPercent,
    ).toBe(0);
    expect(state === undefined ? [] : exportSegmentIds(state)).toEqual(["past", "s1"]);
  });

  it("hold a segment that derive omits, as the request of several clips does", () => {
    const [, make] = states[3] ?? [];
    const state = make?.().getState();
    expect(state?.segments).toEqual([]);
    expect(state === undefined ? [] : exportSegmentIds(state)).toEqual(["b", "a"]);
  });
});
