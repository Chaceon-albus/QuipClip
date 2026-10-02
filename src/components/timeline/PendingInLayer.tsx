import { memo } from "react";
import {
  calculatePendingInRegionLayoutFromSeconds,
  calculatePercentFromPts,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import type { Pts, Rational } from "@/types/project";
import { useDisplayedPlaybackPosition } from "./useDisplayedPlaybackPosition";

const selectPendingInPts = (state: TimelineStoreState) => state.pendingInPts;

export interface PendingInLayerProps {
  videoStartPts: Pts | null | undefined;
  videoTimeBase: Rational | null | undefined;
  totalDurationSeconds: number | null;
}

/** The In boundary of the pending mark, in percent of the source extent, or null. */
function calculatePendingInPercent(
  pendingInPts: Pts | null,
  videoStartPts: Pts | null | undefined,
  videoTimeBase: Rational | null | undefined,
  totalDurationSeconds: number | null,
): number | null {
  return pendingInPts !== null &&
    videoStartPts &&
    videoTimeBase &&
    totalDurationSeconds &&
    totalDurationSeconds > 0
    ? calculatePercentFromPts(
        pendingInPts,
        videoStartPts,
        videoTimeBase,
        totalDurationSeconds,
      )
    : null;
}

/**
 * The pending In region and the pending In bracket in the track, the content of the seek
 * slider that follows the source bar.
 *
 * This layer subscribes to the pending mark only. The region, which does depend on the
 * playhead, is a child that the layer mounts only while a pending mark can be drawn. So no
 * part of this layer renders per frame while no In mark is pending.
 */
export const PendingInTrackMarks = memo(function PendingInTrackMarks({
  videoStartPts,
  videoTimeBase,
  totalDurationSeconds,
}: PendingInLayerProps) {
  const pendingInPts = useTimelineStore(selectPendingInPts);

  // The region needs every input of this percent, so it cannot show while this is null.
  const pendingInPercent = calculatePendingInPercent(
    pendingInPts,
    videoStartPts,
    videoTimeBase,
    totalDurationSeconds,
  );
  if (pendingInPercent === null) {
    return null;
  }

  return (
    <>
      <PendingInRegion
        pendingInPts={pendingInPts}
        videoStartPts={videoStartPts}
        videoTimeBase={videoTimeBase}
        totalDurationSeconds={totalDurationSeconds}
      />

      {/*
       * Pending In mark: a "[" bracket whose left edge is the In boundary. The In PTS is the
       * inclusive left edge of its frame (ADR 002), so the bracket opens to the right of the
       * position and is not centred on it. The shape keeps it apart from the playhead, a
       * centred line that the z-30 layer draws above it.
       */}
      <div
        className="pointer-events-none absolute inset-y-0 z-20 w-1.5 rounded-l-[2px] border-y-2 border-l-2 border-primary"
        style={{ left: `${pendingInPercent}%` }}
      />
    </>
  );
});

interface PendingInRegionProps extends PendingInLayerProps {
  pendingInPts: Pts | null;
}

/**
 * Pending In active region preview overlay.
 *
 * The region depends on the playhead, so it renders per frame. Its right edge is the
 * position the playhead is drawn at, and not the presented frame. Each seek clears
 * `presentedFrame` until the next RVFC callback, so a region drawn from it would disappear
 * on every click, frame step and scrub sample (ADR 022). This is display only: Mark Out and
 * the edit predicates still read `presentedFrame`.
 *
 * The region can lie over an existing segment, because a new segment can overlap an old one
 * (ADR 007). The dashed border is the opaque brand colour, so it keeps 3:1 against the fill
 * of an unselected segment in the light theme. At 80% opacity it did not. It does not keep
 * 3:1 against the selected fill, which is also the brand colour. But the region never lies
 * over the selected segment: while a segment is current, no In mark is pending (ADR 007).
 */
function PendingInRegion({
  pendingInPts,
  videoStartPts,
  videoTimeBase,
  totalDurationSeconds,
}: PendingInRegionProps) {
  const { elapsedSeconds } = useDisplayedPlaybackPosition(videoStartPts, videoTimeBase);
  const pendingRegion = calculatePendingInRegionLayoutFromSeconds(
    pendingInPts,
    elapsedSeconds,
    videoStartPts,
    videoTimeBase,
    totalDurationSeconds,
  );
  if (!pendingRegion || !pendingRegion.isVisible) {
    return null;
  }

  return (
    <div
      className="pointer-events-none absolute inset-y-1 z-20 rounded-md border-2 border-dashed border-primary bg-primary/15"
      style={{
        left: pendingRegion.left,
        width: pendingRegion.width,
      }}
    />
  );
}
