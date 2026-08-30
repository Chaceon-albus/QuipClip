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
import { getMediaSourceIdentity, useMediaStore } from "@/features/media";
import { createVideoRefCallback, usePlaybackStore } from "@/features/playback";
import {
  calculateFrameFromCurrentTime,
  calculateFrameFromMediaTime,
  createSourceLifecycleGuard,
  formatDisplayTimecode,
  formatTotalTimecode,
} from "./previewFrame";

export function PreviewPane() {
  const { t } = useTranslation();
  const { status, media, error } = useMediaStore();

  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const playbackError = usePlaybackStore((s) => s.error);
  const attach = usePlaybackStore((s) => s.attach);
  const detach = usePlaybackStore((s) => s.detach);
  const syncReady = usePlaybackStore((s) => s.syncReady);
  const syncUnready = usePlaybackStore((s) => s.syncUnready);
  const syncRenderedFrame = usePlaybackStore((s) => s.syncRenderedFrame);
  const syncPlay = usePlaybackStore((s) => s.syncPlay);
  const syncPause = usePlaybackStore((s) => s.syncPause);
  const syncEnded = usePlaybackStore((s) => s.syncEnded);
  const resetPlayback = usePlaybackStore((s) => s.reset);

  const sourceIdentity = getMediaSourceIdentity(media);
  const [prevSourceIdentity, setPrevSourceIdentity] = useState(sourceIdentity);
  const [videoError, setVideoError] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [sourceGuard] = useState(() => createSourceLifecycleGuard());

  // Reset decode error state synchronously when source identity changes
  if (prevSourceIdentity !== sourceIdentity) {
    setPrevSourceIdentity(sourceIdentity);
    setVideoError(false);
  }

  // Reset playback store if media disappears
  useEffect(() => {
    if (!media) {
      resetPlayback();
    }
  }, [media, resetPlayback]);

  // Synchronously activate / deactivate source identity before browser paint (ADR-003)
  useLayoutEffect(() => {
    sourceGuard.activate(sourceIdentity);
    return () => {
      sourceGuard.deactivate(sourceIdentity);
    };
  }, [sourceIdentity, sourceGuard]);

  const mediaPath = media?.path;
  const mediaSize = media?.size;
  const mediaMtime = media?.mtime;
  const avgFrameRateN = media?.probe.avgFrameRate.n;
  const avgFrameRateD = media?.probe.avgFrameRate.d;
  const frameCount = media?.probe.frameCount;

  // Stable ref callback for registering and unregistering video element in playback store with exact ownership
  const videoRefCallback = useMemo(
    () =>
      createVideoRefCallback<HTMLVideoElement>({
        videoRef,
        getSource: () =>
          mediaPath !== undefined &&
          mediaSize !== undefined &&
          mediaMtime !== undefined &&
          avgFrameRateN !== undefined &&
          avgFrameRateD !== undefined &&
          frameCount !== undefined
            ? {
                path: mediaPath,
                size: mediaSize,
                mtime: mediaMtime,
                avgFrameRate: { n: avgFrameRateN, d: avgFrameRateD },
                frameCount,
              }
            : null,
        attach,
        detach,
      }),
    [
      mediaPath,
      mediaSize,
      mediaMtime,
      avgFrameRateN,
      avgFrameRateD,
      frameCount,
      attach,
      detach,
    ],
  );

  // Register requestVideoFrameCallback lifecycle loop (ADR-003)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !media || videoError) {
      return;
    }

    const expectedSourceId = sourceIdentity;
    let cancelled = false;
    let handle: number | null = null;

    const hasRvfc =
      "requestVideoFrameCallback" in video &&
      typeof (
        video as HTMLVideoElement & {
          requestVideoFrameCallback?: (
            callback: (
              now: DOMHighResTimeStamp,
              metadata: { mediaTime: number },
            ) => void,
          ) => number;
          cancelVideoFrameCallback?: (handle: number) => void;
        }
      ).requestVideoFrameCallback === "function";

    if (hasRvfc) {
      const onFrame = (_now: DOMHighResTimeStamp, metadata: { mediaTime: number }) => {
        // Guard against late callbacks from unmounted or replaced sources
        if (cancelled || !sourceGuard.isActive(expectedSourceId)) {
          return;
        }

        const frame = calculateFrameFromMediaTime(
          metadata.mediaTime,
          media.probe.startTime,
          media.probe.avgFrameRate,
          media.probe.frameCount,
        );
        syncRenderedFrame(expectedSourceId, frame, video);

        // Re-register the one-shot callback while the video remains active
        const videoElement = video as HTMLVideoElement & {
          requestVideoFrameCallback: (
            callback: (
              now: DOMHighResTimeStamp,
              metadata: { mediaTime: number },
            ) => void,
          ) => number;
        };
        handle = videoElement.requestVideoFrameCallback(onFrame);
      };

      const videoElement = video as HTMLVideoElement & {
        requestVideoFrameCallback: (
          callback: (now: DOMHighResTimeStamp, metadata: { mediaTime: number }) => void,
        ) => number;
      };
      handle = videoElement.requestVideoFrameCallback(onFrame);
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
  }, [sourceIdentity, media, videoError, sourceGuard, syncRenderedFrame]);

  const supportsRvfc =
    typeof HTMLVideoElement !== "undefined" &&
    "requestVideoFrameCallback" in HTMLVideoElement.prototype;

  // Fallback handler used strictly when requestVideoFrameCallback is unsupported
  const handleTimeUpdateFallback = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!sourceGuard.isActive(sourceIdentity) || !media) {
      return;
    }
    if (!supportsRvfc) {
      const frame = calculateFrameFromCurrentTime(
        e.currentTarget.currentTime,
        media.probe.avgFrameRate,
        media.probe.frameCount,
      );
      syncRenderedFrame(sourceIdentity, frame, e.currentTarget);
    }
  };

  const handleVideoError = () => {
    if (!sourceGuard.isActive(sourceIdentity)) {
      return;
    }
    setVideoError(true);
  };

  // Compute timecodes: total is exclusive frameCount, display is clamped [0, frameCount - 1]
  const totalTimecode = media
    ? formatTotalTimecode(media.probe.frameCount, media.probe.avgFrameRate)
    : "00:00:00:00";

  const currentTimecode = media
    ? formatDisplayTimecode(currentFrame, media.probe.avgFrameRate)
    : "00:00:00:00";

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
                  key={sourceIdentity}
                  playsInline
                  preload="metadata"
                  src={convertFileSrc(media.path)}
                  aria-label={t("preview.videoPlayerLabel", {
                    fileName: media.fileName,
                  })}
                  className="h-full w-full object-contain"
                  onPlay={(e) => {
                    if (sourceGuard.isActive(sourceIdentity)) {
                      syncPlay(sourceIdentity, e.currentTarget);
                    }
                  }}
                  onPause={(e) => {
                    if (sourceGuard.isActive(sourceIdentity)) {
                      syncPause(sourceIdentity, e.currentTarget);
                    }
                  }}
                  onEnded={(e) => {
                    if (sourceGuard.isActive(sourceIdentity)) {
                      syncEnded(sourceIdentity, e.currentTarget);
                    }
                  }}
                  onTimeUpdate={handleTimeUpdateFallback}
                  onSeeked={handleTimeUpdateFallback}
                  onLoadedMetadata={(e) => {
                    if (sourceGuard.isActive(sourceIdentity)) {
                      syncReady(sourceIdentity, e.currentTarget);
                      handleTimeUpdateFallback(e);
                    }
                  }}
                  onError={(e) => {
                    if (sourceGuard.isActive(sourceIdentity)) {
                      syncUnready(sourceIdentity, e.currentTarget);
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
          <span className="font-medium text-primary">{currentTimecode}</span>
          <span className="text-preview-muted">/</span>
          <span className="text-preview-muted">{totalTimecode}</span>
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
