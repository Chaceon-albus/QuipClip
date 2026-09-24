/**
 * The fixed frame rate and resolution choices of the preset editor, and the mapping between a
 * stored preset setting and the value of its `<Select>`.
 *
 * Each frame rate choice holds an exact rational (ADR 002). A drop-frame rate such as 29.97 is
 * 30000/1001, never the decimal 2997/100. A stored rate matches a choice when the two are equal
 * as fractions, so 48/2 selects 24. A stored setting that matches no choice selects "custom".
 *
 * Pure module with no React and no i18next dependencies.
 */

import { rationalsEqual } from "@/lib/time";
import type { Rational, Resolution } from "@/types/project";

import type { PresetFrameRate, PresetResolution } from "./types";

/** The `<Select>` value of "Same as source". It is the stored word "source" itself. */
export const OUTPUT_SOURCE_VALUE = "source";

/** The `<Select>` value of "Custom…", which opens the number inputs. */
export const OUTPUT_CUSTOM_VALUE = "custom";

/** One fixed frame rate in the preset editor. */
export type FrameRateChoice = {
  /** The `<Select>` value. It is the rate as `n/d`, so it never equals a sentinel value. */
  readonly value: string;
  /** The exact rate that the choice writes to the preset. */
  readonly rate: Readonly<Rational>;
  /**
   * The conventional name of the rate, for the label only. 23.976 is not the exact value of
   * 24000/1001, so nothing computes with this number.
   */
  readonly nominal: number;
};

/** The fixed frame rates, in the order that the `<Select>` lists them. */
export const FRAME_RATE_CHOICES: readonly FrameRateChoice[] = [
  { value: "24000/1001", rate: { n: 24000, d: 1001 }, nominal: 23.976 },
  { value: "24/1", rate: { n: 24, d: 1 }, nominal: 24 },
  { value: "25/1", rate: { n: 25, d: 1 }, nominal: 25 },
  { value: "30000/1001", rate: { n: 30000, d: 1001 }, nominal: 29.97 },
  { value: "30/1", rate: { n: 30, d: 1 }, nominal: 30 },
  { value: "50/1", rate: { n: 50, d: 1 }, nominal: 50 },
  { value: "60000/1001", rate: { n: 60000, d: 1001 }, nominal: 59.94 },
  { value: "60/1", rate: { n: 60, d: 1 }, nominal: 60 },
];

/** One fixed output resolution in the preset editor. */
export type ResolutionChoice = {
  /** The `<Select>` value. It is the size as `WxH`, so it never equals a sentinel value. */
  readonly value: string;
  /** The exact size in pixels that the choice writes to the preset. */
  readonly size: Readonly<Resolution>;
};

/** The fixed resolutions, in the order that the `<Select>` lists them. */
export const RESOLUTION_CHOICES: readonly ResolutionChoice[] = [
  { value: "3840x2160", size: { w: 3840, h: 2160 } },
  { value: "2560x1440", size: { w: 2560, h: 1440 } },
  { value: "1920x1080", size: { w: 1920, h: 1080 } },
  { value: "1280x720", size: { w: 1280, h: 720 } },
];

/**
 * Answers whether a stored rate is a valid, positive rational that can match a choice. A rate
 * that `validatePresetFields` refuses (NaN, a fraction, zero, or a negative term) never
 * matches, so the editor keeps it in the custom inputs, where its message shows. This also
 * keeps -24/-1 from matching 24/1: the two are equal as fractions, but the stored terms are
 * not valid.
 */
function isPositiveRational(rate: Rational): boolean {
  return (
    Number.isSafeInteger(rate.n) &&
    Number.isSafeInteger(rate.d) &&
    rate.n > 0 &&
    rate.d > 0
  );
}

/**
 * Returns the `<Select>` value for a stored frame rate: `OUTPUT_SOURCE_VALUE` for "source", the
 * value of the choice that equals the rate as a fraction, or `OUTPUT_CUSTOM_VALUE` when no
 * choice matches.
 */
export function frameRateChoiceValue(frameRate: PresetFrameRate): string {
  if (frameRate === "source") {
    return OUTPUT_SOURCE_VALUE;
  }
  if (!isPositiveRational(frameRate)) {
    return OUTPUT_CUSTOM_VALUE;
  }
  const choice = FRAME_RATE_CHOICES.find((candidate) =>
    rationalsEqual(candidate.rate, frameRate),
  );
  return choice?.value ?? OUTPUT_CUSTOM_VALUE;
}

/**
 * Returns the frame rate that a `<Select>` value writes: "source", or a NEW copy of the exact
 * rate of the choice. Returns `null` for `OUTPUT_CUSTOM_VALUE` and for an unknown value,
 * because neither names a rate.
 */
export function frameRateFromChoice(value: string): PresetFrameRate | null {
  if (value === OUTPUT_SOURCE_VALUE) {
    return "source";
  }
  const choice = FRAME_RATE_CHOICES.find((candidate) => candidate.value === value);
  return choice ? { n: choice.rate.n, d: choice.rate.d } : null;
}

/**
 * Returns the `<Select>` value for a stored resolution: `OUTPUT_SOURCE_VALUE` for "source", the
 * value of the choice with the same width and height, or `OUTPUT_CUSTOM_VALUE` when no choice
 * matches. A size in pixels has no other form, so the comparison is exact.
 */
export function resolutionChoiceValue(resolution: PresetResolution): string {
  if (resolution === "source") {
    return OUTPUT_SOURCE_VALUE;
  }
  const choice = RESOLUTION_CHOICES.find(
    (candidate) =>
      candidate.size.w === resolution.w && candidate.size.h === resolution.h,
  );
  return choice?.value ?? OUTPUT_CUSTOM_VALUE;
}

/**
 * Returns the resolution that a `<Select>` value writes: "source", or a NEW copy of the size of
 * the choice. Returns `null` for `OUTPUT_CUSTOM_VALUE` and for an unknown value.
 */
export function resolutionFromChoice(value: string): PresetResolution | null {
  if (value === OUTPUT_SOURCE_VALUE) {
    return "source";
  }
  const choice = RESOLUTION_CHOICES.find((candidate) => candidate.value === value);
  return choice ? { w: choice.size.w, h: choice.size.h } : null;
}
