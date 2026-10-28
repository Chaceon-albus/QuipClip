/**
 * The place of each clip of the sequence on the track lane (ADR 052).
 */

import type { VirtualTimeline } from "@/features/timeline/virtualTime";

/** The place of one clip on the lane, as percents of the extent. */
export interface ClipBarLayout {
  readonly clipId: string;
  readonly sourceId: string;
  readonly index: number;
  readonly leftPercent: number;
  readonly widthPercent: number;
}

/**
 * The place of each clip on the lane. A clip with no extent, possible only as the one clip of the
 * sequence, spans the lane. Null without an axis or a positive total.
 */
export function calculateClipBarLayouts(
  virtual: VirtualTimeline | null,
  totalDurationSeconds: number | null,
): ClipBarLayout[] | null {
  if (
    virtual === null ||
    totalDurationSeconds === null ||
    !(totalDurationSeconds > 0)
  ) {
    return null;
  }
  const seconds = (ticks: bigint) =>
    (Number(ticks) * virtual.timeBase.n) / virtual.timeBase.d;
  return virtual.clips.map((clip) => {
    const left = (seconds(clip.startTicks) / totalDurationSeconds) * 100;
    const width =
      clip.durationTicks === null
        ? 100 - left
        : (seconds(clip.durationTicks) / totalDurationSeconds) * 100;
    return {
      clipId: clip.clipId,
      sourceId: clip.sourceId,
      index: clip.index,
      leftPercent: Math.max(0, Math.min(100, left)),
      widthPercent: Math.max(0, Math.min(100 - Math.max(0, left), width)),
    };
  });
}
