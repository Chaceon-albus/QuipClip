/**
 * Pure presenter for formatting export preset library models and issues for display.
 *
 * Implements view model derivations according to ADR 011 and ADR 013.
 * Returns translation keys and values without calling the i18n runtime.
 */

import type { CodecKind, FfmpegState } from "@/features/ffmpeg/types";
import type { PresetFieldIssue } from "@/features/settings/limits";
import type { Preset, PresetContainer, QualityKind } from "@/features/settings/types";
import {
  buildEncoderOptions,
  getEncoderAvailability,
  type EncoderOption,
} from "./encoderAvailability";
// The controller owns the one definition of this sentinel (guarded by a test in
// `presetLibraryController.test.ts` asserting it is never a valid encoder name). This module
// re-exports the same value so display code can import it alongside the other presenter
// exports without also reaching into the controller module.
import { CUSTOM_ENCODER_VALUE } from "./presetLibraryController";

export { MAX_PRESETS } from "@/features/settings/limits";
export { CUSTOM_ENCODER_VALUE };

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
  }

  if (issue.values) {
    return { key, values: issue.values };
  }
  return { key };
}

/**
 * Maps a whole `validatePresetFields` result to view models ready for the issues list,
 * attaching a stable, unique React key to each entry the same way `pushDetail` does for
 * `ffmpegStatusPresenter`'s detail entries.
 *
 * `validatePresetFields` reports at most one issue per field, so `field` and `code` alone would
 * already be unique in practice; the index is still folded in so this function has no hidden
 * assumption about that upstream invariant.
 */
export function presentPresetIssues(
  issues: PresetFieldIssue[],
): Array<{ id: string; key: string; values?: Record<string, string | number> }> {
  return issues.map((issue, index) => {
    const presented = presentPresetIssue(issue);
    const id = `${issue.field}-${issue.code}-${index}`;
    if (presented.values) {
      return { id, key: presented.key, values: presented.values };
    }
    return { id, key: presented.key };
  });
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

/**
 * Answers whether a keyboard event on a list row (e.g. a preset row acting as `role="button"`)
 * should activate that row, matching the native `<button>` activation keys.
 */
export function isActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}
