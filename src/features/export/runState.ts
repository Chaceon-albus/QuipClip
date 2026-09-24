/**
 * Pure rules about the run that the export store holds.
 */

import type { ExportState } from "./types";

/** The two fields of the export store that decide whether it holds a live run. */
export type ExportRunLiveState = Pick<ExportState, "status" | "tracking">;

/**
 * True while the store holds a run that can still end: `preparing`, `running` or
 * `publishing`, or `failed` while the store still tracks the run.
 *
 * The store reports `failed` with `tracking` still true when a Stop request rejects while
 * the run continues, by run id or by slot while the start waits for its run id. The backend
 * still prepares or encodes that run, and its own `finished` or `failed` event, or the
 * refusal of its start, comes later.
 *
 * The dismissal of the export dialog and the open step of the export flow read this rule,
 * so that no reset drops a live run: they show the run instead (ADR 025). The quit guard
 * reads it too, because a quit stops a live run (ADR 017, ADR 027).
 */
export function isExportRunLive({ status, tracking }: ExportRunLiveState): boolean {
  return (
    status === "preparing" ||
    status === "running" ||
    status === "publishing" ||
    (status === "failed" && tracking)
  );
}
