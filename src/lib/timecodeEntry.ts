/**
 * Parses a time that the user types in the preview timecode to move the playhead, in the
 * timecode format of the source (ADR 028). The rules follow the timecode entry of Premiere Pro,
 * DaVinci Resolve, Final Cut Pro and Avid.
 *
 * The frame format, `HH:MM:SS:FF`:
 *
 * - Fields with `:` between them. Missing leading fields are zero: `5:12` is `00:00:05:12`.
 * - Digits only are right-aligned fields, as in Premiere Pro and Final Cut Pro: the last two
 *   digits are `FF` (three at a rate above 100 fps), the two before are `SS`, then `MM`, and the
 *   rest is `HH`. `1012` is `00:00:10:12`, `112` is `00:00:01:12`, and `12` is frame 12.
 * - A `.` in a run of digits fills the field that it lands in with zeros, as in Final Cut Pro
 *   and DaVinci Resolve, where it stands for `00`. The digits count from the right, and a `.`
 *   gives as many zeros as its field has digits: three for `FF` above 100 fps, two for the other
 *   fields. `3.` is `00:00:03:00`, `3...` is `03:00:00:00`, and `1.20` is `00:01:00:20`.
 * - A field that is too large carries into the next field, as a count does: `00:00:00:40` at
 *   25 fps is frame 40, that is `00:00:01:15`. The frame index is `ceil(S * rate) + FF`, where
 *   `S` is the whole seconds of the fields, so `FF` counts from the first frame that starts in
 *   that second, as the display counts it. At 29.97 fps some seconds hold 29 frames and the
 *   others 30, so a rule that refused `FF` past the frames of its second would refuse `:29` in
 *   some seconds and accept it in the others.
 * - `;` is refused. In other editors it marks drop-frame timecode, and the frame timecode of
 *   ADR 028 is not drop-frame.
 *
 * The millisecond format, `HH:MM:SS.mmm`:
 *
 * - Fields with `:` between them, with the same rule for missing leading fields. The last field
 *   is the seconds, with an optional decimal part of up to three digits: `1:05.5` is
 *   `00:01:05.500`, `5` is five seconds, and `.25` is a quarter second. A field that is too
 *   large carries, so `90` is `00:01:30.000`.
 *
 * Both formats:
 *
 * - `+` or `-` makes the entry relative: forward or back by the amount after the sign. The
 *   amount follows the same rule as an entry without a sign in that format, as in DaVinci
 *   Resolve, Final Cut Pro and Avid. In the frame format `+45` is 45 frames (FF carries), and
 *   `+1012` is 10 seconds and 12 frames. In the millisecond format `-2` is two seconds back, and
 *   `+1.5` is 1.5 seconds forward.
 * - A leading `-` always makes the entry relative, so an absolute entry is never negative.
 * - Spaces around the entry are ignored. The full-width digits, colon, period, plus and minus
 *   that an input method types, the ideographic full stop, and the minus sign U+2212 are read as
 *   their ASCII forms. No other character is accepted, so a superscript or a circled digit is
 *   refused.
 *
 * Every value is exact BigInt arithmetic. No part of an entry goes through a floating-point
 * number. The parser does not know the source extent or the playhead: the seek plan decides what
 * an entry past the end, or a step past either end, does (`timecodeEntrySeek.ts`).
 */

import { frameIndexDigits, type TimecodeDisplay } from "./timecode";

/** A parsed entry. */
export type TimecodeEntry =
  /** An absolute frame of the nominal grid, in the frame format. */
  | { readonly kind: "frame"; readonly frameIndex: bigint }
  /** An absolute time in whole milliseconds, in the millisecond format. */
  | { readonly kind: "millisecond"; readonly milliseconds: bigint }
  /** A relative number of nominal frames, negative for a step back, in the frame format. */
  | { readonly kind: "frameStep"; readonly frames: bigint }
  /** A relative time in whole milliseconds, negative for a step back, in the millisecond format. */
  | { readonly kind: "millisecondStep"; readonly milliseconds: bigint };

/**
 * Why an entry is refused.
 *
 * - `empty`: nothing but spaces, or a sign alone.
 * - `invalid`: the entry has a character or a shape that neither rule accepts.
 * - `tooManyDecimals`: a millisecond entry with more than three digits after the point.
 */
export type TimecodeEntryError = "empty" | "invalid" | "tooManyDecimals";

/** The result of `parseTimecodeEntry`. */
export type TimecodeEntryParse =
  | { readonly ok: true; readonly entry: TimecodeEntry }
  | { readonly ok: false; readonly error: TimecodeEntryError };

/**
 * The characters that are read as an ASCII character: the full-width forms that an input method
 * types, the ideographic full stops, and the minus sign. The full-width semicolon becomes `;`,
 * which the grammar refuses, as it refuses `;`. Every other character stays as it is.
 */
const CHARACTER_MAP: ReadonlyMap<string, string> = new Map([
  ["\uFF1A", ":"],
  ["\uFF1B", ";"],
  ["\uFF0E", "."],
  ["\u3002", "."],
  ["\uFF61", "."],
  ["\uFF0B", "+"],
  ["\uFF0D", "-"],
  ["\u2212", "-"],
  ...Array.from({ length: 10 }, (_, digit): [string, string] => [
    String.fromCharCode(0xff10 + digit),
    String(digit),
  ]),
]);

const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 3600n;

/** Fields with `:` between them: two to four fields in the frame format. */
const FRAME_FIELDS = /^\d+(?::\d+){1,3}$/;
/** A run of digits and periods. */
const FRAME_DIGITS = /^[\d.]+$/;
/** The clock of a millisecond entry: one to three fields. */
const MILLISECOND_CLOCK = /^\d+(?::\d+){0,2}$/;

function refuse(error: TimecodeEntryError): TimecodeEntryParse {
  return { ok: false, error };
}

/** Reads each character of the map as its ASCII form. */
function normalizeCharacters(text: string): string {
  let result = "";
  for (const character of text) {
    result += CHARACTER_MAP.get(character) ?? character;
  }
  return result;
}

/**
 * Whole seconds of the fields `[..., HH, MM, SS]`, each missing leading field zero. The caller
 * passes at most three fields of digits.
 */
function wholeSeconds(fields: readonly string[]): bigint {
  const [ss = "0", mm = "0", hh = "0"] = [...fields].reverse();
  return BigInt(hh) * SECONDS_PER_HOUR + BigInt(mm) * SECONDS_PER_MINUTE + BigInt(ss);
}

/**
 * The frame index that the fields `[..., HH, MM, SS, FF]` name at a rate:
 * `ceil(S * rate) + FF`, with `S` the whole seconds of the leading fields (ADR 028).
 */
function frameIndexOfFields(
  fields: readonly string[],
  rate: { readonly n: number; readonly d: number },
): bigint {
  const ff = BigInt(fields[fields.length - 1]);
  const seconds = wholeSeconds(fields.slice(0, -1));
  const n = BigInt(rate.n);
  const d = BigInt(rate.d);
  // The first frame of second S is ceil(S * n / d).
  return (seconds * n + d - 1n) / d + ff;
}

/**
 * The widths of the right-aligned fields, from the right: `FF`, `SS` and `MM`. `HH` takes every
 * digit before them.
 */
function fieldWidths(ffDigits: number): readonly number[] {
  return [ffDigits, 2, 2];
}

/**
 * The number of digits of the field that holds digit position `position`, counted from the
 * right from 0. A position past `MM` is in `HH`, which a period fills with two zeros.
 */
function widthOfFieldAt(position: number, ffDigits: number): number {
  let end = 0;
  for (const width of fieldWidths(ffDigits)) {
    end += width;
    if (position < end) {
      return width;
    }
  }
  return 2;
}

/**
 * Replaces each period of a run of digits and periods with the zeros of the field that it lands
 * in. The run is read from the right, as the right-aligned fields are, so a period lands at the
 * digit position that the digits and zeros after it have reached.
 */
function expandPeriods(run: string, ffDigits: number): string {
  const fromRight: string[] = [];
  for (let index = run.length - 1; index >= 0; index--) {
    const character = run[index];
    if (character === ".") {
      const width = widthOfFieldAt(fromRight.length, ffDigits);
      for (let zero = 0; zero < width; zero++) {
        fromRight.push("0");
      }
    } else {
      fromRight.push(character);
    }
  }
  return fromRight.reverse().join("");
}

/**
 * Splits a run of digits into right-aligned fields: `FF` with `ffDigits` digits, then `SS` and
 * `MM` with two each, and `HH` with the rest.
 */
function rightAlignedFields(digits: string, ffDigits: number): string[] {
  const fields: string[] = [];
  let end = digits.length;
  for (const width of fieldWidths(ffDigits)) {
    if (end <= 0) {
      break;
    }
    const start = Math.max(0, end - width);
    fields.unshift(digits.slice(start, end));
    end = start;
  }
  if (end > 0) {
    fields.unshift(digits.slice(0, end));
  }
  return fields;
}

/**
 * Parses the body of an entry in the frame format, the part after an optional sign, into the
 * frame index that it names. A relative entry takes that index as its number of frames.
 */
function frameIndexOfBody(
  body: string,
  display: Extract<TimecodeDisplay, { format: "frames" }>,
): bigint | null {
  const ffDigits = frameIndexDigits(display.rate);
  if (FRAME_FIELDS.test(body)) {
    return frameIndexOfFields(body.split(":"), display.rate);
  }
  if (FRAME_DIGITS.test(body)) {
    return frameIndexOfFields(
      rightAlignedFields(expandPeriods(body, ffDigits), ffDigits),
      display.rate,
    );
  }
  return null;
}

/**
 * Parses the body of an entry in the millisecond format, the part after an optional sign, into
 * whole milliseconds.
 */
function millisecondsOfBody(body: string): bigint | TimecodeEntryError {
  const point = body.indexOf(".");
  const clock = point < 0 ? body : body.slice(0, point);
  const fraction = point < 0 ? "" : body.slice(point + 1);
  if (fraction.length > 0 && !/^\d+$/.test(fraction)) {
    return "invalid";
  }
  if (clock.length > 0 && !MILLISECOND_CLOCK.test(clock)) {
    return "invalid";
  }
  // A period alone names no time.
  if (clock.length === 0 && fraction.length === 0) {
    return "invalid";
  }
  if (fraction.length > 3) {
    return "tooManyDecimals";
  }
  const seconds = clock.length === 0 ? 0n : wholeSeconds(clock.split(":"));
  return seconds * 1000n + BigInt(fraction.padEnd(3, "0"));
}

/**
 * Parses a typed time. See the module comment for the rules.
 *
 * @param text The text of the field.
 * @param display The timecode format of the source. The frame format also gives the rate
 *   that `FF` counts.
 */
export function parseTimecodeEntry(
  text: string,
  display: TimecodeDisplay,
): TimecodeEntryParse {
  const normalized = normalizeCharacters(text).trim();
  let sign = 0n;
  let body = normalized;
  const first = normalized.charAt(0);
  if (first === "+") {
    sign = 1n;
    body = normalized.slice(1);
  } else if (first === "-") {
    sign = -1n;
    body = normalized.slice(1);
  }
  if (body.length === 0) {
    return refuse("empty");
  }

  if (display.format === "frames") {
    const frameIndex = frameIndexOfBody(body, display);
    if (frameIndex === null) {
      return refuse("invalid");
    }
    return sign === 0n
      ? { ok: true, entry: { kind: "frame", frameIndex } }
      : { ok: true, entry: { kind: "frameStep", frames: sign * frameIndex } };
  }

  const milliseconds = millisecondsOfBody(body);
  if (typeof milliseconds !== "bigint") {
    return refuse(milliseconds);
  }
  return sign === 0n
    ? { ok: true, entry: { kind: "millisecond", milliseconds } }
    : {
        ok: true,
        entry: { kind: "millisecondStep", milliseconds: sign * milliseconds },
      };
}
