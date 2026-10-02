/**
 * Show the file that a finished export wrote.
 *
 * The backend command takes the run id, not a path. The backend records the path that each
 * run published and acts only on that path, so the web view cannot ask the operating system
 * to show a path of its choice (`src-tauri/src/commands/export_output.rs`).
 */

import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";

/**
 * Stable error codes of `reveal_export_output`.
 *
 * `output.test.ts` reads the Rust enum and checks that this list names the same set.
 */
export const BACKEND_EXPORT_OUTPUT_ERROR_CODES = [
  "outputUnknown",
  "outputMissing",
  "revealFailed",
] as const;

export type BackendExportOutputErrorCode =
  (typeof BACKEND_EXPORT_OUTPUT_ERROR_CODES)[number];

/** The backend codes, and "unknown" for a rejection that carries no known code. */
export type ExportOutputErrorCode = BackendExportOutputErrorCode | "unknown";

/** A failed show request. */
export class ExportOutputError extends Error {
  /** Stable code for localization (ADR 011). */
  readonly code: ExportOutputErrorCode;
  /** Untranslated diagnostic text from the operating system, if any. */
  declare readonly detail?: string;

  constructor(code: ExportOutputErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ExportOutputError";
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isBackendExportOutputErrorCode(
  value: unknown,
): value is BackendExportOutputErrorCode {
  return (
    typeof value === "string" &&
    (BACKEND_EXPORT_OUTPUT_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Turns any rejection into an `ExportOutputError`.
 *
 * An object with a known `code` keeps its code and its string `detail`. A plain string, such
 * as a Tauri refusal of the command itself, becomes "unknown" with the string as the detail.
 */
export function normalizeExportOutputError(error: unknown): ExportOutputError {
  if (error instanceof ExportOutputError) {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;
    const code = isBackendExportOutputErrorCode(candidate.code)
      ? candidate.code
      : "unknown";
    const detail = typeof candidate.detail === "string" ? candidate.detail : undefined;
    return new ExportOutputError(code, detail);
  }
  if (typeof error === "string" && error.length > 0) {
    return new ExportOutputError("unknown", error);
  }
  return new ExportOutputError("unknown");
}

export interface ExportOutputClientOptions {
  /** Optional custom invoke function, for tests. */
  invoke?: InvokeFn;
}

/**
 * Asks the backend to show the file that the run `runId` published, selected in Finder or in
 * File Explorer.
 *
 * @throws ExportOutputError when the backend rejects the request.
 */
export async function revealExportOutput(
  runId: string,
  options: ExportOutputClientOptions = {},
): Promise<void> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    await invoke<unknown>(BACKEND_COMMANDS.REVEAL_EXPORT_OUTPUT, { runId });
  } catch (error) {
    throw normalizeExportOutputError(error);
  }
}
