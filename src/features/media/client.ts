/**
 * Typed IPC client for media import operations.
 */

import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import type { MediaSourceRevisionDescriptor } from "./sourceIdentity";
import type { ExpectedRevision, ImportMediaResult } from "./types";
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
 * The arguments of `import_media` and `read_source_revision`. The key `expected` is absent when
 * the caller expects no revision, so the backend receives `{ path }` as before ADR 072.
 */
function revisionArguments(
  path: string,
  expected: ExpectedRevision | undefined,
): Record<string, unknown> {
  if (expected === undefined) {
    return { path };
  }
  const wire: Record<string, unknown> = { size: expected.size, mtime: expected.mtime };
  if (expected.fingerprint !== undefined) {
    wire.fingerprint = {
      start: expected.fingerprint.start,
      fnv1a64: expected.fingerprint.fnv1a64,
    };
  }
  return { path, expected: wire };
}

/**
 * Invokes the backend `import_media` command with arguments `{ path }`, or `{ path, expected }`
 * when the caller expects a revision (ADR 072).
 *
 * Validates the response structure on success and normalizes any rejection into an `ImportMediaError`.
 *
 * @param path Canonical absolute file path to import.
 * @param expected The revision that the file must be, or undefined for any revision. A file
 *   that does not hold it fails with `revisionMismatch`, before the probe and before the grant.
 * @param options Optional client configuration containing custom invoke.
 * @returns The validated ImportMediaResult.
 * @throws ImportMediaError if the backend rejects or returns malformed data.
 */
export async function importMedia(
  path: string,
  expected?: ExpectedRevision,
  options: ImportMediaClientOptions = {},
): Promise<ImportMediaResult> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(
      BACKEND_COMMANDS.IMPORT_MEDIA,
      revisionArguments(path, expected),
    );
    return validateImportMediaResult(rawResult);
  } catch (error) {
    throw normalizeImportMediaError(error);
  }
}

/**
 * Invokes the backend `read_source_revision` command with arguments `{ path }`, or
 * `{ path, expected }` when the caller expects a revision (ADR 072).
 *
 * A stat, and nothing more: the backend runs no `ffprobe` and grants no asset scope, so this
 * costs a metadata read and answers the three facts a revision comparison needs. With
 * `expected`, the backend gives the verdict of `import_media` for that revision, and a file that
 * does not hold it fails with `revisionMismatch`.
 *
 * @param path Canonical absolute file path to stat.
 * @param expected The revision that the file must be, or undefined for any revision.
 * @param options Optional client configuration containing custom invoke.
 * @returns The validated revision descriptor of the file on disk.
 * @throws ImportMediaError if the backend rejects or returns malformed data.
 */
export async function readSourceRevision(
  path: string,
  expected?: ExpectedRevision,
  options: ImportMediaClientOptions = {},
): Promise<MediaSourceRevisionDescriptor> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(
      BACKEND_COMMANDS.READ_SOURCE_REVISION,
      revisionArguments(path, expected),
    );
    return validateSourceRevision(rawResult);
  } catch (error) {
    throw normalizeImportMediaError(error);
  }
}
