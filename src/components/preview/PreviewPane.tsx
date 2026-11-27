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
import { DiagnosticDetails } from "@/components/common/DiagnosticDetails";
import { useDelayedVisibility } from "@/components/common/useDelayedIndicator";
import { useOpenMediaAction } from "@/components/common/useOpenMediaAction";
import { useShortcutLabels } from "@/components/common/useShortcutLabels";
import { Button } from "@/components/ui/button";
import {
  audioOverrideStore,
  getGeneratedSourceId,
  getSourceRevisionKey,
  mediaStore,
  previewAudioStreamOf,
  useAudioOverrides,
  useMediaStore,
  VIDEO_FILE_EXTENSIONS,
  type AudioProbe,
  type AudioStreamOverride,
  type ImportMediaResult,
  type MediaStoreState,
} from "@/features/media";
import { useWaveformStore, type WaveformStoreState } from "@/features/waveform";
import { waveformController } from "@/features/waveform/instance";
import {
  attachedMediaStore,
  useAttachedMediaStore,
} from "@/features/sequence/attachedMedia";
import { useSequenceMediaStore } from "@/features/sequence/media";
import { sequencePlayback } from "@/features/sequence/playback";
import { timelineStore, useTimelineStore } from "@/features/timeline";
import {
  clearScrubCue,
  createVideoRefCallback,
  playbackStore,
  resolveTimecodeDisplay,
  scrubAudioController,
  setScrubCue,
  usePlaybackStore,
  type PlaybackSource,
} from "@/features/playback";
import {
  CHROMIUM_SEEK_TAIL_SECONDS,
  createMseController,
  type MseEnvironment,
  type MseFailure,
  type MseSource,
} from "@/features/playback/mse/controller";
import { createPcmCue } from "@/features/playback/mse/pcmCue";
import { ANCHOR_MEDIA_TIME, videoStartSeconds } from "@/features/playback/mse/timeline";
import { createWebAudioOutput } from "@/features/playback/mse/webAudio";
import { openPreviewWindow } from "@/features/playback/mse/windowClient";
import { pcmWindowRequest } from "@/features/playback/mse/windowRequests";
import {
  previewCueGain,
  previewElementVolume,
  previewMutePreferenceStore,
  usePreviewMutePreference,
} from "@/features/settings/previewMutePreference";
import { useTimecodePreference } from "@/features/settings/timecodePreference";
import {
  FRAME_TIMECODE_PLACEHOLDER,
  MILLISECONDS_TIMECODE_PLACEHOLDER,
} from "@/lib/timecode";
import { isMacOS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  PICTURE_CHECK_INTERVAL_MS,
  presentDecodeFailure,
  resolvePictureCheck,
  type DecodeFailureReason,
  type DecodeFailureTrigger,
  type PictureCheckEvent,
  type PictureCheckState,
} from "./decodeFailure";
import {
  createAnchorWaitController,
  followDeferredNavigation,
  reportAnchorWaitExpired,
} from "./anchorWait";
import {
  classifyDecodeFailure,
  describeMediaError,
  NO_DECODE_EVIDENCE,
  presentDecodeStall,
  provesPartialDecode,
  stepDecodeEvidence,
  type DecodeEvidence,
} from "./decodeRecovery";
import {
  INITIAL_PREVIEW_FRAME_RATIO_STATE,
  previewFrameAspectRatio,
  previewFrameStyle,
  previewPictureBox,
  previewPictureBoxStyle,
  stepPreviewFrameRatio,
} from "./previewAspectRatio";
import { formatSupportedVideoFormats } from "./previewEmptyState";
import { PreviewBoundaryBadges } from "./PreviewBoundaryBadges";
import { PreviewBufferingIndicator } from "./PreviewBufferingIndicator";
import {
  createMediaSourceOwner,
  createMediaSourceStoreActions,
  type MediaSourceOwner,
  type MediaSourcePaneReports,
} from "./mediaSourceOwner";
import {
  createNativeCueOwner,
  nativeMediaTimeOrigin,
  type NativeCueOwner,
} from "./nativeCueOwner";
import {
  currentPreviewPlatform,
  previewPathOfMedia,
  type PreviewPath,
} from "./previewPath";
import { audioStreamChangeEffect } from "./audioStreamChange";
import {
  addMediaSourceNotice,
  clearMediaSourceNotice,
  dismissMediaSourceNotice,
  mediaSourceNoticesFor,
  mediaSourcePanelTrigger,
  NO_MEDIA_SOURCE_NOTICES,
  rescansAtAttach,
  resolveMediaSourceFailure,
  shownMediaSourceNotices as noticesShownFor,
} from "./mediaSourceRules";
import {
  DecodeStallBanner,
  ImportErrorBanner,
  ImportErrorEmptyState,
  FrameExportNoticeBanner,
  MediaSourceNoticeBanner,
  PlaybackErrorBanner,
  WaveformNoticeBanner,
} from "./PreviewNotices";
import { showsNoticeArea } from "./previewNoticeRules";
import { resolveWaveformNotices } from "./waveformNoticeRules";
import { presentFrameExportNotice } from "./frameExportNoticeRules";
import {
  frameExportController,
  useFrameExportStore,
  type FrameExportState,
} from "@/features/frameExport";
import { createSourceLifecycleGuard, formatPreviewTotalDuration } from "./previewFrame";
import { PreviewTimecode } from "./PreviewTimecode";
import { previewElementKey, previewSequenceGeneration } from "./previewElementKey";

// The playback store actions never change, so they are read once instead of through a
// subscription for each one.
const {
  syncReady,
  primeFirstFrame,
  syncUnready,
  syncPresentedFrame,
  syncPresentationUnavailable,
  syncBrowserDuration,
  syncBrowserTime,
  syncSeeking,
  syncSeeked,
  syncPlay,
  syncPause,
  syncEnded,
  syncDecodeStall,
  reloadStalledPreview,
  reset: resetPlayback,
  dismissError: dismissPlaybackError,
} = playbackStore.getState();

// The media store actions never change either.
const { dismissError: dismissImportError } = mediaStore.getState();

// The format names in the empty state come from the list the file dialog filters on, so the
// two cannot disagree.
const SUPPORTED_VIDEO_FORMATS = formatSupportedVideoFormats(VIDEO_FILE_EXTENSIONS);

/**
 * True when the preview must play a native source muted to show its first frame (ADR 003).
 * WKWebView, the web view of macOS, presents no frame of a paused element that loaded only its
 * metadata, and no frame at position 0 when the first frame starts after 0. The first frame
 * callback then waits for a play of the user, the status bar says "Preparing the preview…", and
 * a navigation before that play makes the calibration unavailable. WebView2 presents the first
 * frame of a paused element.
 */
const PRIMES_FIRST_FRAME = isMacOS();

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
 * The audio stream of `media` that the preview reads: its effective stream under `overrides`
 * (ADR 070). The default reads the override store now, as the ref callback of an element does
 * when it starts the windows.
 */
function previewStreamOf(
  media: ImportMediaResult,
  overrides: Readonly<
    Record<string, AudioStreamOverride>
  > = audioOverrideStore.getState().overrides,
): AudioProbe | null {
  const sourceId = getGeneratedSourceId(media);
  return previewAudioStreamOf(
    media.probe,
    sourceId === null ? undefined : overrides[sourceId],
  );
}

/**
 * How the preview plays a source: the element opens it, or a MediaSource plays it (ADR 046).
 * `stream` is the audio stream that the windows read, whose codec decides between a copy and a
 * transcode of the audio.
 */
function previewPathOf(
  media: ImportMediaResult,
  stream: AudioProbe | null = previewStreamOf(media),
): PreviewPath {
  return previewPathOfMedia(media, stream);
}

/**
 * The source as the remux windows of a MediaSource source need it (ADR 046). `stream` is the
 * stream whose codec chose `path.audio`, and the windows map it (ADR 070).
 */
function toMseSource(
  media: ImportMediaResult,
  path: Extract<PreviewPath, { kind: "mediaSource" }>,
  stream: AudioProbe | null,
  rescanConfig: boolean,
): MseSource {
  return {
    path: media.path,
    size: media.size,
    mtime: media.mtime,
    container: path.container,
    formatStartTime: media.probe.formatStartTime ?? null,
    videoStartSeconds: path.videoStartSeconds,
    durationSeconds: path.durationSeconds,
    audio: path.audio,
    audioCodec: stream?.codec ?? null,
    audioStreamIndex: stream?.index ?? null,
    pcm: stream !== null,
    rescanConfig,
  };
}

/** The browser side of the MediaSource controller. */
const BROWSER_MSE_ENVIRONMENT: MseEnvironment = {
  createMediaSource: () => {
    const source = new MediaSource();
    return { source, url: URL.createObjectURL(source) };
  },
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  isTypeSupported: (type) => MediaSource.isTypeSupported(type),
  openWindow: (request, listener) => openPreviewWindow(request, listener),
  // WebView2 is Chromium, which completes no seek just before a hole of the buffered data.
  // WKWebView, the web view of macOS, does (ADR 046).
  seekTailSeconds: isMacOS() ? 0 : CHROMIUM_SEEK_TAIL_SECONDS,
};

/**
 * Calls `callback` at each pointer and key gesture of the document, so a Web Audio cue can
 * start its AudioContext there. Returns a function that stops the calls.
 */
function listenForPreviewGestures(callback: () => void): () => void {
  const options = { capture: true };
  document.addEventListener("pointerdown", callback, options);
  document.addEventListener("keydown", callback, options);
  return () => {
    document.removeEventListener("pointerdown", callback, options);
    document.removeEventListener("keydown", callback, options);
  };
}

/**
 * True when a native source plays its frame step cue through Web Audio (ADR 062). In WKWebView
 * the hidden audio element of ADR 019 stops each single burst before its sound starts.
 * WebView2 is Chromium, whose element clock waits for the sound, so Windows keeps the element.
 */
const NATIVE_SOURCE_PCM_CUE = isMacOS();

/** The owner of the Web Audio cue of a native source (ADR 062). */
function createPreviewNativeCueOwner(): NativeCueOwner {
  return createNativeCueOwner({
    createCue: (target, gain) =>
      createPcmCue({
        videoStartSeconds: target.originSeconds,
        createOutput: createWebAudioOutput,
        gain,
        openPcmWindow: (startSeconds, listener) =>
          openPreviewWindow(
            pcmWindowRequest({ ...target.source, container: "native" }, startSeconds),
            listener,
          ),
      }),
    setScrubCue,
    clearScrubCue,
    listenForGestures: listenForPreviewGestures,
  });
}

/**
 * The owner of the MediaSource controller and the Web Audio cue of the preview (ADR 046), with
 * the browser, the window client and the playback store behind it. `pane` receives what the
 * pane shows.
 */
function createPreviewMediaSourceOwner(pane: MediaSourcePaneReports): MediaSourceOwner {
  return createMediaSourceOwner({
    createController: (element, source, events) =>
      createMseController(element, source, BROWSER_MSE_ENVIRONMENT, events),
    createCue: (source, gain) =>
      createPcmCue({
        videoStartSeconds: source.videoStartSeconds,
        createOutput: createWebAudioOutput,
        gain,
        // On FLV the PCM comes with the video windows. MPEG-TS and Matroska read their own PCM
        // windows of the audio lane.
        openPcmWindow:
          source.container === "flv"
            ? undefined
            : (startSeconds, listener) =>
                openPreviewWindow(pcmWindowRequest(source, startSeconds), listener),
      }),
    setScrubCue,
    listenForGestures: listenForPreviewGestures,
    store: createMediaSourceStoreActions(playbackStore),
    pane,
    // WKWebView, the web view of macOS, completes a seek whose data arrived late on the wrong
    // frame (ADR 046). WebView2 does not.
    repairsLateSeeks: isMacOS(),
    warn: (message) => {
      console.warn(message);
    },
  });
}

/**
 * Builds the timing descriptor the playback store attaches, or null when no media is open.
 */
function toPlaybackSource(media: ImportMediaResult | null): PlaybackSource | null {
  if (!media) {
    return null;
  }
  // The anchor of a MediaSource source is known before its first frame (ADR 046).
  const isMediaSource = previewPathOf(media).kind === "mediaSource";
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
    mediaSource: isMediaSource,
    anchorMediaTime: isMediaSource ? ANCHOR_MEDIA_TIME : null,
  };
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

const selectMediaSources = (state: MediaStoreState) => state.sources;
const selectWaveformSources = (state: WaveformStoreState) => state.sources;
const selectWaveformRunning = (state: WaveformStoreState) => state.runningSourceId;
const selectHasWaveformNotice = (state: WaveformStoreState) =>
  resolveWaveformNotices(state, () => "").length > 0;
const selectFrameExportNotice = (state: FrameExportState) => state.notice;
const selectHasFrameExportNotice = (state: FrameExportState) => state.notice !== null;

/**
 * The notice of Export Frame (ADR 069). It belongs to the action, not to the attached clip, so it
 * stays while the preview changes the clip.
 */
function FrameExportNotice({ onReturnFocus }: { onReturnFocus: () => void }) {
  const notice = presentFrameExportNotice(useFrameExportStore(selectFrameExportNotice));
  if (notice === null) {
    return null;
  }
  return (
    <FrameExportNoticeBanner
      // A new notice starts with a full timer.
      key={notice.id}
      notice={notice}
      onDismiss={() => frameExportController.dismissNotice(notice.id)}
      onReturnFocus={onReturnFocus}
    />
  );
}

/**
 * The notices of the audio envelope (ADR 056). They belong to a source of the sequence, not to
 * the attached clip, so they show whatever clip the preview plays. The progress of a job
 * renders this list and not the pane.
 */
function WaveformNotices({ onReturnFocus }: { onReturnFocus: () => void }) {
  const mediaSources = useMediaStore(selectMediaSources);
  const sources = useWaveformStore(selectWaveformSources);
  const runningSourceId = useWaveformStore(selectWaveformRunning);
  const notices = resolveWaveformNotices(
    { sources, runningSourceId },
    (sourceId) => mediaSources[sourceId]?.fileName ?? "",
  );
  return notices.map((notice) => (
    <WaveformNoticeBanner
      key={`${notice.kind}-${notice.sourceId}`}
      notice={notice}
      onDismiss={() => waveformController.dismissNotice(notice.sourceId)}
      onReturnFocus={onReturnFocus}
    />
  ));
}

export function PreviewPane() {
  const { t } = useTranslation();
  const hasWaveformNotice = useWaveformStore(selectHasWaveformNotice);
  const hasFrameExportNotice = useFrameExportStore(selectHasFrameExportNotice);
  // The media of the clip that the sequence attached (ADR 052). A switch of clip changes it, and
  // the element below mounts again for the new source: the cold switch.
  const status = useAttachedMediaStore((s) => s.status);
  const media = useAttachedMediaStore((s) => s.media);
  const error = useAttachedMediaStore((s) => s.error);
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
  // The decode stall of the element, and the count of the reloads after a stall. A higher count
  // replaces the media elements with new ones for the same source (see `elementKey`).
  const decodeStall = usePlaybackStore((s) => s.decodeStall);
  const reloadGeneration = usePlaybackStore((s) => s.reloadGeneration);
  // True from the start of a recalibration until its new element is ready (ADR 063). The cues
  // wait for it, so they do not load the file beside the new element before its anchor.
  const isRecalibrating = usePlaybackStore((s) => s.isRecalibrating);

  // The mute toggle of the transport bar. Both media elements take it as the `muted`
  // property, which React sets when it creates the node, so a stored value applies before the
  // first play. It changes only what the user hears: the elements still seek, play and report
  // their events, so the calibration, the seeks and the cue of ADR 019 run as before.
  const isMuted = usePreviewMutePreference((s) => s.muted);
  // The volume slider of the transport bar. It too changes only what the user hears. React has
  // no `volume` attribute, so each ref callback below sets the property on its new element
  // before the first play, and the effect below sets it on the elements that exist when it
  // changes.
  const volumePercent = usePreviewMutePreference((s) => s.volumePercent);

  // The generation of the sequence of the shown media. The open of a project gives a new one,
  // also when the first clip is the file that the preview showed (ADR 072).
  const sequenceGeneration = useTimelineStore(previewSequenceGeneration);

  const sourceRevisionKey = getSourceRevisionKey(media);
  // The key of the media elements and of the components that follow the video element. A new
  // source, a reload after a decode stall, a recalibration and a new sequence from an open give a
  // new key, so React builds new elements. A media element does not play or seek again after a
  // decode error, and a new one does. A new element also calibrates from its own first frame
  // (ADR 063).
  const elementKey = previewElementKey(
    sourceRevisionKey,
    sequenceGeneration,
    reloadGeneration,
  );
  const [previousMedia, setPreviousMedia] = useState(media);
  // The generation part of the element key that the pane last rendered (ADR 072).
  const [previousSequenceGeneration, setPreviousSequenceGeneration] =
    useState(sequenceGeneration);
  // The same generation after the commit, for the listener of the audio-stream overrides, which
  // outlives the render that started it. An override that changes with a new sequence belongs to
  // the elements that the next commit builds.
  const committedSequenceGenerationRef = useRef(sequenceGeneration);
  useLayoutEffect(() => {
    committedSequenceGenerationRef.current = sequenceGeneration;
  }, [sequenceGeneration]);
  // What made the web view fail to play the source, or null while it plays: the element
  // fired `error`, or the picture check found no picture. The pane then shows the
  // decode-failure panel in place of the element.
  const [failureTrigger, setFailureTrigger] = useState<DecodeFailureTrigger | null>(
    null,
  );
  const decodeFailed = failureTrigger !== null;
  // Whether the committed render shows the decode-failure panel, for the listener of the
  // audio-stream overrides, which outlives the render that started it (ADR 070).
  const decodeFailedRef = useRef(false);
  // The stall whose notice the user closed. The notice stays hidden for that stall only, so a
  // later stall shows it again.
  const [dismissedStall, setDismissedStall] = useState<typeof decodeStall>(null);
  // The picture ratio that the video element last reported. The frame takes it while it holds
  // the element (see `stepPreviewFrameRatio` and `previewFrameAspectRatio`).
  const [frameRatio, setFrameRatio] = useState(INITIAL_PREVIEW_FRAME_RATIO_STATE);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  // What each video element has shown of its source, and the revision keys of the sources that
  // an element proved to decode in part (`provesPartialDecode`). A decode error of such a source
  // stops a file that decodes in part (`classifyDecodeFailure`). The record holds for the
  // source, not for one element: the new element of a reload can seek before its own first
  // frame, when the calibration is unavailable, and an error of that seek is a stall too. A new
  // media object, also a new import of the same file, starts the record again.
  const [decodeEvidence] = useState(
    () => new WeakMap<HTMLVideoElement, DecodeEvidence>(),
  );
  const [decodedSources] = useState(() => new Set<string>());
  // For each MediaSource FLV source, the reload generation whose element scans for decoder
  // configurations before the window at the place of a decode error (ADR 046, "Failures"). A
  // stall reloads the element at the next seek, and that element asks for the scan.
  const [rescanGenerations] = useState(() => new Map<string, number>());
  // The notices about a video that plays through FFmpeg (ADR 046), for the source revision they
  // belong to, and the ones that the user dismissed.
  const [mediaSourceNotices, setMediaSourceNotices] = useState(NO_MEDIA_SOURCE_NOTICES);
  const recordDecodeEvidence = useCallback(
    (element: HTMLVideoElement, revisionKey: string, event: "frame" | "seeking") => {
      const next = stepDecodeEvidence(
        decodeEvidence.get(element) ?? NO_DECODE_EVIDENCE,
        event,
      );
      decodeEvidence.set(element, next);
      if (provesPartialDecode(next)) {
        decodedSources.add(revisionKey);
      }
    },
    [decodeEvidence, decodedSources],
  );

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
  // element presents no frame for the whole wait, the pane reports it. The first time for a
  // source the store loads a new element (ADR 063), and the wait arms again for it. The next
  // time the calibration leaves `calibrating` and the navigation runs on the approximate path.
  // With nothing deferred, the calibration stays open until a frame comes.
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

  // The failure handler of the latest render. The MediaSource controller outlives the render that
  // started it, so it reports through this ref.
  const mediaSourceFailureRef = useRef<
    | ((
        sourceRevisionKey: string,
        element: HTMLVideoElement,
        failure: MseFailure,
      ) => void)
    | null
  >(null);

  // The MediaSource controller and the Web Audio cue of the element of a MediaSource source
  // (ADR 046). The video ref callback below builds the owner at its first call, starts them
  // after the store attaches the element, and stops them when the element leaves the tree.
  const mediaSourceOwnerRef = useRef<MediaSourceOwner | null>(null);

  // The hidden element of the frame step cue (ADR 019) that the scrub ref callback below holds,
  // so the volume reaches it.
  const scrubAudioRef = useRef<HTMLAudioElement | null>(null);

  // The Web Audio cue of a native source on macOS (ADR 062). The effect below builds the owner
  // when it first starts a cue.
  const nativeCueOwnerRef = useRef<NativeCueOwner | null>(null);

  // The elements follow the volume, and the Web Audio cues follow the mute toggle and the
  // volume through their gain (ADR 046, ADR 062).
  useEffect(() => {
    const volume = previewElementVolume(volumePercent);
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
    if (scrubAudioRef.current) {
      scrubAudioRef.current.volume = volume;
    }
    const gain = previewCueGain({ muted: isMuted, volumePercent });
    mediaSourceOwnerRef.current?.setGain(gain);
    nativeCueOwnerRef.current?.setGain(gain);
  }, [isMuted, volumePercent]);

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
    // A new import of the open file keeps the element and its controller, so it keeps their
    // notices too.
    setMediaSourceNotices((notices) =>
      mediaSourceNoticesFor(notices, getSourceRevisionKey(media)),
    );
    // The ratio resets with no media, and a new source keeps it until its element reports.
    setFrameRatio((current) =>
      stepPreviewFrameRatio(current, {
        type: "mediaChanged",
        hasMedia: media !== null,
      }),
    );
  }

  // A new sequence from the open of a project builds new media elements, also for the file that
  // the preview showed (ADR 072). The states that the pane keeps for a revision belong to the
  // elements and the controller before the open, so they go before the new element attaches its
  // controller in the commit of this render: the decode failure, the notices of the MediaSource
  // controller, the sources that decoded in part, and the scan of a stall reload.
  if (previousSequenceGeneration !== sequenceGeneration) {
    setPreviousSequenceGeneration(sequenceGeneration);
    setFailureTrigger(null);
    setMediaSourceNotices({ ...NO_MEDIA_SOURCE_NOTICES, sourceRevisionKey });
    decodedSources.clear();
    rescanGenerations.clear();
  }

  // Reset playback store if media disappears
  useEffect(() => {
    if (!media) {
      resetPlayback();
    }
  }, [media]);

  // A new media object starts the record of the sources that decode in part again, so an error
  // of a new element is a stall only after this load proved it. The element on screen keeps its
  // own evidence, which came from the same file.
  //
  // A new import of the open file keeps the revision key, so the stalled element keeps its key
  // and React does not replace it. During a decode stall the import therefore reloads the
  // element, at the start of the source. Without a stall, and for another file, the reload does
  // nothing.
  useEffect(() => {
    decodedSources.clear();
    rescanGenerations.clear();
    if (media) {
      reloadStalledPreview(getSourceRevisionKey(media));
    }
  }, [media, decodedSources, rescanGenerations]);

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
  // The audio stream that the preview reads: the effective stream of the source (ADR 070). A
  // change of the override renders the pane again, so the PCM cue of a native source follows it.
  const audioOverrides = useAudioOverrides();
  const previewStream = useMemo(
    () => (media ? previewStreamOf(media, audioOverrides) : null),
    [media, audioOverrides],
  );
  const previewStreamIndex = previewStream?.index ?? null;
  // How the element plays the source: through the asset protocol, or through a MediaSource that
  // the ref owner below starts (ADR 046).
  const previewPath = useMemo(
    () => (media ? previewPathOf(media, previewStream) : null),
    [media, previewStream],
  );
  const isMediaSource = previewPath?.kind === "mediaSource";

  // What the decode-failure panel says about this source and its trigger.
  const decodeFailure = useMemo(
    () =>
      failureTrigger === null || mediaProbe === undefined || mediaFileName === undefined
        ? null
        : presentDecodeFailure({
            probe: mediaProbe,
            fileName: mediaFileName,
            trigger: failureTrigger,
            platform: currentPreviewPlatform(),
          }),
    [failureTrigger, mediaProbe, mediaFileName],
  );

  // The frame takes the ratio of the picture while it holds the video element, and 16:9 for
  // the empty state, the loading state, the import-error view and the decode-failure panel.
  const frameAspectRatio = previewFrameAspectRatio(frameRatio, {
    hasMedia: media !== null,
    decodeFailed,
  });
  const frameStyle = previewFrameStyle(frameAspectRatio);
  // The box of the picture inside the frame. It is smaller than the frame on one axis when the
  // picture is wider or taller than the limits of the frame ratio, and the element then adds
  // bars. The In and Out badges take this box, so they stay on the picture.
  const pictureBoxStyle = previewPictureBoxStyle(
    previewPictureBox(frameRatio, frameAspectRatio),
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
        getSource: () => toPlaybackSource(attachedMediaStore.getState().media),
        attach: (source, node) => playbackStore.getState().attach(source, node),
        detach: (sourceRevisionKey, node) =>
          playbackStore.getState().detach(sourceRevisionKey, node),
      });
      ownerRef.current(element);
      if (element === null) {
        // A removed element ends its picture check and its wait for the anchor, so a pending
        // wait cannot act on it. Its MediaSource stops with it.
        stopPictureCheckTimer(pictureCheckRef.current);
        pictureCheckRef.current = null;
        anchorWait.disarm();
        const owner = mediaSourceOwnerRef.current;
        const held = owner?.element() ?? null;
        if (owner && held !== null) {
          owner.detach(held);
        }
        return;
      }
      const audioLevel = previewMutePreferenceStore.getState();
      element.volume = previewElementVolume(audioLevel.volumePercent);
      // A MediaSource source starts its controller after the store attached the element, so
      // the first reports find the attachment (ADR 046). The windows map the effective audio
      // stream at this moment, and a later change replaces the element (ADR 070).
      const current = attachedMediaStore.getState().media;
      const stream = current === null ? null : previewStreamOf(current);
      const path = current === null ? null : previewPathOf(current, stream);
      if (current !== null && path?.kind === "mediaSource") {
        const key = getSourceRevisionKey(current);
        mediaSourceOwnerRef.current ??= createPreviewMediaSourceOwner({
          onNonMonotonic: (sourceKey) =>
            setMediaSourceNotices((notices) =>
              addMediaSourceNotice(
                notices,
                sourceKey,
                "preview.mediaSource.timestampsDecrease",
              ),
            ),
          onAudioOmitted: (sourceKey) =>
            setMediaSourceNotices((notices) =>
              addMediaSourceNotice(notices, sourceKey, "preview.mediaSource.noSound"),
            ),
          onFailure: (sourceKey, node, failure) => {
            mediaSourceFailureRef.current?.(sourceKey, node, failure);
          },
        });
        mediaSourceOwnerRef.current.attach(
          element,
          {
            sourceRevisionKey: key,
            source: toMseSource(
              current,
              path,
              stream,
              rescansAtAttach(
                rescanGenerations,
                key,
                playbackStore.getState().reloadGeneration,
              ),
            ),
            hasAudio: stream !== null,
          },
          previewCueGain(audioLevel),
        );
      }
    },
    [anchorWait, rescanGenerations],
  );

  // The Web Audio cue of a native source on macOS (ADR 062). It needs the source time of media
  // time 0. A native source has that time only after the calibration of ADR 003, so the cue
  // starts when the calibration is ready. The hidden audio element below stays out of the tree
  // while this flag holds, and it is the cue in every other case, such as a calibration that is
  // unavailable. A new element (`elementKey`), a new source or a lost calibration stops the cue.
  // A recalibration stops it too, and it starts again when the new element calibrates (ADR 063).
  // A change of the effective audio stream replaces the cue, with its PCM and its windows, and the
  // element and its calibration stay (ADR 070): the effect depends on `previewStreamIndex`, and
  // the owner takes a cue of another stream for a new attachment.
  const usesNativePcmCue =
    NATIVE_SOURCE_PCM_CUE &&
    media !== null &&
    previewStream !== null &&
    !isMediaSource &&
    !decodeFailed &&
    !isRecalibrating &&
    attachedSourceRevisionKey === sourceRevisionKey &&
    calibrationStatus === "ready" &&
    videoStartSeconds(media.probe.videoStartPts, media.probe.videoTimeBase) !== null;
  useEffect(() => {
    if (!usesNativePcmCue) {
      return;
    }
    // The media and the anchor are read here, so a re-import of the open file, which keeps the
    // key, keeps the cue that runs. The stream is read from the override store now, as the
    // windows of a MediaSource element read it at their start.
    const current = attachedMediaStore.getState().media;
    const element = videoRef.current;
    const stream = current === null ? null : previewStreamOf(current);
    if (
      current === null ||
      element === null ||
      stream === null ||
      getSourceRevisionKey(current) !== sourceRevisionKey
    ) {
      return;
    }
    // The anchor, and not the frame on screen: a navigation that waited for the anchor clears
    // the frame in the same update that makes the calibration ready.
    const originSeconds = nativeMediaTimeOrigin(
      playbackStore.getState().calibrationAnchorMediaTime(),
      current.probe.videoStartPts,
      current.probe.videoTimeBase,
    );
    if (originSeconds === null) {
      return;
    }
    const owner = (nativeCueOwnerRef.current ??= createPreviewNativeCueOwner());
    owner.attach(
      element,
      {
        sourceRevisionKey,
        source: {
          path: current.path,
          size: current.size,
          mtime: current.mtime,
          formatStartTime: current.probe.formatStartTime ?? null,
          audioCodec: stream.codec,
          audioStreamIndex: stream.index,
        },
        originSeconds,
      },
      previewCueGain(previewMutePreferenceStore.getState()),
    );
    return () => {
      owner.detach(element);
    };
  }, [usesNativePcmCue, sourceRevisionKey, elementKey, previewStreamIndex]);

  // A change of the effective audio stream (ADR 070). The windows of a MediaSource element map
  // the stream that they read when the element started, so a change replaces the element through
  // the reload of ADR 039, with no stall, as a recalibration does (ADR 063). The new element reads
  // the stream again in the ref callback above. The listener reads the media and the owners when
  // the override changes, so the replacement starts in the task of the choice of the user, and
  // the mark of the submenu and the stream of the new windows come from one state.
  useEffect(
    () =>
      audioOverrideStore.subscribe((state, previous) => {
        if (state.overrides === previous.overrides) {
          return;
        }
        const current = attachedMediaStore.getState().media;
        if (current === null) {
          return;
        }
        const key = getSourceRevisionKey(current);
        const stream = previewStreamOf(current, state.overrides);
        const path = previewPathOf(current, stream);
        const effect = audioStreamChangeEffect({
          path: path.kind,
          sourceRevisionKey: key,
          previousStreamIndex:
            previewStreamOf(current, previous.overrides)?.index ?? null,
          effectiveStreamIndex: stream?.index ?? null,
          // The failure of the render that the user sees: the render-phase reset clears it for
          // a new media object, so it belongs to the attached source.
          showsFailure: decodeFailedRef.current,
          held:
            path.kind === "mediaSource"
              ? (mediaSourceOwnerRef.current?.held() ?? null)
              : (nativeCueOwnerRef.current?.held() ?? null),
          // Step 8 of an open changes the overrides after the new sequence (ADR 072).
          isNewSequence:
            previewSequenceGeneration(timelineStore.getState()) !==
            committedSequenceGenerationRef.current,
        });
        // A cue to replace needs nothing here: the effect of the cue above depends on the stream
        // index, so the render that this change starts replaces the cue.
        if (effect !== "reloadElement" && effect !== "retryFailed") {
          return;
        }
        // The notice that the preview plays no sound was about the stream of the old windows.
        setMediaSourceNotices((notices) =>
          clearMediaSourceNotice(notices, key, "preview.mediaSource.noSound"),
        );
        if (effect === "retryFailed") {
          // The element mounts again, as for a new import of the open file. Its ref callback
          // attaches it to the store, which detached the failed element, and starts a new
          // controller that reads the new stream. The picture check of the failed element ended
          // when that element left the tree, and the new element starts its own. A navigation
          // that waits for the attach, as a playback that crossed into this clip, keeps its seek
          // and loses its play first, so the playback does not start again on the new element.
          sequencePlayback.dropPlayIntent();
          setFailureTrigger(null);
          return;
        }
        sequencePlayback.store.getState().replacePreviewElement(key);
      }),
    [],
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
          scrubAudioRef.current = node;
          node.volume = previewElementVolume(
            previewMutePreferenceStore.getState().volumePercent,
          );
          scrubAudioController.attach(node);
        } else {
          const elToDetach = ownedElement;
          ownedElement = null;
          if (scrubAudioRef.current === elToDetach) {
            scrubAudioRef.current = null;
          }
          if (elToDetach) {
            scrubAudioController.detach(elToDetach);
          }
        }
      };
    })();
    scrubOwnerRef.current(element);
  }, []);

  // Register requestVideoFrameCallback lifecycle loop (ADR 003). The loop starts again for each
  // new video element: a new source, a reload after a decode stall or of a recalibration, and a
  // new sequence from an open, which replace the element with no change of the source. Without
  // `elementKey` the new element of a reload or of an open would get no frame callback and never
  // calibrate.
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
        // A recalibration retired the element (ADR 063): its frames belong to nobody, and the
        // loop stops. The new element runs its own loop.
        if (playbackStore.getState().isRetiredElement(expectedRevisionKey, video)) {
          return;
        }

        // A second frame proves that the source decodes in part.
        recordDecodeEvidence(video, expectedRevisionKey, "frame");

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
  }, [
    sourceRevisionKey,
    elementKey,
    media,
    decodeFailed,
    sourceGuard,
    recordDecodeEvidence,
  ]);

  // True when an event of `element` may reach the sequence playback and the store: its source
  // is the active one, and no recalibration retired the element (ADR 063). A retired element
  // stays in the tree until React replaces it, and its late events, frames and errors belong to
  // nobody. The store refuses them too, but the sequence playback acts on `pause` and `ended`
  // before the store sees them.
  const acceptsEventsOf = (element: HTMLVideoElement, key = sourceRevisionKey) =>
    sourceGuard.isActive(key) &&
    !playbackStore.getState().isRetiredElement(key, element);

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!acceptsEventsOf(e.currentTarget) || !media) {
      return;
    }
    syncBrowserTime(sourceRevisionKey, e.currentTarget);
  };

  // Takes the picture ratio from the size the element reports, at `loadedmetadata` and at each
  // `resize`. A zero size, such as that of a web view that decodes no picture, gives the
  // default ratio. React renders again only when the ratio changes.
  const syncPictureRatio = (element: HTMLVideoElement) => {
    if (!acceptsEventsOf(element)) {
      return;
    }
    // The size is read now, because React can run the updater later.
    const { videoWidth: width, videoHeight: height } = element;
    setFrameRatio((current) =>
      stepPreviewFrameRatio(current, { type: "pictureSize", width, height }),
    );
  };

  // An `error` event and a failed picture check take the same path. The element leaves the
  // tree on the next render, and its ref callback detaches it from the playback store.
  const handleDecodeFailure = (
    element: HTMLVideoElement,
    trigger: DecodeFailureTrigger,
  ) => {
    // An element that a recalibration retired is already being replaced (ADR 063). Its error is
    // not a failure of the source, so it shows no panel and leaves the store ready for the new
    // element.
    if (!acceptsEventsOf(element)) {
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

  // A decode error of a source that decodes in part stops the preview in the middle of the file:
  // the store keeps the timeline and the element, the notice says where the preview stopped, and
  // the next seek replaces the element (`decodeStall`). Every other error, and a stall that the
  // store refuses, takes the path of a failure.
  const handleMediaError = (element: HTMLVideoElement) => {
    if (!acceptsEventsOf(element)) {
      return;
    }
    const code = element.error?.code ?? null;
    console.warn(describeMediaError(code, element.error?.message));
    const decodesInPart =
      decodedSources.has(sourceRevisionKey) ||
      provesPartialDecode(decodeEvidence.get(element) ?? NO_DECODE_EVIDENCE);
    const trigger: DecodeFailureTrigger = { kind: "mediaError", code };
    if (
      classifyDecodeFailure(trigger, decodesInPart) === "stall" &&
      syncDecodeStall(sourceRevisionKey, element)
    ) {
      // A window of an FLV that fails to decode can lack a decoder configuration that its
      // head does not hold. The element of the reload scans for one first (ADR 046).
      if (previewPath?.kind === "mediaSource" && previewPath.container === "flv") {
        rescanGenerations.set(
          sourceRevisionKey,
          playbackStore.getState().reloadGeneration + 1,
        );
      }
      return;
    }
    handleDecodeFailure(
      element,
      isMediaSource ? mediaSourcePanelTrigger(code) : trigger,
    );
  };

  // A MediaSource controller that stopped (ADR 046): see `resolveMediaSourceFailure`. A stall
  // that the store refuses takes the panel.
  const handleMediaSourceFailure = (
    key: string,
    element: HTMLVideoElement,
    failure: MseFailure,
  ) => {
    if (key !== sourceRevisionKey || !acceptsEventsOf(element, key)) {
      return;
    }
    if (failure.kind === "windowFailed") {
      console.warn(
        `preview: a remux window failed (${failure.code})`,
        failure.detail ?? "",
      );
    }
    const decodesInPart =
      decodedSources.has(key) ||
      provesPartialDecode(decodeEvidence.get(element) ?? NO_DECODE_EVIDENCE);
    const outcome = resolveMediaSourceFailure(failure, decodesInPart);
    if (outcome.stall !== null && syncDecodeStall(key, element, outcome.stall.cause)) {
      return;
    }
    handleDecodeFailure(element, outcome.trigger);
  };

  // The duration of the element of each source of the session, the last extent fallback of a
  // clip on the sequence (ADR 007, ADR 052). The timeline keeps it after the attach changes.
  const recordBrowserDuration = (element: HTMLVideoElement) => {
    const sourceId = media === null ? null : getGeneratedSourceId(media);
    if (sourceId !== null) {
      timelineStore.getState().setBrowserDuration(sourceId, element.duration);
    }
  };

  // The ready path of a loaded element. `loadedmetadata` takes it at once when the element
  // reports a picture size. Otherwise the picture check takes it when a size arrives.
  const takeReadyPath = (element: HTMLVideoElement) => {
    if (!acceptsEventsOf(element)) {
      return;
    }
    syncReady(sourceRevisionKey, element);
    syncBrowserDuration(sourceRevisionKey, element);
    recordBrowserDuration(element);
    syncBrowserTime(sourceRevisionKey, element);
    // The store primes only an open first-frame anchor, so a MediaSource source, whose anchor
    // is known, and a source that cannot calibrate are left alone.
    if (PRIMES_FIRST_FRAME) {
      primeFirstFrame(
        sourceRevisionKey,
        element,
        () => previewMutePreferenceStore.getState().muted,
      );
    }
  };

  // Feeds an element event, or the end of a wait, to the picture check, and performs the
  // action that `resolvePictureCheck` returns.
  const runPictureCheck = (element: HTMLVideoElement, event: PictureCheckEvent) => {
    if (!acceptsEventsOf(element)) {
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

  // Publish the runner of this render for the frame callback loop and the wait timer, and the
  // failure handler for the MediaSource controller.
  useLayoutEffect(() => {
    runPictureCheckRef.current = runPictureCheck;
    mediaSourceFailureRef.current = handleMediaSourceFailure;
    decodeFailedRef.current = decodeFailed;
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
  // The timecode row shows the position on the sequence (ADR 052): the virtual media of the
  // sequence, which is the media of the one clip when there is one clip. The decode stall
  // reports a position of the attached element, so it keeps the format of that clip.
  const sequenceMedia = useSequenceMediaStore((s) => s.media);
  const sequenceProbe = sequenceMedia?.probe;
  const sequenceTimecodeDisplay = useMemo(
    () => resolveTimecodeDisplay(timecodePreference, sequenceProbe),
    [timecodePreference, sequenceProbe],
  );
  const noMediaPlaceholder =
    timecodePreference === "frames"
      ? FRAME_TIMECODE_PLACEHOLDER
      : MILLISECONDS_TIMECODE_PLACEHOLDER;

  // The conditions of the notices, named once. The import error shows as the empty-state view
  // with no media and as a banner with media. The notification area shows the loading chip and
  // the two banners, and the In and Out badges hide while it shows one.
  const hasImportError = status === "error" && error !== null;
  const showsPlaybackErrorBanner = playbackError !== null && !decodeFailed;
  const shownStall =
    decodeStall !== null && decodeStall !== dismissedStall && !decodeFailed
      ? decodeStall
      : null;
  const shownMediaSourceNotices = decodeFailed
    ? []
    : noticesShownFor(mediaSourceNotices, sourceRevisionKey);
  const hasNotice =
    showLoading ||
    hasImportError ||
    showsPlaybackErrorBanner ||
    shownStall !== null ||
    shownMediaSourceNotices.length > 0 ||
    hasWaveformNotice ||
    hasFrameExportNotice;

  const totalTimeDisplay = sequenceMedia
    ? formatPreviewTotalDuration(
        sequenceMedia.probe.approximateDurationSeconds,
        sequenceMedia.probe.videoDurationTicks,
        sequenceMedia.probe.videoTimeBase,
        sequenceTimecodeDisplay,
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
      // The focus target of a control that a recalibration removes, also from the status bar
      // (`previewRegion.ts`, ADR 063).
      data-preview-region=""
      tabIndex={-1}
      aria-label={t("preview.regionLabel")}
      className="dark flex min-h-[200px] flex-1 flex-col overflow-hidden bg-preview-background p-3 text-preview-foreground scheme-dark outline-none select-none"
    >
      {/* The preview area. It is a size container, so the frame fits itself into it with
          CSS alone (`preview-frame-fit`), and it takes its size from the layout, so a new
          frame ratio moves nothing around it. */}
      <div className="@container-size relative flex min-h-0 flex-1 items-center justify-center">
        {/* The frame, at the ratio of the picture while it shows one and at 16:9 otherwise.
            The notices and the buffering spinner are anchored to its corners. They sit
            outside the surface, so a notice wider than a narrow frame is not clipped. */}
        <div className="relative preview-frame-fit" style={frameStyle}>
          {/* The surface clips the picture to the corners of the frame. It takes a dashed
              border while it is empty, so it reads as a placeholder. */}
          <div
            className={cn(
              "flex size-full items-center justify-center overflow-hidden rounded-preview-frame border border-preview-border bg-preview-surface shadow-xs",
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
                    className="flex max-h-full w-full max-w-md flex-col items-center gap-2 overflow-y-auto p-4 text-center"
                    aria-live="polite"
                    // The up and down arrows scroll the panel while it overflows and one of
                    // its controls has the focus (`SCROLL_KEYS_ATTRIBUTE`).
                    data-scroll-keys
                  >
                    <AlertCircle
                      aria-hidden="true"
                      className="size-6 shrink-0 text-warning"
                    />
                    <h2 className="text-sm font-medium text-preview-foreground">
                      {t("preview.decodeFailure.title")}
                    </h2>
                    {decodeFailure && (
                      <div className="flex w-full flex-col gap-1 text-xs text-preview-muted">
                        {/* The values are identifiers a user can copy into a search. */}
                        <p className="select-text">
                          <DecodeFailureReasonText reason={decodeFailure.reason} />
                        </p>
                        {decodeFailure.hintKey !== null && (
                          <p>{t(decodeFailure.hintKey)}</p>
                        )}
                        {/* The diagnostic text of a failure of FFmpeg, which is not
                            translated (ADR 011). */}
                        {decodeFailure.detail !== undefined && (
                          <DiagnosticDetails
                            className="mt-1 w-full text-left"
                            summary={t("preview.decodeFailure.details.show")}
                            openSummary={t("preview.decodeFailure.details.hide")}
                            text={decodeFailure.detail}
                          />
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
                    key={elementKey}
                    playsInline
                    muted={isMuted}
                    preload="metadata"
                    // The native player features stay off, so no control outside the playback
                    // store plays, seeks or moves the picture (ADR 003). Each attribute only
                    // removes a control, a menu item, or a way to show the picture in another
                    // window or on another screen. None changes playback, seeking or the frame
                    // callbacks, and an engine that does not know one ignores it: WebKit has
                    // no `controlsList`. The context menu rule (`contextMenuPolicy.ts`) keeps
                    // the native menu of the element closed, with its Loop and Show Controls.
                    disablePictureInPicture
                    disableRemotePlayback
                    controlsList="nodownload noplaybackrate noremoteplayback nofullscreen"
                    // A MediaSource source gets its object URL from its controller (ADR 046).
                    src={isMediaSource ? undefined : videoSrc}
                    aria-label={t("preview.videoPlayerLabel", {
                      fileName: media.fileName,
                    })}
                    className="h-full w-full object-contain"
                    onPlay={(e) => {
                      if (acceptsEventsOf(e.currentTarget)) {
                        syncPlay(sourceRevisionKey, e.currentTarget);
                      }
                    }}
                    onPause={(e) => {
                      if (acceptsEventsOf(e.currentTarget)) {
                        // The element pauses before it ends, and the sequence needs to know that
                        // it was playing then (ADR 052).
                        sequencePlayback.notePause(e.currentTarget.ended);
                        syncPause(sourceRevisionKey, e.currentTarget);
                      }
                    }}
                    onEnded={(e) => {
                      if (acceptsEventsOf(e.currentTarget)) {
                        // At the end of a clip that another clip follows, playback goes on at
                        // the first frame of that clip (ADR 052), and the end of this element is
                        // no end of the playback.
                        if (!sequencePlayback.handleEnded()) {
                          syncEnded(sourceRevisionKey, e.currentTarget);
                        }
                      }
                    }}
                    onTimeUpdate={handleTimeUpdate}
                    onSeeking={(e) => {
                      if (acceptsEventsOf(e.currentTarget)) {
                        // A seek after the first frame moves the element away from a part
                        // that decoded.
                        recordDecodeEvidence(
                          e.currentTarget,
                          sourceRevisionKey,
                          "seeking",
                        );
                        syncSeeking(sourceRevisionKey, e.currentTarget);
                      }
                    }}
                    onSeeked={(e) => {
                      handleTimeUpdate(e);
                      if (acceptsEventsOf(e.currentTarget)) {
                        syncSeeked(sourceRevisionKey, e.currentTarget);
                      }
                    }}
                    onDurationChange={(e) => {
                      if (acceptsEventsOf(e.currentTarget)) {
                        syncBrowserDuration(sourceRevisionKey, e.currentTarget);
                        recordBrowserDuration(e.currentTarget);
                      }
                    }}
                    onLoadedMetadata={(e) => {
                      syncPictureRatio(e.currentTarget);
                      // A zero picture width here is only a suspicion. The picture check
                      // holds the ready path until a size arrives, or it reports a failure.
                      runPictureCheck(e.currentTarget, {
                        type: "loadedMetadata",
                        videoWidth: e.currentTarget.videoWidth,
                        probeWidth: media.probe.width,
                      });
                    }}
                    onResize={(e) => {
                      syncPictureRatio(e.currentTarget);
                      runPictureCheck(e.currentTarget, {
                        type: "resize",
                        videoWidth: e.currentTarget.videoWidth,
                      });
                    }}
                    onError={(e) => {
                      handleMediaError(e.currentTarget);
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
                       source has no anchor to protect.
                    5. !usesNativePcmCue: on macOS a ready calibration starts the Web Audio cue of
                       ADR 062 in place of this element, so the element does not load the file a
                       second time. The element stays the cue in each case that the Web Audio cue does
                       not cover, such as a calibration that is unavailable.
                    6. !isRecalibrating: a recalibration replaces the video element (ADR 063). The
                       first render of the new element still reads the calibration status of the
                       old one, so test 4 alone would mount this element beside the new video
                       element, and its load could delay the anchor.
                    The element is never drawn (`hidden`), so it has no control, no context menu and no
                    picture, and it needs none of the native feature attributes of the video. */}
                {media.probe.audio &&
                  !decodeFailed &&
                  !isMediaSource &&
                  attachedSourceRevisionKey === sourceRevisionKey &&
                  calibrationStatus !== "calibrating" &&
                  !usesNativePcmCue &&
                  !isRecalibrating && (
                    <audio
                      ref={scrubAudioRefCallback}
                      key={`scrub-${elementKey}`}
                      muted={isMuted}
                      preload="auto"
                      src={videoSrc}
                      aria-hidden="true"
                      className="hidden"
                    />
                  )}
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
                {hasImportError && <ImportErrorEmptyState error={error} />}

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

          {media && (
            <>
              {/* The In and Out badges, in the top-left corner of the picture box. They hide
                  while a notice shows, because the notices stack from the same corner. They
                  come first, so the spinner and the notices are drawn over them. Keyed on the
                  source, so a source change starts them again with no badge. */}
              {!decodeFailed && (
                <PreviewBoundaryBadges
                  key={`boundary-${sourceRevisionKey}`}
                  suppressed={hasNotice}
                  pictureBoxStyle={pictureBoxStyle}
                />
              )}

              {/* The buffering spinner, in the bottom-right corner, clear of the notices.
                  Keyed on the video element, so a source change and a reload start it again
                  with the listeners on the new element. */}
              {!decodeFailed && (
                <PreviewBufferingIndicator
                  key={`buffering-${elementKey}`}
                  videoRef={videoRef}
                />
              )}
            </>
          )}

          {/* The notification area. The notices stack from the top, so a loading
              chip, an import error and a playback error never cover each other. The
              area lets the pointer through, and each notice takes it back, so the
              gaps between the notices pass the pointer to the picture. The area ends
              above the bottom of the preview area (`preview-notice-area`), and the
              stack scrolls when it is taller, so it never covers the timecode row. The
              stack widens past a frame too narrow to read the notices in, centred on
              the frame, and the chip keeps to the left edge of the banners
              (`preview-notice-fit`). The area also shows for the
              notice of Export Frame when no clip is attached (`showsNoticeArea`). */}
          {showsNoticeArea(media !== null, hasFrameExportNotice) && (
            <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex preview-notice-area flex-col">
              {/* The up and down arrows scroll the stack while it overflows and one of
                  its controls has the focus (`SCROLL_KEYS_ATTRIBUTE`). */}
              <div
                className="preview-notice-fit flex min-h-0 flex-col gap-2 overflow-y-auto empty:hidden"
                data-scroll-keys
              >
                {media && (
                  <>
                    {showLoading && (
                      <div
                        className="pointer-events-auto flex items-center gap-2 self-start rounded-md border border-border/80 bg-background/90 px-2.5 py-1 text-xs text-foreground shadow-md backdrop-blur-xs"
                        aria-live="polite"
                      >
                        <Loader2 className="size-3.5 animate-spin text-primary" />
                        <span>{t("preview.loading")}</span>
                      </div>
                    )}
                    {hasImportError && (
                      <ImportErrorBanner
                        error={error}
                        onDismiss={dismissImportError}
                        onReturnFocus={returnFocusToPreview}
                      />
                    )}
                    {showsPlaybackErrorBanner && (
                      <PlaybackErrorBanner
                        key={playbackError}
                        code={playbackError}
                        onDismiss={dismissPlaybackError}
                        onReturnFocus={returnFocusToPreview}
                      />
                    )}
                    {shownStall !== null && (
                      <DecodeStallBanner
                        notice={presentDecodeStall(shownStall, timecodeDisplay)}
                        onDismiss={() => setDismissedStall(shownStall)}
                        onReturnFocus={returnFocusToPreview}
                      />
                    )}
                    <WaveformNotices onReturnFocus={returnFocusToPreview} />
                    {shownMediaSourceNotices.map((messageKey) => (
                      <MediaSourceNoticeBanner
                        key={messageKey}
                        messageKey={messageKey}
                        onDismiss={() =>
                          setMediaSourceNotices((current) =>
                            dismissMediaSourceNotice(current, messageKey),
                          )
                        }
                        onReturnFocus={returnFocusToPreview}
                      />
                    ))}
                  </>
                )}
                {/* The notice of Export Frame belongs to the action, so it stays
                    when no clip is attached (ADR 069). */}
                <FrameExportNotice onReturnFocus={returnFocusToPreview} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Preview Bottom Row: Timecode. `h-6` holds the row at a fixed height, so the video
          frame above keeps its size. Tabular figures keep every digit the same width, so
          the value does not shift while it counts. With no media, both values are
          placeholders in the muted colour, because no time is known. The row is `relative`,
          so the error of the typed timecode is placed against it and is never wider than the
          pane (PreviewTimecode). */}
      <div className="relative flex shrink-0 items-center justify-between px-1 pt-2">
        <div className="flex h-6 items-center font-mono text-[15px] leading-none font-medium tracking-tight tabular-nums">
          {sequenceMedia ? (
            <PreviewTimecode
              probe={sequenceMedia.probe}
              display={sequenceTimecodeDisplay}
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
