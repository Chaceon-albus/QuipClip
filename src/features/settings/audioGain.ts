/**
 * The text of a gain field, in decibels, as the tenths of a decibel that a preset stores (ADR 054).
 * The preset editor and the Gain field of the export setup step (ADR 061) read their text here.
 */

/**
 * Decimal text with at most one significant decimal place: "-1", "-1.5", ".5", "1.", or "1.50".
 * Trailing zeros add no precision.
 */
const ONE_DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d?0*)?|\.\d0*)$/;

/**
 * Parses the text of the audio gain input, in decibels, into the tenths of a decibel that a
 * preset stores (ADR 054).
 *
 * Blank or non-numeric text stores `NaN`, for the reason that `parseNumericField` of the preset
 * editor gives. Text with at
 * most one decimal place (`ONE_DECIMAL_PATTERN`) stores its integer tenths: "-1.5" stores -15.
 * The product with 10 is rounded, because "-1.1" times 10 is not exactly -11 in floating point.
 * The decision reads the text, not the number, so "1.000000000001" is not rounded to 10. Other
 * text stores the product without rounding, such as -12.5 for "-1.25", so `validatePresetFields`
 * reports `oneDecimal` and the input still shows the text the user typed
 * (`presentAudioGainField`).
 */
export function parseAudioGainField(raw: string): number {
  const text = raw.trim();
  if (text === "") {
    return Number.NaN;
  }
  const decibels = Number(text);
  if (!Number.isFinite(decibels)) {
    return Number.NaN;
  }
  return ONE_DECIMAL_PATTERN.test(text) ? Math.round(decibels * 10) : decibels * 10;
}
