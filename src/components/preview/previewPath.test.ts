import { describe, expect, it } from "vitest";
import { previewAudioStreamOf } from "@/features/media";
import type { Pts } from "@/types/project";
import { choosePreviewPath, type PreviewPathProbe } from "./previewPath";

const FLV: PreviewPathProbe = {
  formatNames: ["flv"],
  videoCodec: "h264",
  approximateDurationSeconds: 240.04,
  videoStartPts: "1234567" as Pts,
  videoTimeBase: { n: 1, d: 1000 },
};

/** The audio stream of the FLV that the windows read. */
const AAC = { codec: "aac" };

/** The answers of WKWebView in ADR 046 measurement 15. */
function webKit(type: string): boolean {
  return /avc1|hev1|mp4a\.40|ac-3|ec-3|flac/.test(type);
}

describe("choosePreviewPath", () => {
  it("plays an FLV through remux windows with its AAC copied", () => {
    expect(
      choosePreviewPath({
        probe: FLV,
        audioStream: AAC,
        fileName: "live.flv",
        platform: "macos",
        isTypeSupported: webKit,
      }),
    ).toEqual({
      kind: "mediaSource",
      container: "flv",
      audio: "copy",
      videoStartSeconds: 1234.567,
      durationSeconds: 240.04,
    });
  });

  it("transcodes MP3 and audio that the web view refuses, and leaves out no audio", () => {
    const path = (codec: string | null, hasAudio = true) =>
      choosePreviewPath({
        probe: FLV,
        audioStream: hasAudio ? { codec } : null,
        fileName: "a.flv",
        platform: "macos",
        isTypeSupported: webKit,
      });
    expect(path("mp3")).toMatchObject({ audio: "transcode" });
    expect(path("opus")).toMatchObject({ audio: "transcode" });
    expect(path("nellymoser")).toMatchObject({ audio: "transcode" });
    expect(path(null)).toMatchObject({ audio: "transcode" });
    expect(path("eac3")).toMatchObject({ audio: "copy" });
    expect(path(null, false)).toMatchObject({ audio: "omit" });
  });

  it("takes MPEG-TS everywhere and Matroska on macOS only", () => {
    const path = (
      formatNames: string[],
      fileName: string,
      platform: "macos" | "windows",
    ) => {
      const chosen = choosePreviewPath({
        probe: { ...FLV, formatNames },
        audioStream: AAC,
        fileName,
        platform,
        isTypeSupported: webKit,
      });
      return chosen.kind === "mediaSource" ? chosen : null;
    };
    expect(path(["mpegts"], "a.ts", "windows")).toMatchObject({ container: "mpegTs" });
    expect(path(["matroska", "webm"], "a.mkv", "macos")).toMatchObject({
      container: "matroska",
    });
    expect(path(["matroska", "webm"], "a.mkv", "windows")).toBeNull();
    expect(path(["matroska", "webm"], "a.webm", "macos")).toBeNull();
  });

  it("leaves every other source to the native element", () => {
    const kind = (
      probe: Partial<PreviewPathProbe>,
      supported: typeof webKit | null = webKit,
    ) =>
      choosePreviewPath({
        probe: { ...FLV, ...probe },
        audioStream: AAC,
        fileName: "a.flv",
        platform: "macos",
        isTypeSupported: supported,
      }).kind;
    expect(kind({ formatNames: ["mov", "mp4", "m4a"] })).toBe("native");
    expect(kind({ formatNames: ["avi"] })).toBe("native");
    expect(kind({ formatNames: ["asf"] })).toBe("native");
    expect(kind({}, null)).toBe("native");
    expect(kind({ videoCodec: "vp6f" })).toBe("native");
    expect(kind({ videoCodec: "hevc" }, (type) => !type.includes("hev1"))).toBe(
      "native",
    );
    expect(kind({ approximateDurationSeconds: null })).toBe("native");
    expect(kind({ videoStartPts: null })).toBe("native");
    expect(
      kind({}, () => {
        throw new Error("not supported");
      }),
    ).toBe("native");
  });

  it("decides the audio from the stream that the windows read, not the first stream", () => {
    // A Matroska file whose first audio stream is AAC and whose preferred stream is MP3: the
    // windows map the preferred stream, so they transcode it (ADR 070).
    const audioStreams = [
      {
        index: 1,
        codec: "aac",
        sampleRate: 48000,
        channels: 2,
        default: false,
        language: null,
        title: null,
      },
      {
        index: 2,
        codec: "mp3",
        sampleRate: 44100,
        channels: 2,
        default: true,
        language: null,
        title: null,
      },
    ];
    const audio = { index: 2, codec: "mp3", sampleRate: 44100, channels: 2 };
    const probe = { ...FLV, formatNames: ["matroska", "webm"], audio, audioStreams };
    expect(
      choosePreviewPath({
        probe,
        audioStream: previewAudioStreamOf(probe),
        fileName: "two-tracks.mkv",
        platform: "macos",
        isTypeSupported: webKit,
      }),
    ).toMatchObject({ kind: "mediaSource", audio: "transcode" });
  });

  it("takes HEVC where the web view accepts it", () => {
    expect(
      choosePreviewPath({
        probe: { ...FLV, videoCodec: "hevc" },
        audioStream: AAC,
        fileName: "a.flv",
        platform: "windows",
        isTypeSupported: webKit,
      }).kind,
    ).toBe("mediaSource");
  });
});
