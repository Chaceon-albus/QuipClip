import { afterEach, describe, expect, it } from "vitest";
import { audioOverrideStore, createAudioOverrideStore } from "./audioOverrideStore";
import { mediaStore } from "./store";
import type { ImportMediaResult, ListedAudioStream } from "./types";

function listed(index: number, channels: number | null = 2): ListedAudioStream {
  return {
    index,
    codec: "aac",
    sampleRate: 48000,
    channels,
    default: index === 1,
    language: null,
    title: null,
  };
}

/** The probe of a Matroska file, which can hold an override. */
const MKV = { formatNames: ["matroska", "webm"] };

describe("the audio stream overrides (ADR 070)", () => {
  it("keeps one override for each source id, with the facts of the import", () => {
    const store = createAudioOverrideStore();
    store.getState().choose("a", MKV, listed(2, 1));
    store.getState().choose("b", MKV, listed(1));
    expect(store.getState().overrides).toEqual({
      a: { index: 2, codec: "aac", sampleRate: 48000, channels: 1 },
      b: { index: 1, codec: "aac", sampleRate: 48000, channels: 2 },
    });
    // A new choice replaces the override of the source.
    store.getState().choose("a", MKV, listed(3));
    expect(store.getState().overrides.a?.index).toBe(3);
  });

  it("refuses an override for an FLV, however many audio streams ffprobe lists", () => {
    const store = createAudioOverrideStore();
    const before = store.getState().overrides;
    store.getState().choose("live", { formatNames: ["flv"] }, listed(2));
    expect(store.getState().overrides).toBe(before);
    expect(store.getState().overrides).toEqual({});
  });

  it("changes no state for the same choice again", () => {
    const store = createAudioOverrideStore();
    store.getState().choose("a", MKV, listed(2));
    const before = store.getState().overrides;
    store.getState().choose("a", MKV, listed(2));
    expect(store.getState().overrides).toBe(before);
  });

  it("drops the override of each source that leaves", () => {
    const store = createAudioOverrideStore();
    store.getState().choose("a", MKV, listed(2));
    store.getState().choose("b", MKV, listed(2));
    const before = store.getState().overrides;
    store.getState().retain(["a", "b", "c"]);
    expect(store.getState().overrides).toBe(before);
    store.getState().retain(["b"]);
    expect(Object.keys(store.getState().overrides)).toEqual(["b"]);
  });

  describe("the override store of the page", () => {
    afterEach(() => {
      mediaStore.getState().reset();
    });

    it("drops an override when its source leaves the media store", () => {
      const media = { path: "/a.mp4" } as ImportMediaResult;
      mediaStore.setState({ sources: { a: media, b: media } });
      audioOverrideStore.getState().choose("a", MKV, listed(2));
      audioOverrideStore.getState().choose("b", MKV, listed(2));
      mediaStore.setState({ sources: { b: media } });
      expect(Object.keys(audioOverrideStore.getState().overrides)).toEqual(["b"]);
      // A clear of the timeline empties the media store, and every override goes.
      mediaStore.getState().reset();
      expect(audioOverrideStore.getState().overrides).toEqual({});
    });
  });
});
