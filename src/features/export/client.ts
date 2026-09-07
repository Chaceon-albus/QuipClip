/**
 * Typed IPC client for media export operations.
 */

import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import type { ExportRequest, ExportStart } from "./types";
import { normalizeExportError, validateExportStart } from "./validation";

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
 * Validates the initial start response on success and normalizes any rejection into an `ExportError`.
 *
 * @param request The export parameters and segment boundaries.
 * @param options Optional client configuration containing custom invoke.
 * @returns The validated ExportStart.
 * @throws ExportError if the backend rejects or returns malformed data.
 */
export async function startExport(
  request: ExportRequest,
  options: ExportClientOptions = {},
): Promise<ExportStart> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.START_EXPORT, {
      request,
    });
    return validateExportStart(rawResult);
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

/**
 * Invokes the backend `cancel_active_export` command, which takes no arguments.
 *
 * This cancels whichever run holds the single export slot, and it exists for the window in
 * which no run id is available: `start_export` claims the slot, prepares, and answers with the
 * run id only afterward, so a user who cancels during preparation has nothing to name to
 * `cancelExport`. Use `cancelExport` wherever a run id is known; the backend command
 * documents why cancelling by slot is safe in that one window and nowhere else.
 *
 * Checks that the return value is a boolean and normalizes any rejection into an `ExportError`.
 *
 * @param options Optional client configuration containing custom invoke.
 * @returns True if a run held the slot and was asked to stop, false if the slot was free.
 * @throws ExportError if the backend rejects or returns malformed data.
 */
export async function cancelActiveExport(
  options: ExportClientOptions = {},
): Promise<boolean> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.CANCEL_ACTIVE_EXPORT);
    if (typeof rawResult !== "boolean") {
      throw new TypeError("Invalid cancel active export result: expected boolean");
    }
    return rawResult;
  } catch (error) {
    throw normalizeExportError(error);
  }
}
