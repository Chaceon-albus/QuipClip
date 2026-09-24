/**
 * Pure rules for what the export dialog renders: the step, and the frame that shows while the
 * dialog closes.
 */

import type { ExportStatus } from "@/features/export";
import { isExportRunActive } from "./exportCancelState";

/**
 * The three steps of the dialog. A change of step fades the new content in.
 *
 * - `setup`: the preset choice before the save dialog (ADR 024).
 * - `progress`: an active run.
 * - `result`: a run that ended, or a failure of the open step.
 */
export type ExportDialogStep = "setup" | "progress" | "result";

export function resolveExportDialogStep(status: ExportStatus): ExportDialogStep {
  if (status === "idle") {
    return "setup";
  }
  return isExportRunActive(status) ? "progress" : "result";
}

/**
 * Selects the frame that the dialog renders.
 *
 * The dialog holds the frame that showed when a close started, and renders it until the exit
 * animation ends. The store can reset during that animation, and a run can end, so the live
 * frame would collapse or swap the content while it fades out.
 *
 * An open dialog always renders the live frame, so a reopen during the exit animation shows
 * fresh content. A closed dialog with no held frame renders the live frame too.
 */
export function selectShownFrame<T>(open: boolean, live: T, held: T | null): T {
  return open || held === null ? live : held;
}
