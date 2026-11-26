/**
 * The audio stream of a source that the preview reads (ADR 070).
 */

import type { AudioProbe, MediaProbe } from "./types";

/**
 * Returns the audio stream of a source that the remux windows of a MediaSource and the PCM
 * windows of the cue read, or null when the source has no audio (ADR 070). A window request of a
 * source that is not an FLV names this stream by its absolute index, and the preview decides from
 * its codec whether a window copies or transcodes the audio (ADR 046).
 *
 * It is the preferred stream of the probe, because the user cannot choose another one. Each
 * reader of the preview audio takes the stream from here, so the requests, the copy decision and
 * the cue read one stream.
 */
export function previewAudioStreamOf(
  probe: Pick<MediaProbe, "audio">,
): AudioProbe | null {
  return probe.audio;
}
