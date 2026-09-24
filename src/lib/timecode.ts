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
 * `formatElapsedTickSpan` writes the start, the end and the duration of a span, such as a
 * segment, in the same two formats.
 *
 * `FF` is not an edit position. No edit or export reads it, and a mark still stores the PTS of
 * the frame on screen (ADR 028). A typed timecode reads it, to find the frame that the user
 * names (`parseTimecodeEntry`), and the seek then goes to that frame by its nominal grid index
 * or by the last tick that the display names with the typed value (`lastTickOfGridIndex`). The
 * functions here are pure. Which format applies to a source is decided by
 * `resolveTimecodeDisplay` in the playback feature.
 */

import { isPtsString, ticksToSeconds } from "@/lib/time";
import type { Pts, Rational, TickCount } from "@/types/project";

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
 * microsecond, because a nominal frame step that cannot use the frame grid adds one frame
 * interval to that rounded time: without a calibration, at a variable frame rate, or with a
 * time base on which the grid is not exact (see `isFrameGridExact`).
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
 * True when one tick of the time base plus the smallest margin is less than half the nominal
 * frame interval, `rate.d / (2 * rate.n)`. The test is exact BigInt arithmetic by
 * cross-multiplication. The caller validates both rationals.
 */
function isTickBelowHalfInterval(rate: Rational, timeBase: Rational): boolean {
  const tickNum = BigInt(timeBase.n);
  const tickDen = BigInt(timeBase.d);
  // tick + MIN_MARGIN = (tickNum * MIN_MARGIN.den + MIN_MARGIN.num * tickDen) /
  // (tickDen * MIN_MARGIN.den).
  return (
    (tickNum * MIN_MARGIN.den + MIN_MARGIN.num * tickDen) * 2n * BigInt(rate.n) <
    BigInt(rate.d) * tickDen * MIN_MARGIN.den
  );
}

/**
 * The frame boundary margin for a source (ADR 028). A time that lies no more than the
 * margin before the start of a frame counts as that frame. The margin moves a time forward
 * only, so the display still names the frame that contains the time, not the nearest frame.
 *
 * - When the nominal frame interval is not a whole number of ticks of the video time base,
 *   the margin is one tick, and at least one microsecond. A container stores each PTS
 *   rounded to its time base. Matroska uses milliseconds, so at 29.97 fps a frame can start
 *   up to 0.5 ms before its nominal position. The elapsed time counts from the first PTS,
 *   and that PTS can also be rounded, up to 0.5 ms the other way: a first frame at nominal
 *   frame 2 starts at 67 ms, not at 66.73 ms. Measured from it, a later frame can start up
 *   to one tick before its nominal position. Without this margin, that frame would show the
 *   number of the frame before it.
 * - When the interval is a whole number of ticks, such as 1/25 at 25 fps or 1/90000 at
 *   29.97 fps (3003 ticks), the frame starts lie exactly on the tick grid, and no PTS is
 *   rounded. One tick can be as long as the whole interval there, as with 1/25 at 25 fps, so
 *   the margin is only one microsecond.
 * - One tick must stay less than half a frame interval minus one microsecond. When it does
 *   not, the margin is a quarter of the interval, and at least one microsecond. A margin of
 *   half an interval or more would show a time in the middle of a frame as the next frame,
 *   and a nominal frame step aims at that middle (ADR 022). Only a tick of about half an
 *   interval or more reaches this limit, for example 1/24 at 23.976 fps, 1/60 at 59.94 fps,
 *   or 1/25, 1/50 and 1/10 at 29.97 fps. 1/60 at 29.97 fps stays just below it. On such a
 *   time base a real frame start can lie up to a whole frame from its nominal start, so the
 *   frame grid is not exact (see `isFrameGridExact`).
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
  const margin: ExactSeconds = isTickBelowHalfInterval(rate, videoTimeBase)
    ? { num: BigInt(videoTimeBase.n), den: BigInt(videoTimeBase.d) }
    : { num: BigInt(rate.d), den: 4n * BigInt(rate.n) };
  // margin >= MIN_MARGIN, compared by cross-multiplication.
  return margin.num * MIN_MARGIN.den >= MIN_MARGIN.num * margin.den
    ? margin
    : MIN_MARGIN;
}

/**
 * True when the nominal frame interval is a whole number of ticks of the video time base, or
 * when one tick is less than half the interval minus one microsecond. The frame boundary
 * margin is then one tick or one microsecond, and not a quarter interval (ADR 028). With no
 * valid rate or time base there is no tick grid, and the result is false.
 *
 * A nominal frame step uses the frame grid only when this is true (ADR 022). It rounds the
 * frame on screen to the nearest nominal frame, and it aims at the middle of the target
 * frame. On every time base, a real frame start lies less than one tick from its nominal
 * start, measured from a rounded first PTS. When the interval is a whole number of ticks,
 * the starts lie on the tick grid. When one tick is less than half the interval, a real
 * start rounds to its own nominal frame, and a middle target plus the margin stays inside
 * its frame. On a coarser time base, such as 1/24 at 23.976 fps, one tick is almost a whole
 * frame, and neither holds.
 *
 * @param rate The nominal frame rate.
 * @param videoTimeBase The video time base of the source.
 */
export function isFrameGridExact(
  rate: Rational | null | undefined,
  videoTimeBase: Rational | null | undefined,
): boolean {
  if (!isValidRate(rate) || !isValidRate(videoTimeBase)) {
    return false;
  }
  return (
    isWholeTickInterval(rate, videoTimeBase) ||
    isTickBelowHalfInterval(rate, videoTimeBase)
  );
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

/** Frame `frame` of the nominal grid, as the whole second of its start and `FF`. */
interface GridFrame {
  /** The whole seconds of the nominal start of the frame, `frame / rate` rounded down. */
  readonly second: bigint;
  /** `FF`, padded to the digit count of the rate. */
  readonly ff: string;
}

/**
 * Splits frame `frame` of the nominal grid, which starts at `frame / rate` seconds, into the
 * whole seconds of that start and the index of the frame among the frames that start in that
 * second (ADR 028). The caller validates the rate and passes a non-negative frame.
 */
function splitGridFrame(frame: bigint, rate: Rational): GridFrame {
  const n = BigInt(rate.n);
  const d = BigInt(rate.d);
  const second = (frame * d) / n;
  // The first frame of that second is ceil(second * rate).
  const firstFrameOfSecond = (second * n + d - 1n) / d;
  const ff = (frame - firstFrameOfSecond)
    .toString()
    .padStart(frameIndexDigits(rate), "0");
  return { second, ff };
}

/**
 * Names frame `frame` of the nominal grid as `HH:MM:SS:FF`. The caller validates the rate and
 * passes a non-negative frame.
 */
function formatGridFrame(frame: bigint, rate: Rational): string {
  const { second, ff } = splitGridFrame(frame, rate);
  return `${formatClock(second)}:${ff}`;
}

/**
 * Returns the frame index `J` that the frame timecode names for a non-negative tick count
 * (ADR 028). The elapsed time is `ticks * timeBase`. The frame boundary margin of the rate and
 * the video time base is added to the whole elapsed time first, then `J` is the index of the
 * nominal frame that contains the result: `floor((elapsed + margin) * rate)`.
 * `formatFrameTimecodeFromTicks` shows this frame. All arithmetic is BigInt, so the result has
 * no rounding error. A negative tick count or an invalid time base or rate returns null.
 *
 * @param ticks Ticks from the start of the source.
 * @param timeBase Seconds per tick.
 * @param nominalRate Frames per second.
 * @param videoTimeBase The video time base of the source, or null for the smallest margin.
 */
export function frameIndexOfTicks(
  ticks: bigint,
  timeBase: Rational,
  nominalRate: Rational,
  videoTimeBase: Rational | null = null,
): bigint | null {
  if (
    !isValidRate(nominalRate) ||
    typeof ticks !== "bigint" ||
    ticks < 0n ||
    !isValidRate(timeBase)
  ) {
    return null;
  }
  const elapsed: ExactSeconds = {
    num: ticks * BigInt(timeBase.n),
    den: BigInt(timeBase.d),
  };
  const margin = frameBoundaryMargin(nominalRate, videoTimeBase);
  // elapsed + margin = (elapsed.num * margin.den + margin.num * elapsed.den) / (elapsed.den * margin.den)
  const shiftedNum = elapsed.num * margin.den + margin.num * elapsed.den;
  const shiftedDen = elapsed.den * margin.den;
  return (shiftedNum * BigInt(nominalRate.n)) / (shiftedDen * BigInt(nominalRate.d));
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
 * a 1/1000 time base, a PTS of 1000 ms plus the 1 ms margin is exactly the start of
 * frame 30, 1001 ms. The tick path shows frame 30, and this path shows frame 29, because
 * the double `1 + 0.001` lies just below 1.001. No frame starts at 1000 ms: frame 29
 * starts at 968 ms, and frame 30 at 1001 ms.
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
  const frame = frameIndexOfTicks(ticks, timeBase, nominalRate, videoTimeBase);
  return frame === null
    ? frameTimecodePlaceholder(nominalRate)
    : formatGridFrame(frame, nominalRate);
}

/**
 * The whole milliseconds that the millisecond format shows for a non-negative time: the
 * time rounded to the millisecond. Null for a value that is not finite, a negative value, or
 * a result that is not a safe integer.
 */
function millisecondIndex(seconds: number): bigint | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const milliseconds = seconds * 1000;
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  const totalMs = Math.round(milliseconds);
  if (!Number.isSafeInteger(totalMs)) {
    return null;
  }
  return BigInt(totalMs);
}

/** The `.mmm` part of a non-negative count of whole milliseconds. */
function millisecondPart(totalMs: bigint): string {
  return `.${(totalMs % 1000n).toString().padStart(3, "0")}`;
}

/** Writes a non-negative count of whole milliseconds as `HH:MM:SS.mmm`. */
function formatMillisecondIndex(totalMs: bigint): string {
  return `${formatClock(totalMs / 1000n)}${millisecondPart(totalMs)}`;
}

/**
 * Formats a non-negative floating-point seconds value as `HH:MM:SS.mmm`, rounded to the
 * millisecond. An invalid value formats as `00:00:00.000`.
 *
 * @param seconds Non-negative finite duration in seconds.
 */
export function formatMillisecondsTimecode(seconds: number): string {
  const totalMs = millisecondIndex(seconds);
  return totalMs === null ? "00:00:00.000" : formatMillisecondIndex(totalMs);
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

/**
 * A signed tick count as a position on the grid of a display: a frame of the nominal grid
 * in the frame format, or whole milliseconds in the millisecond format. A negative tick
 * count has the position of its magnitude with a minus sign, because the timecode of a
 * negative time is the timecode of its magnitude with a minus sign.
 */
interface GridPosition {
  readonly negative: boolean;
  /** The frame index or the whole milliseconds of the magnitude. */
  readonly magnitude: bigint;
}

/**
 * Finds the grid position of a signed tick count, with the rule that its timecode uses.
 *
 * - The frame format takes the frame index `J` of the magnitude from `frameIndexOfTicks`, the
 *   one frame index rule of the frame timecode (ADR 028), with the frame boundary margin of
 *   the display. The arithmetic is exact BigInt.
 * - The millisecond format converts the magnitude to seconds with the checked helper, then
 *   rounds to the millisecond, as `formatMillisecondsTimecode` does for the playhead.
 *
 * Returns null for an invalid time base, a frame display with an invalid rate, or a
 * magnitude that the checked conversion to seconds refuses.
 */
function gridPosition(
  deltaTicks: bigint,
  timeBase: Rational,
  display: TimecodeDisplay,
): GridPosition | null {
  if (typeof deltaTicks !== "bigint" || !isValidRate(timeBase)) {
    return null;
  }
  const negative = deltaTicks < 0n;
  const magnitude = negative ? -deltaTicks : deltaTicks;
  if (display.format === "frames") {
    const frame = frameIndexOfTicks(
      magnitude,
      timeBase,
      display.rate,
      display.videoTimeBase,
    );
    return frame === null ? null : { negative, magnitude: frame };
  }
  const seconds = ticksToSeconds(magnitude.toString() as TickCount, timeBase);
  const totalMs = seconds === null ? null : millisecondIndex(seconds);
  return totalMs === null ? null : { negative, magnitude: totalMs };
}

/** The grid position as a signed count: frames or milliseconds. */
function signedGridIndex(position: GridPosition): bigint {
  return position.negative ? -position.magnitude : position.magnitude;
}

/** Writes a grid position as a timecode. A negative position takes a leading minus sign. */
function formatGridPosition(position: GridPosition, display: TimecodeDisplay): string {
  const formatted =
    display.format === "frames"
      ? formatGridFrame(position.magnitude, display.rate)
      : formatMillisecondIndex(position.magnitude);
  return position.negative ? `-${formatted}` : formatted;
}

/**
 * Formats a signed tick count in a time base as elapsed time in a display's format. A
 * negative count formats as its magnitude with a leading minus sign. The frame format uses
 * exact rational arithmetic, with the frame boundary margin of the display. The millisecond
 * format converts the magnitude to seconds with the checked helper.
 *
 * Returns null for an invalid time base, a frame display with an invalid rate, or a
 * magnitude that is too large for the checked conversion to seconds.
 *
 * @param deltaTicks Ticks from the start of the source.
 * @param timeBase Seconds per tick.
 * @param display The format that applies to the source.
 */
export function formatSignedElapsedTicks(
  deltaTicks: bigint,
  timeBase: Rational,
  display: TimecodeDisplay,
): string | null {
  const position = gridPosition(deltaTicks, timeBase, display);
  return position === null ? null : formatGridPosition(position, display);
}

/**
 * Formats a PTS as elapsed time from the start PTS of its video stream (ADR 003):
 * `(pts - videoStartPts) * videoTimeBase`.
 *
 * The frame format computes `FF` from the exact tick delta, so an exact frame start never
 * shows the frame before it. A negative elapsed time takes a leading minus sign. Invalid
 * input formats as zero.
 *
 * @param pts A presentation timestamp of the source video stream.
 * @param videoStartPts The presentation timestamp origin of the source video stream.
 * @param videoTimeBase The rational time base of the video stream.
 * @param display The timecode format of the source. Defaults to milliseconds.
 */
export function formatSourceRelativeTime(
  pts: Pts,
  videoStartPts: Pts,
  videoTimeBase: Rational,
  display: TimecodeDisplay = MILLISECONDS_TIMECODE_DISPLAY,
): string {
  const zero = formatElapsedTimecode(0, display);
  if (!isPtsString(pts) || !isPtsString(videoStartPts) || !isValidRate(videoTimeBase)) {
    return zero;
  }
  const deltaTicks = BigInt(pts) - BigInt(videoStartPts);
  return formatSignedElapsedTicks(deltaTicks, videoTimeBase, display) ?? zero;
}

/**
 * How a duration is written.
 *
 * - `full` has every group, as the playhead timecode does: `00:00:05:12` or `00:00:05.012`.
 * - `compact` drops the leading groups that are zero. See `formatCompactClock`.
 */
type DurationStyle = "full" | "compact";

/**
 * Writes whole seconds and the part after them (`:FF` or `.mmm`) as a compact duration.
 *
 * It drops the hour group and the minute group while they are zero, and writes the first
 * group that stays without a leading zero, except as below:
 *
 * - Frames: `SS:FF` below one minute, then `M:SS:FF`, then `H:MM:SS:FF`. The seconds keep two
 *   digits below one minute. So a short duration is the tail of its full timecode (`05:12`
 *   ends `00:00:05:12`), and it does not have the `M:SS` shape of a media player clock.
 * - Milliseconds: `S.mmm` below one minute, then `M:SS.mmm`, then `H:MM:SS.mmm`. The decimal
 *   point already marks the seconds.
 */
function formatCompactClock(
  wholeSeconds: bigint,
  rest: string,
  padSeconds: boolean,
): string {
  const ss = wholeSeconds % 60n;
  const totalMinutes = wholeSeconds / 60n;
  const mm = totalMinutes % 60n;
  const hh = totalMinutes / 60n;
  if (hh > 0n) {
    return `${hh.toString()}:${pad2(mm)}:${pad2(ss)}${rest}`;
  }
  if (mm > 0n) {
    return `${mm.toString()}:${pad2(ss)}${rest}`;
  }
  return `${padSeconds ? pad2(ss) : ss.toString()}${rest}`;
}

/**
 * Writes a non-negative count of frames or milliseconds as a duration. The full style is the
 * timecode of the grid position `count`, so it uses the same formatters as the playhead.
 */
function formatGridDuration(
  count: bigint,
  display: TimecodeDisplay,
  style: DurationStyle,
): string {
  if (display.format === "frames") {
    if (style === "full") {
      return formatGridFrame(count, display.rate);
    }
    const { second, ff } = splitGridFrame(count, display.rate);
    return formatCompactClock(second, `:${ff}`, true);
  }
  if (style === "full") {
    return formatMillisecondIndex(count);
  }
  return formatCompactClock(count / 1000n, millisecondPart(count), false);
}

/**
 * Returns the signed grid index of an elapsed tick count: the frame index `J` in the frame
 * format (`frameIndexOfTicks`), or the whole milliseconds in the millisecond format. Each
 * index uses the rule that the playhead timecode uses, so an end shows the same number in a
 * segment tooltip and on the playhead (ADR 022, ADR 028). A negative tick count has the index
 * of its magnitude with a minus sign, as its timecode has.
 *
 * The length of a span of ticks `[a, b)` on the grid is `elapsedGridIndex(b) -
 * elapsedGridIndex(a)`: the difference of the numbers that the timecode shows at the two
 * ends. For several spans, add these lengths. Do not round a tick length `b - a`. A container
 * can store each PTS rounded to its time base, so a tick length can be up to one tick more or
 * less than a whole number of frames or milliseconds, and a length from it can disagree with
 * the two ends. The errors of several spans also add up.
 *
 * Returns null for an invalid time base, a frame display with an invalid rate, or a
 * magnitude that the checked conversion to seconds of the millisecond format refuses.
 *
 * @param deltaTicks Ticks from the start of the source.
 * @param timeBase Seconds per tick.
 * @param display The format that applies to the source.
 */
export function elapsedGridIndex(
  deltaTicks: bigint,
  timeBase: Rational,
  display: TimecodeDisplay,
): bigint | null {
  const position = gridPosition(deltaTicks, timeBase, display);
  return position === null ? null : signedGridIndex(position);
}

/**
 * Returns the last tick count whose timecode names grid index `index` or an earlier one: the
 * last tick of frame `index` in the frame format, or of millisecond `index` in the millisecond
 * format (ADR 028). It inverts `elapsedGridIndex` for a non-negative tick count: every count
 * from 0 up to the result has a grid index at or below `index`, and the count after the result
 * has a greater one.
 *
 * - Frames: the timecode names frame `J` for a tick count `T` when
 *   `floor((T * timeBase + margin) * rate)` is `J`, so the result is
 *   `ceil(((J + 1) / rate - margin) / timeBase) - 1`.
 * - Milliseconds: the timecode rounds `T * timeBase * 1000` to the nearest whole millisecond,
 *   with a tie up, so the result is `ceil((D + 1/2) / (1000 * timeBase)) - 1`.
 *
 * A seek to the result therefore shows the frame whose timecode is the typed value, when a
 * frame starts inside that grid index: the element shows the frame with the latest start at or
 * before the target, and a later frame starts after the result. When no frame starts inside the
 * index, it shows the frame that contains the index. The arithmetic is exact BigInt, and the
 * result is never negative.
 *
 * The millisecond display rounds a double (`gridPosition`), and a tick at an exact half
 * millisecond can round down there, as 15015 ticks of 1/30000 s, 0.5005 s, show `.500`. The
 * result follows the display, so it moves by that one tick. Otherwise a frame that starts on
 * such a tick, as frame 15 at 29.97 fps does, would show `.500` and a typed `.500` would go to
 * the frame before it.
 *
 * Returns null for a negative index, an invalid time base, or a frame display with an invalid
 * rate.
 *
 * @param index The frame index `J` in the frame format, the whole milliseconds `D` in the
 *   millisecond format.
 * @param timeBase Seconds per tick.
 * @param display The format that applies to the source.
 */
export function lastTickOfGridIndex(
  index: bigint,
  timeBase: Rational,
  display: TimecodeDisplay,
): bigint | null {
  if (typeof index !== "bigint" || index < 0n || !isValidRate(timeBase)) {
    return null;
  }
  const tbN = BigInt(timeBase.n);
  const tbD = BigInt(timeBase.d);
  let numerator: bigint;
  let denominator: bigint;
  if (display.format === "frames") {
    if (!isValidRate(display.rate)) {
      return null;
    }
    const n = BigInt(display.rate.n);
    const d = BigInt(display.rate.d);
    const margin = frameBoundaryMargin(display.rate, display.videoTimeBase);
    // ((J + 1) * d / n - margin.num / margin.den) / (tbN / tbD). The margin is less than half
    // a frame interval, so the numerator is positive.
    numerator = ((index + 1n) * d * margin.den - margin.num * n) * tbD;
    denominator = n * margin.den * tbN;
  } else {
    // (D + 1/2) / (1000 * tbN / tbD) = ((2D + 1) * tbD) / (2000 * tbN).
    numerator = (2n * index + 1n) * tbD;
    denominator = 2000n * tbN;
  }
  // ceil(numerator / denominator) - 1 for a positive numerator, and never below 0.
  let last = (numerator + denominator - 1n) / denominator - 1n;
  if (last < 0n) {
    last = 0n;
  }
  if (display.format === "milliseconds") {
    // The display decides a tick at an exact half millisecond (see above).
    const next = elapsedGridIndex(last + 1n, timeBase, display);
    const atLast = elapsedGridIndex(last, timeBase, display);
    if (next !== null && next <= index) {
      last += 1n;
    } else if (atLast !== null && atLast > index && last > 0n) {
      last -= 1n;
    }
  }
  return last;
}

/**
 * Formats a non-negative length on the grid of a display, such as a value that
 * `elapsedGridIndex` differences add up to, in the full style: whole frames as
 * `HH:MM:SS:FF` or whole milliseconds as `HH:MM:SS.mmm`. A frame count is written with the
 * `FF` rule (ADR 028), so 30 frames at 25 fps show `00:00:01:05`, and 30 frames at 29.97 fps
 * show `00:00:01:00`. A negative count, or a frame display with an invalid rate, returns the
 * placeholder of the display.
 *
 * @param count Whole frames in the frame format, whole milliseconds in the millisecond format.
 * @param display The format that applies to the source.
 */
export function formatGridCountTimecode(
  count: bigint,
  display: TimecodeDisplay,
): string {
  if (display.format === "frames" && !isValidRate(display.rate)) {
    return FRAME_TIMECODE_PLACEHOLDER;
  }
  if (typeof count !== "bigint" || count < 0n) {
    return timecodePlaceholder(display);
  }
  return formatGridDuration(count, display, "full");
}

/** The In time, the Out time and the duration of a half-open span of ticks. */
export interface ElapsedTickSpan {
  /** The elapsed time of the start, as `formatSignedElapsedTicks` writes it. */
  readonly inTime: string;
  /** The elapsed time of the end, the first tick after the span (ADR 002). */
  readonly outTime: string;
  /** The duration in the full style: `00:00:05:12` or `00:00:05.012`. */
  readonly duration: string;
  /**
   * The duration in the compact style: `05:12`, `1:05:12` or `1:01:05:12` for frames, and
   * `5.012`, `1:05.012` or `1:01:05.012` for milliseconds.
   */
  readonly compactDuration: string;
}

/**
 * Formats the start, the end and the duration of a half-open span `[inTicks, outTicks)` of
 * elapsed ticks, such as a segment.
 *
 * The duration is the distance between the grid positions of the two ends: the frame index of
 * the Out time minus the frame index of the In time, or the whole milliseconds of the Out time
 * minus those of the In time. Each index uses the rule of its own timecode (ADR 028), so the
 * three values always agree: the In time plus the duration is the Out time. The frame format
 * uses exact BigInt arithmetic.
 *
 * The duration is written with the `HH:MM:SS:FF` rule (ADR 028) applied to the frame count:
 * the whole seconds of the nominal start of frame `count`, and `FF`. So 30 frames at 29.97 fps
 * is `01:00`, as frame 30 is `00:00:01:00`.
 *
 * Returns null when `inTicks` is after `outTicks`, or when either end has no grid position
 * (see `formatSignedElapsedTicks`).
 *
 * @param inTicks The first tick of the span, from the start of the source.
 * @param outTicks The first tick after the span, from the start of the source.
 * @param timeBase Seconds per tick.
 * @param display The format that applies to the source.
 */
export function formatElapsedTickSpan(
  inTicks: bigint,
  outTicks: bigint,
  timeBase: Rational,
  display: TimecodeDisplay,
): ElapsedTickSpan | null {
  if (
    typeof inTicks !== "bigint" ||
    typeof outTicks !== "bigint" ||
    inTicks > outTicks
  ) {
    return null;
  }
  const start = gridPosition(inTicks, timeBase, display);
  const end = gridPosition(outTicks, timeBase, display);
  if (start === null || end === null) {
    return null;
  }
  // The grid position never decreases as the tick count increases, also across zero, so the
  // count is not negative. The check keeps a broken rule from writing a negative length.
  const count = signedGridIndex(end) - signedGridIndex(start);
  if (count < 0n) {
    return null;
  }
  return {
    inTime: formatGridPosition(start, display),
    outTime: formatGridPosition(end, display),
    duration: formatGridDuration(count, display, "full"),
    compactDuration: formatGridDuration(count, display, "compact"),
  };
}
