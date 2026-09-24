/**
 * Pure rules for what the export dialog renders: the step, the footer, and the frame that
 * shows while the dialog closes.
 */

import type { ExportState, ExportStatus } from "@/features/export";
import { isExportRunLive } from "@/features/export/runState";
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
 * The footers of the dialog.
 *
 * - `setup`: Cancel and "Export..." (ADR 024).
 * - `run`: Stop Export and "Run in Background" (ADR 025). This is the footer of every live run
 *   (`isExportRunLive`): an active status, and also a `failed` that the store still tracks.
 *   A Stop request failed there, and the backend still encodes, so the footer offers the
 *   same two actions: the user can ask for the stop again, or hide the dialog. It offers no
 *   action that resets the store.
 * - `confirmation`: Cancel, Re-import and Export Anyway, for `sourceRevisionChanged`.
 * - `finished`: Show, Open and Done (ADR 029).
 * - `result`: Close and the recovery of the error, for a run that ended without an output,
 *   or for a failure of the open step.
 */
export type ExportDialogFooter =
  "setup" | "run" | "confirmation" | "finished" | "result";

/** The fields of the store that decide the footer. */
export type ExportDialogFooterInput = Pick<
  ExportState,
  "status" | "tracking" | "error"
>;

/**
 * Resolves the footer of the dialog. A live run comes before the confirmation and the
 * results, so the footer of a live run never offers a reset.
 */
export function resolveExportDialogFooter({
  status,
  tracking,
  error,
}: ExportDialogFooterInput): ExportDialogFooter {
  if (status === "idle") {
    return "setup";
  }
  if (isExportRunLive({ status, tracking })) {
    return "run";
  }
  if (status === "failed" && error?.code === "sourceRevisionChanged") {
    return "confirmation";
  }
  return status === "finished" ? "finished" : "result";
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
