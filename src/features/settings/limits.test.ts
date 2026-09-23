import { describe, expect, it } from "vitest";
import { QUALITY_KINDS, type Preset } from "./types";
import {
  canAddPreset,
  defaultQualityValue,
  ENCODER_NAME_PATTERN,
  isValidEncoderName,
  MAX_AUDIO_BITRATE_KBPS,
  MAX_AUDIO_SAMPLE_RATE,
  MAX_ENCODER_NAME_CHARS,
  MAX_PRESET_NAME_CHARS,
  MAX_PRESETS,
  MAX_RESOLUTION_DIMENSION,
  MIN_AUDIO_BITRATE_KBPS,
  MIN_AUDIO_SAMPLE_RATE,
  MIN_ENCODER_NAME_CHARS,
  MIN_RESOLUTION_DIMENSION,
  QUALITY_RANGES,
  validatePresetFields,
} from "./limits";

function createPreset(overrides: Partial<Preset> = {}): Preset {
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

describe("limits", () => {
  describe("constants", () => {
    it("asserts each constant equals its exact literal value", () => {
      expect(MAX_PRESETS).toBe(100);
      expect(MAX_PRESET_NAME_CHARS).toBe(120);
      expect(MIN_RESOLUTION_DIMENSION).toBe(1);
      expect(MAX_RESOLUTION_DIMENSION).toBe(16_384);
      expect(MAX_ENCODER_NAME_CHARS).toBe(64);
      expect(MIN_ENCODER_NAME_CHARS).toBe(1);
      expect(MIN_AUDIO_BITRATE_KBPS).toBe(8);
      expect(MAX_AUDIO_BITRATE_KBPS).toBe(1536);
      expect(MIN_AUDIO_SAMPLE_RATE).toBe(8000);
      expect(MAX_AUDIO_SAMPLE_RATE).toBe(192000);
      expect(ENCODER_NAME_PATTERN.source).toBe("^[0-9A-Za-z][0-9A-Za-z_.-]*$");
      expect(QUALITY_RANGES).toEqual({
        crf: { min: 0, max: 63 },
        bitrate: { min: 1, max: 200_000 },
        qualityScale: { min: 1, max: 100 },
      });
    });
  });

  describe("defaultQualityValue", () => {
    it("returns the documented default for each kind", () => {
      expect(defaultQualityValue("crf")).toBe(20);
      expect(defaultQualityValue("bitrate")).toBe(8000);
      expect(defaultQualityValue("qualityScale")).toBe(50);
    });

    it("keeps every kind's default inside its own QUALITY_RANGES entry", () => {
      for (const kind of QUALITY_KINDS) {
        const value = defaultQualityValue(kind);
        const range = QUALITY_RANGES[kind];
        expect(value).toBeGreaterThanOrEqual(range.min);
        expect(value).toBeLessThanOrEqual(range.max);
      }
    });
  });

  describe("canAddPreset", () => {
    it("checks preset addition limits: canAddPreset(99) is true, canAddPreset(100) is false", () => {
      expect(canAddPreset(99)).toBe(true);
      expect(canAddPreset(100)).toBe(false);
    });
  });

  describe("name validation", () => {
    it("passes a name of exactly 120 characters and fails 121 with tooLong", () => {
      expect(validatePresetFields(createPreset({ name: "a".repeat(120) }))).toEqual([]);
      expect(validatePresetFields(createPreset({ name: "a".repeat(121) }))).toEqual([
        {
          field: "name",
          code: "tooLong",
          values: { max: 120 },
        },
      ]);
    });

    it("passes a name of exactly 120 emoji (astral) characters", () => {
      const emoji120 = "\u{1F600}".repeat(120);
      // Emoji consists of two UTF-16 code units per code point (astral surrogate pair)
      expect(emoji120.length).toBe(240);
      expect(validatePresetFields(createPreset({ name: emoji120 }))).toEqual([]);
    });

    it("fails a name of 121 emoji characters", () => {
      const emoji121 = "\u{1F600}".repeat(121);
      expect(validatePresetFields(createPreset({ name: emoji121 }))).toEqual([
        {
          field: "name",
          code: "tooLong",
          values: { max: 120 },
        },
      ]);
    });

    it("fails a name that is only whitespace with required", () => {
      expect(validatePresetFields(createPreset({ name: "   \t\n  " }))).toEqual([
        {
          field: "name",
          code: "required",
        },
      ]);
    });

    it("measures a name with leading and trailing spaces after trim", () => {
      expect(
        validatePresetFields(createPreset({ name: `  ${"a".repeat(120)}  ` })),
      ).toEqual([]);
      expect(
        validatePresetFields(createPreset({ name: `  ${"a".repeat(121)}  ` })),
      ).toEqual([
        {
          field: "name",
          code: "tooLong",
          values: { max: 120 },
        },
      ]);
    });
  });

  describe("encoder validation", () => {
    it("passes an encoder name of exactly 64 characters and fails 65", () => {
      const valid64 = "a".repeat(64);
      const invalid65 = "a".repeat(65);

      expect(isValidEncoderName(valid64)).toBe(true);
      expect(isValidEncoderName(invalid65)).toBe(false);

      expect(validatePresetFields(createPreset({ videoEncoder: valid64 }))).toEqual([]);
      expect(validatePresetFields(createPreset({ videoEncoder: invalid65 }))).toEqual([
        { field: "videoEncoder", code: "charset" },
      ]);

      expect(validatePresetFields(createPreset({ audioEncoder: valid64 }))).toEqual([]);
      expect(validatePresetFields(createPreset({ audioEncoder: invalid65 }))).toEqual([
        { field: "audioEncoder", code: "charset" },
      ]);
    });

    it("fails invalid encoder names with charset", () => {
      const invalidNames = [
        "-f",
        "libx264 -y",
        "_x264",
        ".foo",
        "lib/x264",
        "libx264 ",
        " libx264",
        "libx264;rm",
      ];

      for (const name of invalidNames) {
        expect(isValidEncoderName(name)).toBe(false);
        expect(validatePresetFields(createPreset({ videoEncoder: name }))).toEqual([
          { field: "videoEncoder", code: "charset" },
        ]);
        expect(validatePresetFields(createPreset({ audioEncoder: name }))).toEqual([
          { field: "audioEncoder", code: "charset" },
        ]);
      }
    });

    it("passes valid encoder names", () => {
      const validNames = [
        "libx264",
        "h264_videotoolbox",
        "libsvtav1",
        "aac",
        "0abc",
        "a.b-c_d",
      ];

      for (const name of validNames) {
        expect(isValidEncoderName(name)).toBe(true);
        expect(validatePresetFields(createPreset({ videoEncoder: name }))).toEqual([]);
        expect(validatePresetFields(createPreset({ audioEncoder: name }))).toEqual([]);
      }
    });

    it("fails whitespace-only encoder names with required", () => {
      expect(validatePresetFields(createPreset({ videoEncoder: "   " }))).toEqual([
        { field: "videoEncoder", code: "required" },
      ]);
      expect(validatePresetFields(createPreset({ audioEncoder: "   " }))).toEqual([
        { field: "audioEncoder", code: "required" },
      ]);
    });

    it("returns false directly for an empty encoder name", () => {
      expect(isValidEncoderName("")).toBe(false);
    });

    it("reports containerMismatch when mov contains flac or libopus", () => {
      expect(
        validatePresetFields(createPreset({ container: "mov", audioEncoder: "flac" })),
      ).toEqual([
        {
          field: "audioEncoder",
          code: "containerMismatch",
          values: { container: "mov", encoder: "flac" },
        },
      ]);

      expect(
        validatePresetFields(
          createPreset({ container: "mov", audioEncoder: "libopus" }),
        ),
      ).toEqual([
        {
          field: "audioEncoder",
          code: "containerMismatch",
          values: { container: "mov", encoder: "libopus" },
        },
      ]);
    });

    it("allows valid container and audio encoder combinations", () => {
      expect(
        validatePresetFields(createPreset({ container: "mov", audioEncoder: "aac" })),
      ).toEqual([]);
      expect(
        validatePresetFields(createPreset({ container: "mp4", audioEncoder: "flac" })),
      ).toEqual([]);
      expect(
        validatePresetFields(
          createPreset({ container: "mkv", audioEncoder: "libopus" }),
        ),
      ).toEqual([]);
    });

    it("prioritizes required and charset issues over containerMismatch for audioEncoder", () => {
      expect(
        validatePresetFields(createPreset({ container: "mov", audioEncoder: "   " })),
      ).toEqual([{ field: "audioEncoder", code: "required" }]);

      expect(
        validatePresetFields(createPreset({ container: "mov", audioEncoder: "-flac" })),
      ).toEqual([{ field: "audioEncoder", code: "charset" }]);
    });
  });

  describe("audioBitrate validation", () => {
    it("passes when audioBitrate is absent (encoder default)", () => {
      const preset = createPreset();
      delete preset.audioBitrate;
      expect(validatePresetFields(preset)).toEqual([]);
    });

    it("validates audioBitrate bounds: 8 passes, 1536 passes, 7 fails, 1537 fails", () => {
      expect(validatePresetFields(createPreset({ audioBitrate: 8 }))).toEqual([]);
      expect(validatePresetFields(createPreset({ audioBitrate: 320 }))).toEqual([]);
      expect(validatePresetFields(createPreset({ audioBitrate: 1536 }))).toEqual([]);

      expect(validatePresetFields(createPreset({ audioBitrate: 7 }))).toEqual([
        {
          field: "audioBitrate",
          code: "outOfRange",
          values: { min: 8, max: 1536 },
        },
      ]);

      expect(validatePresetFields(createPreset({ audioBitrate: 1537 }))).toEqual([
        {
          field: "audioBitrate",
          code: "outOfRange",
          values: { min: 8, max: 1536 },
        },
      ]);
    });

    it("fails non-integer audioBitrate with notInteger", () => {
      expect(validatePresetFields(createPreset({ audioBitrate: 128.5 }))).toEqual([
        { field: "audioBitrate", code: "notInteger" },
      ]);
      expect(validatePresetFields(createPreset({ audioBitrate: Number.NaN }))).toEqual([
        { field: "audioBitrate", code: "notInteger" },
      ]);
      expect(
        validatePresetFields(createPreset({ audioBitrate: Number.POSITIVE_INFINITY })),
      ).toEqual([{ field: "audioBitrate", code: "notInteger" }]);
    });
  });

  describe("audioSampleRate validation", () => {
    it("passes when audioSampleRate is 'source'", () => {
      expect(validatePresetFields(createPreset({ audioSampleRate: "source" }))).toEqual(
        [],
      );
    });

    it("validates audioSampleRate bounds: 8000 passes, 192000 passes, 7999 fails, 192001 fails", () => {
      expect(validatePresetFields(createPreset({ audioSampleRate: 8000 }))).toEqual([]);
      expect(validatePresetFields(createPreset({ audioSampleRate: 48000 }))).toEqual(
        [],
      );
      expect(validatePresetFields(createPreset({ audioSampleRate: 192000 }))).toEqual(
        [],
      );

      expect(validatePresetFields(createPreset({ audioSampleRate: 7999 }))).toEqual([
        {
          field: "audioSampleRate",
          code: "outOfRange",
          values: { min: 8000, max: 192000 },
        },
      ]);

      expect(validatePresetFields(createPreset({ audioSampleRate: 192001 }))).toEqual([
        {
          field: "audioSampleRate",
          code: "outOfRange",
          values: { min: 8000, max: 192000 },
        },
      ]);
    });

    it("fails non-integer audioSampleRate with notInteger", () => {
      expect(validatePresetFields(createPreset({ audioSampleRate: 44100.5 }))).toEqual([
        { field: "audioSampleRate", code: "notInteger" },
      ]);
      expect(
        validatePresetFields(createPreset({ audioSampleRate: Number.NaN })),
      ).toEqual([{ field: "audioSampleRate", code: "notInteger" }]);
      expect(
        validatePresetFields(
          createPreset({ audioSampleRate: Number.POSITIVE_INFINITY }),
        ),
      ).toEqual([{ field: "audioSampleRate", code: "notInteger" }]);
    });
  });

  describe("quality validation", () => {
    it("validates crf: 0 passes, 63 passes, 64 fails, -1 fails", () => {
      expect(
        validatePresetFields(createPreset({ quality: { kind: "crf", value: 0 } })),
      ).toEqual([]);
      expect(
        validatePresetFields(createPreset({ quality: { kind: "crf", value: 63 } })),
      ).toEqual([]);
      expect(
        validatePresetFields(createPreset({ quality: { kind: "crf", value: 64 } })),
      ).toEqual([
        {
          field: "quality",
          code: "outOfRange",
          values: { kind: "crf", min: 0, max: 63 },
        },
      ]);
      expect(
        validatePresetFields(createPreset({ quality: { kind: "crf", value: -1 } })),
      ).toEqual([
        {
          field: "quality",
          code: "outOfRange",
          values: { kind: "crf", min: 0, max: 63 },
        },
      ]);
    });

    it("validates bitrate: 1 passes, 200000 passes, 0 fails, 200001 fails", () => {
      expect(
        validatePresetFields(createPreset({ quality: { kind: "bitrate", value: 1 } })),
      ).toEqual([]);
      expect(
        validatePresetFields(
          createPreset({ quality: { kind: "bitrate", value: 200_000 } }),
        ),
      ).toEqual([]);
      expect(
        validatePresetFields(createPreset({ quality: { kind: "bitrate", value: 0 } })),
      ).toEqual([
        {
          field: "quality",
          code: "outOfRange",
          values: { kind: "bitrate", min: 1, max: 200_000 },
        },
      ]);
      expect(
        validatePresetFields(
          createPreset({ quality: { kind: "bitrate", value: 200_001 } }),
        ),
      ).toEqual([
        {
          field: "quality",
          code: "outOfRange",
          values: { kind: "bitrate", min: 1, max: 200_000 },
        },
      ]);
    });

    it("validates qualityScale: 1 passes, 100 passes, 0 fails, 101 fails", () => {
      expect(
        validatePresetFields(
          createPreset({ quality: { kind: "qualityScale", value: 1 } }),
        ),
      ).toEqual([]);
      expect(
        validatePresetFields(
          createPreset({ quality: { kind: "qualityScale", value: 100 } }),
        ),
      ).toEqual([]);
      expect(
        validatePresetFields(
          createPreset({ quality: { kind: "qualityScale", value: 0 } }),
        ),
      ).toEqual([
        {
          field: "quality",
          code: "outOfRange",
          values: { kind: "qualityScale", min: 1, max: 100 },
        },
      ]);
      expect(
        validatePresetFields(
          createPreset({ quality: { kind: "qualityScale", value: 101 } }),
        ),
      ).toEqual([
        {
          field: "quality",
          code: "outOfRange",
          values: { kind: "qualityScale", min: 1, max: 100 },
        },
      ]);
    });

    it("fails non-integer quality values with notInteger", () => {
      expect(
        validatePresetFields(createPreset({ quality: { kind: "crf", value: 20.5 } })),
      ).toEqual([{ field: "quality", code: "notInteger" }]);
    });

    it("fails non-finite quality values with notInteger", () => {
      expect(
        validatePresetFields(
          createPreset({ quality: { kind: "crf", value: Number.NaN } }),
        ),
      ).toEqual([{ field: "quality", code: "notInteger" }]);
      expect(
        validatePresetFields(
          createPreset({ quality: { kind: "crf", value: Number.POSITIVE_INFINITY } }),
        ),
      ).toEqual([{ field: "quality", code: "notInteger" }]);
    });
  });

  describe("resolution validation", () => {
    it("produces no issue for resolution: source and frameRate: source", () => {
      expect(
        validatePresetFields(
          createPreset({ resolution: "source", frameRate: "source" }),
        ),
      ).toEqual([]);
    });

    it("validates custom resolution bounds: 1x1 passes, 16384x16384 passes, 0 fails, 16385 fails, 1.5 fails with notInteger", () => {
      expect(
        validatePresetFields(createPreset({ resolution: { w: 1, h: 1 } })),
      ).toEqual([]);
      expect(
        validatePresetFields(createPreset({ resolution: { w: 16_384, h: 16_384 } })),
      ).toEqual([]);
      expect(
        validatePresetFields(createPreset({ resolution: { w: 0, h: 1080 } })),
      ).toEqual([
        {
          field: "resolution",
          code: "outOfRange",
          values: { min: 1, max: 16_384 },
        },
      ]);
      expect(
        validatePresetFields(createPreset({ resolution: { w: 1920, h: 0 } })),
      ).toEqual([
        {
          field: "resolution",
          code: "outOfRange",
          values: { min: 1, max: 16_384 },
        },
      ]);
      expect(
        validatePresetFields(createPreset({ resolution: { w: 16_385, h: 1080 } })),
      ).toEqual([
        {
          field: "resolution",
          code: "outOfRange",
          values: { min: 1, max: 16_384 },
        },
      ]);
      expect(
        validatePresetFields(createPreset({ resolution: { w: 1920, h: 16_385 } })),
      ).toEqual([
        {
          field: "resolution",
          code: "outOfRange",
          values: { min: 1, max: 16_384 },
        },
      ]);
      expect(
        validatePresetFields(createPreset({ resolution: { w: 1.5, h: 1080 } })),
      ).toEqual([{ field: "resolution", code: "notInteger" }]);
      expect(
        validatePresetFields(createPreset({ resolution: { w: 1920, h: 1.5 } })),
      ).toEqual([{ field: "resolution", code: "notInteger" }]);
    });
  });

  describe("frameRate validation", () => {
    it("validates rational frameRate: { n: 30000, d: 1001 } passes; { n: 0, d: 1 } fails; { n: 1, d: 0 } fails", () => {
      expect(
        validatePresetFields(createPreset({ frameRate: { n: 30_000, d: 1001 } })),
      ).toEqual([]);
      expect(validatePresetFields(createPreset({ frameRate: { n: 0, d: 1 } }))).toEqual(
        [{ field: "frameRate", code: "positive" }],
      );
      expect(validatePresetFields(createPreset({ frameRate: { n: 1, d: 0 } }))).toEqual(
        [{ field: "frameRate", code: "positive" }],
      );
      expect(
        validatePresetFields(createPreset({ frameRate: { n: 29.97, d: 1 } })),
      ).toEqual([{ field: "frameRate", code: "notInteger" }]);
      expect(
        validatePresetFields(createPreset({ frameRate: { n: 30, d: 1.5 } })),
      ).toEqual([{ field: "frameRate", code: "notInteger" }]);
    });
  });

  describe("multi-field failure ordering", () => {
    it("returns issues in the documented order when several fields are broken", () => {
      const brokenPreset: Preset = {
        id: "broken-preset",
        name: "   ",
        videoEncoder: "-f",
        audioEncoder: "   ",
        audioBitrate: 0,
        audioSampleRate: 5000,
        audioChannels: "source",
        quality: { kind: "crf", value: 99 },
        resolution: { w: 0, h: 0 },
        frameRate: { n: 0, d: 1 },
        container: "mp4",
      };

      expect(validatePresetFields(brokenPreset)).toEqual([
        { field: "name", code: "required" },
        { field: "videoEncoder", code: "charset" },
        { field: "audioEncoder", code: "required" },
        {
          field: "audioBitrate",
          code: "outOfRange",
          values: { min: 8, max: 1536 },
        },
        {
          field: "audioSampleRate",
          code: "outOfRange",
          values: { min: 8000, max: 192000 },
        },
        {
          field: "quality",
          code: "outOfRange",
          values: { kind: "crf", min: 0, max: 63 },
        },
        {
          field: "resolution",
          code: "outOfRange",
          values: { min: 1, max: 16_384 },
        },
        { field: "frameRate", code: "positive" },
      ]);
    });
  });

  describe("outOfRange contract", () => {
    it("attaches min and max to every outOfRange issue, and no values to positive, notInteger, or required issues", () => {
      const brokenPreset: Preset = {
        id: "broken-preset",
        name: "   ",
        videoEncoder: "-f",
        audioEncoder: "   ",
        audioBitrate: 0,
        audioSampleRate: 5000,
        audioChannels: "source",
        quality: { kind: "crf", value: 20.5 },
        resolution: { w: 0, h: 1080 },
        frameRate: { n: 0, d: 1 },
        container: "mp4",
      };

      const issues = validatePresetFields(brokenPreset);
      expect(issues.length).toBeGreaterThan(0);

      for (const issue of issues) {
        if (issue.code === "outOfRange") {
          expect(issue.values).toBeDefined();
          expect(issue.values).toHaveProperty("min");
          expect(issue.values).toHaveProperty("max");
        } else if (
          issue.code === "positive" ||
          issue.code === "notInteger" ||
          issue.code === "required"
        ) {
          expect(issue).not.toHaveProperty("values");
        }
      }
    });
  });
});
