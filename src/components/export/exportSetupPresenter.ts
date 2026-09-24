/**
 * Pure presenter for the export dialog setup step.
 *
 * Implements preset resolution, the summary sentence, the grouped preset summary, the size
 * estimate, and export blocker detection according to ADR 002, ADR 011, ADR 023, ADR 024 and
 * ADR 028. Pure module with no React dependencies.
 */

import {
  formatAudioSampleRateKHz,
  presentContainer,
  presentPresetEncoderMark,
  presentPresetRowSummary,
  type MessageView,
  type PresetEncoderMarkView,
} from "@/components/settings/presetPresenter";
import type { FfmpegState } from "@/features/ffmpeg/types";
import type { MediaProbe } from "@/features/media";
import { getNominalFrameRate } from "@/features/playback";
import {
  isAudioEncoderAllowedIn,
  isLosslessAudioEncoder,
} from "@/features/settings/audioCodecs";
import type { SettingsSection } from "@/features/settings/panelStore";
import {
  splitGraphemes,
  type GraphemeSegmenter,
} from "@/features/settings/presetNaming";
import type {
  Preset,
  Settings,
  SettingsError,
  SettingsStatus,
} from "@/features/settings/types";
import { FRAME_RATE_CHOICES } from "@/features/settings/videoOutputChoices";
import { formatSegmentTotal, getActiveSourceSegmentEntries } from "@/features/timeline";
import { splitFileName } from "@/lib/fileName";
import { rationalsEqual, segmentDurationTicks } from "@/lib/time";
import type { TimecodeDisplay } from "@/lib/timecode";
import type { Rational, Segment } from "@/types/project";

/**
 * View model for a single summary row in the preset details list.
 *
 * A number in `valueValues` is a `count` that selects a plural form. Every other value is a
 * string that the presenter already formatted.
 */
export type PresetSummaryRowView = {
  id: string;
  labelKey: string;
  valueKey: string;
  valueValues?: Record<string, string | number>;
};

/**
 * Blocker message indicating why an export cannot proceed with the given preset.
 */
export type SetupBlockerView = {
  key: string;
  values?: Record<string, string>;
};

/**
 * Resolves the effective preset identifier for the export setup dialog.
 *
 * Hierarchy per ADR 024:
 * 1. The user's explicit in-dialog selection (`requestedId`), when that preset still exists.
 * 2. The active preset from settings (`settings.activePresetId`), when that preset exists.
 * 3. The first preset in the library, when the active preset identifier dangles or is unset.
 * 4. `null` when no presets exist or settings are not loaded yet.
 */
export function resolveSetupPresetId(
  settings: Settings | null,
  requestedId: string | null,
): string | null {
  if (!settings || settings.presets.length === 0) {
    return null;
  }

  if (requestedId !== null && settings.presets.some((p) => p.id === requestedId)) {
    return requestedId;
  }

  if (
    settings.activePresetId !== undefined &&
    settings.presets.some((p) => p.id === settings.activePresetId)
  ) {
    return settings.activePresetId;
  }

  return settings.presets[0]?.id ?? null;
}

/**
 * Formats a frame rate fraction n/d as a localized decimal string with at most 3 fraction digits.
 *
 * For example, 30000/1001 renders as "29.97" and 24000/1001 renders as "23.976", matching
 * standard video industry conventions without assembling sentences from fragments.
 */
export function formatFps(
  numerator: number,
  denominator: number,
  formatter: Intl.NumberFormat,
): string {
  const fpsFormatter = new Intl.NumberFormat(formatter.resolvedOptions().locale, {
    maximumFractionDigits: 3,
  });
  return fpsFormatter.format(numerator / denominator);
}

/**
 * Formats a frame rate the way the frame rate `<Select>` of the preset editor labels it.
 *
 * A rate that equals one of `FRAME_RATE_CHOICES` as a fraction shows the conventional name of
 * that choice, such as 29.97 for 30000/1001, through `formatter`. Any other rate shows
 * `formatFps`. The two agree for every choice, so a rate reads the same in the editor, in the
 * summary, and in the "Same as Source" value of the summary.
 */
export function formatFrameRate(rate: Rational, formatter: Intl.NumberFormat): string {
  const choice = FRAME_RATE_CHOICES.find((candidate) =>
    rationalsEqual(candidate.rate, rate),
  );
  return choice
    ? formatter.format(choice.nominal)
    : formatFps(rate.n, rate.d, formatter);
}

/** The most grapheme clusters that the summary sentence shows of a file name. */
export const SUMMARY_FILE_NAME_MAX_GRAPHEMES = 40;

/** The mark that replaces the part of a file name that the summary leaves out. */
const TRUNCATION_MARK = "…";

/**
 * Shortens a long file name in the middle, so that the start and the end of the name stay
 * visible, and keeps the extension whole: `Recording 2026-09-…0.15.32 final cut.mov`.
 *
 * A name of at most `max` grapheme clusters (see `splitGraphemes`) is returned unchanged. A
 * longer name keeps the extension of `splitFileName` and the start and the end of the stem,
 * with one `…` between them, and holds at most `max` clusters. White space next to the mark is
 * removed. An extension longer than half of `max` is not an extension a reader needs to see
 * whole, so the whole name is then shortened as one text. A cluster is never split.
 *
 * @param name A base name, not a path.
 * @param max The most clusters the result holds. It must be at least 3.
 */
export function truncateFileNameMiddle(
  name: string,
  max: number = SUMMARY_FILE_NAME_MAX_GRAPHEMES,
  segmenter?: GraphemeSegmenter | null,
): string {
  const graphemes = splitGraphemes(name, segmenter);
  if (graphemes.length <= max) {
    return name;
  }
  const { stem, extension } = splitFileName(name);
  const extensionLength = splitGraphemes(extension, segmenter).length;
  const keepsExtension = extensionLength <= Math.floor(max / 2);
  const body = keepsExtension ? splitGraphemes(stem, segmenter) : graphemes;
  const ending = keepsExtension ? extension : "";
  const room = max - TRUNCATION_MARK.length - (keepsExtension ? extensionLength : 0);
  const headLength = Math.ceil(room / 2);
  const tailLength = room - headLength;
  const head = body.slice(0, headLength).join("").trimEnd();
  const tail = body
    .slice(body.length - tailLength)
    .join("")
    .trimStart();
  return `${head}${TRUNCATION_MARK}${tail}${ending}`;
}

/** The facts of the open source and of its segments that the summary sentence reads. */
export type ExportSummaryInput = {
  /** The file name of the open source, with its extension, or null with no source. */
  readonly fileName: string | null;
  /** The number of segments of the open source. */
  readonly segmentCount: number;
  /**
   * The total duration of those segments, from `totalActiveSourceSegments` with `display`, or
   * null when it is not known. It is the value that the Export tooltip of the title bar reads.
   */
  readonly segmentTotal: bigint | null;
  /** The timecode format of the open source (`resolveTimecodeDisplay`, ADR 028). */
  readonly display: TimecodeDisplay;
};

/** The values of the summary sentence at the top of the setup step. */
export type ExportSummarySentenceView = {
  readonly key: "export.setup.summary";
  /** The number of segments. It also selects the plural form. */
  readonly count: number;
  /**
   * The file name that the sentence shows: shortened in the middle when it is long
   * (`truncateFileNameMiddle`), and isolated (`isolateText`).
   */
  readonly fileName: string;
  /**
   * The whole file name, isolated. With a shortened name, assistive technology reads the
   * sentence with this name in place of `fileName`.
   */
  readonly fullFileName: string;
  /** True when `fileName` is shorter than the whole name. */
  readonly shortened: boolean;
  /** The whole file name with no isolation marks, for the tooltip of a shortened name. */
  readonly title: string;
  /** The total duration, as the Export tooltip of the title bar shows it. */
  readonly duration: string;
};

/** U+2068 FIRST STRONG ISOLATE. */
const FIRST_STRONG_ISOLATE = "\u2068";
/** U+2069 POP DIRECTIONAL ISOLATE. */
const POP_DIRECTIONAL_ISOLATE = "\u2069";

/**
 * Wraps text in U+2068 FIRST STRONG ISOLATE and U+2069 POP DIRECTIONAL ISOLATE. The
 * bidirectional algorithm then orders the text on its own, in the direction of its first
 * strong character, and the text around it keeps its order. A file name in Hebrew or Arabic
 * therefore cannot move the count or the duration of the sentence. Both marks are invisible.
 */
export function isolateText(text: string): string {
  return `${FIRST_STRONG_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}

/**
 * Returns the values of the sentence "Export 3 segments from clip.mov · 00:01:23:12 in total".
 *
 * The duration is `formatSegmentTotal` of the same total that the Export tooltip formats, so
 * the sentence and the tooltip show the same text in the same timecode format (ADR 028). An
 * unknown total shows the placeholder of the format.
 *
 * The file name is user data inside a translated sentence, so it is isolated (`isolateText`).
 * The shortening counts the clusters of the name only, not the isolation marks.
 *
 * Returns null with no open source or no segment. The export flow reports both before it
 * shows the setup step (ADR 024), so the step does not state an export that cannot run.
 */
export function presentExportSummarySentence(
  input: ExportSummaryInput,
): ExportSummarySentenceView | null {
  if (input.fileName === null || input.segmentCount <= 0) {
    return null;
  }
  const shown = truncateFileNameMiddle(input.fileName);
  return {
    key: "export.setup.summary",
    count: input.segmentCount,
    fileName: isolateText(shown),
    fullFileName: isolateText(input.fileName),
    shortened: shown !== input.fileName,
    title: input.fileName,
    duration: formatSegmentTotal(input.segmentTotal, input.display),
  };
}

/**
 * The probe facts of the open source that the preset summary reads for the "Same as Source"
 * values and for the audio note.
 */
export type PresetSummarySource = Pick<
  MediaProbe,
  "width" | "height" | "avgFrameRate" | "rFrameRate" | "audio"
>;

/** One group of the preset summary, under a heading. */
export type PresetSummaryGroupView = {
  id: "video" | "audio";
  headingKey: "settings.preset.groupVideo" | "settings.preset.groupAudio";
  rows: PresetSummaryRowView[];
  /** A line that the group shows in place of its rows, or absent. */
  noteKey?: string;
};

/** The preset summary of the setup step. */
export type PresetSummaryView = {
  /** The container of the output file. It belongs to neither group, so it comes first. */
  container: PresetSummaryRowView;
  /** The Video group, then the Audio group. */
  groups: PresetSummaryGroupView[];
};

function isPositiveSafeInteger(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function presentQualityRow(
  preset: Preset,
  formatter: Intl.NumberFormat,
): PresetSummaryRowView {
  let valueKey: string;
  switch (preset.quality.kind) {
    case "crf":
      valueKey = "export.setup.qualityCrf";
      break;
    case "bitrate":
      valueKey = "export.setup.qualityBitrate";
      break;
    case "qualityScale":
      valueKey = "export.setup.qualityScale";
      break;
  }
  return {
    id: "quality",
    labelKey: "export.setup.qualityLabel",
    valueKey,
    valueValues: { value: formatter.format(preset.quality.value) },
  };
}

function presentResolutionRow(
  preset: Preset,
  source: PresetSummarySource | null,
): PresetSummaryRowView {
  const labelKey = "settings.preset.resolutionLabel";
  // A frame size is a technical coordinate, not a counted quantity, so it keeps plain digits
  // with no group separator: 1920 × 1080, never 1,920 × 1,080.
  if (preset.resolution !== "source") {
    return {
      id: "resolution",
      labelKey,
      valueKey: "export.setup.resolutionValue",
      valueValues: {
        width: String(preset.resolution.w),
        height: String(preset.resolution.h),
      },
    };
  }
  if (
    source !== null &&
    isPositiveSafeInteger(source.width) &&
    isPositiveSafeInteger(source.height)
  ) {
    return {
      id: "resolution",
      labelKey,
      valueKey: "export.setup.sourceResolution",
      valueValues: { width: String(source.width), height: String(source.height) },
    };
  }
  return { id: "resolution", labelKey, valueKey: "settings.preset.sourceOption" };
}

function presentFrameRateRow(
  preset: Preset,
  source: PresetSummarySource | null,
  formatter: Intl.NumberFormat,
): PresetSummaryRowView {
  const labelKey = "settings.preset.frameRateLabel";
  if (preset.frameRate !== "source") {
    return {
      id: "frameRate",
      labelKey,
      valueKey: "export.setup.frameRateValue",
      valueValues: { value: formatFrameRate(preset.frameRate, formatter) },
    };
  }
  // The export writes a constant frame rate. For "source" it takes a valid avg_frame_rate
  // first and a valid r_frame_rate second, which is the rate the status bar shows (ADR 003).
  const rate = source === null ? null : getNominalFrameRate(source);
  if (rate !== null) {
    return {
      id: "frameRate",
      labelKey,
      valueKey: "export.setup.sourceFrameRate",
      valueValues: { value: formatFrameRate(rate, formatter) },
    };
  }
  return { id: "frameRate", labelKey, valueKey: "settings.preset.sourceOption" };
}

function presentAudioBitrateRow(
  preset: Preset,
  formatter: Intl.NumberFormat,
): PresetSummaryRowView {
  const labelKey = "settings.preset.audioBitrateLabel";
  // A lossless encoder has no bitrate. An absent bitrate uses the encoder default.
  if (isLosslessAudioEncoder(preset.audioEncoder)) {
    return {
      id: "audioBitrate",
      labelKey,
      valueKey: "export.setup.audioBitrateLossless",
    };
  }
  if (preset.audioBitrate === undefined) {
    return {
      id: "audioBitrate",
      labelKey,
      valueKey: "settings.preset.audioBitrateDefault",
    };
  }
  return {
    id: "audioBitrate",
    labelKey,
    valueKey: "settings.preset.audioBitrateValue",
    valueValues: { value: formatter.format(preset.audioBitrate) },
  };
}

function presentSampleRateRow(
  preset: Preset,
  source: PresetSummarySource | null,
  formatter: Intl.NumberFormat,
): PresetSummaryRowView {
  const labelKey = "settings.preset.audioSampleRateLabel";
  if (preset.audioSampleRate !== "source") {
    return {
      id: "audioSampleRate",
      labelKey,
      valueKey: "settings.preset.audioSampleRateValue",
      valueValues: {
        value: formatAudioSampleRateKHz(preset.audioSampleRate, formatter),
      },
    };
  }
  const sampleRate = source?.audio?.sampleRate;
  if (isPositiveSafeInteger(sampleRate)) {
    return {
      id: "audioSampleRate",
      labelKey,
      valueKey: "export.setup.sourceSampleRate",
      valueValues: { value: formatAudioSampleRateKHz(sampleRate, formatter) },
    };
  }
  return { id: "audioSampleRate", labelKey, valueKey: "settings.preset.sourceOption" };
}

function presentChannelsRow(
  preset: Preset,
  source: PresetSummarySource | null,
): PresetSummaryRowView {
  const labelKey = "settings.preset.audioChannelsLabel";
  switch (preset.audioChannels) {
    case "stereo":
      return {
        id: "audioChannels",
        labelKey,
        valueKey: "settings.preset.audioChannelsStereo",
      };
    case "mono":
      return {
        id: "audioChannels",
        labelKey,
        valueKey: "settings.preset.audioChannelsMono",
      };
    case "source": {
      // ffprobe reports a channel count and not a layout, so the value names the count.
      const channels = source?.audio?.channels;
      if (isPositiveSafeInteger(channels)) {
        return {
          id: "audioChannels",
          labelKey,
          valueKey: "export.setup.sourceChannels",
          valueValues: { count: channels },
        };
      }
      return {
        id: "audioChannels",
        labelKey,
        valueKey: "settings.preset.sourceOption",
      };
    }
  }
}

/**
 * Builds the preset summary of the setup step: the container, then a Video group and an Audio
 * group, in the order of the fields in the preset editor.
 *
 * - Video: the encoder, the quality, the resolution, and the frame rate.
 * - Audio: the encoder, the bitrate, the sample rate, and the channels.
 *
 * A "Same as Source" value also names the value of the open source, from the probe:
 * "Same as Source (1920 × 1080)", "Same as Source (29.97 fps)", "Same as Source (48 kHz)", or
 * "Same as Source (2 channels)". A value that the probe does not state shows only
 * "Same as Source". With no open source, every such value shows only "Same as Source".
 *
 * When the probe reports no audio stream, the export writes no audio. The Audio group then
 * shows a note in place of its rows.
 *
 * @param preset The selected preset.
 * @param formatter Formats numbers for the resolved interface language.
 * @param source The probe of the open source, or null with no source.
 */
export function presentPresetSummary(
  preset: Preset,
  formatter: Intl.NumberFormat,
  source: PresetSummarySource | null,
): PresetSummaryView {
  // Encoder names and the container are technical identifiers, passed through untranslated.
  const container: PresetSummaryRowView = {
    id: "container",
    labelKey: "settings.preset.containerLabel",
    valueKey: "export.setup.value",
    valueValues: { value: presentContainer(preset.container) },
  };

  const video: PresetSummaryGroupView = {
    id: "video",
    headingKey: "settings.preset.groupVideo",
    rows: [
      {
        id: "videoEncoder",
        labelKey: "settings.preset.videoEncoderLabel",
        valueKey: "export.setup.value",
        valueValues: { value: preset.videoEncoder },
      },
      presentQualityRow(preset, formatter),
      presentResolutionRow(preset, source),
      presentFrameRateRow(preset, source, formatter),
    ],
  };

  const audio: PresetSummaryGroupView =
    source !== null && source.audio === null
      ? {
          id: "audio",
          headingKey: "settings.preset.groupAudio",
          rows: [],
          noteKey: "export.setup.noSourceAudio",
        }
      : {
          id: "audio",
          headingKey: "settings.preset.groupAudio",
          rows: [
            {
              id: "audioEncoder",
              labelKey: "settings.preset.audioEncoderLabel",
              valueKey: "export.setup.value",
              valueValues: { value: preset.audioEncoder },
            },
            presentAudioBitrateRow(preset, formatter),
            presentSampleRateRow(preset, source, formatter),
            presentChannelsRow(preset, source),
          ],
        };

  return { container, groups: [video, audio] };
}

/**
 * Returns the exact total duration of the segments of the active source, in ticks of its video
 * time base: the sum of `outPts - inPts` of each segment (ADR 002). The segments of one source
 * share one time base, so their tick lengths can be added (ADR 007).
 *
 * This is the duration that the size estimate reads. It is not the total of the Export
 * tooltip: that total counts what the timecode shows, and in the frame format it counts
 * frames. A store selector can return the result, because a bigint compares by value.
 *
 * Returns 0 with no segment of the active source, or no active source. Returns null when a
 * segment of the active source has no valid range, because the duration is then not known.
 */
export function activeSourceDurationTicks(
  segments: readonly Segment[],
  activeSourceId: string | null | undefined,
): bigint | null {
  let ticks = 0n;
  for (const { segment } of getActiveSourceSegmentEntries(segments, activeSourceId)) {
    const length = segmentDurationTicks(segment.inPts, segment.outPts);
    if (length === null) {
      return null;
    }
    ticks += length;
  }
  return ticks;
}

/** An exact non-negative number of bytes, `num / den`. */
export type ExactBytes = {
  readonly num: bigint;
  readonly den: bigint;
};

/** The facts that the size estimate reads. */
export type ExportSizeInput = {
  /** The quality control and the audio settings of the selected preset. */
  readonly preset: Pick<Preset, "quality" | "audioEncoder" | "audioBitrate">;
  /** True when the open source has an audio stream, so the export writes audio. */
  readonly hasAudio: boolean;
  /**
   * The exact total duration of the segments in ticks of `videoTimeBase`, from
   * `activeSourceDurationTicks`. Null when it is not known.
   */
  readonly durationTicks: bigint | null;
  /** The video time base of the open source, or null with no source. */
  readonly videoTimeBase: Rational | null;
};

/**
 * Estimates the size of the output file, with exact BigInt arithmetic (ADR 002):
 * `(video bitrate + audio bitrate) × total duration`. A bitrate counts kilobits per second
 * (ADR 013), so the result is `kbps × 1000 / 8` bytes for each second.
 *
 * Only a preset in bitrate mode has an estimate. A CRF or a quality scale sets a quality and
 * not a size, so any number would be a guess. The estimate also needs the bitrate of every
 * stream the export writes: with an audio stream in the source, an audio encoder that is
 * lossless, or that uses its default bitrate, has no known bitrate, and the result is null.
 * A source with no audio stream adds no audio. The estimate leaves out the container overhead.
 *
 * Returns null when any input is not known, or when the duration is not positive.
 */
export function estimateExportBytes(input: ExportSizeInput): ExactBytes | null {
  const { preset, hasAudio, durationTicks, videoTimeBase } = input;
  if (preset.quality.kind !== "bitrate") {
    return null;
  }
  if (
    durationTicks === null ||
    durationTicks <= 0n ||
    videoTimeBase === null ||
    !isPositiveSafeInteger(videoTimeBase.n) ||
    !isPositiveSafeInteger(videoTimeBase.d)
  ) {
    return null;
  }
  const videoKbps = preset.quality.value;
  if (!isPositiveSafeInteger(videoKbps)) {
    return null;
  }
  let audioKbps = 0;
  if (hasAudio) {
    if (
      isLosslessAudioEncoder(preset.audioEncoder) ||
      !isPositiveSafeInteger(preset.audioBitrate)
    ) {
      return null;
    }
    audioKbps = preset.audioBitrate;
  }
  // bytes = (kbps × 1000 bits per second) × (ticks × n / d seconds) / 8 bits per byte
  return {
    num:
      (BigInt(videoKbps) + BigInt(audioKbps)) *
      1000n *
      durationTicks *
      BigInt(videoTimeBase.n),
    den: 8n * BigInt(videoTimeBase.d),
  };
}

/** A positive number rounded to a count of significant digits: `mantissa × 10^exponent`. */
export type SignificantValue = {
  /** A whole number with exactly the requested count of digits. */
  readonly mantissa: bigint;
  readonly exponent: number;
};

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/**
 * Rounds the positive exact value `num / den` to `digits` significant digits, with a half
 * rounded up, which for a positive value is away from zero (ADR 002). All arithmetic is exact.
 * A carry, as in 9.96 to 2 digits, moves to the next power of ten: `10 × 10^0`, never
 * `100 × 10^-1`.
 *
 * Returns null for a value that is not positive, or for a count of digits below 1.
 */
export function roundToSignificantDigits(
  num: bigint,
  den: bigint,
  digits: number,
): SignificantValue | null {
  if (num <= 0n || den <= 0n || !Number.isSafeInteger(digits) || digits < 1) {
    return null;
  }
  // The decimal exponent `e` of the leading digit, with 10^e <= num / den < 10^(e + 1). The
  // difference of the digit counts is `e` or `e + 1`.
  let magnitude = num.toString().length - den.toString().length;
  const atLeast = (e: number) =>
    e >= 0 ? num >= den * pow10(e) : num * pow10(-e) >= den;
  if (!atLeast(magnitude)) {
    magnitude -= 1;
  }
  let exponent = magnitude - (digits - 1);
  // mantissa = round(num / den / 10^exponent), with a half rounded up.
  const scaledNum = exponent >= 0 ? num : num * pow10(-exponent);
  const scaledDen = exponent >= 0 ? den * pow10(exponent) : den;
  let mantissa = (2n * scaledNum + scaledDen) / (2n * scaledDen);
  if (mantissa >= pow10(digits)) {
    mantissa /= 10n;
    exponent += 1;
  }
  return { mantissa, exponent };
}

/** The units of the size estimate, largest first, as `Intl` unit identifiers. */
const SIZE_UNITS = [
  { unit: "terabyte", power: 12 },
  { unit: "gigabyte", power: 9 },
  { unit: "megabyte", power: 6 },
  { unit: "kilobyte", power: 3 },
] as const;

/** The significant digits of the size estimate. */
export const SIZE_ESTIMATE_DIGITS = 2;

/** The smallest size that `formatEstimatedSize` formats, 1 kB. */
const ONE_KILOBYTE = 1000n;

/** True when an exact size is less than 1 kB (1000 bytes). The comparison is exact. */
export function isBelowOneKilobyte(bytes: ExactBytes): boolean {
  return bytes.num < ONE_KILOBYTE * bytes.den;
}

/**
 * Formats an estimated size with `SIZE_ESTIMATE_DIGITS` significant digits, in decimal units
 * of the size of the rounded value (kB, MB, GB or TB, 1 MB = 1,000,000 bytes), with the number
 * format and the unit name of the locale: "120 MB", "1.2 GB".
 *
 * The rounding comes first and is exact, so 999.6 MB shows "1 GB" and not "1,000 MB". Any
 * value below 1 MB shows in kB. Returns null for a value below 1 kB, which has its own message
 * (`presentSizeEstimate`), and for a value that is not positive.
 *
 * @param bytes The exact size in bytes.
 * @param locale The resolved interface language.
 */
export function formatEstimatedSize(bytes: ExactBytes, locale: string): string | null {
  if (isBelowOneKilobyte(bytes)) {
    return null;
  }
  const rounded = roundToSignificantDigits(bytes.num, bytes.den, SIZE_ESTIMATE_DIGITS);
  if (rounded === null) {
    return null;
  }
  const leading = rounded.exponent + SIZE_ESTIMATE_DIGITS - 1;
  const { unit, power } =
    SIZE_UNITS.find((candidate) => leading >= candidate.power) ??
    SIZE_UNITS[SIZE_UNITS.length - 1];
  const shift = rounded.exponent - power;
  // The mantissa has two digits, so each conversion to a double is exact or the nearest double
  // of a short decimal, and the format shows that decimal.
  const value =
    shift >= 0
      ? Number(rounded.mantissa * pow10(shift))
      : Number(rounded.mantissa) / 10 ** -shift;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumSignificantDigits: SIZE_ESTIMATE_DIGITS,
  }).format(value);
}

/** The estimated size line of the setup step. */
export type SizeEstimateView =
  | {
      readonly key: "export.setup.estimatedSize";
      readonly values: { readonly size: string };
    }
  | {
      readonly key: "export.setup.estimatedSizeBelowOneKilobyte";
      readonly values?: undefined;
    };

/**
 * Returns the line "Estimated size: about 120 MB", or null when the preset has no estimate.
 * An estimate below 1 kB shows "Estimated size: less than 1 kB", because two significant
 * digits of a fraction of a kilobyte, such as "0.0042 kB", tell the user nothing useful. See
 * `estimateExportBytes` for when an estimate exists and `formatEstimatedSize` for the
 * rounding.
 *
 * @param input The facts that the estimate reads.
 * @param formatter Formats numbers for the resolved interface language. Its locale formats
 *   the size.
 */
export function presentSizeEstimate(
  input: ExportSizeInput,
  formatter: Intl.NumberFormat,
): SizeEstimateView | null {
  const bytes = estimateExportBytes(input);
  if (bytes === null) {
    return null;
  }
  if (isBelowOneKilobyte(bytes)) {
    return { key: "export.setup.estimatedSizeBelowOneKilobyte" };
  }
  const size = formatEstimatedSize(bytes, formatter.resolvedOptions().locale);
  return size === null ? null : { key: "export.setup.estimatedSize", values: { size } };
}

/**
 * Checks whether an export blocker exists for the given preset.
 *
 * Returns `export.setup.noPresets` when no preset is selected or available.
 * Returns `settings.field.containerMismatch` when the preset pairs an incompatible container
 * and audio encoder (e.g. mov + flac, mov + libopus per ADR 023).
 * Otherwise returns `null`, indicating the setup step allows proceeding to file destination selection.
 */
export function presentSetupBlocker(preset: Preset | null): SetupBlockerView | null {
  if (preset === null) {
    return { key: "export.setup.noPresets" };
  }

  if (!isAudioEncoderAllowedIn(preset.container, preset.audioEncoder)) {
    return {
      key: "settings.field.containerMismatch",
      values: {
        container: presentContainer(preset.container),
        encoder: preset.audioEncoder,
      },
    };
  }

  return null;
}

/**
 * Display state for the export setup view step.
 */
export type ExportSetupStepState = "loading" | "error" | "empty" | "ready";

/**
 * Resolves the display state for the export setup step from the settings store state.
 *
 * - "loading": Settings document has not loaded yet and the store is not in error.
 * - "error": Settings document is absent and the store encountered an error loading.
 * - "empty": Settings document is loaded but contains zero presets.
 * - "ready": Settings document is loaded and has at least one preset.
 */
export function resolveExportSetupStepState(state: {
  settings: Settings | null;
  status: SettingsStatus;
  error?: SettingsError | null;
}): ExportSetupStepState {
  if (state.settings === null) {
    if (state.status === "error" || state.error) {
      return "error";
    }
    return "loading";
  }

  if (state.settings.presets.length === 0) {
    return "empty";
  }

  return "ready";
}

/**
 * Returns the settings section that the setup step opens when it cannot list a preset, or
 * null when it can.
 *
 * - "empty": the library holds no preset, and the Presets tab adds one.
 * - "error": the settings file did not load. The settings dialog shows the read error and
 *   its reset control above every tab, and the Presets tab holds what the export needs.
 * - "loading" and "ready" need no way out.
 */
export function presentSetupSettingsSection(
  state: ExportSetupStepState,
): SettingsSection | null {
  switch (state) {
    case "empty":
    case "error":
      return "presets";
    case "loading":
    case "ready":
      return null;
  }
}

/** One item of the preset select of the setup step. */
export type PresetOptionView = {
  id: string;
  /** The stored name. It is user data, so it is never translated (ADR 013). */
  name: string;
  /**
   * True for the default preset, which `activePresetId` names (ADR 024). The item and the
   * closed select then show the Default badge of the preset list.
   */
  isDefault: boolean;
  /** The line under the name: the same line as under the name of a preset list row. */
  summary: MessageView;
  /**
   * The encoder mark of the preset list row, or null when both encoders are known to work.
   * It does not block the export (ADR 024).
   */
  encoderMark: PresetEncoderMarkView | null;
};

/**
 * Presents the items of the preset select, in the order of the library.
 *
 * Each item carries what a row of the preset list in Settings shows: the name, the Default
 * badge, the summary line of `presentPresetRowSummary`, and the encoder mark of
 * `presentPresetEncoderMark`. The select and the list therefore describe a preset the same way.
 *
 * An `activePresetId` that names no preset marks no item. The step then selects the first
 * preset (`resolveSetupPresetId`), but that preset is not the default preset.
 */
export function presentPresetOptions(
  settings: Pick<Settings, "presets" | "activePresetId">,
  ffmpegState: Pick<FfmpegState, "status" | "results">,
  formatter: Intl.NumberFormat,
): PresetOptionView[] {
  return settings.presets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    isDefault: preset.id === settings.activePresetId,
    summary: presentPresetRowSummary(preset, formatter),
    encoderMark: presentPresetEncoderMark(ffmpegState, preset),
  }));
}
