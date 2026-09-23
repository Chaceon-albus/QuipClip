/**
 * Timecode formatting for source-relative elapsed time (ADR 002, ADR 028).
 *
 * The interface has two formats:
 *
 * - `HH:MM:SS:FF`, the default. It names the frame of the nominal frame grid that contains
 *   the elapsed time plus a small margin. `HH:MM:SS` is the whole seconds of the nominal
 *   start of that frame, and `FF` is the index of that frame among the frames that start in
 *   that second.
 * - `HH:MM:SS.mmm`, the elapsed seconds rounded to the millisecond.
 *
 * At an integer rate such as 25 fps, every second starts with a frame, so `HH:MM:SS` is the
 * whole elapsed seconds and `FF` is the fractional part multiplied by the rate, rounded down.
 * At 23.976, 29.97 and 59.94 fps, a frame can start before a whole second and end after it.
 * A time inside the part of that frame after the whole second still shows that frame, so
 * `HH:MM:SS` is then one less than the whole elapsed seconds, for less than one frame
 * interval. Each frame therefore has one number, and a seek target inside a frame shows the
 * same number as the frame that answers it (ADR 022).
 *
 * `FF` is a display rule only. No edit, seek or export reads it, and a mark still stores the
 * PTS of the frame on screen (ADR 028). The functions here are pure. Which format applies to
 * a source is decided by `resolveTimecodeDisplay` in the playback feature.
 */

import type { Rational } from "@/types/project";

/** The timecode format that the user selects in Settings. */
export type TimecodeFormat = "frames" | "milliseconds";

/** Every timecode format, in the order the settings control lists them. */
export const TIMECODE_FORMATS: readonly TimecodeFormat[] = [
  "frames",
  "milliseconds",
] as const;

/**
 * The format that applies to one source. The frame format carries the nominal rate that
 * `FF` counts, so a caller cannot format frames without a rate.
 */
export type TimecodeDisplay =
  | {
      readonly format: "frames";
      /** Frames per second on the nominal grid that `FF` counts. */
      readonly rate: Rational;
      /**
       * The video time base of the source. With the rate, it sets the frame boundary margin.
       * Null gives the smallest margin, one microsecond.
       */
      readonly videoTimeBase: Rational | null;
    }
  | { readonly format: "milliseconds" };

/** The millisecond display. It needs no rate, so one shared value serves every caller. */
export const MILLISECONDS_TIMECODE_DISPLAY: TimecodeDisplay = Object.freeze({
  format: "milliseconds",
});

/** Shown in the millisecond format when no time is known. */
export const MILLISECONDS_TIMECODE_PLACEHOLDER = "--:--:--.---";

/** Shown in the frame format when no time is known and the rate is below 101 fps. */
export const FRAME_TIMECODE_PLACEHOLDER = "--:--:--:--";

/** An exact non-negative number of seconds, `num / den`. */
interface ExactSeconds {
  readonly num: bigint;
  readonly den: bigint;
}

/**
 * The smallest frame boundary margin, one microsecond.
 *
 * It absorbs floating-point error. For example, frame 04 of second 1 at 25 fps starts at
 * 1.16 s, but the nearest double lies below 1.16, and without the margin that value shows
 * frame 03. It also absorbs a web view that reports `currentTime` rounded to the
 * microsecond, because a nominal frame step adds one frame interval to that rounded time.
 */
const MIN_MARGIN: ExactSeconds = { num: 1n, den: 1_000_000n };

/**
 * The largest elapsed time the floating-point path formats, about 9.0e9 s (285 years).
 * From 2^33 s (about 8.6e9 s, 272 years), neighbouring doubles lie more than one
 * microsecond apart, so the smallest margin can round away a little below this bound.
 * No real source comes near either value.
 */
const MAX_FLOAT_ELAPSED_SECONDS = Number.MAX_SAFE_INTEGER / 1_000_000;

function isValidRate(rate: Rational | null | undefined): rate is Rational {
  return (
    rate !== null &&
    rate !== undefined &&
    Number.isSafeInteger(rate.n) &&
    Number.isSafeInteger(rate.d) &&
    rate.n > 0 &&
    rate.d > 0
  );
}

/**
 * True when the nominal frame interval, `1 / rate`, is a whole number of ticks of the time
 * base. The interval in ticks is `(rate.d * timeBase.d) / (rate.n * timeBase.n)`, so the test
 * is exact BigInt arithmetic. The caller validates both rationals.
 */
function isWholeTickInterval(rate: Rational, timeBase: Rational): boolean {
  const ticksNum = BigInt(rate.d) * BigInt(timeBase.d);
  const ticksDen = BigInt(rate.n) * BigInt(timeBase.n);
  return ticksNum % ticksDen === 0n;
}

/**
 * The frame boundary margin for a source (ADR 028). A time that lies no more than the
 * margin before the start of a frame counts as that frame. The margin moves a time forward
 * only, so the display still names the frame that contains the time, not the nearest frame.
 *
 * - When the nominal frame interval is not a whole number of ticks of the video time base,
 *   the margin is half a tick, and at least one microsecond. A container stores each PTS
 *   rounded to its time base. Matroska uses milliseconds, so at 29.97 fps a frame can start
 *   up to 0.5 ms before its nominal position, and without this margin it would show the
 *   number of the frame before it.
 * - When the interval is a whole number of ticks, such as 1/25 at 25 fps or 1/90000 at
 *   29.97 fps (3003 ticks), the frame starts lie exactly on the tick grid, and no PTS is
 *   rounded. Half a tick could then be as much as half a frame, so the margin is only one
 *   microsecond.
 * - With no valid time base or rate, the margin is one microsecond.
 */
function frameBoundaryMargin(
  rate: Rational | null | undefined,
  videoTimeBase: Rational | null | undefined,
): ExactSeconds {
  if (
    !isValidRate(rate) ||
    !isValidRate(videoTimeBase) ||
    isWholeTickInterval(rate, videoTimeBase)
  ) {
    return MIN_MARGIN;
  }
  const halfTick: ExactSeconds = {
    num: BigInt(videoTimeBase.n),
    den: 2n * BigInt(videoTimeBase.d),
  };
  // halfTick >= MIN_MARGIN, compared by cross-multiplication.
  return halfTick.num * MIN_MARGIN.den >= MIN_MARGIN.num * halfTick.den
    ? halfTick
    : MIN_MARGIN;
}

/**
 * The frame boundary margin in seconds, as a double. `formatFrameTimecode` adds it to
 * a floating-point time. `formatFrameTimecodeFromTicks` does not use it: the exact path
 * keeps the margin as a rational.
 *
 * @param rate The nominal frame rate.
 * @param videoTimeBase The video time base of the source, or null for the smallest
 *   margin.
 */
export function frameBoundaryMarginSeconds(
  rate: Rational | null | undefined,
  videoTimeBase: Rational | null | undefined,
): number {
  const margin = frameBoundaryMargin(rate, videoTimeBase);
  return Number(margin.num) / Number(margin.den);
}

/** The largest frame index inside one second, `ceil(rate) - 1`. The caller validates the rate. */
function largestFrameIndex(rate: Rational): bigint {
  const n = BigInt(rate.n);
  const d = BigInt(rate.d);
  return (n + d - 1n) / d - 1n;
}

/**
 * The number of `FF` digits for a rate: the digit count of the largest frame index,
 * `ceil(rate) - 1`, and never fewer than two. Every rate up to 100 fps gives two digits,
 * 120 fps gives three.
 */
export function frameIndexDigits(rate: Rational): number {
  if (!isValidRate(rate)) {
    return 2;
  }
  return Math.max(2, largestFrameIndex(rate).toString().length);
}

/**
 * The frame-format placeholder for a rate. It has one dash for each `FF` digit, so it has
 * the width of a real value at that rate.
 */
export function frameTimecodePlaceholder(rate: Rational | null | undefined): string {
  if (!isValidRate(rate)) {
    return FRAME_TIMECODE_PLACEHOLDER;
  }
  return `--:--:--:${"-".repeat(frameIndexDigits(rate))}`;
}

/** The placeholder of a display, for a time that is not known. */
export function timecodePlaceholder(display: TimecodeDisplay): string {
  return display.format === "frames"
    ? frameTimecodePlaceholder(display.rate)
    : MILLISECONDS_TIMECODE_PLACEHOLDER;
}

function pad2(value: number | bigint): string {
  return value.toString().padStart(2, "0");
}

function formatClock(wholeSeconds: bigint): string {
  const ss = wholeSeconds % 60n;
  const totalMinutes = wholeSeconds / 60n;
  const mm = totalMinutes % 60n;
  const hh = totalMinutes / 60n;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

/**
 * Names frame `frame` of the nominal grid, which starts at `frame / rate` seconds: the whole
 * seconds of that start, and the index of the frame among the frames that start in that
 * second. The caller validates the rate and passes a non-negative frame.
 */
function formatGridFrame(frame: bigint, rate: Rational): string {
  const n = BigInt(rate.n);
  const d = BigInt(rate.d);
  const second = (frame * d) / n;
  // The first frame of that second is ceil(second * rate).
  const firstFrameOfSecond = (second * n + d - 1n) / d;
  const ff = (frame - firstFrameOfSecond)
    .toString()
    .padStart(frameIndexDigits(rate), "0");
  return `${formatClock(second)}:${ff}`;
}

/**
 * Formats exact non-negative elapsed seconds `num / den` as `HH:MM:SS:FF`. The margin is
 * added to the whole elapsed time first, then the frame that contains the result is found.
 * All arithmetic is BigInt, so the result has no rounding error. The caller validates the
 * rate.
 */
function formatFramesExact(
  elapsed: ExactSeconds,
  rate: Rational,
  margin: ExactSeconds,
): string {
  // elapsed + margin = (elapsed.num * margin.den + margin.num * elapsed.den) / (elapsed.den * margin.den)
  const shiftedNum = elapsed.num * margin.den + margin.num * elapsed.den;
  const shiftedDen = elapsed.den * margin.den;
  const frame = (shiftedNum * BigInt(rate.n)) / (shiftedDen * BigInt(rate.d));
  return formatGridFrame(frame, rate);
}

/**
 * Formats non-negative elapsed seconds as `HH:MM:SS:FF` at a nominal frame rate
 * (ADR 028).
 *
 * The frame boundary margin of the rate and the video time base is added to the time
 * before the frame is found. The margin is at least one microsecond. So frame 04 of
 * second 1 at 25 fps, which starts at 1.16 s, shows `00:00:01:04`, although the nearest
 * double lies below 1.16. A negative, non-finite or out-of-range time, or an invalid
 * rate, returns the placeholder.
 *
 * When the time plus the margin is exactly a frame start, this path and
 * `formatFrameTimecodeFromTicks` can differ by floating-point error. At 29.97 fps with
 * a 1/1000 time base, a PTS of 500 ms plus the 0.5 ms margin is exactly the start of
 * frame 15. The tick path shows frame 15, and this path shows frame 14, because the
 * double `0.5 + 0.0005` lies just below 0.5005. A real file never has that PTS: frame
 * 15 starts at 500.5 ms, and Matroska stores it as 501 ms.
 *
 * @param elapsedSeconds Seconds from the start of the source.
 * @param nominalRate Frames per second, as the status bar reports it.
 * @param videoTimeBase The video time base of the source, or null for the smallest
 *   margin.
 */
export function formatFrameTimecode(
  elapsedSeconds: number,
  nominalRate: Rational,
  videoTimeBase: Rational | null = null,
): string {
  if (!isValidRate(nominalRate)) {
    return FRAME_TIMECODE_PLACEHOLDER;
  }
  if (
    typeof elapsedSeconds !== "number" ||
    !Number.isFinite(elapsedSeconds) ||
    elapsedSeconds < 0 ||
    elapsedSeconds > MAX_FLOAT_ELAPSED_SECONDS
  ) {
    return frameTimecodePlaceholder(nominalRate);
  }

  const shifted =
    elapsedSeconds + frameBoundaryMarginSeconds(nominalRate, videoTimeBase);
  const frame = Math.floor((shifted * nominalRate.n) / nominalRate.d);
  if (!Number.isSafeInteger(frame) || frame < 0) {
    return frameTimecodePlaceholder(nominalRate);
  }
  return formatGridFrame(BigInt(frame), nominalRate);
}

/**
 * Formats a non-negative tick count in a time base as `HH:MM:SS:FF`, with exact rational
 * arithmetic (ADR 002). The elapsed time is `ticks * timeBase`. It applies the same margin
 * as `formatFrameTimecode`. A negative tick count or an invalid time base or rate returns
 * the placeholder.
 *
 * @param ticks Ticks from the start of the source.
 * @param timeBase Seconds per tick.
 * @param nominalRate Frames per second.
 * @param videoTimeBase The video time base of the source, or null for the smallest margin.
 */
export function formatFrameTimecodeFromTicks(
  ticks: bigint,
  timeBase: Rational,
  nominalRate: Rational,
  videoTimeBase: Rational | null = null,
): string {
  if (!isValidRate(nominalRate)) {
    return FRAME_TIMECODE_PLACEHOLDER;
  }
  if (typeof ticks !== "bigint" || ticks < 0n || !isValidRate(timeBase)) {
    return frameTimecodePlaceholder(nominalRate);
  }
  return formatFramesExact(
    { num: ticks * BigInt(timeBase.n), den: BigInt(timeBase.d) },
    nominalRate,
    frameBoundaryMargin(nominalRate, videoTimeBase),
  );
}

/**
 * Formats a non-negative floating-point seconds value as `HH:MM:SS.mmm`, rounded to the
 * millisecond. An invalid value formats as `00:00:00.000`.
 *
 * @param seconds Non-negative finite duration in seconds.
 */
export function formatMillisecondsTimecode(seconds: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "00:00:00.000";
  }

  const milliseconds = seconds * 1000;
  if (!Number.isFinite(milliseconds)) {
    return "00:00:00.000";
  }
  const totalMs = Math.round(milliseconds);
  if (!Number.isSafeInteger(totalMs)) {
    return "00:00:00.000";
  }
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const ss = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const mm = totalMin % 60;
  const hh = Math.floor(totalMin / 60);

  const pad3 = (n: number) => String(n).padStart(3, "0");

  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(ms)}`;
}

/**
 * Formats non-negative elapsed seconds in a display's format.
 *
 * @param elapsedSeconds Seconds from the start of the source.
 * @param display The format that applies to the source.
 */
export function formatElapsedTimecode(
  elapsedSeconds: number,
  display: TimecodeDisplay,
): string {
  return display.format === "frames"
    ? formatFrameTimecode(elapsedSeconds, display.rate, display.videoTimeBase)
    : formatMillisecondsTimecode(elapsedSeconds);
}
