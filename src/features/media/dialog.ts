/**
 * Native file dialog orchestration for media selection.
 *
 * Implements the Open Media flow with dependency injection, cancel handling,
 * error normalization, and single-path import triggers.
 */

import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { trackSystemFileDialog } from "@/lib/systemFileDialog";
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
   * The extensions of the filter, with no dot. Defaults to `VIDEO_FILE_EXTENSIONS`. The Open
   * action adds the extension of a project file (ADR 072).
   */
  extensions?: readonly string[];
  /**
   * File dialog opener function. Defaults to Tauri plugin-dialog `open`.
   */
  openDialog?: typeof tauriOpen;
  /**
   * Import handler, called once for each selected file, in the order of the selection. Defaults
   * to `mediaStore.getState().importPath`. `openPaths` takes its place when it is given.
   */
  importPath?: (path: string) => Promise<unknown>;
  /**
   * Request handler, called once with all the selected files, in the order of the selection.
   * The Open action passes `requestOpen` of the quit guard, so no other request comes between
   * two files of one dialog (ADR 072, "One Open action"). The dialog that adds a video from the
   * export dialog passes `requestVideos` (ADR 024). When it is given, `importPath` is not
   * called.
   */
  openPaths?: (paths: readonly string[]) => Promise<unknown>;
  /**
   * Error reporter function. Defaults to `mediaStore.getState().reportError`.
   */
  reportError?: (error: unknown) => void;
}

/**
 * Opens a native file dialog to select one or more video files and imports them (ADR 052).
 *
 * Requirements:
 * - Uses @tauri-apps/plugin-dialog open with multiple: true, directory: false, and localized video filter label.
 * - Cancel is a strict no-op (returns without modifying store or throwing).
 * - Each selected path calls importPath once, one after another, in the order of the selection.
 * - With openPaths, all the selected paths go to one call of openPaths, in the order of the selection.
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
  try {
    // The page receives no key press and no click while the dialog is open, because it is
    // modal to the window. The macOS application menu still works then, so its command items
    // read the shared count (`isSystemFileDialogOpen`) and do nothing while it is true. Without
    // it, Open Media in the menu would queue a second dialog behind the first one.
    selected = await trackSystemFileDialog(() =>
      openDialogFn({
        multiple: true,
        directory: false,
        filters: [
          {
            name: options.filterName,
            extensions: [...(options.extensions ?? VIDEO_FILE_EXTENSIONS)],
          },
        ],
      }),
    );
  } catch {
    reportErrorFn(
      new ImportMediaError({
        code: "dialogFailed",
      }),
    );
    return;
  }

  // Cancel or empty selection is a strict no-op
  const paths = (Array.isArray(selected) ? selected : [selected]).filter(
    (path): path is string => typeof path === "string" && path.trim().length > 0,
  );
  if (options.openPaths !== undefined) {
    if (paths.length > 0) {
      await options.openPaths(paths);
    }
    return;
  }
  // One after another, so the files join the sequence in the order of the selection.
  for (const path of paths) {
    await importPathFn(path);
  }
}
