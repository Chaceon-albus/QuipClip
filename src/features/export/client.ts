/**
 * Typed IPC client for media export operations.
 */

import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import type { ExportRequest, ExportSubmission } from "./types";
import { normalizeExportError, validateExportSubmission } from "./validation";

/**
 * Options for configuring export client command execution.
 */
export interface ExportClientOptions {
  /**
   * Optional custom invoke function (useful for dependency injection in tests).
   */
  invoke?: InvokeFn;
}

/**
 * Invokes the backend `start_export` command with arguments `{ request }`.
 *
 * Validates the answer on success and normalizes any rejection into an `ExportError`. The
 * backend answers as soon as it accepted the run, before the run prepares. A failure of
 * preparation arrives as a `failed` event, not as a rejection.
 *
 * @param request The export parameters and segment boundaries.
 * @param options Optional client configuration containing custom invoke.
 * @returns The validated ExportSubmission, with the run id.
 * @throws ExportError if the backend rejects or returns malformed data.
 */
export async function startExport(
  request: ExportRequest,
  options: ExportClientOptions = {},
): Promise<ExportSubmission> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.START_EXPORT, {
      request,
    });
    return validateExportSubmission(rawResult);
  } catch (error) {
    throw normalizeExportError(error);
  }
}

/**
 * Invokes the backend `cancel_export` command with arguments `{ runId }`.
 *
 * Checks that the return value is a boolean and normalizes any rejection into an `ExportError`.
 *
 * @param runId The identifier of the active export run to cancel.
 * @param options Optional client configuration containing custom invoke.
 * @returns True if cancellation was requested, false otherwise.
 * @throws ExportError if the backend rejects or returns malformed data.
 */
export async function cancelExport(
  runId: string,
  options: ExportClientOptions = {},
): Promise<boolean> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.CANCEL_EXPORT, {
      runId,
    });
    if (typeof rawResult !== "boolean") {
      throw new TypeError("Invalid cancel export result: expected boolean");
    }
    return rawResult;
  } catch (error) {
    throw normalizeExportError(error);
  }
}
