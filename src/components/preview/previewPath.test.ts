import { describe, expect, it } from "vitest";
import type { Pts } from "@/types/project";
import { choosePreviewPath, type PreviewPathProbe } from "./previewPath";

const FLV: PreviewPathProbe = {
  formatNames: ["flv"],
  videoCodec: "h264",
  audio: { index: 1, codec: "aac", sampleRate: 48000, channels: 2 },
  approximateDurationSeconds: 240.04,
  videoStartPts: "1234567" as Pts,
  videoTimeBase: { n: 1, d: 1000 },
};

/** The answers of WKWebView in ADR 046 measurement 15. */
function webKit(type: string): boolean {
  return /avc1|hev1|mp4a\.40|ac-3|ec-3|flac/.test(type);
}

describe("choosePreviewPath", () => {
  it("plays an FLV through remux windows with its AAC copied", () => {
    expect(
      choosePreviewPath({
        probe: FLV,
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
        probe: {
          ...FLV,
          audio: hasAudio ? { index: 1, codec, sampleRate: 44100, channels: 2 } : null,
        },
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

  it("takes HEVC where the web view accepts it", () => {
    expect(
      choosePreviewPath({
        probe: { ...FLV, videoCodec: "hevc" },
        fileName: "a.flv",
        platform: "windows",
        isTypeSupported: webKit,
      }).kind,
    ).toBe("mediaSource");
  });
});
