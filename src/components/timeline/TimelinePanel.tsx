import { useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { Film } from "lucide-react";
import { getMediaSourceIdentity, useMediaStore } from "@/features/media";
import { usePlaybackStore } from "@/features/playback";
import {
  calculateFrameFromClientX,
  calculateKeyboardSeekTargetFrame,
  calculatePercentFromFrame,
  calculatePlayheadLayout,
  calculatePendingInRegionLayout,
  calculateSegmentLayout,
  useTimelineStore,
} from "@/features/timeline";
import { generateRulerMarkers } from "./timelineMarkers";

export function TimelinePanel() {
  const { t } = useTranslation();
  const media = useMediaStore((state) => state.media);
  const currentFrame = usePlaybackStore((state) => state.currentFrame);
  const isAttached = usePlaybackStore((state) => state.isAttached);
  const isReady = usePlaybackStore((state) => state.isReady);
  const seekToFrame = usePlaybackStore((state) => state.seekToFrame);

  const segments = useTimelineStore((state) => state.segments);
  const pendingInFrame = useTimelineStore((state) => state.pendingInFrame);
  const setSource = useTimelineStore((state) => state.setSource);
  const resetTimeline = useTimelineStore((state) => state.reset);

  const sourceIdentity = getMediaSourceIdentity(media);
  const frameCount = media?.probe.frameCount ?? 0;
  const canSeek = media !== null && isAttached && isReady && frameCount > 0;
  const clampedCurrentFrame =
    frameCount > 0
      ? Math.max(0, Math.min(frameCount - 1, Math.floor(currentFrame || 0)))
      : 0;

  // Synchronize active media source with the timeline store
  useLayoutEffect(() => {
    if (media && sourceIdentity) {
      setSource(sourceIdentity, media.probe.frameCount);
    } else {
      resetTimeline();
    }
  }, [media, sourceIdentity, setSource, resetTimeline]);

  const markers = media
    ? generateRulerMarkers(media.probe.frameCount, media.probe.avgFrameRate)
    : [];

  const handleSeekClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canSeek) {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const targetFrame = calculateFrameFromClientX(
      e.clientX,
      rect.left,
      rect.width,
      frameCount,
    );
    seekToFrame(targetFrame);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canSeek) {
      return;
    }
    const targetFrame = calculateKeyboardSeekTargetFrame(
      e.key,
      currentFrame,
      frameCount,
    );
    if (targetFrame !== null) {
      e.preventDefault();
      seekToFrame(targetFrame);
    }
  };

  const playhead = calculatePlayheadLayout(currentFrame, frameCount);
  const pendingRegion = calculatePendingInRegionLayout(
    pendingInFrame,
    currentFrame,
    frameCount,
  );
  const pendingInPercent =
    pendingInFrame !== null
      ? calculatePercentFromFrame(pendingInFrame, frameCount)
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
                    key={`${marker.frame}-${marker.left}`}
                    className="pointer-events-none absolute bottom-0 flex -translate-x-1/2 flex-col items-center gap-0.5"
                    style={{ left: marker.left }}
                  >
                    <span className="text-muted-foreground">{marker.timecode}</span>
                    <div className="h-1.5 w-px bg-timeline-divider" />
                  </div>
                ))}
              </div>

              {/* Playhead marker in ruler */}
              {media && frameCount > 0 && (
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
                  aria-valuemax={Math.max(0, frameCount - 1)}
                  aria-valuenow={clampedCurrentFrame}
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
                  {segments.map((seg, index) => {
                    const layout = calculateSegmentLayout(seg, frameCount);
                    return (
                      <div
                        key={seg.id}
                        className="pointer-events-none absolute inset-y-1 z-10 flex items-center overflow-hidden rounded-md border-2 border-primary bg-primary/25 px-2 text-foreground shadow-xs backdrop-blur-xs"
                        style={{
                          left: layout.left,
                          width: layout.width,
                        }}
                      >
                        <span className="truncate font-mono text-[10px] font-semibold text-primary">
                          #{index + 1}
                        </span>
                      </div>
                    );
                  })}

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
                  {frameCount > 0 && (
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
