/**
 * Show and open the file that a finished export wrote.
 *
 * The backend commands take the run id, not a path. The backend records the path that each
 * run published and acts only on that path, so the web view cannot ask the operating system
 * to open a path of its choice (`src-tauri/src/commands/export_output.rs`).
 */

import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";

/** The two requests the interface can make for a published file. */
export type ExportOutputAction = "reveal" | "open";

/**
 * Stable error codes of `reveal_export_output` and `open_export_output`.
 *
 * `output.test.ts` reads the Rust enum and checks that this list names the same set.
 */
export const BACKEND_EXPORT_OUTPUT_ERROR_CODES = [
  "outputUnknown",
  "outputMissing",
  "outputNotVideo",
  "revealFailed",
  "openFailed",
] as const;

export type BackendExportOutputErrorCode =
  (typeof BACKEND_EXPORT_OUTPUT_ERROR_CODES)[number];

/** The backend codes, and "unknown" for a rejection that carries no known code. */
export type ExportOutputErrorCode = BackendExportOutputErrorCode | "unknown";

/** A failed show or open request. */
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

const COMMAND_OF_ACTION = {
  reveal: BACKEND_COMMANDS.REVEAL_EXPORT_OUTPUT,
  open: BACKEND_COMMANDS.OPEN_EXPORT_OUTPUT,
} as const satisfies Record<ExportOutputAction, string>;

/**
 * Asks the backend to show or open the file that the run `runId` published.
 *
 * @throws ExportOutputError when the backend rejects the request.
 */
export async function performExportOutputAction(
  action: ExportOutputAction,
  runId: string,
  options: ExportOutputClientOptions = {},
): Promise<void> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    await invoke<unknown>(COMMAND_OF_ACTION[action], { runId });
  } catch (error) {
    throw normalizeExportOutputError(error);
  }
}
