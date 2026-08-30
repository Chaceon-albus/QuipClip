/**
 * Native file dialog orchestration for media selection.
 *
 * Implements the Open Media flow with dependency injection, cancel handling,
 * error normalization, and single-path import triggers.
 */

import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { mediaStore } from "./store";
import { ImportMediaError, type ImportMediaResult } from "./types";

/**
 * Sensible video file extensions supported in the file picker.
 */
export const VIDEO_FILE_EXTENSIONS = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "m4v",
  "avi",
  "ts",
  "wmv",
  "flv",
] as const;

/**
 * Options for configuring `openMediaFileDialog`.
 */
export interface OpenMediaFileDialogOptions {
  /**
   * Localized display label for the video file filter in the native dialog.
   */
  filterName: string;
  /**
   * File dialog opener function. Defaults to Tauri plugin-dialog `open`.
   */
  openDialog?: typeof tauriOpen;
  /**
   * Import handler function. Defaults to `mediaStore.getState().importPath`.
   */
  importPath?: (path: string) => Promise<ImportMediaResult | null>;
  /**
   * Error reporter function. Defaults to `mediaStore.getState().reportError`.
   */
  reportError?: (error: unknown) => void;
}

/**
 * Opens a native file dialog to select a single video file and triggers media import.
 *
 * Requirements:
 * - Uses @tauri-apps/plugin-dialog open with multiple: false, directory: false, and localized video filter label.
 * - Cancel is a strict no-op (returns null without modifying store or throwing).
 * - A selected single path calls importPath exactly once.
 * - Handles dialog rejection without unhandled promises: reports ImportMediaError with code dialogFailed and no detail.
 *
 * @param options Configuration options including required localized filterName.
 * @returns The imported media result on success, or null on cancel/failure.
 */
export async function openMediaFileDialog(
  options: OpenMediaFileDialogOptions,
): Promise<ImportMediaResult | null> {
  const openDialogFn = options.openDialog ?? tauriOpen;
  const importPathFn = options.importPath ?? mediaStore.getState().importPath;
  const reportErrorFn = options.reportError ?? mediaStore.getState().reportError;

  let selected: unknown;
  try {
    selected = await openDialogFn({
      multiple: false,
      directory: false,
      filters: [
        {
          name: options.filterName,
          extensions: [...VIDEO_FILE_EXTENSIONS],
        },
      ],
    });
  } catch {
    reportErrorFn(
      new ImportMediaError({
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
    return await importPathFn(selected);
  }

  if (
    Array.isArray(selected) &&
    selected.length > 0 &&
    typeof selected[0] === "string" &&
    selected[0].trim().length > 0
  ) {
    return await importPathFn(selected[0]);
  }

  return null;
}
