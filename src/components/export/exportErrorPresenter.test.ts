import { describe, expect, it } from "vitest";

import { presentExportError, presentExportOutcome } from "./exportErrorPresenter";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n";
import {
  BACKEND_EXPORT_ERROR_CODES,
  EXPORT_ERROR_CODES,
  FRONTEND_EXPORT_ERROR_CODES,
  ExportError,
  type ExportErrorCode,
} from "@/features/export/types";

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
    }
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
