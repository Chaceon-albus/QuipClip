/**
 * Pure rules for what the export dialog renders: the step, the footer, the title, the
 * control that takes the focus, and the frame that shows while the dialog closes.
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
 * The footers of the dialog. `DialogActions` puts the buttons of each footer in the order of
 * the platform.
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

/** The catalog key of the title of the dialog. */
export type ExportDialogTitleKey = "export.title" | "export.sourceChanged.title";

/**
 * Resolves the title of the dialog. The confirmation asks a question of its own, so it has
 * its own title. Every other footer shows the title of the dialog.
 */
export function resolveExportDialogTitleKey(
  footer: ExportDialogFooter,
): ExportDialogTitleKey {
  return footer === "confirmation" ? "export.sourceChanged.title" : "export.title";
}

/**
 * A control of the dialog that the focus rule can name.
 *
 * - `primary`: "Export..." of the setup step.
 * - `setupFirstControl`: the first control of the setup step, the preset select, or Open
 *   Settings when no preset can be listed.
 * - `cancel`: Cancel of the confirmation.
 * - `done`: Done of the finished result.
 * - `dialog`: the dialog itself. Tab then goes to its first control.
 */
export type ExportDialogFocusTarget =
  "primary" | "setupFirstControl" | "cancel" | "done" | "dialog";

/**
 * The controls that take the focus when the dialog opens on `footer`, in order. The first
 * control that can take the focus takes it, and the dialog itself is always last. The same
 * order applies when the footer changes while the dialog is open and no control has the
 * focus, because the control that had it left with the old footer.
 *
 * - `setup`: "Export...", the default button, so Enter continues to the save dialog. While
 *   it is disabled, the first control of the step takes the focus, because the user must
 *   change something there first. Back gives the focus to the first control in any case,
 *   because Export is disabled until the checks of the open step end (`canGoBackToSetup`).
 * - `confirmation`: Cancel. The confirmation asks before an export that can cut the wrong
 *   frames, so Enter changes nothing.
 * - `finished`: Done, the default button of the result.
 * - `run` and `result`: the dialog. The run footer holds Stop Export, which Enter must not
 *   reach by accident. A result shows a notice that the user reads before a choice.
 */
export function resolveExportDialogFocusOrder(
  footer: ExportDialogFooter,
): readonly ExportDialogFocusTarget[] {
  switch (footer) {
    case "setup":
      return ["primary", "setupFirstControl", "dialog"];
    case "confirmation":
      return ["cancel", "dialog"];
    case "finished":
      return ["done", "dialog"];
    case "run":
    case "result":
      return ["dialog"];
  }
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
