import type { TimelineStoreState } from "@/features/timeline";

/**
 * Whether the fill of the selected segment can lie under the track playhead and the frame
 * band: a segment is current, and no In mark is pending. The timeline store never holds a
 * current segment and a pending In together (ADR 007), so the selected fill and a pending In
 * do not show together. The second test keeps the ring off the pending In marks in every
 * state. The value is a boolean, so it renders a layer only when it changes, and not on each
 * presented frame.
 */
export const selectSelectedFillCanBeUnderPlayhead = (state: TimelineStoreState) =>
  state.currentSegmentId !== null && state.pendingInPts === null;
