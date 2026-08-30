/**
 * Typed IPC client for media import operations.
 */

import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import type { ImportMediaResult } from "./types";
import { normalizeImportMediaError, validateImportMediaResult } from "./validation";

/**
 * Options for configuring `importMedia` execution.
 */
export interface ImportMediaClientOptions {
  /**
   * Optional custom invoke function (useful for dependency injection in tests).
   */
  invoke?: InvokeFn;
}

/**
 * Invokes the backend `import_media` command with arguments `{ path }`.
 *
 * Validates the response structure on success and normalizes any rejection into an `ImportMediaError`.
 *
 * @param path Canonical absolute file path to import.
 * @param options Optional client configuration containing custom invoke.
 * @returns The validated ImportMediaResult.
 * @throws ImportMediaError if the backend rejects or returns malformed data.
 */
export async function importMedia(
  path: string,
  options: ImportMediaClientOptions = {},
): Promise<ImportMediaResult> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.IMPORT_MEDIA, {
      path,
    });
    return validateImportMediaResult(rawResult);
  } catch (error) {
    throw normalizeImportMediaError(error);
  }
}
