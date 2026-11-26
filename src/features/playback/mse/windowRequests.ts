/**
 * The parts of the window requests that name the audio stream of a source (ADR 070).
 *
 * The page reads one audio stream of a source in its remux windows and in the PCM windows of
 * the cue (`previewAudioStreamOf`). A window of a source that is not an FLV names that stream by
 * its absolute index, and FFmpeg maps it by that index.
 */

import type { Rational } from "@/types/project";
import type { WindowContainer, WindowRequest } from "./windowClient";

/**
 * The audio stream field of a window request (ADR 070): the absolute index `streamIndex` for a
 * source that is not an FLV. An FLV window maps the one audio stream of the tags that Rust
 * writes, so its request carries no index. A source with no audio stream carries none either.
 */
export function audioStreamField(
  container: WindowContainer,
  streamIndex: number | null,
): Pick<WindowRequest, "audioStreamIndex"> {
  return container === "flv" || streamIndex === null
    ? {}
    : { audioStreamIndex: streamIndex };
}

/** The file and the audio stream that a PCM window of the audio lane reads. */
export interface PcmWindowSource {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  /** Not `flv`: the PCM of an FLV comes with its video windows. */
  readonly container: WindowContainer;
  /** The container start time of the probe, for the input seek of the window. */
  readonly formatStartTime: Rational | null;
  readonly audioCodec: string | null;
  /** The absolute index of the audio stream that the window decodes (`previewAudioStreamOf`). */
  readonly audioStreamIndex: number | null;
}

/** The request of the PCM window of the cue that starts at `startSeconds` of the source. */
export function pcmWindowRequest(
  source: PcmWindowSource,
  startSeconds: number,
): WindowRequest {
  return {
    path: source.path,
    size: source.size,
    mtime: source.mtime,
    lane: "audio",
    container: source.container,
    start: { kind: "time", seconds: startSeconds },
    formatStartTime: source.formatStartTime,
    audio: "copy",
    audioCodec: source.audioCodec,
    ...audioStreamField(source.container, source.audioStreamIndex),
  };
}
