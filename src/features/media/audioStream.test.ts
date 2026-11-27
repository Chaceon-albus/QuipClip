import { describe, expect, it } from "vitest";
import {
  choosableAudioStreamOf,
  effectiveAudioStreamOf,
  isFlvProbe,
  overrideOfStream,
  previewAudioStreamOf,
  sourcesWithChangedEffectiveStream,
  withEffectiveAudio,
  type AudioStreamOverride,
} from "./audioStream";
import type { AudioProbe, ListedAudioStream } from "./types";

function listed(index: number, codec: string, isDefault: boolean): ListedAudioStream {
  return {
    index,
    codec,
    sampleRate: 48000,
    channels: 2,
    default: isDefault,
    language: null,
    title: null,
  };
}

/** The preferred stream 2, AC-3, which has the `default` disposition. */
const PREFERRED: AudioProbe = {
  index: 2,
  codec: "ac3",
  sampleRate: 48000,
  channels: 2,
};

/** The override of stream 1: Opus at 44100 Hz in mono. */
const FIRST: AudioStreamOverride = {
  index: 1,
  codec: "opus",
  sampleRate: 44100,
  channels: 1,
};

/** The format names of a Matroska file, which can hold an override. */
const MKV = ["matroska", "webm"];

describe("previewAudioStreamOf", () => {
  it("gives the preferred stream with no override, also when it is not the first audio stream", () => {
    // The stream with the `default` disposition is the second one (ADR 070).
    const probe = {
      audio: PREFERRED,
      audioStreams: [listed(1, "aac", false), listed(2, "ac3", true)],
      formatNames: MKV,
    };
    expect(previewAudioStreamOf(probe, undefined)).toEqual(PREFERRED);
  });

  it("gives the override, so the windows and the cue read the stream that the export reads", () => {
    const probe = {
      audio: PREFERRED,
      audioStreams: [listed(1, "opus", false), listed(2, "ac3", true)],
      formatNames: MKV,
    };
    expect(previewAudioStreamOf(probe, FIRST)).toEqual(FIRST);
    expect(previewAudioStreamOf(probe, FIRST)).toEqual(
      effectiveAudioStreamOf(probe, FIRST),
    );
  });

  it("gives the preferred stream of an FLV, which holds no override", () => {
    // An FLV keeps the mapping 0:a:0, so its preview reads its one audio stream.
    const probe = { audio: PREFERRED, formatNames: ["flv"] };
    expect(previewAudioStreamOf(probe, FIRST)).toEqual(PREFERRED);
  });

  it("gives null for a source with no audio", () => {
    expect(
      previewAudioStreamOf({ audio: null, formatNames: MKV }, undefined),
    ).toBeNull();
  });
});

describe("the override and the effective stream (ADR 070)", () => {
  it("records the index, the codec, the rate and the channels of a listed stream", () => {
    expect(
      overrideOfStream({
        index: 1,
        codec: "opus",
        sampleRate: 44100,
        channels: 1,
        default: false,
        language: "eng",
        title: "Microphone",
      }),
    ).toEqual(FIRST);
    expect(
      overrideOfStream({
        ...listed(3, "aac", false),
        codec: null,
        sampleRate: null,
        channels: null,
      }),
    ).toEqual({ index: 3, codec: null, sampleRate: null, channels: null });
  });

  it("gives the override, else the preferred stream, else null", () => {
    const probe = { audio: PREFERRED, formatNames: MKV };
    expect(effectiveAudioStreamOf(probe, undefined)).toBe(PREFERRED);
    expect(effectiveAudioStreamOf(probe, FIRST)).toEqual(FIRST);
    // An override of the preferred stream is a real override, with its own facts.
    expect(effectiveAudioStreamOf(probe, { ...PREFERRED })).toEqual(PREFERRED);
    expect(
      effectiveAudioStreamOf({ audio: null, formatNames: MKV }, undefined),
    ).toBeNull();
  });

  it("gives the preferred stream of an FLV, which holds no override", () => {
    const flv = { audio: PREFERRED, formatNames: ["flv"] };
    expect(isFlvProbe(flv)).toBe(true);
    expect(isFlvProbe({ formatNames: MKV })).toBe(false);
    expect(effectiveAudioStreamOf(flv, FIRST)).toBe(PREFERRED);
    expect(withEffectiveAudio(flv, FIRST)).toBe(flv);
    expect(
      sourcesWithChangedEffectiveStream({ live: flv }, {}, { live: FIRST }),
    ).toEqual([]);
  });

  it("puts the effective stream into a probe, and keeps the probe without an override", () => {
    const probe = { audio: PREFERRED, formatNames: MKV, width: 1920 };
    expect(withEffectiveAudio(probe, undefined)).toBe(probe);
    expect(withEffectiveAudio(probe, FIRST)).toEqual({
      audio: FIRST,
      formatNames: MKV,
      width: 1920,
    });
    // The probe of the import does not change.
    expect(probe.audio).toBe(PREFERRED);
  });

  it("names the sources whose effective stream changed", () => {
    const probes = {
      a: { audio: PREFERRED, formatNames: MKV },
      b: { audio: PREFERRED, formatNames: MKV },
      gone: { audio: PREFERRED, formatNames: MKV },
    };
    expect(sourcesWithChangedEffectiveStream(probes, {}, { a: FIRST })).toEqual(["a"]);
    expect(sourcesWithChangedEffectiveStream(probes, { a: FIRST }, {})).toEqual(["a"]);
    expect(
      sourcesWithChangedEffectiveStream(
        probes,
        { a: FIRST },
        { a: FIRST, b: { ...FIRST, index: 3 } },
      ),
    ).toEqual(["b"]);
    // A first override of the stream that was already effective changes no effective stream.
    expect(
      sourcesWithChangedEffectiveStream(probes, {}, { a: { ...PREFERRED } }),
    ).toEqual([]);
    // A source that the probes do not hold is not named.
    expect(sourcesWithChangedEffectiveStream(probes, {}, { other: FIRST })).toEqual([]);
  });
});

describe("choosableAudioStreamOf (ADR 070, ADR 072)", () => {
  const streams = [listed(1, "aac", true), listed(2, "opus", false)];

  it("gives a stream of a file with two or more audio streams that is not an FLV", () => {
    const probe = { formatNames: ["matroska", "webm"], audioStreams: streams };
    expect(choosableAudioStreamOf(probe, 2)).toBe(streams[1]);
    expect(choosableAudioStreamOf(probe, 3)).toBeNull();
  });

  it("gives null for one stream, for no list, and for an FLV", () => {
    expect(
      choosableAudioStreamOf({ formatNames: ["mp4"], audioStreams: [streams[0]] }, 1),
    ).toBeNull();
    expect(choosableAudioStreamOf({ formatNames: ["mp4"] }, 1)).toBeNull();
    expect(
      choosableAudioStreamOf({ formatNames: ["flv"], audioStreams: streams }, 2),
    ).toBeNull();
  });
});
