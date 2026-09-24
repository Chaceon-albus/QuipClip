import type { DOMAttributes, ReactNode } from "react";
import { preventFocusOnMouseDown } from "@/components/common/preventFocusOnMouseDown";
import { calculatePlayheadLayout } from "@/features/timeline";
import type { TimecodeDisplay } from "@/lib/timecode";
import type { Pts, Rational } from "@/types/project";
import { usePlayheadTimecode } from "./playheadTimecode";
import { useDisplayedPlaybackPosition } from "./useDisplayedPlaybackPosition";

/*
 * The layers in this file draw the displayed playback position. Each one subscribes to it,
 * so each one renders on every presented frame during playback. Keep them small: no
 * translation lookup, no segment list and no ruler ticks render here. The panel passes the
 * labels in as props.
 *
 * The playhead moves with `left` and not with a transform. `left` is a percentage of the
 * lane, which the engine rounds to its layout unit and then snaps to device pixels when it
 * paints the 2px line. A translation is not snapped that way: at a fractional offset the
 * line can straddle two device pixels and paint with soft edges, and the head would leave
 * the pixel boundaries of the line. A translation in pixels from the measured lane width
 * would not match either, because that width comes from the rounded viewport width
 * multiplied by the zoom factor. A change of `left` on an absolutely positioned box needs a
 * layout of that box only, and not of the rows around it.
 */

/** The pointer handlers of one scrub surface of the timeline (ADR 022). */
export type ScrubSurfaceHandlers = Pick<
  DOMAttributes<HTMLDivElement>,
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
  | "onPointerCancel"
  | "onLostPointerCapture"
>;

interface PositionLayerProps {
  videoStartPts: Pts | null | undefined;
  videoTimeBase: Rational | null | undefined;
  totalDurationSeconds: number | null;
}

export interface RulerPlayheadProps extends PositionLayerProps {
  ariaLabel: string;
}

/**
 * Playhead in the ruler: the upper part of one line that the track playhead continues
 * below the divider. The line spans the full ruler height and the head lies over its top,
 * both centred on the playhead position. The head is 12px wide, an even width like the 2px
 * line, so its edges and its tip fall on the same pixel boundaries as the line. It is 12px
 * tall, so it leaves most of a timecode label under the playhead visible.
 *
 * The outline is a 1px ring in the timeline background colour, so the line stays visible
 * over a fill of a similar colour, such as the selected segment. It is a drop-shadow filter
 * on this wrapper, and not a box-shadow, for two reasons: clip-path removes the head's own
 * shadow, and one filter outlines the head and the line as one shape, with no gap below the
 * tip. The ring has a left, a right and a lower edge only, the same ring as the track
 * playhead.
 */
export function RulerPlayhead({
  videoStartPts,
  videoTimeBase,
  totalDurationSeconds,
  ariaLabel,
}: RulerPlayheadProps) {
  const { elapsedSeconds, isApproximate } = useDisplayedPlaybackPosition(
    videoStartPts,
    videoTimeBase,
  );
  const playhead = calculatePlayheadLayout(elapsedSeconds, totalDurationSeconds);

  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-30 -translate-x-1/2 drop-shadow-[1px_0_0,-1px_0_0,0_1px_0] drop-shadow-timeline-background"
      style={{ left: playhead.left }}
      aria-label={ariaLabel}
      data-approximate={isApproximate}
    >
      <div className="h-full w-0.5 bg-timeline-playhead" />
      <div className="absolute top-0 left-1/2 h-3 w-3 -translate-x-1/2 bg-timeline-playhead [clip-path:polygon(0_0,100%_0,100%_50%,50%_100%,0_50%)]" />
    </div>
  );
}

export interface TrackPlayheadProps extends PositionLayerProps {
  canSeek: boolean;
  scrubHandlers: ScrubSurfaceHandlers;
}

/**
 * Track playhead layer. The panel places it after the segment group at z-30, so the 9px
 * hit area is grabbable above segments.
 *
 * The layer spans the full track height, and `-top-px` pulls it up over the 1px divider,
 * so it meets the ruler playhead and the two read as one line from the top of the ruler to
 * the bottom of the track.
 *
 * The line has the same outline as the ruler playhead: a drop-shadow ring in the timeline
 * background colour on the left, the right and the lower edge. It has no upper edge on
 * purpose. That edge would paint over the lowest pixel of the ruler line, and the one line
 * would show a gap.
 */
export function TrackPlayhead({
  videoStartPts,
  videoTimeBase,
  totalDurationSeconds,
  canSeek,
  scrubHandlers,
}: TrackPlayheadProps) {
  const { elapsedSeconds, isApproximate } = useDisplayedPlaybackPosition(
    videoStartPts,
    videoTimeBase,
  );
  const playhead = calculatePlayheadLayout(elapsedSeconds, totalDurationSeconds);

  return (
    <div className="pointer-events-none absolute inset-x-0 -top-px bottom-0 z-30">
      <div
        className="pointer-events-none absolute inset-y-0 flex -translate-x-1/2 flex-col items-center"
        style={{ left: playhead.left }}
        data-approximate={isApproximate}
      >
        <div
          {...scrubHandlers}
          className={`flex h-full w-[9px] touch-none items-center justify-center ${canSeek ? "pointer-events-auto cursor-ew-resize" : "pointer-events-none"}`}
        >
          <div className="h-full w-0.5 bg-timeline-playhead drop-shadow-[1px_0_0,-1px_0_0,0_1px_0] drop-shadow-timeline-background" />
        </div>
      </div>
    </div>
  );
}

export interface TimelineSeekSliderProps extends PositionLayerProps {
  ariaLabel: string;
  canSeek: boolean;
  scrubHandlers: ScrubSurfaceHandlers;
  /** The timecode format of the source (ADR 028). The value must be memoized. */
  timecodeDisplay: TimecodeDisplay;
  /**
   * The content of the seek surface. The panel creates these elements, so a render of the
   * slider for a new position reuses them and does not render them again.
   */
  children: ReactNode;
}

/**
 * Canonical accessible seek surface. Its 8px vertical inset holds the source bar, the
 * pending In overlays, the hit area and the focus ring clear of the ruler divider and of
 * the lower panel edge.
 *
 * It renders per frame only for `aria-valuenow` and `aria-valuetext`, the displayed playhead
 * position. The value text is the timecode that the preview shows, in the format of the
 * source, so a screen reader does not read a number of seconds. Both values come from the
 * same subscription, so the text adds no render.
 */
export function TimelineSeekSlider({
  videoStartPts,
  videoTimeBase,
  totalDurationSeconds,
  ariaLabel,
  canSeek,
  scrubHandlers,
  timecodeDisplay,
  children,
}: TimelineSeekSliderProps) {
  const { elapsedSeconds } = useDisplayedPlaybackPosition(videoStartPts, videoTimeBase);
  const timecode = usePlayheadTimecode(videoStartPts, videoTimeBase, timecodeDisplay);
  // The same test as the panel's, repeated here so that it narrows the duration to a number.
  const isIndeterminate = totalDurationSeconds === null || totalDurationSeconds <= 0;
  const hasValue = !isIndeterminate && Number.isFinite(elapsedSeconds);

  return (
    <div
      role="slider"
      aria-label={ariaLabel}
      aria-disabled={!canSeek}
      aria-valuemin={0}
      aria-valuemax={isIndeterminate ? undefined : totalDurationSeconds}
      aria-valuenow={
        hasValue
          ? Math.max(0, Math.min(totalDurationSeconds, elapsedSeconds))
          : undefined
      }
      // The value text names the time that the preview shows, and it is not clamped as the
      // preview is not. So it can name a time outside [0, extent] while `aria-valuenow` is
      // clamped to the extent, and it stays while the extent is unknown and there is no
      // `aria-valuenow`.
      aria-valuetext={timecode}
      tabIndex={canSeek ? 0 : undefined}
      // A mouse press does not move the focus to the slider, as a press on a button of the
      // transport bar does not (ADR 021). A click focuses an element with a `tabIndex`, and
      // WebView2 then draws the focus ring around the whole track at the next key press,
      // such as Space or an arrow key. The scrub runs on the pointer events, so the gesture
      // does not change. The Tab key still focuses the slider.
      onMouseDown={preventFocusOnMouseDown}
      {...scrubHandlers}
      className={`absolute inset-x-0 inset-y-2 touch-none ${canSeek ? "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden" : ""}`}
    >
      {children}
    </div>
  );
}
