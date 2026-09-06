import { describe, expect, it } from "vitest";

import { presentExportError } from "./exportErrorPresenter";
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
