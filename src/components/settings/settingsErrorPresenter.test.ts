import { describe, expect, it } from "vitest";

import { presentSettingsError } from "./settingsErrorPresenter";
import { en } from "@/i18n/locales/en";
import {
  BACKEND_SETTINGS_ERROR_CODES,
  FRONTEND_SETTINGS_ERROR_CODES,
  SETTINGS_ERROR_CODES,
  SettingsError,
  type SettingsErrorCode,
} from "@/features/settings/types";

/**
 * Resolves a dotted translation key path (e.g. "settingsError.readFailed") against a nested
 * catalog object, mirroring how i18next itself walks a namespaced key. Used instead of a
 * hardcoded `en.settingsError[code]` lookup so this test still catches a future presenter
 * change that emits a key under a different path.
 */
function resolveCatalogKey(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

describe("presentSettingsError", () => {
  it("returns null when there is no error", () => {
    expect(presentSettingsError(null)).toBeNull();
  });

  // Every catalog code must map to a key that actually exists in the English message catalog,
  // so a future error code added to SETTINGS_ERROR_CODES without a matching catalog message
  // fails here instead of silently rendering a raw key on screen.
  it.each(SETTINGS_ERROR_CODES)(
    "maps code '%s' to a key that exists in the English catalog",
    (code: SettingsErrorCode) => {
      const error = new SettingsError({ code });

      const view = presentSettingsError(error);

      expect(view).toStrictEqual({ key: `settingsError.${code}` });

      const resolved = resolveCatalogKey(en, view!.key);
      expect(typeof resolved).toBe("string");
      expect((resolved as string).trim().length).toBeGreaterThan(0);
    },
  );

  // The count is derived, never typed: a literal number here would go stale the moment the
  // backend vocabulary grows, even though nothing is wrong. What must hold is the relationship
  // -- every backend code, every frontend code, and the single "unknown" fallback -- so that the
  // loop above covers the whole catalog.
  it("covers the backend codes plus the frontend codes plus the unknown fallback", () => {
    expect(SETTINGS_ERROR_CODES.length).toBe(
      BACKEND_SETTINGS_ERROR_CODES.length + FRONTEND_SETTINGS_ERROR_CODES.length + 1,
    );
  });

  it("falls back to settingsError.unknown for a code absent from the catalog", () => {
    const error = new SettingsError({
      code: "notARealCode" as unknown as SettingsErrorCode,
    });

    const view = presentSettingsError(error);

    expect(view).toStrictEqual({ key: "settingsError.unknown" });
  });

  it("does not attach a values object for any code, since no catalog message declares a placeholder", () => {
    const error = new SettingsError({
      code: "invalidPath",
      detail: "not a real path",
      field: "ffmpegPath",
      value: "/nowhere",
      foundSchemaVersion: 2,
      supportedSchemaVersion: 1,
    });

    const view = presentSettingsError(error);

    expect(view).toStrictEqual({ key: "settingsError.invalidPath" });
    expect(view).not.toHaveProperty("values");
  });
});
