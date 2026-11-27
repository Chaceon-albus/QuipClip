/**
 * The production open step of the page (ADR 072, "The open of a project").
 *
 * The quit guard makes the one instance (`createQuitGuard`), because the save prompt of the open
 * is a form of its dialog, and a quit stops the open first. This module gives the parts of the
 * page that the step reads: the test for another dialog of the window, the file dialog of
 * "Locate…", the save step and the stale mark of the export open step.
 *
 * The save step that the page gives to the open step reports a save that failed itself, to the
 * save error dialog. So the error of a save that the save prompt of the open started always
 * shows, also when a quit stopped the open during the write and the open answered `canceled`.
 */

import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { VIDEO_FILE_EXTENSIONS } from "@/features/media/dialog";
import type { DropContentAnswer } from "@/features/project/dropContent";
import {
  createProjectOpenStep,
  openProjectStore,
  type ProjectOpenStep,
} from "@/features/project/openStep";
import { projectSaveStep } from "@/features/project/saveAction";
import { projectSaveErrorStore } from "@/features/project/saveErrorStore";
import type { ProjectSaveError, ProjectSaveStep } from "@/features/project/saveStep";
import {
  segmentTrimSession,
  type SegmentTrimSession,
} from "@/components/timeline/segmentTrimSession";
import { i18n } from "@/i18n";
import { isSystemFileDialogOpen, trackSystemFileDialog } from "@/lib/systemFileDialog";
import { staleExportOpenStep } from "./exportFlowController";
import { isPageOverlayOpen } from "./nativeContextMenuState";

/**
 * True while a trim of a segment edge is in progress (ADR 030): a drag trims an edge, a press on
 * an edge is armed (the key layer reads both as `isTrimDragging` and `isTrimArmed`), or a
 * released trim still waits for the frame that commits it (its view is in `committing`).
 *
 * @param session The trim session. The session of the page by default.
 */
export function isSegmentTrimBusy(
  session: Pick<SegmentTrimSession, "isLocked" | "getView"> = segmentTrimSession,
): boolean {
  return session.isLocked() || session.getView() !== null;
}

/**
 * Waits until no released trim waits for the frame that commits it (ADR 030): the trim committed,
 * or it gave up. The session bounds that wait itself (`TRIM_FRAME_WAIT_MS` of visible time), so
 * the promise settles without a bound of its own. Answers null, and waits for nothing, when no
 * trim waits, so the caller can go on in the same call.
 *
 * The open of a project waits for it before its step tests for another dialog, so a project that
 * the user picks while a trim waits opens after the trim, and its save prompt sees the commit.
 *
 * @param session The trim session. The session of the page by default.
 */
export function whenTrimSettled(
  session: Pick<SegmentTrimSession, "getView" | "subscribe"> = segmentTrimSession,
): Promise<void> | null {
  const waits = () => session.getView()?.phase === "committing";
  if (!waits()) {
    return null;
  }
  return new Promise<void>((resolve) => {
    const unsubscribe = session.subscribe(() => {
      if (!waits()) {
        unsubscribe();
        resolve();
      }
    });
  });
}

/** The tests of `isOtherDialogOpen`. Each one defaults to the production test. */
export interface OtherDialogTests {
  /** An overlay of the page. `isPageOverlayOpen` by default. */
  readonly hasPageOverlay?: () => boolean;
  /** A file dialog of the system that the page opened. `isSystemFileDialogOpen` by default. */
  readonly hasSystemFileDialog?: () => boolean;
  /** A trim of a segment edge in progress. `isSegmentTrimBusy` by default. */
  readonly isTrimBusy?: () => boolean;
}

/**
 * True when another dialog of the window is open (open step 2): a modal layer of the page
 * (`MODAL_LAYER_SELECTOR`), a native context menu of the page, or a file dialog of the system
 * that the page opened. A trim of a segment edge in progress counts too, so no edit of the trim
 * lands behind the project dialog.
 *
 * A released trim that waits for its commit counts too. The open of a project waits for it first
 * (`whenTrimSettled`), so at the first test only a trim that started again counts.
 *
 * The project dialog of the open that asks does not count: the step tests this before it sets
 * its first phase, so the dialog is not mounted then. The save prompt of the open shows only
 * after the first test, and the step tests again only after a save, when the prompt is closed.
 */
export function isOtherDialogOpen(tests: OtherDialogTests = {}): boolean {
  const hasPageOverlay = tests.hasPageOverlay ?? (() => isPageOverlayOpen());
  const hasSystemFileDialog = tests.hasSystemFileDialog ?? isSystemFileDialogOpen;
  const isTrimBusy = tests.isTrimBusy ?? (() => isSegmentTrimBusy());
  return hasPageOverlay() || hasSystemFileDialog() || isTrimBusy();
}

/**
 * The save step `saveStep`, with each save that fails reported to `report` before its caller
 * gets the result. The report comes before each wait for the end of the step (`whenIdle`) goes
 * on, because the step settles the promise of the save first. So a quit that waits for that save
 * sees the error, and it ends with no quit (unit 3a).
 */
export function reportingSaveStep(
  saveStep: Pick<ProjectSaveStep, "save" | "whenIdle">,
  report: (error: ProjectSaveError) => void,
): Pick<ProjectSaveStep, "save" | "whenIdle"> {
  return {
    whenIdle: () => saveStep.whenIdle(),
    save: (mode) =>
      saveStep.save(mode).then((result) => {
        if (result.status === "failed") {
          report(result.error);
        }
        return result;
      }),
  };
}

/** The options of `openLocateFileDialog`. */
export interface LocateFileDialogOptions {
  /** The directory that the dialog shows first, or null for a directory of the system. */
  readonly defaultDirectory: string | null;
  /** The localized label of the filter of videos. */
  readonly filterName: string;
  /** The open function of the dialog plugin. A test passes a fake. */
  readonly openDialog?: typeof tauriOpen;
}

/**
 * The file dialog of the system for "Locate…" (ADR 072, "The files that the user locates"): one
 * file, with the filter of videos, in the directory of the path that the document has. Answers
 * the chosen path, or null when the user cancels. A dialog that fails rejects, and the open step
 * keeps the row as it is.
 *
 * The dialog counts as a file dialog of the system that the page opened
 * (`trackSystemFileDialog`), so the command items of the macOS menu do nothing while it shows.
 */
export async function openLocateFileDialog(
  options: LocateFileDialogOptions,
): Promise<string | null> {
  const openDialog = options.openDialog ?? tauriOpen;
  const selected: unknown = await trackSystemFileDialog(() =>
    openDialog({
      multiple: false,
      directory: false,
      ...(options.defaultDirectory === null
        ? {}
        : { defaultPath: options.defaultDirectory }),
      filters: [{ name: options.filterName, extensions: [...VIDEO_FILE_EXTENSIONS] }],
    }),
  );
  return typeof selected === "string" && selected.trim().length > 0 ? selected : null;
}

/**
 * Creates the open step of the page over its production parts. `ask` shows the save prompt of
 * the open, and answers Save, Don't Save or Cancel. The step writes to `openProjectStore`, which
 * the project dialog shows. A save that the save prompt started and that fails shows in the save
 * error dialog (`reportingSaveStep`).
 */
export function createPageOpenStep(
  ask: () => Promise<DropContentAnswer>,
): ProjectOpenStep {
  return createProjectOpenStep({
    saveStep: reportingSaveStep(projectSaveStep, (error) => {
      projectSaveErrorStore.getState().report(error);
    }),
    ask,
    isOtherDialogOpen: () => isOtherDialogOpen(),
    pickFile: (defaultDirectory) =>
      openLocateFileDialog({
        defaultDirectory,
        filterName: i18n.t("dialog.videoFilter"),
      }),
    staleExportOpenStep,
    store: openProjectStore,
  });
}
