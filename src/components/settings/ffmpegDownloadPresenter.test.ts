import { describe, expect, it } from "vitest";
import {
  FFMPEG_INSTALL_ERROR_CODES,
  FFMPEG_INSTALL_PHASES,
  type FfmpegDownloadOffer,
  type FfmpegInstallState,
  type FfmpegOfferState,
} from "@/features/ffmpeg/install";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  ffmpegLicenseKey,
  presentFfmpegDownload,
  shouldLoadFfmpegOffer,
} from "./ffmpegDownloadPresenter";

/** The message of `key` in `catalog`, or undefined. */
function messageAt(catalog: object, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog,
    );
}

describe("the catalogs", () => {
  it("hold every message that the presenter names, in both languages", () => {
    const keys = [
      ...[...FFMPEG_INSTALL_ERROR_CODES, "invalidResponse"].map(
        (code) => `ffmpegInstallError.${code}`,
      ),
      "settings.ffmpegDownload.phase.preparing",
      "settings.ffmpegDownload.offer",
      "settings.ffmpegDownload.offerAlone",
      ...FFMPEG_INSTALL_PHASES.map((phase) => `settings.ffmpegDownload.phase.${phase}`),
      ...(["gpl3", "gpl2", "lgpl3", "lgpl2"] as const).map(
        (name) => `settings.ffmpegDownload.license.${name}`,
      ),
    ];
    for (const catalog of [en, zhCN]) {
      for (const key of keys) {
        const message = messageAt(catalog, key);
        expect(typeof message === "string" && message.length > 0, key).toBe(true);
      }
    }
  });
});

const OFFER: FfmpegDownloadOffer = {
  version: "9.0.2",
  source: "github.com/GyanD/codexffmpeg",
  license: { gpl: true, nonfree: false, version3: true },
  downloadSize: 100 * 1024 * 1024,
  directory: "C:\\bin",
  replaces: false,
};

const READY: FfmpegOfferState = { status: "ready", offer: OFFER };
const NO_OFFER: FfmpegOfferState = { status: "ready", offer: null };
const IDLE: FfmpegInstallState = { status: "idle" };

function running(
  overrides: Partial<Extract<FfmpegInstallState, { status: "running" }>>,
) {
  return {
    status: "running",
    phase: null,
    received: null,
    total: null,
    cancelRequested: false,
    ...overrides,
  } as const;
}

describe("shouldLoadFfmpegOffer", () => {
  it("asks only after a check that found no FFmpeg that works", () => {
    expect(shouldLoadFfmpegOffer("missing")).toBe(true);
    expect(shouldLoadFfmpegOffer("failed")).toBe(true);
    for (const status of ["idle", "locating", "probing", "ready"] as const) {
      expect(shouldLoadFfmpegOffer(status)).toBe(false);
    }
  });
});

describe("presentFfmpegDownload", () => {
  it("shows the offer only while no FFmpeg works and Rust gives one", () => {
    expect(presentFfmpegDownload("missing", READY, IDLE, "en")).toEqual({
      kind: "offer",
      offer: OFFER,
      canceled: false,
    });
    expect(presentFfmpegDownload("ready", READY, IDLE, "en")).toEqual({ kind: "none" });
    expect(presentFfmpegDownload("probing", READY, IDLE, "en")).toEqual({
      kind: "none",
    });
    expect(presentFfmpegDownload("missing", NO_OFFER, IDLE, "en")).toEqual({
      kind: "none",
    });
    expect(
      presentFfmpegDownload(
        "missing",
        { status: "loading", previous: null },
        IDLE,
        "en",
      ),
    ).toEqual({ kind: "none" });
    // While Rust answers again, the tab keeps the last offer.
    expect(
      presentFfmpegDownload(
        "missing",
        { status: "loading", previous: OFFER },
        IDLE,
        "en",
      ),
    ).toEqual({ kind: "offer", offer: OFFER, canceled: false });
  });

  it("shows the offer after a failed check, as for a damaged earlier download", () => {
    expect(
      presentFfmpegDownload(
        "failed",
        { status: "ready", offer: { ...OFFER, replaces: true } },
        IDLE,
        "en",
      ),
    ).toEqual({ kind: "offer", offer: { ...OFFER, replaces: true }, canceled: false });
  });

  it("shows the offer again after a cancel, with its note", () => {
    expect(
      presentFfmpegDownload("missing", READY, { status: "canceled" }, "en"),
    ).toMatchObject({ kind: "offer", canceled: true });
  });

  it("shows the steps of a running install, with a percent for the download", () => {
    expect(presentFfmpegDownload("missing", READY, running({}), "en")).toEqual({
      kind: "running",
      phaseKey: "settings.ffmpegDownload.phase.preparing",
      values: {},
      percent: null,
      cancelRequested: false,
    });
    expect(
      presentFfmpegDownload(
        "missing",
        READY,
        running({
          phase: "download",
          received: 25 * 1024 * 1024,
          total: 100 * 1024 * 1024,
        }),
        "en",
      ),
    ).toEqual({
      kind: "running",
      phaseKey: "settings.ffmpegDownload.phase.download",
      values: { received: "25 MB", total: "100 MB" },
      percent: 25,
      cancelRequested: false,
    });
    expect(
      presentFfmpegDownload(
        "missing",
        READY,
        running({ phase: "check", cancelRequested: true }),
        "en",
      ),
    ).toMatchObject({
      phaseKey: "settings.ffmpegDownload.phase.check",
      percent: null,
      cancelRequested: true,
    });
    // A total of 0 still fills the two sizes of the message, with the indeterminate bar.
    expect(
      presentFfmpegDownload(
        "missing",
        READY,
        running({ phase: "download", received: 0, total: 0 }),
        "en",
      ),
    ).toMatchObject({
      phaseKey: "settings.ffmpegDownload.phase.download",
      values: { received: "0 kB", total: "0 kB" },
      percent: null,
    });
  });

  it("shows the result of an install while the probe after it runs", () => {
    expect(
      presentFfmpegDownload("probing", NO_OFFER, { status: "installed" }, "en"),
    ).toEqual({ kind: "installed" });
  });

  it("offers Try Again only after an error that a new attempt can fix", () => {
    const failed = (code: "networkFailed" | "hashMismatch" | "alreadyFound") =>
      presentFfmpegDownload(
        "missing",
        READY,
        { status: "failed", code, detail: "x" },
        "en",
      );
    expect(failed("networkFailed")).toEqual({
      kind: "failed",
      messageKey: "ffmpegInstallError.networkFailed",
      detail: "x",
      retry: true,
    });
    expect(failed("hashMismatch")).toMatchObject({ retry: false });
    expect(failed("alreadyFound")).toMatchObject({ retry: false });

    // The exact set of ADR 059.
    const retried = [...FFMPEG_INSTALL_ERROR_CODES, "invalidResponse" as const].filter(
      (code) => {
        const view = presentFfmpegDownload(
          "missing",
          READY,
          { status: "failed", code, detail: null },
          "en",
        );
        return view.kind === "failed" && view.retry;
      },
    );
    expect(retried.sort()).toEqual(
      [
        "busy",
        "commandExecutionFailed",
        "httpStatus",
        "invalidResponse",
        "networkFailed",
        "workDirectoryUnavailable",
        "writeFailed",
      ].sort(),
    );
    // Without an offer, no install can start.
    expect(
      presentFfmpegDownload(
        "missing",
        NO_OFFER,
        { status: "failed", code: "networkFailed", detail: null },
        "en",
      ),
    ).toMatchObject({ retry: false });
  });
});

describe("ffmpegLicenseKey", () => {
  it("names one licence from the flags", () => {
    expect(ffmpegLicenseKey({ gpl: true, nonfree: false, version3: true })).toBe(
      "settings.ffmpegDownload.license.gpl3",
    );
    expect(ffmpegLicenseKey({ gpl: true, nonfree: false, version3: false })).toBe(
      "settings.ffmpegDownload.license.gpl2",
    );
    expect(ffmpegLicenseKey({ gpl: false, nonfree: false, version3: true })).toBe(
      "settings.ffmpegDownload.license.lgpl3",
    );
    expect(ffmpegLicenseKey({ gpl: false, nonfree: false, version3: false })).toBe(
      "settings.ffmpegDownload.license.lgpl2",
    );
  });
});
