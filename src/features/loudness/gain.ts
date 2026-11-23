/**
 * The gain that the Adjust switch fills, and the values after a gain (ADR 061, "The filled gain").
 *
 * Every value here is in tenths of a decibel and an integer, so a comparison never meets a
 * rounding error of the floating point. The only rounding is the first one: the true peak of the
 * meter, rounded up to a tenth.
 */

import {
  MAX_AUDIO_GAIN_TENTHS_DB,
  MIN_AUDIO_GAIN_TENTHS_DB,
} from "@/features/settings/limits";
import type { LoudnessValues } from "./types";

/** The ceiling of the true peak after the filled gain: -1.0 dBTP. */
export const TRUE_PEAK_CEILING_TENTHS = -10;

/**
 * The true peak `dbtp`, rounded up to a tenth of a decibel, in tenths: `P = ceil(TP × 10)`.
 * Null when the meter gives no true peak. A rounding error of the floating point can change the
 * result only when `dbtp × 10` is within about 1e-15 of an integer.
 */
export function truePeakTenths(dbtp: number | null): number | null {
  if (dbtp === null) {
    return null;
  }
  const tenths = Math.ceil(dbtp * 10);
  // `Math.ceil(-0.4)` is -0, which would show as "-0.0".
  return tenths === 0 ? 0 : tenths;
}

/**
 * The gain that the step fills after a measurement, in tenths: `G = min(0, -10 - P)`, and no
 * lower than the lowest gain of a preset. It only cuts. With no true peak, as for silence, it is
 * 0.
 */
export function filledGainTenths(dbtp: number | null): number {
  const peak = truePeakTenths(dbtp);
  if (peak === null) {
    return 0;
  }
  const gain = Math.min(0, TRUE_PEAK_CEILING_TENTHS - peak);
  return Math.max(MIN_AUDIO_GAIN_TENTHS_DB, gain);
}

/**
 * The tone of the After gain line: `normal` at or below -1.0 dBTP, `warning` above it and at or
 * below 0, `destructive` above 0. It compares the integer `P + gain`. With no true peak it is
 * `normal`.
 */
export type AfterGainTone = "normal" | "warning" | "destructive";

export function afterGainTone(
  peakTenths: number | null,
  gainTenths: number,
): AfterGainTone {
  if (peakTenths === null) {
    return "normal";
  }
  const after = peakTenths + gainTenths;
  if (after <= TRUE_PEAK_CEILING_TENTHS) {
    return "normal";
  }
  return after <= 0 ? "warning" : "destructive";
}

/** The values of the two lines under the Gain row, in tenths of a decibel. */
export interface LoudnessLines {
  /** The measured integrated loudness, rounded to a tenth, or null. */
  readonly measuredLoudnessTenths: number | null;
  /** The measured true peak, rounded up to a tenth, or null. */
  readonly measuredPeakTenths: number | null;
  /** The integrated loudness after the gain, rounded to a tenth, or null. */
  readonly afterLoudnessTenths: number | null;
  /** The true peak after the gain, `P + gain`, or null. */
  readonly afterPeakTenths: number | null;
  readonly tone: AfterGainTone;
}

/** Rounds a value in tenths to an integer, half away from zero, with no -0. */
function roundHalfAway(tenths: number): number {
  const rounded = Math.sign(tenths) * Math.round(Math.abs(tenths));
  return rounded === 0 ? 0 : rounded;
}

/** The values of the Measured line and of the After gain line, for the gain `gainTenths`. */
export function loudnessLines(
  values: LoudnessValues,
  gainTenths: number,
): LoudnessLines {
  const peak = truePeakTenths(values.truePeakDbtp);
  const loudness = values.integratedLufs;
  return {
    measuredLoudnessTenths: loudness === null ? null : roundHalfAway(loudness * 10),
    measuredPeakTenths: peak,
    // The gain is an integer of tenths, so it adds after the scale and before the one rounding.
    afterLoudnessTenths:
      loudness === null ? null : roundHalfAway(loudness * 10 + gainTenths),
    afterPeakTenths: peak === null ? null : peak + gainTenths,
    tone: afterGainTone(peak, gainTenths),
  };
}

/** True for a gain that the field may hold: an integer of tenths in the range of a preset. */
export function isValidGainTenths(tenths: number): boolean {
  return (
    Number.isSafeInteger(tenths) &&
    tenths >= MIN_AUDIO_GAIN_TENTHS_DB &&
    tenths <= MAX_AUDIO_GAIN_TENTHS_DB
  );
}
