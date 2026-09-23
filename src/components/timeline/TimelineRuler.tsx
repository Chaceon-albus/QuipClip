import { memo } from "react";
import type { RulerMarker } from "./timelineMarkers";

export interface TimelineRulerProps {
  markers: readonly RulerMarker[];
}

/**
 * Memoized ruler tick list component.
 *
 * The tick count rises from 6 to as many as 400. TimelinePanel does not render per
 * presented frame, but it does render for changes that keep the markers, such as a
 * change of the seek availability or of the media status. The memo keeps those renders
 * from creating and reconciling up to 400 elements. Do not move the ticks into a layer
 * that subscribes to the playback position.
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
