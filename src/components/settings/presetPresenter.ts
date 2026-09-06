/**
 * Pure presenter for formatting export preset library models and issues for display.
 *
 * Implements view model derivations according to ADR 011 and ADR 013.
 * Returns translation keys and values without calling the i18n runtime.
 */

import type { CodecKind, FfmpegState } from "@/features/ffmpeg/types";
import type { PresetFieldIssue } from "@/features/settings/limits";
import type { PresetContainer, QualityKind } from "@/features/settings/types";
import { buildEncoderOptions, type EncoderOption } from "./encoderAvailability";
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

export function presentEncoderOption(option: EncoderOption): {
  availabilityKey: string;
  reasonKey?: string;
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

  if (!option.reason) {
    return { availabilityKey };
  }

  let reasonKey: string;
  switch (option.reason) {
    case "notListed":
      reasonKey = "settings.encoder.reasonNotListed";
      break;
    case "failed":
      reasonKey = "settings.encoder.reasonFailed";
      break;
    case "timedOut":
      reasonKey = "settings.encoder.reasonTimedOut";
      break;
  }

  return { availabilityKey, reasonKey };
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
 * selected encoder when it is unavailable with a reason.
 *
 * Appends one final option for the "custom encoder name" sentinel. That option's label needs no
 * interpolation (`settings.preset.customOption` holds no placeholders), so its `name` is the empty
 * string -- present only to satisfy `EncoderOptionView`'s shape, never read by the template.
 */
export function presentEncoderSelect(
  state: Pick<FfmpegState, "status" | "results">,
  kind: CodecKind,
  currentValue: string,
): { options: EncoderOptionView[]; currentReasonKey?: string } {
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
  const currentReasonKey = currentOption
    ? presentEncoderOption(currentOption).reasonKey
    : undefined;

  if (currentReasonKey) {
    return { options, currentReasonKey };
  }
  return { options };
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
