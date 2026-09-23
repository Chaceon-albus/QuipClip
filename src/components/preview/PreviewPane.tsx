import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AlertCircle, Film, Loader2 } from "lucide-react";
import { useOpenMediaAction } from "@/components/common/useOpenMediaAction";
import { Button } from "@/components/ui/button";
import {
  getSourceRevisionKey,
  mediaStore,
  useMediaStore,
  VIDEO_FILE_EXTENSIONS,
  type ImportMediaResult,
} from "@/features/media";
import {
  createVideoRefCallback,
  playbackStore,
  scrubAudioController,
  usePlaybackStore,
  type PlaybackSource,
} from "@/features/playback";
import { cn } from "@/lib/utils";
import type { Pts, Rational } from "@/types/project";
import { formatSupportedVideoFormats } from "./previewEmptyState";
import {
  createSourceLifecycleGuard,
  formatPreviewCurrentTime,
  formatPreviewTotalDuration,
  isPreviewTimeApproximate,
} from "./previewFrame";

// The playback store actions never change, so they are read once instead of through a
// subscription for each one.
const {
  syncReady,
  syncUnready,
  syncPresentedFrame,
  syncPresentationUnavailable,
  syncBrowserDuration,
  syncBrowserTime,
  syncSeeked,
  syncPlay,
  syncPause,
  syncEnded,
  reset: resetPlayback,
} = playbackStore.getState();

// The format names in the empty state come from the list the file dialog filters on, so the
// two cannot disagree.
const SUPPORTED_VIDEO_FORMATS = formatSupportedVideoFormats(VIDEO_FILE_EXTENSIONS);

/**
 * Builds the timing descriptor the playback store attaches, or null when no media is open.
 */
function toPlaybackSource(media: ImportMediaResult | null): PlaybackSource | null {
  if (!media) {
    return null;
  }
  return {
    path: media.path,
    size: media.size,
    mtime: media.mtime,
    videoTimeBase: media.probe.videoTimeBase,
    videoStartPts: media.probe.videoStartPts,
    videoDurationTicks: media.probe.videoDurationTicks,
    approximateDurationSeconds: media.probe.approximateDurationSeconds,
    avgFrameRate: media.probe.avgFrameRate,
    rFrameRate: media.probe.rFrameRate,
    reportedFrameCount: media.probe.reportedFrameCount,
  };
}

/**
 * Current preview timecode. It subscribes to `presentedFrame` and to the approximate clock on
 * its own, so the surrounding pane, and with it the `<video>` element, does not re-render once
 * for every presented video frame or every `timeupdate`.
 */
function PreviewTimecode({
  videoStartPts,
  videoTimeBase,
}: {
  videoStartPts: Pts | null;
  videoTimeBase: Rational;
}) {
  const { t } = useTranslation();
  const presentedFrame = usePlaybackStore((s) => s.presentedFrame);
  const calibrationStatus = usePlaybackStore((s) => s.calibrationStatus);
  const approximateBrowserTimeSeconds = usePlaybackStore(
    (s) => s.approximateBrowserTimeSeconds,
  );
  const seekTargetSeconds = usePlaybackStore((s) => s.seekTargetSeconds);

  // Source-relative HH:MM:SS.mmm for a ready inferred PTS, approximate browser time otherwise
  const currentTimeDisplay = formatPreviewCurrentTime(
    presentedFrame,
    calibrationStatus,
    videoStartPts,
    videoTimeBase,
    approximateBrowserTimeSeconds ?? 0,
    seekTargetSeconds,
  );

  return (
    <>
      <span className="font-medium text-primary">{currentTimeDisplay}</span>
      {isPreviewTimeApproximate(calibrationStatus) && (
        <span className="text-preview-muted">{t("preview.approximate")}</span>
      )}
    </>
  );
}

export function PreviewPane() {
  const { t } = useTranslation();
  const status = useMediaStore((s) => s.status);
  const media = useMediaStore((s) => s.media);
  const error = useMediaStore((s) => s.error);
  const openMedia = useOpenMediaAction();

  const playbackError = usePlaybackStore((s) => s.error);
  const calibrationStatus = usePlaybackStore((s) => s.calibrationStatus);
  const attachedSourceRevisionKey = usePlaybackStore(
    (s) => s.attachedSourceRevisionKey,
  );

  const sourceRevisionKey = getSourceRevisionKey(media);
  const [previousMedia, setPreviousMedia] = useState(media);
  const [videoError, setVideoError] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [sourceGuard] = useState(() => createSourceLifecycleGuard());

  // The approximate clock needs no render-phase reset here. `attach` and `detach` null the
  // store field, which also covers an element replaced without a media change.

  // Clear a decode error for every new media object, including a re-import of the same file,
  // which keeps its revision key. Otherwise the import reports success and the pane keeps the
  // decode-error panel.
  if (previousMedia !== media) {
    setPreviousMedia(media);
    setVideoError(false);
  }

  // Reset playback store if media disappears
  useEffect(() => {
    if (!media) {
      resetPlayback();
    }
  }, [media]);

  // Synchronously activate / deactivate source identity before browser paint (ADR 003)
  useLayoutEffect(() => {
    sourceGuard.activate(sourceRevisionKey);
    return () => {
      sourceGuard.deactivate(sourceRevisionKey);
    };
  }, [sourceRevisionKey, sourceGuard]);

  const mediaPath = media?.path;

  const videoSrc = useMemo(
    () => (mediaPath === undefined ? undefined : convertFileSrc(mediaPath)),
    [mediaPath],
  );

  // Registers and unregisters the video element in the playback store with exact ownership.
  //
  // The callback identity must stay stable for the whole life of the component. It must not
  // follow the media object: a re-import of the file that is already open builds a new media
  // object with the same revision key, so React would detach and re-attach the same element
  // against the same node, and the store would re-anchor calibration at the position that
  // element had already reached (ADR 003). Mark In would then write a wrong PTS while the
  // store still reports `ready`. The source and the store actions are therefore read when the
  // callback runs, not captured when it is built.
  const ownerRef = useRef<((element: HTMLVideoElement | null) => void) | null>(null);

  // The owner is built on the first invocation, which React makes while it attaches the node.
  // Do not move this factory into useMemo: a useMemo body is inlined into render, so the
  // accessors below would count as a ref reaching a function during render and
  // `react-hooks/refs` would reject it. A useCallback body runs only when React invokes the
  // callback, which is also the only time the accessors read or write videoRef.current.
  const videoRefCallback = useCallback((element: HTMLVideoElement | null) => {
    ownerRef.current ??= createVideoRefCallback<HTMLVideoElement>({
      getElement: () => videoRef.current,
      setElement: (node) => {
        videoRef.current = node;
      },
      getSource: () => toPlaybackSource(mediaStore.getState().media),
      attach: (source, node) => playbackStore.getState().attach(source, node),
      detach: (sourceRevisionKey, node) =>
        playbackStore.getState().detach(sourceRevisionKey, node),
    });
    ownerRef.current(element);
  }, []);

  // Registers and unregisters the hidden scrub audio element with exact ownership (ADR 019).
  // The callback identity is stable for the life of the component. The closure holds the element
  // it attached, and the controller's own `attached !== element` guard rejects a detach for an
  // element it does not hold.
  const scrubOwnerRef = useRef<((element: HTMLAudioElement | null) => void) | null>(
    null,
  );

  const scrubAudioRefCallback = useCallback((element: HTMLAudioElement | null) => {
    scrubOwnerRef.current ??= (() => {
      let ownedElement: HTMLAudioElement | null = null;
      return (node: HTMLAudioElement | null) => {
        if (node) {
          ownedElement = node;
          scrubAudioController.attach(node);
        } else {
          const elToDetach = ownedElement;
          ownedElement = null;
          if (elToDetach) {
            scrubAudioController.detach(elToDetach);
          }
        }
      };
    })();
    scrubOwnerRef.current(element);
  }, []);

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
  }, [sourceRevisionKey, media, videoError, sourceGuard]);

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!sourceGuard.isActive(sourceRevisionKey) || !media) {
      return;
    }
    syncBrowserTime(sourceRevisionKey, e.currentTarget);
  };

  const handleVideoError = () => {
    if (!sourceGuard.isActive(sourceRevisionKey)) {
      return;
    }
    setVideoError(true);
  };

  const totalTimeDisplay = media
    ? formatPreviewTotalDuration(
        media.probe.approximateDurationSeconds,
        media.probe.videoDurationTicks,
        media.probe.videoTimeBase,
      )
    : "00:00:00.000";

  // The preview stays dark in both themes. The `dark` class makes every theme token and
  // every `dark:` variant inside the section use the dark value, so text, controls and the
  // styled scrollbars keep their contrast on the dark surface in the light theme.
  // `scheme-dark` gives native widgets, such as a future `<video controls>`, the dark color
  // scheme. Tooltips and menus render in a portal under <body>, so they keep the app theme.
  return (
    <section className="dark flex min-h-[200px] flex-1 flex-col overflow-hidden bg-preview-background p-3 text-preview-foreground scheme-dark select-none">
      {/* 16:9 Video Canvas Surface */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {/* The frame takes a dashed border while it is empty, so it reads as a placeholder. */}
        <div
          className={cn(
            "relative flex aspect-video h-full max-h-full w-auto max-w-full items-center justify-center overflow-hidden rounded-lg border border-preview-border bg-preview-surface shadow-xs",
            !media && status === "idle" && "border-dashed",
          )}
        >
          {media ? (
            <>
              {/* Loaded Video Surface: Preserved during replacements or error states */}
              {videoError ? (
                <div
                  className="flex max-w-md flex-col items-center justify-center gap-2 p-4 text-center"
                  aria-live="polite"
                >
                  <AlertCircle className="size-6 shrink-0 text-warning" />
                  <p className="text-xs font-medium text-warning-text">
                    {t("preview.decodeError")}
                  </p>
                </div>
              ) : (
                <video
                  ref={videoRefCallback}
                  key={sourceRevisionKey}
                  playsInline
                  preload="metadata"
                  src={videoSrc}
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
                  onSeeked={(e) => {
                    handleTimeUpdate(e);
                    if (sourceGuard.isActive(sourceRevisionKey)) {
                      syncSeeked(sourceRevisionKey, e.currentTarget);
                    }
                  }}
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

              {/* Hidden audio element for scrub bursts on frame step (ADR 019).
                  Gated on:
                  1. media.probe.audio: null when the source has no audio stream. Mount nothing then.
                  2. !videoError: web view could not decode the source. Mount nothing then.
                  3. attachedSourceRevisionKey === sourceRevisionKey: the identity comparison keeps
                     React from constructing the node at all, React assigns `src` at construction
                     so a fetch would start before insertion, and a boolean such as isAttached
                     cannot serve because the render that first carries a new source still holds
                     the previous source store state.
                  4. calibrationStatus !== "calibrating": keeps the element out until the calibration
                     anchor is taken by the first requestVideoFrameCallback (ADR 003), preventing a
                     competing range request during that window. A source whose calibration resolves
                     straight to "unavailable" mounts at attach time, which is correct because such a
                     source has no anchor to protect. */}
              {media.probe.audio &&
                !videoError &&
                attachedSourceRevisionKey === sourceRevisionKey &&
                calibrationStatus !== "calibrating" && (
                  <audio
                    ref={scrubAudioRefCallback}
                    key={`scrub-${sourceRevisionKey}`}
                    preload="auto"
                    src={videoSrc}
                    aria-hidden="true"
                    className="hidden"
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

              {/* Empty state: it says what to do, offers the File menu's Open Media action,
                  and names the drop on the window as the other way to open a video. */}
              {status === "idle" && (
                <div className="flex flex-col items-center gap-3 p-4 text-center">
                  <div className="grid size-12 place-items-center rounded-xl border border-preview-border bg-preview-background text-preview-muted">
                    <Film className="size-6" />
                  </div>
                  <h2 className="text-sm font-medium text-preview-foreground">
                    {t("preview.empty.title")}
                  </h2>
                  <Button onClick={openMedia}>{t("preview.empty.openVideo")}</Button>
                  <div className="flex flex-col items-center gap-1 text-xs text-preview-muted">
                    <p>{t("preview.empty.dropHint")}</p>
                    <p>{SUPPORTED_VIDEO_FORMATS}</p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Preview Bottom Row: Timecode. `h-6` holds the row at a fixed height, so the video
          frame above keeps its size. */}
      <div className="flex shrink-0 items-center justify-between px-1 pt-2">
        <div className="flex h-6 items-center gap-1.5 font-mono text-xs">
          {media ? (
            <PreviewTimecode
              videoStartPts={media.probe.videoStartPts}
              videoTimeBase={media.probe.videoTimeBase}
            />
          ) : (
            <span className="font-medium text-primary">00:00:00.000</span>
          )}
          <span className="text-preview-muted">/</span>
          <span className="text-preview-muted">{totalTimeDisplay}</span>
        </div>
      </div>
    </section>
  );
}
