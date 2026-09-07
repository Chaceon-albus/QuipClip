import { useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Film } from "lucide-react";
import {
  getGeneratedSourceId,
  getSourceRevisionKey,
  useMediaStore,
  type MediaStoreState,
} from "@/features/media";
import {
  isPlaybackPositionApproximate,
  usePlaybackStore,
  type PlaybackStoreState,
} from "@/features/playback";
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

const selectMedia = (state: MediaStoreState) => state.media;
const selectPresentedFrame = (state: PlaybackStoreState) => state.presentedFrame;
const selectCalibrationStatus = (state: PlaybackStoreState) => state.calibrationStatus;
const selectApproximateBrowserTimeSeconds = (state: PlaybackStoreState) =>
  state.approximateBrowserTimeSeconds;
const selectIsAttached = (state: PlaybackStoreState) => state.isAttached;
const selectIsReady = (state: PlaybackStoreState) => state.isReady;
const selectSeekToPts = (state: PlaybackStoreState) => state.seekToPts;
const selectSeekNominal = (state: PlaybackStoreState) => state.seekNominal;

const selectSegments = (state: TimelineStoreState) => state.segments;
const selectPendingInPts = (state: TimelineStoreState) => state.pendingInPts;
const selectSetSource = (state: TimelineStoreState) => state.setSource;
const selectCurrentSegmentId = (state: TimelineStoreState) => state.currentSegmentId;
const selectSelectSegment = (state: TimelineStoreState) => state.selectSegment;

export function TimelinePanel({
  activeSourceId,
  runtimeBrowserDurationSeconds = null,
  onApproximateSeek,
}: TimelinePanelProps = {}) {
  const { t } = useTranslation();
  const media = useMediaStore(selectMedia);
  const presentedFrame = usePlaybackStore(selectPresentedFrame);
  const calibrationStatus = usePlaybackStore(selectCalibrationStatus);
  const approximateBrowserTimeSeconds = usePlaybackStore(
    selectApproximateBrowserTimeSeconds,
  );
  const isAttached = usePlaybackStore(selectIsAttached);
  const isReady = usePlaybackStore(selectIsReady);
  const seekToPts = usePlaybackStore(selectSeekToPts);
  const seekNominal = usePlaybackStore(selectSeekNominal);

  const segments = useTimelineStore(selectSegments);
  const pendingInPts = useTimelineStore(selectPendingInPts);
  const setSource = useTimelineStore(selectSetSource);
  const currentSegmentId = useTimelineStore(selectCurrentSegmentId);
  const selectSegment = useTimelineStore(selectSelectSegment);

  const sourceRevisionKey = getSourceRevisionKey(media);
  // The generated ID is keyed by the revision key, not by the path, so a file that changed on
  // disk becomes a new source and its old marks stop matching the active source.
  const sourceId = media ? (activeSourceId ?? getGeneratedSourceId(media)) : null;

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

  // True while the playhead position below comes from the browser clock. The playhead takes
  // no visual mark for it: the status bar carries the marking, and marking it twice would
  // make a working playhead look broken.
  const isPositionApproximate = isPlaybackPositionApproximate(
    calibrationStatus,
    presentedFrame,
  );

  // Current elapsed presentation seconds relative to videoStartPts, and the approximate
  // browser clock otherwise. A source that never calibrates has no inferred PTS for its whole
  // session, and a frozen 0 would leave the playhead at the left edge while the picture plays.
  // Both branches report seconds elapsed from the start of the source, the axis the whole
  // ruler uses: the store subtracts the origin of the browser media timeline from the
  // approximate clock, and `onApproximateSeek` adds it back (ADR 003).
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
    return approximateBrowserTimeSeconds ?? 0;
  }, [calibrationStatus, presentedFrame, media, approximateBrowserTimeSeconds]);

  /**
   * Seeks to the timeline position under a client X coordinate.
   *
   * Takes the rectangle it maps against, so both click-to-seek surfaces of the panel, the
   * ruler track and the seek slider, share one implementation.
   */
  const seekFromClientX = (clientX: number, rect: DOMRect) => {
    if (!canSeek || totalDurationSeconds === null) {
      return;
    }
    if (canUsePreciseSeek && media?.probe.videoStartPts && media.probe.videoTimeBase) {
      const targetPts = calculatePtsFromClientX(
        clientX,
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
      clientX,
      rect.left,
      rect.width,
      totalDurationSeconds,
    );
    if (targetSeconds !== null) {
      onApproximateSeek?.(targetSeconds);
    }
  };

  const handleSeekClick = (e: React.MouseEvent<HTMLDivElement>) => {
    seekFromClientX(e.clientX, e.currentTarget.getBoundingClientRect());
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
  // None of these inputs depends on the playhead, so this must not rerun per frame. The
  // label and the number belong here for that reason: `t` is stable per language, so a
  // catalog lookup per segment costs nothing here and would cost one per presented frame
  // in the render body.
  const segmentLayouts = useMemo(
    () =>
      activeSourceSegments
        .map(({ segment, projectIndex }) => ({
          segment,
          number: projectIndex + 1,
          label: t("timeline.segment", { index: projectIndex + 1 }),
          layout: calculateSegmentLayout(
            segment,
            media?.probe.videoStartPts,
            media?.probe.videoTimeBase,
            totalDurationSeconds,
          ),
        }))
        // A zero-width overlay has no visible target. As a button it would also be a Tab
        // stop with nothing to show, which reads as a dead key press.
        .filter(({ layout }) => layout.widthPercent > 0),
    [activeSourceSegments, media, totalDurationSeconds, t],
  );
  const segmentListLabel = useMemo(() => t("timeline.segmentList"), [t]);

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

            {/*
             * Ruler track with time markers and tick marks, and the mouse click-to-seek
             * surface of the panel. A segment button takes the clicks over its own span,
             * so the track lane below is not a seek surface once segments cover the
             * source. This rectangle has the same left edge and the same width as the
             * track lane rectangle, so `seekFromClientX` maps a coordinate identically.
             *
             * Mouse only, by intent: the keyboard path stays on the single
             * `role="slider"` element below. A second focus stop here would repeat the
             * same arrow-key behaviour, and a focusable element with no role announces
             * nothing.
             */}
            <div
              onClick={canSeek ? handleSeekClick : undefined}
              className={`relative flex-1 bg-timeline-ruler ${canSeek ? "cursor-pointer" : ""}`}
            >
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
                  data-approximate={isPositionApproximate}
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
                /*
                 * Shared geometry box. The seek slider and the segment layer are siblings
                 * inside it, each spanning the same rectangle, so `inset-y-1` and the
                 * left/width percentages resolve exactly as they did when the overlays
                 * were children of the slider. Segments are interactive, and interactive
                 * content cannot be nested inside a `role="slider"` element.
                 */
                <div className="relative h-full w-full">
                  {/* Canonical accessible seek surface */}
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
                    className={`absolute inset-0 ${canSeek ? "cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden" : ""}`}
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

                    {/* Pending In active region preview overlay */}
                    {pendingRegion && pendingRegion.isVisible && (
                      <div
                        className="pointer-events-none absolute inset-y-1 z-20 rounded-md border-2 border-dashed border-primary/80 bg-primary/15"
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
                        data-approximate={isPositionApproximate}
                      >
                        <div className="h-full w-0.5 bg-timeline-playhead shadow-xs" />
                      </div>
                    )}
                  </div>

                  {/*
                   * Completed segment overlays. The layer takes the clicks of its buttons
                   * only, so uncovered track stays a click-to-seek surface; over a
                   * segment, the ruler track above is the seek surface. The `z-10` puts
                   * this layer under the pending region and the playhead.
                   */}
                  <div
                    role="group"
                    aria-label={segmentListLabel}
                    className="pointer-events-none absolute inset-0 z-10"
                  >
                    {segmentLayouts.map(({ segment: seg, number, label, layout }) => {
                      // A string comparison at render time, so selection never rebuilds
                      // the memoized layouts.
                      const isCurrent = seg.id === currentSegmentId;
                      return (
                        <button
                          key={seg.id}
                          type="button"
                          aria-pressed={isCurrent}
                          aria-label={label}
                          // Selecting does not seek: the playhead is the operand of Mark
                          // In, Mark Out and Split, so a selection click must not move it.
                          onClick={() => selectSegment(seg.id)}
                          className={`pointer-events-auto absolute inset-y-1 flex items-center overflow-hidden rounded-md border-2 border-primary px-2 text-foreground shadow-xs backdrop-blur-xs ${isCurrent ? "bg-primary/45 ring-2 ring-ring" : "bg-primary/25"}`}
                          style={{
                            left: layout.left,
                            width: layout.width,
                          }}
                        >
                          <span className="truncate font-mono text-[10px] font-semibold text-primary">
                            #{number}
                          </span>
                        </button>
                      );
                    })}
                  </div>
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
