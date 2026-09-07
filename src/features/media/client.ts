/**
 * Typed IPC client for media import operations.
 */

import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import type { MediaSourceRevisionDescriptor } from "./sourceIdentity";
import type { ImportMediaResult } from "./types";
import {
  normalizeImportMediaError,
  validateImportMediaResult,
  validateSourceRevision,
} from "./validation";

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

/**
 * Invokes the backend `read_source_revision` command with arguments `{ path }`.
 *
 * A stat, and nothing more: the backend runs no `ffprobe` and grants no asset scope, so this
 * costs a metadata read and answers the three facts a revision comparison needs.
 *
 * @param path Canonical absolute file path to stat.
 * @param options Optional client configuration containing custom invoke.
 * @returns The validated revision descriptor of the file on disk.
 * @throws ImportMediaError if the backend rejects or returns malformed data.
 */
export async function readSourceRevision(
  path: string,
  options: ImportMediaClientOptions = {},
): Promise<MediaSourceRevisionDescriptor> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.READ_SOURCE_REVISION, {
      path,
    });
    return validateSourceRevision(rawResult);
  } catch (error) {
    throw normalizeImportMediaError(error);
  }
}
