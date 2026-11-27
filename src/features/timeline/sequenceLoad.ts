/**
 * The test of a whole sequence before the timeline store takes it as its truth (ADR 052, ADR 072).
 *
 * The open of a project puts the clips, the sources and the segments of a document on the
 * sequence as one step (`loadSequence` of the timeline store). The save step and the open step
 * test a document first, with the facts of the document only (`checkProjectDocument`). Both use
 * this one function, so the test of a document refuses exactly what the store would refuse for
 * the same data.
 *
 * The test applies the rules that the store applies to its own edits: the clips can be laid out
 * with these sources and no length from the web view, the sequence has a virtual axis, and each
 * segment keeps the rules of ADR 052. It also refuses the forms that the store cannot hold: a
 * repeated identifier and a segment name that is not valid (ADR 065).
 *
 * It accepts each state that the edits of the store can produce. One such state has a segment
 * that keeps the rules of ADR 052 but has no place on the virtual axis, because a later insert
 * made the axis finer: the timeline shows no bar for it, and it stays in the truth. So the test
 * does not ask for a place on the axis.
 *
 * Every function is pure.
 */

import type { Clip, SequenceSegment } from "@/types/project";
import { isValidSegmentName } from "./segmentName";
import {
  isValidSequenceSegment,
  layoutSequence,
  type SequenceSource,
  type SequenceSources,
} from "./sequence";
import { buildVirtualTimeline } from "./virtualTime";

/** Why a sequence cannot be loaded. */
export type SequenceLoadProblem =
  /** Two sources have this identifier. */
  | { readonly kind: "duplicateSource"; readonly sourceId: string }
  /** Two clips have this identifier. */
  | { readonly kind: "duplicateClip"; readonly clipId: string }
  /** The clip names a source that is not in the list. */
  | {
      readonly kind: "unknownSource";
      readonly clipId: string;
      readonly sourceId: string;
    }
  /**
   * The clip has no extent, and another clip is on the sequence (ADR 052). The start of each clip
   * after it would be unknown. The document has no length from the web view, so a sequence that
   * had such a clip next to another one cannot be saved (ADR 072, Save step 2).
   */
  | {
      readonly kind: "clipExtentUnknown";
      readonly clipId: string;
      readonly sourceId: string;
    }
  /**
   * The clips cannot be laid out on one virtual axis for another reason: a time base that is not
   * a safe positive rational, or a value outside the range of a PTS (ADR 002).
   */
  | { readonly kind: "layoutFailed" }
  /** Two segments have this identifier. */
  | { readonly kind: "duplicateSegment"; readonly segmentId: string }
  /** The segment has a name that `isValidSegmentName` refuses (ADR 065). */
  | { readonly kind: "invalidSegmentName"; readonly segmentId: string }
  /** The segment breaks a rule of ADR 052. */
  | { readonly kind: "invalidSegment"; readonly segmentId: string };

/** The result of `checkSequenceLoad`. */
export type SequenceLoadCheck =
  { readonly ok: true } | { readonly ok: false; readonly problem: SequenceLoadProblem };

const LOADABLE: SequenceLoadCheck = { ok: true };

function refused(problem: SequenceLoadProblem): SequenceLoadCheck {
  return { ok: false, problem };
}

/**
 * The first clip that has no extent of its own, with no length from the web view. Only
 * `layoutSequence` computes an extent (ADR 052), so the test lays out each clip alone.
 */
function clipWithoutExtent(
  clips: readonly Clip[],
  sources: SequenceSources,
): Clip | undefined {
  return clips.find(
    (clip) => layoutSequence([clip], sources)?.placements[0]?.duration === null,
  );
}

/**
 * Tests whether the timeline store can take `clips`, `sources` and `segments` as its whole truth,
 * with no length from the web view. The checks run in this order, and the first failure is the
 * result: the identifiers of the sources, the identifiers of the clips, the source of each clip,
 * the layout and the virtual axis, and then each segment in array order.
 *
 * A source that no clip names is allowed. A list with no clip is loadable only with no segment.
 */
export function checkSequenceLoad(
  clips: readonly Clip[],
  sources: readonly SequenceSource[],
  segments: readonly SequenceSegment[],
): SequenceLoadCheck {
  const byId = new Map<string, SequenceSource>();
  for (const source of sources) {
    if (byId.has(source.id)) {
      return refused({ kind: "duplicateSource", sourceId: source.id });
    }
    byId.set(source.id, source);
  }

  const clipIds = new Set<string>();
  for (const clip of clips) {
    if (clipIds.has(clip.id)) {
      return refused({ kind: "duplicateClip", clipId: clip.id });
    }
    clipIds.add(clip.id);
  }
  for (const clip of clips) {
    if (!byId.has(clip.sourceId)) {
      return refused({
        kind: "unknownSource",
        clipId: clip.id,
        sourceId: clip.sourceId,
      });
    }
  }

  // No length from the web view: the layout of the store reads none after a load either.
  const virtual = clips.length === 0 ? null : buildVirtualTimeline(clips, byId);
  if (clips.length > 0 && virtual === null) {
    const missing =
      layoutSequence(clips, byId) === null ? clipWithoutExtent(clips, byId) : undefined;
    return refused(
      missing === undefined
        ? { kind: "layoutFailed" }
        : { kind: "clipExtentUnknown", clipId: missing.id, sourceId: missing.sourceId },
    );
  }

  const segmentIds = new Set<string>();
  for (const segment of segments) {
    if (segmentIds.has(segment.id)) {
      return refused({ kind: "duplicateSegment", segmentId: segment.id });
    }
    segmentIds.add(segment.id);
    if (segment.name !== undefined && !isValidSegmentName(segment.name)) {
      return refused({ kind: "invalidSegmentName", segmentId: segment.id });
    }
    // The rules that each edit of the store keeps (ADR 052).
    if (!isValidSequenceSegment(segment, clips, byId)) {
      return refused({ kind: "invalidSegment", segmentId: segment.id });
    }
  }
  return LOADABLE;
}
