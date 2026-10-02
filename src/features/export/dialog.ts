/**
 * Native file dialog orchestration for export destination selection.
 *
 * Implements the Save Export flow with dependency injection, cancel handling,
 * error normalization, and filtering by the extension of the output.
 */

import { save as tauriSave } from "@tauri-apps/plugin-dialog";
import { exportStore } from "./store";
import { ExportError } from "./types";

/**
 * Options for configuring `openExportSaveDialog`.
 */
export interface OpenExportSaveDialogOptions {
  /**
   * The extension of the output file, with or without its dot: the container of the preset
   * ("mp4", "mov", "mkv"), or "m4a" or "mka" for an audio-only export (ADR 036).
   */
  extension: string;
  /**
   * Localized display label for the file filter in the native dialog: video files, or audio
   * files for an audio-only export.
   */
  filterName: string;
  /**
   * Default suggested file name for the save dialog.
   */
  defaultName?: string;
  /**
   * Optional title of the dialog window.
   */
  title?: string;
  /**
   * File dialog save function. Defaults to Tauri plugin-dialog `save`.
   */
  saveDialog?: typeof tauriSave;
  /**
   * Error reporter function. Defaults to `exportStore.getState().reportError`.
   */
  reportError?: (error: unknown) => void;
}

/**
 * Opens a native save file dialog to select an export output file path.
 *
 * Requirements:
 * - Uses @tauri-apps/plugin-dialog save with localized filter label and the extension of the output.
 * - Cancel is a strict no-op returning null (never an error).
 * - A rejection reports a dialogFailed ExportError with NO detail (never leaking local messages) through reportError and returns null.
 * - Never rethrows.
 *
 * @param options Configuration options including required extension and filterName.
 * @returns The chosen output file path on success, or null on cancel/failure.
 */
export async function openExportSaveDialog(
  options: OpenExportSaveDialogOptions,
): Promise<string | null> {
  const saveDialogFn = options.saveDialog ?? tauriSave;
  const reportErrorFn = options.reportError ?? exportStore.getState().reportError;

  const extension = options.extension.replace(/^\./, "");

  let selected: unknown;
  try {
    selected = await saveDialogFn({
      ...(options.title ? { title: options.title } : {}),
      ...(options.defaultName ? { defaultPath: options.defaultName } : {}),
      filters: [
        {
          name: options.filterName,
          extensions: [extension],
        },
      ],
    });
  } catch {
    reportErrorFn(
      new ExportError({
        code: "dialogFailed",
      }),
    );
    return null;
  }

  // Cancel or empty selection is a strict no-op
  if (!selected) {
    return null;
  }

  if (typeof selected === "string" && selected.trim().length > 0) {
    return selected;
  }

  return null;
}
