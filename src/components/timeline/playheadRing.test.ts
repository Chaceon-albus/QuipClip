import { describe, expect, it } from "vitest";
import type { TimelineStoreState } from "@/features/timeline";
import { selectSelectedFillCanBeUnderPlayhead } from "./playheadRing";

/**
 * A store state that holds only the fields that the selector reads. The current segment is
 * the only selected one, or none, as the store keeps it (ADR 045).
 */
function state(
  selectedSegmentIds: readonly string[],
  pendingInPts: string | null,
): TimelineStoreState {
  return {
    selectedSegmentIds,
    currentSegmentId: selectedSegmentIds.length === 1 ? selectedSegmentIds[0] : null,
    pendingInPts,
  } as unknown as TimelineStoreState;
}

describe("selectSelectedFillCanBeUnderPlayhead", () => {
  it("is true only while a segment is selected and no In mark is pending", () => {
    expect(selectSelectedFillCanBeUnderPlayhead(state(["segment-1"], null))).toBe(true);
    expect(selectSelectedFillCanBeUnderPlayhead(state([], null))).toBe(false);
    expect(selectSelectedFillCanBeUnderPlayhead(state([], "30"))).toBe(false);
  });

  it("is true for a selection of several segments, where none is current", () => {
    expect(
      selectSelectedFillCanBeUnderPlayhead(state(["segment-1", "segment-2"], null)),
    ).toBe(true);
  });

  it("keeps the ring off a pending In mark, even in a state that the store never holds", () => {
    expect(selectSelectedFillCanBeUnderPlayhead(state(["segment-1"], "30"))).toBe(
      false,
    );
  });
});
