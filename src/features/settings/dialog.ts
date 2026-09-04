/**
 * Native file and directory dialog orchestration for FFmpeg / FFprobe path selection.
 *
 * Why both modes exist:
 * `src-tauri/src/ffmpeg/locate.rs` accepts a directory OR either executable as
 * the configured path. A directory is the better default because it is the
 * only mode that reliably yields a PAIR: a user who picks just
 * `/opt/bin/ffmpeg` while `ffprobe` lives elsewhere gets a confusing
 * `ffmpegPairMissing`.
 *
 * The file picker MUST NOT set a filter:
 * An `extensions` filter hides extensionless binaries, and every ffmpeg on macOS
 * and Linux is extensionless — setting filters would show an empty folder containing
 * the very binary the user is attempting to select.
 */

import { open as tauriOpen, type OpenDialogOptions } from "@tauri-apps/plugin-dialog";
import { settingsStore } from "./store";
import { SettingsError } from "./types";

/**
 * Options for configuring `openFfmpegPathDialog`.
 */
export interface OpenFfmpegPathDialogOptions {
  /**
   * Selection mode: either a single executable file or a directory containing binaries.
   */
  mode: "file" | "directory";
  /**
   * Optional custom dialog window title.
   */
  title?: string;
  /**
   * File/directory dialog opener function. Defaults to Tauri plugin-dialog `open`.
   */
  openDialog?: typeof tauriOpen;
  /**
   * Optional callback invoked when a valid path is selected.
   */
  onPicked?: (path: string) => void | Promise<void>;
  /**
   * Error reporter function. Defaults to `settingsStore.getState().reportError`.
   */
  reportError?: (error: unknown) => void;
}

/**
 * Opens a native file or directory dialog to select an FFmpeg executable or binary directory.
 *
 * Requirements:
 * - mode: "directory" calls open with `{ multiple: false, directory: true }`.
 * - mode: "file" calls open with `{ multiple: false, directory: false }` and NO `filters` key.
 * - Cancel (null/undefined, empty array, or whitespace-only string) is a strict no-op returning null.
 * - A dialog rejection calls `reportError` exactly once with a `SettingsError` whose code is `"dialogFailed"`
 *   and no detail, does not rethrow, and returns null.
 * - A string[] selection uses element zero `[0]`.
 * - On a good selection, calls `onPicked` exactly once with the path and returns the path.
 *
 * @param options Configuration options including mode, optional title, and DI callbacks.
 * @returns The selected path on success, or null on cancel/failure.
 */
export async function openFfmpegPathDialog(
  options: OpenFfmpegPathDialogOptions,
): Promise<string | null> {
  const openDialogFn = options.openDialog ?? tauriOpen;
  const reportErrorFn = options.reportError ?? settingsStore.getState().reportError;
  const onPickedFn = options.onPicked;

  const openOptions: OpenDialogOptions = {
    multiple: false,
    directory: options.mode === "directory",
  };

  if (options.title !== undefined) {
    openOptions.title = options.title;
  }

  let selected: unknown;
  try {
    selected = await openDialogFn(openOptions);
  } catch {
    reportErrorFn(
      new SettingsError({
        code: "dialogFailed",
      }),
    );
    return null;
  }

  // Cancel or empty selection is a strict no-op
  if (!selected) {
    return null;
  }

  let resolvedPath: string | null = null;
  if (typeof selected === "string" && selected.trim().length > 0) {
    resolvedPath = selected;
  } else if (
    Array.isArray(selected) &&
    selected.length > 0 &&
    typeof selected[0] === "string" &&
    selected[0].trim().length > 0
  ) {
    resolvedPath = selected[0];
  }

  if (resolvedPath === null) {
    return null;
  }

  await onPickedFn?.(resolvedPath);
  return resolvedPath;
}
