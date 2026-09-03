import { describe, expect, it } from "vitest";
import {
  BACKEND_CAPABILITY_PROBE_ERROR_CODES,
  CapabilityProbeError,
  type EncoderResult,
  type FfmpegState,
  type InspectedCandidate,
} from "@/features/ffmpeg/types";
import { presentFfmpegStatus } from "./ffmpegStatusPresenter";

function createFormatters(locale = "en") {
  return {
    list: new Intl.ListFormat(locale, { style: "long", type: "unit" }),
    number: new Intl.NumberFormat(locale),
  };
}

function createBaseState(): FfmpegState {
  return {
    status: "idle",
    runId: null,
    paths: null,
    origin: null,
    version: null,
    license: null,
    hwaccels: [],
    results: [],
    done: 0,
    total: 0,
    source: null,
    error: null,
    inspected: null,
  };
}

describe("presentFfmpegStatus", () => {
  const format = createFormatters("en");

  describe("idle and locating statuses", () => {
    it("presents idle status as locating with neutral tone and empty detail", () => {
      const state: FfmpegState = { ...createBaseState(), status: "idle" };
      const view = presentFfmpegStatus(state, format);

      expect(view).toEqual({
        lineKey: "ffmpeg.status.locating",
        lineValues: {},
        detail: [],
        tone: "neutral",
      });
    });

    it("presents locating status as locating with neutral tone and empty detail", () => {
      const state: FfmpegState = { ...createBaseState(), status: "locating" };
      const view = presentFfmpegStatus(state, format);

      expect(view).toEqual({
        lineKey: "ffmpeg.status.locating",
        lineValues: {},
        detail: [],
        tone: "neutral",
      });
    });
  });

  describe("probing status", () => {
    it("formats done and total using injected number formatter with neutral tone", () => {
      const state: FfmpegState = {
        ...createBaseState(),
        status: "probing",
        done: 4,
        total: 12,
      };
      const view = presentFfmpegStatus(state, format);

      expect(view).toEqual({
        lineKey: "ffmpeg.status.probing",
        lineValues: {
          done: "4",
          total: "12",
        },
        detail: [],
        tone: "neutral",
      });
    });

    it("uses locale-specific number grouping for large counts", () => {
      const deFormat = createFormatters("de-DE");
      const state: FfmpegState = {
        ...createBaseState(),
        status: "probing",
        done: 1000,
        total: 2500,
      };
      const view = presentFfmpegStatus(state, deFormat);

      expect(view.lineValues).toEqual({
        done: "1.000",
        total: "2.500",
      });
    });
  });

  describe("ready status", () => {
    it("presents ready status with a mix of working and failed encoders", () => {
      const results: EncoderResult[] = [
        { name: "h264_videotoolbox", kind: "video", listed: true, status: "works" },
        { name: "hevc_videotoolbox", kind: "video", listed: true, status: "works" },
        { name: "libx264", kind: "video", listed: true, status: "works" },
        { name: "libx265", kind: "video", listed: true, status: "works" },
        { name: "aac", kind: "audio", listed: true, status: "works" },
        { name: "h264_nvenc", kind: "video", listed: false, status: "notListed" },
        { name: "hevc_nvenc", kind: "video", listed: false, status: "notListed" },
        { name: "h264_amf", kind: "video", listed: false, status: "notListed" },
        {
          name: "h264_qsv",
          kind: "video",
          listed: true,
          status: "failed",
          exitCode: 1,
        },
        { name: "libfdk_aac", kind: "audio", listed: true, status: "failed" },
        { name: "libsvtav1", kind: "video", listed: true, status: "timedOut" },
        { name: "libopus", kind: "audio", listed: true, status: "timedOut" },
      ];

      const state: FfmpegState = {
        ...createBaseState(),
        status: "ready",
        origin: "path",
        paths: {
          ffmpeg: "/opt/homebrew/bin/ffmpeg",
          ffprobe: "/opt/homebrew/bin/ffprobe",
        },
        version: "7.1.1",
        license: {
          gpl: true,
          nonfree: false,
          version3: false,
        },
        hwaccels: ["videotoolbox"],
        results,
        done: 12,
        total: 12,
      };

      const view = presentFfmpegStatus(state, format);

      expect(view.lineKey).toBe("ffmpeg.status.ready");
      expect(view.lineValues).toEqual({
        version: "7.1.1",
        working: "5",
        tested: "12",
      });
      expect(view.tone).toBe("ready");

      expect(view.detail).toEqual([
        { key: "ffmpeg.detail.origin.path" },
        {
          key: "ffmpeg.detail.program",
          values: { path: "/opt/homebrew/bin/ffmpeg" },
        },
        {
          key: "ffmpeg.detail.version",
          values: { version: "7.1.1" },
        },
        { key: "ffmpeg.detail.license.gpl" },
        {
          key: "ffmpeg.detail.hardware",
          values: { methods: "videotoolbox" },
        },
        {
          key: "ffmpeg.detail.workingEncoders",
          values: {
            encoders: "h264_videotoolbox, hevc_videotoolbox, libx264, libx265, aac",
          },
        },
      ]);
    });

    it("presents multiple license flags in order when enabled", () => {
      const state: FfmpegState = {
        ...createBaseState(),
        status: "ready",
        origin: "configured",
        paths: {
          ffmpeg: "/usr/local/bin/ffmpeg",
          ffprobe: "/usr/local/bin/ffprobe",
        },
        version: "6.1",
        license: {
          gpl: true,
          nonfree: true,
          version3: true,
        },
        hwaccels: ["cuda", "vdpau"],
        results: [{ name: "libx264", kind: "video", listed: true, status: "works" }],
        done: 1,
        total: 1,
      };

      const view = presentFfmpegStatus(state, format);

      expect(view.detail).toEqual([
        { key: "ffmpeg.detail.origin.configured" },
        {
          key: "ffmpeg.detail.program",
          values: { path: "/usr/local/bin/ffmpeg" },
        },
        {
          key: "ffmpeg.detail.version",
          values: { version: "6.1" },
        },
        { key: "ffmpeg.detail.license.gpl" },
        { key: "ffmpeg.detail.license.nonfree" },
        { key: "ffmpeg.detail.license.version3" },
        {
          key: "ffmpeg.detail.hardware",
          values: { methods: "cuda, vdpau" },
        },
        {
          key: "ffmpeg.detail.workingEncoders",
          values: { encoders: "libx264" },
        },
      ]);
    });

    it("presents license.none, hardwareNone, and noWorkingEncoders when flags/lists are empty", () => {
      const state: FfmpegState = {
        ...createBaseState(),
        status: "ready",
        origin: "appData",
        paths: {
          ffmpeg: "/app/data/ffmpeg",
          ffprobe: "/app/data/ffprobe",
        },
        version: "5.0",
        license: {
          gpl: false,
          nonfree: false,
          version3: false,
        },
        hwaccels: [],
        results: [{ name: "libx264", kind: "video", listed: true, status: "failed" }],
        done: 1,
        total: 1,
      };

      const view = presentFfmpegStatus(state, format);

      expect(view.lineValues).toEqual({
        version: "5.0",
        working: "0",
        tested: "1",
      });
      expect(view.tone).toBe("warning");
      expect(view.detail).toContainEqual({ key: "ffmpeg.detail.origin.appData" });
      expect(view.detail).toContainEqual({ key: "ffmpeg.detail.license.none" });
      expect(view.detail).toContainEqual({ key: "ffmpeg.detail.hardwareNone" });
      expect(view.detail).toContainEqual({ key: "ffmpeg.detail.noWorkingEncoders" });
    });

    it("returns tone 'warning' when ready with zero working encoders", () => {
      const state: FfmpegState = {
        ...createBaseState(),
        status: "ready",
        version: "7.1",
        results: [
          { name: "libx264", kind: "video", listed: true, status: "failed" },
          { name: "libx265", kind: "video", listed: true, status: "timedOut" },
        ],
        done: 2,
        total: 2,
      };

      const view = presentFfmpegStatus(state, format);
      expect(view.lineValues).toEqual({
        version: "7.1",
        working: "0",
        tested: "2",
      });
      expect(view.tone).toBe("warning");
    });

    it("presents nonfree license without gpl or fallback none, asserted with toEqual on the whole detail array", () => {
      const state: FfmpegState = {
        ...createBaseState(),
        status: "ready",
        origin: "path",
        paths: {
          ffmpeg: "/opt/homebrew/bin/ffmpeg",
          ffprobe: "/opt/homebrew/bin/ffprobe",
        },
        version: "7.1",
        license: {
          gpl: false,
          nonfree: true,
          version3: false,
        },
        hwaccels: ["videotoolbox"],
        results: [{ name: "libx264", kind: "video", listed: true, status: "works" }],
        done: 1,
        total: 1,
      };

      const view = presentFfmpegStatus(state, format);

      expect(view.tone).toBe("ready");
      expect(view.detail).toEqual([
        { key: "ffmpeg.detail.origin.path" },
        {
          key: "ffmpeg.detail.program",
          values: { path: "/opt/homebrew/bin/ffmpeg" },
        },
        {
          key: "ffmpeg.detail.version",
          values: { version: "7.1" },
        },
        { key: "ffmpeg.detail.license.nonfree" },
        {
          key: "ffmpeg.detail.hardware",
          values: { methods: "videotoolbox" },
        },
        {
          key: "ffmpeg.detail.workingEncoders",
          values: { encoders: "libx264" },
        },
      ]);
    });

    it("presents ready status when origin, paths, and version are all null", () => {
      const state: FfmpegState = {
        ...createBaseState(),
        status: "ready",
        origin: null,
        paths: null,
        version: null,
        license: {
          gpl: false,
          nonfree: false,
          version3: false,
        },
        hwaccels: [],
        results: [],
        done: 0,
        total: 0,
      };

      const view = presentFfmpegStatus(state, format);

      expect(view.lineValues).toEqual({
        version: "",
        working: "0",
        tested: "0",
      });
      expect(view.tone).toBe("warning");
      expect(view.detail).toEqual([
        { key: "ffmpeg.detail.license.none" },
        { key: "ffmpeg.detail.hardwareNone" },
        { key: "ffmpeg.detail.noWorkingEncoders" },
      ]);
    });
  });

  describe("missing status", () => {
    it("presents missing status with every inspected candidate in exact search order", () => {
      const inspected: InspectedCandidate[] = [
        {
          ffmpeg: "/Users/user/.config/quipclip/bin/ffmpeg",
          ffprobe: "/Users/user/.config/quipclip/bin/ffprobe",
          origin: "configured",
        },
        {
          ffmpeg: "/opt/homebrew/bin/ffmpeg",
          ffprobe: "/opt/homebrew/bin/ffprobe",
          origin: "path",
        },
        {
          ffmpeg: "/usr/local/bin/ffmpeg",
          ffprobe: "/usr/local/bin/ffprobe",
          origin: "path",
        },
        {
          ffmpeg: "/Users/user/Library/Application Support/quipclip/ffmpeg",
          ffprobe: "/Users/user/Library/Application Support/quipclip/ffprobe",
          origin: "appData",
        },
      ];

      const state: FfmpegState = {
        ...createBaseState(),
        status: "missing",
        inspected,
      };

      const view = presentFfmpegStatus(state, format);

      expect(view).toEqual({
        lineKey: "ffmpeg.status.missing",
        lineValues: {},
        detail: [
          {
            key: "ffmpegError.ffmpegPairMissing",
          },
          {
            key: "ffmpeg.detail.searchedPair",
            values: {
              path: "/Users/user/.config/quipclip/bin/ffmpeg",
              probe: "/Users/user/.config/quipclip/bin/ffprobe",
              origin: "configured",
            },
          },
          {
            key: "ffmpeg.detail.searchedPair",
            values: {
              path: "/opt/homebrew/bin/ffmpeg",
              probe: "/opt/homebrew/bin/ffprobe",
              origin: "path",
            },
          },
          {
            key: "ffmpeg.detail.searchedPair",
            values: {
              path: "/usr/local/bin/ffmpeg",
              probe: "/usr/local/bin/ffprobe",
              origin: "path",
            },
          },
          {
            key: "ffmpeg.detail.searchedPair",
            values: {
              path: "/Users/user/Library/Application Support/quipclip/ffmpeg",
              probe: "/Users/user/Library/Application Support/quipclip/ffprobe",
              origin: "appData",
            },
          },
        ],
        tone: "warning",
      });
    });

    it("presents missing status with non-empty detail when inspected is null", () => {
      const state: FfmpegState = {
        ...createBaseState(),
        status: "missing",
        inspected: null,
      };

      const view = presentFfmpegStatus(state, format);

      expect(view).toEqual({
        lineKey: "ffmpeg.status.missing",
        lineValues: {},
        detail: [{ key: "ffmpegError.ffmpegPairMissing" }],
        tone: "warning",
      });
      expect(view.detail.length).toBeGreaterThan(0);
    });

    it("presents missing status with non-empty detail when inspected is empty array", () => {
      const state: FfmpegState = {
        ...createBaseState(),
        status: "missing",
        inspected: [],
      };

      const view = presentFfmpegStatus(state, format);

      expect(view).toEqual({
        lineKey: "ffmpeg.status.missing",
        lineValues: {},
        detail: [{ key: "ffmpegError.ffmpegPairMissing" }],
        tone: "warning",
      });
      expect(view.detail.length).toBeGreaterThan(0);
    });

    it("presents missing status with informative error line and raw detail when error has detail", () => {
      const error = new CapabilityProbeError({
        code: "ffmpegPairMissing",
        detail: "ffmpeg present but ffprobe absent",
      });

      const state: FfmpegState = {
        ...createBaseState(),
        status: "missing",
        error,
        inspected: [],
      };

      const view = presentFfmpegStatus(state, format);

      expect(view).toEqual({
        lineKey: "ffmpeg.status.missing",
        lineValues: {},
        detail: [
          { key: "ffmpegError.ffmpegPairMissing" },
          {
            key: "ffmpeg.detail.raw",
            values: { detail: "ffmpeg present but ffprobe absent" },
          },
        ],
        tone: "warning",
      });
      expect(view.detail.length).toBeGreaterThan(0);
    });
  });

  describe("failed status", () => {
    it("presents failed status with known backend error code and diagnostic detail", () => {
      const error = new CapabilityProbeError({
        code: "ffmpegSpawnFailed",
        detail: "execve: /usr/bin/ffmpeg permission denied",
        exitCode: 126,
      });

      const state: FfmpegState = {
        ...createBaseState(),
        status: "failed",
        error,
      };

      const view = presentFfmpegStatus(state, format);

      expect(view).toEqual({
        lineKey: "ffmpeg.status.failed",
        lineValues: {},
        detail: [
          {
            key: "ffmpegError.ffmpegSpawnFailed",
          },
          {
            key: "ffmpeg.detail.raw",
            values: { detail: "execve: /usr/bin/ffmpeg permission denied" },
          },
        ],
        tone: "warning",
      });
    });

    it("presents failed status with known backend error code without detail", () => {
      const error = new CapabilityProbeError({
        code: "cacheUnavailable",
      });

      const state: FfmpegState = {
        ...createBaseState(),
        status: "failed",
        error,
      };

      const view = presentFfmpegStatus(state, format);

      expect(view).toEqual({
        lineKey: "ffmpeg.status.failed",
        lineValues: {},
        detail: [
          {
            key: "ffmpegError.cacheUnavailable",
          },
        ],
        tone: "warning",
      });
    });

    it("falls back to ffmpegError.unknown when error is null or code is unrecognized", () => {
      const stateNullError: FfmpegState = {
        ...createBaseState(),
        status: "failed",
        error: null,
      };

      expect(presentFfmpegStatus(stateNullError, format)).toEqual({
        lineKey: "ffmpeg.status.failed",
        lineValues: {},
        detail: [
          {
            key: "ffmpegError.unknown",
          },
        ],
        tone: "warning",
      });

      const errorUnrecognized = new CapabilityProbeError({
        code: "customErrorCode" as unknown as "unknown",
        detail: "unexpected system fault",
      });
      const stateUnrecognized: FfmpegState = {
        ...createBaseState(),
        status: "failed",
        error: errorUnrecognized,
      };

      expect(presentFfmpegStatus(stateUnrecognized, format)).toEqual({
        lineKey: "ffmpeg.status.failed",
        lineValues: {},
        detail: [
          {
            key: "ffmpegError.unknown",
          },
          {
            key: "ffmpeg.detail.raw",
            values: { detail: "unexpected system fault" },
          },
        ],
        tone: "warning",
      });
    });

    it.each(BACKEND_CAPABILITY_PROBE_ERROR_CODES)(
      "maps backend error code '%s' to ffmpegError.%s",
      (code) => {
        const error = new CapabilityProbeError({
          code,
          detail: `Diagnostic for ${code}`,
        });
        const state: FfmpegState = {
          ...createBaseState(),
          status: "failed",
          error,
        };

        const view = presentFfmpegStatus(state, format);
        expect(view.detail).toEqual([
          { key: `ffmpegError.${code}` },
          {
            key: "ffmpeg.detail.raw",
            values: { detail: `Diagnostic for ${code}` },
          },
        ]);
      },
    );
  });
});
