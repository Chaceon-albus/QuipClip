/**
 * The production save step of the page, its save dialog, and the Save action (ADR 072, "Save").
 *
 * The key `primary`+S, the Save and Save As items of the macOS menu and of the File menu of the
 * title bar run `runSaveProjectAction`. The action shows nothing for a save that succeeded, that
 * the user canceled, or that did nothing because another save runs. A save that failed puts its
 * error in the save error store, and the save error dialog shows it.
 */

import { save as tauriSave } from "@tauri-apps/plugin-dialog";
import { i18n } from "@/i18n";
import { trackSystemFileDialog } from "@/lib/systemFileDialog";
import { PROJECT_FILE_EXTENSION, pathInDirectory } from "./paths";
import { projectSaveErrorStore } from "./saveErrorStore";
import {
  createProjectSaveStep,
  type ProjectSaveError,
  type ProjectSaveMode,
  type ProjectSaveResult,
  type ProjectSaveStep,
} from "./saveStep";

/** The options of `openProjectSaveDialog`. */
export interface ProjectSaveDialogOptions {
  /** The name of the file that the dialog proposes. */
  readonly defaultName: string;
  /** The directory that the dialog proposes, or null for a directory of the system. */
  readonly defaultDirectory: string | null;
  /** The localized label of the filter of project files. */
  readonly filterName: string;
  /** The save function of the dialog plugin. A test passes a fake. */
  readonly saveDialog?: typeof tauriSave;
}

/**
 * Opens the save dialog of the system with the filter of project files, and answers with the
 * chosen path, or null when the user cancels. A failure of the dialog rejects, and the save step
 * makes it the error `dialogFailed`.
 *
 * The dialog is modal to the window, so the page gets no key press and no click while it shows.
 * The macOS application menu still works then, and its command items do nothing while the
 * dialog counts as open (`isSystemFileDialogOpen`).
 */
export async function openProjectSaveDialog(
  options: ProjectSaveDialogOptions,
): Promise<string | null> {
  const saveDialog = options.saveDialog ?? tauriSave;
  const selected = await trackSystemFileDialog(() =>
    saveDialog({
      defaultPath: pathInDirectory(options.defaultDirectory, options.defaultName),
      filters: [
        { name: options.filterName, extensions: [PROJECT_FILE_EXTENSION.slice(1)] },
      ],
    }),
  );
  return typeof selected === "string" && selected.trim().length > 0 ? selected : null;
}

/** The one save step of the page. The Save action and the save prompt run it. */
export const projectSaveStep: ProjectSaveStep = createProjectSaveStep({
  showSaveDialog: (defaultName, defaultDirectory) =>
    openProjectSaveDialog({
      defaultName,
      defaultDirectory,
      filterName: i18n.t("dialog.projectFilter"),
    }),
});

/** The dependencies of `createSaveProjectAction`. Each one defaults to the production value. */
export interface SaveProjectActionDependencies {
  readonly saveStep?: Pick<ProjectSaveStep, "save">;
  /** Shows the error of a failed save. Defaults to the save error store. */
  readonly reportError?: (error: ProjectSaveError) => void;
}

/**
 * Creates the Save action: Save for `save`, Save As for `saveAs`. It runs the save step, and it
 * reports the error of a failed step. The caller tests the conditions of the action
 * (`canSaveProject`) first.
 */
export function createSaveProjectAction(
  dependencies: SaveProjectActionDependencies = {},
): (mode: ProjectSaveMode) => Promise<ProjectSaveResult> {
  const saveStep = dependencies.saveStep ?? projectSaveStep;
  const reportError =
    dependencies.reportError ??
    ((error: ProjectSaveError) => {
      projectSaveErrorStore.getState().report(error);
    });
  return async (mode) => {
    const result = await saveStep.save(mode);
    if (result.status === "failed") {
      reportError(result.error);
    }
    return result;
  };
}

/** The Save action of the page. */
export const runSaveProjectAction: (
  mode: ProjectSaveMode,
) => Promise<ProjectSaveResult> = createSaveProjectAction();
