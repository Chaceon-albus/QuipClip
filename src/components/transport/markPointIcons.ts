/**
 * The Mark In and Mark Out glyphs of the transport bar.
 *
 * Each glyph is the shape of its marker on the timeline: a bracket whose open side faces the
 * segment, and a faint block for the segment itself. The In bracket `[` is the pending In
 * mark of the track, which opens to the right of the In boundary. The Out bracket `]` is the
 * right edge of a segment box. The block repeats the fill of the pending region and of a
 * segment, so the two glyphs read as the two ends of one segment.
 *
 * `createLucideIcon` gives the glyphs the frame of every other icon of the bar: the 24-unit
 * grid, the 2-unit stroke with round caps and joins, `currentColor`, the size classes and
 * `aria-hidden`. The brackets are the two halves of the lucide `brackets` glyph.
 */

import { createLucideIcon } from "lucide-react";

/** The opacity of the segment block, faint beside the full stroke of the bracket. */
const SEGMENT_BLOCK_OPACITY = "0.35";

export const MarkInIcon = createLucideIcon("quipclip-mark-in", [
  ["path", { d: "M8 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3", key: "bracket" }],
  [
    "rect",
    {
      x: "7",
      y: "6",
      width: "13",
      height: "12",
      rx: "1.5",
      fill: "currentColor",
      fillOpacity: SEGMENT_BLOCK_OPACITY,
      stroke: "none",
      key: "segment",
    },
  ],
]);

export const MarkOutIcon = createLucideIcon("quipclip-mark-out", [
  ["path", { d: "M16 3h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-3", key: "bracket" }],
  [
    "rect",
    {
      x: "4",
      y: "6",
      width: "13",
      height: "12",
      rx: "1.5",
      fill: "currentColor",
      fillOpacity: SEGMENT_BLOCK_OPACITY,
      stroke: "none",
      key: "segment",
    },
  ],
]);
