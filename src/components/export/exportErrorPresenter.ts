/**
 * Pure presenter for translating an export error into an i18next key for the export dialog,
 * for the notice that shows a failed or canceled export, and for the action that offers the
 * way out of a failure.
 *
 * Follows the presenter pattern from `src/components/settings/settingsErrorPresenter.ts`.
 */

import {
  EXPORT_ERROR_CODES,
  type ExportError,
  type ExportErrorCode,
} from "@/features/export/types";
import type { SettingsSection } from "@/features/settings/panelStore";

/**
 * Translation key and optional interpolation values for an export error, ready for `t()`.
 */
export type ExportErrorView = {
  key: string;
  values?: Record<string, string | number>;
};

/**
 * The action that the failed panel offers beside Close.
 *
 * - `openSettings`: the fix is in the settings. The export dialog closes first, and the
 *   settings dialog then opens at `section`, so two modal dialogs never show together.
 * - `backToSetup`: another file name, another folder, another preset, or a second attempt
 *   can succeed. The export dialog goes back to the setup step of ADR 024.
 * - `null`: no action in the export dialog or in the settings can repair the cause, so the
 *   panel offers Close only.
 */
export type ExportErrorRecovery =
  { kind: "openSettings"; section: SettingsSection } | { kind: "backToSetup" } | null;

const OPEN_FFMPEG_SETTINGS = { kind: "openSettings", section: "ffmpeg" } as const;
const OPEN_PRESET_SETTINGS = { kind: "openSettings", section: "presets" } as const;
const BACK_TO_SETUP = { kind: "backToSetup" } as const;

/**
 * The recovery of each export error code. The `Record` type makes a new code in
 * `EXPORT_ERROR_CODES` a compile error here until it has a recovery.
 */
const EXPORT_ERROR_RECOVERY: Readonly<Record<ExportErrorCode, ExportErrorRecovery>> = {
  // The settings file holds the presets, and Rust reads the preset of the export from it.
  // The settings dialog shows the read error and its reset control above every tab, and
  // the Presets tab holds what the export needs.
  settingsUnreadable: OPEN_PRESET_SETTINGS,
  presetNotFound: OPEN_PRESET_SETTINGS,

  // The FFmpeg tab sets the executable pair and shows which encoders work.
  ffmpegPairMissing: OPEN_FFMPEG_SETTINGS,
  ffprobeSpawnFailed: OPEN_FFMPEG_SETTINGS,
  ffmpegSpawnFailed: OPEN_FFMPEG_SETTINGS,
  encoderUnavailable: OPEN_FFMPEG_SETTINGS,

  // The destination: another name or another folder can succeed.
  outputPathInvalid: BACK_TO_SETUP,
  outputDirectoryMissing: BACK_TO_SETUP,
  outputEqualsSource: BACK_TO_SETUP,
  outputNotWritable: BACK_TO_SETUP,
  outputReadOnly: BACK_TO_SETUP,
  outputRenameFailed: BACK_TO_SETUP,
  dialogFailed: BACK_TO_SETUP,

  // The encode: another preset, or a second attempt, can succeed.
  ffmpegProcessFailed: BACK_TO_SETUP,
  frameCountMismatch: BACK_TO_SETUP,

  // A condition that can clear by itself: a share that stopped answering, a command that
  // did not reach the backend, a slot that a stopped run has not released yet (ADR 016),
  // or a cause that has no code.
  ffprobeTimedOut: BACK_TO_SETUP,
  commandExecutionFailed: BACK_TO_SETUP,
  exportAlreadyRunning: BACK_TO_SETUP,
  unknown: BACK_TO_SETUP,

  // The fix is outside the export dialog and the settings: the application data directory,
  // the source file, or the marked segments. A second attempt fails the same way.
  appDataUnavailable: null,
  ffprobeProcessFailed: null,
  ffprobeParseFailed: null,
  noSegments: null,
  tooManySegments: null,
  invalidSegment: null,
  sourcePathInvalid: null,
  sourceNotFound: null,
  sourceNotFile: null,
  sourceFrameRateUnknown: null,
  sourceAudioRateUnknown: null,

  // The user stopped the export. This is a result, not a failure.
  canceled: null,
  // A confirmation with its own three actions, never the failed panel.
  sourceRevisionChanged: null,
};

/**
 * Re-narrows the code of `error` against `EXPORT_ERROR_CODES`, because the value crossed an
 * IPC boundary. An absent error, or a code absent from the catalog, becomes `"unknown"`.
 */
function knownCode(error: ExportError | null): ExportErrorCode {
  if (error === null) {
    return "unknown";
  }
  const rawCode: string = error.code;
  return (EXPORT_ERROR_CODES as readonly string[]).includes(rawCode)
    ? (rawCode as ExportErrorCode)
    : "unknown";
}

/**
 * Returns the recovery that the failed panel offers for `error`. See `ExportErrorRecovery`.
 *
 * An absent error, or a code absent from the catalog, takes the recovery of `"unknown"`,
 * which is the message that the panel shows for it.
 */
export function presentExportErrorRecovery(
  error: ExportError | null,
): ExportErrorRecovery {
  return EXPORT_ERROR_RECOVERY[knownCode(error)];
}

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

  return { key: `exportError.${knownCode(error)}` };
}

/**
 * The notice that shows how an export that did not finish ended.
 *
 * - `canceled`: the user stopped the export. This is not an error, so the notice is neutral,
 *   it is a `status`, it carries no diagnostic, and it offers no recovery.
 * - `failed`: the export stopped on an error. The notice is destructive, it is an `alert`, it
 *   carries the diagnostic text when the backend sent one, and it offers the recovery of its
 *   code.
 */
export type ExportOutcomeView =
  | {
      kind: "canceled";
      tone: "neutral";
      role: "status";
      message: { key: "export.status.canceled" };
      detail: null;
      recovery: null;
    }
  | {
      kind: "failed";
      tone: "destructive";
      role: "alert";
      message: ExportErrorView;
      detail: string | null;
      recovery: ExportErrorRecovery;
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
      recovery: null,
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
    recovery: presentExportErrorRecovery(error),
  };
}
