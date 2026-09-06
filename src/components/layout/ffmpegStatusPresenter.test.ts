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
        {
          key: "ffmpeg.detail.origin.path",
          id: "ffmpeg.detail.origin.path#0",
          mono: false,
        },
        {
          key: "ffmpeg.detail.program",
          values: { path: "/opt/homebrew/bin/ffmpeg" },
          id: "ffmpeg.detail.program#1",
          mono: false,
        },
        {
          key: "ffmpeg.detail.version",
          values: { version: "7.1.1" },
          id: "ffmpeg.detail.version#2",
          mono: false,
        },
        {
          key: "ffmpeg.detail.license.gpl",
          id: "ffmpeg.detail.license.gpl#3",
          mono: false,
        },
        {
          key: "ffmpeg.detail.hardware",
          values: { methods: "videotoolbox" },
          id: "ffmpeg.detail.hardware#4",
          mono: false,
        },
        {
          key: "ffmpeg.detail.workingEncoders",
          values: {
            encoders: "h264_videotoolbox, hevc_videotoolbox, libx264, libx265, aac",
          },
          id: "ffmpeg.detail.workingEncoders#5",
          mono: false,
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
        {
          key: "ffmpeg.detail.origin.configured",
          id: "ffmpeg.detail.origin.configured#0",
          mono: false,
        },
        {
          key: "ffmpeg.detail.program",
          values: { path: "/usr/local/bin/ffmpeg" },
          id: "ffmpeg.detail.program#1",
          mono: false,
        },
        {
          key: "ffmpeg.detail.version",
          values: { version: "6.1" },
          id: "ffmpeg.detail.version#2",
          mono: false,
        },
        {
          key: "ffmpeg.detail.license.gpl",
          id: "ffmpeg.detail.license.gpl#3",
          mono: false,
        },
        {
          key: "ffmpeg.detail.license.nonfree",
          id: "ffmpeg.detail.license.nonfree#4",
          mono: false,
        },
        {
          key: "ffmpeg.detail.license.version3",
          id: "ffmpeg.detail.license.version3#5",
          mono: false,
        },
        {
          key: "ffmpeg.detail.hardware",
          values: { methods: "cuda, vdpau" },
          id: "ffmpeg.detail.hardware#6",
          mono: false,
        },
        {
          key: "ffmpeg.detail.workingEncoders",
          values: { encoders: "libx264" },
          id: "ffmpeg.detail.workingEncoders#7",
          mono: false,
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
      expect(view.detail).toContainEqual({
        key: "ffmpeg.detail.origin.appData",
        id: "ffmpeg.detail.origin.appData#0",
        mono: false,
      });
      expect(view.detail).toContainEqual({
        key: "ffmpeg.detail.license.none",
        id: "ffmpeg.detail.license.none#3",
        mono: false,
      });
      expect(view.detail).toContainEqual({
        key: "ffmpeg.detail.hardwareNone",
        id: "ffmpeg.detail.hardwareNone#4",
        mono: false,
      });
      expect(view.detail).toContainEqual({
        key: "ffmpeg.detail.noWorkingEncoders",
        id: "ffmpeg.detail.noWorkingEncoders#5",
        mono: false,
      });
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
        {
          key: "ffmpeg.detail.origin.path",
          id: "ffmpeg.detail.origin.path#0",
          mono: false,
        },
        {
          key: "ffmpeg.detail.program",
          values: { path: "/opt/homebrew/bin/ffmpeg" },
          id: "ffmpeg.detail.program#1",
          mono: false,
        },
        {
          key: "ffmpeg.detail.version",
          values: { version: "7.1" },
          id: "ffmpeg.detail.version#2",
          mono: false,
        },
        {
          key: "ffmpeg.detail.license.nonfree",
          id: "ffmpeg.detail.license.nonfree#3",
          mono: false,
        },
        {
          key: "ffmpeg.detail.hardware",
          values: { methods: "videotoolbox" },
          id: "ffmpeg.detail.hardware#4",
          mono: false,
        },
        {
          key: "ffmpeg.detail.workingEncoders",
          values: { encoders: "libx264" },
          id: "ffmpeg.detail.workingEncoders#5",
          mono: false,
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
        {
          key: "ffmpeg.detail.license.none",
          id: "ffmpeg.detail.license.none#0",
          mono: false,
        },
        {
          key: "ffmpeg.detail.hardwareNone",
          id: "ffmpeg.detail.hardwareNone#1",
          mono: false,
        },
        {
          key: "ffmpeg.detail.noWorkingEncoders",
          id: "ffmpeg.detail.noWorkingEncoders#2",
          mono: false,
        },
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
            id: "ffmpegError.ffmpegPairMissing#0",
            mono: false,
          },
          {
            key: "ffmpeg.detail.searchedPair.configured",
            values: {
              path: "/Users/user/.config/quipclip/bin/ffmpeg",
              probe: "/Users/user/.config/quipclip/bin/ffprobe",
            },
            id: "ffmpeg.detail.searchedPair.configured#1",
            mono: false,
          },
          {
            key: "ffmpeg.detail.searchedPair.path",
            values: {
              path: "/opt/homebrew/bin/ffmpeg",
              probe: "/opt/homebrew/bin/ffprobe",
            },
            id: "ffmpeg.detail.searchedPair.path#2",
            mono: false,
          },
          {
            key: "ffmpeg.detail.searchedPair.path",
            values: {
              path: "/usr/local/bin/ffmpeg",
              probe: "/usr/local/bin/ffprobe",
            },
            id: "ffmpeg.detail.searchedPair.path#3",
            mono: false,
          },
          {
            key: "ffmpeg.detail.searchedPair.appData",
            values: {
              path: "/Users/user/Library/Application Support/quipclip/ffmpeg",
              probe: "/Users/user/Library/Application Support/quipclip/ffprobe",
            },
            id: "ffmpeg.detail.searchedPair.appData#4",
            mono: false,
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
        detail: [
          {
            key: "ffmpegError.ffmpegPairMissing",
            id: "ffmpegError.ffmpegPairMissing#0",
            mono: false,
          },
        ],
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
        detail: [
          {
            key: "ffmpegError.ffmpegPairMissing",
            id: "ffmpegError.ffmpegPairMissing#0",
            mono: false,
          },
        ],
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
          {
            key: "ffmpegError.ffmpegPairMissing",
            id: "ffmpegError.ffmpegPairMissing#0",
            mono: false,
          },
          {
            key: "ffmpeg.detail.raw",
            values: { detail: "ffmpeg present but ffprobe absent" },
            id: "ffmpeg.detail.raw#1",
            mono: true,
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
            id: "ffmpegError.ffmpegSpawnFailed#0",
            mono: false,
          },
          {
            key: "ffmpeg.detail.raw",
            values: { detail: "execve: /usr/bin/ffmpeg permission denied" },
            id: "ffmpeg.detail.raw#1",
            mono: true,
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
            id: "ffmpegError.cacheUnavailable#0",
            mono: false,
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
            id: "ffmpegError.unknown#0",
            mono: false,
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
            id: "ffmpegError.unknown#0",
            mono: false,
          },
          {
            key: "ffmpeg.detail.raw",
            values: { detail: "unexpected system fault" },
            id: "ffmpeg.detail.raw#1",
            mono: true,
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
          { key: `ffmpegError.${code}`, id: `ffmpegError.${code}#0`, mono: false },
          {
            key: "ffmpeg.detail.raw",
            values: { detail: `Diagnostic for ${code}` },
            id: "ffmpeg.detail.raw#1",
            mono: true,
          },
        ]);
      },
    );
  });

  describe("detail entry ids and mono flag", () => {
    it("marks only the raw diagnostic entry as mono", () => {
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

      const monoEntries = view.detail.filter((entry) => entry.mono);
      const nonMonoEntries = view.detail.filter((entry) => !entry.mono);

      expect(monoEntries).toEqual([
        {
          key: "ffmpeg.detail.raw",
          values: { detail: "execve: /usr/bin/ffmpeg permission denied" },
          id: "ffmpeg.detail.raw#1",
          mono: true,
        },
      ]);
      expect(nonMonoEntries).toEqual([
        {
          key: "ffmpegError.ffmpegSpawnFailed",
          id: "ffmpegError.ffmpegSpawnFailed#0",
          mono: false,
        },
      ]);
    });

    it("gives every detail entry a unique id even when entries share a key", () => {
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
      ];
      const state: FfmpegState = {
        ...createBaseState(),
        status: "missing",
        inspected,
      };

      const view = presentFfmpegStatus(state, format);
      const ids = view.detail.map((entry) => entry.id);

      // Several entries share the "ffmpeg.detail.searchedPair.path" key; ids must still be
      // pairwise distinct, so the set of ids is exactly as large as the detail array.
      expect(new Set(ids).size).toBe(view.detail.length);
    });
  });
});
