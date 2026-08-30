/**
 * Exact rational time helpers and frame grid conversions for the frontend.
 *
 * This module is deliberately smaller than the Rust `time.rs` module.
 * JavaScript numbers are IEEE-754 64-bit floating point numbers (doubles),
 * so exact rational arithmetic would require BigInt throughout. The frontend
 * needs exactness only where it performs integer frame arithmetic (such as
 * timecodes and segment boundaries). Where it converts to seconds for
 * `video.currentTime` and preview seeks, a double is already the native
 * destination type expected by DOM media elements.
 */

import { type Rational } from "@/types/project";

/**
 * Calculates the greatest common divisor of two integers using Euclid's algorithm.
 */
function gcd(a: number, b: number): number {
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
 * Asserts that a Rational represents a strictly positive frame rate with safe integer components.
 * Throws RangeError before any arithmetic is performed if the frame rate is non-positive,
 * non-finite, fractional, or has unsafe integer components.
 */
function assertPositiveFps(fps: Rational): void {
  if (
    fps.n <= 0 ||
    fps.d <= 0 ||
    !Number.isSafeInteger(fps.n) ||
    !Number.isSafeInteger(fps.d)
  ) {
    throw new RangeError(
      `Frame rate must be positive with safe integer components, got ${fps.n}/${fps.d}`,
    );
  }
}

/**
 * Converts a Rational to a floating-point number.
 * Used for approximate UI presentation and layout percentages where IEEE 754 precision is sufficient.
 */
export function rationalToNumber(r: Rational): number {
  return r.n / r.d;
}

/**
 * Parses a frame rate string into a reduced Rational timebase.
 * Parses "30000/1001" and "25" while rejecting "0/0", non-positive rates, and malformed inputs.
 * Reduces by GCD so equivalent rates (e.g. 50/2 and 25/1) compare equal after JSON serialization.
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
 * Avoids division which would introduce floating-point inaccuracies, and falls
 * back to BigInt arithmetic if either cross-product exceeds Number.MAX_SAFE_INTEGER.
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
 * Calculates the exact start time in seconds for a given integer frame index.
 * Used when setting HTML5 video.currentTime or calculating playback offsets.
 */
export function secondsAtFrame(frame: number, fps: Rational): number {
  assertPositiveFps(fps);
  return (frame * fps.d) / fps.n;
}

/**
 * Calculates the midpoint timestamp in seconds for a given frame index.
 * Used as the seek target for video elements (ADR 003) because seeking to the
 * exact frame boundary instant (PTS = k / fps) touches both frame k-1 and frame k,
 * risking landing on the wrong frame due to decoder rounding. The midpoint is
 * unambiguously within the target frame's duration.
 */
export function midpointSecondsAtFrame(frame: number, fps: Rational): number {
  assertPositiveFps(fps);
  return ((frame + 0.5) * fps.d) / fps.n;
}

/**
 * Converts a timestamp in seconds to the containing frame index on the project grid.
 * Floors the result to find the active frame (including for negative timestamps).
 * Snaps results within 1e-6 of an integer to prevent precision loss where a float
 * value landing one ULP below a boundary would incorrectly floor to the preceding frame.
 */
export function frameAtSeconds(seconds: number, fps: Rational): number {
  assertPositiveFps(fps);
  const rawFrames = (seconds * fps.n) / fps.d;
  const nearest = Math.round(rawFrames);
  const snapped = Math.abs(rawFrames - nearest) < 1e-6 ? nearest : rawFrames;
  return Math.floor(snapped);
}

/**
 * Converts presentation timestamp readbacks from `requestVideoFrameCallback` to an integer frame index.
 * Accounts for non-zero container start times (ADR 003) to verify which frame was rendered on screen.
 */
export function frameAtMediaTime(
  mediaTime: number,
  startTime: number,
  fps: Rational,
): number {
  assertPositiveFps(fps);
  return frameAtSeconds(mediaTime - startTime, fps);
}

/**
 * Calculates the ceiling of frames per second for non-drop-frame timecode display.
 * Determines the width of the FF field (e.g., 30 slots for 30000/1001 fps) so each
 * second contains a fixed integer count of frame indices (00..FF-1).
 */
export function framesPerSecondCeil(fps: Rational): number {
  assertPositiveFps(fps);
  return Math.ceil(fps.n / fps.d);
}

/**
 * Formats an integer frame index as a non-drop-frame `HH:MM:SS:FF` timecode.
 * Uses integer math with unconstrained hours and a single leading '-' for negative frames.
 * The FF field counts `framesPerSecondCeil` slots (e.g. 00..29 for 30000/1001 fps).
 */
export function formatTimecode(frame: number, fps: Rational): string {
  assertPositiveFps(fps);
  const fpsCeil = framesPerSecondCeil(fps);
  const negative = frame < 0;
  const absFrame = Math.abs(Math.trunc(frame));
  const totalSeconds = Math.floor(absFrame / fpsCeil);
  const ff = absFrame % fpsCeil;
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor(totalSeconds / 60) % 60;
  const ss = totalSeconds % 60;
  const sign = negative ? "-" : "";

  const pad = (val: number) => String(val).padStart(2, "0");
  return `${sign}${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/**
 * Parses a `HH:MM:SS:FF` timecode string into an integer frame index.
 * Rejects malformed strings, minutes/seconds >= 60, and FF fields >= framesPerSecondCeil
 * to ensure that invalid or out-of-range timecodes do not produce corrupt edit points.
 */
export function parseTimecode(text: string, fps: Rational): number | null {
  assertPositiveFps(fps);
  const trimmed = text.trim();
  const negative = trimmed.startsWith("-");
  const rest = negative ? trimmed.slice(1) : trimmed;
  const parts = rest.split(":");

  if (parts.length !== 4) {
    return null;
  }

  if (!parts.every((p) => /^\d+$/.test(p))) {
    return null;
  }

  const [hhStr, mmStr, ssStr, ffStr] = parts;
  const hh = Number(hhStr);
  const mm = Number(mmStr);
  const ss = Number(ssStr);
  const ff = Number(ffStr);

  if (
    !Number.isSafeInteger(hh) ||
    !Number.isSafeInteger(mm) ||
    !Number.isSafeInteger(ss) ||
    !Number.isSafeInteger(ff)
  ) {
    return null;
  }

  if (hh < 0 || mm < 0 || mm >= 60 || ss < 0 || ss >= 60 || ff < 0) {
    return null;
  }

  const fpsCeil = framesPerSecondCeil(fps);
  if (ff >= fpsCeil) {
    return null;
  }

  const totalSeconds = hh * 3600 + mm * 60 + ss;
  const magnitude = totalSeconds * fpsCeil + ff;
  const result = negative ? -magnitude : magnitude;

  if (!Number.isSafeInteger(result)) {
    return null;
  }

  return result;
}

/**
 * Formats a frame timestamp into a fixed-point decimal string with 9 decimal places.
 * Required for ffmpeg command line arguments (ADR 004) where sub-frame trim precision
 * is needed. Computes the integer and fractional parts using BigInt to prevent
 * floating-point precision loss on large frame numbers.
 */
export function formatSecondsForFfmpeg(frame: number, fps: Rational): string {
  assertPositiveFps(fps);
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

  // Round half away from zero to match Rust's format_seconds and ffmpeg expectation
  const rounded = remainder * 2n >= denMag ? quotient + 1n : quotient;

  const digits = rounded.toString();
  const padded = digits.padStart(10, "0");
  const splitAt = padded.length - 9;
  const intPart = padded.slice(0, splitAt);
  const fracPart = padded.slice(splitAt);
  const sign = negative && rounded !== 0n ? "-" : "";

  return `${sign}${intPart}.${fracPart}`;
}
