/**
 * Pure presenter for the status bar item that describes the open source.
 *
 * Version 1 has no project format of its own, so the item states the coded frame size and the
 * nominal frame rate that ffprobe reported for the source. Returns translation keys and values
 * without calling the i18n runtime (ADR 011).
 */

import type { MediaProbe } from "@/features/media";
import { getNominalFrameRate } from "@/features/playback";

/** Exactly the probe fields that the item reads. */
export type SourceInfoProbe = Pick<
  MediaProbe,
  "width" | "height" | "avgFrameRate" | "rFrameRate"
>;

export type SourceInfoLineKey =
  "statusBar.source.summary" | "statusBar.source.summaryNoRate";

export type SourceInfoDetailKey =
  | "statusBar.source.resolution"
  | "statusBar.source.rateAverage"
  | "statusBar.source.rateReal"
  | "statusBar.source.rateUnavailable";

export interface SourceInfoDetailEntry {
  readonly key: SourceInfoDetailKey;
  readonly values: Readonly<Record<string, string>>;
}

export interface SourceInfoView {
  /** The status bar line, such as `1920 × 1080 · 29.97 fps`. */
  readonly lineKey: SourceInfoLineKey;
  readonly lineValues: Readonly<Record<string, string>>;
  /** The tooltip lines. They name each value and the ffprobe field of the rate. */
  readonly detail: readonly SourceInfoDetailEntry[];
}

/**
 * Returns the item view, or null when no source is open. With no source there is nothing to
 * describe, so the status bar shows no item instead of an invented default.
 *
 * The rate follows ADR 003: a valid `avg_frame_rate` first, a valid `r_frame_rate` second.
 * The conversion to a number is for display only (ADR 002).
 *
 * @param probe The probe of the open source, or null when no source is open.
 * @param number Formats the frame rate for the resolved interface language.
 */
export function presentSourceInfo(
  probe: SourceInfoProbe | null,
  number: Intl.NumberFormat,
): SourceInfoView | null {
  if (probe === null) {
    return null;
  }

  // A frame size is a technical identifier, not a counted quantity, so it keeps its defined
  // format and never takes digit grouping: 1920 × 1080, never 1,920 × 1,080. The frame rate
  // IS a measured quantity and goes through `Intl`.
  const size = { width: String(probe.width), height: String(probe.height) };

  const rate = getNominalFrameRate(probe);
  if (rate === null) {
    return {
      lineKey: "statusBar.source.summaryNoRate",
      lineValues: size,
      detail: [
        { key: "statusBar.source.resolution", values: size },
        { key: "statusBar.source.rateUnavailable", values: {} },
      ],
    };
  }

  const fps = number.format(rate.n / rate.d);
  // `getNominalFrameRate` returns the probe's own object, so the identity names the field.
  const rateKey =
    rate === probe.avgFrameRate
      ? "statusBar.source.rateAverage"
      : "statusBar.source.rateReal";

  return {
    lineKey: "statusBar.source.summary",
    lineValues: { ...size, fps },
    detail: [
      { key: "statusBar.source.resolution", values: size },
      { key: rateKey, values: { fps } },
    ],
  };
}
