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
 * The pending In mark and its trail in the track, the content of the seek slider that follows
 * the source bar.
 *
 * This layer subscribes to the pending mark only. The trail, which does depend on the
 * playhead, is a child that the layer mounts only while a pending mark can be drawn. So no
 * part of this layer renders per frame while no In mark is pending.
 */
export const PendingInTrackMarks = memo(function PendingInTrackMarks({
  videoStartPts,
  videoTimeBase,
  totalDurationSeconds,
}: PendingInLayerProps) {
  const pendingInPts = useTimelineStore(selectPendingInPts);

  // The trail needs every input of this percent, so it cannot show while this is null.
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
      <PendingInTrail
        pendingInPts={pendingInPts}
        videoStartPts={videoStartPts}
        videoTimeBase={videoTimeBase}
        totalDurationSeconds={totalDurationSeconds}
      />

      {/*
       * The pending In mark, in the mark colour, which is not the colour of the playhead. The
       * playhead stands on the In right after Mark In, and a mark in the brand colour then
       * looked like part of the playhead.
       *
       * - The line is 2px wide and centred on the In, as the 2px playhead line is centred on
       *   its position, so it covers the pixels that the playhead covers when it stands on the
       *   In. It spans the full track lane, as the playhead does, so it reads as a second line
       *   of the same kind (`-inset-y-2` undoes the 8px inset of the content).
       * - The flag is a 12px swallowtail at the top of the lane, to the right of the line. The
       *   In PTS is the inclusive left edge of its frame (ADR 002), so the flag points into the
       *   segment that the In starts. The playhead line is 2px wide, so the flag stays in view
       *   while the playhead covers the line, right after Mark In.
       *
       * The z-20 mark lies over the segments, because a new segment can start inside an old one
       * (ADR 007). The mark colour keeps 3:1 against the fill of an unselected segment and 4.7:1
       * against the track in the light theme, and 4.7:1 and 9.9:1 in the dark theme. It never
       * lies over the selected fill: while a segment is current, no In mark is pending.
       */}
      <div
        className="pointer-events-none absolute -inset-y-2 z-20 w-0"
        style={{ left: `${pendingInPercent}%` }}
      >
        <div className="absolute inset-y-0 -left-px w-0.5 bg-timeline-mark" />
        <div className="absolute top-0 left-px h-3 w-3 bg-timeline-mark [clip-path:polygon(0_0,100%_0,62%_50%,100%_100%,0_100%)]" />
      </div>
    </>
  );
});

interface PendingInTrailProps extends PendingInLayerProps {
  pendingInPts: Pts | null;
}

/**
 * The trail of the pending In: the part of the source from the In to the playhead, the
 * segment that Mark Out or Finish would make there. It shows only while the playhead is after
 * the In.
 *
 * The trail depends on the playhead, so it renders per frame. Its right edge is the position
 * the playhead is drawn at, and not the presented frame. Each seek clears `presentedFrame`
 * until the next RVFC callback, so a trail drawn from it would disappear on every click, frame
 * step and scrub sample (ADR 022). This is display only: Mark Out and the edit predicates still
 * read `presentedFrame`.
 *
 * The playhead pulls the trail behind it, so the trail has no edge of its own at either end.
 * Its left end lies under the line of the In mark, and its right end lies under the 2px
 * playhead line, centred in it. The earlier dashed outline had a right border at the playhead.
 * The engine snapped that border and the playhead line to device pixels on their own, so the
 * border could show beside the playhead and look like a second mark. Its dashes and its rounded
 * corners also moved on every frame of playback, because a dashed border spaces its dashes over
 * the length of each side. The trail has no dash and no corner. Only its gradient stretches
 * with the width, smoothly.
 *
 * It has two parts:
 *
 * - The fill: the track colour under a tint of the mark colour that grows toward the playhead,
 *   so it hides the hatch of the source bar and reads as a trail. It has the rectangle of a
 *   segment (`inset-y-1`), so the segment that a press makes appears where the trail was. It
 *   lies under the segments (it has no z-index, and the segment layer is z-10), so a segment
 *   that the trail crosses stays in view.
 * - The edges: two solid 2px lines in the 4px between the source bar and the rectangle of a
 *   segment, above and below it. No segment covers them, so they show the extent of the trail
 *   also where it crosses a segment. They carry no information that the In line and the
 *   playhead do not, so in the light theme they may keep less than 3:1 against the track.
 */
function PendingInTrail({
  pendingInPts,
  videoStartPts,
  videoTimeBase,
  totalDurationSeconds,
}: PendingInTrailProps) {
  const { elapsedSeconds } = useDisplayedPlaybackPosition(videoStartPts, videoTimeBase);
  const trail = calculatePendingInRegionLayoutFromSeconds(
    pendingInPts,
    elapsedSeconds,
    videoStartPts,
    videoTimeBase,
    totalDurationSeconds,
  );
  if (!trail || !trail.isVisible) {
    return null;
  }

  const style = { left: trail.left, width: trail.width };
  return (
    <>
      <div
        className="pointer-events-none absolute inset-y-1 bg-timeline-track bg-linear-to-r from-timeline-mark/8 to-timeline-mark/35"
        style={style}
      />
      <div
        className="pointer-events-none absolute inset-y-0.5 border-y-2 border-timeline-mark/60"
        style={style}
      />
    </>
  );
}
