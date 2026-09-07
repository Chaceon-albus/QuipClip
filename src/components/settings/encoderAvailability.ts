/**
 * Pure module deriving encoder availability and building selection options
 * for the export preset editor.
 *
 * Implements capability probe availability rules according to ADR 006, ADR 011, and ADR 013.
 * Returns stable codes and keys without importing i18next or user-facing prose.
 */

import type { CodecKind, EncoderResult, FfmpegState } from "@/features/ffmpeg/types";

export type EncoderAvailability = "available" | "unavailable" | "unknown";
export type EncoderUnavailableReason = "notListed" | "failed" | "timedOut";
export type EncoderUnknownReason = "notTested" | "notProbed";

export type EncoderOption =
  | {
      name: string;
      availability: "available";
    }
  | {
      name: string;
      availability: "unavailable";
      reason: EncoderUnavailableReason;
    }
  | {
      name: string;
      availability: "unknown";
      reason: EncoderUnknownReason;
    };

export type EncoderProbeState = Pick<FfmpegState, "status" | "results">;

function toSettledOption(name: string, result: EncoderResult): EncoderOption {
  if (result.status === "works") {
    return {
      name,
      availability: "available",
    };
  }

  // `reason: "notListed"` is emitted HERE and nowhere else: only a backend
  // `EncoderStatus::NotListed` carries it, and the backend reaches that status only after its
  // listing step read this build's own `-encoders` output. That is what makes the message
  // "this FFmpeg build does not include the encoder" a true statement about the build. A name
  // simply missing from `results` is NOT that fact -- see `getEncoderAvailability` below.
  return {
    name,
    availability: "unavailable",
    reason: result.status,
  };
}

/**
 * Reports what QuipClip knows about one encoder name.
 *
 * A name absent from `state.results` says nothing about the FFmpeg build. `results` only ever
 * holds the fixed `TESTED_ENCODERS` set (`src-tauri/src/ffmpeg/capabilities/mod.rs`), and the
 * parsed `-encoders` listing never crosses the IPC boundary: `CapabilityReport` carries the
 * version, the licence flags, the hwaccels, and those results, and nothing else. So an absent
 * name means the probe never asked, which is "unknown", never "unavailable".
 */
export function getEncoderAvailability(
  state: EncoderProbeState,
  name: string,
): EncoderOption {
  const result = state.results.find((entry) => entry.name === name);

  if (result) {
    return toSettledOption(name, result);
  }

  switch (state.status) {
    case "ready":
      // The probe finished and reported on every name it tests, so this one is not in that
      // fixed set. No probe QuipClip runs will ever answer for it.
      return {
        name,
        availability: "unknown",
        reason: "notTested",
      };

    case "idle":
    case "locating":
    case "probing":
    case "missing":
    case "failed":
      // No report yet, the probe is still running or failed, or ffmpeg is missing. A later
      // probe can still answer for this name.
      return {
        name,
        availability: "unknown",
        reason: "notProbed",
      };
  }
}

export function buildEncoderOptions(
  state: EncoderProbeState,
  kind: CodecKind,
  currentValue: string,
): EncoderOption[] {
  const options = state.results
    .filter((entry) => entry.kind === kind)
    .map((entry) => toSettledOption(entry.name, entry));

  if (currentValue.trim().length > 0) {
    // Preserve raw currentValue so the prepended option name matches the Radix
    // Select value exactly and avoids blank selection states for padded values.
    const alreadyPresent = options.some((option) => option.name === currentValue);
    if (!alreadyPresent) {
      return [getEncoderAvailability(state, currentValue), ...options];
    }
  }

  return options;
}
