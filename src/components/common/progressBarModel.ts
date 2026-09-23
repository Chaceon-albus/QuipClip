export type ProgressBarMode = "determinate" | "indeterminate";

export interface ProgressBarModel {
  mode: ProgressBarMode;
  /** Clamped fill width in percent, 0 to 100. Null in the indeterminate mode. */
  fillPercent: number | null;
  /** Clamped and rounded value for aria-valuenow. Undefined in the indeterminate mode. */
  ariaValueNow: number | undefined;
}

/**
 * Resolves the display mode, fill percentage, and accessibility value for a progress bar.
 *
 * Missing, non-numeric, or non-finite inputs yield the indeterminate mode where the bar has
 * no numeric position. Finite inputs are clamped to [0, 100], preserving fractional percentages
 * for CSS width while rounding to whole numbers for the aria-valuenow attribute.
 */
export function resolveProgressBarModel(
  value: number | null | undefined,
): ProgressBarModel {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return {
      mode: "indeterminate",
      fillPercent: null,
      ariaValueNow: undefined,
    };
  }

  const clamped = Math.min(100, Math.max(0, value));

  return {
    mode: "determinate",
    fillPercent: clamped,
    ariaValueNow: Math.round(clamped),
  };
}
