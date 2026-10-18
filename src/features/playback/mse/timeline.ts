/**
 * The media timeline of a MediaSource source (ADR 046).
 *
 * The remux windows keep the absolute source timestamps, and the page sets `timestampOffset` to
 * −(`videoStartPts` × `videoTimeBase`). Media time 0 is then `videoStartPts`, the anchor of
 * ADR 003, and a sample at absolute time `t` has the media time `t` − the video start.
 */

import { assertPositiveTimeBase, isPtsString, ptsToBigInt } from "@/lib/time";
import type { Pts, Rational } from "@/types/project";

/** The media time of `videoStartPts`. The store takes it as the known anchor. */
export const ANCHOR_MEDIA_TIME = 0;

/**
 * The absolute source time of `videoStartPts` in seconds, or null when the PTS or the time base
 * is not valid, or the time is not a safe number.
 */
export function videoStartSeconds(
  videoStartPts: Pts | null,
  timeBase: Rational,
): number | null {
  if (videoStartPts === null || !isPtsString(videoStartPts)) {
    return null;
  }
  try {
    assertPositiveTimeBase(timeBase);
  } catch {
    return null;
  }
  const ticks = ptsToBigInt(videoStartPts);
  if (
    ticks > BigInt(Number.MAX_SAFE_INTEGER) ||
    ticks < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return null;
  }
  const seconds = (Number(ticks) * timeBase.n) / timeBase.d;
  return Number.isFinite(seconds) ? seconds : null;
}

/** The `timestampOffset` of the SourceBuffer of a source whose video starts at `startSeconds`. */
export function timestampOffsetFor(startSeconds: number): number {
  return ANCHOR_MEDIA_TIME - startSeconds;
}

/** The media time of a sample at `ticks` of a track with `timescale` ticks each second. */
export function sampleMediaTime(
  ticks: number,
  timescale: number,
  startSeconds: number,
): number {
  return ticks / timescale + timestampOffsetFor(startSeconds);
}

/** The absolute source time of a media time. */
export function sourceSecondsAt(mediaTime: number, startSeconds: number): number {
  return mediaTime - timestampOffsetFor(startSeconds);
}

/**
 * The `duration` of the MediaSource: the anchor plus the length of the source from its first
 * video frame (ADR 046, "The probe"), or null without a valid length.
 */
export function mediaDurationFor(
  approximateDurationSeconds: number | null,
): number | null {
  if (
    approximateDurationSeconds === null ||
    !Number.isFinite(approximateDurationSeconds) ||
    approximateDurationSeconds <= 0
  ) {
    return null;
  }
  return ANCHOR_MEDIA_TIME + approximateDurationSeconds;
}
