/**
 * The audio stream of a source: the override that the user chose, and the effective stream that
 * the export, the measurement, the envelope and the preview read (ADR 070).
 */

import type { AudioProbe, ListedAudioStream, MediaProbe } from "./types";

/**
 * The audio stream that the user chose for a source (ADR 070): its absolute index, and its codec,
 * its sample rate and its channel count from the probe of the import. The export request and the
 * request of a measurement carry it as the `audioStream` of the source, and the backend refuses
 * the request with `audioStreamChanged` when the file no longer has such a stream.
 */
export type AudioStreamOverride = {
  readonly index: number;
  readonly codec: string | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
};

/** The override of a listed stream: the facts of the import that the request carries. */
export function overrideOfStream(stream: ListedAudioStream): AudioStreamOverride {
  return {
    index: stream.index,
    codec: stream.codec,
    sampleRate: stream.sampleRate,
    channels: stream.channels,
  };
}

/** The facts of a probe that decide the effective audio stream of a source. */
export type AudioStreamSource = Pick<MediaProbe, "audio" | "formatNames">;

/**
 * True when ffprobe names the container of `probe` FLV, by the test of the preview path and of
 * the export (`formatNames` holds `flv`). An FLV has one audio stream for QuipClip (ADR 070): its
 * inputs hold the audio tags only, and every reader maps that audio as `0:a:0`. So an FLV gets no
 * Audio Track submenu and holds no override, however many audio streams ffprobe lists.
 */
export function isFlvProbe(probe: Pick<MediaProbe, "formatNames">): boolean {
  return probe.formatNames.includes("flv");
}

/**
 * The effective audio stream of a source (ADR 070): its override, or its preferred stream when it
 * has no override, or null for a source with no audio. Every reader of the stream takes it from
 * here: the export request, the request and the key of the measurement, the facts of the setup
 * step, the request of the envelope, and the preview (`previewAudioStreamOf`).
 *
 * The override is kept for the id of the source, which names one revision of the file (ADR 007),
 * so its facts are the facts of this probe. An FLV has one audio stream for QuipClip, and its
 * readers map it as `0:a:0`, so its effective stream is always its preferred stream.
 */
export function effectiveAudioStreamOf(
  probe: AudioStreamSource,
  override: AudioStreamOverride | undefined,
): AudioProbe | null {
  if (override === undefined || isFlvProbe(probe)) {
    return probe.audio;
  }
  return {
    index: override.index,
    codec: override.codec,
    sampleRate: override.sampleRate,
    channels: override.channels,
  };
}

/**
 * Returns the audio stream of a source that the remux windows of a MediaSource and the PCM
 * windows of the cue read, or null when the source has no audio (ADR 070). A window request of a
 * source that is not an FLV names this stream by its absolute index, and the preview decides from
 * its codec whether a window copies or transcodes the audio (ADR 046).
 *
 * It is the effective stream of the source (`effectiveAudioStreamOf`): the override of the user,
 * else the preferred stream. Each reader of the preview audio takes the stream from here, so the
 * requests, the copy decision and the cue read the stream that the export reads. An FLV has one
 * audio stream for QuipClip, so it gets its preferred stream, and its windows keep the mapping
 * `0:a:0` (`audioStreamField`).
 */
export function previewAudioStreamOf(
  probe: AudioStreamSource,
  override: AudioStreamOverride | undefined,
): AudioProbe | null {
  return effectiveAudioStreamOf(probe, override);
}

/**
 * `probe` with its effective audio stream in place of the preferred one, so a reader of
 * `probe.audio`, such as the facts of the setup step, reads the effective stream. The same object
 * when the source has no override.
 */
export function withEffectiveAudio<P extends AudioStreamSource>(
  probe: P,
  override: AudioStreamOverride | undefined,
): P {
  if (override === undefined || isFlvProbe(probe)) {
    return probe;
  }
  return { ...probe, audio: effectiveAudioStreamOf(probe, override) };
}

/**
 * The ids of the sources whose effective audio stream differs between the overrides `previous`
 * and `next`, among the sources of `probes`. A new override of the stream that was already
 * effective changes no effective stream.
 */
export function sourcesWithChangedEffectiveStream(
  probes: Readonly<Record<string, AudioStreamSource>>,
  previous: Readonly<Record<string, AudioStreamOverride>>,
  next: Readonly<Record<string, AudioStreamOverride>>,
): string[] {
  const ids = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const id of ids) {
    const probe = probes[id];
    if (probe === undefined) {
      continue;
    }
    const before = effectiveAudioStreamOf(probe, previous[id]);
    const after = effectiveAudioStreamOf(probe, next[id]);
    if (before?.index !== after?.index) {
      changed.push(id);
    }
  }
  return changed;
}
