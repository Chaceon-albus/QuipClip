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
            // The overlay layer holding the segments is z-10, the pending-In overlays are
            // z-20, and the playhead is z-30. Applying z-20 to the selected segment raises
            // it above sibling segments so overlapping segments do not obscure it, without
            // covering the playhead.
            className={`pointer-events-auto absolute inset-y-1 flex items-center overflow-hidden rounded-md px-2 shadow-xs ${
              isCurrent
                ? "z-20 border-2 border-primary-active bg-primary text-primary-foreground ring-2 ring-primary-active ring-offset-2 ring-offset-clip-video"
                : "border-2 border-primary/45 bg-primary/20 text-foreground backdrop-blur-xs hover:border-primary/70 hover:bg-primary/30"
            }`}
            style={{
              left: layout.left,
              width: layout.width,
            }}
          >
            <span
              className={`truncate font-mono text-[10px] font-semibold ${
                isCurrent ? "text-primary-foreground" : "text-foreground"
              }`}
            >
              #{number}
            </span>
          </button>
        );
      })}
    </div>
  );
});
