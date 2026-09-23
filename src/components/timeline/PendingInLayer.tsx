import { memo, useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  calculatePendingInRegionLayoutFromSeconds,
  calculatePercentFromPts,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import type { Pts, Rational } from "@/types/project";
import { useDisplayedPlaybackPosition } from "./useDisplayedPlaybackPosition";

const selectPendingInPts = (state: TimelineStoreState) => state.pendingInPts;

/**
 * Places the pending In flag to the right of the In boundary, or to the left of it when the
 * flag does not fit between the boundary and the end of the lane.
 *
 * The wrapper of the flag runs from the In boundary to the end of the lane, and it is a size
 * container. So `100cqw` is the space to the right of the boundary, and `100%` in a
 * translation is the width of the flag itself. When the flag fits, the difference is zero or
 * more, and `min` gives 0. When it does not fit, the scaled difference is a large negative
 * length, and `max` gives -100%, which puts the right edge of the flag on the boundary. The
 * factor turns a shortfall of a small fraction of a pixel into the full move, so the flag has
 * no position between the two placements. The rule compares the rendered width of the flag,
 * so it holds for a label of any length and needs no layout read in JavaScript.
 */
const PENDING_IN_FLAG_PLACEMENT_STYLE: CSSProperties = {
  transform: "translateX(max(-100%, min(0px, calc((100cqw - 100%) * 100000))))",
};

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
 * Pending In flag in the ruler. One edge of the flag lies on the In boundary, the same edge
 * as the bracket in the track. The flag extends to the right of it, or to the left of it
 * when it does not fit before the end of the lane (see PENDING_IN_FLAG_PLACEMENT_STYLE), so
 * the flag stays whole and inside the lane, and it does not make the scroll area wider.
 *
 * The playhead at z-30 is drawn above the flag. Its head is 12px wide and centred, and its
 * outline adds 1px, so it covers 7px on each side of the playhead. Right after Mark In the
 * playhead lies on the In boundary, so the 8px padding on each side keeps the label clear
 * of the head in both placements.
 *
 * The label is words, not a time code, so it takes the smallest text step, `text-2xs`,
 * which gives Chinese its larger size. The fixed 12px line keeps the flag as tall as the
 * playhead head in both languages.
 *
 * The flag is aria-hidden. It repeats the pending In mark in the track, which is also
 * decorative, and a bare "In" read out of the ruler gives no position.
 *
 * The flag does not depend on the playhead, so it does not subscribe to the position.
 */
export const PendingInFlag = memo(function PendingInFlag({
  videoStartPts,
  videoTimeBase,
  totalDurationSeconds,
}: PendingInLayerProps) {
  const { t } = useTranslation();
  const pendingInPts = useTimelineStore(selectPendingInPts);
  const pendingInFlagLabel = useMemo(() => t("timeline.pendingInFlag"), [t]);

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
    <div
      aria-hidden="true"
      className="@container pointer-events-none absolute top-0 right-0 z-20"
      style={{ left: `${pendingInPercent}%` }}
    >
      <span
        className="absolute top-0 left-0 rounded-b-sm bg-primary px-2 text-2xs leading-3 font-semibold whitespace-nowrap text-primary-foreground"
        style={PENDING_IN_FLAG_PLACEMENT_STYLE}
      >
        {pendingInFlagLabel}
      </span>
    </div>
  );
});

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
      className="pointer-events-none absolute inset-y-1 z-20 rounded-md border-2 border-dashed border-primary/80 bg-primary/15"
      style={{
        left: pendingRegion.left,
        width: pendingRegion.width,
      }}
    />
  );
}
