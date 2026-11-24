/**
 * The text of a gain field, in decibels, as the tenths of a decibel that a preset stores (ADR 054).
 * The preset editor and the Gain field of the export setup step (ADR 061) read their text here.
 */

/**
 * Decimal text: an optional sign, digits with at most one decimal point, and an optional
 * exponent: "-1", ".5", "1.50", "1e1". It covers each value of a number input, and also forms such
 * as "1." and "+3" that `Number()` reads. Group 1 holds the digits before the point, group 2 the
 * digits after it, and group 3 the exponent. Text with no digit around the point is not decimal
 * text, and `decimalPlaces` checks that.
 */
const DECIMAL_PATTERN = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * The decimal places of the exact value of `text`, or null when `text` is not decimal text
 * (`DECIMAL_PATTERN`). The count comes from the digits, not from a binary number, so
 * "1.0000000000000001" has 16 places, although it reads as the number 1. A trailing zero adds no
 * place ("1.50" has one), and an exponent moves the point ("1e1" has none, "1e-2" has two).
 */
function decimalPlaces(text: string): number | null {
  const match = DECIMAL_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (whole === "" && fraction === "") {
    return null;
  }
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  // The value is the digits, read as a whole number, times 10 to the power of the exponent less
  // the length of the fraction. Each trailing zero of the digits raises that power by one.
  const digits = whole + fraction;
  const significant = digits.replace(/0+$/, "");
  if (significant === "") {
    return 0;
  }
  const trailingZeros = digits.length - significant.length;
  return Math.max(0, fraction.length - exponent - trailingZeros);
}

/**
 * Parses the text of the audio gain input, in decibels, into the tenths of a decibel that a
 * preset stores (ADR 054).
 *
 * Text whose exact value has at most one decimal place stores its integer tenths: "-1.5" stores
 * -15, and "1e1" stores 100. The product with 10 is rounded, because "-1.1" times 10 is not
 * exactly -11 in floating point. The decision reads the digits of the text (`decimalPlaces`), not
 * the number, so "1.000000000001" and "1.0000000000000001" are not rounded to 10. Such a value
 * too large for a number, such as "1e400", stores the largest number with its sign, a whole
 * number, so `audioGainIssue` reports it as out of range.
 *
 * Every other text stores `NaN`, which `audioGainIssue` reports as `oneDecimal`: blank text, text
 * with more decimal places, such as "-1.25", and text that is not decimal text
 * (`DECIMAL_PATTERN`), such as "abc" or "0x10". The stored number does not show in an input: the
 * preset editor and the export setup step each keep the text that the user typed.
 */
export function parseAudioGainField(raw: string): number {
  const text = raw.trim();
  const places = decimalPlaces(text);
  if (places === null || places > 1) {
    return Number.NaN;
  }
  const decibels = Number(text);
  const tenths = Math.round(decibels * 10);
  return Number.isFinite(tenths) ? tenths : Math.sign(decibels) * Number.MAX_VALUE;
}

/**
 * The text of a stored gain, in tenths of a decibel, for a gain input: "-1.5" for -15, or an
 * empty string for `NaN`. The preset editor shows it for a loaded draft, until the user types.
 * A stored gain is a whole number of tenths, and the division by 10 gives the number nearest to
 * its decimal text, so the text has at most one decimal place.
 */
export function formatAudioGainField(tenthsDb: number): string {
  return Number.isNaN(tenthsDb) ? "" : String(tenthsDb / 10);
}
