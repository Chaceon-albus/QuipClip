import type { TimelineStoreState } from "@/features/timeline";

/**
 * Whether the fill of a selected segment can lie under the track playhead and the frame band:
 * a segment is selected, and no In mark is pending. Several segments can be selected, and then
 * none is current (ADR 045), so the test reads the selection and not the current segment. The
 * timeline store never holds a selection and a pending In together (ADR 007, ADR 045), so the
 * selected fill and a pending In do not show together. The second test keeps the ring off the
 * pending In marks in every state. The value is a boolean, so it renders a layer only when it
 * changes, and not on each presented frame.
 */
export const selectSelectedFillCanBeUnderPlayhead = (state: TimelineStoreState) =>
  state.selectedSegmentIds.length > 0 && state.pendingInPts === null;
