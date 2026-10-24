/**
 * When the export setup step offers a copy of the audio, and what the request then asks for
 * (ADR 048).
 *
 * An export of one segment can copy the packets of the source audio in place of an encode. The
 * backend decides at the start of the export whether it copies (`copy::decide` in
 * `src-tauri/src/ffmpeg/export/copy.rs`), and it encodes the audio when it does not copy, without
 * an error. The setup step offers the copy only where the facts of the import probe allow one:
 * one segment, a source format, a sample rate, and a codec that the muxer of the output takes.
 * The lists below are copies of the Rust lists, and `audioCopy.test.ts` reads those from the Rust
 * source.
 *
 * The backend reads facts that the step does not have, so a copy that the step offers can still
 * be an encode: an audio stream that holds no packets, an In point before zero, and where the
 * audio starts and ends inside the segment and the gaps inside it. The other way round, the
 * export reads the sample rate of an MPEG-TS stream that the import probe missed from its first
 * packet, so the backend could copy some audio that the step does not offer. Hiding a copy is the
 * safe side of that difference.
 */

import type { MediaProbe } from "@/features/media/types";
import type { PresetContainer } from "@/features/settings/types";
import type { ExportAudioMode, ExportStreams } from "./types";

/** A muxer that writes the output file, by the name that the backend gives it. */
export type ExportMuxer = "mp4" | "mov" | "matroska";

/** One audio codec whose packets an export copies, and the muxers that take them. */
export type CopyableAudio = {
  /** The codec, by the name that ffprobe gives it, as `AudioProbe.codec` holds it. */
  readonly codec: string;
  readonly muxers: readonly ExportMuxer[];
};

/** The codecs whose packets an export copies, each with the muxers that take them. */
export const COPYABLE_AUDIO: readonly CopyableAudio[] = [
  { codec: "aac", muxers: ["mp4", "mov", "matroska"] },
  { codec: "mp3", muxers: ["mp4", "mov", "matroska"] },
  { codec: "ac3", muxers: ["mp4", "mov", "matroska"] },
  { codec: "opus", muxers: ["matroska"] },
];

/**
 * The demuxers of the sources whose audio an export copies, each by a name that the probe lists
 * in `formatNames`.
 */
export const COPY_SOURCE_FORMATS: readonly string[] = [
  "mov",
  "matroska",
  "mpegts",
  "flv",
];

/** The lowest sample rate, in hertz, of audio that an export copies. */
export const MIN_COPY_SAMPLE_RATE = 32000;

/**
 * The muxer that writes the output of an export, as the backend selects it (`muxer_of` in
 * `src-tauri/src/ffmpeg/export/arguments.rs`). An audio-only export of a MOV preset writes an
 * `.m4a` through the `mp4` muxer (ADR 036).
 */
export function exportMuxer(
  container: PresetContainer,
  streams: ExportStreams,
): ExportMuxer {
  switch (container) {
    case "mkv":
      return "matroska";
    case "mov":
      return streams === "audioOnly" ? "mp4" : "mov";
    case "mp4":
      return "mp4";
  }
}

/** The facts of the setup step that decide whether it offers a copy of the audio. */
export type AudioCopyFacts = {
  /** The probe of the open source, or null with no source. */
  readonly probe: Pick<MediaProbe, "formatNames" | "audio"> | null;
  /** The container of the selected preset. */
  readonly container: PresetContainer;
  /** The streams that the export writes. */
  readonly streams: ExportStreams;
  /** The number of segments of the active source. */
  readonly segmentCount: number;
};

/**
 * True when the setup step offers a copy of the audio: the export writes the audio of one
 * segment, from a source whose format, sample rate and codec the backend copies into the muxer
 * of the output. The backend can still encode the audio of such an export, for a reason that
 * only the export reads.
 */
export function canCopyAudio({
  probe,
  container,
  streams,
  segmentCount,
}: AudioCopyFacts): boolean {
  const audio = probe?.audio ?? null;
  if (probe === null || audio === null) {
    return false;
  }
  if (segmentCount !== 1 || streams === "videoOnly") {
    return false;
  }
  if (!probe.formatNames.some((name) => COPY_SOURCE_FORMATS.includes(name))) {
    return false;
  }
  if (audio.sampleRate === null || audio.sampleRate < MIN_COPY_SAMPLE_RATE) {
    return false;
  }
  const muxer = exportMuxer(container, streams);
  return COPYABLE_AUDIO.some(
    (copyable) => copyable.codec === audio.codec && copyable.muxers.includes(muxer),
  );
}

/**
 * The audio mode of the request: `copy` when the user chose the copy and the setup step offers
 * it, and `encode` otherwise. A choice that the step does not offer, after the user added a
 * second segment for example, asks for nothing.
 */
export function resolveExportAudioMode(
  copyChosen: boolean,
  copyOffered: boolean,
): ExportAudioMode {
  return copyChosen && copyOffered ? "copy" : "encode";
}
