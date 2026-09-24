import { describe, expect, it } from "vitest";

import {
  presentExportError,
  presentExportErrorRecovery,
  presentExportOutcome,
  type ExportErrorRecovery,
} from "./exportErrorPresenter";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n";
import {
  BACKEND_EXPORT_ERROR_CODES,
  EXPORT_ERROR_CODES,
  FRONTEND_EXPORT_ERROR_CODES,
  ExportError,
  type ExportErrorCode,
} from "@/features/export/types";
import { SETTINGS_SECTIONS } from "@/features/settings/panelStore";

/**
 * Resolves a dotted translation key path (e.g. "exportError.outputNotWritable") against a nested
 * catalog object, mirroring how i18next walks a namespaced key.
 */
function resolveCatalogKey(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

describe("presentExportError", () => {
  it("returns null when there is no error", () => {
    expect(presentExportError(null)).toBeNull();
  });

  it.each(EXPORT_ERROR_CODES)(
    "maps code '%s' to a key that exists in the English catalog",
    (code: ExportErrorCode) => {
      const error = new ExportError({ code });

      const view = presentExportError(error);

      expect(view).toStrictEqual({ key: `exportError.${code}` });

      const resolved = resolveCatalogKey(en, view!.key);
      expect(typeof resolved).toBe("string");
      expect((resolved as string).trim().length).toBeGreaterThan(0);
    },
  );

  it.each(EXPORT_ERROR_CODES)(
    "maps code '%s' to a key that exists in the Simplified Chinese catalog",
    (code: ExportErrorCode) => {
      const error = new ExportError({ code });

      const view = presentExportError(error);

      expect(view).toStrictEqual({ key: `exportError.${code}` });

      const resolved = resolveCatalogKey(zhCN, view!.key);
      expect(typeof resolved).toBe("string");
      expect((resolved as string).trim().length).toBeGreaterThan(0);
    },
  );

  // The count is derived, never typed: the backend vocabulary grows, and a literal number here
  // would fail on the next code added even though nothing is wrong. What must hold is the
  // relationship -- every backend code, every frontend code, and the single "unknown" fallback --
  // so that the two loops above cover the whole vocabulary.
  it("covers the backend codes plus the frontend codes plus the unknown fallback", () => {
    expect(EXPORT_ERROR_CODES.length).toBe(
      BACKEND_EXPORT_ERROR_CODES.length + FRONTEND_EXPORT_ERROR_CODES.length + 1,
    );
  });

  it("falls back to exportError.unknown for a code absent from the catalog", () => {
    const error = new ExportError({
      code: "notARealCode" as unknown as ExportErrorCode,
    });

    const view = presentExportError(error);

    expect(view).toStrictEqual({ key: "exportError.unknown" });
  });

  it("does not attach a values object for any code, since no catalog message declares a placeholder", () => {
    const error = new ExportError({
      code: "ffmpegProcessFailed",
      detail: "hardware encoder crashed",
      exitCode: 1,
      encoder: "h264_nvenc",
    });

    const view = presentExportError(error);

    expect(view).toStrictEqual({ key: "exportError.ffmpegProcessFailed" });
    expect(view).not.toHaveProperty("values");
  });
});

describe("presentExportOutcome", () => {
  it("presents a canceled export as a neutral status with the canceled status text", () => {
    const outcome = presentExportOutcome({
      status: "canceled",
      error: new ExportError({ code: "canceled" }),
    });

    expect(outcome).toStrictEqual({
      kind: "canceled",
      tone: "neutral",
      role: "status",
      message: { key: "export.status.canceled" },
      detail: null,
      recovery: null,
    });
  });

  it("drops a diagnostic that a canceled export carries", () => {
    const outcome = presentExportOutcome({
      status: "canceled",
      error: new ExportError({ code: "canceled", detail: "process killed" }),
    });

    expect(outcome.kind).toBe("canceled");
    expect(outcome.detail).toBeNull();
  });

  it("presents a canceled status with no error as canceled", () => {
    expect(presentExportOutcome({ status: "canceled", error: null }).kind).toBe(
      "canceled",
    );
  });

  it("presents a canceled code as canceled even in the failed status", () => {
    const outcome = presentExportOutcome({
      status: "failed",
      error: new ExportError({ code: "canceled" }),
    });

    expect(outcome.kind).toBe("canceled");
    expect(outcome.tone).toBe("neutral");
  });

  it("presents a failed export as a destructive alert with its error key and diagnostic", () => {
    const outcome = presentExportOutcome({
      status: "failed",
      error: new ExportError({
        code: "ffmpegProcessFailed",
        detail: "Conversion failed!",
      }),
    });

    expect(outcome).toStrictEqual({
      kind: "failed",
      tone: "destructive",
      role: "alert",
      message: { key: "exportError.ffmpegProcessFailed" },
      detail: "Conversion failed!",
      recovery: { kind: "backToSetup" },
    });
  });

  it("gives a failed export with no diagnostic a null detail", () => {
    const withoutDetail = presentExportOutcome({
      status: "failed",
      error: new ExportError({ code: "outputRenameFailed" }),
    });
    const emptyDetail = presentExportOutcome({
      status: "failed",
      error: new ExportError({ code: "outputRenameFailed", detail: "" }),
    });

    expect(withoutDetail.detail).toBeNull();
    expect(emptyDetail.detail).toBeNull();
  });

  it("falls back to exportError.unknown for a failed status with no error", () => {
    expect(presentExportOutcome({ status: "failed", error: null })).toStrictEqual({
      kind: "failed",
      tone: "destructive",
      role: "alert",
      message: { key: "exportError.unknown" },
      detail: null,
      recovery: { kind: "backToSetup" },
    });
  });

  it("presents every code but canceled as a failure", () => {
    for (const code of EXPORT_ERROR_CODES) {
      if (code === "canceled") {
        continue;
      }
      const outcome = presentExportOutcome({
        status: "failed",
        error: new ExportError({ code }),
      });
      expect(outcome.kind).toBe("failed");
      expect(outcome.tone).toBe("destructive");
      expect(outcome.message.key).toBe(`exportError.${code}`);
      expect(outcome.recovery).toStrictEqual(
        presentExportErrorRecovery(new ExportError({ code })),
      );
    }
  });

  it("offers no recovery for a canceled export, whatever the status", () => {
    expect(
      presentExportOutcome({ status: "canceled", error: null }).recovery,
    ).toBeNull();
    expect(
      presentExportOutcome({
        status: "failed",
        error: new ExportError({ code: "canceled" }),
      }).recovery,
    ).toBeNull();
  });

  it("uses a canceled status text that exists in both catalogs", () => {
    const outcome = presentExportOutcome({ status: "canceled", error: null });

    for (const catalog of [en, zhCN]) {
      const resolved = resolveCatalogKey(catalog, outcome.message.key);
      expect(typeof resolved).toBe("string");
      expect((resolved as string).trim().length).toBeGreaterThan(0);
    }
  });
});

const OPEN_FFMPEG: ExportErrorRecovery = { kind: "openSettings", section: "ffmpeg" };
const OPEN_PRESETS: ExportErrorRecovery = { kind: "openSettings", section: "presets" };
const BACK: ExportErrorRecovery = { kind: "backToSetup" };

/**
 * The expected recovery of every code, written out here rather than read from the module, so
 * a change to the mapping must change this table too. The `Record` type makes a code added
 * to `EXPORT_ERROR_CODES` a type error here until the table names it.
 */
const EXPECTED_RECOVERY: Record<ExportErrorCode, ExportErrorRecovery> = {
  appDataUnavailable: null,
  settingsUnreadable: OPEN_PRESETS,
  presetNotFound: OPEN_PRESETS,
  ffmpegPairMissing: OPEN_FFMPEG,
  ffprobeSpawnFailed: OPEN_FFMPEG,
  ffprobeProcessFailed: null,
  ffprobeParseFailed: null,
  ffprobeTimedOut: BACK,
  noSegments: null,
  tooManySegments: null,
  invalidSegment: null,
  sourcePathInvalid: null,
  sourceNotFound: null,
  sourceNotFile: null,
  outputPathInvalid: BACK,
  outputDirectoryMissing: BACK,
  outputEqualsSource: BACK,
  outputNotWritable: BACK,
  outputReadOnly: BACK,
  sourceFrameRateUnknown: null,
  sourceAudioRateUnknown: null,
  encoderUnavailable: OPEN_FFMPEG,
  ffmpegSpawnFailed: OPEN_FFMPEG,
  ffmpegProcessFailed: BACK,
  frameCountMismatch: BACK,
  outputRenameFailed: BACK,
  canceled: null,
  commandExecutionFailed: BACK,
  exportAlreadyRunning: BACK,
  dialogFailed: BACK,
  sourceRevisionChanged: null,
  unknown: BACK,
};

describe("presentExportErrorRecovery", () => {
  it.each(EXPORT_ERROR_CODES)(
    "maps code '%s' to its recovery",
    (code: ExportErrorCode) => {
      expect(presentExportErrorRecovery(new ExportError({ code }))).toStrictEqual(
        EXPECTED_RECOVERY[code],
      );
    },
  );

  it("names every code in the expected table, and no other key", () => {
    expect(Object.keys(EXPECTED_RECOVERY).sort()).toStrictEqual(
      [...EXPORT_ERROR_CODES].sort(),
    );
  });

  it("opens a settings section that the settings dialog has", () => {
    for (const code of EXPORT_ERROR_CODES) {
      const recovery = presentExportErrorRecovery(new ExportError({ code }));
      if (recovery?.kind === "openSettings") {
        expect(SETTINGS_SECTIONS).toContain(recovery.section);
      }
    }
  });

  it("opens the FFmpeg section for the executable and encoder codes", () => {
    for (const code of [
      "ffmpegPairMissing",
      "ffprobeSpawnFailed",
      "ffmpegSpawnFailed",
      "encoderUnavailable",
    ] as const) {
      expect(presentExportErrorRecovery(new ExportError({ code }))).toStrictEqual(
        OPEN_FFMPEG,
      );
    }
  });

  it("opens the Presets section for the preset and settings file codes", () => {
    for (const code of ["presetNotFound", "settingsUnreadable"] as const) {
      expect(presentExportErrorRecovery(new ExportError({ code }))).toStrictEqual(
        OPEN_PRESETS,
      );
    }
  });

  it("goes back to the setup step for the output and process codes", () => {
    for (const code of [
      "outputPathInvalid",
      "outputDirectoryMissing",
      "outputEqualsSource",
      "outputNotWritable",
      "outputReadOnly",
      "outputRenameFailed",
      "ffmpegProcessFailed",
      "frameCountMismatch",
      "dialogFailed",
    ] as const) {
      expect(presentExportErrorRecovery(new ExportError({ code }))).toStrictEqual(BACK);
    }
  });

  it("offers nothing for a stop, or for the confirmation with its own actions", () => {
    expect(
      presentExportErrorRecovery(new ExportError({ code: "canceled" })),
    ).toBeNull();
    expect(
      presentExportErrorRecovery(new ExportError({ code: "sourceRevisionChanged" })),
    ).toBeNull();
  });

  it("gives an absent error the recovery of the unknown code", () => {
    expect(presentExportErrorRecovery(null)).toStrictEqual(BACK);
  });

  it("gives a code absent from the catalog the recovery of the unknown code", () => {
    const error = new ExportError({
      code: "notARealCode" as unknown as ExportErrorCode,
    });

    expect(presentExportErrorRecovery(error)).toStrictEqual(BACK);
  });
});
