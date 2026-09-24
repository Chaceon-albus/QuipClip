import type { ExportRunLiveState, ExportStatus } from "@/features/export";
import { isExportRunLive } from "@/features/export/runState";

/**
 * Kind of dismissal action performed when the export dialog is dismissed.
 *
 * "hide" hides the dialog while keeping a live export running behind it.
 * "close" closes the dialog and resets the export store.
 * See ADR 025.
 */
export type ExportDismissal = "hide" | "close";

/**
 * True while a run is active: preparing, running, or publishing, with or without a run id.
 *
 * The dialog shows the progress step in these statuses. A `failed` status that the store
 * still tracks is not active, and it is still live (`isExportRunLive`): it shows the result
 * step with the warning, and the Stop Export footer. The controls that must not drop a run
 * read `isExportRunLive` instead.
 */
export function isExportRunActive(status: ExportStatus): boolean {
  return status === "preparing" || status === "running" || status === "publishing";
}

/**
 * Resolves whether dismissing the dialog hides it while the export continues,
 * or closes it and resets the store.
 *
 * "hide" while the run is live (`isExportRunLive`): preparing, running, or publishing, with
 * or without a run id, and `failed` while the store still tracks the run. A Stop request
 * that failed gives that `failed`, and the backend still encodes, so a reset would drop the
 * only record of the run. "close" otherwise. See ADR 025.
 */
export function resolveExportDismissal(state: ExportRunLiveState): ExportDismissal {
  return isExportRunLive(state) ? "hide" : "close";
}

/**
 * Inputs the cancel button and cancel state derive from.
 */
export interface ExportCancelStateInput {
  /** Current lifecycle status held by the export store. */
  status: ExportStatus;
  /** Identifier of the active run, or null before the backend answers with one. */
  runId: string | null;
  /** Whether a cancel request asked for by the store is currently outstanding. */
  cancelRequested: boolean;
  /** The `tracking` field of the store. A `failed` that the store tracks is still live. */
  tracking: boolean;
}

/**
 * Answers whether a cancel request that the store asked for is currently outstanding.
 *
 * True while the run is live (`isExportRunLive`) and cancelRequested is true: in
 * preparing, running, publishing, and in a `failed` that the store still tracks, where the
 * user asked for the stop again. See ADR 025.
 */
export function isCancelOutstanding({
  status,
  tracking,
  cancelRequested,
}: Pick<ExportCancelStateInput, "status" | "tracking" | "cancelRequested">): boolean {
  return isExportRunLive({ status, tracking }) && cancelRequested;
}

/**
 * Answers whether the cancel button accepts a click.
 *
 * "preparing" accepts a click with or without a run id. The store reaches the backend
 * without one through `cancel_active_export`, which stops whichever run holds the single
 * export slot; that is the run the store just started. This is the phase that most needs
 * the button, because preparation includes a re-probe bounded at 30 seconds and the run
 * holds the export slot for all of it (ADR 016, ADR 025).
 *
 * "running" requires a run id, because the store only reaches that status from a `started`
 * or `progress` event, and an event can only arrive for a run the store already knows by id.
 *
 * "publishing" still refuses it: the backend runs its last cancel test before it emits the
 * event that puts the interface into that phase (ADR 016), so a cancel there cannot stop
 * the rename. The button would report a cancel that never happened while the export still
 * writes the file.
 *
 * "failed" while the store still tracks the run accepts a click. A Stop request failed, and
 * the backend did not confirm the stop, so the user can ask again. The store asks by run id
 * when it has one, and by slot while the start still waits for its run id. That `failed` is
 * never the publication. The `publishing` event changes the status to `publishing`, and a
 * Stop request that fails after that event keeps `publishing` (`reportStopFailure` in the
 * store), so the button stays disabled for the whole rename.
 *
 * Every other status carries no live run to stop and refuses. An outstanding cancel also
 * refuses.
 */
export function isCancelEnabled(input: ExportCancelStateInput): boolean {
  const { status, runId, tracking } = input;
  const liveFailure = status === "failed" && tracking;
  if (status !== "preparing" && status !== "running" && !liveFailure) {
    return false;
  }
  if (status === "running" && runId === null) {
    return false;
  }
  return !isCancelOutstanding(input);
}
