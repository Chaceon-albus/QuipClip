/**
 * Native file dialog orchestration for media selection.
 *
 * Implements the Open Media flow with dependency injection, cancel handling,
 * error normalization, and single-path import triggers.
 */

import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { mediaStore } from "./store";
import { ImportMediaError } from "./types";

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
 * Reports whether a file path ends in one of `VIDEO_FILE_EXTENSIONS`, in any letter case.
 *
 * This is the same test the file dialog filter applies, so a path that other entry points
 * accept, such as a file dropped on the window, is one the dialog would also show.
 *
 * The test reads the name after the last `/` or `\`, so it accepts a POSIX path and a
 * Windows path. A name whose only dot is its first character, such as `.mp4`, has no
 * extension.
 *
 * @param path An absolute or relative file path.
 */
export function hasVideoFileExtension(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  const extension = name.slice(dot + 1).toLowerCase();
  return (VIDEO_FILE_EXTENSIONS as readonly string[]).includes(extension);
}

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
   * Import handler, called once for each selected file, in the order of the selection. The
   * quit guard passes `requestOpen`, which adds each file as a clip of the sequence (ADR 052).
   * Defaults to `mediaStore.getState().importPath`.
   */
  importPath?: (path: string) => Promise<unknown>;
  /**
   * Error reporter function. Defaults to `mediaStore.getState().reportError`.
   */
  reportError?: (error: unknown) => void;
}

/** The number of native file dialogs that `openMediaFileDialog` has open now. */
let openDialogCount = 0;

/**
 * True while a native file dialog of `openMediaFileDialog` is open.
 *
 * The page receives no key press and no click while that dialog is open, because the dialog
 * is modal to the window. The macOS application menu still works then, so its command items
 * read this value and do nothing while it is true. Without it, Open Media in the menu would
 * queue a second dialog behind the first one.
 */
export function isMediaFileDialogOpen(): boolean {
  return openDialogCount > 0;
}

/**
 * Opens a native file dialog to select one or more video files and imports them (ADR 052).
 *
 * Requirements:
 * - Uses @tauri-apps/plugin-dialog open with multiple: true, directory: false, and localized video filter label.
 * - Cancel is a strict no-op (returns without modifying store or throwing).
 * - Each selected path calls importPath once, one after another, in the order of the selection.
 * - Handles dialog rejection without unhandled promises: reports ImportMediaError with code dialogFailed and no detail.
 *
 * @param options Configuration options including required localized filterName.
 */
export async function openMediaFileDialog(
  options: OpenMediaFileDialogOptions,
): Promise<void> {
  const openDialogFn = options.openDialog ?? tauriOpen;
  const importPathFn = options.importPath ?? mediaStore.getState().importPath;
  const reportErrorFn = options.reportError ?? mediaStore.getState().reportError;

  let selected: unknown;
  openDialogCount += 1;
  try {
    selected = await openDialogFn({
      multiple: true,
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
    return;
  } finally {
    openDialogCount -= 1;
  }

  // Cancel or empty selection is a strict no-op
  const paths = (Array.isArray(selected) ? selected : [selected]).filter(
    (path): path is string => typeof path === "string" && path.trim().length > 0,
  );
  // One after another, so the files join the sequence in the order of the selection.
  for (const path of paths) {
    await importPathFn(path);
  }
}
