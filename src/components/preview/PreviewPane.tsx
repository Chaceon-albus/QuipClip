import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AlertCircle, ChevronDown, Loader2, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getSourceRevisionKey, useMediaStore } from "@/features/media";
import { createVideoRefCallback, usePlaybackStore } from "@/features/playback";
import {
  createSourceLifecycleGuard,
  formatPreviewCurrentTime,
  formatPreviewTotalDuration,
  isPreviewTimeApproximate,
} from "./previewFrame";

export function PreviewPane() {
  const { t } = useTranslation();
  const { status, media, error } = useMediaStore();

  const presentedFrame = usePlaybackStore((s) => s.presentedFrame);
  const calibrationStatus = usePlaybackStore((s) => s.calibrationStatus);
  const playbackError = usePlaybackStore((s) => s.error);
  const attach = usePlaybackStore((s) => s.attach);
  const detach = usePlaybackStore((s) => s.detach);
  const syncReady = usePlaybackStore((s) => s.syncReady);
  const syncUnready = usePlaybackStore((s) => s.syncUnready);
  const syncPresentedFrame = usePlaybackStore((s) => s.syncPresentedFrame);
  const syncPresentationUnavailable = usePlaybackStore(
    (s) => s.syncPresentationUnavailable,
  );
  const syncBrowserDuration = usePlaybackStore((s) => s.syncBrowserDuration);
  const syncPlay = usePlaybackStore((s) => s.syncPlay);
  const syncPause = usePlaybackStore((s) => s.syncPause);
  const syncEnded = usePlaybackStore((s) => s.syncEnded);
  const resetPlayback = usePlaybackStore((s) => s.reset);

  const sourceRevisionKey = getSourceRevisionKey(media);
  const [previousRevisionKey, setPreviousRevisionKey] = useState(sourceRevisionKey);
  const [videoError, setVideoError] = useState(false);
  const [approximateBrowserTime, setApproximateBrowserTime] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [sourceGuard] = useState(() => createSourceLifecycleGuard());

  // Reset decode error state and approximate time synchronously when source identity changes
  if (previousRevisionKey !== sourceRevisionKey) {
    setPreviousRevisionKey(sourceRevisionKey);
    setVideoError(false);
    setApproximateBrowserTime(0);
  }

  // Reset playback store if media disappears
  useEffect(() => {
    if (!media) {
      resetPlayback();
    }
  }, [media, resetPlayback]);

  // Synchronously activate / deactivate source identity before browser paint (ADR 003)
  useLayoutEffect(() => {
    sourceGuard.activate(sourceRevisionKey);
    return () => {
      sourceGuard.deactivate(sourceRevisionKey);
    };
  }, [sourceRevisionKey, sourceGuard]);

  const mediaPath = media?.path;
  const mediaSize = media?.size;
  const mediaMtime = media?.mtime;
  const videoTimeBase = media?.probe.videoTimeBase;
  const videoStartPts = media?.probe.videoStartPts;
  const videoDurationTicks = media?.probe.videoDurationTicks;
  const approximateDurationSeconds = media?.probe.approximateDurationSeconds;
  const avgFrameRate = media?.probe.avgFrameRate;
  const rFrameRate = media?.probe.rFrameRate;
  const reportedFrameCount = media?.probe.reportedFrameCount;

  // Stable ref callback for registering and unregistering video element in playback store with exact ownership
  const videoRefCallback = useMemo(
    () =>
      createVideoRefCallback<HTMLVideoElement>({
        videoRef,
        getSource: () =>
          mediaPath !== undefined &&
          mediaSize !== undefined &&
          mediaMtime !== undefined &&
          videoTimeBase !== undefined
            ? {
                path: mediaPath,
                size: mediaSize,
                mtime: mediaMtime,
                videoTimeBase,
                videoStartPts: videoStartPts ?? null,
                videoDurationTicks,
                approximateDurationSeconds,
                avgFrameRate,
                rFrameRate,
                reportedFrameCount,
              }
            : null,
        attach,
        detach,
      }),
    [
      mediaPath,
      mediaSize,
      mediaMtime,
      videoTimeBase,
      videoStartPts,
      videoDurationTicks,
      approximateDurationSeconds,
      avgFrameRate,
      rFrameRate,
      reportedFrameCount,
      attach,
      detach,
    ],
  );

  // Register requestVideoFrameCallback lifecycle loop (ADR 003)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !media || videoError) {
      return;
    }

    const expectedRevisionKey = sourceRevisionKey;
    let cancelled = false;
    let handle: number | null = null;

    const hasRvfc =
      "requestVideoFrameCallback" in video &&
      typeof (
        video as HTMLVideoElement & {
          requestVideoFrameCallback?: (
            callback: (
              now: DOMHighResTimeStamp,
              metadata: { mediaTime: number; presentedFrames?: number },
            ) => void,
          ) => number;
          cancelVideoFrameCallback?: (handle: number) => void;
        }
      ).requestVideoFrameCallback === "function";

    if (hasRvfc) {
      const onFrame = (
        _now: DOMHighResTimeStamp,
        metadata: { mediaTime: number; presentedFrames?: number },
      ) => {
        // Guard against late callbacks from unmounted or replaced sources
        if (cancelled || !sourceGuard.isActive(expectedRevisionKey)) {
          return;
        }

        syncPresentedFrame(
          expectedRevisionKey,
          metadata.mediaTime,
          metadata.presentedFrames,
          video,
        );

        // Re-register the one-shot callback while the video remains active
        const videoElement = video as HTMLVideoElement & {
          requestVideoFrameCallback: (
            callback: (
              now: DOMHighResTimeStamp,
              metadata: { mediaTime: number; presentedFrames?: number },
            ) => void,
          ) => number;
        };
        handle = videoElement.requestVideoFrameCallback(onFrame);
      };

      const videoElement = video as HTMLVideoElement & {
        requestVideoFrameCallback: (
          callback: (
            now: DOMHighResTimeStamp,
            metadata: { mediaTime: number; presentedFrames?: number },
          ) => void,
        ) => number;
      };
      handle = videoElement.requestVideoFrameCallback(onFrame);
    } else {
      syncPresentationUnavailable(expectedRevisionKey, video);
    }

    return () => {
      cancelled = true;
      if (handle !== null) {
        const videoElement = video as HTMLVideoElement & {
          cancelVideoFrameCallback?: (handle: number) => void;
        };
        if (typeof videoElement.cancelVideoFrameCallback === "function") {
          videoElement.cancelVideoFrameCallback(handle);
        }
      }
    };
  }, [
    sourceRevisionKey,
    media,
    videoError,
    sourceGuard,
    syncPresentedFrame,
    syncPresentationUnavailable,
  ]);

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!sourceGuard.isActive(sourceRevisionKey) || !media) {
      return;
    }
    setApproximateBrowserTime(e.currentTarget.currentTime);
  };

  const handleVideoError = () => {
    if (!sourceGuard.isActive(sourceRevisionKey)) {
      return;
    }
    setVideoError(true);
  };

  // Compute timecodes: source-relative HH:MM:SS.mmm for ready inferred PTS, approximate browser time otherwise
  const currentTimeDisplay = media
    ? formatPreviewCurrentTime(
        presentedFrame,
        calibrationStatus,
        media.probe.videoStartPts,
        media.probe.videoTimeBase,
        approximateBrowserTime,
      )
    : "00:00:00.000";

  const totalTimeDisplay = media
    ? formatPreviewTotalDuration(
        media.probe.approximateDurationSeconds,
        media.probe.videoDurationTicks,
        media.probe.videoTimeBase,
      )
    : "00:00:00.000";
  const isCurrentTimeApproximate = isPreviewTimeApproximate(
    calibrationStatus,
    presentedFrame,
  );

  return (
    <section className="flex min-h-[200px] flex-1 flex-col overflow-hidden bg-preview-background p-3 text-preview-foreground select-none">
      {/* 16:9 Video Canvas Surface */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <div className="relative flex aspect-video h-full max-h-full w-auto max-w-full items-center justify-center overflow-hidden rounded-lg border border-preview-border bg-preview-surface shadow-xs">
          {media ? (
            <>
              {/* Loaded Video Surface: Preserved during replacements or error states */}
              {videoError ? (
                <div
                  className="flex max-w-md flex-col items-center justify-center gap-2 p-4 text-center"
                  aria-live="polite"
                >
                  <AlertCircle className="size-6 shrink-0 text-amber-500" />
                  <p className="text-xs font-medium text-amber-400">
                    {t("preview.decodeError")}
                  </p>
                </div>
              ) : (
                <video
                  ref={videoRefCallback}
                  key={sourceRevisionKey}
                  playsInline
                  preload="metadata"
                  src={convertFileSrc(media.path)}
                  aria-label={t("preview.videoPlayerLabel", {
                    fileName: media.fileName,
                  })}
                  className="h-full w-full object-contain"
                  onPlay={(e) => {
                    if (sourceGuard.isActive(sourceRevisionKey)) {
                      syncPlay(sourceRevisionKey, e.currentTarget);
                    }
                  }}
                  onPause={(e) => {
                    if (sourceGuard.isActive(sourceRevisionKey)) {
                      syncPause(sourceRevisionKey, e.currentTarget);
                    }
                  }}
                  onEnded={(e) => {
                    if (sourceGuard.isActive(sourceRevisionKey)) {
                      syncEnded(sourceRevisionKey, e.currentTarget);
                    }
                  }}
                  onTimeUpdate={handleTimeUpdate}
                  onSeeked={handleTimeUpdate}
                  onDurationChange={(e) => {
                    if (sourceGuard.isActive(sourceRevisionKey)) {
                      syncBrowserDuration(sourceRevisionKey, e.currentTarget);
                    }
                  }}
                  onLoadedMetadata={(e) => {
                    if (sourceGuard.isActive(sourceRevisionKey)) {
                      syncReady(sourceRevisionKey, e.currentTarget);
                      syncBrowserDuration(sourceRevisionKey, e.currentTarget);
                      handleTimeUpdate(e);
                    }
                  }}
                  onError={(e) => {
                    if (sourceGuard.isActive(sourceRevisionKey)) {
                      syncUnready(sourceRevisionKey, e.currentTarget);
                      handleVideoError();
                    }
                  }}
                />
              )}

              {/* Restrained Overlay when replacement media is loading */}
              {status === "loading" && (
                <div
                  className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-md border border-border/80 bg-background/90 px-2.5 py-1 text-xs text-foreground shadow-md backdrop-blur-xs"
                  aria-live="polite"
                >
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                  <span>{t("preview.loading")}</span>
                </div>
              )}

              {/* Restrained Overlay when a replacement or dialog error occurs */}
              {status === "error" && error && (
                <div
                  className="absolute top-3 right-3 left-3 z-10 flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/90 px-3 py-1.5 text-xs text-destructive-foreground shadow-md backdrop-blur-xs"
                  aria-live="polite"
                >
                  <div className="flex items-center gap-2 truncate">
                    <AlertCircle className="size-4 shrink-0" />
                    <span className="truncate font-medium">
                      {t(`mediaError.${error.code}`, {
                        defaultValue: t("mediaError.unknown"),
                      })}
                    </span>
                  </div>
                </div>
              )}

              {/* Restrained Overlay when local playback start fails */}
              {playbackError && !videoError && (
                <div
                  className="absolute top-3 right-3 left-3 z-10 flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/90 px-3 py-1.5 text-xs text-destructive-foreground shadow-md backdrop-blur-xs"
                  aria-live="polite"
                >
                  <div className="flex items-center gap-2 truncate">
                    <AlertCircle className="size-4 shrink-0" />
                    <span className="truncate font-medium">
                      {t(`playbackError.${playbackError}`, {
                        defaultValue: t("playbackError.playbackFailed"),
                      })}
                    </span>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Full Empty / Loading / Error State when no media is loaded */
            <>
              {status === "loading" && (
                <div
                  className="flex flex-col items-center justify-center gap-2 text-xs text-preview-muted"
                  aria-live="polite"
                >
                  <Loader2 className="size-6 animate-spin text-primary" />
                  <span>{t("preview.loading")}</span>
                </div>
              )}

              {status === "error" && error && (
                <div
                  className="flex max-w-md flex-col items-center justify-center gap-2 p-4 text-center"
                  aria-live="polite"
                >
                  <AlertCircle className="size-6 shrink-0 text-destructive" />
                  <p className="text-xs font-medium text-destructive-foreground">
                    {t(`mediaError.${error.code}`, {
                      defaultValue: t("mediaError.unknown"),
                    })}
                  </p>
                  {error.detail && (
                    <p className="max-h-24 w-full overflow-y-auto rounded border border-border bg-background/60 p-2 text-left font-mono text-[11px] break-all text-muted-foreground select-text">
                      {error.detail}
                    </p>
                  )}
                </div>
              )}

              {status === "idle" && (
                <span className="text-xs text-preview-muted">
                  {t("preview.noMedia")}
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Preview Bottom Row: Timecode and View Controls */}
      <div className="flex shrink-0 items-center justify-between px-1 pt-2">
        <div className="flex items-center gap-1.5 font-mono text-xs">
          <span className="font-medium text-primary">{currentTimeDisplay}</span>
          {media && isCurrentTimeApproximate && (
            <span className="text-preview-muted">{t("preview.approximate")}</span>
          )}
          <span className="text-preview-muted">/</span>
          <span className="text-preview-muted">{totalTimeDisplay}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled>
              <Button
                variant="ghost"
                size="xs"
                disabled
                className="h-6 gap-1 px-2 text-xs text-preview-muted hover:bg-preview-surface hover:text-preview-foreground"
              >
                {t("preview.zoom.fit")}
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>{t("preview.zoom.fit")}</DropdownMenuItem>
              <DropdownMenuItem>{t("preview.zoom.zoom50")}</DropdownMenuItem>
              <DropdownMenuItem>{t("preview.zoom.zoom100")}</DropdownMenuItem>
              <DropdownMenuItem>{t("preview.zoom.zoom200")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled
                className="size-6 text-preview-muted hover:bg-preview-surface hover:text-preview-foreground"
                aria-label={t("preview.action.toggleFullscreen")}
              >
                <Maximize2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("preview.action.fullscreen")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
