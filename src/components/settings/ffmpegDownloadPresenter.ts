/**
 * Pure rules for the download of FFmpeg in the FFmpeg tab of the Settings window (ADR 059):
 * when the tab asks Rust for the offer, and what the tab shows for the offer and the install.
 *
 * Like the other presenters, it returns catalog keys and never calls the i18n runtime.
 */

import type { FfmpegStatus } from "@/features/ffmpeg/types";
import {
  shownFfmpegOffer,
  type FfmpegDownloadOffer,
  type FfmpegInstallErrorCode,
  type FfmpegInstallState,
  type FfmpegOfferState,
} from "@/features/ffmpeg/install";
import { formatCacheSize } from "./waveformCachePresenter";

/**
 * True when the tab asks Rust for the offer: the check ended and found no FFmpeg that works.
 * Rust applies the rule of ADR 059 and gives no offer when the download must not run.
 */
export function shouldLoadFfmpegOffer(status: FfmpegStatus): boolean {
  return status === "missing" || status === "failed";
}

/**
 * The errors after which a new attempt can succeed with the same files: the network, a busy
 * slot, the disk, or a fault of the application. After an error of the files themselves, a new
 * download gets the same files, so the tab offers no new attempt.
 */
const RETRY_CODES: ReadonlySet<FfmpegInstallErrorCode> = new Set([
  "busy",
  "networkFailed",
  "httpStatus",
  "workDirectoryUnavailable",
  "writeFailed",
  "commandExecutionFailed",
  "invalidResponse",
]);

export type FfmpegInstallPhaseKey =
  | "settings.ffmpegDownload.phase.preparing"
  | "settings.ffmpegDownload.phase.download"
  | "settings.ffmpegDownload.phase.extract"
  | "settings.ffmpegDownload.phase.check"
  | "settings.ffmpegDownload.phase.install";

/** What the tab shows for the download. */
export type FfmpegDownloadView =
  /** Nothing: FFmpeg works, or Rust gives no offer. */
  | { readonly kind: "none" }
  /** The Download FFmpeg… button, and the note of a canceled install before it. */
  | {
      readonly kind: "offer";
      readonly offer: FfmpegDownloadOffer;
      readonly canceled: boolean;
    }
  | {
      readonly kind: "running";
      readonly phaseKey: FfmpegInstallPhaseKey;
      readonly values: Record<string, string>;
      /** 0 to 100 during the download, else null for the indeterminate bar. */
      readonly percent: number | null;
      readonly cancelRequested: boolean;
    }
  | { readonly kind: "installed" }
  | {
      readonly kind: "failed";
      readonly messageKey: `ffmpegInstallError.${FfmpegInstallErrorCode}`;
      readonly detail: string | null;
      /** True when Try Again starts a new install. */
      readonly retry: boolean;
    };

/**
 * What the tab shows for the download.
 *
 * A running install and its result show whatever the status of the check is, so the user sees
 * how the install ended while the probe that follows it runs. Otherwise the offer shows only
 * while the check found no FFmpeg that works.
 */
export function presentFfmpegDownload(
  status: FfmpegStatus,
  offer: FfmpegOfferState,
  install: FfmpegInstallState,
  locale: string,
): FfmpegDownloadView {
  switch (install.status) {
    case "running": {
      const common = { cancelRequested: install.cancelRequested };
      if (install.phase === null) {
        return {
          kind: "running",
          phaseKey: "settings.ffmpegDownload.phase.preparing",
          values: {},
          percent: null,
          ...common,
        };
      }
      if (install.phase === "download") {
        // The message of the download always gets its two sizes. A total of 0 gives the
        // indeterminate bar.
        const received = install.received ?? 0;
        const total = install.total ?? 0;
        return {
          kind: "running",
          phaseKey: "settings.ffmpegDownload.phase.download",
          values: {
            received: formatCacheSize(received, locale),
            total: formatCacheSize(total, locale),
          },
          percent: total > 0 ? Math.min(100, (received / total) * 100) : null,
          ...common,
        };
      }
      return {
        kind: "running",
        phaseKey: `settings.ffmpegDownload.phase.${install.phase}`,
        values: {},
        percent: null,
        ...common,
      };
    }
    case "installed":
      return { kind: "installed" };
    case "failed":
      return {
        kind: "failed",
        messageKey: `ffmpegInstallError.${install.code}`,
        detail: install.detail,
        retry: RETRY_CODES.has(install.code) && shownFfmpegOffer(offer) !== null,
      };
    case "canceled":
    case "idle": {
      const value = shownFfmpegOffer(offer);
      if (!shouldLoadFfmpegOffer(status) || value === null) {
        return { kind: "none" };
      }
      return { kind: "offer", offer: value, canceled: install.status === "canceled" };
    }
  }
}

export type FfmpegLicenseKey =
  | "settings.ffmpegDownload.license.gpl3"
  | "settings.ffmpegDownload.license.gpl2"
  | "settings.ffmpegDownload.license.lgpl3"
  | "settings.ffmpegDownload.license.lgpl2";

/**
 * The licence that the consent dialog names. The manifest never pins a non-free build
 * (ADR 059), so the flags give one of four licences.
 */
export function ffmpegLicenseKey(
  license: FfmpegDownloadOffer["license"],
): FfmpegLicenseKey {
  if (license.gpl) {
    return license.version3
      ? "settings.ffmpegDownload.license.gpl3"
      : "settings.ffmpegDownload.license.gpl2";
  }
  return license.version3
    ? "settings.ffmpegDownload.license.lgpl3"
    : "settings.ffmpegDownload.license.lgpl2";
}
