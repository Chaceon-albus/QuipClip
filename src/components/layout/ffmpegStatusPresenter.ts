/**
 * Pure presenter for formatting FFmpeg readiness and capability state for the status bar.
 *
 * Implements status line and detail view model derivations according to ADR 005, ADR 006,
 * and ADR 011. Returns translation keys and values without calling the i18n runtime.
 */

import {
  BACKEND_CAPABILITY_PROBE_ERROR_CODES,
  type FfmpegState,
} from "@/features/ffmpeg/types";

export type FfmpegStatusLineKey =
  | "ffmpeg.status.locating"
  | "ffmpeg.status.probing"
  | "ffmpeg.status.ready"
  | "ffmpeg.status.missing"
  | "ffmpeg.status.failed";

export type FfmpegStatusView = {
  lineKey: FfmpegStatusLineKey;
  lineValues: Record<string, string>;
  detail: Array<{ key: string; values?: Record<string, string> }>;
  tone: "neutral" | "ready" | "warning";
};

export function presentFfmpegStatus(
  state: FfmpegState,
  format: { list: Intl.ListFormat; number: Intl.NumberFormat },
): FfmpegStatusView {
  switch (state.status) {
    case "idle":
    case "locating": {
      return {
        lineKey: "ffmpeg.status.locating",
        lineValues: {},
        detail: [],
        tone: "neutral",
      };
    }

    case "probing": {
      return {
        lineKey: "ffmpeg.status.probing",
        lineValues: {
          done: format.number.format(state.done),
          total: format.number.format(state.total),
        },
        detail: [],
        tone: "neutral",
      };
    }

    case "ready": {
      const workingResults = state.results.filter((r) => r.status === "works");
      const workingCount = workingResults.length;
      const testedCount = state.results.length;

      const detail: Array<{ key: string; values?: Record<string, string> }> = [];

      // 1. Origin
      if (state.origin) {
        detail.push({ key: `ffmpeg.detail.origin.${state.origin}` });
      }

      // 2. Program path
      if (state.paths?.ffmpeg) {
        detail.push({
          key: "ffmpeg.detail.program",
          values: { path: state.paths.ffmpeg },
        });
      }

      // 3. Version
      if (state.version) {
        detail.push({
          key: "ffmpeg.detail.version",
          values: { version: state.version },
        });
      }

      // 4. Licence flags
      let hasLicenseFlag = false;
      if (state.license?.gpl) {
        detail.push({ key: "ffmpeg.detail.license.gpl" });
        hasLicenseFlag = true;
      }
      if (state.license?.nonfree) {
        detail.push({ key: "ffmpeg.detail.license.nonfree" });
        hasLicenseFlag = true;
      }
      if (state.license?.version3) {
        detail.push({ key: "ffmpeg.detail.license.version3" });
        hasLicenseFlag = true;
      }
      if (!hasLicenseFlag) {
        detail.push({ key: "ffmpeg.detail.license.none" });
      }

      // 5. Hardware acceleration methods
      if (state.hwaccels && state.hwaccels.length > 0) {
        detail.push({
          key: "ffmpeg.detail.hardware",
          values: { methods: format.list.format(state.hwaccels) },
        });
      } else {
        detail.push({ key: "ffmpeg.detail.hardwareNone" });
      }

      // 6. Working encoders
      if (workingResults.length > 0) {
        const encoderNames = workingResults.map((r) => r.name);
        detail.push({
          key: "ffmpeg.detail.workingEncoders",
          values: { encoders: format.list.format(encoderNames) },
        });
      } else {
        detail.push({ key: "ffmpeg.detail.noWorkingEncoders" });
      }

      return {
        lineKey: "ffmpeg.status.ready",
        lineValues: {
          version: state.version ?? "",
          working: format.number.format(workingCount),
          tested: format.number.format(testedCount),
        },
        detail,
        tone: workingCount === 0 ? "warning" : "ready",
      };
    }

    case "missing": {
      const detail: Array<{ key: string; values?: Record<string, string> }> = [];
      detail.push({ key: "ffmpegError.ffmpegPairMissing" });

      if (state.error?.detail) {
        detail.push({
          key: "ffmpeg.detail.raw",
          values: { detail: state.error.detail },
        });
      }

      if (state.inspected) {
        for (const candidate of state.inspected) {
          detail.push({
            key: "ffmpeg.detail.searchedPair",
            values: {
              path: candidate.ffmpeg,
              probe: candidate.ffprobe,
              origin: candidate.origin,
            },
          });
        }
      }

      return {
        lineKey: "ffmpeg.status.missing",
        lineValues: {},
        detail,
        tone: "warning",
      };
    }

    case "failed": {
      const detail: Array<{ key: string; values?: Record<string, string> }> = [];
      const rawCode = state.error?.code;
      const isKnownCode =
        typeof rawCode === "string" &&
        (BACKEND_CAPABILITY_PROBE_ERROR_CODES as readonly string[]).includes(rawCode);
      const errorCode = isKnownCode ? rawCode : "unknown";

      detail.push({ key: `ffmpegError.${errorCode}` });

      if (state.error?.detail) {
        detail.push({
          key: "ffmpeg.detail.raw",
          values: { detail: state.error.detail },
        });
      }

      return {
        lineKey: "ffmpeg.status.failed",
        lineValues: {},
        detail,
        tone: "warning",
      };
    }
  }
}
