import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMediaStore, type MediaStoreState } from "@/features/media";
import { resolveTimecodeDisplay, usePlaybackStore } from "@/features/playback";
import { useTimecodePreference } from "@/features/settings/timecodePreference";
import { useTimelineStore, type TimelineStoreState } from "@/features/timeline";
import { timecodePlaceholder, type TimecodeDisplay } from "@/lib/timecode";
import type { Pts } from "@/types/project";
import {
  formatCurrentSegmentDuration,
  presentPendingSegmentDuration,
  resolveSegmentDurationSubject,
  settleSegmentDuration,
  type SegmentDurationTiming,
  type SegmentDurationValue,
} from "./segmentDurationModel";

const selectProbe = (s: MediaStoreState) => s.media?.probe;
const selectSegments = (s: TimelineStoreState) => s.segments;
const selectSourceId = (s: TimelineStoreState) => s.sourceId;
const selectCurrentSegmentId = (s: TimelineStoreState) => s.currentSegmentId;
const selectPendingInPts = (s: TimelineStoreState) => s.pendingInPts;

/**
 * Returns the duration to show, and keeps the last one while a pending seek hides the frame
 * on screen (`settleSegmentDuration`). The setter runs during the render only when the value
 * changes, which is the React pattern for state derived from the previous render.
 */
function useSettledDuration(presented: SegmentDurationValue): string | null {
  const [shown, setShown] = useState<string | null>(null);
  const next = settleSegmentDuration(shown, presented);
  if (next !== shown) {
    setShown(next);
  }
  return next;
}

/**
 * The two lines of the readout. The label names the segment, and the duration is under it in
 * the full timecode style of the source, as the Duration row of the segment tooltip shows it.
 * Both lines keep to the right edge, and the duration has monospace tabular figures and the
 * width of the timecode placeholder of the source, so the digits do not move while the value
 * counts. The block is the last item of the column and takes the free space on its left
 * (`ml-auto`), so it moves no other control when it shows or hides.
 */
function DurationBlock({
  label,
  duration,
  display,
}: {
  label: string;
  duration: string;
  display: TimecodeDisplay;
}) {
  return (
    <div className="ml-auto flex shrink-0 flex-col items-end gap-1 leading-none whitespace-nowrap">
      <span className="text-2xs leading-none text-muted-foreground">{label}</span>
      <span
        className="text-right font-mono text-[13px] leading-none font-medium text-foreground tabular-nums"
        style={{ width: `${timecodePlaceholder(display).length}ch` }}
      >
        {duration}
      </span>
    </div>
  );
}

/**
 * The duration from a pending In mark to the frame on screen. It is the one part of the
 * readout that reads the playback store, and it mounts only while an In mark is pending, so a
 * current segment adds no playback subscription. It renders once for each new frame on screen.
 * The caller keys it on the mark, so a new mark, or an undo that restores one during a seek,
 * starts with no kept value and never shows the duration of another mark.
 */
function PendingSegmentDuration({
  pendingInPts,
  timing,
}: {
  pendingInPts: Pts;
  timing: SegmentDurationTiming;
}) {
  const { t } = useTranslation();
  const duration = useSettledDuration(
    usePlaybackStore((s) => presentPendingSegmentDuration(pendingInPts, s, timing)),
  );
  if (duration === null) {
    return null;
  }
  return (
    <DurationBlock
      label={t("transport.segmentDuration.pending")}
      duration={duration}
      display={timing.display}
    />
  );
}

/**
 * The duration of the segment that is being edited, at the right end of the transport bar
 * (see `segmentDurationModel.ts`): the current segment, or the segment from a pending In mark
 * to the frame on screen. Nothing shows when neither applies.
 *
 * The duration of a current segment does not depend on the playhead. It is computed from the
 * timeline data once for each change of the segment, the source or the format, and this
 * component does not subscribe to the playback store.
 */
export function SegmentDurationReadout({
  hasActiveSource,
}: {
  hasActiveSource: boolean;
}) {
  const { t } = useTranslation();
  const probe = useMediaStore(selectProbe);
  const segments = useTimelineStore(selectSegments);
  const sourceId = useTimelineStore(selectSourceId);
  const currentSegmentId = useTimelineStore(selectCurrentSegmentId);
  const pendingInPts = useTimelineStore(selectPendingInPts);
  const timecodePreference = useTimecodePreference((s) => s.format);

  const subject = useMemo(
    () =>
      resolveSegmentDurationSubject(
        segments,
        currentSegmentId,
        sourceId,
        pendingInPts,
        hasActiveSource,
      ),
    [segments, currentSegmentId, sourceId, pendingInPts, hasActiveSource],
  );
  // The format of the source, as the preview timecode and the segment tooltip use it
  // (ADR 028).
  const timing = useMemo<SegmentDurationTiming>(
    () => ({
      videoStartPts: probe?.videoStartPts,
      videoTimeBase: probe?.videoTimeBase,
      display: resolveTimecodeDisplay(timecodePreference, probe),
    }),
    [probe, timecodePreference],
  );
  const segmentDuration = useMemo(
    () =>
      subject?.kind === "segment"
        ? formatCurrentSegmentDuration(subject.segment, timing)
        : null,
    [subject, timing],
  );

  if (subject === null) {
    return null;
  }
  if (subject.kind === "pending") {
    return (
      <PendingSegmentDuration
        key={subject.pendingInPts}
        pendingInPts={subject.pendingInPts}
        timing={timing}
      />
    );
  }
  if (segmentDuration === null) {
    return null;
  }
  return (
    <DurationBlock
      label={t("transport.segmentDuration.segment", { index: subject.number })}
      duration={segmentDuration}
      display={timing.display}
    />
  );
}
