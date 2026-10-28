/**
 * The vertical line that shows where dropped videos go on the track lane (ADR 052). It shows only
 * while a drag of video files is over the lane.
 */

import { useFileDropTarget } from "@/components/layout/fileDropTarget";

export function DropJunctionLine() {
  const target = useFileDropTarget();
  if (target === null) {
    return null;
  }
  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-30 w-0.5 -translate-x-1/2 bg-timeline-mark"
      style={{ left: `${target.leftPercent}%` }}
      aria-hidden
    />
  );
}
