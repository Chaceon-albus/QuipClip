/**
 * Pure rules for the compose state of the export dialog: the setup of an export that joins
 * the queue while another export runs or waits (ADR 049).
 *
 * While the compose store is `composing`, the dialog shows the setup step, the confirmation,
 * or a failure of that setup, from the compose store. The export store keeps the live run,
 * and no compose path resets it.
 *
 * The module has no React and no document, so the tests need neither.
 */

import type {
  ExportComposeState,
  ExportQueueState,
  ExportState,
} from "@/features/export";
import { isExportRunLive } from "@/features/export/runState";

/** The fields of a target state that the step, the footer, and the handlers read. */
export type ExportDialogTargetState = Pick<
  ExportState,
  "status" | "tracking" | "error"
>;

/**
 * Selects the state that the dialog shows and that its handlers act on.
 *
 * While the compose store is `composing`, it is the status and the error of the compose
 * store, with `tracking` false. The compose store never holds a run, so this state is never
 * live (`isExportRunLive`). The step and footer rules then give the setup step for `idle`,
 * the confirmation for `sourceRevisionChanged`, and the result with Back for another failure.
 * Otherwise it is the state of the export store.
 */
export function selectExportDialogTargetState(
  compose: Pick<ExportComposeState, "composing" | "status" | "error">,
  exportState: ExportDialogTargetState,
): ExportDialogTargetState {
  if (compose.composing) {
    return { status: compose.status, tracking: false, error: compose.error };
  }
  return {
    status: exportState.status,
    tracking: exportState.tracking,
    error: exportState.error,
  };
}

/**
 * How the user leaves the compose state.
 *
 * - `dismiss`: the close control or Escape.
 * - `cancel`: Cancel of the setup step or of the confirmation, and Close of a failure.
 */
export type ExportComposeExitTrigger = "dismiss" | "cancel";

/**
 * What the dialog does after it leaves the compose state.
 *
 * - `closeDialog`: the dialog closes. The export store keeps its state, so a live run
 *   continues and a result stays for the status bar.
 * - `showRun`: the dialog stays open and shows the run view of the export store.
 */
export type ExportComposeExit = "closeDialog" | "showRun";

/**
 * Resolves what the dialog does when the user leaves the compose state. Each exit ends the
 * compose state, and none resets the export store.
 *
 * - The close control and Escape close the dialog, as they hide a live run (ADR 025).
 * - Cancel and Close go back to the run view while the export store holds a run or a result
 *   to show. An idle export store has nothing to show, so the dialog closes.
 */
export function resolveComposeExit(
  trigger: ExportComposeExitTrigger,
  exportState: Pick<ExportState, "status">,
): ExportComposeExit {
  if (trigger === "dismiss") {
    return "closeDialog";
  }
  return exportState.status === "idle" ? "closeDialog" : "showRun";
}

/** The inputs of the rule that names the confirm button of the setup step. */
export interface AddsToQueueInput {
  /** The status and the tracking of the export store. */
  readonly exportState: Pick<ExportState, "status" | "tracking">;
  /** The waiting runs and the open submissions of the queue store. */
  readonly queue: Pick<ExportQueueState, "waiting" | "submitting">;
  /**
   * True while the setup step submits its own export (`choosingDestination`). That
   * submission counts in `submitting`, and it does not make the export join a queue.
   */
  readonly ownSubmission: boolean;
}

/**
 * Answers whether an export that the setup step starts joins the queue: the export store
 * holds a live run (`isExportRunLive`), runs wait, or another submission has no answer yet.
 * This is the condition of `hasPendingExportWork`, less the submission of the step itself, so
 * the label does not change while the step submits its own export.
 */
export function addsToQueue({
  exportState,
  queue,
  ownSubmission,
}: AddsToQueueInput): boolean {
  if (isExportRunLive(exportState) || queue.waiting.length > 0) {
    return true;
  }
  return queue.submitting > (ownSubmission ? 1 : 0);
}

/** The catalog key of the confirm button of the setup step. */
export type SetupConfirmLabelKey =
  "export.action.chooseDestination" | "export.action.addToQueue";

/** "Add to Queue…" when the export joins the queue (`addsToQueue`), and "Export…" otherwise. */
export function resolveSetupConfirmLabelKey(queued: boolean): SetupConfirmLabelKey {
  return queued ? "export.action.addToQueue" : "export.action.chooseDestination";
}

/** The catalog key of the label of the close control. */
export type ExportCloseLabelKey = "export.action.hide" | "common.close";

/**
 * The label of the close control. It hides the dialog while the export store holds a live
 * run, also from the compose state, and the export continues. The label says so, because an
 * X usually reads as "close". Otherwise it reads "Close".
 */
export function resolveExportCloseLabelKey(
  exportRunLive: boolean,
): ExportCloseLabelKey {
  return exportRunLive ? "export.action.hide" : "common.close";
}

/**
 * Answers whether the run footer shows "New Export…". The footer shows no note of Stop Export
 * beside it: the note, the three buttons, and the row do not fit together, and the note then
 * breaks word by word. The note shows only while the run publishes (`presentStopButton`), and
 * the run ends soon after that.
 */
export function showsNewExportAction(stopNoteKey: string | null): boolean {
  return stopNoteKey === null;
}
