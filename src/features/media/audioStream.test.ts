import { describe, expect, it } from "vitest";
import { previewAudioStreamOf } from "./audioStream";
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

describe("previewAudioStreamOf", () => {
  it("gives the preferred stream, also when it is not the first audio stream", () => {
    // The stream with the `default` disposition is the second one (ADR 070).
    const audio: AudioProbe = {
      index: 2,
      codec: "ac3",
      sampleRate: 48000,
      channels: 2,
    };
    const probe = {
      audio,
      audioStreams: [listed(1, "aac", false), listed(2, "ac3", true)],
    };
    expect(previewAudioStreamOf(probe)).toEqual(audio);
  });

  it("gives null for a source with no audio", () => {
    expect(previewAudioStreamOf({ audio: null })).toBeNull();
  });
});
