import { describe, expect, it } from "vitest";
import {
  BACKEND_CAPABILITY_PROBE_ERROR_CODES,
  CapabilityProbeError,
  type EncoderResult,
  type FfmpegState,
  type InspectedCandidate,
} from "@/features/ffmpeg/types";
import { en } from "@/i18n/locales/en";
import {
  presentFfmpegStatus,
  SHORT_VERSION_MAX_LENGTH,
  shortVersion,
} from "./ffmpegStatusPresenter";

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
        labelKey: "ffmpeg.status.locating",
        labelValues: {},
        summary: [
          {
            key: "ffmpeg.status.locating",
            id: "ffmpeg.status.locating#0",
            mono: false,
          },
        ],
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
        labelKey: "ffmpeg.status.locating",
        labelValues: {},
        summary: [
          {
            key: "ffmpeg.status.locating",
            id: "ffmpeg.status.locating#0",
            mono: false,
          },
        ],
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
        labelKey: "ffmpeg.status.probing",
        labelValues: {
          done: "4",
          total: "12",
        },
        summary: [
          {
            key: "ffmpeg.status.probing",
            values: { done: "4", total: "12" },
            id: "ffmpeg.status.probing#0",
            mono: false,
          },
        ],
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

      // The status bar label holds the short version only. The tooltip summary holds the
      // complete line with the encoder count, and the program path.
      expect(view.labelKey).toBe("ffmpeg.status.readyShort");
      expect(view.labelValues).toEqual({ version: "7.1.1" });
      expect(view.summary).toEqual([
        {
          key: "ffmpeg.status.ready",
          values: { version: "7.1.1", working: "5", tested: "12" },
          id: "ffmpeg.status.ready#0",
          mono: false,
        },
        {
          key: "ffmpeg.detail.program",
          values: { path: "/opt/homebrew/bin/ffmpeg" },
          id: "ffmpeg.detail.program#1",
          mono: false,
        },
      ]);

      expect(view.detail).toEqual([
        {
          key: "ffmpeg.detail.version",
          values: { version: "7.1.1" },
          id: "ffmpeg.detail.version#0",
          mono: false,
        },
        {
          key: "ffmpeg.detail.license.gpl",
          id: "ffmpeg.detail.license.gpl#1",
          mono: false,
        },
        {
          key: "ffmpeg.detail.hardware",
          values: { methods: "videotoolbox" },
          id: "ffmpeg.detail.hardware#2",
          mono: false,
        },
        {
          key: "ffmpeg.detail.workingEncoders",
          values: {
            encoders: "h264_videotoolbox, hevc_videotoolbox, libx264, libx265, aac",
          },
          id: "ffmpeg.detail.workingEncoders#3",
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
          key: "ffmpeg.detail.version",
          values: { version: "6.1" },
          id: "ffmpeg.detail.version#0",
          mono: false,
        },
        {
          key: "ffmpeg.detail.license.gpl",
          id: "ffmpeg.detail.license.gpl#1",
          mono: false,
        },
        {
          key: "ffmpeg.detail.license.nonfree",
          id: "ffmpeg.detail.license.nonfree#2",
          mono: false,
        },
        {
          key: "ffmpeg.detail.license.version3",
          id: "ffmpeg.detail.license.version3#3",
          mono: false,
        },
        {
          key: "ffmpeg.detail.hardware",
          values: { methods: "cuda, vdpau" },
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
        key: "ffmpeg.detail.license.none",
        id: "ffmpeg.detail.license.none#1",
        mono: false,
      });
      expect(view.detail).toContainEqual({
        key: "ffmpeg.detail.hardwareNone",
        id: "ffmpeg.detail.hardwareNone#2",
        mono: false,
      });
      expect(view.detail).toContainEqual({
        key: "ffmpeg.detail.noWorkingEncoders",
        id: "ffmpeg.detail.noWorkingEncoders#3",
        mono: false,
      });
    });

    it.each(["configured", "path", "appData"] as const)(
      "leaves the program path and the %s origin out of the detail, because Settings shows them in its location block",
      (origin) => {
        const state: FfmpegState = {
          ...createBaseState(),
          status: "ready",
          origin,
          paths: { ffmpeg: "/tools/ffmpeg", ffprobe: "/tools/ffprobe" },
          version: "7.1",
          results: [{ name: "libx264", kind: "video", listed: true, status: "works" }],
          done: 1,
          total: 1,
        };

        const view = presentFfmpegStatus(state, format);

        const keys = view.detail.map((entry) => entry.key);
        expect(keys).not.toContain("ffmpeg.detail.program");
        expect(keys.some((key) => key.startsWith("ffmpeg.detail.origin"))).toBe(false);
        expect(keys[0]).toBe("ffmpeg.detail.version");
        // The status bar tooltip still names the program.
        expect(view.summary).toContainEqual({
          key: "ffmpeg.detail.program",
          values: { path: "/tools/ffmpeg" },
          id: "ffmpeg.detail.program#1",
          mono: false,
        });
      },
    );

    it("names a Windows program in the tooltip without the verbatim prefix", () => {
      const state: FfmpegState = {
        ...createBaseState(),
        status: "ready",
        origin: "path",
        paths: {
          ffmpeg: "\\\\?\\C:\\tools\\ffmpeg.exe",
          ffprobe: "\\\\?\\C:\\tools\\ffprobe.exe",
        },
        version: "8.0",
        results: [{ name: "libx264", kind: "video", listed: true, status: "works" }],
        done: 1,
        total: 1,
      };

      const view = presentFfmpegStatus(state, format);

      expect(view.summary[1]).toEqual({
        key: "ffmpeg.detail.program",
        values: { path: "C:\\tools\\ffmpeg.exe" },
        id: "ffmpeg.detail.program#1",
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
          key: "ffmpeg.detail.version",
          values: { version: "7.1" },
          id: "ffmpeg.detail.version#0",
          mono: false,
        },
        {
          key: "ffmpeg.detail.license.nonfree",
          id: "ffmpeg.detail.license.nonfree#1",
          mono: false,
        },
        {
          key: "ffmpeg.detail.hardware",
          values: { methods: "videotoolbox" },
          id: "ffmpeg.detail.hardware#2",
          mono: false,
        },
        {
          key: "ffmpeg.detail.workingEncoders",
          values: { encoders: "libx264" },
          id: "ffmpeg.detail.workingEncoders#3",
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
      expect(view.labelValues).toEqual({ version: "" });
      // With no program path, the summary holds the status line only.
      expect(view.summary).toEqual([
        {
          key: "ffmpeg.status.ready",
          values: { version: "", working: "0", tested: "0" },
          id: "ffmpeg.status.ready#0",
          mono: false,
        },
      ]);
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

    it("labels a master-branch build with its short version and keeps the complete one elsewhere", () => {
      const version = "N-121234-g1a2b3c4d5e-20250923";
      const state: FfmpegState = {
        ...createBaseState(),
        status: "ready",
        version,
        results: [{ name: "libx264", kind: "video", listed: true, status: "works" }],
        done: 1,
        total: 1,
      };

      const view = presentFfmpegStatus(state, format);

      expect(view.labelValues).toEqual({ version: "N-121234" });
      expect(view.lineValues.version).toBe(version);
      expect(view.summary[0]?.values?.version).toBe(version);
      expect(view.detail).toContainEqual({
        key: "ffmpeg.detail.version",
        values: { version },
        id: "ffmpeg.detail.version#0",
        mono: false,
      });
    });
  });

  describe("shortVersion", () => {
    it.each([
      // A release version has no `-`, so it stays as it is.
      ["7.1.1", "7.1.1"],
      ["9.0", "9.0"],
      // A release-branch build keeps the text before the first `-`.
      ["n7.1.1-20-g1234567890-20250901", "n7.1.1"],
      // A distribution package drops its package revision.
      ["6.1.1-3ubuntu5", "6.1.1"],
      ["7.1.1-full_build-www.gyan.dev", "7.1.1"],
      // A master-branch build keeps the marker and its revision number.
      ["N-121234-g1a2b3c4d5e-20250923", "N-121234"],
      // A gyan.dev git build starts with a date, and keeps the whole 10-character date.
      ["2025-09-01-git-5e5a2a7a0c-full_build-www.gyan.dev", "2025-09-01"],
      ["2025-09-01", "2025-09-01"],
      // A text that only starts like a date keeps the text before its first `-`.
      ["2025-9-1-git", "2025"],
      // A text with no `-` stops at 12 characters.
      ["abcdefghijklmnopqrstuvwxyz", "abcdefghijkl"],
      // The text before the first `-` also stops at 12 characters.
      ["1234567890123456-rc1", "123456789012"],
      // `N` with no numeric revision after it is kept as it is.
      ["N-gabcdef", "N"],
      // An empty text before the first `-` falls back to the start of the whole string.
      ["-custom", "-custom"],
      ["  7.1.1  ", "7.1.1"],
      ["", ""],
    ])("shortens %j to %j", (version, expected) => {
      expect(shortVersion(version)).toBe(expected);
    });

    it("never returns more than SHORT_VERSION_MAX_LENGTH characters", () => {
      for (const version of [
        "N-1234567890123-gabc",
        "x".repeat(40),
        "-".repeat(40),
        "2025-09-01-git-5e5a2a7a0c-full_build-www.gyan.dev",
      ]) {
        expect(Array.from(shortVersion(version)).length).toBeLessThanOrEqual(
          SHORT_VERSION_MAX_LENGTH,
        );
      }
    });

    it("returns a prefix of the trimmed version, so the label never shows other text", () => {
      for (const version of [
        "7.1.1",
        "n7.1.1-20-g1234567890-20250901",
        "N-121234-g1a2b3c4d5e-20250923",
        "2025-09-01-git-5e5a2a7a0c-full_build-www.gyan.dev",
        "abcdefghijklmnopqrstuvwxyz",
      ]) {
        expect(version.trim().startsWith(shortVersion(version))).toBe(true);
      }
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
        labelKey: "ffmpeg.status.missing",
        labelValues: {},
        summary: [
          {
            key: "ffmpeg.status.missing",
            id: "ffmpeg.status.missing#0",
            mono: false,
          },
          {
            key: "ffmpegError.ffmpegPairMissing",
            id: "ffmpegError.ffmpegPairMissing#1",
            mono: false,
          },
        ],
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
        labelKey: "ffmpeg.status.missing",
        labelValues: {},
        summary: [
          {
            key: "ffmpeg.status.missing",
            id: "ffmpeg.status.missing#0",
            mono: false,
          },
          {
            key: "ffmpegError.ffmpegPairMissing",
            id: "ffmpegError.ffmpegPairMissing#1",
            mono: false,
          },
        ],
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
        labelKey: "ffmpeg.status.missing",
        labelValues: {},
        summary: [
          {
            key: "ffmpeg.status.missing",
            id: "ffmpeg.status.missing#0",
            mono: false,
          },
          {
            key: "ffmpegError.ffmpegPairMissing",
            id: "ffmpegError.ffmpegPairMissing#1",
            mono: false,
          },
        ],
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
        labelKey: "ffmpeg.status.missing",
        labelValues: {},
        summary: [
          {
            key: "ffmpeg.status.missing",
            id: "ffmpeg.status.missing#0",
            mono: false,
          },
          {
            key: "ffmpegError.ffmpegPairMissing",
            id: "ffmpegError.ffmpegPairMissing#1",
            mono: false,
          },
        ],
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
        labelKey: "ffmpeg.status.failed",
        labelValues: {},
        summary: [
          {
            key: "ffmpeg.status.failed",
            id: "ffmpeg.status.failed#0",
            mono: false,
          },
          {
            key: "ffmpegError.ffmpegSpawnFailed",
            id: "ffmpegError.ffmpegSpawnFailed#1",
            mono: false,
          },
        ],
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
        labelKey: "ffmpeg.status.failed",
        labelValues: {},
        summary: [
          {
            key: "ffmpeg.status.failed",
            id: "ffmpeg.status.failed#0",
            mono: false,
          },
          {
            key: "ffmpegError.cacheUnavailable",
            id: "ffmpegError.cacheUnavailable#1",
            mono: false,
          },
        ],
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
        labelKey: "ffmpeg.status.failed",
        labelValues: {},
        summary: [
          { key: "ffmpeg.status.failed", id: "ffmpeg.status.failed#0", mono: false },
          { key: "ffmpegError.unknown", id: "ffmpegError.unknown#1", mono: false },
        ],
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
        labelKey: "ffmpeg.status.failed",
        labelValues: {},
        summary: [
          { key: "ffmpeg.status.failed", id: "ffmpeg.status.failed#0", mono: false },
          { key: "ffmpegError.unknown", id: "ffmpegError.unknown#1", mono: false },
        ],
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

  // Every label key must resolve to a non-empty string in the English catalog, so a renamed
  // or deleted message fails here instead of rendering a raw key in the status bar.
  describe("label catalog coverage", () => {
    const statuses: FfmpegState["status"][] = [
      "idle",
      "locating",
      "probing",
      "ready",
      "missing",
      "failed",
    ];

    it.each(statuses)("resolves the label key of status '%s'", (status) => {
      const view = presentFfmpegStatus({ ...createBaseState(), status }, format);
      const [group, subgroup, leaf] = view.labelKey.split(".");
      expect(group).toBe("ffmpeg");
      expect(subgroup).toBe("status");
      const resolved = (en.ffmpeg.status as Record<string, string>)[leaf];
      expect(typeof resolved).toBe("string");
      expect(resolved.trim().length).toBeGreaterThan(0);
    });

    // The tooltip opens with the state in every status, and holds at most two lines.
    it.each(statuses)(
      "starts the summary of status '%s' with its status line",
      (status) => {
        const view = presentFfmpegStatus({ ...createBaseState(), status }, format);
        expect(view.summary[0]?.key).toBe(view.lineKey);
        expect(view.summary.length).toBeLessThanOrEqual(2);
      },
    );
  });
});
