/**
 * How the preview plays a source (ADR 046): the web view opens the file itself, or a
 * MediaSource plays remux windows of it.
 */

import type { MediaProbe } from "@/features/media";
import { mediaDurationFor, videoStartSeconds } from "@/features/playback/mse/timeline";
import type {
  WindowAudio,
  WindowContainer,
} from "@/features/playback/mse/windowClient";
import { findUnplayableFormat, type PreviewPlatform } from "./decodeFailure";

/** The path of a source. */
export type PreviewPath =
  /** The element opens the file through the asset protocol (ADR 003). */
  | { readonly kind: "native" }
  /** A MediaSource plays remux windows of the file. */
  | {
      readonly kind: "mediaSource";
      readonly container: WindowContainer;
      readonly audio: WindowAudio;
      /** The absolute source time of `videoStartPts`. */
      readonly videoStartSeconds: number;
      /** The `duration` of the MediaSource. */
      readonly durationSeconds: number;
    };

/** The probe fields that the choice reads. */
export type PreviewPathProbe = Pick<
  MediaProbe,
  | "formatNames"
  | "videoCodec"
  | "audio"
  | "approximateDurationSeconds"
  | "videoStartPts"
  | "videoTimeBase"
>;

export interface PreviewPathInput {
  readonly probe: PreviewPathProbe;
  /** The base name of the open file. Only its extension is read. */
  readonly fileName: string;
  readonly platform: PreviewPlatform;
  /** `MediaSource.isTypeSupported`, or null when the web view has no MediaSource. */
  readonly isTypeSupported: ((type: string) => boolean) | null;
}

/** The containers that the remux windows read, by ffprobe format name. */
const WINDOW_CONTAINERS: Readonly<Record<string, WindowContainer>> = {
  flv: "flv",
  mpegts: "mpegTs",
  matroska: "matroska",
};

/**
 * A codec string for each video codec that a window can copy. FFmpeg writes HEVC into MP4 with
 * the `hev1` sample entry. The string of the first init segment decides in the end.
 */
const VIDEO_CODECS: Readonly<Record<string, string>> = {
  h264: "avc1.640028",
  hevc: "hev1.1.6.L93.B0",
};

/** A codec string for each audio codec that a window can copy into MP4. */
const AUDIO_CODECS: Readonly<Record<string, string>> = {
  aac: "mp4a.40.2",
  opus: "opus",
  flac: "flac",
  ac3: "ac-3",
  eac3: "ec-3",
};

const NATIVE: PreviewPath = { kind: "native" };

/**
 * Chooses the path of a source. A source takes the MediaSource path when the platform cannot
 * open its container, the container is one that the windows read, the web view has a
 * MediaSource that accepts the video codec, and the probe gives a duration and a video start.
 * Every other source keeps the native element, which shows the decode failure panel when it
 * fails. Audio that the web view refuses is transcoded. MP3 in MP4 is refused by both web views
 * (ADR 046 measurement 15).
 */
export function choosePreviewPath(input: PreviewPathInput): PreviewPath {
  const { probe, isTypeSupported } = input;
  const format = findUnplayableFormat(
    probe.formatNames,
    input.fileName,
    input.platform,
  );
  const container = format === null ? undefined : WINDOW_CONTAINERS[format];
  if (container === undefined || isTypeSupported === null) {
    return NATIVE;
  }
  const videoCodec = VIDEO_CODECS[probe.videoCodec.trim().toLowerCase()];
  if (
    videoCodec === undefined ||
    !supports(isTypeSupported, `video/mp4; codecs="${videoCodec}"`)
  ) {
    return NATIVE;
  }
  const durationSeconds = mediaDurationFor(probe.approximateDurationSeconds);
  const startSeconds = videoStartSeconds(probe.videoStartPts, probe.videoTimeBase);
  if (durationSeconds === null || startSeconds === null) {
    return NATIVE;
  }
  return {
    kind: "mediaSource",
    container,
    audio: audioOf(probe.audio?.codec ?? null, probe.audio !== null, isTypeSupported),
    videoStartSeconds: startSeconds,
    durationSeconds,
  };
}

function audioOf(
  codec: string | null,
  hasAudio: boolean,
  isTypeSupported: (type: string) => boolean,
): WindowAudio {
  if (!hasAudio) {
    return "omit";
  }
  const string = codec === null ? undefined : AUDIO_CODECS[codec.trim().toLowerCase()];
  return string !== undefined &&
    supports(isTypeSupported, `audio/mp4; codecs="${string}"`)
    ? "copy"
    : "transcode";
}

function supports(isTypeSupported: (type: string) => boolean, type: string): boolean {
  try {
    return isTypeSupported(type);
  } catch {
    return false;
  }
}

/** `MediaSource.isTypeSupported` of this web view, or null without a MediaSource. */
export function mediaSourceSupport(): ((type: string) => boolean) | null {
  if (
    typeof MediaSource === "undefined" ||
    typeof MediaSource.isTypeSupported !== "function"
  ) {
    return null;
  }
  return (type) => MediaSource.isTypeSupported(type);
}
