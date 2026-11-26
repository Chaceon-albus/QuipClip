import { describe, expect, it } from "vitest";
import {
  audioStreamField,
  pcmWindowRequest,
  type PcmWindowSource,
} from "./windowRequests";

/** A Matroska file whose preferred audio stream is its second audio stream, at index 3. */
const MATROSKA: PcmWindowSource = {
  path: "/media/two-tracks.mkv",
  size: 10,
  mtime: 1,
  container: "matroska",
  formatStartTime: { n: 0, d: 1 },
  audioCodec: "ac3",
  audioStreamIndex: 3,
};

describe("audioStreamField", () => {
  it("names the stream of a source that is not an FLV", () => {
    for (const container of ["mpegTs", "matroska", "native"] as const) {
      expect(audioStreamField(container, 3)).toEqual({ audioStreamIndex: 3 });
    }
    expect(audioStreamField("matroska", 0)).toEqual({ audioStreamIndex: 0 });
  });

  it("names no stream for an FLV or a source with no audio", () => {
    expect(audioStreamField("flv", 1)).toEqual({});
    expect(audioStreamField("matroska", null)).toEqual({});
  });
});

describe("pcmWindowRequest", () => {
  it("asks for the PCM of the named stream at the time of the window", () => {
    expect(pcmWindowRequest(MATROSKA, 134.5)).toEqual({
      path: "/media/two-tracks.mkv",
      size: 10,
      mtime: 1,
      lane: "audio",
      container: "matroska",
      start: { kind: "time", seconds: 134.5 },
      formatStartTime: { n: 0, d: 1 },
      audio: "copy",
      audioCodec: "ac3",
      audioStreamIndex: 3,
    });
  });

  it("names the stream of a native source too", () => {
    const request = pcmWindowRequest(
      {
        ...MATROSKA,
        path: "/media/clip.mp4",
        container: "native",
        audioStreamIndex: 2,
      },
      0,
    );
    expect(request).toMatchObject({ container: "native", audioStreamIndex: 2 });
  });
});
