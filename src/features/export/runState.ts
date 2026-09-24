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
 * The store reports `failed` with `tracking` still true when a call from the interface
 * rejects while the run continues, such as a Stop that fails at the IPC layer. The backend
 * still encodes that run, and its own `finished` or `failed` event comes later.
 */
export function isExportRunLive({ status, tracking }: ExportRunLiveState): boolean {
  return (
    status === "preparing" ||
    status === "running" ||
    status === "publishing" ||
    (status === "failed" && tracking)
  );
}
