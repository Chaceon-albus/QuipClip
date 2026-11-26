import { describe, expect, it } from "vitest";
import {
  audioStreamChangeEffect,
  type AudioStreamChangeInput,
} from "./audioStreamChange";

/** The source of the attached clip, whose windows map stream 1. */
const ATTACHED: AudioStreamChangeInput = {
  path: "mediaSource",
  sourceRevisionKey: "/media/two-tracks.mkv:10:1",
  previousStreamIndex: 1,
  effectiveStreamIndex: 2,
  showsFailure: false,
  held: { sourceRevisionKey: "/media/two-tracks.mkv:10:1", audioStreamIndex: 1 },
};

/** The same source while the failure panel shows: no element, so no reader. */
const FAILED: AudioStreamChangeInput = { ...ATTACHED, showsFailure: true, held: null };

describe("audioStreamChangeEffect (ADR 070)", () => {
  it("retries a MediaSource source whose failure panel shows, for a new effective stream", () => {
    expect(audioStreamChangeEffect(FAILED)).toBe("retryFailed");
  });

  it("retries nothing while the panel shows when the effective stream stays", () => {
    // An override of another source, or an override that names the preferred stream.
    expect(
      audioStreamChangeEffect({
        ...FAILED,
        previousStreamIndex: 2,
        effectiveStreamIndex: 2,
      }),
    ).toBe("none");
  });

  it("never retries a native source, whose element does not read the effective stream", () => {
    expect(audioStreamChangeEffect({ ...FAILED, path: "native" })).toBe("none");
  });

  it("reloads a MediaSource element whose windows map another stream", () => {
    expect(audioStreamChangeEffect(ATTACHED)).toBe("reloadElement");
  });

  it("replaces the PCM cue of a native element, and leaves the element", () => {
    expect(audioStreamChangeEffect({ ...ATTACHED, path: "native" })).toBe("replaceCue");
  });

  it("does nothing for a native source with no PCM cue", () => {
    // The element plays the track that the web view chooses, and nothing reads the stream.
    expect(audioStreamChangeEffect({ ...ATTACHED, path: "native", held: null })).toBe(
      "none",
    );
  });

  it("does nothing for a source that is not attached, which reads the stream at its attach", () => {
    // The reader on screen belongs to another source, as during a switch to another clip.
    expect(
      audioStreamChangeEffect({
        ...ATTACHED,
        held: { sourceRevisionKey: "/media/other.mkv:20:2", audioStreamIndex: 1 },
      }),
    ).toBe("none");
    expect(
      audioStreamChangeEffect({
        ...ATTACHED,
        path: "native",
        held: { sourceRevisionKey: "/media/other.mkv:20:2", audioStreamIndex: 1 },
      }),
    ).toBe("none");
    // No element is held, as between the detach of an element and the attach of the next one.
    expect(audioStreamChangeEffect({ ...ATTACHED, held: null })).toBe("none");
  });

  it("does nothing when the reader maps the effective stream already", () => {
    expect(audioStreamChangeEffect({ ...ATTACHED, effectiveStreamIndex: 1 })).toBe(
      "none",
    );
    expect(
      audioStreamChangeEffect({ ...ATTACHED, path: "native", effectiveStreamIndex: 1 }),
    ).toBe("none");
  });

  it("ends two quick changes on the last one", () => {
    // Stream 1 runs. The user chooses 2, then 3 before the new element attaches: the old
    // element still maps 1, so both changes ask for a reload, and the store starts one. The
    // element that attaches then reads 3.
    expect(audioStreamChangeEffect({ ...ATTACHED, effectiveStreamIndex: 2 })).toBe(
      "reloadElement",
    );
    expect(audioStreamChangeEffect({ ...ATTACHED, effectiveStreamIndex: 3 })).toBe(
      "reloadElement",
    );
    // The element of the first reload attached with 2, and the user chose 3 after it: that
    // element goes too.
    const afterFirst = {
      ...ATTACHED,
      held: { sourceRevisionKey: ATTACHED.sourceRevisionKey, audioStreamIndex: 2 },
    };
    expect(audioStreamChangeEffect({ ...afterFirst, effectiveStreamIndex: 3 })).toBe(
      "reloadElement",
    );
    // A change back to the stream of the element that runs leaves it.
    expect(audioStreamChangeEffect({ ...afterFirst, effectiveStreamIndex: 2 })).toBe(
      "none",
    );
  });
});
