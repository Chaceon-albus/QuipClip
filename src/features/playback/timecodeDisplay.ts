/**
 * Chooses the timecode format that applies to one source (ADR 028).
 */

import { isPositiveRational } from "@/features/media/validation";
import {
  MILLISECONDS_TIMECODE_DISPLAY,
  type TimecodeDisplay,
  type TimecodeFormat,
} from "@/lib/timecode";
import { getNominalFrameRate, hasVariableFrameRate } from "./store";
import type { PlaybackSource } from "./types";

/** Exactly the probe fields that the choice reads. */
export type TimecodeRateSource = Pick<
  PlaybackSource,
  "avgFrameRate" | "rFrameRate" | "videoTimeBase"
>;

/**
 * Returns the display for a source: the user's format, with the nominal rate that `FF`
 * counts and the video time base that sets the frame boundary margin when that format is
 * frames.
 *
 * The millisecond format applies in three cases:
 *
 * - The preference is milliseconds.
 * - No source is open, or the source has no nominal frame rate.
 * - The source reports a valid average frame rate and a valid real frame rate, and the two
 *   differ. The source then has a variable frame rate, and `FF` would not name a frame.
 *
 * Otherwise the frame format applies, with the rate the status bar reports: a valid
 * `avg_frame_rate` first, a valid `r_frame_rate` second (ADR 003).
 *
 * @param preference The format the user selected.
 * @param source The frame rates and the video time base of the open source, or null when
 *   no source is open.
 */
export function resolveTimecodeDisplay(
  preference: TimecodeFormat,
  source: TimecodeRateSource | null | undefined,
): TimecodeDisplay {
  if (preference === "milliseconds" || !source) {
    return MILLISECONDS_TIMECODE_DISPLAY;
  }
  const rate = getNominalFrameRate(source);
  if (rate === null || hasVariableFrameRate(source)) {
    return MILLISECONDS_TIMECODE_DISPLAY;
  }
  const videoTimeBase = isPositiveRational(source.videoTimeBase)
    ? source.videoTimeBase
    : null;
  return { format: "frames", rate, videoTimeBase };
}

/**
 * Returns the format that applies to a source. See `resolveTimecodeDisplay` for the rule.
 *
 * @param preference The format the user selected.
 * @param source The frame rates and the video time base of the open source, or null when
 *   no source is open.
 */
export function resolveTimecodeFormat(
  preference: TimecodeFormat,
  source: TimecodeRateSource | null | undefined,
): TimecodeFormat {
  return resolveTimecodeDisplay(preference, source).format;
}
