import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AlertCircle, Film, Loader2 } from "lucide-react";
import { SHORT_STATE_INDICATOR_DELAY_MS } from "@/components/common/delayedIndicator";
import { useDelayedVisibility } from "@/components/common/useDelayedIndicator";
import { useOpenMediaAction } from "@/components/common/useOpenMediaAction";
import { useShortcutLabels } from "@/components/common/useShortcutLabels";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  resolveTimecodeDisplay,
  scrubAudioController,
  usePlaybackStore,
  type PlaybackSource,
} from "@/features/playback";
import { usePreviewMutePreference } from "@/features/settings/previewMutePreference";
import { useTimecodePreference } from "@/features/settings/timecodePreference";
import {
  FRAME_TIMECODE_PLACEHOLDER,
  MILLISECONDS_TIMECODE_PLACEHOLDER,
  type TimecodeDisplay,
} from "@/lib/timecode";
import { isMacOS, isWindows } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { Pts, Rational } from "@/types/project";
import {
  PICTURE_CHECK_INTERVAL_MS,
  presentDecodeFailure,
  resolvePictureCheck,
  type DecodeFailureReason,
  type DecodeFailureTrigger,
  type PictureCheckEvent,
  type PictureCheckState,
  type PreviewPlatform,
} from "./decodeFailure";
import {
  createAnchorWaitController,
  followDeferredNavigation,
  reportAnchorWaitExpired,
} from "./anchorWait";
import { formatSupportedVideoFormats } from "./previewEmptyState";
import { PreviewBufferingIndicator } from "./PreviewBufferingIndicator";
import {
  ImportErrorBanner,
  ImportErrorEmptyState,
  PlaybackErrorBanner,
} from "./PreviewNotices";
import {
  createSourceLifecycleGuard,
  formatPreviewCurrentTime,
  formatPreviewTotalDuration,
  showsApproximateBadge,
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
  dismissError: dismissPlaybackError,
} = playbackStore.getState();

// The media store actions never change either.
const { dismissError: dismissImportError } = mediaStore.getState();

// The format names in the empty state come from the list the file dialog filters on, so the
// two cannot disagree.
const SUPPORTED_VIDEO_FORMATS = formatSupportedVideoFormats(VIDEO_FILE_EXTENSIONS);

/** The platform of the web view, for the hint of the decode-failure panel. */
function currentPlatform(): PreviewPlatform {
  if (isWindows()) {
    return "windows";
  }
  if (isMacOS()) {
    return "macos";
  }
  return "other";
}

/** The picture check of one mounted video element (see `resolvePictureCheck`). */
interface PictureCheck {
  readonly element: HTMLVideoElement;
  readonly state: PictureCheckState;
  /** The current wait for a picture, while the check is pending. */
  readonly timer: number | null;
  /** `performance.now()` when the check started to wait, or null before the first wait. */
  readonly waitStartedAt: number | null;
}

/** Stops the wait of a picture check, so that its timer can no longer act. */
function stopPictureCheckTimer(check: PictureCheck | null): void {
  if (check !== null && check.timer !== null) {
    window.clearTimeout(check.timer);
  }
}

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
 * Marks the current timecode as approximate. It is a small `≈` badge before the value, and
 * its tooltip gives the same explanation as the status bar's approximate-position chip. The
 * badge can take the focus, so a keyboard user can open the tooltip, and its accessible
 * name is the chip's label, because a screen reader would read the symbol alone as a
 * relation.
 *
 * The preview section is always dark, so the `-text` token resolves to its dark value here.
 */
function ApproximateBadge() {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="mr-1.5 rounded-sm bg-warning/15 px-1 text-2xs text-warning-text focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span aria-hidden="true">≈</span>
          <span className="sr-only">{t("statusBar.approximatePosition")}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-md flex-col items-start gap-1 text-xs">
        <p>{t("statusBar.approximatePositionDetail")}</p>
        <p>{t("statusBar.approximatePositionMarks")}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Current preview timecode. It subscribes to `presentedFrame` and to the approximate clock on
 * its own, so the surrounding pane, and with it the `<video>` element, does not re-render once
 * for every presented video frame or every `timeupdate`.
 */
function PreviewTimecode({
  videoStartPts,
  videoTimeBase,
  display,
  decodeFailed,
}: {
  videoStartPts: Pts | null;
  videoTimeBase: Rational;
  display: TimecodeDisplay;
  decodeFailed: boolean;
}) {
  const presentedFrame = usePlaybackStore((s) => s.presentedFrame);
  const calibrationStatus = usePlaybackStore((s) => s.calibrationStatus);
  const approximateBrowserTimeSeconds = usePlaybackStore(
    (s) => s.approximateBrowserTimeSeconds,
  );
  const seekTargetSeconds = usePlaybackStore((s) => s.seekTargetSeconds);

  // The seek target first, then the source-relative time of a ready inferred PTS, then the
  // approximate browser time (ADR 022), in the format of the source (ADR 028).
  const currentTimeDisplay = formatPreviewCurrentTime(
    presentedFrame,
    calibrationStatus,
    videoStartPts,
    videoTimeBase,
    approximateBrowserTimeSeconds ?? 0,
    seekTargetSeconds,
    display,
  );

  return (
    <>
      {showsApproximateBadge(calibrationStatus, decodeFailed) && <ApproximateBadge />}
      <span className="text-primary">{currentTimeDisplay}</span>
    </>
  );
}

/** The tags of the decode-failure reason messages. `<mono>` wraps a technical value. */
const REASON_COMPONENTS = {
  mono: <span className="font-mono text-preview-foreground" />,
};

/**
 * The reason line of the decode-failure panel.
 *
 * `Trans` types its values from the key. For a union of keys it requires the placeholders of
 * every member, so each case narrows the reason to one placeholder shape and its values.
 */
function DecodeFailureReasonText({ reason }: { reason: DecodeFailureReason }) {
  const { t } = useTranslation();
  switch (reason.shape) {
    case "full":
      return (
        <Trans
          t={t}
          i18nKey={reason.key}
          values={reason.values}
          components={REASON_COMPONENTS}
        />
      );
    case "noProfile":
      return (
        <Trans
          t={t}
          i18nKey={reason.key}
          values={reason.values}
          components={REASON_COMPONENTS}
        />
      );
    case "noPixelFormat":
      return (
        <Trans
          t={t}
          i18nKey={reason.key}
          values={reason.values}
          components={REASON_COMPONENTS}
        />
      );
    case "codecOnly":
      return (
        <Trans
          t={t}
          i18nKey={reason.key}
          values={reason.values}
          components={REASON_COMPONENTS}
        />
      );
    case "container":
      return (
        <Trans
          t={t}
          i18nKey={reason.key}
          values={reason.values}
          components={REASON_COMPONENTS}
        />
      );
    case "plain":
      return t(reason.key);
  }
}

export function PreviewPane() {
  const { t } = useTranslation();
  const status = useMediaStore((s) => s.status);
  const media = useMediaStore((s) => s.media);
  const error = useMediaStore((s) => s.error);
  // The loading indicators show only after a load has lasted SHORT_STATE_INDICATOR_DELAY_MS,
  // so a fast open shows no flash.
  const showLoading = useDelayedVisibility(
    status === "loading",
    SHORT_STATE_INDICATOR_DELAY_MS,
  );
  const openMedia = useOpenMediaAction();
  // The Open button performs the Open Media action, so it declares the same key (ADR 026).
  const shortcutOf = useShortcutLabels();
  const openMediaShortcut = shortcutOf("openMedia");

  const playbackError = usePlaybackStore((s) => s.error);
  const calibrationStatus = usePlaybackStore((s) => s.calibrationStatus);
  const attachedSourceRevisionKey = usePlaybackStore(
    (s) => s.attachedSourceRevisionKey,
  );

  // The mute toggle of the transport bar. Both media elements take it as the `muted`
  // property, which React sets when it creates the node, so a stored value applies before the
  // first play. It changes only what the user hears: the elements still seek, play and report
  // their events, so the calibration, the seeks and the cue of ADR 019 run as before.
  const isMuted = usePreviewMutePreference((s) => s.muted);

  const sourceRevisionKey = getSourceRevisionKey(media);
  const [previousMedia, setPreviousMedia] = useState(media);
  // What made the web view fail to play the source, or null while it plays: the element
  // fired `error`, or the picture check found no picture. The pane then shows the
  // decode-failure panel in place of the element.
  const [failureTrigger, setFailureTrigger] = useState<DecodeFailureTrigger | null>(
    null,
  );
  const decodeFailed = failureTrigger !== null;

  const videoRef = useRef<HTMLVideoElement | null>(null);

  // The focus target when a notice that held the focus leaves: the user closed it, or the
  // store removed it. The section holds the notices, so the focus stays where the user was,
  // and the next Tab goes on from the preview. The section is not a control, so it does not
  // own a key: Space and the other window shortcuts keep working.
  const sectionRef = useRef<HTMLElement | null>(null);
  const returnFocusToPreview = useCallback(() => {
    sectionRef.current?.focus({ preventScroll: true });
  }, []);
  const [sourceGuard] = useState(() => createSourceLifecycleGuard());

  // The bounded wait for the calibration anchor while a navigation waits for it (see
  // `anchorWait.ts`). It runs only while the store reports a deferred navigation. When a visible
  // element presents no frame for the whole wait, the pane reports that frame callbacks are not
  // available, so the calibration leaves `calibrating` and the navigation runs on the
  // approximate path. With nothing deferred, the calibration stays open until a frame comes.
  const [anchorWait] = useState(() =>
    createAnchorWaitController<HTMLVideoElement>(
      {
        setTimer: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
        clearTimer: (handle) => window.clearTimeout(handle),
      },
      (element) => {
        reportAnchorWaitExpired(playbackStore, element, (key) =>
          sourceGuard.isActive(key),
        );
      },
    ),
  );

  // The wait follows the deferred navigation of the store, and it counts only while the
  // document is visible, because a hidden window presents no frames.
  useEffect(() => {
    const isVisible = () => document.visibilityState !== "hidden";
    const stopFollowing = followDeferredNavigation(
      playbackStore,
      anchorWait,
      () => videoRef.current,
      isVisible,
    );
    const onVisibilityChange = () => {
      anchorWait.visibility(isVisible());
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopFollowing();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      anchorWait.disarm();
    };
  }, [anchorWait]);

  // The approximate clock needs no render-phase reset here. `attach` and `detach` null the
  // store field, which also covers an element replaced without a media change.

  // Clear a decode failure for every new media object, including a re-import of the same
  // file, which keeps its revision key. Otherwise the import reports success and the pane keeps
  // the decode-failure panel.
  if (previousMedia !== media) {
    setPreviousMedia(media);
    setFailureTrigger(null);
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
  const mediaProbe = media?.probe;
  const mediaFileName = media?.fileName;

  // What the decode-failure panel says about this source and its trigger.
  const decodeFailure = useMemo(
    () =>
      failureTrigger === null || mediaProbe === undefined || mediaFileName === undefined
        ? null
        : presentDecodeFailure({
            probe: mediaProbe,
            fileName: mediaFileName,
            trigger: failureTrigger,
            platform: currentPlatform(),
          }),
    [failureTrigger, mediaProbe, mediaFileName],
  );

  // The picture check of the mounted video element. The ref callback clears it when the
  // element leaves the tree: on a source change, on the decode-failure panel, and on unmount.
  const pictureCheckRef = useRef<PictureCheck | null>(null);
  // The picture check runner of the latest render. The frame callback loop and the wait
  // timer outlive the render that started them, so they call the runner through this ref.
  const runPictureCheckRef = useRef<
    ((element: HTMLVideoElement, event: PictureCheckEvent) => void) | null
  >(null);

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
  const videoRefCallback = useCallback(
    (element: HTMLVideoElement | null) => {
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
      if (element === null) {
        // A removed element ends its picture check and its wait for the anchor, so a pending
        // wait cannot act on it.
        stopPictureCheckTimer(pictureCheckRef.current);
        pictureCheckRef.current = null;
        anchorWait.disarm();
      }
    },
    [anchorWait],
  );

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
    if (!video || !media || decodeFailed) {
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

        // A presented frame proves a picture. A pending picture check takes the ready path
        // before the store sees the frame, so the calibration anchor is checked against the
        // position that `syncReady` reads, not the one saved at attach (ADR 003).
        if (pictureCheckRef.current?.state === "pending") {
          runPictureCheckRef.current?.(video, { type: "frame" });
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
  }, [sourceRevisionKey, media, decodeFailed, sourceGuard]);

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!sourceGuard.isActive(sourceRevisionKey) || !media) {
      return;
    }
    syncBrowserTime(sourceRevisionKey, e.currentTarget);
  };

  // An `error` event and a failed picture check take the same path. The element leaves the
  // tree on the next render, and its ref callback detaches it from the playback store.
  const handleDecodeFailure = (
    element: HTMLVideoElement,
    trigger: DecodeFailureTrigger,
  ) => {
    if (!sourceGuard.isActive(sourceRevisionKey)) {
      return;
    }
    const check = pictureCheckRef.current;
    if (check !== null) {
      stopPictureCheckTimer(check);
      pictureCheckRef.current = { ...check, state: "failed", timer: null };
    }
    syncUnready(sourceRevisionKey, element);
    setFailureTrigger(trigger);
  };

  // The ready path of a loaded element. `loadedmetadata` takes it at once when the element
  // reports a picture size. Otherwise the picture check takes it when a size arrives.
  const takeReadyPath = (element: HTMLVideoElement) => {
    if (!sourceGuard.isActive(sourceRevisionKey)) {
      return;
    }
    syncReady(sourceRevisionKey, element);
    syncBrowserDuration(sourceRevisionKey, element);
    syncBrowserTime(sourceRevisionKey, element);
  };

  // Feeds an element event, or the end of a wait, to the picture check, and performs the
  // action that `resolvePictureCheck` returns.
  const runPictureCheck = (element: HTMLVideoElement, event: PictureCheckEvent) => {
    if (!sourceGuard.isActive(sourceRevisionKey)) {
      return;
    }
    let check = pictureCheckRef.current;
    if (check === null || check.element !== element) {
      // Only `loadedmetadata` starts the check of an element. A later event of an element
      // without a check, such as a late event of a replaced element, does nothing.
      if (event.type !== "loadedMetadata") {
        return;
      }
      stopPictureCheckTimer(check);
      check = { element, state: "idle", timer: null, waitStartedAt: null };
    }

    const result = resolvePictureCheck(check.state, event);
    if (result.action === "none") {
      if (result.state !== check.state || pictureCheckRef.current !== check) {
        pictureCheckRef.current = { ...check, state: result.state };
      }
      return;
    }
    stopPictureCheckTimer(check);

    if (result.action === "wait") {
      // A new `loadedmetadata` starts the total wait again. A repeated wait keeps its start.
      const waitStartedAt =
        event.type === "loadedMetadata" || check.waitStartedAt === null
          ? performance.now()
          : check.waitStartedAt;
      const timer = window.setTimeout(() => {
        const current = pictureCheckRef.current;
        // A replaced or removed element, or a newer wait, owns the record now.
        if (
          current === null ||
          current.element !== element ||
          current.timer !== timer
        ) {
          return;
        }
        pictureCheckRef.current = { ...current, timer: null };
        runPictureCheckRef.current?.(element, {
          type: "timeout",
          videoWidth: element.videoWidth,
          readyState: element.readyState,
          elapsedMs: performance.now() - waitStartedAt,
        });
      }, PICTURE_CHECK_INTERVAL_MS);
      pictureCheckRef.current = { element, state: result.state, timer, waitStartedAt };
      return;
    }

    pictureCheckRef.current = {
      element,
      state: result.state,
      timer: null,
      waitStartedAt: check.waitStartedAt,
    };
    if (result.action === "ready") {
      takeReadyPath(element);
    } else {
      handleDecodeFailure(element, { kind: "pictureMissing" });
    }
  };

  // Publish the runner of this render for the frame callback loop and the wait timer.
  useLayoutEffect(() => {
    runPictureCheckRef.current = runPictureCheck;
  });

  // The format of the open source: the user's preference, with milliseconds for a source
  // without a single nominal rate (ADR 028). With no source, the placeholder follows the
  // preference alone.
  const timecodePreference = useTimecodePreference((s) => s.format);
  const probe = media?.probe;
  const timecodeDisplay = useMemo(
    () => resolveTimecodeDisplay(timecodePreference, probe),
    [timecodePreference, probe],
  );
  const noMediaPlaceholder =
    timecodePreference === "frames"
      ? FRAME_TIMECODE_PLACEHOLDER
      : MILLISECONDS_TIMECODE_PLACEHOLDER;

  const totalTimeDisplay = media
    ? formatPreviewTotalDuration(
        media.probe.approximateDurationSeconds,
        media.probe.videoDurationTicks,
        media.probe.videoTimeBase,
        timecodeDisplay,
      )
    : noMediaPlaceholder;

  // The preview stays dark in both themes. The `dark` class makes every theme token and
  // every `dark:` variant inside the section use the dark value, so text, controls and the
  // styled scrollbars keep their contrast on the dark surface in the light theme.
  // `scheme-dark` gives native widgets, such as a future `<video controls>`, the dark color
  // scheme. Tooltips and menus render in a portal under <body>, so they keep the app theme.
  // `tabIndex={-1}` lets `returnFocusToPreview` focus the section without a Tab stop, and
  // `outline-none` hides a ring there, because the focus lands on no control. The label names
  // the section, because a focusable area needs an accessible name.
  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-label={t("preview.regionLabel")}
      className="dark flex min-h-[200px] flex-1 flex-col overflow-hidden bg-preview-background p-3 text-preview-foreground scheme-dark outline-none select-none"
    >
      {/* 16:9 Video Canvas Surface */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {/* The frame takes a dashed border while it is empty, so it reads as a placeholder. */}
        <div
          className={cn(
            "relative flex aspect-video h-full max-h-full w-auto max-w-full items-center justify-center overflow-hidden rounded-lg border border-preview-border bg-preview-surface shadow-xs",
            !media && (status === "idle" || status === "error") && "border-dashed",
          )}
        >
          {media ? (
            <>
              {/* Loaded Video Surface: Preserved during replacements or error states */}
              {decodeFailed ? (
                /* Decode-failure panel: what the system player cannot decode, the step
                   that can make the file play, and the Open Media action for another file.
                   The panel scrolls when the preview is too small to hold it. */
                <div
                  className="flex max-h-full max-w-md flex-col items-center gap-2 overflow-y-auto p-4 text-center"
                  aria-live="polite"
                >
                  <AlertCircle
                    aria-hidden="true"
                    className="size-6 shrink-0 text-warning"
                  />
                  <h2 className="text-sm font-medium text-preview-foreground">
                    {t("preview.decodeFailure.title")}
                  </h2>
                  {decodeFailure && (
                    <div className="flex flex-col gap-1 text-xs text-preview-muted">
                      {/* The values are identifiers a user can copy into a search. */}
                      <p className="select-text">
                        <DecodeFailureReasonText reason={decodeFailure.reason} />
                      </p>
                      {decodeFailure.hintKey !== null && (
                        <p>{t(decodeFailure.hintKey)}</p>
                      )}
                    </div>
                  )}
                  <Button
                    className="mt-1"
                    onClick={openMedia}
                    aria-keyshortcuts={openMediaShortcut?.aria}
                  >
                    {t("preview.decodeFailure.openAnother")}
                  </Button>
                </div>
              ) : (
                <video
                  ref={videoRefCallback}
                  key={sourceRevisionKey}
                  playsInline
                  muted={isMuted}
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
                    // A zero picture width here is only a suspicion. The picture check
                    // holds the ready path until a size arrives, or it reports a failure.
                    runPictureCheck(e.currentTarget, {
                      type: "loadedMetadata",
                      videoWidth: e.currentTarget.videoWidth,
                      probeWidth: media.probe.width,
                    });
                  }}
                  onResize={(e) => {
                    runPictureCheck(e.currentTarget, {
                      type: "resize",
                      videoWidth: e.currentTarget.videoWidth,
                    });
                  }}
                  onError={(e) => {
                    handleDecodeFailure(e.currentTarget, {
                      kind: "mediaError",
                      code: e.currentTarget.error?.code ?? null,
                    });
                  }}
                />
              )}

              {/* Hidden audio element for scrub bursts on frame step (ADR 019).
                  Gated on:
                  1. media.probe.audio: null when the source has no audio stream. Mount nothing then.
                  2. !decodeFailed: web view could not decode the source. Mount nothing then.
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
                !decodeFailed &&
                attachedSourceRevisionKey === sourceRevisionKey &&
                calibrationStatus !== "calibrating" && (
                  <audio
                    ref={scrubAudioRefCallback}
                    key={`scrub-${sourceRevisionKey}`}
                    muted={isMuted}
                    preload="auto"
                    src={videoSrc}
                    aria-hidden="true"
                    className="hidden"
                  />
                )}

              {/* The buffering spinner, in the bottom-right corner, clear of the notices.
                  Keyed on the source, so a source change starts it again. */}
              {!decodeFailed && (
                <PreviewBufferingIndicator
                  key={`buffering-${sourceRevisionKey}`}
                  videoRef={videoRef}
                />
              )}

              {/* The notification area. The notices stack from the top, so a loading
                  chip, an import error and a playback error never cover each other. The
                  area lets the pointer through, and each notice takes it back. */}
              <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-col gap-2">
                {showLoading && (
                  <div
                    className="pointer-events-auto flex items-center gap-2 self-start rounded-md border border-border/80 bg-background/90 px-2.5 py-1 text-xs text-foreground shadow-md backdrop-blur-xs"
                    aria-live="polite"
                  >
                    <Loader2 className="size-3.5 animate-spin text-primary" />
                    <span>{t("preview.loading")}</span>
                  </div>
                )}
                {status === "error" && error && (
                  <ImportErrorBanner
                    error={error}
                    onDismiss={dismissImportError}
                    onReturnFocus={returnFocusToPreview}
                  />
                )}
                {playbackError && !decodeFailed && (
                  <PlaybackErrorBanner
                    key={playbackError}
                    code={playbackError}
                    onDismiss={dismissPlaybackError}
                    onReturnFocus={returnFocusToPreview}
                  />
                )}
              </div>
            </>
          ) : (
            /* Full Empty / Loading / Error State when no media is loaded */
            <>
              {showLoading && (
                <div
                  className="flex flex-col items-center justify-center gap-2 text-xs text-preview-muted"
                  aria-live="polite"
                >
                  <Loader2 className="size-6 animate-spin text-primary" />
                  <span>{t("preview.loading")}</span>
                </div>
              )}

              {/* An import that failed with no video open: what failed, what to do, and
                  the actions, in the layout of the empty state. */}
              {status === "error" && error && <ImportErrorEmptyState error={error} />}

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
                  <Button
                    onClick={openMedia}
                    aria-keyshortcuts={openMediaShortcut?.aria}
                  >
                    {t("preview.empty.openVideo")}
                  </Button>
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
          frame above keeps its size. Tabular figures keep every digit the same width, so
          the value does not shift while it counts. With no media, both values are
          placeholders in the muted colour, because no time is known. */}
      <div className="flex shrink-0 items-center justify-between px-1 pt-2">
        <div className="flex h-6 items-center font-mono text-[15px] leading-none font-medium tracking-tight tabular-nums">
          {media ? (
            <PreviewTimecode
              videoStartPts={media.probe.videoStartPts}
              videoTimeBase={media.probe.videoTimeBase}
              display={timecodeDisplay}
              decodeFailed={decodeFailed}
            />
          ) : (
            <span className="text-preview-muted">{noMediaPlaceholder}</span>
          )}
          <span className="mx-1 text-preview-muted/60">/</span>
          <span className="text-preview-muted">{totalTimeDisplay}</span>
        </div>
      </div>
    </section>
  );
}
