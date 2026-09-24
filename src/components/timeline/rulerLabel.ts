/**
 * The text of a ruler label and its horizontal placement (ADR 028).
 *
 * A ruler label is a short form of the timecode that the preview shows. It keeps only the
 * fields that the tick step can change:
 *
 * | Step                  | Source shorter than 1 h | Source of 1 h or longer |
 * | --------------------- | ----------------------- | ----------------------- |
 * | 1 s or more           | `MM:SS`                 | `H:MM:SS`               |
 * | Whole frames, < 1 s   | `MM:SS:FF`              | `H:MM:SS:FF`            |
 * | 100 ms to 500 ms      | `MM:SS.m`               | `H:MM:SS.m`             |
 * | 10 ms to 50 ms        | `MM:SS.mm`              | `H:MM:SS.mm`            |
 * | 1 ms to 5 ms          | `MM:SS.mmm`             | `H:MM:SS.mmm`           |
 *
 * The last clock field is always seconds, so a label never reads as `HH:MM` where it means
 * `MM:SS`. The hours are not padded, so `0:05:12` (hours) and `00:05:12` (minutes, seconds
 * and frames) have different shapes. All labels on one ruler have one shape, because the
 * shape depends only on the step and on the source extent.
 *
 * The functions here are pure. The labels are display only (ADR 002): no edit, seek or
 * export reads them.
 */

/** How a label writes the part of the time below one second. */
export type RulerLabelFraction =
  | { readonly kind: "none" }
  /** `.m`, `.mm` or `.mmm`: the milliseconds cut to the precision of the step. */
  | { readonly kind: "milliseconds"; readonly digits: 1 | 2 | 3 }
  /** `:FF`: the index of the frame among the frames that start in that second. */
  | { readonly kind: "frames"; readonly digits: number };

/** The shape of every label on one ruler. */
export interface RulerLabelScheme {
  /** True when the source is 1 h or longer. Every label then shows the hours. */
  readonly showHours: boolean;
  /** The number of hour digits that the longest label needs. */
  readonly hourDigits: number;
  readonly fraction: RulerLabelFraction;
}

/** The time that one label names, as exact integers. */
export interface RulerLabelTime {
  /** Whole seconds from the start of the source. */
  readonly seconds: number;
  /**
   * The milliseconds (0 to 999) for a millisecond fraction, or the `FF` index for a frame
   * fraction. A scheme with no fraction ignores it.
   */
  readonly fraction: number;
}

/** Sources of this extent or longer show the hours in every label. */
export const RULER_HOURS_THRESHOLD_SECONDS = 3600;

/** The label for a time that cannot be written, such as a negative time. */
const INVALID_LABEL = "--:--";

function pad(value: number, digits: number): string {
  return String(value).padStart(digits, "0");
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * The label scheme for a source extent and a step.
 *
 * @param durationSeconds The source extent in seconds.
 * @param fraction The fraction that the step needs.
 */
export function resolveRulerLabelScheme(
  durationSeconds: number,
  fraction: RulerLabelFraction,
): RulerLabelScheme {
  const showHours =
    Number.isFinite(durationSeconds) &&
    durationSeconds >= RULER_HOURS_THRESHOLD_SECONDS;
  const hours = showHours
    ? Math.floor(durationSeconds / RULER_HOURS_THRESHOLD_SECONDS)
    : 0;
  return {
    showHours,
    hourDigits: showHours ? String(hours).length : 0,
    fraction,
  };
}

/**
 * The millisecond fraction for a step of whole milliseconds: no fraction for whole
 * seconds, else the digits down to the last digit that the step changes.
 *
 * @param stepMilliseconds A positive whole number of milliseconds.
 */
export function millisecondFractionForStep(
  stepMilliseconds: number,
): RulerLabelFraction {
  if (!isNonNegativeSafeInteger(stepMilliseconds) || stepMilliseconds % 1000 === 0) {
    return { kind: "none" };
  }
  if (stepMilliseconds % 100 === 0) {
    return { kind: "milliseconds", digits: 1 };
  }
  if (stepMilliseconds % 10 === 0) {
    return { kind: "milliseconds", digits: 2 };
  }
  return { kind: "milliseconds", digits: 3 };
}

/** The character count of the longest label of a scheme. */
export function rulerLabelLength(scheme: RulerLabelScheme): number {
  // `MM:SS` has 5 characters. `H:` adds the hour digits and a colon.
  const clock = scheme.showHours ? scheme.hourDigits + 1 + 5 : 5;
  switch (scheme.fraction.kind) {
    case "none":
      return clock;
    case "milliseconds":
    case "frames":
      return clock + 1 + scheme.fraction.digits;
  }
}

/**
 * Writes one ruler label.
 *
 * The caller passes a time on the tick step, so the millisecond digits that the scheme
 * cuts off are zeros. A time that is not a non-negative whole number of seconds with a
 * valid fraction gives `--:--`.
 *
 * @param time The whole seconds and the fraction of the tick.
 * @param scheme The shape of the labels on the ruler.
 */
export function formatRulerLabel(
  time: RulerLabelTime,
  scheme: RulerLabelScheme,
): string {
  const { seconds, fraction } = time;
  if (!isNonNegativeSafeInteger(seconds)) {
    return INVALID_LABEL;
  }

  const ss = seconds % 60;
  const totalMinutes = Math.floor(seconds / 60);
  const clock = scheme.showHours
    ? `${Math.floor(totalMinutes / 60)}:${pad(totalMinutes % 60, 2)}:${pad(ss, 2)}`
    : `${pad(totalMinutes, 2)}:${pad(ss, 2)}`;

  switch (scheme.fraction.kind) {
    case "none":
      return clock;
    case "milliseconds": {
      if (!isNonNegativeSafeInteger(fraction) || fraction > 999) {
        return INVALID_LABEL;
      }
      return `${clock}.${pad(fraction, 3).slice(0, scheme.fraction.digits)}`;
    }
    case "frames": {
      if (!isNonNegativeSafeInteger(fraction)) {
        return INVALID_LABEL;
      }
      return `${clock}:${pad(fraction, scheme.fraction.digits)}`;
    }
  }
}

/**
 * The width budget of one label character. Geist Mono advances 0.6 em for every glyph, so
 * a character of the 10 px ruler text is 6 px wide. The fallback monospace fonts are no
 * wider.
 */
export const RULER_LABEL_CHAR_WIDTH_PX = 6;

/** The width budget of a label of `length` characters. */
export function rulerLabelWidthPx(length: number): number {
  return Math.max(0, length) * RULER_LABEL_CHAR_WIDTH_PX;
}

/**
 * Where a label sits against its tick.
 *
 * - `center`: the label is centred on the tick.
 * - `start`: the left edge of the label is on the tick (`translate-x-0`).
 * - `end`: the right edge of the label is on the tick (`-translate-x-full`).
 */
export type RulerLabelAnchor = "center" | "start" | "end";

/**
 * Chooses the anchor of one label. A centred label that would start before the lane start
 * is anchored at its start, so the sticky gutter does not cover half of it. A centred label
 * that would end after the lane end is anchored at its end, so the clip at the end of the
 * lane does not cut it. A lane narrower than the label anchors at the start.
 *
 * @param tickPx The tick position in pixels from the lane start.
 * @param labelWidthPx The width of the label.
 * @param laneWidthPx The width of the lane.
 */
export function resolveRulerLabelAnchor(
  tickPx: number,
  labelWidthPx: number,
  laneWidthPx: number,
): RulerLabelAnchor {
  if (
    !Number.isFinite(tickPx) ||
    !Number.isFinite(labelWidthPx) ||
    !Number.isFinite(laneWidthPx) ||
    labelWidthPx <= 0 ||
    laneWidthPx <= 0
  ) {
    return "center";
  }
  const half = labelWidthPx / 2;
  if (tickPx - half < 0) {
    return "start";
  }
  if (tickPx + half > laneWidthPx) {
    return "end";
  }
  return "center";
}

/** The number of labels that anchor at each end of the lane. */
export interface RulerEdgeAnchorCounts {
  /** The first `start` labels anchor at their start. */
  readonly start: number;
  /** The last `end` labels anchor at their end. */
  readonly end: number;
}

/**
 * Counts the labels that anchor at the lane start and at the lane end. Ticks increase
 * along the lane, so the start anchors are a prefix and the end anchors are a suffix.
 * The ruler takes the two counts as numbers, so a zoom that keeps the counts does not
 * render the ticks again.
 *
 * @param ticks The ticks in lane order, with their percent offset and their label.
 * @param laneWidthPx The width of the lane.
 */
export function countRulerEdgeAnchors(
  ticks: readonly { readonly percent: number; readonly label: string }[],
  laneWidthPx: number,
): RulerEdgeAnchorCounts {
  const anchorAt = (index: number): RulerLabelAnchor => {
    const tick = ticks[index];
    return resolveRulerLabelAnchor(
      (tick.percent / 100) * laneWidthPx,
      rulerLabelWidthPx(tick.label.length),
      laneWidthPx,
    );
  };

  let start = 0;
  while (start < ticks.length && anchorAt(start) === "start") {
    start++;
  }
  let end = 0;
  while (end < ticks.length - start && anchorAt(ticks.length - 1 - end) === "end") {
    end++;
  }
  return { start, end };
}
