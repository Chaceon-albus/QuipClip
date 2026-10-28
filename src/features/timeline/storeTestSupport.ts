/**
 * Test support: a timeline store of one clip, built from segments of the one-source shape.
 *
 * With one clip, a virtual PTS is the source PTS (`virtualTime.ts`), so a test written for the one
 * source of ADR 007 keeps its PTS values. The source has the widest range that a PTS can take and
 * no known end, so every PTS of such a test lies in it.
 */

import { I64_MIN, ptsFromBigInt } from "@/lib/time";
import type { Pts, Segment, SequenceSegment } from "@/types/project";
import type { SequenceSource } from "./sequence";
import {
  createTimelineStore,
  sequenceSourceIdOf,
  singleClipIdOf,
  type TimelineStore,
  type TimelineStoreDependencies,
} from "./store";

/** The source of the one clip. */
export const TEST_SOURCE: SequenceSource = {
  id: "test-source",
  videoTimeBase: { n: 1, d: 90000 },
  videoStartPts: ptsFromBigInt(I64_MIN),
  videoEndPts: null,
  videoDurationTicks: null,
  approximateDurationSeconds: null,
};

/** The identifier of the one clip. */
export const TEST_CLIP_ID = singleClipIdOf(TEST_SOURCE.id);

/** The virtual source ID of the store that `createOneClipTimelineStore` builds. */
export const TEST_SEQUENCE_SOURCE_ID = sequenceSourceIdOf(1);

/** The bounds of a segment in the one-source shape. Its `sourceId`, if any, is ignored. */
export type OneSourceSegment = Pick<Segment, "id" | "inPts" | "outPts"> & {
  readonly sourceId?: string;
};

/** A segment of the one clip, from the bounds of a one-source segment. */
export function anchoredOnTestClip(segment: OneSourceSegment): SequenceSegment {
  return {
    id: segment.id,
    inClipId: TEST_CLIP_ID,
    inPts: segment.inPts,
    outClipId: TEST_CLIP_ID,
    outPts: segment.outPts,
  };
}

/** Options of `createOneClipTimelineStore`. */
export interface OneClipTimelineOptions {
  readonly segments?: readonly OneSourceSegment[];
  readonly pendingInPts?: Pts | null;
  readonly selectedSegmentIds?: readonly string[];
  readonly currentSegmentId?: string | null;
}

/** A timeline store whose sequence is the one clip of `TEST_SOURCE`, in generation 1. */
export function createOneClipTimelineStore(
  options: OneClipTimelineOptions = {},
  dependencies: TimelineStoreDependencies = {},
): TimelineStore {
  return createTimelineStore(dependencies, {
    clips: [{ id: TEST_CLIP_ID, sourceId: TEST_SOURCE.id }],
    sequenceSources: { [TEST_SOURCE.id]: TEST_SOURCE },
    sequenceSegments: (options.segments ?? []).map(anchoredOnTestClip),
    pendingIn:
      options.pendingInPts == null
        ? null
        : { clipId: TEST_CLIP_ID, pts: options.pendingInPts },
    attachedClipId: TEST_CLIP_ID,
    generation: 1,
    selectedSegmentIds: options.selectedSegmentIds,
    currentSegmentId: options.currentSegmentId ?? null,
  });
}
