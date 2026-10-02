/**
 * Pure geometry of the pending In region in the track (`PendingInLayer.tsx`).
 *
 * The playhead line is 2px wide and centred on its position, so it covers one pixel on each
 * side of it (`PlayheadLayer.tsx`). The vertical strokes of the pending In marks are centred
 * on their positions in the same way. The left stroke of the bracket and the left border of
 * the region then cover the pixels that the playhead covers when it stands on the In, and the
 * right border of the region covers the pixels of the playhead. So the In does not look
 * offset from the position of the playhead at Mark In.
 *
 * The percentages stay those of `calculatePendingInRegionLayoutFromSeconds`, so the time axis
 * does not change (ADR 007). Only a fixed pixel offset is added to each value.
 */

import type { PendingInRegionLayout } from "@/features/timeline";

/**
 * The width of the dashed border of the pending In region, in CSS pixels. It must stay equal
 * to the `border-2` class of the region.
 */
export const PENDING_IN_REGION_BORDER_PX = 2;

/** The CSS `left` and `width` of the box of the pending In region. */
export interface PendingInRegionBox {
  readonly left: string;
  readonly width: string;
}

/**
 * The box of the pending In region, with each side border centred on its edge.
 *
 * The box starts half a border width before the In boundary and ends half a border width
 * after the displayed playback position. Its left border then covers [In − 1px, In + 1px] and
 * its right border [playhead − 1px, playhead + 1px].
 *
 * @param layout The CSS percentages of the region: `left` is the In boundary, and `left` plus
 *   `width` is the displayed playback position.
 */
export function calculatePendingInRegionBox(
  layout: Pick<PendingInRegionLayout, "left" | "width">,
): PendingInRegionBox {
  const halfBorderPx = PENDING_IN_REGION_BORDER_PX / 2;
  return {
    left: `calc(${layout.left} - ${halfBorderPx}px)`,
    width: `calc(${layout.width} + ${PENDING_IN_REGION_BORDER_PX}px)`,
  };
}
