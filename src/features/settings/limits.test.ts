import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QUALITY_KINDS, type Preset, type PresetOption } from "./types";
import {
  canAddPreset,
  DEFAULT_PIXEL_FORMAT,
  defaultQualityValue,
  DENIED_OPTION_NAMES,
  ENCODER_NAME_PATTERN,
  isDeniedOptionName,
  isValidEncoderName,
  isValidOptionName,
  isValidOptionValue,
  isValidPixelFormat,
  MAX_OPTION_NAME_CHARS,
  MAX_OPTION_VALUE_CHARS,
  MAX_PIXEL_FORMAT_CHARS,
  MAX_PRESET_OPTION_BYTES,
  MAX_PRESET_OPTIONS,
  OPTION_NAME_PATTERN,
  optionFlag,
  PIXEL_FORMAT_PATTERN,
  presetOptionBytes,
  renderedOptionBytes,
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

/** The settings module of the Rust backend, which holds every bound this module mirrors. */
const RUST_SETTINGS_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../src-tauri/src/settings/mod.rs", import.meta.url)),
  "utf8",
);

/**
 * Reads every name of `DENIED_OPTION_NAMES` out of the Rust source, in its order. The
 * declaration is matched rather than the whole file, so a string elsewhere cannot contribute a
 * name.
 */
function readRustDeniedOptionNames(): string[] {
  const declaration =
    /\npub const DENIED_OPTION_NAMES: &\[&str\] = &\[\n([\s\S]*?)\n\];\n/.exec(
      RUST_SETTINGS_SOURCE,
    );
  expect(declaration).not.toBeNull();
  const names = declaration![1].matchAll(/^ {4}"([^"]+)",$/gm);
  return Array.from(names, (match) => match[1]);
}

/** Reads the value of a `pub const <name>: usize = <value>;` or `u32` out of the Rust source. */
function readRustNumber(name: string): number {
  const declaration = new RegExp(
    `\\npub const ${name}: (?:usize|u32) = ([0-9_]+);\\n`,
  ).exec(RUST_SETTINGS_SOURCE);
  expect(declaration).not.toBeNull();
  return Number(declaration![1].replaceAll("_", ""));
}

function option(name: string, value: string): PresetOption {
  return { name, value };
}

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
    pixelFormat: "yuv420p",
    videoOptions: [],
    audioOptions: [],
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
        cq: { min: 1, max: 63 },
        bitrate: { min: 1, max: 200_000 },
        qualityScale: { min: 1, max: 100 },
      });
      expect(DEFAULT_PIXEL_FORMAT).toBe("yuv420p");
      expect(MAX_PIXEL_FORMAT_CHARS).toBe(32);
      expect(PIXEL_FORMAT_PATTERN.source).toBe("^[a-z0-9_]{1,32}$");
      expect(MAX_PRESET_OPTIONS).toBe(32);
      expect(MAX_OPTION_NAME_CHARS).toBe(64);
      expect(MAX_OPTION_VALUE_CHARS).toBe(512);
      expect(MAX_PRESET_OPTION_BYTES).toBe(1024);
      expect(OPTION_NAME_PATTERN.source).toBe("^[A-Za-z][A-Za-z0-9_.-]{0,63}$");
    });

    it("holds the same schema-2 bounds as the Rust settings module", () => {
      expect(readRustNumber("MIN_CONSTANT_QUALITY")).toBe(QUALITY_RANGES.cq.min);
      expect(readRustNumber("MAX_CONSTANT_QUALITY")).toBe(QUALITY_RANGES.cq.max);
      expect(readRustNumber("MAX_PIXEL_FORMAT_CHARS")).toBe(MAX_PIXEL_FORMAT_CHARS);
      expect(readRustNumber("MAX_PRESET_OPTIONS")).toBe(MAX_PRESET_OPTIONS);
      expect(readRustNumber("MAX_OPTION_NAME_CHARS")).toBe(MAX_OPTION_NAME_CHARS);
      expect(readRustNumber("MAX_OPTION_VALUE_CHARS")).toBe(MAX_OPTION_VALUE_CHARS);
      expect(readRustNumber("MAX_PRESET_OPTION_BYTES")).toBe(MAX_PRESET_OPTION_BYTES);
      expect(RUST_SETTINGS_SOURCE).toContain(
        `pub const DEFAULT_PIXEL_FORMAT: &str = "${DEFAULT_PIXEL_FORMAT}";`,
      );
    });
  });

  describe("DENIED_OPTION_NAMES", () => {
    it("names exactly the Rust list, in its order", () => {
      const rustNames = readRustDeniedOptionNames();
      // Guards the parse itself: a moved or renamed declaration would otherwise read as an
      // empty list and pass the comparison below.
      expect(rustNames.length).toBeGreaterThan(150);
      expect(new Set(rustNames).size).toBe(rustNames.length);
      expect([...DENIED_OPTION_NAMES]).toEqual(rustNames);
    });

    it("holds the managed flags, the argument-less options, and their no forms", () => {
      for (const name of [
        "c",
        "codec",
        "f",
        "i",
        "y",
        "n",
        "map",
        "filter_complex",
        "lavfi",
        "pix_fmt",
        "crf",
        "cq",
        "q",
        "b",
        "progress",
        "nostats",
        "loglevel",
        "copyts",
        "shortest",
        "noshortest",
        "an",
        "vn",
        "movflags",
      ]) {
        expect(isDeniedOptionName(name)).toBe(true);
      }
    });

    it("compares names exactly, so an encoder option that only starts like one passes", () => {
      for (const name of [
        "mapping_family",
        "Y",
        "preset",
        "x264-params",
        "tag",
        "profile",
      ]) {
        expect(isDeniedOptionName(name)).toBe(false);
      }
    });

    it("holds no name that the name rule refuses, because such a name could never reach it", () => {
      for (const name of DENIED_OPTION_NAMES) {
        expect(isValidOptionName(name)).toBe(true);
      }
    });
  });

  describe("option rules", () => {
    it("renders the flag with the specifier of the stream", () => {
      expect(optionFlag({ name: "preset" }, "video")).toBe("-preset:v");
      expect(optionFlag({ name: "aac_coder" }, "audio")).toBe("-aac_coder:a");
    });

    it("counts the UTF-8 bytes of the flag and the value, as Rust does", () => {
      expect(renderedOptionBytes(option("x", "abc"), "video")).toBe(4 + 3);
      // "é" is two bytes in UTF-8, one code point.
      expect(renderedOptionBytes(option("x", "é"), "audio")).toBe(4 + 2);
      expect(
        presetOptionBytes({
          videoOptions: [option("preset", "slow")],
          audioOptions: [option("ac4", "1")],
        }),
      ).toBe("-preset:vslow".length + "-ac4:a1".length);
    });

    it("accepts the option names of common encoders and refuses every other shape", () => {
      for (const name of [
        "preset",
        "x264-params",
        "b_ref_mode",
        "rc-lookahead",
        "a.b",
      ]) {
        expect(isValidOptionName(name)).toBe(true);
      }
      expect(isValidOptionName("a".repeat(64))).toBe(true);
      for (const name of [
        "",
        "-g",
        "/filter_complex",
        "profile:v",
        "1pass",
        "_x",
        "a b",
        "é",
        "a".repeat(65),
      ]) {
        expect(isValidOptionName(name)).toBe(false);
      }
    });

    it("accepts a value of 1 to 512 code points without a line break, a NUL, a double quote, or a final backslash", () => {
      expect(isValidOptionValue("a")).toBe(true);
      expect(isValidOptionValue("\u{1F600}".repeat(512))).toBe(true);
      expect(isValidOptionValue("C:\\x265\\stats")).toBe(true);
      for (const value of [
        "",
        "a".repeat(513),
        "a\nb",
        "a\rb",
        "a\0b",
        'a"b',
        "C:\\x265\\",
      ]) {
        expect(isValidOptionValue(value)).toBe(false);
      }
    });

    it("accepts a pixel format of lowercase letters, digits, and underscores", () => {
      for (const name of ["yuv420p", "p010le", "nv12", "a".repeat(32)]) {
        expect(isValidPixelFormat(name)).toBe(true);
      }
      for (const name of [
        "",
        "YUV420P",
        "yuv420p:x",
        "yuv 420p",
        "-custom",
        "a".repeat(33),
      ]) {
        expect(isValidPixelFormat(name)).toBe(false);
      }
    });
  });

  describe("pixel format and option validation", () => {
    it("passes the defaults and the options of the seeds", () => {
      expect(
        validatePresetFields(
          createPreset({
            pixelFormat: "p010le",
            videoOptions: [
              option("profile", "main10"),
              option("prio_speed", "0"),
              option("tag", "hvc1"),
            ],
            audioOptions: [option("profile", "aac_low")],
          }),
        ),
      ).toEqual([]);
    });

    it("reports a blank or a malformed pixel format", () => {
      expect(validatePresetFields(createPreset({ pixelFormat: "  " }))).toEqual([
        { field: "pixelFormat", code: "required" },
      ]);
      expect(validatePresetFields(createPreset({ pixelFormat: "yuv420p,x" }))).toEqual([
        { field: "pixelFormat", code: "pixelFormat", values: { max: 32 } },
      ]);
    });

    it("refuses every denied option name on both streams, noshortest included", () => {
      for (const name of DENIED_OPTION_NAMES) {
        expect(
          validatePresetFields(createPreset({ videoOptions: [option(name, "1")] })),
        ).toEqual([{ field: "videoOptions", code: "optionDenied", values: { name } }]);
        expect(
          validatePresetFields(createPreset({ audioOptions: [option(name, "1")] })),
        ).toEqual([{ field: "audioOptions", code: "optionDenied", values: { name } }]);
      }
      expect(
        validatePresetFields(
          createPreset({ audioOptions: [option("noshortest", "1")] }),
        ),
      ).toEqual([
        { field: "audioOptions", code: "optionDenied", values: { name: "noshortest" } },
      ]);
    });

    it("reports the first issue of each list, in the order Rust checks it", () => {
      expect(
        validatePresetFields(
          createPreset({
            videoOptions: [option("g", "1"), option("bad:name", "1"), option("y", "1")],
            audioOptions: [option("profile", ""), option("profile", "x")],
          }),
        ),
      ).toEqual([
        { field: "videoOptions", code: "optionName", values: { name: "bad:name" } },
        {
          field: "audioOptions",
          code: "optionValue",
          values: { name: "profile", max: 512 },
        },
      ]);
      expect(
        validatePresetFields(
          createPreset({ videoOptions: [option("g", "1"), option("g", "2")] }),
        ),
      ).toEqual([
        { field: "videoOptions", code: "optionDuplicate", values: { name: "g" } },
      ]);
      // One name on both streams is not a duplicate.
      expect(
        validatePresetFields(
          createPreset({
            videoOptions: [option("profile", "main")],
            audioOptions: [option("profile", "aac_low")],
          }),
        ),
      ).toEqual([]);
    });

    it("enforces the number of options of each list", () => {
      const options = (count: number) =>
        Array.from({ length: count }, (_, index) => option(`o${index}`, "1"));
      expect(
        validatePresetFields(
          createPreset({ videoOptions: options(32), audioOptions: options(32) }),
        ),
      ).toEqual([]);
      expect(validatePresetFields(createPreset({ audioOptions: options(33) }))).toEqual(
        [{ field: "audioOptions", code: "tooManyOptions", values: { max: 32 } }],
      );
    });

    it("enforces the byte limit of both lists together, on the list that passes it", () => {
      // 2 × 505 bytes of video options and 14 bytes of audio options: exactly the limit.
      const atLimit = createPreset({
        videoOptions: [option("xa", "v".repeat(500)), option("xb", "v".repeat(500))],
        audioOptions: [option("xc", "a".repeat(9))],
      });
      expect(presetOptionBytes(atLimit)).toBe(1024);
      expect(validatePresetFields(atLimit)).toEqual([]);

      const over = createPreset({
        ...atLimit,
        audioOptions: [option("xc", "a".repeat(10))],
      });
      expect(validatePresetFields(over)).toEqual([
        { field: "audioOptions", code: "optionsTooLong", values: { max: 1024 } },
      ]);

      const videoOver = createPreset({
        videoOptions: [0, 1, 2].map((index) => option(`o${index}`, "v".repeat(400))),
      });
      expect(validatePresetFields(videoOver)).toEqual([
        { field: "videoOptions", code: "optionsTooLong", values: { max: 1024 } },
      ]);
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
        pixelFormat: "yuv420p",
        videoOptions: [],
        audioOptions: [],
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
        pixelFormat: "yuv420p",
        videoOptions: [],
        audioOptions: [],
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
