/**
 * Pure model of the two motions of the segment layer: the fade of a segment that the user just
 * made, and the flash of the cut point of a split.
 *
 * Both motions change the opacity only. No timeline object moves or changes its size with a
 * transition or an animation: the position and the width of a segment, the playhead and every
 * other mark follow the time model at once (ADR 007, ADR 022).
 *
 * The layer keeps one `SegmentMotionState` from render to render, and advances it with each new
 * segment list (`advanceSegmentMotion`). A segment enters when its identifier is in the new list
 * of the active source and was not in the previous list. That covers every way that the user
 * makes a segment or brings one back:
 *
 * - Mark Out with no current segment appends a segment with a new identifier.
 * - Split keeps the identifier of the left half and gives the right half a new one.
 * - Undo of a Delete, and Redo of a Mark Out or a Split, restore an identifier that the list
 *   lost.
 *
 * Nothing else enters:
 *
 * - The first list of the layer is the baseline, so a source that loads, and the layer when it
 *   mounts again, show every segment at once.
 * - A change of the active source starts a new baseline.
 * - A zoom, a scroll, a resize and a selection do not change the list, so the state and its
 *   classes stay as they are, and the browser does not start the animation again.
 * - A trim and a Mark In or Mark Out on the current segment keep the identifier.
 *
 * The functions take plain values and return new values, so the tests need no store and no
 * document.
 */

import { getActiveSourceSegmentEntries } from "@/features/timeline";
import type { Pts, Segment } from "@/types/project";

/** The cut point of a split that flashes once. */
export interface SegmentCutFlash {
  /**
   * The React key of the flash: both identifiers and the PTS. A Redo of the same split mounts a
   * new element, so its flash runs again.
   */
  readonly key: string;
  /** The PTS of the shared edge: the Out of the left half and the In of the right half. */
  readonly pts: Pts;
}

/** The motion state of the segment layer after one segment list. */
export interface SegmentMotionState {
  /** The active source of that list. */
  readonly sourceId: string | null;
  /** The segment list, in project order. The next list is compared with it. */
  readonly segments: readonly Segment[];
  /** The segments of the active source that fade in, by identifier. */
  readonly enteringIds: ReadonlySet<string>;
  /** The cut points of the splits in the last change, in the order of the list. */
  readonly cutFlashes: readonly SegmentCutFlash[];
}

const NO_IDS: ReadonlySet<string> = new Set<string>();
const NO_CUTS: readonly SegmentCutFlash[] = [];

/**
 * The baseline state for a segment list: nothing enters and nothing flashes.
 *
 * @param sourceId The active source of the timeline.
 * @param segments The project segment array.
 */
export function createSegmentMotionState(
  sourceId: string | null,
  segments: readonly Segment[],
): SegmentMotionState {
  return { sourceId, segments, enteringIds: NO_IDS, cutFlashes: NO_CUTS };
}

/**
 * Finds the cut points of the splits in one change. A cut is an entering segment `right`, and a
 * segment `left` that was in the previous list, where `left` kept its In and now ends at the In
 * of `right`, and `right` ends at the old Out of `left`. That is the result of Split, `[in, p)`
 * and `[p, out)` from `[in, out)` (ADR 007), and of a Redo of it. A Mark Out that starts at the
 * Out of another segment makes an adjacent pair too, but the other segment did not change, so it
 * is not a cut. PTS values are canonical decimal strings (ADR 010), so string equality is exact.
 */
function findCutFlashes(
  after: readonly Segment[],
  before: ReadonlyMap<string, Segment>,
  enteringIds: ReadonlySet<string>,
): readonly SegmentCutFlash[] {
  const cuts: SegmentCutFlash[] = [];
  for (const right of after) {
    if (!enteringIds.has(right.id)) {
      continue;
    }
    for (const left of after) {
      const old = before.get(left.id);
      if (
        old !== undefined &&
        left.inPts === old.inPts &&
        left.outPts === right.inPts &&
        old.outPts === right.outPts
      ) {
        cuts.push({ key: `${left.id}|${right.id}|${right.inPts}`, pts: right.inPts });
        break;
      }
    }
  }
  return cuts.length === 0 ? NO_CUTS : cuts;
}

/**
 * Advances the motion state to a new segment list.
 *
 * - The same list and the same source return the previous state itself, so a render for a zoom
 *   or a selection changes no class.
 * - A new source returns a new baseline, in which nothing enters.
 * - Otherwise the segments of the active source whose identifiers were not in the previous list
 *   enter, and the splits among them flash at their cut points. A change that adds no
 *   identifier, such as a trim or a Delete, clears both, so the classes of an earlier change do
 *   not stay.
 *
 * @param previous The state after the previous list.
 * @param sourceId The active source of the timeline.
 * @param segments The project segment array, in project order.
 */
export function advanceSegmentMotion(
  previous: SegmentMotionState,
  sourceId: string | null,
  segments: readonly Segment[],
): SegmentMotionState {
  if (previous.segments === segments && previous.sourceId === sourceId) {
    return previous;
  }
  if (previous.sourceId !== sourceId) {
    return createSegmentMotionState(sourceId, segments);
  }

  const before = new Map<string, Segment>();
  for (const { segment } of getActiveSourceSegmentEntries(
    previous.segments,
    sourceId,
  )) {
    before.set(segment.id, segment);
  }
  const after = getActiveSourceSegmentEntries(segments, sourceId).map(
    ({ segment }) => segment,
  );

  const entering = new Set<string>();
  for (const segment of after) {
    if (!before.has(segment.id)) {
      entering.add(segment.id);
    }
  }
  if (entering.size === 0) {
    return createSegmentMotionState(sourceId, segments);
  }
  return {
    sourceId,
    segments,
    enteringIds: entering,
    cutFlashes: findCutFlashes(after, before, entering),
  };
}
