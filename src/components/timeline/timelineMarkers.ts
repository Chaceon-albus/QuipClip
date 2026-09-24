/**
 * Timeline ruler scale and tick helpers.
 *
 * The ruler spans source time [0, totalDurationSeconds] (ADR 002, ADR 003, ADR 007). It
 * places major ticks on whole multiples of a step from a fixed ladder, and labels them in
 * the timecode format of the source (ADR 028) with the short forms that `rulerLabel.ts`
 * defines.
 *
 * Every tick is display only. The frame steps use the nominal frame rate, and no edit,
 * seek or export reads a tick or snaps to one (ADR 002).
 */

import type { Rational } from "@/types/project";
import { frameIndexDigits, type TimecodeDisplay } from "@/lib/timecode";
import {
  formatRulerLabel,
  millisecondFractionForStep,
  resolveRulerLabelScheme,
  rulerLabelLength,
  rulerLabelWidthPx,
  type RulerLabelFraction,
  type RulerLabelScheme,
} from "./rulerLabel";

/** Upper bound on generated ticks, so a very wide lane cannot flood the DOM. */
export const MAX_QUANTIZED_RULER_TICK_COUNT = 400;

/** The smallest clear space between two label boxes. */
export const RULER_LABEL_GAP_PX = 8;

/**
 * The smallest spacing between two major ticks for labels of `labelLength` characters.
 *
 * A label is centred on its tick, except at the lane edges (`resolveRulerLabelAnchor`).
 * The tightest pair is an edge label next to a centred neighbour: the edge label covers its
 * full width on the inner side of its tick, and the neighbour covers half of its width
 * towards it. So the spacing holds one and a half label widths and the gap.
 *
 * @param labelLength The character count of the longest label.
 */
export function calculateMinRulerTickSpacingPx(labelLength: number): number {
  return Math.ceil(1.5 * rulerLabelWidthPx(labelLength)) + RULER_LABEL_GAP_PX;
}

/**
 * The smallest spacing of any scale, 53 px: the spacing for the shortest label, `MM:SS`.
 * A longer label needs more (`calculateMinRulerTickSpacingPx`): `MM:SS.m` and `H:MM:SS`
 * need 71 px, and `MM:SS:FF` needs 80 px.
 */
export const MIN_RULER_TICK_SPACING_PX = calculateMinRulerTickSpacingPx(5);

/** The smallest spacing between two minor ticks. */
export const MIN_RULER_MINOR_TICK_SPACING_PX = 12;

/**
 * The major steps in whole milliseconds. The millisecond scheme uses every entry. The frame
 * scheme at one frame per second or more uses the entries of one second or more, and whole
 * frames below one second.
 */
export const RULER_STEP_LADDER_MILLISECONDS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
  14_400_000,
] as const;

/** The ladder entries of one second or more. */
const WHOLE_SECOND_STEPS_MILLISECONDS = RULER_STEP_LADDER_MILLISECONDS.filter(
  (value) => value >= 1000,
);

/**
 * The frame steps below one frame per second: 1, 2 and 5 times each power of ten, up to
 * 5,000,000 frames. At such a rate each frame lasts more than one second.
 */
export const RULER_SLOW_FRAME_STEP_LADDER: readonly number[] = Array.from(
  { length: 21 },
  (_, index) => [1, 2, 5][index % 3] * 10 ** Math.floor(index / 3),
);

/** A rate with more frames than this in one second gets no frame steps. */
const MAX_RULER_FRAMES_PER_SECOND = 1000;

/**
 * The interval between two major ticks.
 *
 * - `milliseconds`: a whole number of milliseconds. The frame scheme uses whole seconds
 *   only, and only at one frame per second or more.
 * - `frames`: a whole number of nominal frames. Only the frame scheme uses it.
 *   - At one frame per second or more, the step is below one second. The count starts
 *     again at the first frame of each second, so every second shows the same `FF` values
 *     (ADR 028).
 *   - Below one frame per second, the ticks lie on every `value`-th frame from frame 0.
 */
export type RulerStep =
  | { readonly unit: "milliseconds"; readonly value: number }
  | { readonly unit: "frames"; readonly value: number };

/** The major step and the minor step of a ruler. */
export interface RulerScale {
  readonly major: RulerStep;
  /** The seconds between two minor ticks, or null when no minor step is wide enough. */
  readonly minorSeconds: number | null;
}

/** One major tick and the interval from it to the next tick. */
export interface RulerTick {
  /** The label text (`rulerLabel.ts`). */
  readonly label: string;
  /** Elapsed seconds at the tick. */
  readonly seconds: number;
  /** Offset along the lane, 0..100. */
  readonly percent: number;
  /** CSS left percentage, rounded to four decimals. */
  readonly left: string;
  /** CSS width percentage of the interval to the next tick, or to the lane end. */
  readonly width: string;
  /** Seconds from this tick to the next tick, or to the lane end. */
  readonly intervalSeconds: number;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

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

function ceilDiv(num: bigint, den: bigint): bigint {
  return (num + den - 1n) / den;
}

/** The nominal rate of the frame scheme, or null for the millisecond scheme. */
function frameRateOf(display: TimecodeDisplay): Rational | null {
  return display.format === "frames" && isValidRate(display.rate) ? display.rate : null;
}

/**
 * True below one frame per second.
 *
 * At one frame per second or more, every second holds a frame start, and the tick of
 * second `s` lies on the nominal start of the first frame of that second: the frame that
 * the preview shows as `SS:00`. Below one frame per second, each frame lasts more than one
 * second, so a second holds one frame start or none. The preview shows the frame that
 * contains the time, so a tick on a whole second could name a frame that does not start
 * there. The ruler puts every tick on a frame start instead
 * (`RULER_SLOW_FRAME_STEP_LADDER`), and the preview shows each of them as `SS:00`.
 */
function isSlowRate(rate: Rational): boolean {
  return rate.n < rate.d;
}

function isIntegerRate(rate: Rational): boolean {
  return rate.n % rate.d === 0;
}

/** The nominal start of the first frame of second `second`, `ceil(second * rate) / rate`. */
function firstFrameStartSeconds(second: number, rate: Rational): number {
  const frame = ceilDiv(BigInt(second) * BigInt(rate.n), BigInt(rate.d));
  return Number(frame * BigInt(rate.d)) / rate.n;
}

/**
 * The frame steps for a rate: every divisor of `ceil(rate)` below it, in ascending order.
 * A step that divides the frame count of a second repeats the same `FF` values in every
 * second. A rate below two frames per second, or above 1000, has no frame steps here.
 * Below one frame per second, the ruler uses RULER_SLOW_FRAME_STEP_LADDER instead.
 *
 * @param rate The nominal frame rate.
 */
export function rulerFrameStepLadder(rate: Rational): number[] {
  if (!isValidRate(rate)) {
    return [];
  }
  const perSecond = Number(ceilDiv(BigInt(rate.n), BigInt(rate.d)));
  if (perSecond > MAX_RULER_FRAMES_PER_SECOND) {
    return [];
  }
  const steps: number[] = [];
  for (let frames = 1; frames < perSecond; frames++) {
    if (perSecond % frames === 0) {
      steps.push(frames);
    }
  }
  return steps;
}

/** The major step candidates of a display, in ascending order. */
function candidateSteps(display: TimecodeDisplay): RulerStep[] {
  const rate = frameRateOf(display);
  if (rate === null) {
    return RULER_STEP_LADDER_MILLISECONDS.map((value) => ({
      unit: "milliseconds" as const,
      value,
    }));
  }
  if (isSlowRate(rate)) {
    return RULER_SLOW_FRAME_STEP_LADDER.map((value) => ({
      unit: "frames" as const,
      value,
    }));
  }
  return [
    ...rulerFrameStepLadder(rate).map((value) => ({ unit: "frames" as const, value })),
    ...WHOLE_SECOND_STEPS_MILLISECONDS.map((value) => ({
      unit: "milliseconds" as const,
      value,
    })),
  ];
}

/** The nominal length of a step in seconds, or null when a frame step has no rate. */
function stepSeconds(step: RulerStep, display: TimecodeDisplay): number | null {
  if (step.unit === "milliseconds") {
    return step.value / 1000;
  }
  const rate = frameRateOf(display);
  return rate === null ? null : (step.value * rate.d) / rate.n;
}

/**
 * The shortest interval between two ticks of a step. On the frame grid of a rate of one
 * frame per second or more that is not a whole number, such as 29.97 fps, a second holds
 * one frame less than `ceil(rate)` now and then, so the last frame step of that second is
 * one frame shorter, and a whole-second tick can lie up to one frame after its second.
 * Below one frame per second, the ticks lie on a uniform frame grid.
 */
function shortestIntervalSeconds(step: RulerStep, display: TimecodeDisplay): number {
  const nominal = stepSeconds(step, display) ?? 0;
  const rate = frameRateOf(display);
  if (rate === null || isIntegerRate(rate) || isSlowRate(rate)) {
    return nominal;
  }
  const frameSeconds = rate.d / rate.n;
  if (step.unit === "frames") {
    return step.value >= 2 ? nominal - frameSeconds : nominal;
  }
  return step.value % 1000 === 0 ? nominal - frameSeconds : nominal;
}

/** An upper bound on the number of ticks of a step. */
function estimateTickCount(
  totalDurationSeconds: number,
  step: RulerStep,
  display: TimecodeDisplay,
): number {
  if (step.unit === "frames") {
    const rate = frameRateOf(display);
    if (rate === null) {
      return Infinity;
    }
    if (isSlowRate(rate)) {
      return Math.floor((totalDurationSeconds * rate.n) / (rate.d * step.value)) + 1;
    }
    const perSecond = Number(ceilDiv(BigInt(rate.n), BigInt(rate.d)));
    return (Math.floor(totalDurationSeconds) + 1) * Math.ceil(perSecond / step.value);
  }
  return Math.floor((totalDurationSeconds * 1000) / step.value) + 1;
}

function labelFractionForStep(
  step: RulerStep,
  display: TimecodeDisplay,
): RulerLabelFraction {
  if (step.unit === "frames") {
    const rate = frameRateOf(display);
    if (rate !== null && isSlowRate(rate)) {
      // Below one frame per second, every tick lies on a frame start, which the preview
      // shows with `FF` 00.
      return { kind: "none" };
    }
    return { kind: "frames", digits: rate === null ? 2 : frameIndexDigits(rate) };
  }
  return millisecondFractionForStep(step.value);
}

/**
 * The label scheme of a step: the hours when the source is 1 h or longer, and the fraction
 * that the step needs.
 *
 * @param totalDurationSeconds The source extent in seconds.
 * @param step The major step.
 * @param display The timecode format of the source.
 */
export function resolveRulerStepLabelScheme(
  totalDurationSeconds: number,
  step: RulerStep,
  display: TimecodeDisplay,
): RulerLabelScheme {
  return resolveRulerLabelScheme(
    totalDurationSeconds,
    labelFractionForStep(step, display),
  );
}

/**
 * The minor step candidates for a major step, in seconds, in ascending order.
 *
 * Each interval starts its minor ticks at its own major tick and repeats them at one
 * period, so a minor step is a candidate only where that period keeps it on the grid of
 * the major ticks:
 *
 * - A frame major takes the frame steps of its ladder that divide it.
 * - A whole-second major in the millisecond scheme, or at a whole-number rate, takes the
 *   whole frames that divide one second and the whole seconds that divide it. Every second
 *   then starts on a frame.
 * - A whole-second major at a rate that is not a whole number lies on a frame start: the
 *   first frame of its second. It takes the whole frames that divide one second, because a
 *   minor then adds whole frames to a frame start and lies on a frame start too. Under a
 *   major of 1 s, those minors start again with each second. Under a longer major they do
 *   not, and `calculateMinorTickPeriod` drops a period that does not fit in the interval.
 * - A major of 2 s or more at such a rate lies up to one frame after its second, so a
 *   whole-second minor at `k` s after it lands up to one frame before the first frame of
 *   its second, inside the last frame of the second before: about 0.33 s early at 1.5 fps.
 *   Such a major takes whole-second minors only while one frame is narrower than one pixel.
 *
 * @param major The major step.
 * @param display The timecode format of the source.
 * @param pxPerSecond The lane pixels for each second of source.
 */
function minorCandidateSeconds(
  major: RulerStep,
  display: TimecodeDisplay,
  pxPerSecond: number,
): number[] {
  const dividing = (ladder: readonly number[]) =>
    ladder.filter((value) => value < major.value && major.value % value === 0);
  const rate = frameRateOf(display);
  if (major.unit === "frames") {
    if (rate === null) {
      return [];
    }
    const ladder = isSlowRate(rate)
      ? RULER_SLOW_FRAME_STEP_LADDER
      : rulerFrameStepLadder(rate);
    return dividing(ladder).map((frames) => (frames * rate.d) / rate.n);
  }
  if (rate === null) {
    return dividing(RULER_STEP_LADDER_MILLISECONDS).map((value) => value / 1000);
  }
  if (isSlowRate(rate) || major.value % 1000 !== 0) {
    return [];
  }
  const frameMinors = rulerFrameStepLadder(rate).map(
    (frames) => (frames * rate.d) / rate.n,
  );
  const secondMinors = dividing(WHOLE_SECOND_STEPS_MILLISECONDS).map(
    (value) => value / 1000,
  );
  // A major of 1 s has no whole-second minors, so this keeps its frame minors only.
  const framePx = (rate.d / rate.n) * pxPerSecond;
  return isIntegerRate(rate) || framePx < 1
    ? [...frameMinors, ...secondMinors]
    : frameMinors;
}

/**
 * Chooses the major step and the minor step for a lane of the given pixel width.
 *
 * The major step is the smallest candidate whose shortest interval holds its labels
 * (`calculateMinRulerTickSpacingPx`) and that gives no more than
 * MAX_QUANTIZED_RULER_TICK_COUNT ticks. When no candidate fits, it is the largest
 * candidate. The millisecond scheme takes its candidates from
 * RULER_STEP_LADDER_MILLISECONDS. The frame scheme takes whole frames below one second
 * (`rulerFrameStepLadder`), then the whole seconds of that ladder. Below one frame per
 * second, it takes every `k`-th frame (`RULER_SLOW_FRAME_STEP_LADDER`).
 *
 * The minor step is the smallest candidate (`minorCandidateSeconds`) that is at least
 * MIN_RULER_MINOR_TICK_SPACING_PX wide, or null when none is.
 *
 * Returns null when the duration or the width cannot produce ticks.
 *
 * @param totalDurationSeconds The source extent in seconds.
 * @param laneWidthPx The width of the lane.
 * @param display The timecode format of the source (`resolveTimecodeDisplay`).
 */
export function calculateRulerScale(
  totalDurationSeconds: number | null | undefined,
  laneWidthPx: number,
  display: TimecodeDisplay,
): RulerScale | null {
  if (!isPositiveFinite(totalDurationSeconds) || !isPositiveFinite(laneWidthPx)) {
    return null;
  }

  const pxPerSecond = laneWidthPx / totalDurationSeconds;
  const candidates = candidateSteps(display);
  let major = candidates[candidates.length - 1];
  for (const step of candidates) {
    const labelLength = rulerLabelLength(
      resolveRulerStepLabelScheme(totalDurationSeconds, step, display),
    );
    const spacingPx = shortestIntervalSeconds(step, display) * pxPerSecond;
    if (
      spacingPx >= calculateMinRulerTickSpacingPx(labelLength) &&
      estimateTickCount(totalDurationSeconds, step, display) <=
        MAX_QUANTIZED_RULER_TICK_COUNT
    ) {
      major = step;
      break;
    }
  }

  const minorSeconds =
    minorCandidateSeconds(major, display, pxPerSecond).find(
      (seconds) => seconds * pxPerSecond >= MIN_RULER_MINOR_TICK_SPACING_PX,
    ) ?? null;

  return { major, minorSeconds };
}

function roundPercent(percent: number): number {
  return Math.round(percent * 10_000) / 10_000;
}

/**
 * Generates the major ticks of a step, with their labels and the intervals between them.
 *
 * - A millisecond step puts tick `j` at `j * step`.
 * - In the frame scheme, a whole-second step puts the tick of second `s` on the nominal
 *   start of the first frame of that second (`firstFrameStartSeconds`). For a whole-number rate that is
 *   `s` itself.
 * - A frame step puts ticks on every `step`-th frame from the first frame of each second.
 *   At a rate such as 29.97 fps, the last interval of a second can be one frame shorter.
 * - Below one frame per second, a frame step puts ticks on every `step`-th frame from
 *   frame 0. The label of frame `f` shows the whole seconds of its start, `f / rate`
 *   rounded down, as the preview does.
 *
 * The last tick is no later than the source extent. Its interval runs to the lane end.
 * Returns an empty array when the duration or the step is unusable, and for a millisecond
 * step below one frame per second, which the frame scheme does not use there.
 *
 * @param totalDurationSeconds The source extent in seconds.
 * @param display The timecode format of the source.
 * @param major The major step (`calculateRulerScale`).
 */
export function generateRulerTicks(
  totalDurationSeconds: number | null | undefined,
  display: TimecodeDisplay,
  major: RulerStep | null,
): RulerTick[] {
  if (
    !isPositiveFinite(totalDurationSeconds) ||
    major === null ||
    !Number.isSafeInteger(major.value) ||
    major.value <= 0
  ) {
    return [];
  }

  const duration = totalDurationSeconds;
  const scheme = resolveRulerStepLabelScheme(duration, major, display);
  const points: { seconds: number; label: string }[] = [];

  if (major.unit === "frames") {
    const rate = frameRateOf(display);
    if (rate === null) {
      return [];
    }
    const n = BigInt(rate.n);
    const d = BigInt(rate.d);
    const step = BigInt(major.value);
    if (isSlowRate(rate)) {
      // Every `step`-th frame from frame 0. The whole seconds of the start of frame `f` are
      // `f * d / n` rounded down, as `formatFrameTimecode` shows them.
      for (
        let frame = 0n;
        points.length < MAX_QUANTIZED_RULER_TICK_COUNT;
        frame += step
      ) {
        const seconds = Number(frame * d) / rate.n;
        if (seconds > duration) {
          break;
        }
        points.push({
          seconds,
          label: formatRulerLabel(
            { seconds: Number((frame * d) / n), fraction: 0 },
            scheme,
          ),
        });
      }
    } else {
      let next = 0n;
      fill: for (let second = 0; second <= duration; second++) {
        const first = next;
        next = ceilDiv(BigInt(second + 1) * n, d);
        for (let frame = first; frame < next; frame += step) {
          const seconds = Number(frame * d) / rate.n;
          if (seconds > duration || points.length >= MAX_QUANTIZED_RULER_TICK_COUNT) {
            break fill;
          }
          points.push({
            seconds,
            label: formatRulerLabel(
              { seconds: second, fraction: Number(frame - first) },
              scheme,
            ),
          });
        }
      }
    }
  } else {
    const rate = frameRateOf(display);
    if (rate !== null && isSlowRate(rate)) {
      return [];
    }
    const alignedRate = major.value % 1000 === 0 ? rate : null;
    for (let index = 0; points.length < MAX_QUANTIZED_RULER_TICK_COUNT; index++) {
      const totalMilliseconds = index * major.value;
      if (!Number.isSafeInteger(totalMilliseconds)) {
        break;
      }
      const wholeSeconds = Math.floor(totalMilliseconds / 1000);
      const seconds =
        alignedRate === null
          ? totalMilliseconds / 1000
          : firstFrameStartSeconds(wholeSeconds, alignedRate);
      if (seconds > duration) {
        break;
      }
      points.push({
        seconds,
        label: formatRulerLabel(
          { seconds: wholeSeconds, fraction: totalMilliseconds % 1000 },
          scheme,
        ),
      });
    }
  }

  const rounded = points.map(({ seconds }) =>
    roundPercent(seconds >= duration ? 100 : (seconds / duration) * 100),
  );

  return points.map(({ seconds, label }, index): RulerTick => {
    const isLast = index === points.length - 1;
    const nextSeconds = isLast ? duration : points[index + 1].seconds;
    const nextPercent = isLast ? 100 : rounded[index + 1];
    return {
      label,
      seconds,
      percent: seconds >= duration ? 100 : (seconds / duration) * 100,
      left: `${rounded[index]}%`,
      width: `${roundPercent(nextPercent - rounded[index])}%`,
      intervalSeconds: nextSeconds - seconds,
    };
  });
}

/**
 * The period of the minor ticks inside one interval, as a CSS percentage of the interval
 * width. The minor ticks start again at each major tick, so they stay on the step of that
 * tick. Returns null when no minor step is set or no minor tick falls inside the interval.
 *
 * The percentage is rounded up to four decimals. When the minor step divides the interval
 * `m` times, the `m`-th repeat then lies at 100% or after it, at the next major tick, and
 * never a fraction of a pixel before it.
 *
 * @param minorSeconds The minor step (`calculateRulerScale`).
 * @param intervalSeconds The interval of the tick (`RulerTick.intervalSeconds`).
 */
export function calculateMinorTickPeriod(
  minorSeconds: number | null,
  intervalSeconds: number,
): string | null {
  if (!isPositiveFinite(minorSeconds) || !isPositiveFinite(intervalSeconds)) {
    return null;
  }
  const percent = Math.ceil((minorSeconds / intervalSeconds) * 100 * 10_000) / 10_000;
  return percent > 0 && percent < 100 ? `${percent}%` : null;
}
