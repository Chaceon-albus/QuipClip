import { memo, useSyncExternalStore } from "react";
import type { Pts, Rational } from "@/types/project";
import { calculateTrimPreviewLayout } from "./segmentTrim";
import { segmentTrimSession, type SegmentTrimView } from "./segmentTrimSession";
import { useDisplayedPlaybackPosition } from "./useDisplayedPlaybackPosition";

export interface SegmentTrimPreviewProps {
  videoStartPts: Pts | null | undefined;
  videoTimeBase: Rational | null | undefined;
  totalDurationSeconds: number | null;
}

/**
 * The preview of a segment that a trim moves (ADR 030): the new extent of the segment, from its
 * fixed edge to the displayed playhead position. The playhead follows the display target of the
 * seek (ADR 022), so the moving edge of the preview follows it too, during the drag and while
 * the release waits for its frame. The stored segment does not change until the commit, and the
 * segment layer fades it while the trim runs.
 *
 * The preview is display only. Its moving edge never becomes an edit value: the commit writes
 * the PTS of the presented frame, or the stored PTS of a snap (`planTrimRelease`).
 *
 * This layer subscribes to the trim only, which changes at the start and the end of a trim. The
 * box, which follows the playhead, is a child that mounts only while a trim runs, so no part of
 * the preview renders per frame at other times. The box has the look of the selected segment,
 * because the trim selects its segment. It is z-20, above the segment layer (z-10) and under
 * the playhead (z-30). It is aria-hidden and takes no pointer event, as the pending In region
 * does.
 */
export const SegmentTrimPreview = memo(function SegmentTrimPreview({
  videoStartPts,
  videoTimeBase,
  totalDurationSeconds,
}: SegmentTrimPreviewProps) {
  const view = useSyncExternalStore(
    segmentTrimSession.subscribe,
    segmentTrimSession.getView,
  );
  if (view === null) {
    return null;
  }
  return (
    <SegmentTrimPreviewBox
      view={view}
      videoStartPts={videoStartPts}
      videoTimeBase={videoTimeBase}
      totalDurationSeconds={totalDurationSeconds}
    />
  );
});

interface SegmentTrimPreviewBoxProps extends SegmentTrimPreviewProps {
  view: SegmentTrimView;
}

/** The box of the preview. It renders per frame while a trim runs. */
function SegmentTrimPreviewBox({
  view,
  videoStartPts,
  videoTimeBase,
  totalDurationSeconds,
}: SegmentTrimPreviewBoxProps) {
  const { elapsedSeconds } = useDisplayedPlaybackPosition(videoStartPts, videoTimeBase);
  const layout = calculateTrimPreviewLayout(
    view.edge,
    view.fixedPts,
    elapsedSeconds,
    videoStartPts,
    videoTimeBase,
    totalDurationSeconds,
  );
  if (layout === null) {
    return null;
  }
  // The wrapper spans the rectangle of the segment layer (`inset-y-2`), and the box has the
  // vertical inset of a segment button (`inset-y-1`).
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 inset-y-2 z-20"
    >
      <div
        className="absolute inset-y-1 rounded-md border-2 border-clip-video-selected-border bg-clip-video-selected inset-ring inset-ring-primary-foreground"
        style={{ left: layout.left, width: layout.width }}
      />
    </div>
  );
}
