/**
 * What an export of several sources writes, for the summary of the setup step (ADR 053).
 *
 * The backend plan decides the output. With the preset value `source`, ADR 053 gives the rules,
 * and this module repeats them so the setup step can show the values before the export starts:
 *
 * - the canvas: no canvas when every source has the same coded size, SAR and rotation; else the
 *   display size with the largest area, the earlier source on a tie, with even sides;
 * - the frame rate: the highest nominal rate, the average rate else the real rate;
 * - the audio: the highest sample rate and the most channels among the sources with audio.
 *
 * With one source, the result is the probe of that source, so the summary stays as before. A
 * rotation of 90 or 270 degrees swaps the sides in every case, because `ffmpeg` turns the picture
 * before the graph (ADR 053).
 */

import type { AudioProbe, ImportMediaResult, MediaProbe } from "@/features/media/types";
import { getNominalFrameRate } from "@/features/playback/store";
import type { SequenceSource } from "@/features/timeline/sequence";
import type { Clip, Rational, SequenceSegment } from "@/types/project";
import { sequenceExportPieces } from "./sequenceRequest";

/** The fields of a probe that the summary reads. */
export type OutputSummarySource = Pick<
  MediaProbe,
  "width" | "height" | "avgFrameRate" | "rFrameRate" | "audio"
>;

/** The display size of a source: the coded size with its SAR and its rotation. */
export function displaySize(
  probe: Pick<MediaProbe, "width" | "height" | "sampleAspectRatio" | "rotation">,
): { width: number; height: number } {
  const sar = probe.sampleAspectRatio;
  // Width times the SAR, rounded to the nearest whole pixel, and a half up (ADR 053). An unknown
  // SAR counts as 1.
  const width =
    sar === null || sar.n === sar.d
      ? probe.width
      : Math.floor((2 * probe.width * sar.n + sar.d) / (2 * sar.d));
  return turned(probe)
    ? { width: probe.height, height: width }
    : { width, height: probe.height };
}

/** Whether `ffmpeg` turns the picture of a source a quarter turn, which swaps its sides. */
function turned(probe: Pick<MediaProbe, "rotation">): boolean {
  return probe.rotation === 90 || probe.rotation === 270;
}

/**
 * An even side for a 4:2:0 canvas: an odd side loses one pixel, and a side of 1 becomes 2. The plan
 * applies it to the canvas of several sources and to an explicit preset size (ADR 053).
 */
export function evenSide(side: number): number {
  if (side <= 1) {
    return 2;
  }
  return side % 2 === 0 ? side : side - 1;
}

function greaterRate(a: Rational, b: Rational): boolean {
  return a.n * b.d > b.n * a.d;
}

/**
 * The output that the setup step shows for the sources of the pieces, in the order of their first
 * piece. Null for no source. One source gives its probe as it is.
 */
export function outputSummarySource(
  probes: readonly MediaProbe[],
): OutputSummarySource | null {
  const first = probes[0];
  if (first === undefined) {
    return null;
  }
  if (probes.length === 1) {
    return turned(first)
      ? { ...first, width: first.height, height: first.width }
      : first;
  }

  const sameFrame = probes.every(
    (probe) =>
      probe.width === first.width &&
      probe.height === first.height &&
      (probe.sampleAspectRatio?.n ?? 1) * (first.sampleAspectRatio?.d ?? 1) ===
        (first.sampleAspectRatio?.n ?? 1) * (probe.sampleAspectRatio?.d ?? 1) &&
      probe.rotation === first.rotation,
  );
  // The same frame gets no canvas, so the output keeps the coded size, turned.
  let width = turned(first) ? first.height : first.width;
  let height = turned(first) ? first.width : first.height;
  if (!sameFrame) {
    let best = displaySize(first);
    for (const probe of probes.slice(1)) {
      const size = displaySize(probe);
      if (size.width * size.height > best.width * best.height) {
        best = size;
      }
    }
    width = evenSide(best.width);
    height = evenSide(best.height);
  }

  let rate: Rational | null = null;
  for (const probe of probes) {
    const nominal = getNominalFrameRate(probe);
    if (nominal !== null && (rate === null || greaterRate(nominal, rate))) {
      rate = nominal;
    }
  }

  const streams = probes
    .map((probe) => probe.audio)
    .filter((stream): stream is AudioProbe => stream !== null);
  const firstStream = streams[0];
  const audio: AudioProbe | null =
    firstStream === undefined
      ? null
      : {
          ...firstStream,
          sampleRate:
            Math.max(...streams.map((stream) => stream.sampleRate ?? 0)) || null,
          channels: Math.max(...streams.map((stream) => stream.channels ?? 0)) || null,
        };

  return { width, height, avgFrameRate: rate, rFrameRate: rate, audio };
}

/** The probe of each source of the clips, by source ID. */
type ImportedSources = Readonly<Record<string, Pick<ImportMediaResult, "probe">>>;

/** The inputs of `exportSourceFacts`. */
export interface ExportSourceFactsInput {
  /** The probe of the attached clip, which decides alone with one clip. */
  readonly probe: MediaProbe | null;
  /** The number of segments with one clip. */
  readonly segmentCount: number;
  readonly clips: readonly Clip[];
  readonly segments: readonly SequenceSegment[];
  readonly sources: Readonly<Record<string, SequenceSource>>;
  readonly imported: ImportedSources;
}

/** The facts of the sources of an export, which the setup step and the dialog decide with. */
export interface ExportSourceFacts {
  /**
   * What the export writes with the preset value `source`. The summary shows it, and its `audio`
   * says whether the export can write audio: with several clips, it is null only when no source
   * of a piece has an audio stream.
   */
  readonly output: OutputSummarySource | null;
  /**
   * The probe that decides the copy of the audio (ADR 048): the one source of the one piece, or
   * null with several pieces.
   */
  readonly copyProbe: MediaProbe | null;
  /** The number of segments that the copy counts: the number of pieces with several clips. */
  readonly copySegmentCount: number;
}

/**
 * The facts of the sources of an export. With one clip, they are the probe of that clip and its
 * segment count, as before ADR 053. With several clips, they come from the sources of the pieces,
 * as the backend reads them (ADR 053). With no piece, the output falls back to `probe`.
 */
export function exportSourceFacts(input: ExportSourceFactsInput): ExportSourceFacts {
  if (input.clips.length <= 1) {
    return {
      output: input.probe === null ? null : outputSummarySource([input.probe]),
      copyProbe: input.probe,
      copySegmentCount: input.segmentCount,
    };
  }
  const { pieces, sourceIds } = sequenceExportPieces(
    input.clips,
    input.segments,
    new Map(Object.entries(input.sources)),
  );
  const probes = sourceIds.flatMap((id) => {
    const source = input.imported[id];
    return source === undefined ? [] : [source.probe];
  });
  const only = pieces.length === 1 ? pieces[0] : undefined;
  return {
    output:
      outputSummarySource(probes) ??
      (input.probe === null ? null : outputSummarySource([input.probe])),
    copyProbe:
      only === undefined ? null : (input.imported[only.sourceId]?.probe ?? null),
    copySegmentCount: pieces.length,
  };
}
