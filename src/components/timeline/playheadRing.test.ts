import { describe, expect, it } from "vitest";
import type { TimelineStoreState } from "@/features/timeline";
import { selectSelectedFillCanBeUnderPlayhead } from "./playheadRing";

/** A store state that holds only the two fields that the selector reads. */
function state(
  currentSegmentId: string | null,
  pendingInPts: string | null,
): TimelineStoreState {
  return { currentSegmentId, pendingInPts } as unknown as TimelineStoreState;
}

describe("selectSelectedFillCanBeUnderPlayhead", () => {
  it("is true only while a segment is current and no In mark is pending", () => {
    expect(selectSelectedFillCanBeUnderPlayhead(state("segment-1", null))).toBe(true);
    expect(selectSelectedFillCanBeUnderPlayhead(state(null, null))).toBe(false);
    expect(selectSelectedFillCanBeUnderPlayhead(state(null, "30"))).toBe(false);
  });

  it("keeps the ring off a pending In mark, even in a state that the store never holds", () => {
    expect(selectSelectedFillCanBeUnderPlayhead(state("segment-1", "30"))).toBe(false);
  });
});
