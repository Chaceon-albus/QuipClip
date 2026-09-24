import { memo, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import type { RulerLabelAnchor } from "./rulerLabel";
import { calculateMinorTickPeriod, type RulerTick } from "./timelineMarkers";

export interface TimelineRulerProps {
  ticks: readonly RulerTick[];
  /** The seconds between two minor ticks, or null for no minor ticks. */
  minorSeconds: number | null;
  /** The first labels that anchor at their start (`countRulerEdgeAnchors`). */
  startAnchoredCount: number;
  /** The last labels that anchor at their end (`countRulerEdgeAnchors`). */
  endAnchoredCount: number;
}

const LABEL_ANCHOR_CLASS: Record<RulerLabelAnchor, string> = {
  center: "-translate-x-1/2",
  start: "translate-x-0",
  end: "-translate-x-full",
};

/** The inline style of one interval. The minor period is a custom property. */
type RulerIntervalStyle = CSSProperties & { "--ruler-minor-period"?: string };

/**
 * Memoized ruler tick list component.
 *
 * Each major tick is one interval element and one label. The interval runs from the tick
 * to the next tick. Its background draws the major tick at its left edge and the minor
 * ticks inside it (the `timeline-ruler-interval` utility), so the minor ticks need no
 * element of their own. Each interval starts its minor ticks again at its own major tick,
 * so no rounding of a repeated background tile adds up along a lane that can be 100,000 px
 * wide.
 *
 * A tick at the lane end has an empty interval. Its element is the last pixel column of the
 * lane, so its major tick stays visible inside the clip at the lane end. The tick at the
 * lane start draws its full line to the right of the gutter.
 *
 * The major tick is 4 px tall and the minor tick 2 px. The minor ticks are decorative: the
 * labels and the major ticks carry the time, so the minor ticks keep a lower contrast than
 * WCAG 1.4.11 asks of a graphic that carries information (see `--timeline-tick-minor`).
 *
 * Each label box is 10 px tall and sits on its major tick, at the bottom of the ruler. The
 * ruler content is 27 px tall, so the box starts 13 px below its top. The pending In flag
 * and the playhead head take the top 12 px, so they do not overlap a label box.
 *
 * The tick count rises from a few to as many as 400. TimelinePanel does not render per
 * presented frame, but it does render for changes that keep the ticks, such as a change of
 * the seek availability, of the media status, or of the zoom inside one step. The memo
 * keeps those renders from creating and reconciling up to 800 elements. The anchor counts
 * are numbers for the same reason. Do not move the ticks into a layer that subscribes to
 * the playback position.
 */
export const TimelineRuler = memo(function TimelineRuler({
  ticks,
  minorSeconds,
  startAnchoredCount,
  endAnchoredCount,
}: TimelineRulerProps) {
  const firstEndAnchored = ticks.length - endAnchoredCount;
  return (
    <>
      {ticks.map((tick, index) => {
        const anchor: RulerLabelAnchor =
          index < startAnchoredCount
            ? "start"
            : index >= firstEndAnchored
              ? "end"
              : "center";
        const isAtLaneEnd = tick.percent >= 100;
        const style: RulerIntervalStyle = isAtLaneEnd
          ? { left: "calc(100% - 1px)", width: "1px" }
          : { left: tick.left, width: tick.width };
        const period = calculateMinorTickPeriod(minorSeconds, tick.intervalSeconds);
        if (period !== null) {
          style["--ruler-minor-period"] = period;
        }
        return (
          <div
            key={tick.seconds}
            className="pointer-events-none absolute bottom-0 h-1 timeline-ruler-interval"
            style={style}
          >
            <span
              className={cn(
                "absolute bottom-full left-0 leading-none whitespace-nowrap text-muted-foreground",
                LABEL_ANCHOR_CLASS[anchor],
              )}
            >
              {tick.label}
            </span>
          </div>
        );
      })}
    </>
  );
});
