/**
 * Exact rational time helpers, BigInt PTS arithmetic, and checked conversions for QuipClip.
 *
 * See ADR 002, ADR 003, ADR 007, and ADR 010.
 * Presentation timestamps (PTS) and tick counts are represented as branded canonical decimal strings.
 * Internal calculations use exact BigInt and rational arithmetic. Conversions between browser
 * floating-point numbers and ticks are checked to prevent precision loss and invalid state.
 */

import type { Pts, Rational, TickCount } from "@/types/project";

/**
 * Minimum signed 64-bit integer (-2^63).
 */
export const I64_MIN = -9_223_372_036_854_775_808n;

/**
 * Maximum signed 64-bit integer (2^63 - 1).
 */
export const I64_MAX = 9_223_372_036_854_775_807n;

/**
 * Calculates the greatest common divisor of two integers using Euclid's algorithm.
 */
export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/**
 * Asserts that a Rational represents a strictly positive timebase or frame rate with safe integer components.
 * Throws RangeError if non-positive, non-finite, fractional, or having unsafe integer components.
 */
export function assertPositiveTimeBase(timeBase: Rational): void {
  if (
    timeBase.n <= 0 ||
    timeBase.d <= 0 ||
    !Number.isSafeInteger(timeBase.n) ||
    !Number.isSafeInteger(timeBase.d)
  ) {
    throw new RangeError(
      `Time base must be positive with safe integer components, got ${timeBase.n}/${timeBase.d}`,
    );
  }
}

/**
 * Validates whether an unknown value is a canonical decimal string representation of a signed i64 PTS (ADR 002).
 *
 * Requirements:
 * - Must be a string matching `/^(0|-?[1-9]\d*)$/` (rejects "-0", "+123", "01", leading/trailing whitespace).
 * - Must represent an integer within signed 64-bit range [-9223372036854775808, 9223372036854775807].
 */
export function isPtsString(value: unknown): value is Pts {
  if (typeof value !== "string" || !/^(0|-?[1-9]\d*)$/.test(value)) {
    return false;
  }
  try {
    const val = BigInt(value);
    return val >= I64_MIN && val <= I64_MAX;
  } catch {
    return false;
  }
}

/**
 * Parses and validates a canonical signed i64 PTS decimal string.
 * Returns the branded Pts or null if malformed or out of range.
 */
export function parsePts(text: string): Pts | null {
  return isPtsString(text) ? text : null;
}

/**
 * Converts a BigInt into a branded canonical PTS string.
 * Throws RangeError if the value exceeds signed i64 bounds.
 */
export function ptsFromBigInt(val: bigint): Pts {
  if (val < I64_MIN || val > I64_MAX) {
    throw new RangeError(`PTS value out of signed i64 range: ${val.toString()}`);
  }
  return val.toString() as Pts;
}

/**
 * Converts a branded PTS string into an exact BigInt value.
 * Throws TypeError if the input is not a valid canonical PTS string.
 */
export function ptsToBigInt(pts: Pts): bigint {
  if (!isPtsString(pts)) {
    throw new TypeError(`Invalid canonical PTS string: ${String(pts)}`);
  }
  return BigInt(pts);
}

/**
 * Validates whether an unknown value is a canonical decimal string representation of a non-negative i64 tick count (ADR 002).
 *
 * Requirements:
 * - Must be a string matching `/^(0|[1-9]\d*)$/` (rejects negative, "+123", "01", whitespace).
 * - Must represent an integer within non-negative 64-bit range [0, 9223372036854775807].
 */
export function isTickCountString(value: unknown): value is TickCount {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    return false;
  }
  try {
    const val = BigInt(value);
    return val >= 0n && val <= I64_MAX;
  } catch {
    return false;
  }
}

/**
 * Parses and validates a canonical non-negative i64 tick count decimal string.
 * Returns the branded TickCount or null if malformed or out of range.
 */
export function parseTickCount(text: string): TickCount | null {
  return isTickCountString(text) ? text : null;
}

/**
 * Converts a non-negative BigInt into a branded canonical TickCount string.
 * Throws RangeError if negative or exceeds i64::MAX.
 */
export function tickCountFromBigInt(val: bigint): TickCount {
  if (val < 0n || val > I64_MAX) {
    throw new RangeError(
      `TickCount value out of non-negative i64 range: ${val.toString()}`,
    );
  }
  return val.toString() as TickCount;
}

/**
 * Converts a branded TickCount string into an exact BigInt value.
 * Throws TypeError if the input is not a valid canonical TickCount string.
 */
export function tickCountToBigInt(ticks: TickCount): bigint {
  if (!isTickCountString(ticks)) {
    throw new TypeError(`Invalid canonical TickCount string: ${String(ticks)}`);
  }
  return BigInt(ticks);
}

/**
 * Validates whether a value is a valid finite, non-negative approximate duration in seconds (ADR 002).
 */
export function isValidApproximateDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Normalizes approximate duration metadata, returning null if invalid or non-finite.
 */
export function validateApproximateDuration(value: unknown): number | null {
  return isValidApproximateDuration(value) ? value : null;
}

/**
 * Converts a Rational to a floating-point number.
 * Used only for UI presentation and layout percentages where IEEE 754 precision is sufficient.
 */
export function rationalToNumber(r: Rational): number {
  assertPositiveTimeBase(r);
  const result = r.n / r.d;
  if (!Number.isFinite(result)) {
    throw new RangeError(
      `Rational conversion produced non-finite number: ${r.n}/${r.d}`,
    );
  }
  return result;
}

/**
 * Parses a frame rate or timebase string into a reduced Rational.
 * Parses "30000/1001" and "25" while rejecting "0/0", non-positive rates, and malformed inputs.
 * Reduces by GCD so equivalent rates (e.g. 50/2 and 25/1) compare equal.
 */
export function parseFrameRate(text: string): Rational | null {
  const trimmed = text.trim();
  const match = /^([+-]?\d+)(?:\s*\/\s*([+-]?\d+))?$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const n = Number(match[1]);
  const d = match[2] !== undefined ? Number(match[2]) : 1;

  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d === 0) {
    return null;
  }

  const g = gcd(n, d);
  let num = n / g;
  let den = d / g;

  if (den < 0) {
    num = -num;
    den = -den;
  }

  if (num <= 0) {
    return null;
  }

  return { n: num, d: den };
}

/**
 * Compares two Rational values for exact equality via cross-multiplication.
 * Falls back to BigInt arithmetic if either cross-product exceeds Number.MAX_SAFE_INTEGER.
 */
export function rationalsEqual(a: Rational, b: Rational): boolean {
  if (a.d === 0 || b.d === 0) {
    return false;
  }

  const absAn = Math.abs(a.n);
  const absAd = Math.abs(a.d);
  const absBn = Math.abs(b.n);
  const absBd = Math.abs(b.d);

  const overflowA = absBd !== 0 && absAn > Number.MAX_SAFE_INTEGER / absBd;
  const overflowB = absAd !== 0 && absBn > Number.MAX_SAFE_INTEGER / absAd;

  if (overflowA || overflowB) {
    return BigInt(a.n) * BigInt(b.d) === BigInt(b.n) * BigInt(a.d);
  }

  return a.n * b.d === b.n * a.d;
}

/**
 * Infers a source presentation timestamp (PTS) from a presented browser frame callback (ADR 003).
 *
 * Formula:
 * `videoStartPts + round((mediaTime - calibratedMediaTime) / videoTimeBase)`
 *
 * Checked conversion:
 * - Rejects non-finite or negative mediaTime / calibratedMediaTime.
 * - Rejects unsafe integer tick deltas.
 * - Rejects results outside signed i64 range.
 * - Returns null on any validation or numeric safety failure.
 */
export function mediaTimeToPts(
  mediaTime: number,
  calibratedMediaTime: number,
  videoStartPts: Pts,
  videoTimeBase: Rational,
): Pts | null {
  if (
    typeof mediaTime !== "number" ||
    !Number.isFinite(mediaTime) ||
    mediaTime < 0 ||
    typeof calibratedMediaTime !== "number" ||
    !Number.isFinite(calibratedMediaTime) ||
    calibratedMediaTime < 0
  ) {
    return null;
  }

  try {
    assertPositiveTimeBase(videoTimeBase);
  } catch {
    return null;
  }

  if (!isPtsString(videoStartPts)) {
    return null;
  }

  const deltaSeconds = mediaTime - calibratedMediaTime;
  if (!Number.isFinite(deltaSeconds)) {
    return null;
  }

  const rawDeltaTicks = (deltaSeconds * videoTimeBase.d) / videoTimeBase.n;
  const deltaTicks = Math.round(rawDeltaTicks);

  if (!Number.isSafeInteger(deltaTicks)) {
    return null;
  }

  const startBig = ptsToBigInt(videoStartPts);
  const targetBig = startBig + BigInt(deltaTicks);

  if (targetBig < I64_MIN || targetBig > I64_MAX) {
    return null;
  }

  return ptsFromBigInt(targetBig);
}

/**
 * Applies the inverse calibrated mapping to determine the browser mediaTime to seek to for a target PTS (ADR 003).
 *
 * Formula:
 * `calibratedMediaTime + (targetPts - videoStartPts) * videoTimeBase`
 *
 * Checked conversion:
 * - Subtracts source origin with BigInt before checking safe-integer range.
 * - Rejects unsafe BigInt-to-number tick deltas.
 * - Rejects results that are not finite or not valid non-negative media times.
 */
export function ptsToMediaTime(
  targetPts: Pts,
  videoStartPts: Pts,
  calibratedMediaTime: number,
  videoTimeBase: Rational,
): number | null {
  if (
    typeof calibratedMediaTime !== "number" ||
    !Number.isFinite(calibratedMediaTime) ||
    calibratedMediaTime < 0
  ) {
    return null;
  }

  try {
    assertPositiveTimeBase(videoTimeBase);
  } catch {
    return null;
  }

  if (!isPtsString(targetPts) || !isPtsString(videoStartPts)) {
    return null;
  }

  const deltaTicksBig = ptsToBigInt(targetPts) - ptsToBigInt(videoStartPts);

  if (
    deltaTicksBig < BigInt(Number.MIN_SAFE_INTEGER) ||
    deltaTicksBig > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }

  const deltaSeconds = (Number(deltaTicksBig) * videoTimeBase.n) / videoTimeBase.d;
  const mediaTime = calibratedMediaTime + deltaSeconds;

  if (!Number.isFinite(mediaTime) || mediaTime < 0) {
    return null;
  }

  return mediaTime;
}

/**
 * Converts a source PTS to elapsed seconds from the source start with checked arithmetic.
 * Returns null when the PTS delta cannot be represented safely at a browser or UI boundary.
 */
export function ptsElapsedSeconds(
  pts: Pts,
  videoStartPts: Pts,
  videoTimeBase: Rational,
): number | null {
  if (!isPtsString(pts) || !isPtsString(videoStartPts)) {
    return null;
  }
  try {
    assertPositiveTimeBase(videoTimeBase);
  } catch {
    return null;
  }

  const deltaTicks = ptsToBigInt(pts) - ptsToBigInt(videoStartPts);
  if (
    deltaTicks < BigInt(Number.MIN_SAFE_INTEGER) ||
    deltaTicks > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  const seconds = (Number(deltaTicks) * videoTimeBase.n) / videoTimeBase.d;
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Converts finite, non-negative source elapsed seconds to a source PTS.
 * The rounded tick delta must be a safe integer before it enters BigInt arithmetic.
 */
export function elapsedSecondsToPts(
  elapsedSeconds: number,
  videoStartPts: Pts,
  videoTimeBase: Rational,
): Pts | null {
  return mediaTimeToPts(elapsedSeconds, 0, videoStartPts, videoTimeBase);
}

/**
 * Checked conversion of a TickCount to seconds.
 * Rejects values exceeding Number.MAX_SAFE_INTEGER or non-finite results.
 */
export function ticksToSeconds(ticks: TickCount, timeBase: Rational): number | null {
  try {
    assertPositiveTimeBase(timeBase);
  } catch {
    return null;
  }

  if (!isTickCountString(ticks)) {
    return null;
  }

  const ticksBig = tickCountToBigInt(ticks);
  if (ticksBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }

  const sec = (Number(ticksBig) * timeBase.n) / timeBase.d;
  if (!Number.isFinite(sec) || sec < 0) {
    return null;
  }

  return sec;
}

/**
 * Checked conversion of seconds to a non-negative TickCount.
 * Rejects non-finite, negative, or unsafe integer inputs.
 */
export function secondsToTicks(seconds: number, timeBase: Rational): TickCount | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  try {
    assertPositiveTimeBase(timeBase);
  } catch {
    return null;
  }

  const rawTicks = (seconds * timeBase.d) / timeBase.n;
  const ticks = Math.round(rawTicks);

  if (!Number.isSafeInteger(ticks) || ticks < 0) {
    return null;
  }

  const ticksBig = BigInt(ticks);
  if (ticksBig > I64_MAX) {
    return null;
  }

  return tickCountFromBigInt(ticksBig);
}

/**
 * Checks whether a half-open segment interval [inPts, outPts) is strictly valid (inPts < outPts) (ADR 002).
 */
export function isValidSegmentRange(inPts: Pts, outPts: Pts): boolean {
  if (!isPtsString(inPts) || !isPtsString(outPts)) {
    return false;
  }
  return ptsToBigInt(inPts) < ptsToBigInt(outPts);
}

/**
 * Calculates the exact signed difference between two PTS values as a BigInt (`a - b`).
 */
export function ptsDifference(a: Pts, b: Pts): bigint {
  return ptsToBigInt(a) - ptsToBigInt(b);
}

/**
 * Checks whether a candidate PTS is strictly inside a half-open segment interval (inPts < pts < outPts) (ADR 007).
 */
export function isPtsInsideSegment(pts: Pts, inPts: Pts, outPts: Pts): boolean {
  if (!isPtsString(pts) || !isPtsString(inPts) || !isPtsString(outPts)) {
    return false;
  }
  const p = ptsToBigInt(pts);
  return ptsToBigInt(inPts) < p && p < ptsToBigInt(outPts);
}

/**
 * Calculates the exact duration in ticks for a valid half-open segment interval [inPts, outPts).
 * The difference can be as large as I64_MAX - I64_MIN and is therefore not a TickCount.
 */
export function segmentDurationTicks(inPts: Pts, outPts: Pts): bigint | null {
  if (!isValidSegmentRange(inPts, outPts)) {
    return null;
  }
  return ptsToBigInt(outPts) - ptsToBigInt(inPts);
}

/**
 * Calculates the exact duration in seconds for a segment interval [inPts, outPts).
 * Returns null if invalid or unsafe.
 */
export function segmentDurationSeconds(
  inPts: Pts,
  outPts: Pts,
  timeBase: Rational,
): number | null {
  const ticks = segmentDurationTicks(inPts, outPts);
  if (ticks === null || ticks > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  try {
    assertPositiveTimeBase(timeBase);
  } catch {
    return null;
  }
  const seconds = (Number(ticks) * timeBase.n) / timeBase.d;
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Formats a frame timestamp into fixed 9 decimal places for FFmpeg (transitional).
 */
export function formatSecondsForFfmpeg(frame: number, fps: Rational): string {
  assertPositiveTimeBase(fps);
  if (!Number.isSafeInteger(frame)) {
    return "0.000000000";
  }

  const frameBig = BigInt(Math.trunc(frame));
  const dBig = BigInt(Math.trunc(fps.d));
  const nBig = BigInt(Math.trunc(fps.n));

  const num = frameBig * dBig;
  const den = nBig;

  const negative = num < 0n !== den < 0n;
  const numMag = num < 0n ? -num : num;
  const denMag = den < 0n ? -den : den;

  const scale = 1_000_000_000n; // 10^9
  const scaled = numMag * scale;
  const quotient = scaled / denMag;
  const remainder = scaled % denMag;

  const rounded = remainder * 2n >= denMag ? quotient + 1n : quotient;

  const digits = rounded.toString();
  const padded = digits.padStart(10, "0");
  const splitAt = padded.length - 9;
  const intPart = padded.slice(0, splitAt);
  const fracPart = padded.slice(splitAt);
  const sign = negative && rounded !== 0n ? "-" : "";

  return `${sign}${intPart}.${fracPart}`;
}
