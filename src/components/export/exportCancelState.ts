import type { ExportStatus } from "@/features/export";

/**
 * Kind of dismissal action performed when the export dialog is dismissed.
 *
 * "hide" hides the dialog while keeping an active export running behind it.
 * "close" closes the dialog and resets the export store.
 * See ADR 025.
 */
export type ExportDismissal = "hide" | "close";

/**
 * Resolves whether dismissing the dialog hides it while the export continues,
 * or closes it and resets the store.
 *
 * "hide" in preparing, running, publishing (with or without a run id). "close" otherwise.
 * See ADR 025.
 */
export function resolveExportDismissal(status: ExportStatus): ExportDismissal {
  if (status === "preparing" || status === "running" || status === "publishing") {
    return "hide";
  }
  return "close";
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
}

/**
 * Answers whether a cancel request that the store asked for is currently outstanding.
 *
 * True in preparing, running, publishing when cancelRequested is true.
 * See ADR 025.
 */
export function isCancelOutstanding({
  status,
  cancelRequested,
}: Pick<ExportCancelStateInput, "status" | "cancelRequested">): boolean {
  if (status !== "preparing" && status !== "running" && status !== "publishing") {
    return false;
  }
  return cancelRequested;
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
 * Every other status carries no active run to stop and refuses. An outstanding cancel also
 * refuses.
 */
export function isCancelEnabled(input: ExportCancelStateInput): boolean {
  const { status, runId } = input;
  if (status !== "preparing" && status !== "running") {
    return false;
  }
  if (status === "running" && runId === null) {
    return false;
  }
  return !isCancelOutstanding(input);
}
