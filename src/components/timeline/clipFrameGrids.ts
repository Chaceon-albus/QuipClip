/**
 * The frame grids of the clips of a sequence, for the zoom ceiling and the frame bands of the
 * timeline (ADR 052).
 *
 * The probe of the sequence has one nominal rate only while every clip starts on one frame grid
 * (`sequenceNominalRate`), because the frame timecode needs that. The zoom ceiling and the frame
 * bands do not: ADR 052 gives the ceiling the highest rate of the clips, and each band the grid of
 * the clip under it. With one clip, both keep the rate and the grid of that clip, as before.
 *
 * The module has no React and no store, so the tests need neither.
 */

import type { MediaProbe } from "@/features/media";
import { getNominalFrameRate } from "@/features/playback";
import type { VirtualTimeline } from "@/features/timeline/virtualTime";
import { isPtsString } from "@/lib/time";
import type { Rational } from "@/types/project";
import { resolveFrameBandRate, type FrameBandGrid } from "./frameBand";
import { resolveTrimGridRate } from "./segmentTrim";

/** The probe facts of a clip that the grids read. */
export type ClipGridProbe = Pick<
  MediaProbe,
  "videoStartPts" | "videoTimeBase" | "avgFrameRate" | "rFrameRate"
>;

/** The probe of each source of the sequence, by source ID. */
export type ClipGridProbes = Readonly<
  Record<string, { readonly probe: ClipGridProbe }>
>;

function isSequence(virtual: VirtualTimeline | null): virtual is VirtualTimeline {
  return virtual !== null && virtual.clips.length > 1;
}

/**
 * The rate of the zoom ceiling (`calculateMaxZoom`): on a sequence of several clips, the highest
 * nominal rate of the clips, and else the nominal rate of the probe of the one source.
 *
 * @param probe The probe of the sequence, or of the one source.
 */
export function resolveZoomCeilingRate(
  virtual: VirtualTimeline | null,
  sources: ClipGridProbes,
  probe: ClipGridProbe | null,
): Rational | null {
  if (!isSequence(virtual)) {
    return probe === null ? null : getNominalFrameRate(probe);
  }
  let highest: Rational | null = null;
  for (const clip of virtual.clips) {
    const source = sources[clip.sourceId];
    const rate = source === undefined ? null : getNominalFrameRate(source.probe);
    // The products of two safe integers are exact as BigInt.
    if (
      rate !== null &&
      (highest === null ||
        BigInt(rate.n) * BigInt(highest.d) > BigInt(highest.n) * BigInt(rate.d))
    ) {
      highest = rate;
    }
  }
  return highest;
}

/** No band shows. One constant, so a memo of the list keeps one value. */
const NO_GRIDS: readonly FrameBandGrid[] = [];

/**
 * Seconds of `ticks` of the lane time base. It is the expression of `ptsElapsedSeconds` and of
 * `clipStartSeconds`, in the same order, so a frame on a junction and the start of the later clip
 * give the same number, and `frameBandGridAt` gives the junction to the later clip. Keep them the
 * same.
 */
function secondsOf(ticks: bigint, timeBase: Rational): number {
  return (Number(ticks) * timeBase.n) / timeBase.d;
}

/**
 * The grids of the frame bands, or an empty list when no band shows. A band shows only on the
 * exact frame grid and only while one frame is at least `FRAME_BAND_MIN_WIDTH_PX` wide.
 *
 * - With one source, one grid with the rate of `gridRate` and no clip.
 * - On a sequence of several clips, one grid for each clip whose source has an exact frame grid
 *   (`resolveTrimGridRate`) that is wide enough, in sequence order. Frame 0 of the grid is the
 *   first frame of the source of the clip, placed on the virtual axis, which is the axis of the
 *   lane.
 *
 * The fields:
 *
 * - `gridRate`: the rate of the exact frame grid of the one source while a precise seek is
 *   possible, or null. A sequence of several clips does not read it.
 * - `canUsePreciseSeek`: true while a precise seek is possible. On a sequence of several clips it
 *   is the condition of every band, as `gridRate` holds it for the one source.
 * - `totalDurationSeconds`: the extent of the ruler (ADR 007).
 * - `laneWidthPx`: the width of the lane in CSS pixels.
 */
export function resolveFrameBandGrids({
  virtual,
  sources,
  gridRate,
  canUsePreciseSeek,
  totalDurationSeconds,
  laneWidthPx,
}: {
  readonly virtual: VirtualTimeline | null;
  readonly sources: ClipGridProbes;
  readonly gridRate: Rational | null;
  readonly canUsePreciseSeek: boolean;
  readonly totalDurationSeconds: number | null;
  readonly laneWidthPx: number;
}): readonly FrameBandGrid[] {
  if (!isSequence(virtual)) {
    const rate = resolveFrameBandRate(gridRate, totalDurationSeconds, laneWidthPx);
    return rate === null ? NO_GRIDS : [{ rate }];
  }
  if (!canUsePreciseSeek) {
    return NO_GRIDS;
  }
  const laneTimeBase = virtual.timeBase;
  const grids: FrameBandGrid[] = [];
  for (const clip of virtual.clips) {
    const probe = sources[clip.sourceId]?.probe;
    if (probe === undefined || clip.rangeStart === null) {
      continue;
    }
    const rate = resolveTrimGridRate(probe);
    const startPts = probe.videoStartPts;
    if (
      rate === null ||
      !probe.videoTimeBase ||
      startPts === null ||
      !isPtsString(startPts) ||
      resolveFrameBandRate(rate, totalDurationSeconds, laneWidthPx) === null
    ) {
      continue;
    }
    grids.push({
      rate,
      clip: {
        originTicks:
          clip.startTicks + (BigInt(startPts) - clip.rangeStart) * clip.scale,
        videoTimeBase: probe.videoTimeBase,
        startSeconds: secondsOf(clip.startTicks, laneTimeBase),
        endSeconds:
          clip.durationTicks === null
            ? null
            : secondsOf(clip.startTicks + clip.durationTicks, laneTimeBase),
      },
    });
  }
  return grids.length === 0 ? NO_GRIDS : grids;
}
