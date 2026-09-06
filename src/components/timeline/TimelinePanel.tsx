import { useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Film } from "lucide-react";
import {
  generateSourceId,
  getSourceRevisionKey,
  useMediaStore,
  type MediaStoreState,
} from "@/features/media";
import { usePlaybackStore, type PlaybackStoreState } from "@/features/playback";
import {
  calculatePendingInRegionLayout,
  calculatePercentFromPts,
  calculatePlayheadLayout,
  calculatePtsFromClientX,
  calculateSegmentLayout,
  calculateTimelineSecondsFromClientX,
  getActiveSourceSegmentEntries,
  getTimelineDurationSeconds,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import { ptsElapsedSeconds } from "@/lib/time";
import { generateRulerMarkers } from "./timelineMarkers";

export interface TimelinePanelProps {
  /** Stable project source ID when project state already owns one. */
  activeSourceId?: string | null;
  /** Finite HTMLMediaElement.duration supplied by preview runtime state. */
  runtimeBrowserDurationSeconds?: number | null;
  /** Browser-time seek request used when calibrated PTS seeking is unavailable. */
  onApproximateSeek?: (seconds: number) => void;
}

const generatedSourceIdsByPath = new Map<string, string>();

function getGeneratedSourceId(path: string): string {
  const existing = generatedSourceIdsByPath.get(path);
  if (existing) {
    return existing;
  }
  const generated = generateSourceId();
  generatedSourceIdsByPath.set(path, generated);
  return generated;
}

const selectMedia = (state: MediaStoreState) => state.media;
const selectPresentedFrame = (state: PlaybackStoreState) => state.presentedFrame;
const selectCalibrationStatus = (state: PlaybackStoreState) => state.calibrationStatus;
const selectIsAttached = (state: PlaybackStoreState) => state.isAttached;
const selectIsReady = (state: PlaybackStoreState) => state.isReady;
const selectSeekToPts = (state: PlaybackStoreState) => state.seekToPts;
const selectSeekNominal = (state: PlaybackStoreState) => state.seekNominal;

const selectSegments = (state: TimelineStoreState) => state.segments;
const selectPendingInPts = (state: TimelineStoreState) => state.pendingInPts;
const selectSetSource = (state: TimelineStoreState) => state.setSource;

export function TimelinePanel({
  activeSourceId,
  runtimeBrowserDurationSeconds = null,
  onApproximateSeek,
}: TimelinePanelProps = {}) {
  const { t } = useTranslation();
  const media = useMediaStore(selectMedia);
  const presentedFrame = usePlaybackStore(selectPresentedFrame);
  const calibrationStatus = usePlaybackStore(selectCalibrationStatus);
  const isAttached = usePlaybackStore(selectIsAttached);
  const isReady = usePlaybackStore(selectIsReady);
  const seekToPts = usePlaybackStore(selectSeekToPts);
  const seekNominal = usePlaybackStore(selectSeekNominal);

  const segments = useTimelineStore(selectSegments);
  const pendingInPts = useTimelineStore(selectPendingInPts);
  const setSource = useTimelineStore(selectSetSource);

  const sourceRevisionKey = getSourceRevisionKey(media);
  const sourceId = media ? (activeSourceId ?? getGeneratedSourceId(media.path)) : null;

  // Synchronize active media source with the timeline store
  useLayoutEffect(() => {
    if (sourceId && sourceRevisionKey) {
      setSource(sourceId, sourceRevisionKey);
    } else {
      setSource(null, null);
    }
  }, [sourceId, sourceRevisionKey, setSource]);

  const totalDurationSeconds = useMemo(() => {
    if (!media) return null;
    return getTimelineDurationSeconds({
      videoDurationTicks: media.probe.videoDurationTicks,
      videoTimeBase: media.probe.videoTimeBase,
      approximateDurationSeconds: media.probe.approximateDurationSeconds,
      runtimeBrowserDuration: runtimeBrowserDurationSeconds,
    });
  }, [media, runtimeBrowserDurationSeconds]);

  const isIndeterminate = totalDurationSeconds === null || totalDurationSeconds <= 0;
  const canUsePreciseSeek =
    media !== null &&
    isAttached &&
    isReady &&
    !isIndeterminate &&
    calibrationStatus === "ready" &&
    media.probe.videoStartPts !== null;
  const canUseApproximateSeek =
    media !== null &&
    isAttached &&
    isReady &&
    !isIndeterminate &&
    onApproximateSeek !== undefined;
  const canSeek = canUsePreciseSeek || canUseApproximateSeek;

  const markers = useMemo(() => {
    return generateRulerMarkers(totalDurationSeconds);
  }, [totalDurationSeconds]);

  // Current elapsed presentation seconds relative to videoStartPts
  const currentElapsedSeconds = useMemo(() => {
    if (
      calibrationStatus === "ready" &&
      presentedFrame !== null &&
      media?.probe.videoStartPts &&
      media?.probe.videoTimeBase
    ) {
      return (
        ptsElapsedSeconds(
          presentedFrame.inferredSourcePts,
          media.probe.videoStartPts,
          media.probe.videoTimeBase,
        ) ?? 0
      );
    }
    return 0;
  }, [calibrationStatus, presentedFrame, media]);

  const handleSeekClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canSeek || totalDurationSeconds === null) {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    if (canUsePreciseSeek && media?.probe.videoStartPts && media.probe.videoTimeBase) {
      const targetPts = calculatePtsFromClientX(
        e.clientX,
        rect.left,
        rect.width,
        totalDurationSeconds,
        media.probe.videoStartPts,
        media.probe.videoTimeBase,
      );
      if (targetPts !== null) {
        seekToPts(targetPts);
      }
      return;
    }
    const targetSeconds = calculateTimelineSecondsFromClientX(
      e.clientX,
      rect.left,
      rect.width,
      totalDurationSeconds,
    );
    if (targetSeconds !== null) {
      onApproximateSeek?.(targetSeconds);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canUsePreciseSeek) {
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      seekNominal(-1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      seekNominal(1);
    } else if (e.key === "Home" && media?.probe.videoStartPts) {
      e.preventDefault();
      seekToPts(media.probe.videoStartPts);
    }
  };

  const playhead = calculatePlayheadLayout(currentElapsedSeconds, totalDurationSeconds);

  const activeSourceSegments = useMemo(
    () => getActiveSourceSegmentEntries(segments, sourceId),
    [segments, sourceId],
  );
  // None of the layout inputs depends on the playhead, so this must not rerun per frame.
  const segmentLayouts = useMemo(
    () =>
      activeSourceSegments.map(({ segment, projectIndex }) => ({
        segment,
        projectIndex,
        layout: calculateSegmentLayout(
          segment,
          media?.probe.videoStartPts,
          media?.probe.videoTimeBase,
          totalDurationSeconds,
        ),
      })),
    [activeSourceSegments, media, totalDurationSeconds],
  );

  // The pending In region does depend on the playhead, so it stays on the render path.
  const pendingRegion = calculatePendingInRegionLayout(
    pendingInPts,
    presentedFrame?.inferredSourcePts ?? null,
    media?.probe.videoStartPts,
    media?.probe.videoTimeBase,
    totalDurationSeconds,
  );

  const pendingInPercent =
    pendingInPts !== null &&
    media?.probe.videoStartPts &&
    media?.probe.videoTimeBase &&
    totalDurationSeconds &&
    totalDurationSeconds > 0
      ? calculatePercentFromPts(
          pendingInPts,
          media.probe.videoStartPts,
          media.probe.videoTimeBase,
          totalDurationSeconds,
        )
      : null;

  return (
    <section className="flex h-[180px] shrink-0 flex-col border-t border-timeline-divider bg-timeline-background text-foreground select-none">
      <div className="flex min-h-0 flex-1 flex-col overflow-x-auto overflow-y-hidden">
        <div className="flex min-w-[900px] flex-1 flex-col">
          {/* Ruler Row (~28px tall) */}
          <div className="flex h-7 shrink-0 border-b border-timeline-divider">
            {/* Gutter header pinned sticky on the left */}
            <div className="sticky left-0 z-20 w-24 shrink-0 border-r border-timeline-divider bg-sidebar" />

            {/* Ruler track with time markers and tick marks */}
            <div className="relative flex-1 bg-timeline-ruler">
              {/* Timecode labels and ticks */}
              <div className="relative h-full w-full font-mono text-[10px]">
                {markers.map((marker) => (
                  <div
                    key={`${marker.seconds}-${marker.left}`}
                    className="pointer-events-none absolute bottom-0 flex -translate-x-1/2 flex-col items-center gap-0.5"
                    style={{ left: marker.left }}
                  >
                    <span className="text-muted-foreground">{marker.timecode}</span>
                    <div className="h-1.5 w-px bg-timeline-divider" />
                  </div>
                ))}
              </div>

              {/* Playhead marker in ruler */}
              {media && !isIndeterminate && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-30 flex -translate-x-1/2 flex-col items-center"
                  style={{ left: playhead.left }}
                  aria-label={t("timeline.playhead")}
                >
                  <div className="h-2 w-3 rounded-b-xs bg-timeline-playhead shadow-xs" />
                  <div className="h-full w-0.5 bg-timeline-playhead" />
                </div>
              )}
            </div>
          </div>

          {/* Single-Source Overview Track Row */}
          <div className="flex min-h-0 flex-1">
            {/* Left gutter (~96px wide) displaying Source Media lane header */}
            <div className="sticky left-0 z-20 flex w-24 shrink-0 items-center border-r border-timeline-divider bg-sidebar px-3">
              <span className="truncate text-xs font-semibold text-sidebar-foreground">
                {t("timeline.sourceLane")}
              </span>
            </div>

            {/* Track lane container */}
            <div className="relative flex flex-1 items-center bg-timeline-track py-2">
              {media ? (
                /* Canonical accessible seek surface: inner source surface spanning full extent with overlays */
                <div
                  role="slider"
                  aria-label={t("timeline.seekSlider")}
                  aria-disabled={!canSeek}
                  aria-valuemin={0}
                  aria-valuemax={isIndeterminate ? undefined : totalDurationSeconds}
                  aria-valuenow={
                    isIndeterminate || !Number.isFinite(currentElapsedSeconds)
                      ? undefined
                      : Math.max(
                          0,
                          Math.min(totalDurationSeconds, currentElapsedSeconds),
                        )
                  }
                  tabIndex={canSeek ? 0 : undefined}
                  onClick={canSeek ? handleSeekClick : undefined}
                  onKeyDown={canSeek ? handleKeyDown : undefined}
                  className={`relative h-full w-full ${canSeek ? "cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden" : ""}`}
                >
                  {/* Full-source background layer */}
                  <div className="pointer-events-none absolute inset-0 flex items-center gap-2 overflow-hidden rounded-lg border border-border bg-clip-video p-2 text-clip-foreground shadow-xs">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-preview-surface text-preview-muted">
                      <Film className="size-3.5" />
                    </div>
                    <span className="truncate text-xs font-medium">
                      {media.fileName}
                    </span>
                  </div>

                  {/* Completed segment overlays */}
                  {segmentLayouts.map(({ segment: seg, projectIndex, layout }) => (
                    <div
                      key={seg.id}
                      className="pointer-events-none absolute inset-y-1 z-10 flex items-center overflow-hidden rounded-md border-2 border-primary bg-primary/25 px-2 text-foreground shadow-xs backdrop-blur-xs"
                      style={{
                        left: layout.left,
                        width: layout.width,
                      }}
                    >
                      <span className="truncate font-mono text-[10px] font-semibold text-primary">
                        #{projectIndex + 1}
                      </span>
                    </div>
                  ))}

                  {/* Pending In active region preview overlay */}
                  {pendingRegion && pendingRegion.isVisible && (
                    <div
                      className="pointer-events-none absolute inset-y-1 z-10 rounded-md border-2 border-dashed border-primary/80 bg-primary/15"
                      style={{
                        left: pendingRegion.left,
                        width: pendingRegion.width,
                      }}
                    />
                  )}

                  {/* Pending In vertical flag/marker */}
                  {pendingInPercent !== null && (
                    <div
                      className="pointer-events-none absolute inset-y-0 z-20 flex -translate-x-1/2 flex-col items-center"
                      style={{ left: `${pendingInPercent}%` }}
                    >
                      <div className="h-full w-0.5 bg-primary shadow-xs" />
                    </div>
                  )}

                  {/* Playhead vertical line spanning the track lane */}
                  {!isIndeterminate && (
                    <div
                      className="pointer-events-none absolute inset-y-0 z-30 flex -translate-x-1/2 flex-col items-center"
                      style={{ left: playhead.left }}
                    >
                      <div className="h-full w-0.5 bg-timeline-playhead shadow-xs" />
                    </div>
                  )}
                </div>
              ) : (
                /* Localized empty prompt */
                <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                  <span className="italic">{t("timeline.emptyPrompt")}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
