/**
 * The parts of a program play (ADR 074).
 *
 * The program is the list of the segments of the export, in the export order (ADR 066). Play
 * Program and Play Joins each make a list of parts from it, one time, when the action starts. A
 * part is on one clip: the clip, a start and an end that is not in the part, as PTS values of the
 * source of that clip. So a part never crosses a junction, and a segment that crosses a junction
 * plays as one part for each of its pieces, as the export joins its pieces (ADR 052).
 *
 * The module is pure. It reads the timeline state and the probe facts of the sources, and it has
 * no React dependency.
 */

import { canPlaySegment } from "@/features/playback/store";
import {
  isSequenceExport,
  oneClipExportSegments,
  sequenceExportSegments,
  type ExportSegmentsInput,
} from "@/features/timeline/exportSegments";
import type { SequencePiece } from "@/features/timeline/sequence";
import { isPtsString, ptsFromBigInt, ptsToBigInt } from "@/lib/time";
import type { Pts, Rational } from "@/types/project";
import type { MediaBySource } from "./virtualMedia";

/** The two actions of a program play: Play Program and Play Joins. */
export type ProgramAction = "program" | "joins";

/** The length of the tail and of the head of a segment in Play Joins, in seconds. */
export const JOIN_SECONDS = 2;

/** One part of a program play: a half-open range `[startPts, endPts)` of the source of a clip. */
export interface ProgramPart {
  /** The segment of the program that the part comes from. */
  readonly segmentId: string;
  /** The clip that the part plays on. */
  readonly clipId: string;
  /** The source of that clip. */
  readonly sourceId: string;
  /** The first PTS of the part, in the video time base of the source. */
  readonly startPts: Pts;
  /** The PTS after the part, in the video time base of the source. */
  readonly endPts: Pts;
}

/** A segment of the program with its pieces, in sequence order. */
export interface ProgramSegment {
  readonly segmentId: string;
  readonly pieces: readonly SequencePiece[];
}

/** The parts of the timeline state that the program reads. */
export type ProgramInput = ExportSegmentsInput & {
  readonly generation: number;
};

/**
 * The program: the segments of the export in the export order, each with its pieces. It uses
 * the two rules of `exportSegmentIds`, so it holds the same segments in the same order.
 *
 * - Several clips: the anchored segments, with the pieces of `expandSegment`.
 * - One clip: the derived segments of the one source. Each has one piece on that clip, because
 *   with one clip a virtual PTS is the source PTS of the clip.
 */
export function programSegments(timeline: ExportSegmentsInput): ProgramSegment[] {
  if (isSequenceExport(timeline.clips)) {
    return sequenceExportSegments(
      timeline.clips,
      timeline.sequenceSegments,
      new Map(Object.entries(timeline.sequenceSources)),
    ).map((entry) => ({ segmentId: entry.segment.id, pieces: entry.pieces }));
  }
  const clip = timeline.clips[0];
  if (clip === undefined) {
    return [];
  }
  return oneClipExportSegments(timeline.segments, timeline.sourceId).map((segment) => ({
    segmentId: segment.id,
    pieces: [
      {
        clipId: clip.id,
        sourceId: clip.sourceId,
        inPts: segment.inPts,
        outPts: segment.outPts,
      },
    ],
  }));
}

/**
 * The index in `program` of the segment where a play starts (ADR 074): the current segment when
 * it is in the program, else the first segment. For Play Joins, a current segment that is the
 * last of the program counts as no current segment. The caller gives the current segment, the
 * segment that Play Segment would play, or null.
 */
export function programStartIndex(
  action: ProgramAction,
  program: readonly ProgramSegment[],
  currentSegmentId: string | null,
): number {
  if (currentSegmentId === null) {
    return 0;
  }
  const index = program.findIndex((segment) => segment.segmentId === currentSegmentId);
  if (index < 0) {
    return 0;
  }
  if (action === "joins" && index === program.length - 1) {
    return 0;
  }
  return index;
}

/**
 * The count of ticks of `timeBase` in JOIN_SECONDS, rounded down, or null for a time base that
 * is not positive. The arithmetic is exact: `floor(seconds * d / n)`.
 */
export function joinTicks(timeBase: Rational): bigint | null {
  if (
    !Number.isSafeInteger(timeBase.n) ||
    !Number.isSafeInteger(timeBase.d) ||
    timeBase.n <= 0 ||
    timeBase.d <= 0
  ) {
    return null;
  }
  return (BigInt(JOIN_SECONDS) * BigInt(timeBase.d)) / BigInt(timeBase.n);
}

/** A range of a piece as bigint ticks. */
interface TickRange {
  readonly start: bigint;
  readonly end: bigint;
}

function rangeOf(piece: SequencePiece): TickRange | null {
  if (!isPtsString(piece.inPts) || !isPtsString(piece.outPts)) {
    return null;
  }
  return { start: ptsToBigInt(piece.inPts), end: ptsToBigInt(piece.outPts) };
}

function partOf(
  segmentId: string,
  piece: SequencePiece,
  range: TickRange,
): ProgramPart {
  return {
    segmentId,
    clipId: piece.clipId,
    sourceId: piece.sourceId,
    startPts: ptsFromBigInt(range.start),
    endPts: ptsFromBigInt(range.end),
  };
}

/**
 * Builds the list of the parts of `action` (ADR 074).
 *
 * - Play Program: one part for each piece of each segment, from the start segment to the last
 *   segment of the program.
 * - Play Joins: the tail of the start segment; for each later segment that is not the last, its
 *   head and then its tail, or the whole piece as one part when the segment has one piece and
 *   its head ends at or after the start of its tail; for the last segment, its head. The tail
 *   starts JOIN_SECONDS before the end of the last piece, but not before its start. The head
 *   ends JOIN_SECONDS after the start of the first piece, but not after its end. Both lengths
 *   are counts of ticks of the time base of the source of the piece (`joinTicks`). Play Joins
 *   needs a program with two or more segments.
 *
 * A part that holds no frame is left out: the test of Play Segment (`canPlaySegment`) with the
 * probe facts of the source of the part. A part whose source has no media is left out too.
 *
 * `currentSegmentId` is the segment that Play Segment would play, or null (`programStartIndex`).
 */
export function buildProgramParts(
  action: ProgramAction,
  timeline: ExportSegmentsInput,
  media: MediaBySource,
  currentSegmentId: string | null,
): ProgramPart[] {
  const program = programSegments(timeline);
  if (program.length === 0 || (action === "joins" && program.length < 2)) {
    return [];
  }
  const start = programStartIndex(action, program, currentSegmentId);
  const candidates: ProgramPart[] = [];

  const ticksOf = (piece: SequencePiece): bigint | null => {
    const source = timeline.sequenceSources[piece.sourceId];
    return source === undefined ? null : joinTicks(source.videoTimeBase);
  };
  const tailOf = (piece: SequencePiece): TickRange | null => {
    const range = rangeOf(piece);
    const ticks = ticksOf(piece);
    if (range === null || ticks === null) {
      return null;
    }
    const from = range.end - ticks;
    return { start: from > range.start ? from : range.start, end: range.end };
  };
  const headOf = (piece: SequencePiece): TickRange | null => {
    const range = rangeOf(piece);
    const ticks = ticksOf(piece);
    if (range === null || ticks === null) {
      return null;
    }
    const to = range.start + ticks;
    return { start: range.start, end: to < range.end ? to : range.end };
  };

  for (let index = start; index < program.length; index += 1) {
    const segment = program[index];
    const first = segment?.pieces[0];
    const last = segment?.pieces[segment.pieces.length - 1];
    if (segment === undefined || first === undefined || last === undefined) {
      continue;
    }
    if (action === "program") {
      for (const piece of segment.pieces) {
        const range = rangeOf(piece);
        if (range !== null) {
          candidates.push(partOf(segment.segmentId, piece, range));
        }
      }
      continue;
    }
    const isStart = index === start;
    const isLast = index === program.length - 1;
    const head = isStart ? null : headOf(first);
    const tail = isLast ? null : tailOf(last);
    if (
      head !== null &&
      tail !== null &&
      segment.pieces.length === 1 &&
      head.end >= tail.start
    ) {
      const whole = rangeOf(first);
      if (whole !== null) {
        candidates.push(partOf(segment.segmentId, first, whole));
      }
      continue;
    }
    if (head !== null) {
      candidates.push(partOf(segment.segmentId, first, head));
    }
    if (tail !== null) {
      candidates.push(partOf(segment.segmentId, last, tail));
    }
  }

  return candidates.filter((part) => {
    const probe = media[part.sourceId]?.probe;
    return probe !== undefined && canPlaySegment(probe, part.startPts, part.endPts);
  });
}

/**
 * A key of the program that a run plays (ADR 074): the generation of the sequence, the clips in
 * their order, the boundaries of every segment, and the pieces of each segment of the program in
 * the export order. Two states with the same key give the same program. The name of a segment,
 * the selection, the attached clip and the length that an element reports for a source are not
 * in the key, except where they change the pieces of the program.
 */
export function programKey(timeline: ProgramInput): string {
  return JSON.stringify([
    timeline.generation,
    timeline.clips.map((clip) => [clip.id, clip.sourceId]),
    timeline.sequenceSegments.map((segment) => [
      segment.id,
      segment.inClipId,
      segment.inPts,
      segment.outClipId,
      segment.outPts,
    ]),
    programSegments(timeline).map((segment) => [
      segment.segmentId,
      segment.pieces.map((piece) => [
        piece.clipId,
        piece.sourceId,
        piece.inPts,
        piece.outPts,
      ]),
    ]),
  ]);
}
