/**
 * Pure presenter for translating an export error into an i18next key for the export dialog,
 * and for the notice that shows a failed or canceled export.
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

/**
 * The notice that shows how an export that did not finish ended.
 *
 * - `canceled`: the user stopped the export. This is not an error, so the notice is neutral,
 *   it is a `status`, and it carries no diagnostic.
 * - `failed`: the export stopped on an error. The notice is destructive, it is an `alert`, and
 *   it carries the diagnostic text when the backend sent one.
 */
export type ExportOutcomeView =
  | {
      kind: "canceled";
      tone: "neutral";
      role: "status";
      message: { key: "export.status.canceled" };
      detail: null;
    }
  | {
      kind: "failed";
      tone: "destructive";
      role: "alert";
      message: ExportErrorView;
      detail: string | null;
    };

export interface ExportOutcomeInput {
  status: "failed" | "canceled";
  error: ExportError | null;
}

/**
 * Presents the notice for an export that ended in `failed` or `canceled`.
 *
 * The store sets `canceled` exactly when the error code is `canceled`. The presenter accepts
 * either signal, so a canceled export never shows in the error style.
 *
 * The replacement confirmation for `sourceRevisionChanged` is not an outcome. The dialog
 * shows it with its own actions before it calls this presenter.
 */
export function presentExportOutcome({
  status,
  error,
}: ExportOutcomeInput): ExportOutcomeView {
  if (status === "canceled" || error?.code === "canceled") {
    return {
      kind: "canceled",
      tone: "neutral",
      role: "status",
      message: { key: "export.status.canceled" },
      detail: null,
    };
  }

  // An empty diagnostic carries nothing to show.
  const detail = error?.detail;
  return {
    kind: "failed",
    tone: "destructive",
    role: "alert",
    message: presentExportError(error) ?? { key: "exportError.unknown" },
    detail: detail ? detail : null,
  };
}
