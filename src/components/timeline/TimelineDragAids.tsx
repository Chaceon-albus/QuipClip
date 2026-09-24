import { memo, type Ref } from "react";

/*
 * The elements of the two aids of the playhead drag: the hover line and the snap indicator.
 * Each aid has one element in the ruler lane and one in the track lane, as the playhead has.
 * The two lanes share one left edge and one width (ADR 007), so one position serves both.
 *
 * The elements render once, hidden, and stay mounted. The panel shows, moves and hides them
 * with DOM writes (`timelineHover.ts`), so a pointer move renders nothing. React never
 * receives a `style` prop or children for a written element, so a render of these layers
 * cannot undo a write. They take no pointer event, so the scrub surfaces under them keep every
 * press.
 *
 * They are z-30 and come after the playhead in the document, so they lie over the playhead
 * line, and under the sticky gutters at z-40.
 */

/**
 * Hides the hover line while the segment tooltip is open. The tooltip opens above a segment,
 * over the ruler, where the label of the line would collide with it. The anchor of that
 * tooltip is the only tooltip trigger in the track lane (`data-timeline-track`), and Radix
 * gives it `data-state="delayed-open"` or `"instant-open"` while the tooltip is open. The
 * selector reads that state, so the panel needs no script for it, and a tooltip that opens
 * after its delay, with no pointer move, hides the line too.
 */
const HIDDEN_WHILE_SEGMENT_TOOLTIP_OPEN =
  "group-has-[[data-timeline-track]_[data-slot=tooltip-trigger][data-state$=open]]/timeline:hidden";

export interface RulerHoverLineProps {
  lineRef: Ref<HTMLDivElement>;
  labelRef: Ref<HTMLSpanElement>;
}

/**
 * The hover line in the ruler, with its "≈ timecode" label.
 *
 * The line is 1px in the foreground colour at a low opacity, so it stays quieter than the
 * playhead. The label is a small chip in the tooltip colours at the top of the ruler, the band
 * of the playhead head and the pending In flag, so it does not cover the tick labels. It sits
 * to the right of the line, or to the left of it near the right edge of the view
 * (`resolveHoverLabelSide`).
 *
 * The label is decorative. The time it shows is a pixel position, which the accessible seek
 * slider does not need.
 */
export const RulerHoverLine = memo(function RulerHoverLine({
  lineRef,
  labelRef,
}: RulerHoverLineProps) {
  return (
    <div
      ref={lineRef}
      hidden
      aria-hidden="true"
      className={`pointer-events-none absolute inset-y-0 left-0 z-30 w-px bg-foreground/40 ${HIDDEN_WHILE_SEGMENT_TOOLTIP_OPEN}`}
    >
      <span
        ref={labelRef}
        data-side="right"
        className="absolute top-0 left-full ml-1 rounded-sm bg-tooltip px-1 font-mono text-[10px] leading-3 whitespace-nowrap text-tooltip-foreground tabular-nums data-[side=left]:right-full data-[side=left]:left-auto data-[side=left]:mr-1 data-[side=left]:ml-0"
      />
    </div>
  );
});

export interface TrackHoverLineProps {
  lineRef: Ref<HTMLDivElement>;
}

/**
 * The hover line in the track. `-top-px` pulls it over the divider under the ruler, as the
 * track playhead does, so the two parts read as one line.
 */
export const TrackHoverLine = memo(function TrackHoverLine({
  lineRef,
}: TrackHoverLineProps) {
  return (
    <div
      ref={lineRef}
      hidden
      aria-hidden="true"
      className={`pointer-events-none absolute -top-px bottom-0 left-0 z-30 w-px bg-foreground/40 ${HIDDEN_WHILE_SEGMENT_TOOLTIP_OPEN}`}
    />
  );
});

export interface SnapIndicatorProps {
  indicatorRef: Ref<HTMLDivElement>;
}

/**
 * The snap indicator in the ruler: a 1px line in the foreground colour, and a small diamond
 * under the playhead head.
 *
 * A snapped seek draws the playhead on the boundary, so the line lies in the middle of the
 * 2px playhead line and gives it a core of the other colour. The diamond is the part that
 * stays clear of the playhead. Its outline in the timeline background colour keeps it apart
 * from the tick labels under it.
 *
 * The indicator shows and hides at once. It has no transition, so it has nothing to reduce
 * for a user who asks for reduced motion.
 */
export const RulerSnapIndicator = memo(function RulerSnapIndicator({
  indicatorRef,
}: SnapIndicatorProps) {
  return (
    <div
      ref={indicatorRef}
      hidden
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 z-30 w-px bg-foreground"
    >
      <div className="absolute top-3.5 left-1/2 size-2 -translate-x-1/2 rotate-45 bg-foreground ring-1 ring-timeline-background" />
    </div>
  );
});

/** The snap indicator in the track: the lower part of the line of the ruler indicator. */
export const TrackSnapIndicator = memo(function TrackSnapIndicator({
  indicatorRef,
}: SnapIndicatorProps) {
  return (
    <div
      ref={indicatorRef}
      hidden
      aria-hidden="true"
      className="pointer-events-none absolute -top-px bottom-0 z-30 w-px bg-foreground"
    />
  );
});
