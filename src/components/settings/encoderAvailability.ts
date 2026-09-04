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

export type EncoderOption = {
  name: string;
  availability: EncoderAvailability;
  reason?: EncoderUnavailableReason; // key ABSENT unless availability is "unavailable"
};

export type EncoderProbeState = Pick<FfmpegState, "status" | "results">;

function toSettledOption(name: string, result: EncoderResult): EncoderOption {
  if (result.status === "works") {
    return {
      name,
      availability: "available",
    };
  }

  return {
    name,
    availability: "unavailable",
    reason: result.status,
  };
}

export function getEncoderAvailability(
  state: EncoderProbeState,
  name: string,
): EncoderOption {
  const result = state.results.find((entry) => entry.name === name);

  switch (state.status) {
    case "idle":
    case "locating":
    case "probing": {
      if (result) {
        return toSettledOption(name, result);
      }
      return {
        name,
        availability: "unknown",
      };
    }

    case "ready": {
      if (result) {
        return toSettledOption(name, result);
      }
      return {
        name,
        availability: "unavailable",
        reason: "notListed",
      };
    }

    case "missing":
    case "failed": {
      if (result) {
        return toSettledOption(name, result);
      }
      return {
        name,
        availability: "unknown",
      };
    }
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
