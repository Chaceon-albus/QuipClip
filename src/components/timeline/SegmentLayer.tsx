import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  calculateSegmentLayout,
  getActiveSourceSegmentEntries,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import type { Pts, Rational } from "@/types/project";

const selectSegments = (state: TimelineStoreState) => state.segments;
const selectCurrentSegmentId = (state: TimelineStoreState) => state.currentSegmentId;
const selectSelectSegment = (state: TimelineStoreState) => state.selectSegment;

export interface SegmentLayerProps {
  sourceId: string | null;
  videoStartPts: Pts | null | undefined;
  videoTimeBase: Rational | null | undefined;
  totalDurationSeconds: number | null;
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
 * position. It is memoized, and its props are percent-layout inputs, so neither a presented
 * frame nor a zoom renders it again.
 */
export const SegmentLayer = memo(function SegmentLayer({
  sourceId,
  videoStartPts,
  videoTimeBase,
  totalDurationSeconds,
}: SegmentLayerProps) {
  const { t } = useTranslation();
  const segments = useTimelineStore(selectSegments);
  const currentSegmentId = useTimelineStore(selectCurrentSegmentId);
  const selectSegment = useTimelineStore(selectSelectSegment);

  const activeSourceSegments = useMemo(
    () => getActiveSourceSegmentEntries(segments, sourceId),
    [segments, sourceId],
  );
  // A selection change renders this layer again, and none of these inputs depends on the
  // selection. So the layouts, the labels and the numbers are built once per change of the
  // segment list, the source or the extent, and not once per selection click.
  const segmentLayouts = useMemo(
    () =>
      activeSourceSegments
        .map(({ segment, projectIndex }) => ({
          segment,
          number: projectIndex + 1,
          label: t("timeline.segment", { index: projectIndex + 1 }),
          layout: calculateSegmentLayout(
            segment,
            videoStartPts,
            videoTimeBase,
            totalDurationSeconds,
          ),
        }))
        // A zero-width overlay has no visible target. As a button it would also be a Tab
        // stop with nothing to show, which reads as a dead key press.
        .filter(({ layout }) => layout.widthPercent > 0),
    [activeSourceSegments, videoStartPts, videoTimeBase, totalDurationSeconds, t],
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
   * padding and no border, so a narrow segment does not get a wider fill than its outline.
   * The label has margins and not padding: a margin does not paint, and the label shrinks to
   * zero width, so it disappears when it does not fit. The button does not clip its
   * overflow, because a clip would also cut the hit area below.
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
      {segmentLayouts.map(({ segment: seg, number, label, layout }) => {
        // A string comparison at render time, so selection never rebuilds the memoized
        // layouts.
        const isCurrent = seg.id === currentSegmentId;
        return (
          <button
            key={seg.id}
            type="button"
            aria-pressed={isCurrent}
            aria-label={label}
            // Selecting does not seek: the playhead is the operand of Mark In, Mark Out and
            // Split, so a selection click must not move it.
            onClick={() => selectSegment(seg.id)}
            className={`pointer-events-auto absolute inset-y-1 flex items-center rounded-md focus-visible:z-50 focus-visible:inset-ring-3 focus-visible:inset-ring-background focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground ${
              isCurrent
                ? "z-20 bg-clip-video-selected text-primary-foreground"
                : "bg-clip-video text-clip-foreground before:absolute before:inset-y-0 before:left-1/2 before:-z-10 before:w-full before:min-w-3 before:-translate-x-1/2 hover:bg-clip-video-hover hover:transition-colors focus-visible:before:hidden"
            }`}
            style={{
              left: layout.left,
              width: layout.width,
            }}
          >
            <span className="mx-2 min-w-0 truncate font-mono text-[10px] font-semibold">
              #{number}
            </span>
          </button>
        );
      })}
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
    </div>
  );
});
