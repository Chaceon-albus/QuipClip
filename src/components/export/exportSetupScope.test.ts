import { describe, expect, it } from "vitest";
import { canCopyAudio } from "@/features/export/audioCopy";
import { exportScopeSourceFacts } from "@/features/export/outputSummary";
import {
  createSegmentListScope,
  resolveExportScope,
  WHOLE_EXPORT_SCOPE,
  type ExportScopeInput,
} from "@/features/export/scope";
import type { MediaProbe } from "@/features/media/types";
import type { SequenceSource } from "@/features/timeline/sequence";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { MILLISECONDS_TIMECODE_DISPLAY } from "@/lib/timecode";
import type { Pts, Segment, SequenceSegment } from "@/types/project";
import {
  presentExportSummarySentence,
  presentScopeSourceFile,
  presentSelectedSegmentsLine,
  presentSizeEstimate,
  scopeDurationTicks,
} from "./exportSetupPresenter";

const pts = (value: string) => value as Pts;

/** Walks a dotted message key through a catalog, as i18next does. */
function lookup(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node !== null && typeof node === "object" && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, catalog);
}

function probe(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    width: 1920,
    height: 1080,
    sampleAspectRatio: null,
    rotation: 0,
    avgFrameRate: { n: 30, d: 1 },
    rFrameRate: { n: 30, d: 1 },
    audio: { index: 1, codec: "aac", sampleRate: 48000, channels: 2 },
    formatNames: ["mov", "mp4"],
    ...overrides,
  } as MediaProbe;
}

const facts = (id: string, end: string): SequenceSource => ({
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

const derived = (id: string, inPts: string, outPts: string): Segment => ({
  id,
  sourceId: "sequence:1",
  inPts: pts(inPts),
  outPts: pts(outPts),
});

/**
 * Clips a1 (A) and b1 (B). `x` lies on a1, `y` on b1, and `cross` runs from a1 into b1. The
 * derived segments place each one on the virtual axis, where b1 starts at 10000.
 */
function sequence(): ExportScopeInput {
  return {
    clips: [
      { id: "a1", sourceId: "A" },
      { id: "b1", sourceId: "B" },
    ],
    sequenceSources: { A: facts("A", "10000"), B: facts("B", "5000") },
    sequenceSegments: [
      on("x", "a1", "1000", "a1", "2000"),
      on("cross", "a1", "9000", "b1", "1000"),
      on("y", "b1", "2000", "b1", "4000"),
    ],
    segments: [
      derived("x", "1000", "2000"),
      derived("cross", "9000", "11000"),
      derived("y", "12000", "14000"),
    ],
    sourceId: "sequence:1",
  };
}

const FILES: Readonly<Record<string, { path: string; fileName: string }>> = {
  A: { path: "/media/a.mp4", fileName: "a.mp4" },
  B: { path: "/media/b.mov", fileName: "b.mov" },
};

describe("presentSelectedSegmentsLine (ADR 067)", () => {
  it("shows no line for the whole export", () => {
    expect(presentSelectedSegmentsLine(WHOLE_EXPORT_SCOPE, 3, 3)).toBeNull();
  });

  it("names the count of the scope and the count of the export for a list", () => {
    const scope = createSegmentListScope(sequence(), ["x", "y"]);
    expect(presentSelectedSegmentsLine(scope, 2, 3)).toStrictEqual({
      key: "export.setup.selectedSegments",
      values: { count: 2, total: 3 },
    });
  });

  it("has the line in both catalogs, with the count forms", () => {
    expect(lookup(en, "export.setup.selectedSegments_one")).toBe(
      "Only the selected segment: {{count}} of {{total}}",
    );
    expect(lookup(en, "export.setup.selectedSegments_other")).toBe(
      "Only the selected segments: {{count}} of {{total}}",
    );
    expect(lookup(zhCN, "export.setup.selectedSegments_other")).toBe(
      "仅导出所选的 {{count}} 个片段（共 {{total}} 个）",
    );
  });
});

describe("presentScopeSourceFile (ADR 067)", () => {
  const fileOf = (id: string) => FILES[id];

  it("names the file of the whole export as before", () => {
    const input = sequence();
    expect(
      presentScopeSourceFile({
        scope: WHOLE_EXPORT_SCOPE,
        segments: resolveExportScope(input, WHOLE_EXPORT_SCOPE).segments,
        wholeExportFileName: "sequence.mp4",
        fileOf,
      }),
    ).toStrictEqual({ kind: "file", fileName: "sequence.mp4" });
  });

  it("names the one file that the pieces of a list read", () => {
    const input = sequence();
    for (const [ids, fileName] of [
      [["x"], "a.mp4"],
      [["y"], "b.mov"],
    ] as const) {
      const scope = createSegmentListScope(input, ids);
      expect(
        presentScopeSourceFile({
          scope,
          segments: resolveExportScope(input, scope).segments,
          wholeExportFileName: "sequence.mp4",
          fileOf,
        }),
      ).toStrictEqual({ kind: "file", fileName });
    }
  });

  it("names no file when the pieces of a list read several files", () => {
    const input = sequence();
    for (const ids of [["x", "y"], ["cross"]]) {
      const scope = createSegmentListScope(input, ids);
      expect(
        presentScopeSourceFile({
          scope,
          segments: resolveExportScope(input, scope).segments,
          wholeExportFileName: "sequence.mp4",
          fileOf,
        }),
      ).toStrictEqual({ kind: "several" });
    }
  });

  it("counts two sources of one path as one file", () => {
    // The file was imported again after its modification time changed: two sources, one path.
    const input = sequence();
    const samePath = (id: string) =>
      id === "A" || id === "B"
        ? { path: "/media/a.mp4", fileName: "a.mp4" }
        : undefined;
    for (const ids of [["x", "y"], ["cross"]]) {
      const scope = createSegmentListScope(input, ids);
      expect(
        presentScopeSourceFile({
          scope,
          segments: resolveExportScope(input, scope).segments,
          wholeExportFileName: "sequence.mp4",
          fileOf: samePath,
        }),
      ).toStrictEqual({ kind: "file", fileName: "a.mp4" });
    }
    // A source with no imported media is a file of its own.
    const scope = createSegmentListScope(input, ["x", "y"]);
    expect(
      presentScopeSourceFile({
        scope,
        segments: resolveExportScope(input, scope).segments,
        wholeExportFileName: "sequence.mp4",
        fileOf: (id) => (id === "A" ? FILES.A : undefined),
      }),
    ).toStrictEqual({ kind: "several" });
  });
});

describe("presentExportSummarySentence for a scope (ADR 067)", () => {
  it("names no file for several files", () => {
    expect(
      presentExportSummarySentence({
        fileName: null,
        severalFiles: true,
        segmentCount: 2,
        segmentTotal: 3000n,
        display: MILLISECONDS_TIMECODE_DISPLAY,
      }),
    ).toStrictEqual({
      key: "export.setup.summaryNoFile",
      count: 2,
      fileName: "",
      fullFileName: "",
      shortened: false,
      title: "",
      duration: "00:00:03.000",
    });
    expect(
      presentExportSummarySentence({
        fileName: null,
        severalFiles: true,
        segmentCount: 0,
        segmentTotal: 0n,
        display: MILLISECONDS_TIMECODE_DISPLAY,
      }),
    ).toBeNull();
    expect(lookup(en, "export.setup.summaryNoFile_other")).toBe(
      "Export {{count}} segments · {{duration}} in total",
    );
    expect(lookup(zhCN, "export.setup.summaryNoFile_other")).toBe(
      "导出 {{count}} 个片段 · 总时长 {{duration}}",
    );
  });

  it("keeps the sentence with the file for one file", () => {
    expect(
      presentExportSummarySentence({
        fileName: "a.mp4",
        severalFiles: false,
        segmentCount: 1,
        segmentTotal: 1000n,
        display: MILLISECONDS_TIMECODE_DISPLAY,
      }),
    ).toMatchObject({ key: "export.setup.summary", count: 1, title: "a.mp4" });
  });
});

describe("the size estimate of a scope (ADR 067)", () => {
  it("reads the exact duration of the segments of the scope that have a place", () => {
    const input = sequence();
    expect(scopeDurationTicks(input, WHOLE_EXPORT_SCOPE)).toBe(5000n);
    expect(scopeDurationTicks(input, createSegmentListScope(input, ["y"]))).toBe(2000n);
    expect(
      scopeDurationTicks(input, createSegmentListScope(input, ["x", "cross"])),
    ).toBe(3000n);
    // A segment of the list that the derived timeline does not place adds nothing.
    const unplaced = { ...input, segments: input.segments.slice(0, 2) };
    expect(scopeDurationTicks(unplaced, createSegmentListScope(input, ["y"]))).toBe(0n);
  });

  it("estimates the size from that duration", () => {
    const input = sequence();
    const formatter = new Intl.NumberFormat("en");
    const estimate = (durationTicks: bigint | null) =>
      presentSizeEstimate(
        {
          preset: {
            quality: { kind: "bitrate", value: 8000 },
            audioEncoder: "aac",
            audioBitrate: 192,
          },
          streams: "videoAndAudio",
          durationTicks,
          videoTimeBase: { n: 1, d: 1000 },
        },
        formatter,
      );
    const whole = estimate(scopeDurationTicks(input, WHOLE_EXPORT_SCOPE));
    const one = estimate(
      scopeDurationTicks(input, createSegmentListScope(input, ["y"])),
    );
    // 8192 kbps for 5 s and for 2 s.
    expect(whole).toStrictEqual({
      key: "export.setup.estimatedSize",
      values: { size: "5.1 MB" },
    });
    expect(one).toStrictEqual({
      key: "export.setup.estimatedSize",
      values: { size: "2 MB" },
    });
  });
});

describe("the facts of the sources of a scope (ADR 067)", () => {
  const imported = { A: { probe: probe() }, B: { probe: probe({ audio: null }) } };
  const copyOffered = (copyProbe: MediaProbe | null, segmentCount: number) =>
    canCopyAudio({
      probe: copyProbe,
      container: "mp4",
      streams: "videoAndAudio",
      segmentCount,
    });

  it("offers the copy of the audio for a scope of one segment with one piece", () => {
    const input = sequence();
    const whole = exportScopeSourceFacts({
      probe: probe(),
      timeline: input,
      scope: WHOLE_EXPORT_SCOPE,
      imported,
    });
    expect(copyOffered(whole.copyProbe, whole.copySegmentCount)).toBe(false);
    const one = exportScopeSourceFacts({
      probe: probe(),
      timeline: input,
      scope: createSegmentListScope(input, ["x"]),
      imported,
    });
    expect(one.copySegmentCount).toBe(1);
    expect(copyOffered(one.copyProbe, one.copySegmentCount)).toBe(true);
    // A segment across the junction has two pieces.
    const cross = exportScopeSourceFacts({
      probe: probe(),
      timeline: input,
      scope: createSegmentListScope(input, ["cross"]),
      imported,
    });
    expect(cross.copySegmentCount).toBe(2);
  });

  it("reads the sources of the pieces of the scope for the streams", () => {
    const input = sequence();
    // `y` reads only B, which has no audio.
    const silent = exportScopeSourceFacts({
      probe: probe(),
      timeline: input,
      scope: createSegmentListScope(input, ["y"]),
      imported,
    });
    expect(silent.output?.audio).toBeNull();
    const whole = exportScopeSourceFacts({
      probe: probe(),
      timeline: input,
      scope: WHOLE_EXPORT_SCOPE,
      imported,
    });
    expect(whole.output?.audio).not.toBeNull();
  });

  it("counts the segments of the scope with one clip", () => {
    const oneClip: ExportScopeInput = {
      clips: [{ id: "a1", sourceId: "A" }],
      sequenceSources: { A: facts("A", "10000") },
      sequenceSegments: [],
      segments: [derived("p", "0", "1000"), derived("q", "2000", "3000")],
      sourceId: "sequence:1",
    };
    expect(
      exportScopeSourceFacts({
        probe: probe(),
        timeline: oneClip,
        scope: WHOLE_EXPORT_SCOPE,
        imported,
      }).copySegmentCount,
    ).toBe(2);
    expect(
      exportScopeSourceFacts({
        probe: probe(),
        timeline: oneClip,
        scope: createSegmentListScope(oneClip, ["q"]),
        imported,
      }).copySegmentCount,
    ).toBe(1);
  });
});
