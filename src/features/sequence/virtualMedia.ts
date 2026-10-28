/**
 * The sequence as one virtual media file for the interface (ADR 052).
 *
 * The timeline, the transport and the keyboard layer read one `ImportMediaResult`: its probe gives
 * the video time base, the start PTS, the extent and the nominal frame rate of their one axis. On a
 * sequence of several clips, this module gives them a media whose probe describes the virtual axis
 * of `virtualTime.ts`. The file facts (path, name, size, codec, picture size) stay those of the
 * attached clip, which the preview shows.
 *
 * With one clip, the virtual axis is the axis of that clip, so the media is the media of the clip
 * itself, the same object.
 */

import type { ImportMediaResult } from "@/features/media/types";
import type { TimelineState } from "@/features/timeline/types";
import type { VirtualTimeline } from "@/features/timeline/virtualTime";
import { rationalsEqual } from "@/lib/time";
import type { Rational } from "@/types/project";

/** The media of every source of the session, by source ID. */
export type MediaBySource = Readonly<Record<string, ImportMediaResult>>;

/** The parts of the timeline state that the virtual media reads. */
export type VirtualMediaTimeline = Pick<
  TimelineState,
  "clips" | "virtual" | "attachedClipId"
>;

/** The media of the clip that the preview shows: the attached clip, else the first clip. */
export function attachedMediaOf(
  timeline: Pick<TimelineState, "clips" | "attachedClipId">,
  media: MediaBySource,
): ImportMediaResult | null {
  const clip =
    timeline.clips.find((entry) => entry.id === timeline.attachedClipId) ??
    timeline.clips[0];
  return clip === undefined ? null : (media[clip.sourceId] ?? null);
}

/**
 * The one nominal rate of the sequence for the frame timecode (ADR 052, ADR 028), or null when the
 * sequence must show milliseconds:
 *
 * - every clip has an average rate equal to its real rate (a variable rate shows milliseconds);
 * - every clip has the same rate;
 * - every clip before the last has an exact extent that is a whole number of frames at that rate,
 *   within one tick of its own time base, so each clip starts on a frame of the count.
 */
export function sequenceNominalRate(
  timeline: VirtualMediaTimeline,
  media: MediaBySource,
): Rational | null {
  const virtual = timeline.virtual;
  if (virtual === null) {
    return null;
  }
  let rate: Rational | null = null;
  for (const [index, clip] of timeline.clips.entries()) {
    const probe = media[clip.sourceId]?.probe;
    const average = probe?.avgFrameRate ?? null;
    const real = probe?.rFrameRate ?? null;
    if (
      probe === undefined ||
      average === null ||
      real === null ||
      !rationalsEqual(average, real)
    ) {
      return null;
    }
    if (rate !== null && !rationalsEqual(rate, average)) {
      return null;
    }
    rate = average;
    const placement = virtual.clips[index];
    if (index < timeline.clips.length - 1) {
      if (
        placement === undefined ||
        !placement.exactDuration ||
        placement.durationTicks === null
      ) {
        return null;
      }
      if (!isWholeFrames(placement.durationTicks, virtual, average, placement.scale)) {
        return null;
      }
    }
  }
  return rate;
}

/**
 * True when `ticks` of the virtual time base is a whole number of frames at `rate`, within one
 * tick of the clip's own time base (`scale` virtual ticks).
 */
function isWholeFrames(
  ticks: bigint,
  virtual: VirtualTimeline,
  rate: Rational,
  scale: bigint,
): boolean {
  // In units of 1 / (T.n * rate.n) virtual ticks: the extent is `ticks * T.n * rate.n`, and one
  // frame is `T.d * rate.d`. Exact integers, so no rounding hides a drift.
  const perTick = BigInt(virtual.timeBase.n) * BigInt(rate.n);
  const extent = ticks * perTick;
  const frame = BigInt(virtual.timeBase.d) * BigInt(rate.d);
  const frames = (extent + frame / 2n) / frame;
  const distance =
    extent > frames * frame ? extent - frames * frame : frames * frame - extent;
  return frames > 0n && distance <= scale * perTick;
}

/**
 * The virtual media of the sequence, or the media of the one clip. Null for an empty sequence. A
 * sequence of several clips with no virtual axis gives the attached media as it is, so the
 * interface keeps working on one clip while the axis is not known.
 */
export function virtualMediaOf(
  timeline: VirtualMediaTimeline,
  media: MediaBySource,
): ImportMediaResult | null {
  const attached = attachedMediaOf(timeline, media);
  if (attached === null || timeline.clips.length <= 1 || timeline.virtual === null) {
    return attached;
  }
  const virtual = timeline.virtual;
  const origin = BigInt(virtual.originPts);
  const total = virtual.totalTicks;
  const seconds =
    total === null ? null : (Number(total) * virtual.timeBase.n) / virtual.timeBase.d;
  const rate = sequenceNominalRate(timeline, media);
  return {
    ...attached,
    probe: {
      ...attached.probe,
      videoTimeBase: virtual.timeBase,
      videoStartPts: virtual.originPts,
      videoEndPts:
        total !== null && virtual.exact
          ? ((origin + total).toString() as typeof virtual.originPts)
          : null,
      videoDurationTicks:
        total !== null && virtual.exact
          ? (total.toString() as NonNullable<
              ImportMediaResult["probe"]["videoDurationTicks"]
            >)
          : null,
      approximateDurationSeconds:
        seconds !== null && Number.isFinite(seconds) ? seconds : null,
      avgFrameRate: rate,
      rFrameRate: rate,
      reportedFrameCount: null,
    },
  };
}
