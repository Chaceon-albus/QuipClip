/**
 * Pure rules for the queue list of the export dialog: whether the list shows, and what each
 * row of the batch shows (ADR 049).
 *
 * The list shows the runs of the batch in the order of submission: the runs that ended, the
 * run that holds the slot, and the runs that wait. A finished run keeps Show File (ADR 029).
 * A waiting run can be removed.
 */

import type {
  ExportOutputActionRunState,
  ExportOutputActionState,
  ExportQueueRow,
  ExportState,
} from "@/features/export";
import { selectExportOutputAction } from "@/features/export/outputActionStore";
import { isExportRunLive } from "@/features/export/runState";
import { presentExportOutcome, type ExportErrorView } from "./exportErrorPresenter";
import {
  outputActionErrorKey,
  presentOutputFile,
  type OutputActionErrorKey,
} from "./exportFinishedPresenter";

/** The catalog key of the status label of a row. */
export type ExportQueueStatusKey =
  | "export.queue.status.waiting"
  | "export.queue.status.current"
  | "export.queue.status.finished"
  | "export.queue.status.failed"
  | "export.queue.status.canceled";

/** The state of Show File for a finished row. */
export interface ExportQueueShowView {
  /** True while the show request of the run is in flight. */
  pending: boolean;
  /** The catalog key of the failure of the last show request, or null. */
  errorKey: OutputActionErrorKey | null;
  /** The diagnostic text of that failure, or null. */
  errorDetail: string | null;
}

/** One row of the queue list. */
export interface ExportQueueRowView {
  /** The run id. It is the React key of the row, so a row keeps its place in the list. */
  key: string;
  runId: string;
  /** The file name of the output, with its extension. */
  fileName: string;
  /** The file name before its extension, and the extension, for a truncated display. */
  fileStem: string;
  fileExtension: string;
  /** The complete output path, for the tooltip of the file name. */
  fullPath: string;
  /** The name of the folder of the output, or null. */
  folderName: string | null;
  presetName: string;
  statusKey: ExportQueueStatusKey;
  /**
   * True for the row of the run of the export store. The list highlights it. The run panel
   * and the footer above the list already show this run, with its Show File and its failure.
   * So the current row shows only its file name, its preset name, and its status label.
   */
  current: boolean;
  /** The state of Show File, for an ended row that finished. Null for every other row. */
  show: ExportQueueShowView | null;
  /** True for a waiting row that the backend does not cancel yet. */
  canRemove: boolean;
  /** True for a waiting row that the backend cancels now. Its Remove button is disabled. */
  removing: boolean;
  /**
   * The error message, for an ended row that failed: the catalog key and its values, as the
   * failed notice of the dialog takes them. Null for every other row, also for the current
   * row of a failed run: the run panel shows that failure.
   */
  error: ExportErrorView | null;
}

/** The view of the queue list. Null when the list does not show. */
export interface ExportQueueView {
  rows: ExportQueueRowView[];
}

export interface ExportQueueViewInput {
  /** The rows of `selectExportQueueRows`, in the order of submission. */
  rows: readonly ExportQueueRow[];
  /** The number of runs of the batch (`ExportQueueState.order`). */
  batchSize: number;
  /** The fields of the export store that decide the status of the current row. */
  exportState: Pick<ExportState, "status" | "tracking" | "error">;
  /** The Show state of each run (`ExportOutputActionState`). */
  outputActions: ExportOutputActionState;
}

/** The end of a row: the status label and, for a failure, the error message. */
interface RowEnd {
  statusKey: ExportQueueStatusKey;
  error: ExportErrorView | null;
}

/**
 * The status of a run that ended. The error presenter decides between a stop and a failure,
 * so a run with the `canceled` code never shows as failed, and the message of a failure comes
 * from the one code table of that presenter.
 */
function presentEnd(
  status: "finished" | "failed" | "canceled",
  error: ExportState["error"],
): RowEnd {
  if (status === "finished") {
    return { statusKey: "export.queue.status.finished", error: null };
  }
  const outcome = presentExportOutcome({ status, error, tracking: false });
  if (outcome.kind === "failed") {
    return { statusKey: "export.queue.status.failed", error: outcome.message };
  }
  return { statusKey: "export.queue.status.canceled", error: null };
}

/**
 * The status of the current row. While the run is live (`isExportRunLive`), the row says that
 * it exports. A `failed` that the store still tracks is live: a Stop request failed, and the
 * backend still encodes. After its end, the row shows the end that the export store keeps.
 */
function presentCurrent(
  exportState: Pick<ExportState, "status" | "tracking" | "error">,
): RowEnd {
  const { status, tracking, error } = exportState;
  if (
    !isExportRunLive({ status, tracking }) &&
    (status === "finished" || status === "failed" || status === "canceled")
  ) {
    return presentEnd(status, error);
  }
  return { statusKey: "export.queue.status.current", error: null };
}

function presentShow(state: ExportOutputActionRunState): ExportQueueShowView {
  return {
    pending: state.pending,
    errorKey: state.error === null ? null : outputActionErrorKey(state.error.code),
    errorDetail: state.error?.detail ? state.error.detail : null,
  };
}

/**
 * Builds the view of the queue list, or null when the list does not show.
 *
 * The list shows only when the batch has more than one run. A batch of one run is the export
 * of the dialog before the queue, so the dialog then looks as it did before.
 */
export function presentExportQueue({
  rows,
  batchSize,
  exportState,
  outputActions,
}: ExportQueueViewInput): ExportQueueView | null {
  if (batchSize <= 1 || rows.length === 0) {
    return null;
  }
  return {
    rows: rows.map((row) => {
      const current = row.phase === "current";
      let end: RowEnd;
      if (current) {
        end = presentCurrent(exportState);
      } else if (row.phase === "ended" && row.ended !== null) {
        end = presentEnd(row.ended.status, row.ended.error);
      } else {
        end = { statusKey: "export.queue.status.waiting", error: null };
      }
      const waiting = row.phase === "waiting";
      const file = presentOutputFile(row.job.outputPath);
      return {
        key: row.runId,
        runId: row.runId,
        // A path with no segment keeps the whole path as its name, so the row is never empty.
        fileName: file?.fileName ?? row.job.outputPath,
        fileStem: file?.fileStem ?? row.job.outputPath,
        fileExtension: file?.fileExtension ?? "",
        fullPath: row.job.outputPath,
        folderName: file?.folderName ?? null,
        presetName: row.job.presetName,
        statusKey: end.statusKey,
        current,
        show:
          !current && end.statusKey === "export.queue.status.finished"
            ? presentShow(selectExportOutputAction(outputActions, row.runId))
            : null,
        canRemove: waiting && !row.removing,
        removing: waiting && row.removing,
        error: current ? null : end.error,
      };
    }),
  };
}
