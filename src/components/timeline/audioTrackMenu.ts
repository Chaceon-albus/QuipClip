/**
 * The model of the "Audio Track" submenu of a clip label (ADR 070).
 *
 * The submenu shows only for a source with two or more audio streams. It has one item for each
 * stream, in the order of the file, and a mark on the effective stream of the source. The menus of
 * two clips of one source show and set the same override, because the override is kept for the
 * source id.
 */

import {
  effectiveAudioStreamOf,
  isFlvProbe,
  type AudioStreamOverride,
} from "@/features/media/audioStream";
import type { ListedAudioStream, MediaProbe } from "@/features/media/types";

/** One item of the submenu: one audio stream of the file. */
export interface AudioTrackItem {
  /** The stream, which `choose` of the override store takes. */
  readonly stream: ListedAudioStream;
  /** The number of the stream among the audio streams of the file, from 1. */
  readonly number: number;
  /** The title of the stream, else its language, or null when the file gives neither. */
  readonly name: string | null;
}

/** The submenu of one source. */
export interface AudioTrackMenu {
  readonly items: readonly AudioTrackItem[];
  /** The probe of the import of the source, which `choose` of the override store takes. */
  readonly probe: Pick<MediaProbe, "formatNames">;
  /** The absolute index of the effective stream, which has the mark. */
  readonly checkedIndex: number | null;
  /**
   * True when the submenu shows the note that the preview can play another track: for a source
   * that the web view opens itself.
   */
  readonly showsPreviewNote: boolean;
}

/**
 * How the preview plays a source (`PreviewPath.kind`, ADR 046): the web view opens the file
 * itself, or a MediaSource plays remux windows of it.
 */
export type AudioTrackPreviewKind = "native" | "mediaSource";

/**
 * The submenu of a source with the probe `probe` and the override `override`, or null when the
 * source has fewer than two audio streams, or is an FLV: such a source has no submenu, and nothing
 * else changes for it. An FLV has one audio stream for QuipClip, however many ffprobe lists
 * (`isFlvProbe`). `previewKind` is how the preview plays the source, which decides the note.
 */
export function presentAudioTrackMenu(
  probe: Pick<MediaProbe, "audio" | "audioStreams" | "formatNames"> | undefined,
  override: AudioStreamOverride | undefined,
  previewKind: AudioTrackPreviewKind,
): AudioTrackMenu | null {
  const streams = probe?.audioStreams ?? [];
  if (probe === undefined || streams.length < 2 || isFlvProbe(probe)) {
    return null;
  }
  return {
    items: streams.map((stream, position) => ({
      stream,
      number: position + 1,
      name: stream.title ?? stream.language,
    })),
    probe,
    checkedIndex: effectiveAudioStreamOf(probe, override)?.index ?? null,
    // The element of a native source plays the track that the web view chooses, which QuipClip
    // does not know, so the note shows for each effective stream, also the preferred one. The
    // windows of a MediaSource source map the effective stream, so its preview plays the track
    // that the export uses, and it gets no note (ADR 070).
    showsPreviewNote: previewKind === "native",
  };
}

/** The catalog keys of the items of the submenu. */
export type AudioTrackItemKey =
  | "timeline.clip.audioTrackNamed"
  | "timeline.clip.audioTrackUnnamed"
  | "timeline.clip.audioTrackNamedNoChannels"
  | "timeline.clip.audioTrackUnnamedNoChannels";

/**
 * The narrow view of `t` that the text of an item needs (ADR 011: a helper that returns a
 * `string` names only its own keys).
 */
export type AudioTrackTranslate = (
  key: AudioTrackItemKey | "timeline.clip.audioTrackUnknownCodec",
  options?: Readonly<Record<string, string | number>>,
) => string;

/**
 * The text of an item: the number of the stream, its title or its language when the file gives
 * one, its codec and its channel count. A codec that the probe does not name shows as unknown, and
 * a channel count that it does not give is left out.
 */
export function audioTrackItemText(
  item: AudioTrackItem,
  t: AudioTrackTranslate,
): string {
  const codec = item.stream.codec ?? t("timeline.clip.audioTrackUnknownCodec");
  const channels = item.stream.channels;
  const values: Record<string, string | number> = { number: item.number, codec };
  if (item.name !== null) {
    values.name = item.name;
  }
  if (channels === null) {
    return t(
      item.name === null
        ? "timeline.clip.audioTrackUnnamedNoChannels"
        : "timeline.clip.audioTrackNamedNoChannels",
      values,
    );
  }
  return t(
    item.name === null
      ? "timeline.clip.audioTrackUnnamed"
      : "timeline.clip.audioTrackNamed",
    { ...values, count: channels },
  );
}
