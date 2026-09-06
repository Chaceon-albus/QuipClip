/**
 * Pure presenter for translating an export error into an i18next key for the export dialog.
 *
 * Follows the presenter pattern from `src/components/settings/settingsErrorPresenter.ts`.
 */

import { EXPORT_ERROR_CODES, type ExportError } from "@/features/export/types";

/**
 * Translation key and optional interpolation values for an export error, ready for `t()`.
 */
export type ExportErrorView = {
  key: string;
  values?: Record<string, string | number>;
};

/**
 * Builds the translation key for `error`, or `null` when there is no error to show.
 *
 * The error's `code` is re-narrowed against `EXPORT_ERROR_CODES` defensively at this
 * boundary, falling back to the literal `"unknown"` if absent from the catalog.
 *
 * None of the current `exportError.*` catalog messages (see `src/i18n/locales/en.ts`)
 * declare an interpolation placeholder, so `ExportError`'s optional `detail`, `exitCode`,
 * and `encoder` fields have nothing to feed, and i18next discards them. Furthermore,
 * `detail` is already rendered raw elsewhere in the error dialog. Return the key alone,
 * matching `settingsErrorPresenter`.
 */
export function presentExportError(error: ExportError | null): ExportErrorView | null {
  if (error === null) {
    return null;
  }

  const rawCode: string = error.code;
  const isKnownCode = (EXPORT_ERROR_CODES as readonly string[]).includes(rawCode);
  const code = isKnownCode ? rawCode : "unknown";

  return { key: `exportError.${code}` };
}
