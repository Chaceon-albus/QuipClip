/**
 * Native file dialog orchestration for export destination selection.
 *
 * Implements the Save Export flow with dependency injection, cancel handling,
 * error normalization, and preset container extension filtering.
 */

import { save as tauriSave } from "@tauri-apps/plugin-dialog";
import { exportStore } from "./store";
import { ExportError } from "./types";

/**
 * Options for configuring `openExportSaveDialog`.
 */
export interface OpenExportSaveDialogOptions {
  /**
   * Container format / extension (e.g. "mp4", "mov", "mkv").
   */
  container: string;
  /**
   * Localized display label for the file filter in the native dialog.
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
 * - Uses @tauri-apps/plugin-dialog save with localized filter label and extension matching the preset container.
 * - Cancel is a strict no-op returning null (never an error).
 * - A rejection reports a dialogFailed ExportError with NO detail (never leaking local messages) through reportError and returns null.
 * - Never rethrows.
 *
 * @param options Configuration options including required container and filterName.
 * @returns The chosen output file path on success, or null on cancel/failure.
 */
export async function openExportSaveDialog(
  options: OpenExportSaveDialogOptions,
): Promise<string | null> {
  const saveDialogFn = options.saveDialog ?? tauriSave;
  const reportErrorFn = options.reportError ?? exportStore.getState().reportError;

  const extension = options.container.replace(/^\./, "");

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
