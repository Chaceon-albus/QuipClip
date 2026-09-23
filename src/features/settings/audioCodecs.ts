/**
 * Audio codec constants, bitrate rules, and container compatibility checks.
 *
 * Implements audio controls and compatibility constraints per ADR 023.
 * Pure module with no React and no i18next dependencies.
 */

import type { PresetContainer } from "./types";

/**
 * Audio encoders that produce lossless output.
 * Lossless encoders have no bitrate setting; their bitrates are determined by source audio (ADR 023).
 */
export const LOSSLESS_AUDIO_ENCODERS = ["flac", "alac"] as const;

export type LosslessAudioEncoder = (typeof LOSSLESS_AUDIO_ENCODERS)[number];

/**
 * Checks whether an encoder name matches one of the known lossless audio encoders.
 */
export function isLosslessAudioEncoder(name: string): boolean {
  return (LOSSLESS_AUDIO_ENCODERS as readonly string[]).includes(name);
}

/**
 * Default audio bitrate in kilobits per second (kbps) when transitioning from a lossless
 * encoder to a lossy encoder without a stored bitrate, or seeding new presets (ADR 023).
 */
export const DEFAULT_AUDIO_BITRATE_KBPS = 320;

/**
 * Recommended bitrate choices in kbps for libopus.
 * libopus supports higher efficiency across low and high bitrates up to 510 kbps.
 */
const OPUS_AUDIO_BITRATE_CHOICES = [64, 96, 128, 160, 192, 256, 320, 510] as const;

/**
 * Standard recommended bitrate choices in kbps for general lossy audio encoders (AAC, MP3, etc.).
 */
const STANDARD_AUDIO_BITRATE_CHOICES = [96, 128, 160, 192, 256, 320] as const;

/**
 * Returns available bitrate choices for a given audio encoder.
 *
 * - Returns `[]` for lossless encoders (`flac`, `alac`), which have no bitrate setting.
 * - Returns `[64, 96, 128, 160, 192, 256, 320, 510]` for `libopus`.
 * - Returns `[96, 128, 160, 192, 256, 320]` for every other name, including custom names.
 */
export function audioBitrateChoices(encoder: string): readonly number[] {
  if (isLosslessAudioEncoder(encoder)) {
    return [];
  }
  if (encoder === "libopus") {
    return OPUS_AUDIO_BITRATE_CHOICES;
  }
  return STANDARD_AUDIO_BITRATE_CHOICES;
}

/**
 * Common standard audio sample rates in hertz (Hz) available in the preset editor.
 */
export const AUDIO_SAMPLE_RATE_CHOICES = [44100, 48000, 96000] as const;

/**
 * Checks whether a given audio encoder is allowed inside the specified container format.
 *
 * Measurements on ffmpeg 9.0.2 (macOS) demonstrate that the mov muxer explicitly refuses
 * flac and opus with messages:
 * - "flac only supported in MP4"
 * - "opus only supported in MP4"
 *
 * Therefore, `mov` refuses `flac` and `libopus`. Every other container-encoder pair is allowed,
 * including unknown or custom encoder names, because FFmpeg itself is the final authority and
 * reports any muxing errors during export execution (ADR 023).
 */
export function isAudioEncoderAllowedIn(
  container: PresetContainer,
  encoder: string,
): boolean {
  if (container === "mov" && (encoder === "flac" || encoder === "libopus")) {
    return false;
  }
  return true;
}
