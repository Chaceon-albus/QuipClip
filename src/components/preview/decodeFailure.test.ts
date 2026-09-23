import { describe, expect, it } from "vitest";
import { en, extractPlaceholders, zhCN } from "@/i18n";
import {
  classifyChroma,
  findUnplayableContainer,
  formatCodecName,
  HAVE_CURRENT_DATA,
  MEDIA_ERR_ABORTED,
  MEDIA_ERR_DECODE,
  MEDIA_ERR_NETWORK,
  MEDIA_ERR_SRC_NOT_SUPPORTED,
  PICTURE_CHECK_INTERVAL_MS,
  PICTURE_CHECK_MAX_WAIT_MS,
  pixelFormatBitDepth,
  presentDecodeFailure,
  resolvePictureCheck,
  type DecodeFailureHintKey,
  type DecodeFailureInput,
  type DecodeFailureProbe,
  type DecodeFailureReasonKey,
  type DecodeFailureTrigger,
  type PictureCheckState,
} from "./decodeFailure";

const PICTURE_MISSING: DecodeFailureTrigger = { kind: "pictureMissing" };

function mediaError(code: number | null): DecodeFailureTrigger {
  return { kind: "mediaError", code };
}

function probe(overrides: Partial<DecodeFailureProbe> = {}): DecodeFailureProbe {
  return {
    formatNames: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    videoCodec: "hevc",
    videoProfile: "Main 10",
    pixelFormat: "yuv420p10le",
    bitDepth: 10,
    ...overrides,
  };
}

/** `HTMLMediaElement.HAVE_METADATA`: the element knows the size and the duration only. */
const HAVE_METADATA = 1;

function input(overrides: Partial<DecodeFailureInput> = {}): DecodeFailureInput {
  return {
    probe: probe(),
    fileName: "clip.mp4",
    trigger: PICTURE_MISSING,
    platform: "macos",
    ...overrides,
  };
}

/** Reads a dotted key from a catalog, or undefined when a segment is missing. */
function lookup(catalog: unknown, key: string): unknown {
  let node: unknown = catalog;
  for (const segment of key.split(".")) {
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

const ALL_REASON_KEYS: readonly DecodeFailureReasonKey[] = [
  "preview.decodeFailure.unsupportedCodec.full",
  "preview.decodeFailure.unsupportedCodec.noProfile",
  "preview.decodeFailure.unsupportedCodec.noPixelFormat",
  "preview.decodeFailure.unsupportedCodec.codecOnly",
  "preview.decodeFailure.cannotPlay.full",
  "preview.decodeFailure.cannotPlay.noProfile",
  "preview.decodeFailure.cannotPlay.noPixelFormat",
  "preview.decodeFailure.cannotPlay.codecOnly",
  "preview.decodeFailure.unsupportedContainer",
  "preview.decodeFailure.readFailed",
];

const ALL_HINT_KEYS: readonly DecodeFailureHintKey[] = [
  "preview.decodeFailure.hint.installHevc",
  "preview.decodeFailure.hint.convertH264",
  "preview.decodeFailure.hint.convertMp4",
];

describe("resolvePictureCheck", () => {
  const STATES: readonly PictureCheckState[] = ["idle", "pending", "decoded", "failed"];

  describe("loadedmetadata", () => {
    it("takes the ready path when the element reports a picture size", () => {
      expect(
        resolvePictureCheck("idle", {
          type: "loadedMetadata",
          videoWidth: 1920,
          probeWidth: 1920,
        }),
      ).toEqual({ state: "decoded", action: "ready" });
    });

    it("waits instead of failing when the element reports width 0 for a video stream", () => {
      expect(
        resolvePictureCheck("idle", {
          type: "loadedMetadata",
          videoWidth: 0,
          probeWidth: 3840,
        }),
      ).toEqual({ state: "pending", action: "wait" });
    });

    it("takes the ready path when the probe reports no width", () => {
      expect(
        resolvePictureCheck("idle", {
          type: "loadedMetadata",
          videoWidth: 0,
          probeWidth: 0,
        }),
      ).toEqual({ state: "decoded", action: "ready" });
    });

    it("decides again on a later loadedmetadata of the same element", () => {
      expect(
        resolvePictureCheck("decoded", {
          type: "loadedMetadata",
          videoWidth: 1280,
          probeWidth: 1280,
        }),
      ).toEqual({ state: "decoded", action: "ready" });
      expect(
        resolvePictureCheck("pending", {
          type: "loadedMetadata",
          videoWidth: 0,
          probeWidth: 1280,
        }),
      ).toEqual({ state: "pending", action: "wait" });
    });
  });

  describe("resize", () => {
    it("takes the ready path when a pending element reports a picture size", () => {
      expect(
        resolvePictureCheck("pending", { type: "resize", videoWidth: 1920 }),
      ).toEqual({
        state: "decoded",
        action: "ready",
      });
    });

    it("keeps waiting when a pending element still reports width 0", () => {
      expect(resolvePictureCheck("pending", { type: "resize", videoWidth: 0 })).toEqual(
        {
          state: "pending",
          action: "none",
        },
      );
    });

    it("does nothing before loadedmetadata, after the ready path, or after a failure", () => {
      for (const state of ["idle", "decoded", "failed"] as const) {
        expect(
          resolvePictureCheck(state, { type: "resize", videoWidth: 1920 }),
        ).toEqual({
          state,
          action: "none",
        });
      }
    });
  });

  describe("frame", () => {
    it("takes the ready path when a pending element presents a frame", () => {
      expect(resolvePictureCheck("pending", { type: "frame" })).toEqual({
        state: "decoded",
        action: "ready",
      });
    });

    it("does nothing in any other state", () => {
      for (const state of ["idle", "decoded", "failed"] as const) {
        expect(resolvePictureCheck(state, { type: "frame" })).toEqual({
          state,
          action: "none",
        });
      }
    });
  });

  describe("timeout", () => {
    function timeout(overrides: {
      videoWidth?: number;
      readyState?: number;
      elapsedMs?: number;
    }) {
      return {
        type: "timeout",
        videoWidth: 0,
        readyState: HAVE_CURRENT_DATA,
        elapsedMs: PICTURE_CHECK_INTERVAL_MS,
        ...overrides,
      } as const;
    }

    it("fails when the element holds frame data and still reports width 0", () => {
      for (const readyState of [HAVE_CURRENT_DATA, 3, 4]) {
        expect(resolvePictureCheck("pending", timeout({ readyState }))).toEqual({
          state: "failed",
          action: "fail",
        });
      }
    });

    it("waits again when no frame data has arrived yet, as on a slow drive", () => {
      for (const readyState of [0, HAVE_METADATA]) {
        expect(resolvePictureCheck("pending", timeout({ readyState }))).toEqual({
          state: "pending",
          action: "wait",
        });
      }
    });

    it("keeps waiting up to the longest wait", () => {
      const elapsed = [1, 2, 3].map((n) => n * PICTURE_CHECK_INTERVAL_MS);
      for (const elapsedMs of elapsed.filter((ms) => ms < PICTURE_CHECK_MAX_WAIT_MS)) {
        expect(
          resolvePictureCheck(
            "pending",
            timeout({ readyState: HAVE_METADATA, elapsedMs }),
          ).action,
        ).toBe("wait");
      }
    });

    it("takes the ready path after the longest wait without evidence of a failure", () => {
      for (const elapsedMs of [
        PICTURE_CHECK_MAX_WAIT_MS,
        PICTURE_CHECK_MAX_WAIT_MS + 1,
      ]) {
        expect(
          resolvePictureCheck(
            "pending",
            timeout({ readyState: HAVE_METADATA, elapsedMs }),
          ),
        ).toEqual({ state: "decoded", action: "ready" });
      }
    });

    it("still fails after the longest wait when the element holds frame data", () => {
      expect(
        resolvePictureCheck(
          "pending",
          timeout({
            readyState: HAVE_CURRENT_DATA,
            elapsedMs: PICTURE_CHECK_MAX_WAIT_MS,
          }),
        ),
      ).toEqual({ state: "failed", action: "fail" });
    });

    it("takes the ready path when a size arrived without a resize event", () => {
      for (const readyState of [HAVE_METADATA, HAVE_CURRENT_DATA]) {
        expect(
          resolvePictureCheck("pending", timeout({ videoWidth: 640, readyState })),
        ).toEqual({ state: "decoded", action: "ready" });
      }
    });

    it("does nothing when the element is not pending", () => {
      for (const state of ["idle", "decoded", "failed"] as const) {
        expect(resolvePictureCheck(state, timeout({}))).toEqual({
          state,
          action: "none",
        });
      }
    });
  });

  it("never acts again after a failure", () => {
    const events = [
      { type: "loadedMetadata", videoWidth: 1920, probeWidth: 1920 },
      { type: "loadedMetadata", videoWidth: 0, probeWidth: 1920 },
      { type: "resize", videoWidth: 1920 },
      { type: "frame" },
      {
        type: "timeout",
        videoWidth: 1920,
        readyState: HAVE_CURRENT_DATA,
        elapsedMs: PICTURE_CHECK_MAX_WAIT_MS,
      },
    ] as const;
    for (const event of events) {
      expect(resolvePictureCheck("failed", event)).toEqual({
        state: "failed",
        action: "none",
      });
    }
  });

  it("fails only from the pending state, at a timeout, with frame data", () => {
    const events = [
      { type: "loadedMetadata", videoWidth: 0, probeWidth: 1920 },
      { type: "resize", videoWidth: 0 },
      { type: "frame" },
      { type: "timeout", videoWidth: 0, readyState: 0, elapsedMs: 0 },
      { type: "timeout", videoWidth: 0, readyState: HAVE_METADATA, elapsedMs: 99_999 },
      { type: "timeout", videoWidth: 0, readyState: HAVE_CURRENT_DATA, elapsedMs: 0 },
    ] as const;
    for (const state of STATES) {
      for (const event of events) {
        const { action } = resolvePictureCheck(state, event);
        if (action === "fail") {
          expect(state).toBe("pending");
          expect(event.type).toBe("timeout");
          expect(event.type === "timeout" && event.readyState).toBeGreaterThanOrEqual(
            HAVE_CURRENT_DATA,
          );
        }
      }
    }
  });
});

describe("pixelFormatBitDepth", () => {
  it("reads the depth of the semi-planar P0xx family", () => {
    expect(pixelFormatBitDepth("p010le")).toBe(10);
    expect(pixelFormatBitDepth("p012le")).toBe(12);
    expect(pixelFormatBitDepth("p016be")).toBe(16);
  });

  it("reads the depth suffix of a planar YUV format", () => {
    expect(pixelFormatBitDepth("yuv420p10le")).toBe(10);
    expect(pixelFormatBitDepth("yuv420p12be")).toBe(12);
    expect(pixelFormatBitDepth("yuv444p16le")).toBe(16);
  });

  it("reports 8 bits for a planar format without a suffix and for NV12", () => {
    for (const pixelFormat of ["yuv420p", "yuvj420p", "yuv422p", "nv12", "nv21"]) {
      expect(pixelFormatBitDepth(pixelFormat)).toBe(8);
    }
  });

  it("reports null for an unstated or unrecognized format", () => {
    for (const pixelFormat of [null, "", "unknown", "rgb24", "gray16le"]) {
      expect(pixelFormatBitDepth(pixelFormat)).toBeNull();
    }
  });
});

describe("formatCodecName", () => {
  it("uses the display name of a known codec", () => {
    expect(formatCodecName("hevc")).toBe("HEVC");
    expect(formatCodecName("h264")).toBe("H.264");
    expect(formatCodecName("av1")).toBe("AV1");
    expect(formatCodecName("vp9")).toBe("VP9");
    expect(formatCodecName("prores")).toBe("ProRes");
    expect(formatCodecName("mpeg2video")).toBe("MPEG-2");
  });

  it("ignores the letter case and the surrounding white space of the codec name", () => {
    expect(formatCodecName(" HEVC ")).toBe("HEVC");
  });

  it("shows an unknown codec name as ffprobe reports it", () => {
    expect(formatCodecName("msmpeg4v3")).toBe("msmpeg4v3");
  });
});

describe("classifyChroma", () => {
  it("recognizes the 4:2:0 pixel formats of every bit depth", () => {
    for (const pixelFormat of [
      "yuv420p",
      "yuv420p10le",
      "yuv420p12be",
      "yuvj420p",
      "yuva420p",
      "nv12",
      "nv21",
      "p010le",
      "p016le",
    ]) {
      expect(classifyChroma(pixelFormat)).toBe("4:2:0");
    }
  });

  it("reports other chroma for a stated format that is not 4:2:0", () => {
    for (const pixelFormat of [
      "yuv422p",
      "yuv422p10le",
      "yuv444p",
      "yuv444p12le",
      "nv16",
      "gray",
      "rgb24",
    ]) {
      expect(classifyChroma(pixelFormat)).toBe("other");
    }
  });

  it("reports unknown chroma when ffprobe states no pixel format", () => {
    for (const pixelFormat of [null, "", "unknown", "N/A"]) {
      expect(classifyChroma(pixelFormat)).toBe("unknown");
    }
  });
});

describe("findUnplayableContainer", () => {
  it("names AVI, WMV, MPEG-TS, and FLV on every platform", () => {
    for (const platform of ["windows", "macos", "other"] as const) {
      expect(findUnplayableContainer(["avi"], "a.avi", platform)).toBe("AVI");
      expect(findUnplayableContainer(["asf"], "a.wmv", platform)).toBe("WMV");
      expect(findUnplayableContainer(["mpegts"], "a.ts", platform)).toBe("MPEG-TS");
      expect(findUnplayableContainer(["flv"], "a.flv", platform)).toBe("FLV");
    }
  });

  it("names MKV on macOS only", () => {
    expect(findUnplayableContainer(["matroska", "webm"], "a.mkv", "macos")).toBe("MKV");
    expect(
      findUnplayableContainer(["matroska", "webm"], "a.mkv", "windows"),
    ).toBeNull();
  });

  it("does not name a WebM file, which reports the Matroska format names", () => {
    expect(findUnplayableContainer(["matroska", "webm"], "a.webm", "macos")).toBeNull();
    expect(findUnplayableContainer(["matroska", "webm"], "A.WEBM", "macos")).toBeNull();
  });

  it("does not name the MP4 family", () => {
    const mp4 = ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"];
    expect(findUnplayableContainer(mp4, "a.mp4", "windows")).toBeNull();
    expect(findUnplayableContainer(mp4, "a.mov", "macos")).toBeNull();
  });

  it("ignores the letter case of a format name", () => {
    expect(findUnplayableContainer([" AVI "], "a.avi", "windows")).toBe("AVI");
  });
});

describe("presentDecodeFailure", () => {
  describe("a missing picture", () => {
    it("names the codec, the profile, and the pixel format when all are stated", () => {
      expect(presentDecodeFailure(input()).reason).toEqual({
        shape: "full",
        key: "preview.decodeFailure.unsupportedCodec.full",
        values: { codec: "HEVC", profile: "Main 10", pixelFormat: "yuv420p10le" },
      });
    });

    it("keeps the profile and the pixel format as ffprobe reports them", () => {
      const view = presentDecodeFailure(
        input({
          probe: probe({
            videoCodec: "h264",
            videoProfile: "High 4:2:2",
            pixelFormat: "yuv422p",
          }),
        }),
      );
      expect(view.reason).toMatchObject({
        values: { codec: "H.264", profile: "High 4:2:2", pixelFormat: "yuv422p" },
      });
    });

    it("selects the variant without a profile when ffprobe states none", () => {
      expect(
        presentDecodeFailure(input({ probe: probe({ videoProfile: null }) })).reason,
      ).toEqual({
        shape: "noProfile",
        key: "preview.decodeFailure.unsupportedCodec.noProfile",
        values: { codec: "HEVC", pixelFormat: "yuv420p10le" },
      });
    });

    it("selects the variant without a pixel format when ffprobe states none", () => {
      expect(
        presentDecodeFailure(input({ probe: probe({ pixelFormat: null }) })).reason,
      ).toEqual({
        shape: "noPixelFormat",
        key: "preview.decodeFailure.unsupportedCodec.noPixelFormat",
        values: { codec: "HEVC", profile: "Main 10" },
      });
    });

    it("selects the codec-only variant when ffprobe states neither", () => {
      expect(
        presentDecodeFailure(
          input({ probe: probe({ videoProfile: null, pixelFormat: null }) }),
        ).reason,
      ).toEqual({
        shape: "codecOnly",
        key: "preview.decodeFailure.unsupportedCodec.codecOnly",
        values: { codec: "HEVC" },
      });
    });

    it("treats a blank value and ffprobe's placeholder words as not stated", () => {
      for (const unstated of ["", "  ", "unknown", "UNKNOWN", "N/A"]) {
        const view = presentDecodeFailure(
          input({ probe: probe({ videoProfile: unstated, pixelFormat: unstated }) }),
        );
        expect(view.reason.key).toBe(
          "preview.decodeFailure.unsupportedCodec.codecOnly",
        );
      }
    });

    it("trims the white space around a stated value", () => {
      const view = presentDecodeFailure(
        input({ probe: probe({ videoProfile: " Main ", pixelFormat: " yuv420p " }) }),
      );
      expect(view.reason).toMatchObject({
        values: { codec: "HEVC", profile: "Main", pixelFormat: "yuv420p" },
      });
    });

    it("names the codec even for a container the platform cannot open", () => {
      const view = presentDecodeFailure(
        input({ probe: probe({ formatNames: ["avi"] }), fileName: "a.avi" }),
      );
      expect(view.reason.key).toBe("preview.decodeFailure.unsupportedCodec.full");
    });
  });

  describe("an error event", () => {
    it("says that QuipClip could not read the file for an aborted or network error", () => {
      for (const code of [MEDIA_ERR_ABORTED, MEDIA_ERR_NETWORK]) {
        expect(presentDecodeFailure(input({ trigger: mediaError(code) }))).toEqual({
          reason: { shape: "plain", key: "preview.decodeFailure.readFailed" },
          hintKey: null,
        });
      }
    });

    it("names a container the platform cannot open and suggests MP4 for browser-safe H.264", () => {
      expect(
        presentDecodeFailure(
          input({
            probe: probe({
              formatNames: ["mpegts"],
              videoCodec: "h264",
              videoProfile: "High",
              pixelFormat: "yuv420p",
              bitDepth: 8,
            }),
            fileName: "capture.ts",
            trigger: mediaError(MEDIA_ERR_SRC_NOT_SUPPORTED),
            platform: "windows",
          }),
        ),
      ).toEqual({
        reason: {
          shape: "container",
          key: "preview.decodeFailure.unsupportedContainer",
          values: { container: "MPEG-TS" },
        },
        hintKey: "preview.decodeFailure.hint.convertMp4",
      });
    });

    it("suggests the H.264 conversion for an unplayable container of other video", () => {
      const cases: Partial<DecodeFailureProbe>[] = [
        // Another codec.
        { videoCodec: "mpeg4", videoProfile: "Simple Profile", pixelFormat: "yuv420p" },
        // H.264 with 10-bit samples.
        { videoCodec: "h264", pixelFormat: "yuv420p10le", bitDepth: 10 },
        // H.264 with 4:2:2 chroma.
        { videoCodec: "h264", pixelFormat: "yuv422p", bitDepth: 8 },
        // H.264 whose pixel format ffprobe does not state.
        { videoCodec: "h264", pixelFormat: null, bitDepth: null },
        // H.264 whose probe reports a depth that contradicts an 8-bit format.
        { videoCodec: "h264", pixelFormat: "yuv420p", bitDepth: 10 },
      ];
      for (const overrides of cases) {
        const view = presentDecodeFailure(
          input({
            probe: probe({ formatNames: ["avi"], ...overrides }),
            fileName: "old.avi",
            trigger: mediaError(MEDIA_ERR_SRC_NOT_SUPPORTED),
            platform: "windows",
          }),
        );
        expect(view.reason).toMatchObject({ values: { container: "AVI" } });
        expect(view.hintKey).toBe("preview.decodeFailure.hint.convertH264");
      }
    });

    it("suggests MP4 for browser-safe H.264 without a stated bit depth", () => {
      const view = presentDecodeFailure(
        input({
          probe: probe({
            formatNames: ["flv"],
            videoCodec: "H264",
            pixelFormat: "nv12",
            bitDepth: null,
          }),
          fileName: "a.flv",
          trigger: mediaError(MEDIA_ERR_SRC_NOT_SUPPORTED),
        }),
      );
      expect(view.hintKey).toBe("preview.decodeFailure.hint.convertMp4");
    });

    it("names MKV on macOS", () => {
      const view = presentDecodeFailure(
        input({
          probe: probe({ formatNames: ["matroska", "webm"] }),
          fileName: "a.mkv",
          trigger: mediaError(MEDIA_ERR_SRC_NOT_SUPPORTED),
          platform: "macos",
        }),
      );
      expect(view.reason).toMatchObject({ values: { container: "MKV" } });
    });

    it("gives the neutral message for MKV on Windows, which WebView2 opens", () => {
      const view = presentDecodeFailure(
        input({
          probe: probe({ formatNames: ["matroska", "webm"] }),
          fileName: "a.mkv",
          trigger: mediaError(MEDIA_ERR_SRC_NOT_SUPPORTED),
          platform: "windows",
        }),
      );
      expect(view.reason.key).toBe("preview.decodeFailure.cannotPlay.full");
    });

    it("gives the neutral message for an unsupported source in a typical container", () => {
      expect(
        presentDecodeFailure(
          input({ trigger: mediaError(MEDIA_ERR_SRC_NOT_SUPPORTED) }),
        ).reason,
      ).toEqual({
        shape: "full",
        key: "preview.decodeFailure.cannotPlay.full",
        values: { codec: "HEVC", profile: "Main 10", pixelFormat: "yuv420p10le" },
      });
    });

    it("gives the neutral message for a decode error, even in an unplayable container", () => {
      const view = presentDecodeFailure(
        input({
          probe: probe({ formatNames: ["avi"] }),
          fileName: "a.avi",
          trigger: mediaError(MEDIA_ERR_DECODE),
        }),
      );
      expect(view.reason.key).toBe("preview.decodeFailure.cannotPlay.full");
    });

    it("gives the neutral message when the element reports no error code", () => {
      for (const code of [null, 0, 99]) {
        const view = presentDecodeFailure(input({ trigger: mediaError(code) }));
        expect(view.reason.key).toBe("preview.decodeFailure.cannotPlay.full");
      }
    });

    it("selects the neutral variant that matches the stated probe fields", () => {
      const trigger = mediaError(MEDIA_ERR_DECODE);
      expect(
        presentDecodeFailure(input({ probe: probe({ videoProfile: null }), trigger }))
          .reason,
      ).toEqual({
        shape: "noProfile",
        key: "preview.decodeFailure.cannotPlay.noProfile",
        values: { codec: "HEVC", pixelFormat: "yuv420p10le" },
      });
      expect(
        presentDecodeFailure(input({ probe: probe({ pixelFormat: null }), trigger }))
          .reason,
      ).toEqual({
        shape: "noPixelFormat",
        key: "preview.decodeFailure.cannotPlay.noPixelFormat",
        values: { codec: "HEVC", profile: "Main 10" },
      });
      expect(
        presentDecodeFailure(
          input({ probe: probe({ videoProfile: null, pixelFormat: null }), trigger }),
        ).reason,
      ).toEqual({
        shape: "codecOnly",
        key: "preview.decodeFailure.cannotPlay.codecOnly",
        values: { codec: "HEVC" },
      });
    });
  });

  describe("the hint", () => {
    it("names the HEVC Video Extensions for 4:2:0 HEVC on Windows", () => {
      expect(presentDecodeFailure(input({ platform: "windows" })).hintKey).toBe(
        "preview.decodeFailure.hint.installHevc",
      );
    });

    it("names the HEVC Video Extensions when ffprobe states no pixel format", () => {
      const view = presentDecodeFailure(
        input({ probe: probe({ pixelFormat: null }), platform: "windows" }),
      );
      expect(view.hintKey).toBe("preview.decodeFailure.hint.installHevc");
    });

    it("gives the H.264 conversion for HEVC with 4:2:2 or 4:4:4 chroma on Windows", () => {
      for (const pixelFormat of ["yuv422p10le", "yuv444p"]) {
        const view = presentDecodeFailure(
          input({ probe: probe({ pixelFormat }), platform: "windows" }),
        );
        expect(view.hintKey).toBe("preview.decodeFailure.hint.convertH264");
      }
    });

    it("gives the H.264 conversion for HEVC with more than 10 bits on Windows", () => {
      const cases: Partial<DecodeFailureProbe>[] = [
        { pixelFormat: "yuv420p12le", bitDepth: 12 },
        { pixelFormat: "yuv420p12be", bitDepth: null },
        { pixelFormat: "p012le", bitDepth: null },
        { pixelFormat: "p016le", bitDepth: 16 },
        // The probe's depth counts even when the pixel format is not stated.
        { pixelFormat: null, bitDepth: 12 },
      ];
      for (const overrides of cases) {
        const view = presentDecodeFailure(
          input({ probe: probe(overrides), platform: "windows" }),
        );
        expect(view.hintKey).toBe("preview.decodeFailure.hint.convertH264");
      }
    });

    it("names the HEVC Video Extensions for 8-bit and 10-bit HEVC on Windows", () => {
      const cases: Partial<DecodeFailureProbe>[] = [
        { pixelFormat: "yuv420p", bitDepth: 8 },
        { pixelFormat: "yuv420p10le", bitDepth: 10 },
        { pixelFormat: "p010le", bitDepth: null },
        { pixelFormat: null, bitDepth: null },
      ];
      for (const overrides of cases) {
        const view = presentDecodeFailure(
          input({ probe: probe(overrides), platform: "windows" }),
        );
        expect(view.hintKey).toBe("preview.decodeFailure.hint.installHevc");
      }
    });

    it("recognizes the HEVC codec name in any letter case", () => {
      const view = presentDecodeFailure(
        input({ probe: probe({ videoCodec: "HEVC" }), platform: "windows" }),
      );
      expect(view.hintKey).toBe("preview.decodeFailure.hint.installHevc");
    });

    it("gives the H.264 conversion for HEVC on another platform", () => {
      for (const platform of ["macos", "other"] as const) {
        expect(presentDecodeFailure(input({ platform })).hintKey).toBe(
          "preview.decodeFailure.hint.convertH264",
        );
      }
    });

    it("gives the H.264 conversion for another codec on Windows", () => {
      for (const videoCodec of ["av1", "prores", "vp9", "h264"]) {
        const view = presentDecodeFailure(
          input({ probe: probe({ videoCodec }), platform: "windows" }),
        );
        expect(view.hintKey).toBe("preview.decodeFailure.hint.convertH264");
      }
    });

    it("applies the codec hint to the neutral message too", () => {
      const view = presentDecodeFailure(
        input({
          trigger: mediaError(MEDIA_ERR_SRC_NOT_SUPPORTED),
          platform: "windows",
        }),
      );
      expect(view.reason.key).toBe("preview.decodeFailure.cannotPlay.full");
      expect(view.hintKey).toBe("preview.decodeFailure.hint.installHevc");
    });
  });

  describe("the catalogs", () => {
    it("hold every reason and hint key as a string in both languages", () => {
      for (const key of [...ALL_REASON_KEYS, ...ALL_HINT_KEYS]) {
        for (const catalog of [en, zhCN]) {
          expect(typeof lookup(catalog, key)).toBe("string");
        }
      }
    });

    it("receive exactly the placeholders of the selected message", () => {
      const inputs: DecodeFailureInput[] = [];
      for (const trigger of [PICTURE_MISSING, mediaError(MEDIA_ERR_DECODE)]) {
        for (const overrides of [
          {},
          { videoProfile: null },
          { pixelFormat: null },
          { videoProfile: null, pixelFormat: null },
        ]) {
          inputs.push(input({ trigger, probe: probe(overrides) }));
        }
      }
      inputs.push(
        input({
          trigger: mediaError(MEDIA_ERR_SRC_NOT_SUPPORTED),
          probe: probe({ formatNames: ["avi"] }),
          fileName: "a.avi",
        }),
        input({ trigger: mediaError(MEDIA_ERR_NETWORK) }),
      );

      const seen = new Set<string>();
      for (const value of inputs) {
        const { reason } = presentDecodeFailure(value);
        seen.add(reason.key);
        const expected = "values" in reason ? Object.keys(reason.values).sort() : [];
        for (const catalog of [en, zhCN]) {
          const message = lookup(catalog, reason.key);
          expect(typeof message).toBe("string");
          expect(extractPlaceholders(message as string)).toEqual(expected);
        }
      }
      // The inputs above reach every reason message.
      expect([...seen].sort()).toEqual([...ALL_REASON_KEYS].sort());
    });

    it("wrap every placeholder of a reason message in a mono tag", () => {
      for (const key of ALL_REASON_KEYS) {
        for (const catalog of [en, zhCN]) {
          const message = lookup(catalog, key) as string;
          // Remove each mono span. No placeholder and no stray tag may remain.
          const outside = message.replace(/<mono>[^<]*<\/mono>/g, "");
          expect(extractPlaceholders(outside)).toEqual([]);
          expect(outside).not.toMatch(/<\/?mono>/);
        }
      }
    });
  });
});
