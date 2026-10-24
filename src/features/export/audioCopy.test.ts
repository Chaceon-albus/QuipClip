import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AudioProbe, MediaProbe } from "@/features/media/types";
import { PRESET_CONTAINERS } from "@/features/settings/types";
import {
  COPYABLE_AUDIO,
  COPY_SOURCE_FORMATS,
  MIN_COPY_SAMPLE_RATE,
  canCopyAudio,
  exportMuxer,
  resolveExportAudioMode,
  type AudioCopyFacts,
} from "./audioCopy";

/** The source of `copy.rs`, which holds the Rust copies of the three lists. */
function readCopyRs(): string {
  return readFileSync(
    fileURLToPath(
      new URL("../../../src-tauri/src/ffmpeg/export/copy.rs", import.meta.url),
    ),
    "utf8",
  );
}

const AAC: AudioProbe = { index: 1, codec: "aac", sampleRate: 48000, channels: 2 };

/** One segment of an MP4 source with 48000 Hz AAC, exported with video into MP4. */
function facts(overrides: Partial<AudioCopyFacts> = {}): AudioCopyFacts {
  const probe: Pick<MediaProbe, "formatNames" | "audio"> = {
    formatNames: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    audio: AAC,
  };
  return {
    probe,
    container: "mp4",
    streams: "videoAndAudio",
    segmentCount: 1,
    ...overrides,
  };
}

describe("Rust parity", () => {
  it("names the codecs and the muxers of COPYABLE_AUDIO in copy.rs", () => {
    const source = readCopyRs();
    const entries = Array.from(
      source.matchAll(
        /CopyableAudio \{\s*codec: "([^"]+)",\s*muxers: &\[([^\]]*)\],\s*\}/g,
      ),
      (match) => ({
        codec: match[1],
        muxers: Array.from(match[2].matchAll(/"([^"]+)"/g), (muxer) => muxer[1]),
      }),
    );
    // Guards the parse itself: the array type names the number of entries, so an entry that the
    // pattern misses fails the test rather than leaving the list short.
    const length = /pub const COPYABLE_AUDIO: \[CopyableAudio; (\d+)\]/.exec(source);
    expect(length).not.toBeNull();
    expect(entries.length).toBe(Number(length![1]));
    expect(COPYABLE_AUDIO).toEqual(entries);
  });

  it("names the source formats and the lowest sample rate of copy.rs", () => {
    const source = readCopyRs();
    const formats =
      /pub const COPY_SOURCE_FORMATS: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(source);
    expect(formats).not.toBeNull();
    const rustFormats = Array.from(
      formats![2].matchAll(/"([^"]+)"/g),
      (match) => match[1],
    );
    expect(rustFormats.length).toBe(Number(formats![1]));
    expect([...COPY_SOURCE_FORMATS]).toEqual(rustFormats);
    const rate = /pub const MIN_COPY_SAMPLE_RATE: u32 = ([\d_]+);/.exec(source);
    expect(rate).not.toBeNull();
    expect(MIN_COPY_SAMPLE_RATE).toBe(Number(rate![1].replaceAll("_", "")));
  });
});

describe("exportMuxer", () => {
  it.each([
    ["mp4", "videoAndAudio", "mp4"],
    ["mov", "videoAndAudio", "mov"],
    ["mkv", "videoAndAudio", "matroska"],
    ["mp4", "audioOnly", "mp4"],
    // An audio-only export of a MOV preset writes an `.m4a` (ADR 036).
    ["mov", "audioOnly", "mp4"],
    ["mkv", "audioOnly", "matroska"],
  ] as const)("writes a %s preset with %s through %s", (container, streams, muxer) => {
    expect(exportMuxer(container, streams)).toBe(muxer);
  });

  it("covers every container", () => {
    for (const container of PRESET_CONTAINERS) {
      expect(["mp4", "mov", "matroska"]).toContain(exportMuxer(container, "audioOnly"));
    }
  });
});

describe("canCopyAudio", () => {
  it("offers the copy of the audio of one segment of a copyable source", () => {
    expect(canCopyAudio(facts())).toBe(true);
    expect(canCopyAudio(facts({ streams: "audioOnly" }))).toBe(true);
  });

  it("does not offer it for more than one segment, or for none", () => {
    expect(canCopyAudio(facts({ segmentCount: 2 }))).toBe(false);
    expect(canCopyAudio(facts({ segmentCount: 0 }))).toBe(false);
  });

  it("does not offer it when the export writes no audio, or the source has none", () => {
    expect(canCopyAudio(facts({ streams: "videoOnly" }))).toBe(false);
    expect(canCopyAudio(facts({ probe: { formatNames: ["mov"], audio: null } }))).toBe(
      false,
    );
    expect(canCopyAudio(facts({ probe: null }))).toBe(false);
  });

  it("does not offer it for a source format that was not measured", () => {
    expect(canCopyAudio(facts({ probe: { formatNames: ["avi"], audio: AAC } }))).toBe(
      false,
    );
    for (const formatNames of [["matroska", "webm"], ["mpegts"], ["flv"]]) {
      expect(canCopyAudio(facts({ probe: { formatNames, audio: AAC } }))).toBe(true);
    }
  });

  it("does not offer it below the lowest sample rate, or with no rate", () => {
    const at = (sampleRate: number | null) =>
      canCopyAudio(
        facts({ probe: { formatNames: ["mov"], audio: { ...AAC, sampleRate } } }),
      );
    expect(at(MIN_COPY_SAMPLE_RATE)).toBe(true);
    expect(at(MIN_COPY_SAMPLE_RATE - 1)).toBe(false);
    expect(at(null)).toBe(false);
  });

  it("offers it only for a codec that the muxer of the output takes", () => {
    const copies = (
      codec: string | null,
      container: "mp4" | "mov" | "mkv",
      streams: "videoAndAudio" | "audioOnly",
    ) =>
      canCopyAudio(
        facts({
          probe: { formatNames: ["matroska"], audio: { ...AAC, codec } },
          container,
          streams,
        }),
      );
    for (const codec of ["aac", "mp3", "ac3"]) {
      for (const container of PRESET_CONTAINERS) {
        expect(copies(codec, container, "videoAndAudio")).toBe(true);
      }
    }
    expect(copies("opus", "mkv", "videoAndAudio")).toBe(true);
    expect(copies("opus", "mp4", "videoAndAudio")).toBe(false);
    expect(copies("opus", "mov", "videoAndAudio")).toBe(false);
    expect(copies("opus", "mov", "audioOnly")).toBe(false);
    for (const codec of ["eac3", "flac", "pcm_s16le", null]) {
      expect(copies(codec, "mkv", "videoAndAudio")).toBe(false);
    }
  });
});

describe("resolveExportAudioMode", () => {
  it("asks for the copy only when the user chose it and the step offers it", () => {
    expect(resolveExportAudioMode(true, true)).toBe("copy");
    expect(resolveExportAudioMode(true, false)).toBe("encode");
    expect(resolveExportAudioMode(false, true)).toBe("encode");
    expect(resolveExportAudioMode(false, false)).toBe("encode");
  });
});
