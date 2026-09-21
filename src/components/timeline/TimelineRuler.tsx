import { memo } from "react";
import type { RulerMarker } from "./timelineMarkers";

export interface TimelineRulerProps {
  markers: readonly RulerMarker[];
}

/**
 * Memoized ruler tick list component.
 *
 * This is required, not an optimisation. The tick count rises from 6 to as many as
 * 400, and TimelinePanel subscribes to presentedFrame, so it re-renders on every
 * presented frame during playback. Leaving up to 400 elements in that render body
 * would create and reconcile them about sixty times a second.
 */
export const TimelineRuler = memo(function TimelineRuler({
  markers,
}: TimelineRulerProps) {
  return (
    <>
      {markers.map((marker) => (
        <div
          key={`${marker.seconds}-${marker.left}`}
          className="pointer-events-none absolute bottom-0 flex -translate-x-1/2 flex-col items-center gap-0.5"
          style={{ left: marker.left }}
        >
          <span className="text-muted-foreground">{marker.timecode}</span>
          <div className="h-1.5 w-px bg-timeline-divider" />
        </div>
      ))}
    </>
  );
});
