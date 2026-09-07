import type { ExportStatus } from "@/features/export";

/**
 * Inputs the cancel button derives its state from.
 */
export interface ExportCancelStateInput {
  /** Current lifecycle status held by the export store. */
  status: ExportStatus;
  /** Identifier of the active run, or null before the backend answers with one. */
  runId: string | null;
  /** Run the user asked to cancel, or null if the user asked for no cancel. */
  cancelingRunId: string | null;
}

/**
 * Answers whether the dialog must refuse every dismissal: Escape, the outside click, the
 * close control, and the Close button.
 *
 * "preparing" WITHOUT a run id stays dismissable, and it is now a real exit rather than a
 * trade. The dialog cancels before it dismisses in that phase: the store has no run id to
 * name, so it calls `cancel_active_export`, which stops whichever run holds the single export
 * slot. In this window that is the run the store just started, because no other export can
 * claim a slot this one has not released.
 *
 * So a dismissal here reaches the backend and asks the run to stop. The run ends, and releases
 * the slot, at the NEXT point it tests the cancel flag -- before the re-probe, before the
 * reservation, before ffmpeg spawns, and once more before the rename (ADR 016). The flag is
 * tested between those steps, never inside one, so a step already running finishes first: a
 * retry inside the remainder of the current step can still be refused with
 * `exportAlreadyRunning`. That remainder is up to `PROBE_TIMEOUT`, 30 seconds, for the
 * re-probe, and unbounded while `discover` walks a `PATH` entry that stopped answering. The
 * store's `reset` still invalidates the in-flight start through its request counter, so the
 * store's own state stays consistent whichever way the backend answers.
 *
 * One window remains, and it is the one ADR 016 already accepts: a cancel that lands after the
 * worker's last test still publishes the output. Dismissal cannot promise that no file is
 * written, only that the run is asked to stop.
 */
export function isExportDismissalRefused({
  status,
  runId,
}: Pick<ExportCancelStateInput, "status" | "runId">): boolean {
  if (status === "preparing") {
    return runId !== null;
  }
  return status === "running" || status === "publishing";
}

/**
 * Answers whether a cancel the user asked for is still outstanding.
 *
 * The flag is keyed to a run id rather than held as a boolean, so a cancel that names
 * another run does not count: a new export carries a new run id and starts clean.
 */
export function isCancelOutstanding({
  status,
  runId,
  cancelingRunId,
}: ExportCancelStateInput): boolean {
  if (status !== "preparing" && status !== "running" && status !== "publishing") {
    return false;
  }
  return cancelingRunId !== null && cancelingRunId === runId;
}

/**
 * Answers whether the cancel button accepts a click.
 *
 * "preparing" accepts a click with no run id. The store reaches the backend without one there,
 * through `cancel_active_export`, which stops whichever run holds the single export slot; that
 * is the run the store just started, for the reason `isExportDismissalRefused` gives above.
 * This is the phase that most needs the button, because preparation includes a re-probe bounded
 * at 30 seconds and the run holds the export slot for all of it.
 *
 * "publishing" still refuses it, and for an unchanged reason: the backend runs its last cancel
 * test before it emits the event that puts the interface into that phase (ADR 016), so a cancel
 * there cannot stop the rename. The button would report a cancel that never happened while the
 * export still writes the file.
 *
 * "running" still requires a run id, because the store only reaches that status from a `started`
 * or `progress` event, and an event can only arrive for a run the store already knows by id.
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
