import { describe, expect, it } from "vitest";
import { SettingsError, type Preset, type Settings } from "@/features/settings/types";
import {
  formatFps,
  presentPresetSummary,
  presentSetupBlocker,
  resolveExportSetupStepState,
  resolveSetupPresetId,
} from "./exportSetupPresenter";

function createPreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "default-preset",
    name: "Default Preset",
    container: "mp4",
    videoEncoder: "libx264",
    audioEncoder: "aac",
    audioBitrate: 320,
    audioSampleRate: "source",
    audioChannels: "source",
    quality: { kind: "crf", value: 20 },
    resolution: "source",
    frameRate: "source",
    ...overrides,
  };
}

function createSettings(presets: Preset[], activePresetId?: string): Settings {
  return {
    schemaVersion: 1,
    revision: 1,
    activePresetId,
    presets,
  };
}

describe("exportSetupPresenter", () => {
  const formatter = new Intl.NumberFormat("en");

  describe("resolveSetupPresetId", () => {
    it("returns null when settings is null or presets are empty", () => {
      expect(resolveSetupPresetId(null, "p1")).toBeNull();
      expect(resolveSetupPresetId(createSettings([]), "p1")).toBeNull();
    });

    it("returns requestedId when a preset with that id exists", () => {
      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const settings = createSettings([p1, p2], "p1");

      expect(resolveSetupPresetId(settings, "p2")).toBe("p2");
    });

    it("falls back to activePresetId when requestedId is null or missing from presets", () => {
      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const settings = createSettings([p1, p2], "p2");

      expect(resolveSetupPresetId(settings, null)).toBe("p2");
      expect(resolveSetupPresetId(settings, "non-existent")).toBe("p2");
    });

    it("falls back to the first preset id when activePresetId dangles or is unset", () => {
      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const settingsWithDangling = createSettings([p1, p2], "dangling-id");
      const settingsWithoutActive = createSettings([p1, p2]);

      expect(resolveSetupPresetId(settingsWithDangling, null)).toBe("p1");
      expect(resolveSetupPresetId(settingsWithoutActive, null)).toBe("p1");
    });
  });

  describe("formatFps", () => {
    it("formats fractional frame rates with at most 3 decimal fraction digits", () => {
      // 30000/1001 = 29.9700299... -> 29.97
      expect(formatFps(30000, 1001, formatter)).toBe("29.97");
      // 24000/1001 = 23.9760239... -> 23.976
      expect(formatFps(24000, 1001, formatter)).toBe("23.976");
      // 60000/1001 = 59.9400599... -> 59.94
      expect(formatFps(60000, 1001, formatter)).toBe("59.94");
      // Whole numbers
      expect(formatFps(30, 1, formatter)).toBe("30");
      expect(formatFps(24, 1, formatter)).toBe("24");
      expect(formatFps(60, 1, formatter)).toBe("60");
    });
  });

  describe("presentPresetSummary", () => {
    it("returns 9 rows in exact fixed order for a standard preset", () => {
      const preset = createPreset({
        container: "mp4",
        videoEncoder: "libx264",
        quality: { kind: "crf", value: 22 },
        audioEncoder: "aac",
        audioBitrate: 256,
        audioSampleRate: 48000,
        audioChannels: "stereo",
        resolution: { w: 1920, h: 1080 },
        frameRate: { n: 30000, d: 1001 },
      });

      const summary = presentPresetSummary(preset, formatter);

      expect(summary).toHaveLength(9);
      expect(summary.map((r) => r.id)).toEqual([
        "container",
        "videoEncoder",
        "quality",
        "audioEncoder",
        "audioBitrate",
        "audioSampleRate",
        "audioChannels",
        "resolution",
        "frameRate",
      ]);

      // Container
      expect(summary[0]).toEqual({
        id: "container",
        labelKey: "settings.preset.containerLabel",
        valueKey: "export.setup.value",
        valueValues: { value: "MP4" },
      });

      // Video encoder
      expect(summary[1]).toEqual({
        id: "videoEncoder",
        labelKey: "settings.preset.videoEncoderLabel",
        valueKey: "export.setup.value",
        valueValues: { value: "libx264" },
      });

      // Quality (CRF)
      expect(summary[2]).toEqual({
        id: "quality",
        labelKey: "export.setup.qualityLabel",
        valueKey: "export.setup.qualityCrf",
        valueValues: { value: "22" },
      });

      // Audio encoder
      expect(summary[3]).toEqual({
        id: "audioEncoder",
        labelKey: "settings.preset.audioEncoderLabel",
        valueKey: "export.setup.value",
        valueValues: { value: "aac" },
      });

      // Audio bitrate
      expect(summary[4]).toEqual({
        id: "audioBitrate",
        labelKey: "settings.preset.audioBitrateLabel",
        valueKey: "settings.preset.audioBitrateValue",
        valueValues: { value: "256" },
      });

      // Audio sample rate (48000 Hz -> 48 kHz)
      expect(summary[5]).toEqual({
        id: "audioSampleRate",
        labelKey: "settings.preset.audioSampleRateLabel",
        valueKey: "settings.preset.audioSampleRateValue",
        valueValues: { value: "48" },
      });

      // Audio channels
      expect(summary[6]).toEqual({
        id: "audioChannels",
        labelKey: "settings.preset.audioChannelsLabel",
        valueKey: "settings.preset.audioChannelsStereo",
      });

      // Resolution
      expect(summary[7]).toEqual({
        id: "resolution",
        labelKey: "settings.preset.resolutionLabel",
        valueKey: "export.setup.resolutionValue",
        valueValues: { width: "1920", height: "1080" },
      });

      // Frame rate
      expect(summary[8]).toEqual({
        id: "frameRate",
        labelKey: "settings.preset.frameRateLabel",
        valueKey: "export.setup.frameRateValue",
        valueValues: { value: "29.97" },
      });
    });

    it("handles quality kinds bitrate and qualityScale", () => {
      const bitratePreset = createPreset({
        quality: { kind: "bitrate", value: 8000 },
      });
      const scalePreset = createPreset({
        quality: { kind: "qualityScale", value: 50 },
      });

      const bitrateRow = presentPresetSummary(bitratePreset, formatter).find(
        (r) => r.id === "quality",
      );
      const scaleRow = presentPresetSummary(scalePreset, formatter).find(
        (r) => r.id === "quality",
      );

      expect(bitrateRow).toEqual({
        id: "quality",
        labelKey: "export.setup.qualityLabel",
        valueKey: "export.setup.qualityBitrate",
        valueValues: { value: "8,000" },
      });

      expect(scaleRow).toEqual({
        id: "quality",
        labelKey: "export.setup.qualityLabel",
        valueKey: "export.setup.qualityScale",
        valueValues: { value: "50" },
      });
    });

    it("handles lossless audio encoder and absent bitrate", () => {
      const losslessPreset = createPreset({
        audioEncoder: "flac",
        audioBitrate: undefined,
      });
      const defaultBitratePreset = createPreset({
        audioEncoder: "aac",
        audioBitrate: undefined,
      });

      const losslessRow = presentPresetSummary(losslessPreset, formatter).find(
        (r) => r.id === "audioBitrate",
      );
      const defaultRow = presentPresetSummary(defaultBitratePreset, formatter).find(
        (r) => r.id === "audioBitrate",
      );

      expect(losslessRow).toEqual({
        id: "audioBitrate",
        labelKey: "settings.preset.audioBitrateLabel",
        valueKey: "export.setup.audioBitrateLossless",
      });

      expect(defaultRow).toEqual({
        id: "audioBitrate",
        labelKey: "settings.preset.audioBitrateLabel",
        valueKey: "settings.preset.audioBitrateDefault",
      });
    });

    it("handles 'source' for sample rate, channels, resolution, and frame rate", () => {
      const preset = createPreset({
        audioSampleRate: "source",
        audioChannels: "source",
        resolution: "source",
        frameRate: "source",
      });

      const summary = presentPresetSummary(preset, formatter);

      expect(summary.find((r) => r.id === "audioSampleRate")).toEqual({
        id: "audioSampleRate",
        labelKey: "settings.preset.audioSampleRateLabel",
        valueKey: "settings.preset.sourceOption",
      });

      expect(summary.find((r) => r.id === "audioChannels")).toEqual({
        id: "audioChannels",
        labelKey: "settings.preset.audioChannelsLabel",
        valueKey: "settings.preset.sourceOption",
      });

      expect(summary.find((r) => r.id === "resolution")).toEqual({
        id: "resolution",
        labelKey: "settings.preset.resolutionLabel",
        valueKey: "settings.preset.sourceOption",
      });

      expect(summary.find((r) => r.id === "frameRate")).toEqual({
        id: "frameRate",
        labelKey: "settings.preset.frameRateLabel",
        valueKey: "settings.preset.sourceOption",
      });
    });

    it("formats 44.1 kHz sample rate correctly", () => {
      const preset = createPreset({ audioSampleRate: 44100 });
      const row = presentPresetSummary(preset, formatter).find(
        (r) => r.id === "audioSampleRate",
      );

      expect(row).toEqual({
        id: "audioSampleRate",
        labelKey: "settings.preset.audioSampleRateLabel",
        valueKey: "settings.preset.audioSampleRateValue",
        valueValues: { value: "44.1" },
      });
    });

    it("handles mono channel option", () => {
      const preset = createPreset({ audioChannels: "mono" });
      const row = presentPresetSummary(preset, formatter).find(
        (r) => r.id === "audioChannels",
      );

      expect(row).toEqual({
        id: "audioChannels",
        labelKey: "settings.preset.audioChannelsLabel",
        valueKey: "settings.preset.audioChannelsMono",
      });
    });
  });

  describe("presentSetupBlocker", () => {
    it("returns export.setup.noPresets when preset is null", () => {
      expect(presentSetupBlocker(null)).toEqual({
        key: "export.setup.noPresets",
      });
    });

    it("returns containerMismatch issue values when mov is paired with flac or libopus", () => {
      const movFlac = createPreset({ container: "mov", audioEncoder: "flac" });
      const movOpus = createPreset({ container: "mov", audioEncoder: "libopus" });

      expect(presentSetupBlocker(movFlac)).toEqual({
        key: "settings.field.containerMismatch",
        values: {
          container: "MOV",
          encoder: "flac",
        },
      });

      expect(presentSetupBlocker(movOpus)).toEqual({
        key: "settings.field.containerMismatch",
        values: {
          container: "MOV",
          encoder: "libopus",
        },
      });
    });

    it("pins uppercase container name MOV in containerMismatch blocker values", () => {
      const movFlac = createPreset({ container: "mov", audioEncoder: "flac" });
      const blocker = presentSetupBlocker(movFlac);

      expect(blocker?.values?.container).toBe("MOV");
    });

    it("returns null for compatible container and audio encoder combinations", () => {
      expect(
        presentSetupBlocker(createPreset({ container: "mp4", audioEncoder: "aac" })),
      ).toBeNull();
      expect(
        presentSetupBlocker(createPreset({ container: "mov", audioEncoder: "aac" })),
      ).toBeNull();
      expect(
        presentSetupBlocker(createPreset({ container: "mkv", audioEncoder: "flac" })),
      ).toBeNull();
    });
  });

  describe("resolveExportSetupStepState", () => {
    it("returns loading when settings is null and status is loading", () => {
      expect(
        resolveExportSetupStepState({
          settings: null,
          status: "loading",
        }),
      ).toBe("loading");
    });

    it("returns loading when settings is null and status is idle", () => {
      expect(
        resolveExportSetupStepState({
          settings: null,
          status: "idle",
        }),
      ).toBe("loading");
    });

    it("returns error when settings is null and status is error", () => {
      expect(
        resolveExportSetupStepState({
          settings: null,
          status: "error",
          error: new SettingsError({ code: "invalidSettings" }),
        }),
      ).toBe("error");
    });

    it("returns error when settings is null and error is present regardless of status", () => {
      expect(
        resolveExportSetupStepState({
          settings: null,
          status: "idle",
          error: new SettingsError({ code: "readFailed" }),
        }),
      ).toBe("error");
    });

    it("returns empty when settings is loaded but presets are empty", () => {
      expect(
        resolveExportSetupStepState({
          settings: createSettings([]),
          status: "ready",
        }),
      ).toBe("empty");
    });

    it("returns ready when settings is loaded and presets has items", () => {
      expect(
        resolveExportSetupStepState({
          settings: createSettings([createPreset()]),
          status: "ready",
        }),
      ).toBe("ready");
    });
  });
});
