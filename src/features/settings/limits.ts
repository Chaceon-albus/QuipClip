/**
 * Frontend preset limits and per-field validation rules matching Rust settings bounds.
 *
 * Implements defensive checks for preset creation and editing per ADR 013.
 * Authoritative backend source: src-tauri/src/settings/mod.rs.
 */

import { isAudioEncoderAllowedIn } from "./audioCodecs";
import type { Preset, PresetOption, QualityKind } from "./types";

/**
 * Maximum number of export presets allowed in settings.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_PRESETS).
 */
export const MAX_PRESETS = 100;

/**
 * Maximum preset display name length in Unicode code points.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_PRESET_NAME_CHARS).
 */
export const MAX_PRESET_NAME_CHARS = 120;

/**
 * Minimum resolution dimension in pixels for custom resolution width or height.
 * Authoritative source: src-tauri/src/settings/mod.rs.
 */
export const MIN_RESOLUTION_DIMENSION = 1;

/**
 * Maximum resolution dimension in pixels for custom resolution width or height.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_RESOLUTION_DIMENSION).
 */
export const MAX_RESOLUTION_DIMENSION = 16_384;

/**
 * Maximum encoder name length in Unicode code points.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_ENCODER_NAME_CHARS).
 */
export const MAX_ENCODER_NAME_CHARS = 64;

/**
 * Minimum encoder name length in Unicode code points.
 * Authoritative source: src-tauri/src/settings/mod.rs.
 */
export const MIN_ENCODER_NAME_CHARS = 1;

/**
 * Minimum audio bitrate in kilobits per second (kbps).
 * Authoritative source: src-tauri/src/settings/mod.rs (MIN_AUDIO_BITRATE_KBPS).
 */
export const MIN_AUDIO_BITRATE_KBPS = 8;

/**
 * Maximum audio bitrate in kilobits per second (kbps).
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_AUDIO_BITRATE_KBPS).
 */
export const MAX_AUDIO_BITRATE_KBPS = 1536;

/**
 * Minimum audio sample rate in hertz.
 * Authoritative source: src-tauri/src/settings/mod.rs (MIN_AUDIO_SAMPLE_RATE).
 */
export const MIN_AUDIO_SAMPLE_RATE = 8000;

/**
 * Maximum audio sample rate in hertz.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_AUDIO_SAMPLE_RATE).
 */
export const MAX_AUDIO_SAMPLE_RATE = 192000;

/**
 * Regular expression validating encoder name character set and start pattern.
 * Encoder names must start with an alphanumeric character and contain only [0-9A-Za-z_.-].
 * Authoritative source: src-tauri/src/settings/mod.rs (is_valid_encoder_name).
 */
export const ENCODER_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z_.-]*$/;

/**
 * Permissible numeric ranges for preset quality configurations by QualityKind.
 * Authoritative source: src-tauri/src/settings/mod.rs (is_valid_quality).
 */
export const QUALITY_RANGES: Record<QualityKind, { min: number; max: number }> = {
  crf: { min: 0, max: 63 },
  // NVENC reads 0 as automatic. 63 is the top of av1_nvenc; h264_nvenc and hevc_nvenc stop at 51.
  cq: { min: 1, max: 63 }, // MIN_CONSTANT_QUALITY and MAX_CONSTANT_QUALITY
  bitrate: { min: 1, max: 200_000 }, // kilobits per second
  qualityScale: { min: 1, max: 100 },
};

/**
 * Default numeric value written when the user switches the quality kind to a given kind.
 * Each value sits inside its own `QUALITY_RANGES` entry (see limits.test.ts), so switching
 * kind never carries a stale number out of range: a crf of 20 read as a bitrate would mean
 * 20 kbit/s, and a bitrate of 8000 read as a crf would be out of range and need clearing by
 * hand.
 */
const DEFAULT_QUALITY_VALUES: Record<QualityKind, number> = {
  crf: 20,
  cq: 25,
  bitrate: 8000,
  qualityScale: 50,
};

/**
 * Returns the default numeric value for the given quality kind.
 */
export function defaultQualityValue(kind: QualityKind): number {
  return DEFAULT_QUALITY_VALUES[kind];
}

/**
 * The pixel format a new preset takes, and the one a version-1 preset reads as.
 * Authoritative source: src-tauri/src/settings/mod.rs (DEFAULT_PIXEL_FORMAT).
 */
export const DEFAULT_PIXEL_FORMAT = "yuv420p";

/**
 * Maximum pixel format name length.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_PIXEL_FORMAT_CHARS).
 */
export const MAX_PIXEL_FORMAT_CHARS = 32;

/**
 * The characters of a pixel format name: those of every name that `ffmpeg -pix_fmts` lists.
 * The graph writes the name into a filter, so the rule keeps it from changing the graph.
 * Authoritative source: src-tauri/src/settings/mod.rs (is_valid_pixel_format).
 */
export const PIXEL_FORMAT_PATTERN = /^[a-z0-9_]{1,32}$/;

/**
 * Maximum number of entries in one of `videoOptions` and `audioOptions`.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_PRESET_OPTIONS).
 */
export const MAX_PRESET_OPTIONS = 32;

/**
 * Maximum option name length.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_OPTION_NAME_CHARS).
 */
export const MAX_OPTION_NAME_CHARS = 64;

/**
 * Maximum option value length in Unicode code points.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_OPTION_VALUE_CHARS).
 */
export const MAX_OPTION_VALUE_CHARS = 512;

/**
 * Maximum bytes that the options of one preset add to the command line, for both lists
 * together; see `renderedOptionBytes`.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_PRESET_OPTION_BYTES).
 */
export const MAX_PRESET_OPTION_BYTES = 1024;

/**
 * The character rule of an option name: an ASCII letter, then ASCII letters, digits, `_`, `.`,
 * or `-`, 64 characters at most. It refuses a `:`, which would change the stream specifier,
 * and a `/`, because FFmpeg 7.1 and later read the value of `-/<name>` from a file.
 * Authoritative source: src-tauri/src/settings/mod.rs (is_valid_option_name).
 */
export const OPTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * The option names a preset cannot hold: each fftools option that takes no argument (Rust
 * would leave its value behind as an output file), and each option that QuipClip sets or that
 * breaks the export. The comparison is exact and case-sensitive.
 *
 * A copy of the Rust list, which is the one source of truth and documents each group.
 * `limits.test.ts` reads the Rust list and compares the two.
 * Authoritative source: src-tauri/src/settings/mod.rs (DENIED_OPTION_NAMES).
 */
export const DENIED_OPTION_NAMES: readonly string[] = [
  // fftools options that print something and end the process (`OPT_EXIT`).
  "L",
  "license",
  "h",
  "help",
  "version",
  "buildconf",
  "formats",
  "muxers",
  "demuxers",
  "devices",
  "codecs",
  "decoders",
  "encoders",
  "bsfs",
  "protocols",
  "filters",
  "pix_fmts",
  "layouts",
  "sample_fmts",
  "dispositions",
  "colors",
  "sources",
  "sinks",
  "hwaccels",
  // fftools functions that take no argument.
  "report",
  "vstats",
  "qphist",
  // fftools boolean options.
  "accurate_seek",
  "an",
  "auto_conversion_filters",
  "autorotate",
  "autoscale",
  "benchmark",
  "benchmark_all",
  "bitexact",
  "copy_unknown",
  "copyinkf",
  "copyts",
  "debug_ts",
  "display_hflip",
  "display_vflip",
  "dn",
  "dump",
  "find_stream_info",
  "fix_sub_duration",
  "fix_sub_duration_heartbeat",
  "force_fps",
  "hex",
  "hide_banner",
  "ignore_unknown",
  "n",
  "print_graphs",
  "re",
  "recast_media",
  "shortest",
  "sn",
  "start_at_zero",
  "stats",
  "stdin",
  "vn",
  "xerror",
  "y",
  // The `no` form of each boolean option, which sets it to false.
  "noaccurate_seek",
  "noan",
  "noauto_conversion_filters",
  "noautorotate",
  "noautoscale",
  "nobenchmark",
  "nobenchmark_all",
  "nobitexact",
  "nocopy_unknown",
  "nocopyinkf",
  "nocopyts",
  "nodebug_ts",
  "nodisplay_hflip",
  "nodisplay_vflip",
  "nodn",
  "nodump",
  "nofind_stream_info",
  "nofix_sub_duration",
  "nofix_sub_duration_heartbeat",
  "noforce_fps",
  "nohex",
  "nohide_banner",
  "noignore_unknown",
  "non",
  "noprint_graphs",
  "nore",
  "norecast_media",
  "noshortest",
  "nosn",
  "nostart_at_zero",
  "nostats",
  "nostdin",
  "novn",
  "noxerror",
  "noy",
  // The group separators of the command line: an input file, and a loopback decoder.
  "i",
  "dec",
  // The streams, the encoders, and the muxer, which the renderer selects.
  "map",
  "map_metadata",
  "map_chapters",
  "c",
  "codec",
  "vcodec",
  "acodec",
  "scodec",
  "dcodec",
  "f",
  "target",
  "attach",
  // Filters. The renderer writes the one filter graph of the export.
  "filter",
  "filter_complex",
  "filter_complex_script",
  "filter_script",
  "filter_threads",
  "filter_complex_threads",
  "filter_hw_device",
  "filter_buffered_frames",
  "lavfi",
  "vf",
  "af",
  // The picture and the sound that preset fields set: size, rate, pixel format, sample
  // rate, channels, aspect, time base, and rotation.
  "s",
  "r",
  "fpsmax",
  "fps_mode",
  "vsync",
  "pix_fmt",
  "ar",
  "ac",
  "ch_layout",
  "channel_layout",
  "apad",
  "aspect",
  "sar",
  "enc_time_base",
  "time_base",
  "display_rotation",
  // The quality control and the bitrates, which the quality kind and the audio bitrate set.
  "b",
  "ab",
  "crf",
  "cq",
  "q",
  "qscale",
  "aq",
  "global_quality",
  // The length of the output and the number of frames, which the success checks count.
  "t",
  "to",
  "ss",
  "sseof",
  "fs",
  "frames",
  "vframes",
  "aframes",
  "dframes",
  "shortest_buf_duration",
  "frame_drop_threshold",
  // The inputs and their timestamps, which the cut relies on.
  "itsoffset",
  "itsscale",
  "stream_loop",
  "readrate",
  "readrate_initial_burst",
  "readrate_catchup",
  "seek_timestamp",
  "isync",
  "dts_delta_threshold",
  "dts_error_threshold",
  "copytb",
  "reinit_filter",
  "drop_changed",
  // The process: its log, its progress report, its time limit, and its exit status.
  "loglevel",
  "v",
  "progress",
  "stats_period",
  "timelimit",
  "max_error_rate",
  // Files beside the output, and files of options.
  "pass",
  "passlogfile",
  "vstats_file",
  "vstats_version",
  "stats_enc_pre",
  "stats_enc_post",
  "stats_mux_pre",
  "stats_enc_pre_fmt",
  "stats_enc_post_fmt",
  "stats_mux_pre_fmt",
  "print_graphs_file",
  "print_graphs_format",
  "sdp_file",
  "dump_attachment",
  "pre",
  "apre",
  "vpre",
  "spre",
  "fpre",
  // The muxer and the packets: muxer flags, metadata, and bitstream filters, which can
  // rewrite timestamps or drop packets after the encoder.
  "movflags",
  "metadata",
  "bsf",
];

const DENIED_OPTION_NAME_SET: ReadonlySet<string> = new Set(DENIED_OPTION_NAMES);

/** The stream that one option list applies to. */
export type OptionStream = "video" | "audio";

/**
 * The flag argument Rust writes for `option` on `stream`: `-<name>:v` or `-<name>:a`.
 * Authoritative source: src-tauri/src/settings/mod.rs (PresetOption::flag).
 */
export function optionFlag(
  option: Pick<PresetOption, "name">,
  stream: OptionStream,
): string {
  return `-${option.name}:${stream === "video" ? "v" : "a"}`;
}

const utf8 = new TextEncoder();

/**
 * The bytes `option` adds to the command line on `stream`: the UTF-8 bytes of the flag and of
 * the value. `MAX_PRESET_OPTION_BYTES` bounds the sum over both lists of a preset.
 * Authoritative source: src-tauri/src/settings/mod.rs (PresetOption::rendered_bytes).
 */
export function renderedOptionBytes(
  option: PresetOption,
  stream: OptionStream,
): number {
  return (
    utf8.encode(optionFlag(option, stream)).length + utf8.encode(option.value).length
  );
}

/**
 * The bytes all options of one preset add to the command line.
 */
export function presetOptionBytes(
  preset: Pick<Preset, "videoOptions" | "audioOptions">,
): number {
  let bytes = 0;
  for (const option of preset.videoOptions) {
    bytes += renderedOptionBytes(option, "video");
  }
  for (const option of preset.audioOptions) {
    bytes += renderedOptionBytes(option, "audio");
  }
  return bytes;
}

/**
 * Checks an option name against `OPTION_NAME_PATTERN`.
 */
export function isValidOptionName(name: string): boolean {
  return OPTION_NAME_PATTERN.test(name);
}

/**
 * Checks whether a preset cannot hold an option with this name (see `DENIED_OPTION_NAMES`).
 */
export function isDeniedOptionName(name: string): boolean {
  return DENIED_OPTION_NAME_SET.has(name);
}

/**
 * Checks an option value: 1 to `MAX_OPTION_VALUE_CHARS` code points, with no NUL, CR, LF or
 * `"`, and no `\` at its end (the Windows quoting of an argument would lengthen both).
 * Counts Unicode code points rather than UTF-16 code units to match Rust chars().count().
 * Authoritative source: src-tauri/src/settings/mod.rs (is_valid_option_value).
 */
export function isValidOptionValue(value: string): boolean {
  const codePointCount = [...value].length;
  return (
    codePointCount >= 1 &&
    codePointCount <= MAX_OPTION_VALUE_CHARS &&
    !/[\0\r\n"]/.test(value) &&
    !value.endsWith("\\")
  );
}

/**
 * Checks a pixel format name against `PIXEL_FORMAT_PATTERN`.
 */
export function isValidPixelFormat(name: string): boolean {
  return PIXEL_FORMAT_PATTERN.test(name);
}

export type PresetFieldName =
  | "name"
  | "videoEncoder"
  | "audioEncoder"
  | "audioBitrate"
  | "audioSampleRate"
  | "quality"
  | "resolution"
  | "frameRate"
  | "pixelFormat"
  | "videoOptions"
  | "audioOptions";

export type PresetFieldIssueCode =
  | "required"
  | "tooLong"
  | "charset"
  | "outOfRange"
  | "notInteger"
  | "positive"
  | "containerMismatch"
  | "pixelFormat"
  | "tooManyOptions"
  | "optionName"
  | "optionDenied"
  | "optionDuplicate"
  | "optionValue"
  | "optionsTooLong";

export type PresetFieldIssue = {
  field: PresetFieldName;
  code: PresetFieldIssueCode;
  values?: Record<string, string | number>;
};

/**
 * Checks whether an encoder name satisfies character set, starting character, and length constraints.
 *
 * Counts Unicode code points rather than UTF-16 code units to match Rust chars().count().
 * Does not trim whitespace: leading or trailing spaces are invalid characters.
 * Authoritative source: src-tauri/src/settings/mod.rs (is_valid_encoder_name).
 */
export function isValidEncoderName(name: string): boolean {
  const codePointCount = [...name].length;
  if (
    codePointCount < MIN_ENCODER_NAME_CHARS ||
    codePointCount > MAX_ENCODER_NAME_CHARS
  ) {
    return false;
  }
  return ENCODER_NAME_PATTERN.test(name);
}

/**
 * Checks whether another preset can be added without exceeding MAX_PRESETS.
 * Authoritative source: src-tauri/src/settings/mod.rs (MAX_PRESETS).
 */
export function canAddPreset(presetCount: number): boolean {
  return presetCount < MAX_PRESETS;
}

/**
 * Returns the first issue of one option list, in the order Rust checks it: the count, then
 * each entry in order, its name before its value. Returns null when the list is valid.
 */
function optionListIssue(
  field: "videoOptions" | "audioOptions",
  options: readonly PresetOption[],
): PresetFieldIssue | null {
  if (options.length > MAX_PRESET_OPTIONS) {
    return { field, code: "tooManyOptions", values: { max: MAX_PRESET_OPTIONS } };
  }
  const names = new Set<string>();
  for (const option of options) {
    if (!isValidOptionName(option.name)) {
      return { field, code: "optionName", values: { name: option.name } };
    }
    if (isDeniedOptionName(option.name)) {
      return { field, code: "optionDenied", values: { name: option.name } };
    }
    if (names.has(option.name)) {
      return { field, code: "optionDuplicate", values: { name: option.name } };
    }
    names.add(option.name);
    if (!isValidOptionValue(option.value)) {
      return {
        field,
        code: "optionValue",
        values: { name: option.name, max: MAX_OPTION_VALUE_CHARS },
      };
    }
  }
  return null;
}

/**
 * Validates the fields of an individual export preset, returning issues in fixed field order.
 *
 * Order: name, videoEncoder, audioEncoder, audioBitrate, audioSampleRate, quality, resolution,
 * frameRate, pixelFormat, videoOptions, audioOptions.
 * Reports at most one issue per field. Returns [] when all fields are valid.
 * Authoritative source: src-tauri/src/settings/mod.rs (validate_settings). Note that the
 * container-audio encoder compatibility rule exists only here (ADR 023); Rust does not repeat
 * the container rule.
 */
export function validatePresetFields(preset: Preset): PresetFieldIssue[] {
  const issues: PresetFieldIssue[] = [];

  // 1. name: blank after trim -> required; over MAX_PRESET_NAME_CHARS code points -> tooLong
  const trimmedName = preset.name.trim();
  if (trimmedName.length === 0) {
    issues.push({ field: "name", code: "required" });
  } else if ([...trimmedName].length > MAX_PRESET_NAME_CHARS) {
    issues.push({
      field: "name",
      code: "tooLong",
      values: { max: MAX_PRESET_NAME_CHARS },
    });
  }

  // 2. videoEncoder: blank after trim -> required; !isValidEncoderName(untrimmed) -> charset
  if (preset.videoEncoder.trim().length === 0) {
    issues.push({ field: "videoEncoder", code: "required" });
  } else if (!isValidEncoderName(preset.videoEncoder)) {
    issues.push({ field: "videoEncoder", code: "charset" });
  }

  // 3. audioEncoder: blank after trim -> required; !isValidEncoderName(untrimmed) -> charset; container mismatch -> containerMismatch
  if (preset.audioEncoder.trim().length === 0) {
    issues.push({ field: "audioEncoder", code: "required" });
  } else if (!isValidEncoderName(preset.audioEncoder)) {
    issues.push({ field: "audioEncoder", code: "charset" });
  } else if (!isAudioEncoderAllowedIn(preset.container, preset.audioEncoder)) {
    issues.push({
      field: "audioEncoder",
      code: "containerMismatch",
      values: {
        container: preset.container,
        encoder: preset.audioEncoder,
      },
    });
  }

  // 4. audioBitrate: when present, not safe integer -> notInteger; outside bounds -> outOfRange
  if (preset.audioBitrate !== undefined) {
    if (!Number.isSafeInteger(preset.audioBitrate)) {
      issues.push({ field: "audioBitrate", code: "notInteger" });
    } else if (
      preset.audioBitrate < MIN_AUDIO_BITRATE_KBPS ||
      preset.audioBitrate > MAX_AUDIO_BITRATE_KBPS
    ) {
      issues.push({
        field: "audioBitrate",
        code: "outOfRange",
        values: {
          min: MIN_AUDIO_BITRATE_KBPS,
          max: MAX_AUDIO_BITRATE_KBPS,
        },
      });
    }
  }

  // 5. audioSampleRate: when a number, not safe integer -> notInteger; outside bounds -> outOfRange
  if (typeof preset.audioSampleRate === "number") {
    if (!Number.isSafeInteger(preset.audioSampleRate)) {
      issues.push({ field: "audioSampleRate", code: "notInteger" });
    } else if (
      preset.audioSampleRate < MIN_AUDIO_SAMPLE_RATE ||
      preset.audioSampleRate > MAX_AUDIO_SAMPLE_RATE
    ) {
      issues.push({
        field: "audioSampleRate",
        code: "outOfRange",
        values: {
          min: MIN_AUDIO_SAMPLE_RATE,
          max: MAX_AUDIO_SAMPLE_RATE,
        },
      });
    }
  }

  // 6. quality: not safe integer -> notInteger; outside range -> outOfRange
  if (!Number.isSafeInteger(preset.quality.value)) {
    issues.push({ field: "quality", code: "notInteger" });
  } else {
    const range = QUALITY_RANGES[preset.quality.kind];
    if (preset.quality.value < range.min || preset.quality.value > range.max) {
      issues.push({
        field: "quality",
        code: "outOfRange",
        values: {
          kind: preset.quality.kind,
          min: range.min,
          max: range.max,
        },
      });
    }
  }

  // 7. resolution: skip "source"; { w, h }: not safe integer -> notInteger; outside bounds -> outOfRange
  if (preset.resolution !== "source") {
    if (
      !Number.isSafeInteger(preset.resolution.w) ||
      !Number.isSafeInteger(preset.resolution.h)
    ) {
      issues.push({ field: "resolution", code: "notInteger" });
    } else if (
      preset.resolution.w < MIN_RESOLUTION_DIMENSION ||
      preset.resolution.w > MAX_RESOLUTION_DIMENSION ||
      preset.resolution.h < MIN_RESOLUTION_DIMENSION ||
      preset.resolution.h > MAX_RESOLUTION_DIMENSION
    ) {
      issues.push({
        field: "resolution",
        code: "outOfRange",
        values: {
          min: MIN_RESOLUTION_DIMENSION,
          max: MAX_RESOLUTION_DIMENSION,
        },
      });
    }
  }

  // 8. frameRate: skip "source"; { n, d }: not safe integer -> notInteger; n <= 0 || d <= 0 -> positive
  if (preset.frameRate !== "source") {
    if (
      !Number.isSafeInteger(preset.frameRate.n) ||
      !Number.isSafeInteger(preset.frameRate.d)
    ) {
      issues.push({ field: "frameRate", code: "notInteger" });
    } else if (preset.frameRate.n <= 0 || preset.frameRate.d <= 0) {
      issues.push({ field: "frameRate", code: "positive" });
    }
  }

  // 9. pixelFormat: blank -> required; outside PIXEL_FORMAT_PATTERN -> pixelFormat
  if (preset.pixelFormat.trim().length === 0) {
    issues.push({ field: "pixelFormat", code: "required" });
  } else if (!isValidPixelFormat(preset.pixelFormat)) {
    issues.push({
      field: "pixelFormat",
      code: "pixelFormat",
      values: { max: MAX_PIXEL_FORMAT_CHARS },
    });
  }

  // 10, 11. videoOptions and audioOptions: the first issue of each list; then the byte limit
  // of both lists together, on the list that passes it, unless that list has an issue already.
  const videoIssue = optionListIssue("videoOptions", preset.videoOptions);
  const audioIssue = optionListIssue("audioOptions", preset.audioOptions);
  let videoBytes = 0;
  for (const option of preset.videoOptions) {
    videoBytes += renderedOptionBytes(option, "video");
  }
  const tooLong = presetOptionBytes(preset) > MAX_PRESET_OPTION_BYTES;
  // Rust writes the video options first, so the audio list passes the limit unless the video
  // list already does on its own.
  const tooLongField =
    videoBytes > MAX_PRESET_OPTION_BYTES ? "videoOptions" : "audioOptions";
  for (const [field, issue] of [
    ["videoOptions", videoIssue],
    ["audioOptions", audioIssue],
  ] as const) {
    if (issue !== null) {
      issues.push(issue);
    } else if (tooLong && field === tooLongField) {
      issues.push({
        field,
        code: "optionsTooLong",
        values: { max: MAX_PRESET_OPTION_BYTES },
      });
    }
  }

  return issues;
}
