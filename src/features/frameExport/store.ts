/**
 * The production controller of the Export Frame action (ADR 069), with the save dialog of the
 * system and the client of `export_frame`.
 */

import { save as tauriSave } from "@tauri-apps/plugin-dialog";
import { useStore } from "zustand";
import { i18n } from "@/i18n";
import { exportFrame } from "./client";
import {
  createFrameExportController,
  type FrameExportController,
  type FrameExportState,
} from "./controller";

/** The options of `openPngSaveDialog`. */
export interface PngSaveDialogOptions {
  /** The name that the dialog offers. */
  readonly defaultName: string;
  /** The localized label of the PNG filter. */
  readonly filterName: string;
  /** The save function of the dialog plugin. A test passes a fake. */
  readonly saveDialog?: typeof tauriSave;
}

/**
 * Opens the save dialog of the system with the filter PNG, and answers with the chosen path, or
 * null when the user cancels. A failure of the dialog rejects.
 */
export async function openPngSaveDialog(
  options: PngSaveDialogOptions,
): Promise<string | null> {
  const saveDialog = options.saveDialog ?? tauriSave;
  const selected = await saveDialog({
    defaultPath: options.defaultName,
    filters: [{ name: options.filterName, extensions: ["png"] }],
  });
  return typeof selected === "string" && selected.trim().length > 0 ? selected : null;
}

/** The one controller of the application. The key, the button and the menu item run it. */
export const frameExportController: FrameExportController = createFrameExportController(
  {
    chooseOutputPath: (defaultName) =>
      openPngSaveDialog({ defaultName, filterName: i18n.t("dialog.pngFilter") }),
    exportFrame: (request) => exportFrame(request),
  },
);

/** React hook for the state of the action. */
export function useFrameExportStore<T>(selector: (state: FrameExportState) => T): T {
  return useStore(frameExportController.store, selector);
}
