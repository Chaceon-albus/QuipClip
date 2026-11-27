/**
 * The Open action (ADR 026, ADR 072, "One Open action").
 *
 * The item of the File menu of the title bar, the Open button of the empty preview
 * (`useOpenMediaAction`), the key and the item of the macOS menu (`runShortcutCommand`) all run
 * `runOpenAction`, so the entry points cannot drift apart in their filter or their error handling.
 *
 * The action first asks the quit guard whether it would take a request now (`canOpen`), so no
 * file dialog shows while a prompt shows, a flow runs, or the quit started. The file dialog of
 * the system lists videos and project files in one filter. All the files of one dialog go to
 * `requestOpen` of the quit guard as one request, as a drop does, so no other request comes
 * between two files of one dialog. `requestOpen` tests the guard again after the dialog. The quit guard decides what the request does:
 * it imports the videos, opens one project file, or opens nothing for a project file with other
 * files.
 *
 * The dialog that adds a video from the export dialog (ADR 024) does not use this action. It
 * keeps its filter of videos, and it sends its files to `requestVideos`.
 */

import type { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { openMediaFileDialog, VIDEO_FILE_EXTENSIONS } from "@/features/media/dialog";
import { PROJECT_FILE_EXTENSION } from "@/features/project/paths";
import { i18n } from "@/i18n";
import { quitGuard } from "./quitGuardController";

/** The extensions of the filter of the Open action, with no dot: the videos and `qcproj`. */
export const OPEN_FILE_EXTENSIONS: readonly string[] = [
  ...VIDEO_FILE_EXTENSIONS,
  PROJECT_FILE_EXTENSION.slice(1),
];

/** The dependencies of `createOpenAction`. Each one defaults to the production value. */
export interface OpenActionDependencies {
  /** The open function of the dialog plugin. */
  readonly openDialog?: typeof tauriOpen;
  /**
   * True when the guard would take a request now. Defaults to `quitGuard.canOpen`. While it is
   * false, the action shows no file dialog.
   */
  readonly canOpen?: () => boolean;
  /** Takes all the files of one dialog as one request. Defaults to `quitGuard.requestOpen`. */
  readonly requestOpen?: (paths: readonly string[]) => Promise<unknown>;
  /** Shows the error of a dialog that failed. Defaults to the error of the media store. */
  readonly reportError?: (error: unknown) => void;
  /** The localized label of the filter. Defaults to `dialog.openFilter`, read at each run. */
  readonly filterName?: () => string;
}

/** Creates the Open action over `dependencies`. */
export function createOpenAction(
  dependencies: OpenActionDependencies = {},
): () => Promise<void> {
  const filterName = dependencies.filterName ?? (() => i18n.t("dialog.openFilter"));
  const requestOpen =
    dependencies.requestOpen ??
    ((paths: readonly string[]) => quitGuard.requestOpen(paths));
  const canOpen = dependencies.canOpen ?? (() => quitGuard.canOpen());
  return async () => {
    if (!canOpen()) {
      return;
    }
    await openMediaFileDialog({
      filterName: filterName(),
      extensions: OPEN_FILE_EXTENSIONS,
      openPaths: requestOpen,
      openDialog: dependencies.openDialog,
      reportError: dependencies.reportError,
    });
  };
}

/** The Open action of the page. */
export const runOpenAction: () => Promise<void> = createOpenAction();
