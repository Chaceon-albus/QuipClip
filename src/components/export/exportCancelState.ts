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
 * Two phases refuse it. While `runId` is null the store cannot reach the backend, and
 * `cancelExport` answers false without a call. During "publishing" the backend runs its
 * last cancel test before it emits the event that puts the interface into that phase
 * (ADR 016), so a cancel there cannot stop the rename either. In both cases the button
 * would report a cancel that never happened while the export still writes the file.
 */
export function isCancelEnabled(input: ExportCancelStateInput): boolean {
  const { status, runId } = input;
  if (status !== "preparing" && status !== "running") {
    return false;
  }
  if (runId === null) {
    return false;
  }
  return !isCancelOutstanding(input);
}
