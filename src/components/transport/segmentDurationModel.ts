/**
 * Pure model for the segment duration in the transport bar.
 *
 * The bar shows the duration of the segment that is being edited:
 *
 * - While a segment is current, its duration.
 * - While an In mark is pending, the duration from the pending In mark to the frame on screen.
 *   That is the duration of the segment that Mark Out would make now, because Mark Out writes
 *   the PTS of the frame on screen as the Out point (ADR 002, ADR 022).
 *
 * Both values use the duration rule of the segment label and the segment tooltip
 * (`formatSegmentTimes`, which calls `formatElapsedTickSpan`): the grid index of the Out time
 * minus the grid index of the In time, in the timecode format of the source (ADR 028). So the
 * value that the bar shows is the value that the tooltip of that segment shows, character for
 * character. The rule reads stored and inferred PTS values only, so the value is exact, and
 * the bar does not mark it as approximate.
 *
 * The duration of the current segment does not depend on the playhead, so it has no playback
 * input (`formatCurrentSegmentDuration`). Only the duration from a pending In mark reads the
 * frame on screen (`presentPendingSegmentDuration`).
 *
 * The functions return values, and do not call the i18n runtime (ADR 011).
 */

import {
  formatSegmentTimes,
  numberSegmentsInExportOrder,
} from "@/components/timeline/segmentLabels";
import type { PlaybackState } from "@/features/playback";
import { isPtsString } from "@/lib/time";
import { formatElapsedTickSpan, type TimecodeDisplay } from "@/lib/timecode";
import type { Pts, Rational, Segment } from "@/types/project";

/**
 * The segment whose duration the bar shows.
 *
 * - `segment`: the current segment, with its number in the export order (`#N`).
 * - `pending`: the segment that a pending In mark starts.
 */
export type SegmentDurationSubject =
  | {
      readonly kind: "segment";
      readonly number: number;
      readonly segment: Pick<Segment, "inPts" | "outPts">;
    }
  | { readonly kind: "pending"; readonly pendingInPts: Pts };

/**
 * Returns the segment whose duration the bar shows, or null when there is none.
 *
 * The current segment comes first. The timeline store keeps no pending In mark while a
 * current segment resolves (ADR 007), so the two cannot both apply, and the order only makes
 * the rule total. A current segment of another source does not resolve, as for every segment
 * action.
 *
 * @param segments The project segment array, in export order.
 * @param currentSegmentId The current segment, or null.
 * @param activeSourceId The source that the timeline shows.
 * @param pendingInPts The pending In mark of the active source, or null.
 * @param hasActiveSource True while media is open and an attached element of it is ready.
 */
export function resolveSegmentDurationSubject(
  segments: readonly Segment[],
  currentSegmentId: string | null,
  activeSourceId: string | null | undefined,
  pendingInPts: Pts | null,
  hasActiveSource: boolean,
): SegmentDurationSubject | null {
  if (!hasActiveSource || !activeSourceId) {
    return null;
  }
  if (currentSegmentId !== null) {
    const entry = numberSegmentsInExportOrder(segments, activeSourceId).entries.find(
      ({ segment }) => segment.id === currentSegmentId,
    );
    if (entry !== undefined) {
      return { kind: "segment", number: entry.number, segment: entry.segment };
    }
  }
  if (pendingInPts !== null && isPtsString(pendingInPts)) {
    return { kind: "pending", pendingInPts };
  }
  return null;
}

/**
 * The value for a pending In mark while no frame is presented, because a seek is pending. It
 * is not a duration: the caller keeps the value that it showed before
 * (`settleSegmentDuration`), so a frame step does not blank the value. It is a symbol, so no
 * text can be equal to it.
 */
export const SEGMENT_DURATION_PENDING: unique symbol = Symbol("segmentDurationPending");

/** A duration, `SEGMENT_DURATION_PENDING`, or null when no duration applies. */
export type SegmentDurationValue = string | typeof SEGMENT_DURATION_PENDING | null;

/** The playback facts that the duration reads. The store state satisfies it as it is. */
export type SegmentDurationPlayback = Pick<
  PlaybackState,
  "calibrationStatus" | "presentedFrame"
>;

/** The timing of the source that the duration needs. */
export interface SegmentDurationTiming {
  readonly videoStartPts: Pts | null | undefined;
  readonly videoTimeBase: Rational | null | undefined;
  readonly display: TimecodeDisplay;
}

/**
 * The full-style duration from `inPts` to `outPts`, or null (`formatElapsedTickSpan`). Unlike
 * `formatSegmentTimes`, it accepts an empty span, whose duration is zero, because the frame on
 * screen can be the pending In mark itself. Null when `outPts` is before `inPts`.
 */
function formatPendingDuration(
  inPts: Pts,
  outPts: Pts,
  timing: SegmentDurationTiming,
): string | null {
  const { videoStartPts, videoTimeBase, display } = timing;
  if (
    !videoStartPts ||
    !videoTimeBase ||
    !isPtsString(videoStartPts) ||
    !isPtsString(inPts) ||
    !isPtsString(outPts)
  ) {
    return null;
  }
  const start = BigInt(videoStartPts);
  return (
    formatElapsedTickSpan(
      BigInt(inPts) - start,
      BigInt(outPts) - start,
      videoTimeBase,
      display,
    )?.duration ?? null
  );
}

/**
 * Returns the duration of the current segment, in the full style of the source format, such
 * as `00:00:05:12` or `00:00:05.480`. It does not depend on the playhead. Null when the segment
 * is not a valid half-open interval or the source timing is missing.
 *
 * It is the function of the segment label and the segment tooltip (`formatSegmentTimes`), so
 * the three agree.
 *
 * @param segment The PTS pair of the current segment.
 * @param timing The timing of the source and its timecode format.
 */
export function formatCurrentSegmentDuration(
  segment: Pick<Segment, "inPts" | "outPts">,
  timing: SegmentDurationTiming,
): string | null {
  return (
    formatSegmentTimes(
      segment,
      timing.videoStartPts,
      timing.videoTimeBase,
      timing.display,
    )?.duration ?? null
  );
}

/**
 * Returns the duration from a pending In mark to the frame on screen, in the full style of
 * the source format.
 *
 * - On the mark itself it is zero. Before the mark it is null, because no segment can end
 *   there.
 * - `SEGMENT_DURATION_PENDING` while the calibration is ready and no frame is presented: the
 *   window between a seek and the frame callback that answers it.
 * - Null while the calibration is not ready, because no PTS then names the frame on screen
 *   (ADR 003).
 *
 * A store selector can call it and settle on a string, so the bar renders again only when the
 * text changes.
 *
 * @param pendingInPts The pending In mark.
 * @param playback The playback facts.
 * @param timing The timing of the source and its timecode format.
 */
export function presentPendingSegmentDuration(
  pendingInPts: Pts,
  playback: SegmentDurationPlayback,
  timing: SegmentDurationTiming,
): SegmentDurationValue {
  if (playback.calibrationStatus !== "ready") {
    return null;
  }
  const frame = playback.presentedFrame;
  if (frame === null) {
    return SEGMENT_DURATION_PENDING;
  }
  return formatPendingDuration(pendingInPts, frame.inferredSourcePts, timing);
}

/**
 * Returns the duration to show, given the one shown before and the one presented now.
 *
 * `SEGMENT_DURATION_PENDING` keeps the duration shown before, so a frame step leaves the value
 * as it was until the frame callback answers, and the value never shows a duration for a
 * frame that the callback has not confirmed. Every other value replaces it.
 */
export function settleSegmentDuration(
  shown: string | null,
  presented: SegmentDurationValue,
): string | null {
  return presented === SEGMENT_DURATION_PENDING ? shown : presented;
}
