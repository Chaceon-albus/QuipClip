/**
 * Pure presenter for translating a settings error into an i18next key for the settings dialog.
 *
 * `SettingsDialog.tsx` used to build the translation key inline with a template literal and a
 * cast (`` (t as (key: string) => string)(`settingsError.${error.code}`) ``), an untestable
 * transformation of store output embedded in a `.tsx` file that this repository cannot
 * render-test. This module isolates that transformation as a pure function, following the same
 * pattern as `src/components/layout/ffmpegStatusPresenter.ts`.
 */

import { SETTINGS_ERROR_CODES, type SettingsError } from "@/features/settings/types";

/**
 * Translation key and optional interpolation values for a settings error, ready for `t()`.
 */
export type SettingsErrorView = {
  key: string;
  values?: Record<string, string | number>;
};

/**
 * Builds the translation key for `error`, or `null` when there is no error to show.
 *
 * The error's `code` is re-narrowed against `SETTINGS_ERROR_CODES` defensively at this
 * boundary, falling back to the literal `"unknown"`, exactly as `presentFfmpegStatus`
 * re-narrows a backend error code even though the type already claims it is valid: a code
 * absent from the catalog would otherwise render its own, nonexistent key path on screen
 * instead of a real message.
 *
 * None of the current `settingsError.*` catalog messages (see `src/i18n/locales/en.ts`)
 * declare an interpolation placeholder, so `SettingsError`'s optional `detail`, `field`,
 * `value`, `foundSchemaVersion`, and `supportedSchemaVersion` fields have nothing to feed, and
 * `values` is never populated. A future catalog message that adds a placeholder should be
 * matched here by passing through exactly that field, and no other -- a key that declares a
 * placeholder it never receives renders the raw `{{name}}` text on screen.
 */
export function presentSettingsError(
  error: SettingsError | null,
): SettingsErrorView | null {
  if (error === null) {
    return null;
  }

  const rawCode: string = error.code;
  const isKnownCode = (SETTINGS_ERROR_CODES as readonly string[]).includes(rawCode);
  const code = isKnownCode ? rawCode : "unknown";

  return { key: `settingsError.${code}` };
}
