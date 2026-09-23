/**
 * Pure helpers for the panel that the preview shows when the web view cannot play the open
 * source.
 *
 * ADR 003 decodes the preview with the native video element and checks the decision at
 * runtime. This module holds two rules:
 *
 * - `resolvePictureCheck` detects a source that loads with no picture and never fires
 *   `error`. A zero picture width at `loadedmetadata` is only a suspicion, because WebKit can
 *   report 0 there and set the size later, and a slow drive can delay the first frame. The
 *   check waits for a picture size or a presented frame. It reports a failure only when the
 *   element holds the data of a frame and still reports no picture.
 * - `presentDecodeFailure` states what the panel says. The message follows the trigger: a
 *   missing picture names the codec, an `error` event names what its error code and the
 *   container indicate. The hint gives the step that can make the file play.
 *
 * The presenter returns translation keys and values without calling the i18n runtime
 * (ADR 011). Each combination of known and missing fields has a complete message of its
 * own, so no sentence is assembled from fragments.
 */

import type { MediaProbe } from "@/features/media";
import { splitFileName } from "@/lib/fileName";

// ---------------------------------------------------------------------------------------
// Picture check
// ---------------------------------------------------------------------------------------

/** How long each wait of the check lasts before it reads the element again. */
export const PICTURE_CHECK_INTERVAL_MS = 1500;

/**
 * The longest total wait after `loadedmetadata`. After it, a check that has no evidence of a
 * failure takes the ready path.
 */
export const PICTURE_CHECK_MAX_WAIT_MS = 6000;

/**
 * `HTMLMediaElement.HAVE_CURRENT_DATA`. From this ready state on, the element holds the data
 * of the current frame, so a decodable picture has a size.
 */
export const HAVE_CURRENT_DATA = 2;

/**
 * State of the picture check for one video element.
 *
 * - `idle`: the element has not loaded metadata.
 * - `pending`: metadata loaded with a zero picture width for a source that has a video
 *   stream. The pane has not taken the ready path, and a wait runs.
 * - `decoded`: the pane took the ready path, because the element reports a picture size or
 *   presented a frame, or because the longest wait ended without evidence of a failure.
 * - `failed`: the element holds frame data and reports no picture. The pane shows the
 *   decode-failure panel.
 */
export type PictureCheckState = "idle" | "pending" | "decoded" | "failed";

/** An element event, or the end of one wait, with what the element reports then. */
export type PictureCheckEvent =
  | {
      readonly type: "loadedMetadata";
      /** `HTMLVideoElement.videoWidth` at the event. */
      readonly videoWidth: number;
      /** The width of the video stream that ffprobe reported. */
      readonly probeWidth: number;
    }
  | { readonly type: "resize"; readonly videoWidth: number }
  /** A `requestVideoFrameCallback` callback: the element presented a frame. */
  | { readonly type: "frame" }
  | {
      readonly type: "timeout";
      readonly videoWidth: number;
      /** `HTMLMediaElement.readyState` at the end of the wait. */
      readonly readyState: number;
      /** Milliseconds since the check started to wait. */
      readonly elapsedMs: number;
    };

/**
 * What the pane does after an event.
 *
 * - `none`: nothing.
 * - `ready`: stop the wait, then take the normal ready path (`syncReady` and the rest).
 * - `wait`: start a wait, and do not take the ready path yet.
 * - `fail`: stop the wait, then show the decode-failure panel.
 */
export type PictureCheckAction = "none" | "ready" | "wait" | "fail";

export interface PictureCheckResult {
  readonly state: PictureCheckState;
  readonly action: PictureCheckAction;
}

/**
 * Returns the next state of the picture check and the action for the pane.
 *
 * WebView2 without HEVC support, and similar cases, can play the audio of a source with a
 * black picture and never fire `error`. The element then reports a zero picture width, while
 * ffprobe reports the coded width of the video stream. No frame callback arrives in that
 * state, so calibration never leaves `calibrating`.
 *
 * A picture size or a presented frame proves a picture. A failure needs the opposite proof:
 * the element holds the data of a frame (`HAVE_CURRENT_DATA`) and still reports width 0. A
 * slow drive that has not delivered the first frame is not a failure, so the check waits
 * again, up to `PICTURE_CHECK_MAX_WAIT_MS`. After that it takes the ready path, as the pane
 * did before this check existed.
 *
 * The rule decides only when the pane takes the ready path and when it shows the panel. It
 * does not change the calibration state machine (ADR 003).
 */
export function resolvePictureCheck(
  state: PictureCheckState,
  event: PictureCheckEvent,
): PictureCheckResult {
  // The panel replaces the element, so a failed check is final for that element.
  if (state === "failed") {
    return { state, action: "none" };
  }

  switch (event.type) {
    case "loadedMetadata":
      // Every `loadedmetadata` decides again, as the pane did before this check existed.
      if (event.videoWidth === 0 && event.probeWidth > 0) {
        return { state: "pending", action: "wait" };
      }
      return { state: "decoded", action: "ready" };
    case "resize":
      if (state === "pending" && event.videoWidth > 0) {
        return { state: "decoded", action: "ready" };
      }
      return { state, action: "none" };
    case "frame":
      if (state === "pending") {
        return { state: "decoded", action: "ready" };
      }
      return { state, action: "none" };
    case "timeout":
      if (state !== "pending") {
        return { state, action: "none" };
      }
      // A size that arrived without a `resize` event still counts.
      if (event.videoWidth > 0) {
        return { state: "decoded", action: "ready" };
      }
      if (event.readyState >= HAVE_CURRENT_DATA) {
        return { state: "failed", action: "fail" };
      }
      if (event.elapsedMs < PICTURE_CHECK_MAX_WAIT_MS) {
        return { state: "pending", action: "wait" };
      }
      return { state: "decoded", action: "ready" };
  }
}

// ---------------------------------------------------------------------------------------
// Panel text
// ---------------------------------------------------------------------------------------

/** `MediaError.code` values (HTML Living Standard). Node has no `MediaError` global. */
export const MEDIA_ERR_ABORTED = 1;
export const MEDIA_ERR_NETWORK = 2;
export const MEDIA_ERR_DECODE = 3;
export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/** What made the pane show the panel. */
export type DecodeFailureTrigger =
  /** The picture check failed: the element plays no picture. */
  | { readonly kind: "pictureMissing" }
  /** The element fired `error`. `code` is `element.error?.code`, or null without one. */
  | { readonly kind: "mediaError"; readonly code: number | null };

/** The operating system of the web view. The two supported ones, and every other one. */
export type PreviewPlatform = "windows" | "macos" | "other";

/** Exactly the probe fields that the panel reads. */
export type DecodeFailureProbe = Pick<
  MediaProbe,
  "formatNames" | "videoCodec" | "videoProfile" | "pixelFormat" | "bitDepth"
>;

export interface DecodeFailureInput {
  readonly probe: DecodeFailureProbe;
  /** The base name of the open file. Only its extension is read. */
  readonly fileName: string;
  readonly trigger: DecodeFailureTrigger;
  readonly platform: PreviewPlatform;
}

/** The two messages that name the video stream. Each has four variants. */
const CODEC_REASON_KEYS = {
  unsupportedCodec: {
    full: "preview.decodeFailure.unsupportedCodec.full",
    noProfile: "preview.decodeFailure.unsupportedCodec.noProfile",
    noPixelFormat: "preview.decodeFailure.unsupportedCodec.noPixelFormat",
    codecOnly: "preview.decodeFailure.unsupportedCodec.codecOnly",
  },
  cannotPlay: {
    full: "preview.decodeFailure.cannotPlay.full",
    noProfile: "preview.decodeFailure.cannotPlay.noProfile",
    noPixelFormat: "preview.decodeFailure.cannotPlay.noPixelFormat",
    codecOnly: "preview.decodeFailure.cannotPlay.codecOnly",
  },
} as const;

type CodecReasonFamily = keyof typeof CODEC_REASON_KEYS;
type CodecReasonKey<V extends keyof (typeof CODEC_REASON_KEYS)[CodecReasonFamily]> =
  (typeof CODEC_REASON_KEYS)[CodecReasonFamily][V];

/**
 * The line that says why the file does not play.
 *
 * `shape` names the placeholders of `key`, and `values` holds exactly those. Two keys with
 * one shape have the same placeholders, so the pane can pass them to `Trans` with one type.
 * The panel shows each value in a monospace font.
 */
export type DecodeFailureReason =
  | {
      readonly shape: "full";
      readonly key: CodecReasonKey<"full">;
      readonly values: {
        readonly codec: string;
        readonly profile: string;
        readonly pixelFormat: string;
      };
    }
  | {
      readonly shape: "noProfile";
      readonly key: CodecReasonKey<"noProfile">;
      readonly values: { readonly codec: string; readonly pixelFormat: string };
    }
  | {
      readonly shape: "noPixelFormat";
      readonly key: CodecReasonKey<"noPixelFormat">;
      readonly values: { readonly codec: string; readonly profile: string };
    }
  | {
      readonly shape: "codecOnly";
      readonly key: CodecReasonKey<"codecOnly">;
      readonly values: { readonly codec: string };
    }
  | {
      readonly shape: "container";
      readonly key: "preview.decodeFailure.unsupportedContainer";
      readonly values: { readonly container: string };
    }
  | {
      readonly shape: "plain";
      readonly key: "preview.decodeFailure.readFailed";
    };

export type DecodeFailureReasonKey = DecodeFailureReason["key"];

export type DecodeFailureHintKey =
  | "preview.decodeFailure.hint.installHevc"
  | "preview.decodeFailure.hint.convertH264"
  | "preview.decodeFailure.hint.convertMp4";

export interface DecodeFailureView {
  readonly reason: DecodeFailureReason;
  /** The step that can make the file play, or null when the panel has none to offer. */
  readonly hintKey: DecodeFailureHintKey | null;
}

/**
 * Display names for the ffprobe codec names whose display name is not the codec name in
 * capitals. A codec name that is not in this table is shown as ffprobe reports it, because
 * it is a technical identifier (ADR 011).
 */
const CODEC_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  h264: "H.264",
  h263: "H.263",
  hevc: "HEVC",
  vvc: "VVC",
  av1: "AV1",
  vp8: "VP8",
  vp9: "VP9",
  mpeg1video: "MPEG-1",
  mpeg2video: "MPEG-2",
  mpeg4: "MPEG-4",
  vc1: "VC-1",
  prores: "ProRes",
  dnxhd: "DNxHD",
  cfhd: "CineForm",
  mjpeg: "MJPEG",
  ffv1: "FFV1",
  theora: "Theora",
};

/**
 * Values that ffprobe writes in place of a profile or a pixel format that it cannot name.
 * They are compared in lower case.
 */
const UNSTATED_VALUES: ReadonlySet<string> = new Set(["", "unknown", "n/a"]);

/**
 * The ffmpeg pixel formats with 4:2:0 chroma: the planar YUV families, with or without full
 * range and alpha, and the semi-planar NV12, NV21, and P01x families. The pattern matches
 * the start of the name, so every bit depth and byte order is included.
 */
const CHROMA_420_PIXEL_FORMAT = /^(?:yuvj?a?420p|nv12|nv21|p01[026])/;

/** The ffmpeg pixel formats with 8-bit samples and 4:2:0 chroma. */
const EIGHT_BIT_420_PIXEL_FORMATS: ReadonlySet<string> = new Set([
  "yuv420p",
  "yuvj420p",
  "yuva420p",
  "nv12",
  "nv21",
]);

/**
 * Containers that the web view of a platform typically cannot open, by ffprobe format name.
 * The table holds only containers that the open dialog accepts.
 */
const UNPLAYABLE_CONTAINERS: readonly {
  readonly formatName: string;
  readonly displayName: string;
  readonly platforms: readonly PreviewPlatform[];
}[] = [
  { formatName: "avi", displayName: "AVI", platforms: ["windows", "macos", "other"] },
  // ffprobe names the container of a WMV file ASF. The user knows the file as WMV.
  { formatName: "asf", displayName: "WMV", platforms: ["windows", "macos", "other"] },
  {
    formatName: "mpegts",
    displayName: "MPEG-TS",
    platforms: ["windows", "macos", "other"],
  },
  { formatName: "flv", displayName: "FLV", platforms: ["windows", "macos", "other"] },
  // WebView2 opens Matroska through the Chromium demuxer. WKWebView does not.
  { formatName: "matroska", displayName: "MKV", platforms: ["macos"] },
];

/**
 * Returns the display name of an ffprobe codec name, such as `HEVC` for `hevc`.
 *
 * @param codec The codec name that ffprobe reported. The backend guarantees that it is not
 *   blank.
 */
export function formatCodecName(codec: string): string {
  const trimmed = codec.trim();
  return CODEC_DISPLAY_NAMES[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Returns a profile or a pixel format as ffprobe reports it, or null when ffprobe did not
 * state one.
 */
function stated(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return UNSTATED_VALUES.has(trimmed.toLowerCase()) ? null : trimmed;
}

/**
 * Classifies the chroma subsampling of an ffmpeg pixel format.
 *
 * Returns `unknown` when ffprobe states no pixel format. A stated format that is not a 4:2:0
 * format is `other`, such as `yuv422p10le` or `yuv444p`.
 */
export function classifyChroma(
  pixelFormat: string | null,
): "4:2:0" | "other" | "unknown" {
  const value = stated(pixelFormat);
  if (value === null) {
    return "unknown";
  }
  return CHROMA_420_PIXEL_FORMAT.test(value.toLowerCase()) ? "4:2:0" : "other";
}

/**
 * Returns the bit depth that an ffmpeg pixel format names, or null when its name states
 * none. `p010le` and `yuv420p10le` name 10 bits, and `p016le` names 16 bits.
 */
export function pixelFormatBitDepth(pixelFormat: string | null): number | null {
  const value = stated(pixelFormat)?.toLowerCase() ?? null;
  if (value === null) {
    return null;
  }
  // The semi-planar P0xx family: p010, p012, p016.
  const semiPlanar = /^p0(\d{2})/.exec(value);
  if (semiPlanar) {
    return Number(semiPlanar[1]);
  }
  // A planar YUV format with a depth suffix, such as yuv420p10le or yuv444p12be.
  const planar = /^yuvj?a?4\d\dp(\d{1,2})(?:le|be)?$/.exec(value);
  if (planar) {
    return Number(planar[1]);
  }
  // A planar YUV format without a suffix, or NV12 and its relatives, has 8-bit samples.
  if (/^yuvj?a?4\d\dp$/.test(value) || /^nv\d{2}$/.test(value)) {
    return 8;
  }
  return null;
}

/**
 * Reports whether the source has more than 10 bits per sample. The probe's bit depth and
 * the depth that the pixel format names both count.
 */
function exceedsTenBits(probe: DecodeFailureProbe): boolean {
  const formatDepth = pixelFormatBitDepth(probe.pixelFormat);
  return (
    (probe.bitDepth !== null && probe.bitDepth > 10) ||
    (formatDepth !== null && formatDepth > 10)
  );
}

/**
 * Reports whether the video stream is already H.264 with 8-bit samples and 4:2:0 chroma,
 * the stream that both web views decode. An unstated pixel format does not confirm it.
 */
function isBrowserSafeH264(probe: DecodeFailureProbe): boolean {
  const pixelFormat = stated(probe.pixelFormat)?.toLowerCase() ?? null;
  return (
    probe.videoCodec.trim().toLowerCase() === "h264" &&
    pixelFormat !== null &&
    EIGHT_BIT_420_PIXEL_FORMATS.has(pixelFormat) &&
    (probe.bitDepth === null || probe.bitDepth === 8)
  );
}

/**
 * Returns the display name of a container that the platform typically cannot open, or null.
 *
 * A WebM file reports the same format names as a Matroska file, and WKWebView opens WebM, so
 * the `.webm` extension exempts a file from the Matroska entry.
 */
export function findUnplayableContainer(
  formatNames: readonly string[],
  fileName: string,
  platform: PreviewPlatform,
): string | null {
  const names = formatNames.map((name) => name.trim().toLowerCase());
  const isWebM = splitFileName(fileName).extension.toLowerCase() === ".webm";
  for (const entry of UNPLAYABLE_CONTAINERS) {
    if (!entry.platforms.includes(platform) || !names.includes(entry.formatName)) {
      continue;
    }
    if (entry.formatName === "matroska" && isWebM) {
      continue;
    }
    return entry.displayName;
  }
  return null;
}

/** Selects the variant of a codec message that matches the stated probe fields. */
function codecReason(
  family: CodecReasonFamily,
  probe: DecodeFailureProbe,
): DecodeFailureReason {
  const keys = CODEC_REASON_KEYS[family];
  const codec = formatCodecName(probe.videoCodec);
  const profile = stated(probe.videoProfile);
  const pixelFormat = stated(probe.pixelFormat);
  if (profile !== null && pixelFormat !== null) {
    return { shape: "full", key: keys.full, values: { codec, profile, pixelFormat } };
  }
  if (pixelFormat !== null) {
    return { shape: "noProfile", key: keys.noProfile, values: { codec, pixelFormat } };
  }
  if (profile !== null) {
    return {
      shape: "noPixelFormat",
      key: keys.noPixelFormat,
      values: { codec, profile },
    };
  }
  return { shape: "codecOnly", key: keys.codecOnly, values: { codec } };
}

/**
 * The step for a video stream that the system player cannot decode.
 *
 * WebView2 decodes HEVC only through the HEVC Video Extensions, and those decode 4:2:0
 * chroma at 8 or 10 bits only. The Store step therefore needs Windows, HEVC, 4:2:0 or
 * unstated chroma, and no more than 10 bits. Every other source gets the conversion to
 * H.264.
 */
function codecHint(
  probe: DecodeFailureProbe,
  platform: PreviewPlatform,
): DecodeFailureHintKey {
  const isHevc = probe.videoCodec.trim().toLowerCase() === "hevc";
  const chroma = classifyChroma(probe.pixelFormat);
  return platform === "windows" &&
    isHevc &&
    chroma !== "other" &&
    !exceedsTenBits(probe)
    ? "preview.decodeFailure.hint.installHevc"
    : "preview.decodeFailure.hint.convertH264";
}

/**
 * Returns the panel view for a source that the web view cannot play.
 *
 * - A missing picture names the codec, the profile, and the pixel format that the system
 *   player does not support.
 * - `MEDIA_ERR_ABORTED` and `MEDIA_ERR_NETWORK` say that QuipClip could not read the file.
 *   The panel has no hint for them.
 * - `MEDIA_ERR_SRC_NOT_SUPPORTED` for a container that the platform typically cannot open
 *   names the container. It suggests MP4 when the video is already H.264 with 8-bit samples
 *   and 4:2:0 chroma, and the conversion to that H.264 otherwise.
 * - Every other error says that QuipClip cannot play the file, and it names the video stream
 *   without a claim about the cause.
 *
 * The codec takes its display name. The profile and the pixel format stay as ffprobe reports
 * them, such as `Main 10` and `yuv420p10le`. A missing profile or pixel format selects the
 * variant without that part.
 */
export function presentDecodeFailure(input: DecodeFailureInput): DecodeFailureView {
  const { probe, trigger, platform } = input;

  if (trigger.kind === "pictureMissing") {
    return {
      reason: codecReason("unsupportedCodec", probe),
      hintKey: codecHint(probe, platform),
    };
  }

  if (trigger.code === MEDIA_ERR_ABORTED || trigger.code === MEDIA_ERR_NETWORK) {
    return {
      reason: { shape: "plain", key: "preview.decodeFailure.readFailed" },
      hintKey: null,
    };
  }

  if (trigger.code === MEDIA_ERR_SRC_NOT_SUPPORTED) {
    const container = findUnplayableContainer(
      probe.formatNames,
      input.fileName,
      platform,
    );
    if (container !== null) {
      return {
        reason: {
          shape: "container",
          key: "preview.decodeFailure.unsupportedContainer",
          values: { container },
        },
        hintKey: isBrowserSafeH264(probe)
          ? "preview.decodeFailure.hint.convertMp4"
          : "preview.decodeFailure.hint.convertH264",
      };
    }
  }

  return {
    reason: codecReason("cannotPlay", probe),
    hintKey: codecHint(probe, platform),
  };
}
