import { memo, useEffect, useId, useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  calculateSegmentLayout,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import type { TimecodeDisplay } from "@/lib/timecode";
import type { Pts, Rational } from "@/types/project";
import {
  buildSegmentTooltipRows,
  calculateSegmentWidthPx,
  formatSegmentTimes,
  measureSegmentLabel,
  numberSegmentsInExportOrder,
  resolveSegmentLabelTier,
} from "./segmentLabels";
import { SegmentTooltip, type SegmentTooltipEntry } from "./SegmentTooltip";
import { createSegmentTooltipController } from "./segmentTooltipController";

const selectSegments = (state: TimelineStoreState) => state.segments;
const selectCurrentSegmentId = (state: TimelineStoreState) => state.currentSegmentId;
const selectSelectSegment = (state: TimelineStoreState) => state.selectSegment;

export interface SegmentLayerProps {
  sourceId: string | null;
  videoStartPts: Pts | null | undefined;
  videoTimeBase: Rational | null | undefined;
  totalDurationSeconds: number | null;
  /** The width of the lane in CSS pixels. It sets the label tier of each segment. */
  laneWidthPx: number;
  /** The timecode format of the source (ADR 028). The value must be memoized. */
  timecodeDisplay: TimecodeDisplay;
  /**
   * The scroll container of the timeline. The tooltip reads its rectangle when it opens, to
   * anchor on the visible part of a segment.
   */
  viewportRef: RefObject<HTMLElement | null>;
}

/**
 * True when the element has keyboard focus. A click also focuses a button in Chromium, and
 * that focus must not open the tooltip. An engine that does not know the pseudo-class
 * treats every focus as a keyboard focus.
 */
function hasFocusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * Completed segment overlays. The layer takes the clicks of its buttons only, so uncovered
 * track stays a seek surface; over a segment, the ruler track above and the playhead hit
 * area are the seek surfaces. The `z-10` puts this layer under the pending region and the
 * playhead.
 *
 * One exception: an unselected segment narrower than 12px has a hit area of 12px. So a
 * click up to (12 − w) / 2 px beside a segment of width w selects it and does not seek.
 * The ruler above still seeks at that position.
 *
 * The layer subscribes to the segment list and the selection, and not to the playback
 * position. It is memoized, and no prop changes per presented frame, so a presented frame
 * never renders it again. A zoom or a resize of the lane changes `laneWidthPx` and renders
 * it again, because the label tier of a segment depends on its width in pixels. The layouts
 * and the texts stay memoized, so that render only chooses the tiers.
 *
 * All segments share one tooltip (see SegmentTooltip). A hover renders that tooltip and not
 * this layer.
 */
export const SegmentLayer = memo(function SegmentLayer({
  sourceId,
  videoStartPts,
  videoTimeBase,
  totalDurationSeconds,
  laneWidthPx,
  timecodeDisplay,
  viewportRef,
}: SegmentLayerProps) {
  const { t } = useTranslation();
  const segments = useTimelineStore(selectSegments);
  const currentSegmentId = useTimelineStore(selectCurrentSegmentId);
  const selectSegment = useTimelineStore(selectSelectSegment);
  const [tooltip] = useState(createSegmentTooltipController);
  const descriptionIdPrefix = useId();
  // A pending open must not fire after the layer unmounts.
  useEffect(() => () => tooltip.dispose(), [tooltip]);
  // A scroll of the timeline cancels a pending open and closes or moves the tooltip
  // (`SegmentTooltipController.scroll`). Radix watches scrolls only while its content is
  // mounted, so it cannot cancel an open that is still in its delay.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    const onScroll = () => tooltip.scroll();
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [viewportRef, tooltip]);

  // The numbers and the total count only the segments of the active source, as the export
  // does. They are taken before the zero-width filter below, because the export also joins a
  // segment that has no width on the timeline.
  const { entries: numberedSegments, total } = useMemo(
    () => numberSegmentsInExportOrder(segments, sourceId),
    [segments, sourceId],
  );
  // A selection change renders this layer again, and none of these inputs depends on the
  // selection. So the layouts, the texts and the numbers are built once per change of the
  // segment list, the source, the extent, the timecode format or the language, and not once
  // per selection click or zoom step.
  const segmentLayouts = useMemo(
    () =>
      numberedSegments
        .map(({ segment, projectIndex, number }) => {
          const layout = calculateSegmentLayout(
            segment,
            videoStartPts,
            videoTimeBase,
            totalDurationSeconds,
          );
          const times = formatSegmentTimes(
            segment,
            videoStartPts,
            videoTimeBase,
            timecodeDisplay,
          );
          const tooltipEntry: SegmentTooltipEntry = {
            id: segment.id,
            number,
            leftPercent: layout.leftPercent,
            widthPercent: layout.widthPercent,
            rows: buildSegmentTooltipRows(times),
          };
          return {
            segment,
            number,
            layout,
            compactDuration: times?.compactDuration ?? null,
            labelWidths: measureSegmentLabel(number, times?.compactDuration ?? null),
            label:
              times === null
                ? t("timeline.segment", { index: number })
                : t("timeline.segmentLabel", {
                    index: number,
                    inTime: times.inTime,
                    outTime: times.outTime,
                    duration: times.duration,
                  }),
            description: t("timeline.segmentDescription", { order: number, total }),
            // The index in the project array is unique, and an ID token cannot hold a space.
            descriptionId: `${descriptionIdPrefix}-segment-${projectIndex}`,
            tooltipEntry,
          };
        })
        // A zero-width overlay has no visible target. As a button it would also be a Tab
        // stop with nothing to show, which reads as a dead key press.
        .filter(({ layout }) => layout.widthPercent > 0),
    [
      numberedSegments,
      total,
      videoStartPts,
      videoTimeBase,
      totalDurationSeconds,
      timecodeDisplay,
      descriptionIdPrefix,
      t,
    ],
  );
  const tooltipEntries = useMemo(
    () => segmentLayouts.map(({ tooltipEntry }) => tooltipEntry),
    [segmentLayouts],
  );
  const segmentListLabel = useMemo(() => t("timeline.segmentList"), [t]);

  /*
   * The layer draws each segment in two passes, and the `z-10` of the layer makes it one
   * stacking context. So the z values below order the passes inside the layer only, and the
   * whole layer stays under the pending In overlays (z-20) and the playhead (z-30) of the
   * track.
   *
   * 1. The fill pass: one button for each segment. It holds the fill, the label and the
   *    click target. The selected button is z-20, so its fill covers the fills of the
   *    segments that overlap it.
   * 2. The outline pass: one decorative box for each segment, above every fill. Segments can
   *    overlap (ADR 007), and an opaque fill hides the segments under it. So the outline of
   *    each segment is drawn after all the fills, and a segment that lies inside a later one
   *    still shows its extent. The unselected outlines are z-30 and the selected outline is
   *    z-40, so the selected outline is on top.
   *
   * A segment is the part that the export keeps, so its fill is solid. The source bar under
   * it is the hatched part that the export cuts away. The outline, and not the fill, gives
   * the 3:1 contrast against the track in both themes.
   *
   * The unselected outline is a 1px border with a 1px inset line in the unselected fill
   * colour. On the segment's own fill that line does not show. Over the selected fill, where
   * the border has little contrast, the line shows the extent of the segment.
   *
   * The selected segment must be obvious at a glance, so it differs in kind and not only in
   * degree: a brand-strength fill, an inverted label, a 2px border in the strongest clip
   * colour of the theme, and a 1px inset line in the brand foreground. Each decoration is
   * inside the segment's box. An outer ring or shadow would make the segment look wider
   * than its interval and cover the edge of a neighbour after a split.
   *
   * The button and the outline both have the true extent of the segment. The button has no
   * horizontal padding and no border, so a narrow segment does not get a wider fill than its
   * outline. The label has margins and not padding: a margin does not paint, and the label
   * shrinks to zero width, so it disappears when it does not fit. The button does not clip
   * its overflow, because a clip would also cut the hit area below.
   *
   * The label is at the top left: the number, and under it the duration in the compact style
   * of the source's timecode format. The label tier (`resolveSegmentLabelTier`) compares the
   * width of the segment with the estimated width of that text, and drops the duration line,
   * then the number, when it does not fit. So a narrow segment does not show a truncated
   * fragment. The number tier has 4px margins instead of 8px, so the number fits a narrower
   * segment. The accessible name gives the number, the In and Out times and the full
   * duration in every tier, and the description gives the export order.
   *
   * Both lines take the full text colour of the fill. The number line is larger and heavier,
   * and that difference sets the order of the two lines. A dimmed duration line fell below
   * the 4.5:1 text contrast on the selected fill and on the hover fill.
   *
   * A narrow segment is hard to click, so the `::before` of an unselected button gives it a
   * hit area of at least 12px, centred on the segment. The hit area paints nothing. The
   * button is not a stacking context, so the `-z-10` puts the hit area in the stacking
   * context of the layer, under every button, and it takes a click only where no other
   * segment is. A button with a z-index is a stacking context, and there the `-z-10` would
   * put the hit area above its neighbours and let it take their clicks. So the selected
   * button has no hit area (a click on it does nothing), and a focused button hides its
   * hit area while it is at z-50.
   *
   * A focused button rises to z-50, so the outlines of its neighbours do not cover its focus
   * ring. The ring is inside the box, like the other decorations. It is two-tone: a 2px
   * outline in the foreground colour, and inside it a 1px line in the background colour,
   * which is the part of the 3px inset ring that the outline does not cover. The brand ring
   * colour would disappear on the selected fill, which is also the brand colour, and no
   * single colour keeps 3:1 against both fills in the dark theme. With two tones, one of
   * them keeps 3:1 against each fill.
   *
   * Only the hover animates. The transition is in the unselected state and only while the
   * pointer is over the segment, so a selection and a deselection both show at once.
   */
  return (
    <div
      role="group"
      aria-label={segmentListLabel}
      className="pointer-events-none absolute inset-x-0 inset-y-2 z-10"
    >
      {segmentLayouts.map(
        ({
          segment: seg,
          number,
          label,
          description,
          descriptionId,
          compactDuration,
          labelWidths,
          layout,
        }) => {
          // A string comparison at render time, so selection never rebuilds the memoized
          // layouts.
          const isCurrent = seg.id === currentSegmentId;
          const tier = resolveSegmentLabelTier(
            calculateSegmentWidthPx(layout.widthPercent, laneWidthPx),
            labelWidths,
          );
          return (
            <button
              key={seg.id}
              type="button"
              aria-pressed={isCurrent}
              aria-label={label}
              aria-describedby={descriptionId}
              // Selecting does not seek: the playhead is the operand of Mark In, Mark Out and
              // Split, so a selection click must not move it.
              onClick={() => selectSegment(seg.id)}
              onPointerEnter={(event) => tooltip.hover(seg.id, event)}
              onPointerMove={(event) => tooltip.hover(seg.id, event)}
              onPointerLeave={() => tooltip.leave(seg.id)}
              onPointerDown={() => tooltip.press(seg.id)}
              onFocus={(event) =>
                tooltip.focus(seg.id, hasFocusVisible(event.currentTarget))
              }
              onBlur={() => tooltip.blur(seg.id)}
              className={`pointer-events-auto absolute inset-y-1 flex items-start justify-start rounded-md pt-1 focus-visible:z-50 focus-visible:inset-ring-3 focus-visible:inset-ring-background focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground ${
                isCurrent
                  ? "z-20 bg-clip-video-selected text-primary-foreground"
                  : "bg-clip-video text-clip-foreground before:absolute before:inset-y-0 before:left-1/2 before:-z-10 before:w-full before:min-w-3 before:-translate-x-1/2 hover:bg-clip-video-hover hover:transition-colors focus-visible:before:hidden"
              }`}
              style={{
                left: layout.left,
                width: layout.width,
              }}
            >
              {tier !== "none" && (
                <span
                  className={`flex min-w-0 flex-col text-left leading-tight ${tier === "full" ? "mx-2" : "mx-1"}`}
                >
                  <span className="truncate text-[11px] font-semibold tabular-nums">
                    #{number}
                  </span>
                  {tier === "full" && compactDuration !== null && (
                    <span className="truncate font-mono text-[10px] tabular-nums">
                      {compactDuration}
                    </span>
                  )}
                </span>
              )}
              {/* A referenced element gives its text to the description while it is hidden. */}
              <span id={descriptionId} hidden>
                {description}
              </span>
            </button>
          );
        },
      )}
      {segmentLayouts.map(({ segment: seg, layout }) => {
        const isCurrent = seg.id === currentSegmentId;
        return (
          <div
            key={seg.id}
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-1 rounded-md inset-ring ${
              isCurrent
                ? "z-40 border-2 border-clip-video-selected-border inset-ring-primary-foreground"
                : "z-30 border border-clip-video-border inset-ring-clip-video"
            }`}
            style={{
              left: layout.left,
              width: layout.width,
            }}
          />
        );
      })}
      <SegmentTooltip
        controller={tooltip}
        entries={tooltipEntries}
        total={total}
        viewportRef={viewportRef}
        laneWidthPx={laneWidthPx}
      />
    </div>
  );
});
