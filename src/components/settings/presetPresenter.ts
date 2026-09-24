/**
 * Pure presenter for formatting export preset library models and issues for display.
 *
 * Implements view model derivations according to ADR 011 and ADR 013.
 * Returns translation keys and values without calling the i18n runtime.
 */

import type { CodecKind, FfmpegState } from "@/features/ffmpeg/types";
import {
  AUDIO_SAMPLE_RATE_CHOICES,
  audioBitrateChoices,
  isLosslessAudioEncoder,
} from "@/features/settings/audioCodecs";
import {
  MAX_PRESETS,
  MAX_RESOLUTION_DIMENSION,
  MIN_RESOLUTION_DIMENSION,
  QUALITY_RANGES,
  validatePresetFields,
  type PresetFieldIssue,
  type PresetFieldName,
} from "@/features/settings/limits";
import {
  DEFAULT_CUSTOM_FRAME_RATE,
  DEFAULT_CUSTOM_RESOLUTION,
} from "@/features/settings/presetDocument";
import type {
  Preset,
  PresetAudioChannels,
  PresetAudioSampleRate,
  PresetContainer,
  QualityKind,
} from "@/features/settings/types";
import { isPresetContainer } from "@/features/settings/validation";
import {
  FRAME_RATE_CHOICES,
  OUTPUT_CUSTOM_VALUE,
  OUTPUT_SOURCE_VALUE,
  RESOLUTION_CHOICES,
} from "@/features/settings/videoOutputChoices";
import type { Rational, Resolution } from "@/types/project";
import {
  buildEncoderOptions,
  getEncoderAvailability,
  type EncoderOption,
} from "./encoderAvailability";
// The controller owns the one definition of this sentinel (guarded by a test in
// `presetLibraryController.test.ts` asserting it is never a valid encoder name). This module
// re-exports the same value so display code can import it alongside the other presenter
// exports without also reaching into the controller module.
import {
  CUSTOM_ENCODER_VALUE,
  type PresetLibraryView,
} from "./presetLibraryController";

export { CUSTOM_ENCODER_VALUE, MAX_PRESETS };

/** Sentinel value for the "encoder default" choice in an audio bitrate `<Select>`. */
export const AUDIO_BITRATE_DEFAULT_VALUE = "default";

export type MessageView = {
  key: string;
  values?: Record<string, string | number>;
};

export type EncoderTone = "warning" | "neutral";

export function presentPresetIssue(issue: PresetFieldIssue): MessageView {
  let key: string;
  switch (issue.code) {
    case "required":
      key = "settings.field.required";
      break;
    case "tooLong":
      key = "settings.field.tooLong";
      break;
    case "charset":
      key = "settings.field.charset";
      break;
    case "outOfRange":
      key = "settings.field.outOfRange";
      break;
    case "notInteger":
      key = "settings.field.notInteger";
      break;
    case "positive":
      key = "settings.field.positive";
      break;
    case "containerMismatch":
      key = "settings.field.containerMismatch";
      break;
  }

  if (issue.values) {
    if (
      issue.code === "containerMismatch" &&
      typeof issue.values.container === "string"
    ) {
      const rawContainer = issue.values.container;
      const formattedContainer = isPresetContainer(rawContainer)
        ? presentContainer(rawContainer)
        : rawContainer;
      return {
        key,
        values: {
          ...issue.values,
          container: formattedContainer,
        },
      };
    }
    return { key, values: issue.values };
  }
  return { key };
}

/**
 * A field of the preset editor that can show a validation message: each field that
 * `validatePresetFields` names, plus `container`. No issue names `container` as its field, but
 * a `containerMismatch` issue concerns it (see `issueTargets`).
 */
export type PresetIssueTarget = PresetFieldName | "container";

/**
 * The validation messages of a draft, grouped by the field that shows each one.
 *
 * `other` holds an issue that names no field of the editor, so that the editor still shows it
 * in one box below the fields. `validatePresetFields` names a known field in every issue it
 * makes, so `other` is empty unless a new field reaches the issues before the editor shows it.
 */
export type PresetIssueGroups = Record<PresetIssueTarget | "other", MessageView[]>;

/**
 * Every issue target, once. The `Record` type makes the compiler reject this object when a new
 * `PresetFieldName` is added and the editor has no place for its messages.
 */
const ISSUE_TARGETS: Record<PresetIssueTarget, true> = {
  name: true,
  container: true,
  videoEncoder: true,
  audioEncoder: true,
  audioBitrate: true,
  audioSampleRate: true,
  quality: true,
  resolution: true,
  frameRate: true,
};

function isIssueTarget(value: string): value is PresetIssueTarget {
  return Object.prototype.hasOwnProperty.call(ISSUE_TARGETS, value);
}

/**
 * The fields that show one issue.
 *
 * An issue shows under the field it names. A `containerMismatch` issue names the audio
 * encoder, but the conflict is between two fields: the container cannot hold that encoder. A
 * change to either field fixes it, so the issue also shows under `container`.
 */
function issueTargets(issue: PresetFieldIssue): PresetIssueTarget[] {
  const targets: PresetIssueTarget[] = [];
  if (isIssueTarget(issue.field)) {
    targets.push(issue.field);
  }
  if (issue.code === "containerMismatch" && !targets.includes("container")) {
    targets.push("container");
  }
  return targets;
}

/**
 * Groups a `validatePresetFields` result by the editor field that shows each message, so every
 * message appears at the control it is about (see `issueTargets`). An issue that names no known
 * field goes to `other`. The order of the issues stays the same inside each group.
 */
export function groupIssuesByField(
  issues: readonly PresetFieldIssue[],
): PresetIssueGroups {
  const groups: PresetIssueGroups = {
    name: [],
    container: [],
    videoEncoder: [],
    audioEncoder: [],
    audioBitrate: [],
    audioSampleRate: [],
    quality: [],
    resolution: [],
    frameRate: [],
    other: [],
  };
  for (const issue of issues) {
    const message = presentPresetIssue(issue);
    const targets = issueTargets(issue);
    if (targets.length === 0) {
      groups.other.push(message);
    }
    for (const target of targets) {
      groups[target].push(message);
    }
  }
  return groups;
}

/**
 * Presents the short line beside Save that says why Save is off, or `null` when the draft has
 * no issues.
 *
 * `count` is the number of issues, not the number of messages in `groupIssuesByField`: a
 * `containerMismatch` issue shows under two fields, but it is one problem to fix. The key is a
 * plural family, so i18next selects the form for the count in each language (ADR 011).
 */
export function presentSaveBlockedSummary(
  issues: readonly PresetFieldIssue[],
): MessageView | null {
  if (issues.length === 0) {
    return null;
  }
  return { key: "settings.preset.saveBlocked", values: { count: issues.length } };
}

/** The state of the Duplicate action of the preset library. */
export type DuplicatePresetActionView = {
  disabled: boolean;
  /**
   * Why Duplicate is off, or `null` when there is nothing to say. A write in flight disables
   * the action for a moment only, so it gives no reason.
   */
  reason: MessageView | null;
};

/**
 * Presents the Duplicate action of the preset library, an item of the menu under the preset
 * list (see `presentDuplicateSelectedAction`). It follows the rules of
 * `PresetLibraryController.duplicatePreset`, which refuses in the same states.
 *
 * - The library is full: the reason is the limit message that Add shows.
 * - The draft holds an unsaved edit: the reason asks the user to save or cancel it. The copy
 *   is made from the stored preset, so a copy made now would not contain the edit on screen,
 *   and the selection of the copy would discard the edit.
 * - A write is in flight: the action is off with no reason.
 */
export function presentDuplicatePresetAction(
  view: Pick<PresetLibraryView, "canAdd" | "dirty" | "pending">,
): DuplicatePresetActionView {
  if (!view.canAdd) {
    return {
      disabled: true,
      reason: { key: "settings.preset.limitReached", values: { max: MAX_PRESETS } },
    };
  }
  if (view.dirty) {
    return {
      disabled: true,
      reason: { key: "settings.preset.duplicateBlockedUnsaved" },
    };
  }
  return { disabled: view.pending, reason: null };
}

/**
 * Marks the two inputs of a pair field. When neither input fails alone, the pair fails only as
 * a whole, so both inputs are marked.
 */
function markPair(firstFails: boolean, secondFails: boolean): [boolean, boolean] {
  if (!firstFails && !secondFails) {
    return [true, true];
  }
  return [firstFails, secondFails];
}

/**
 * Answers which of the two custom resolution inputs a `resolution` issue is about, so that
 * only the input with the bad value is marked invalid.
 *
 * `validatePresetFields` reports one issue for the width and the height together. This function
 * validates each input again alone, with the other input set to its value in
 * `DEFAULT_CUSTOM_RESOLUTION`. The answer thus follows the validation rules and does not
 * repeat them. Returns `false` for both when there is no `resolution` issue.
 */
export function presentResolutionInvalid(
  draft: Preset,
  issues: readonly PresetFieldIssue[],
): { w: boolean; h: boolean } {
  if (
    draft.resolution === "source" ||
    !issues.some((issue) => issue.field === "resolution")
  ) {
    return { w: false, h: false };
  }
  const { w, h } = draft.resolution;
  const fails = (resolution: Resolution) =>
    validatePresetFields({ ...draft, resolution }).some(
      (issue) => issue.field === "resolution",
    );
  const [wFails, hFails] = markPair(
    fails({ w, h: DEFAULT_CUSTOM_RESOLUTION.h }),
    fails({ w: DEFAULT_CUSTOM_RESOLUTION.w, h }),
  );
  return { w: wFails, h: hFails };
}

/**
 * Answers which of the two custom frame rate inputs a `frameRate` issue is about. It works as
 * `presentResolutionInvalid` does, with `DEFAULT_CUSTOM_FRAME_RATE` for the other input.
 */
export function presentFrameRateInvalid(
  draft: Preset,
  issues: readonly PresetFieldIssue[],
): { n: boolean; d: boolean } {
  if (
    draft.frameRate === "source" ||
    !issues.some((issue) => issue.field === "frameRate")
  ) {
    return { n: false, d: false };
  }
  const { n, d } = draft.frameRate;
  const fails = (frameRate: Rational) =>
    validatePresetFields({ ...draft, frameRate }).some(
      (issue) => issue.field === "frameRate",
    );
  const [nFails, dFails] = markPair(
    fails({ n, d: DEFAULT_CUSTOM_FRAME_RATE.d }),
    fails({ n: DEFAULT_CUSTOM_FRAME_RATE.n, d }),
  );
  return { n: nFails, d: dFails };
}

/**
 * Joins the ids of the elements that describe a control into one `aria-describedby` value.
 * Skips each id that is absent, and returns `undefined` when none is left, so the attribute
 * does not render at all.
 */
export function joinDescribedBy(
  ...ids: ReadonlyArray<string | false | null | undefined>
): string | undefined {
  const present = ids.filter((id): id is string => typeof id === "string" && id !== "");
  return present.length > 0 ? present.join(" ") : undefined;
}

/** An encoder option that carries a reason: every availability except "available". */
type ReasonedEncoderOption = Extract<
  EncoderOption,
  { availability: "unavailable" | "unknown" }
>;

/**
 * Maps the reason of a non-available encoder option to its message key and its tone.
 *
 * An "unavailable" reason is a verdict the probe reached, so it reads as a warning. An
 * "unknown" reason is the ABSENCE of a verdict, so it reads as neutral: nothing failed.
 */
function presentEncoderReason(option: ReasonedEncoderOption): {
  reasonKey: string;
  tone: EncoderTone;
} {
  switch (option.reason) {
    case "notListed":
      return { reasonKey: "settings.encoder.reasonNotListed", tone: "warning" };
    case "failed":
      return { reasonKey: "settings.encoder.reasonFailed", tone: "warning" };
    case "timedOut":
      return { reasonKey: "settings.encoder.reasonTimedOut", tone: "warning" };
    case "notTested":
      return { reasonKey: "settings.encoder.reasonNotTested", tone: "neutral" };
    case "notProbed":
      return { reasonKey: "settings.encoder.reasonNotProbed", tone: "neutral" };
  }
}

/**
 * Maps an encoder availability to the key of its short badge word, plus the reason line and
 * the tone of that line. An available option has neither: there is nothing to explain.
 */
export function presentEncoderOption(option: EncoderOption): {
  availabilityKey: string;
  reasonKey?: string;
  tone?: EncoderTone;
} {
  let availabilityKey: string;
  switch (option.availability) {
    case "available":
      availabilityKey = "settings.encoder.available";
      break;
    case "unavailable":
      availabilityKey = "settings.encoder.unavailable";
      break;
    case "unknown":
      availabilityKey = "settings.encoder.unknown";
      break;
  }

  if (option.availability === "available") {
    return { availabilityKey };
  }

  const { reasonKey, tone } = presentEncoderReason(option);
  return { availabilityKey, reasonKey, tone };
}

/** View model for one entry in an encoder `<Select>`, including the appended custom option. */
export type EncoderOptionView = {
  value: string;
  /**
   * The key of one COMPLETE message. Each availability has its own key holding the whole
   * label, so the component never assembles a sentence from translated fragments (ADR 011);
   * a translator moves the parenthesis, drops it, or reorders the words per language.
   */
  labelKey: string;
  /** Interpolation values for `labelKey`. The encoder name is never translated. */
  labelValues: { name: string };
};

/**
 * Maps an encoder availability to the key of the complete `<Select>` option label for it.
 */
function presentEncoderOptionLabelKey(option: EncoderOption): string {
  switch (option.availability) {
    case "available":
      return "settings.encoder.optionLabelAvailable";
    case "unavailable":
      return "settings.encoder.optionLabelUnavailable";
    case "unknown":
      return "settings.encoder.optionLabelUnknown";
  }
}

/**
 * Builds the encoder `<Select>` options for `kind`, plus the reason line for the currently
 * selected encoder when it is unavailable or unknown with a reason.
 *
 * Appends one final option for the "custom encoder name" sentinel. That option's label needs no
 * interpolation (`settings.preset.customOption` holds no placeholders), so its `name` is the empty
 * string -- present only to satisfy `EncoderOptionView`'s shape, never read by the template.
 */
export function presentEncoderSelect(
  state: Pick<FfmpegState, "status" | "results">,
  kind: CodecKind,
  currentValue: string,
): {
  options: EncoderOptionView[];
  currentReasonKey?: string;
  currentReasonTone?: EncoderTone;
} {
  const rawOptions = buildEncoderOptions(state, kind, currentValue);

  const options: EncoderOptionView[] = rawOptions.map((option) => ({
    value: option.name,
    labelKey: presentEncoderOptionLabelKey(option),
    labelValues: { name: option.name },
  }));

  options.push({
    value: CUSTOM_ENCODER_VALUE,
    labelKey: "settings.preset.customOption",
    labelValues: { name: "" },
  });

  const currentOption = rawOptions.find((option) => option.name === currentValue);
  const currentPresented = currentOption
    ? presentEncoderOption(currentOption)
    : undefined;

  if (currentPresented?.reasonKey) {
    return {
      options,
      currentReasonKey: currentPresented.reasonKey,
      currentReasonTone: currentPresented.tone,
    };
  }
  return { options };
}

/** The one badge a preset row shows when an encoder it names is not known to work. */
export type PresetEncoderMarkView = {
  encoderName: string;
  availability: "unavailable" | "unknown";
  tone: EncoderTone;
  /** The short word inside the badge, and part of the row's accessible name. */
  badgeKey: string;
  titleKey: string;
  titleValues: { name: string };
  /** The full explanation, for the badge's tooltip. */
  reasonKey: string;
};

/**
 * Presents the encoder mark for one preset row in the library list, so a preset naming an
 * encoder this machine cannot use is visible without opening it (ADR 013).
 *
 * Reports ONE encoder not known to work, so a row keeps one badge on one line. Orders the two
 * slots by severity first and by slot second: an "unavailable" verdict the probe actually
 * reached wins over an "unknown" in either slot, because a neutral badge naming the encoder
 * nothing is known about would hide the encoder that will really fail. Video before audio
 * decides a tie inside one severity. Returns `null` when both encoders are known to work.
 *
 * Ignores a `notProbed` reason. That reason says no report exists YET, so it holds for every
 * encoder name at once: marking on it puts a badge on every row while the probe runs, and on
 * every row for as long as ffmpeg is missing, which restates what the capability block above the
 * list already says once. The badge exists to make ONE preset stand out, so it only speaks about
 * a preset in particular. The editor's reason line still shows `notProbed`, where it answers a
 * question the user asked by opening that preset.
 */
export function presentPresetEncoderMark(
  state: Pick<FfmpegState, "status" | "results">,
  preset: Pick<Preset, "videoEncoder" | "audioEncoder">,
): PresetEncoderMarkView | null {
  const video = getEncoderAvailability(state, preset.videoEncoder);
  const audio = getEncoderAvailability(state, preset.audioEncoder);

  const both = [video, audio].filter(
    (option): option is ReasonedEncoderOption =>
      option.availability !== "available" && option.reason !== "notProbed",
  );

  const target =
    both.find((option) => option.availability === "unavailable") ??
    both.find((option) => option.availability === "unknown");

  if (!target) {
    return null;
  }

  const { reasonKey, tone } = presentEncoderReason(target);

  return {
    encoderName: target.name,
    availability: target.availability,
    tone,
    badgeKey: presentEncoderOption(target).availabilityKey,
    titleKey: "settings.preset.encoderMarkTitle",
    titleValues: { name: target.name },
    reasonKey,
  };
}

export function presentQualityKind(kind: QualityKind): string {
  switch (kind) {
    case "crf":
      return "settings.quality.crf";
    case "bitrate":
      return "settings.quality.bitrate";
    case "qualityScale":
      return "settings.quality.qualityScale";
  }
}

export function presentContainer(container: PresetContainer): string {
  switch (container) {
    case "mp4":
      return "MP4";
    case "mov":
      return "MOV";
    case "mkv":
      return "MKV";
  }
}

/**
 * Presents the one-line summary of a preset: the container, the video encoder, and the
 * quality, such as "MP4 · libx264 · CRF 20".
 *
 * Two places show it under the preset name: a row of the preset list in Settings, and an item
 * of the preset select in the export setup step. Both call this function, so the two lines
 * always agree.
 *
 * The encoder is the stored name, verbatim. The line does not ask the capability probe about
 * it, so an encoder that this machine does not have, or a custom name, shows the same as any
 * other name. The encoder mark beside the line reports whether the encoder works (ADR 013).
 *
 * The quality kind selects one of three complete messages, because each kind puts its unit in
 * a different place.
 */
export function presentPresetRowSummary(
  preset: Pick<Preset, "container" | "videoEncoder" | "quality">,
  formatter: Intl.NumberFormat,
): MessageView {
  const values = {
    container: presentContainer(preset.container),
    encoder: preset.videoEncoder,
    value: formatter.format(preset.quality.value),
  };
  switch (preset.quality.kind) {
    case "crf":
      return { key: "settings.preset.rowSummaryCrf", values };
    case "bitrate":
      return { key: "settings.preset.rowSummaryBitrate", values };
    case "qualityScale":
      return { key: "settings.preset.rowSummaryQualityScale", values };
  }
}

/**
 * Renders a numeric draft field (quality value, resolution width/height, frame rate numerator
 * or denominator) for a controlled `<Input>`.
 *
 * The controller stores `NaN` for a blank or non-integer field (see
 * `PresetLibraryController`'s `parseNumericField`) so `validatePresetFields` can report
 * `notInteger` on it. Rendering `NaN` directly would print the literal text "NaN" in the input;
 * this maps it back to an empty string instead.
 */
export function presentNumericField(value: number): string {
  return Number.isNaN(value) ? "" : String(value);
}

/** View model for one entry in an audio bitrate `<Select>`. */
export type AudioBitrateOptionView = {
  value: string;
  labelKey: string;
  labelValues?: { value: string };
};

/** View model for the audio bitrate `<Select>`. */
export type AudioBitrateSelectView = {
  options: AudioBitrateOptionView[];
  disabled: boolean;
  hintKey?: string;
};

/**
 * Maps an audio bitrate (in kbps, or undefined for encoder default) to its `<Select>` value string.
 */
export function presentAudioBitrateValue(bitrate: number | undefined): string {
  return bitrate === undefined ? AUDIO_BITRATE_DEFAULT_VALUE : String(bitrate);
}

/**
 * Parses an audio bitrate `<Select>` value string back into a numeric kbps value, or null for encoder default.
 */
export function parseAudioBitrateValue(value: string): number | null {
  return value === AUDIO_BITRATE_DEFAULT_VALUE ? null : Number(value);
}

/**
 * Builds the options and disabled state for the audio bitrate `<Select>`.
 *
 * For lossless encoders (e.g. FLAC, ALAC), the select is disabled only when no bitrate is
 * stored. If a lossless preset already stores a bitrate (e.g. from hand-editing), the select
 * remains enabled so the user can choose "Encoder Default" to clear it. In both cases, a
 * localized hint explains that lossless encoders do not use a bitrate setting.
 */
export function presentAudioBitrateSelect(
  encoder: string,
  currentBitrate: number | undefined,
  formatter: Intl.NumberFormat,
): AudioBitrateSelectView {
  const lossless = isLosslessAudioEncoder(encoder);
  const choices = audioBitrateChoices(encoder);

  const options: AudioBitrateOptionView[] = [
    {
      value: AUDIO_BITRATE_DEFAULT_VALUE,
      labelKey: "settings.preset.audioBitrateDefault",
    },
  ];

  const choiceList = [...choices];
  if (currentBitrate !== undefined && !choiceList.includes(currentBitrate)) {
    choiceList.push(currentBitrate);
  }

  for (const choice of choiceList) {
    options.push({
      value: String(choice),
      labelKey: "settings.preset.audioBitrateValue",
      labelValues: { value: formatter.format(choice) },
    });
  }

  if (lossless) {
    return {
      options,
      disabled: currentBitrate === undefined,
      hintKey: "settings.preset.audioBitrateLossless",
    };
  }

  return {
    options,
    disabled: false,
  };
}

/**
 * Maps a preset audio sample rate ("source" or frequency in Hz) to its `<Select>` value string.
 */
export function presentAudioSampleRateValue(sampleRate: PresetAudioSampleRate): string {
  return String(sampleRate);
}

/**
 * Parses an audio sample rate `<Select>` value string back into a `PresetAudioSampleRate` ("source" or numeric Hz).
 */
export function parseAudioSampleRateValue(value: string): PresetAudioSampleRate {
  return value === "source" ? "source" : Number(value);
}

/** View model for one entry in an audio sample rate `<Select>`. */
export type AudioSampleRateOptionView = {
  value: string;
  labelKey: string;
  labelValues?: { value: string };
};

/** View model for the audio sample rate `<Select>`. */
export type AudioSampleRateSelectView = {
  options: AudioSampleRateOptionView[];
};

/**
 * Formats an audio sample rate in Hz to a localized kHz string (e.g. 48000 -> "48", 44100 -> "44.1").
 */
export function formatAudioSampleRateKHz(
  sampleRateHz: number,
  formatter: Intl.NumberFormat,
): string {
  return formatter.format(sampleRateHz / 1000);
}

/**
 * Builds the options for the audio sample rate `<Select>`.
 *
 * Displays "Same as Source" followed by standard sample rates in kHz (e.g. 44.1 kHz, 48 kHz).
 * If the current stored value is not in the standard list, it is preserved as an additional option.
 */
export function presentAudioSampleRateSelect(
  currentSampleRate: PresetAudioSampleRate,
  formatter: Intl.NumberFormat,
): AudioSampleRateSelectView {
  const options: AudioSampleRateOptionView[] = [
    {
      value: "source",
      labelKey: "settings.preset.sourceOption",
    },
  ];

  const choices: number[] = [...AUDIO_SAMPLE_RATE_CHOICES];
  if (typeof currentSampleRate === "number" && !choices.includes(currentSampleRate)) {
    choices.push(currentSampleRate);
  }

  for (const rate of choices) {
    options.push({
      value: String(rate),
      labelKey: "settings.preset.audioSampleRateValue",
      labelValues: { value: formatAudioSampleRateKHz(rate, formatter) },
    });
  }

  return { options };
}

/** View model for one entry in an audio channels `<Select>`. */
export type AudioChannelsOptionView = {
  value: PresetAudioChannels;
  labelKey: string;
};

/** View model for the audio channels `<Select>`. */
export type AudioChannelsSelectView = {
  options: AudioChannelsOptionView[];
};

/**
 * Builds the options for the audio channels `<Select>` ("source", "stereo", "mono").
 */
export function presentAudioChannelsSelect(): AudioChannelsSelectView {
  return {
    options: [
      { value: "source", labelKey: "settings.preset.sourceOption" },
      { value: "stereo", labelKey: "settings.preset.audioChannelsStereo" },
      { value: "mono", labelKey: "settings.preset.audioChannelsMono" },
    ],
  };
}

/** View model for one entry in the resolution or the frame rate `<Select>`. */
export type VideoOutputOptionView = {
  value: string;
  labelKey: string;
  labelValues?: Record<string, string>;
};

/** View model for the resolution or the frame rate `<Select>`. */
export type VideoOutputSelectView = {
  options: VideoOutputOptionView[];
};

/**
 * Builds the options for the frame rate `<Select>`: "Same as Source", each of the
 * `FRAME_RATE_CHOICES`, and "Custom…" last.
 *
 * A choice shows its conventional name, such as 23.976 for 24000/1001, in the number format of
 * the locale. The value of `PresetLibraryView.frameRateChoice` is always one of these values.
 */
export function presentFrameRateSelect(
  formatter: Intl.NumberFormat,
): VideoOutputSelectView {
  return {
    options: [
      { value: OUTPUT_SOURCE_VALUE, labelKey: "settings.preset.sourceOption" },
      ...FRAME_RATE_CHOICES.map((choice) => ({
        value: choice.value,
        labelKey: "settings.preset.frameRateValue",
        labelValues: { value: formatter.format(choice.nominal) },
      })),
      { value: OUTPUT_CUSTOM_VALUE, labelKey: "settings.preset.customOption" },
    ],
  };
}

/**
 * Builds the options for the resolution `<Select>`: "Same as Source", each of the
 * `RESOLUTION_CHOICES`, and "Custom…" last.
 *
 * The width and the height are pixel counts, so they show as plain digits with no group
 * separator. The value of `PresetLibraryView.resolutionChoice` is always one of these values.
 */
export function presentResolutionSelect(): VideoOutputSelectView {
  return {
    options: [
      { value: OUTPUT_SOURCE_VALUE, labelKey: "settings.preset.sourceOption" },
      ...RESOLUTION_CHOICES.map((choice) => ({
        value: choice.value,
        labelKey: "settings.preset.resolutionValue",
        labelValues: { w: String(choice.size.w), h: String(choice.size.h) },
      })),
      { value: OUTPUT_CUSTOM_VALUE, labelKey: "settings.preset.customOption" },
    ],
  };
}

/**
 * The native attributes and the unit of one number input in the preset editor.
 *
 * `min`, `max`, and `step` come from the limits of ADR 013. They set the range of the arrow
 * keys and of the spin buttons. They do not replace `validatePresetFields`, because a user can
 * still type any value.
 */
export type NumberInputView = {
  min: number;
  /** Absent when the only upper bound is the safe integer range. */
  max?: number;
  step: number;
  /** The key of the unit inside the field, on the right. Absent when the value has no unit. */
  unitKey?: string;
};

/** The quality value input: its number attributes and the one-line hint under it. */
export type QualityValueInputView = NumberInputView & {
  hintKey: string;
};

/**
 * Presents the quality value input for a quality kind. The range is `QUALITY_RANGES` for the
 * kind. Only `bitrate` has a unit, because it counts kilobits per second.
 */
export function presentQualityValueInput(kind: QualityKind): QualityValueInputView {
  const { min, max } = QUALITY_RANGES[kind];
  switch (kind) {
    case "crf":
      return { min, max, step: 1, hintKey: "settings.preset.qualityHintCrf" };
    case "bitrate":
      return {
        min,
        max,
        step: 1,
        unitKey: "settings.preset.unitKbps",
        hintKey: "settings.preset.qualityHintBitrate",
      };
    case "qualityScale":
      return { min, max, step: 1, hintKey: "settings.preset.qualityHintQualityScale" };
  }
}

/** Presents the custom width input and the custom height input. */
export function presentResolutionInput(): NumberInputView {
  return {
    min: MIN_RESOLUTION_DIMENSION,
    max: MAX_RESOLUTION_DIMENSION,
    step: 1,
    unitKey: "settings.preset.unitPixels",
  };
}

/**
 * Presents the custom numerator input and the custom denominator input.
 *
 * `validatePresetFields` refuses a term below 1 (`positive`) and a term outside the safe
 * integer range (`notInteger`). The first rule gives `min`. The second gives no useful `max`.
 */
export function presentFrameRateTermInput(): NumberInputView {
  return { min: 1, step: 1 };
}
