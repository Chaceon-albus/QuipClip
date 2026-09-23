import { describe, expect, it } from "vitest";
import {
  AUDIO_CHANNEL_SETTINGS,
  BACKEND_SETTINGS_ERROR_CODES,
  PRESET_CONTAINERS,
  QUALITY_KINDS,
  SettingsError,
  type Preset,
  type Settings,
} from "./types";
import {
  isBackendSettingsErrorCode,
  isLoadSettingsResult,
  isNonNegativeU32,
  isPositiveRational,
  isPositiveU32,
  isPreset,
  isPresetAudioChannels,
  isPresetAudioSampleRate,
  isPresetContainer,
  isPresetFrameRate,
  isPresetQuality,
  isPresetResolution,
  isQualityKind,
  isSettings,
  isSettingsErrorCode,
  isSignedRational,
  normalizeSettingsError,
  U32_MAX,
  validateLoadSettingsResult,
  validateSettings,
} from "./validation";

function createValidPreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "default-h264-mp4",
    name: "H.264 MP4",
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

describe("Settings Validation & Normalization", () => {
  describe("Numeric and Rational boundaries", () => {
    it("validates isPositiveU32", () => {
      expect(isPositiveU32(1)).toBe(true);
      expect(isPositiveU32(U32_MAX)).toBe(true);
      expect(isPositiveU32(0)).toBe(false);
      expect(isPositiveU32(-1)).toBe(false);
      expect(isPositiveU32(1.5)).toBe(false);
      expect(isPositiveU32(U32_MAX + 1)).toBe(false);
      expect(isPositiveU32("1")).toBe(false);
      expect(isPositiveU32(null)).toBe(false);
    });

    it("validates isNonNegativeU32", () => {
      expect(isNonNegativeU32(0)).toBe(true);
      expect(isNonNegativeU32(1)).toBe(true);
      expect(isNonNegativeU32(U32_MAX)).toBe(true);
      expect(isNonNegativeU32(-1)).toBe(false);
      expect(isNonNegativeU32(1.5)).toBe(false);
      expect(isNonNegativeU32(U32_MAX + 1)).toBe(false);
      expect(isNonNegativeU32("0")).toBe(false);
    });

    it("validates isSignedRational", () => {
      expect(isSignedRational({ n: 0, d: 1 })).toBe(true);
      expect(isSignedRational({ n: -30, d: 1 })).toBe(true);
      expect(isSignedRational({ n: 30, d: 1 })).toBe(true);
      expect(isSignedRational({ n: 30, d: 0 })).toBe(false);
      expect(isSignedRational({ n: 30, d: -1 })).toBe(false);
      expect(isSignedRational({ n: 1.5, d: 1 })).toBe(false);
      expect(isSignedRational({ n: 1, d: 1.5 })).toBe(false);
      expect(isSignedRational(null)).toBe(false);
    });

    it("validates isPositiveRational", () => {
      expect(isPositiveRational({ n: 30, d: 1 })).toBe(true);
      expect(isPositiveRational({ n: 60000, d: 1001 })).toBe(true);
      expect(isPositiveRational({ n: 0, d: 1 })).toBe(false);
      expect(isPositiveRational({ n: -30, d: 1 })).toBe(false);
      expect(isPositiveRational({ n: 30, d: 0 })).toBe(false);
    });
  });

  describe("isPresetContainer", () => {
    it("accepts exactly the literal wire strings", () => {
      for (const container of PRESET_CONTAINERS) {
        expect(isPresetContainer(container)).toBe(true);
      }
      expect(isPresetContainer("mp4")).toBe(true);
      expect(isPresetContainer("mov")).toBe(true);
      expect(isPresetContainer("mkv")).toBe(true);
    });

    it("rejects unknown containers such as webm or avi", () => {
      expect(isPresetContainer("webm")).toBe(false);
      expect(isPresetContainer("avi")).toBe(false);
      expect(isPresetContainer("")).toBe(false);
      expect(isPresetContainer(null)).toBe(false);
      expect(isPresetContainer(123)).toBe(false);
    });
  });

  describe("isQualityKind", () => {
    it("accepts exactly the literal quality kind wire strings", () => {
      for (const kind of QUALITY_KINDS) {
        expect(isQualityKind(kind)).toBe(true);
      }
      expect(isQualityKind("crf")).toBe(true);
      expect(isQualityKind("bitrate")).toBe(true);
      expect(isQualityKind("qualityScale")).toBe(true);
    });

    it("rejects unknown or invalid quality kinds", () => {
      expect(isQualityKind("vbr")).toBe(false);
      expect(isQualityKind("cbr")).toBe(false);
      expect(isQualityKind("")).toBe(false);
      expect(isQualityKind(null)).toBe(false);
    });
  });

  describe("isPresetQuality", () => {
    it("accepts valid quality objects with known kinds and u32 values", () => {
      expect(isPresetQuality({ kind: "crf", value: 20 })).toBe(true);
      expect(isPresetQuality({ kind: "bitrate", value: 5000 })).toBe(true);
      expect(isPresetQuality({ kind: "qualityScale", value: 80 })).toBe(true);
    });

    it("rejects quality missing value", () => {
      expect(isPresetQuality({ kind: "crf" })).toBe(false);
    });

    it("rejects quality with an empty kind", () => {
      expect(isPresetQuality({ kind: "", value: 20 })).toBe(false);
    });

    it("rejects unknown quality kinds because the union is closed", () => {
      expect(isPresetQuality({ kind: "unknown", value: 20 })).toBe(false);
      expect(isPresetQuality({ kind: "vbr", value: 20 })).toBe(false);
    });

    it("rejects invalid values (negative, float, non-number)", () => {
      expect(isPresetQuality({ kind: "crf", value: -1 })).toBe(false);
      expect(isPresetQuality({ kind: "crf", value: 20.5 })).toBe(false);
      expect(isPresetQuality({ kind: "crf", value: "20" })).toBe(false);
      expect(isPresetQuality(null)).toBe(false);
    });
  });

  describe("isPresetResolution", () => {
    it("accepts the literal wire string 'source'", () => {
      expect(isPresetResolution("source")).toBe(true);
    });

    it("accepts custom resolution with positive integer w and h", () => {
      expect(isPresetResolution({ w: 1920, h: 1080 })).toBe(true);
      expect(isPresetResolution({ w: 3840, h: 2160 })).toBe(true);
    });

    it("rejects resolution {w:0, h:1080}", () => {
      expect(isPresetResolution({ w: 0, h: 1080 })).toBe(false);
    });

    it("rejects resolution {w:1.5, h:1080}", () => {
      expect(isPresetResolution({ w: 1.5, h: 1080 })).toBe(false);
    });

    it("rejects resolution {w:1920} with no h", () => {
      expect(isPresetResolution({ w: 1920 })).toBe(false);
    });

    it("rejects resolution with no w or invalid values", () => {
      expect(isPresetResolution({ h: 1080 })).toBe(false);
      expect(isPresetResolution({ w: 1920, h: 0 })).toBe(false);
      expect(isPresetResolution({ w: -1920, h: 1080 })).toBe(false);
      expect(isPresetResolution("1920x1080")).toBe(false);
      expect(isPresetResolution(null)).toBe(false);
    });
  });

  describe("isPresetFrameRate", () => {
    it("accepts the literal wire string 'source'", () => {
      expect(isPresetFrameRate("source")).toBe(true);
    });

    it("accepts explicit positive rational frame rates", () => {
      expect(isPresetFrameRate({ n: 30, d: 1 })).toBe(true);
      expect(isPresetFrameRate({ n: 60000, d: 1001 })).toBe(true);
    });

    it("rejects frameRate {n:30, d:0} with denominator zero", () => {
      expect(isPresetFrameRate({ n: 30, d: 0 })).toBe(false);
    });

    it("rejects non-positive rational frame rates", () => {
      expect(isPresetFrameRate({ n: 0, d: 1 })).toBe(false);
      expect(isPresetFrameRate({ n: -30, d: 1 })).toBe(false);
      expect(isPresetFrameRate({ n: 30.5, d: 1 })).toBe(false);
      expect(isPresetFrameRate(30)).toBe(false);
      expect(isPresetFrameRate(null)).toBe(false);
    });
  });

  describe("isPresetAudioChannels", () => {
    it("accepts exactly the literal wire strings from AUDIO_CHANNEL_SETTINGS", () => {
      for (const channels of AUDIO_CHANNEL_SETTINGS) {
        expect(isPresetAudioChannels(channels)).toBe(true);
      }
      expect(isPresetAudioChannels("source")).toBe(true);
      expect(isPresetAudioChannels("stereo")).toBe(true);
      expect(isPresetAudioChannels("mono")).toBe(true);
    });

    it("rejects unknown channel settings", () => {
      expect(isPresetAudioChannels("surround")).toBe(false);
      expect(isPresetAudioChannels("5.1")).toBe(false);
      expect(isPresetAudioChannels("")).toBe(false);
      expect(isPresetAudioChannels(null)).toBe(false);
      expect(isPresetAudioChannels(2)).toBe(false);
    });
  });

  describe("isPresetAudioSampleRate", () => {
    it("accepts 'source' or a safe integer frequency in hertz", () => {
      expect(isPresetAudioSampleRate("source")).toBe(true);
      expect(isPresetAudioSampleRate(44100)).toBe(true);
      expect(isPresetAudioSampleRate(48000)).toBe(true);
      expect(isPresetAudioSampleRate(96000)).toBe(true);
      expect(isPresetAudioSampleRate(8000)).toBe(true);
    });

    it("rejects floats, non-numbers, negative values, and null", () => {
      expect(isPresetAudioSampleRate(44100.5)).toBe(false);
      expect(isPresetAudioSampleRate(-1)).toBe(false);
      expect(isPresetAudioSampleRate(-48000)).toBe(false);
      expect(isPresetAudioSampleRate(U32_MAX + 1)).toBe(false);
      expect(isPresetAudioSampleRate("48000")).toBe(false);
      expect(isPresetAudioSampleRate(Number.NaN)).toBe(false);
      expect(isPresetAudioSampleRate(Number.POSITIVE_INFINITY)).toBe(false);
      expect(isPresetAudioSampleRate(null)).toBe(false);
      expect(isPresetAudioSampleRate(undefined)).toBe(false);
    });
  });

  describe("isPreset", () => {
    it("accepts a fully valid preset", () => {
      const preset = createValidPreset();
      expect(isPreset(preset)).toBe(true);
    });

    it("accepts valid presets with custom resolution and frame rate", () => {
      const preset = createValidPreset({
        resolution: { w: 1920, h: 1080 },
        frameRate: { n: 60, d: 1 },
      });
      expect(isPreset(preset)).toBe(true);
    });

    it("rejects resolution {w:0, h:1080}", () => {
      const preset = createValidPreset({
        resolution: { w: 0, h: 1080 },
      });
      expect(isPreset(preset)).toBe(false);
    });

    it("rejects resolution {w:1.5, h:1080}", () => {
      const preset = createValidPreset({
        resolution: { w: 1.5, h: 1080 },
      });
      expect(isPreset(preset)).toBe(false);
    });

    it("rejects resolution {w:1920} with no h", () => {
      const preset = createValidPreset({
        resolution: { w: 1920 } as unknown as Preset["resolution"],
      });
      expect(isPreset(preset)).toBe(false);
    });

    it("rejects frameRate {n:30, d:0}", () => {
      const preset = createValidPreset({
        frameRate: { n: 30, d: 0 },
      });
      expect(isPreset(preset)).toBe(false);
    });

    it("rejects quality missing value", () => {
      const preset = createValidPreset({
        quality: { kind: "crf" } as unknown as Preset["quality"],
      });
      expect(isPreset(preset)).toBe(false);
    });

    it("rejects quality with an empty kind", () => {
      const preset = createValidPreset({
        quality: { kind: "", value: 20 } as unknown as Preset["quality"],
      });
      expect(isPreset(preset)).toBe(false);
    });

    it("rejects unknown quality kinds because the Rust union is closed", () => {
      const preset = createValidPreset({
        quality: { kind: "fourthKind", value: 20 } as unknown as Preset["quality"],
      });
      expect(isPreset(preset)).toBe(false);
    });

    it("rejects container 'webm'", () => {
      const preset = createValidPreset({
        container: "webm" as unknown as Preset["container"],
      });
      expect(isPreset(preset)).toBe(false);
    });

    it("rejects an empty id", () => {
      expect(isPreset(createValidPreset({ id: "" }))).toBe(false);
      expect(isPreset(createValidPreset({ id: "   " }))).toBe(false);
    });

    it("rejects an empty name", () => {
      expect(isPreset(createValidPreset({ name: "" }))).toBe(false);
      expect(isPreset(createValidPreset({ name: "   " }))).toBe(false);
    });

    it("rejects empty encoder names", () => {
      expect(isPreset(createValidPreset({ videoEncoder: "" }))).toBe(false);
      expect(isPreset(createValidPreset({ videoEncoder: "   " }))).toBe(false);
      expect(isPreset(createValidPreset({ audioEncoder: "" }))).toBe(false);
      expect(isPreset(createValidPreset({ audioEncoder: "   " }))).toBe(false);
    });

    it("accepts a preset with audioBitrate omitted (encoder default)", () => {
      const preset = createValidPreset();
      delete preset.audioBitrate;
      expect(isPreset(preset)).toBe(true);
    });

    it("accepts a preset with a safe integer audioBitrate", () => {
      expect(isPreset(createValidPreset({ audioBitrate: 128 }))).toBe(true);
      expect(isPreset(createValidPreset({ audioBitrate: 320 }))).toBe(true);
    });

    it("rejects invalid audioBitrate types", () => {
      expect(isPreset(createValidPreset({ audioBitrate: 128.5 }))).toBe(false);
      expect(isPreset(createValidPreset({ audioBitrate: -1 }))).toBe(false);
      expect(isPreset(createValidPreset({ audioBitrate: U32_MAX + 1 }))).toBe(false);
      expect(
        isPreset(
          createValidPreset({
            audioBitrate: "320" as unknown as number,
          }),
        ),
      ).toBe(false);
      expect(
        isPreset(
          createValidPreset({
            audioBitrate: null as unknown as number,
          }),
        ),
      ).toBe(false);
      expect(isPreset(createValidPreset({ audioBitrate: Number.NaN }))).toBe(false);
    });

    it("accepts audioSampleRate: 'source' or safe integer", () => {
      expect(isPreset(createValidPreset({ audioSampleRate: "source" }))).toBe(true);
      expect(isPreset(createValidPreset({ audioSampleRate: 48000 }))).toBe(true);
      expect(isPreset(createValidPreset({ audioSampleRate: 44100 }))).toBe(true);
    });

    it("rejects invalid audioSampleRate values", () => {
      expect(isPreset(createValidPreset({ audioSampleRate: 48000.5 }))).toBe(false);
      expect(
        isPreset(
          createValidPreset({
            audioSampleRate: -1 as unknown as Preset["audioSampleRate"],
          }),
        ),
      ).toBe(false);
      expect(
        isPreset(
          createValidPreset({
            audioSampleRate: (U32_MAX + 1) as unknown as Preset["audioSampleRate"],
          }),
        ),
      ).toBe(false);
      expect(
        isPreset(
          createValidPreset({
            audioSampleRate: "48000" as unknown as Preset["audioSampleRate"],
          }),
        ),
      ).toBe(false);
      expect(
        isPreset(
          createValidPreset({
            audioSampleRate: null as unknown as Preset["audioSampleRate"],
          }),
        ),
      ).toBe(false);
      expect(
        isPreset(
          createValidPreset({
            audioSampleRate: undefined as unknown as Preset["audioSampleRate"],
          }),
        ),
      ).toBe(false);
    });

    it("accepts audioChannels in AUDIO_CHANNEL_SETTINGS", () => {
      expect(isPreset(createValidPreset({ audioChannels: "source" }))).toBe(true);
      expect(isPreset(createValidPreset({ audioChannels: "stereo" }))).toBe(true);
      expect(isPreset(createValidPreset({ audioChannels: "mono" }))).toBe(true);
    });

    it("rejects invalid audioChannels values", () => {
      expect(
        isPreset(
          createValidPreset({
            audioChannels: "5.1" as unknown as Preset["audioChannels"],
          }),
        ),
      ).toBe(false);
      expect(
        isPreset(
          createValidPreset({
            audioChannels: "" as unknown as Preset["audioChannels"],
          }),
        ),
      ).toBe(false);
      expect(
        isPreset(
          createValidPreset({
            audioChannels: null as unknown as Preset["audioChannels"],
          }),
        ),
      ).toBe(false);
      expect(
        isPreset(
          createValidPreset({
            audioChannels: undefined as unknown as Preset["audioChannels"],
          }),
        ),
      ).toBe(false);
    });

    it("rejects null, non-objects, and primitives", () => {
      expect(isPreset(null)).toBe(false);
      expect(isPreset("preset")).toBe(false);
      expect(isPreset(123)).toBe(false);
    });
  });

  describe("isSettings", () => {
    it("accepts valid settings with presets and optional keys absent", () => {
      const settings: Settings = {
        schemaVersion: 1,
        revision: 0,
        presets: [createValidPreset()],
      };
      expect(isSettings(settings)).toBe(true);
    });

    it("accepts valid settings with all optional keys populated", () => {
      const settings: Settings = {
        schemaVersion: 1,
        revision: 12,
        ffmpegPath: "/usr/local/bin/ffmpeg",
        presets: [createValidPreset()],
        activePresetId: "default-h264-mp4",
      };
      expect(isSettings(settings)).toBe(true);
    });

    it("accepts a dangling activePresetId that names no preset", () => {
      const settingsWithDanglingId = {
        schemaVersion: 1,
        revision: 0,
        presets: [createValidPreset({ id: "preset-a" })],
        activePresetId: "non-existent-preset-id",
      };
      expect(isSettings(settingsWithDanglingId)).toBe(true);

      const emptyPresetsWithDanglingId = {
        schemaVersion: 1,
        revision: 0,
        presets: [],
        activePresetId: "orphan-id",
      };
      expect(isSettings(emptyPresetsWithDanglingId)).toBe(true);
    });

    it("rejects presets: 'nope'", () => {
      const invalid = {
        schemaVersion: 1,
        revision: 0,
        presets: "nope",
      };
      expect(isSettings(invalid)).toBe(false);
    });

    it("rejects ffmpegPath: 3", () => {
      const invalid = {
        schemaVersion: 1,
        revision: 0,
        presets: [],
        ffmpegPath: 3,
      };
      expect(isSettings(invalid)).toBe(false);
    });

    it("rejects schemaVersion other than 1", () => {
      expect(isSettings({ schemaVersion: 2, revision: 0, presets: [] })).toBe(false);
      expect(isSettings({ schemaVersion: 0, revision: 0, presets: [] })).toBe(false);
      expect(isSettings({ schemaVersion: "1", revision: 0, presets: [] })).toBe(false);
    });

    it("requires revision, so a document this build did not write is rejected", () => {
      // Rust always serializes the key (ADR 013), so an absent `revision` means the document
      // did not come from this build. Accepting it would let a save go out with no
      // compare-and-swap token.
      expect(isSettings({ schemaVersion: 1, presets: [] })).toBe(false);
      expect(isSettings({ schemaVersion: 1, revision: undefined, presets: [] })).toBe(
        false,
      );
    });

    it("rejects a revision that is not a u32 counter", () => {
      for (const revision of [-1, 1.5, 4_294_967_296, "1", null, Number.NaN]) {
        expect(isSettings({ schemaVersion: 1, revision, presets: [] })).toBe(false);
      }
    });

    it("accepts revision 0 and the whole u32 range", () => {
      // No revision is invalid: this is a counter, not a format version, and it wraps at the
      // top of the u32 range rather than saturating.
      for (const revision of [0, 1, 4_294_967_295]) {
        expect(isSettings({ schemaVersion: 1, revision, presets: [] })).toBe(true);
      }
    });

    it("rejects non-string activePresetId", () => {
      expect(
        isSettings({
          schemaVersion: 1,
          revision: 0,
          presets: [],
          activePresetId: 123,
        }),
      ).toBe(false);
    });

    it("rejects if any preset is invalid", () => {
      const invalid = {
        schemaVersion: 1,
        revision: 0,
        presets: [createValidPreset(), { ...createValidPreset(), container: "webm" }],
      };
      expect(isSettings(invalid)).toBe(false);
    });

    it("rejects null or non-objects", () => {
      expect(isSettings(null)).toBe(false);
      expect(isSettings(undefined)).toBe(false);
      expect(isSettings("settings")).toBe(false);
    });
  });

  describe("isLoadSettingsResult", () => {
    it("accepts valid load settings results", () => {
      expect(
        isLoadSettingsResult({
          settings: { schemaVersion: 1, revision: 0, presets: [] },
          seeded: true,
        }),
      ).toBe(true);

      expect(
        isLoadSettingsResult({
          settings: { schemaVersion: 1, revision: 3, presets: [createValidPreset()] },
          seeded: false,
        }),
      ).toBe(true);
    });

    it("rejects invalid load settings results", () => {
      expect(
        isLoadSettingsResult({
          settings: { schemaVersion: 2, revision: 0, presets: [] },
          seeded: true,
        }),
      ).toBe(false);

      expect(
        isLoadSettingsResult({
          settings: { schemaVersion: 1, revision: 0, presets: [] },
          seeded: "true",
        }),
      ).toBe(false);

      expect(isLoadSettingsResult(null)).toBe(false);
    });
  });

  describe("Error code type guards", () => {
    it("validates BackendSettingsErrorCode for every backend code", () => {
      for (const code of BACKEND_SETTINGS_ERROR_CODES) {
        expect(isBackendSettingsErrorCode(code)).toBe(true);
        expect(isSettingsErrorCode(code)).toBe(true);
      }
    });

    it("validates frontend-only dialogFailed and unknown codes", () => {
      expect(isBackendSettingsErrorCode("dialogFailed")).toBe(false);
      expect(isSettingsErrorCode("dialogFailed")).toBe(true);

      expect(isBackendSettingsErrorCode("unknown")).toBe(false);
      expect(isSettingsErrorCode("unknown")).toBe(true);
    });

    it("rejects unrecognized error codes", () => {
      expect(isBackendSettingsErrorCode("notAnErrorCode")).toBe(false);
      expect(isSettingsErrorCode("notAnErrorCode")).toBe(false);
      expect(isSettingsErrorCode(null)).toBe(false);
      expect(isSettingsErrorCode(123)).toBe(false);
    });
  });

  describe("Throwing validators", () => {
    it("validateSettings returns valid settings or throws TypeError", () => {
      const valid: Settings = { schemaVersion: 1, revision: 0, presets: [] };
      expect(validateSettings(valid)).toBe(valid);

      expect(() =>
        validateSettings({ schemaVersion: 2, revision: 0, presets: [] }),
      ).toThrow(TypeError);
      expect(() => validateSettings(null)).toThrow(TypeError);
    });

    it("validateLoadSettingsResult returns valid result or throws TypeError", () => {
      const valid = {
        settings: { schemaVersion: 1, revision: 0, presets: [] } as Settings,
        seeded: true,
      };
      expect(validateLoadSettingsResult(valid)).toBe(valid);

      expect(() =>
        validateLoadSettingsResult({ settings: "invalid", seeded: true }),
      ).toThrow(TypeError);
      expect(() => validateLoadSettingsResult(null)).toThrow(TypeError);
    });
  });

  describe("normalizeSettingsError", () => {
    it("keeps code and detail and drops field when field has the wrong type", () => {
      const input = {
        code: "writeFailed",
        detail: "EACCES",
        field: 7,
      };
      const error = normalizeSettingsError(input);

      expect(error).toBeInstanceOf(SettingsError);
      expect(error.code).toBe("writeFailed");
      expect(error.detail).toBe("EACCES");
      expect(error.field).toBeUndefined();
    });

    it("drops non-string detail", () => {
      expect(
        normalizeSettingsError({ code: "readFailed", detail: 42 }).detail,
      ).toBeUndefined();
      expect(
        normalizeSettingsError({ code: "readFailed", detail: new TypeError("boom") })
          .detail,
      ).toBeUndefined();
    });

    it("maps unrecognized code {code: 'nope'} to 'unknown'", () => {
      const input = { code: "nope" };
      const error = normalizeSettingsError(input);

      expect(error.code).toBe("unknown");
      expect(error.detail).toBeUndefined();
    });

    it("normalizes new TypeError('boom') to unknown with detail UNDEFINED", () => {
      const localError = new TypeError("boom");
      const normalized = normalizeSettingsError(localError);

      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBeUndefined();
      expect(normalized.message).toBe("unknown");
    });

    it("preserves an existing SettingsError instance", () => {
      const original = new SettingsError({
        code: "permissionDenied",
        detail: "EPERM",
      });
      expect(normalizeSettingsError(original)).toBe(original);
    });

    it("normalizes plain string rejections into { code: 'unknown', detail: <string> }", () => {
      const error = normalizeSettingsError(
        "Tauri argument deserialization failed: missing field 'presets'",
      );
      expect(error.code).toBe("unknown");
      expect(error.detail).toBe(
        "Tauri argument deserialization failed: missing field 'presets'",
      );
      expect(error.message).toBe(
        "unknown: Tauri argument deserialization failed: missing field 'presets'",
      );
    });

    it("preserves string field and value", () => {
      const error = normalizeSettingsError({
        code: "invalidSettings",
        field: "presets[0].name",
        value: "tooLong",
      });
      expect(error.code).toBe("invalidSettings");
      expect(error.field).toBe("presets[0].name");
      expect(error.value).toBe("tooLong");
    });

    it("drops non-string value and preserves string detail", () => {
      const error = normalizeSettingsError({
        code: "unsafeSettingsValue",
        value: 123456,
        detail: "overflow",
      });
      expect(error.code).toBe("unsafeSettingsValue");
      expect(error.value).toBeUndefined();
      expect(error.detail).toBe("overflow");
    });

    it("preserves safe non-negative integer foundSchemaVersion and supportedSchemaVersion", () => {
      const error = normalizeSettingsError({
        code: "futureSchemaVersion",
        foundSchemaVersion: 2,
        supportedSchemaVersion: 1,
      });
      expect(error.code).toBe("futureSchemaVersion");
      expect(error.foundSchemaVersion).toBe(2);
      expect(error.supportedSchemaVersion).toBe(1);
    });

    it("drops non-integer or negative schema versions", () => {
      const error = normalizeSettingsError({
        code: "futureSchemaVersion",
        foundSchemaVersion: -1,
        supportedSchemaVersion: 1.5,
      });
      expect(error.code).toBe("futureSchemaVersion");
      expect(error.foundSchemaVersion).toBeUndefined();
      expect(error.supportedSchemaVersion).toBeUndefined();
    });

    it("normalizes non-objects (null, undefined, number, empty string) to unknown with no detail", () => {
      expect(normalizeSettingsError(null).code).toBe("unknown");
      expect(normalizeSettingsError(null).detail).toBeUndefined();

      expect(normalizeSettingsError(undefined).code).toBe("unknown");
      expect(normalizeSettingsError(undefined).detail).toBeUndefined();

      expect(normalizeSettingsError(42).code).toBe("unknown");
      expect(normalizeSettingsError(42).detail).toBeUndefined();

      expect(normalizeSettingsError("").code).toBe("unknown");
      expect(normalizeSettingsError("").detail).toBeUndefined();
    });
  });
});
