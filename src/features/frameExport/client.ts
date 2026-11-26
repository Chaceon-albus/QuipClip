/**
 * The page side of `export_frame` (ADR 069).
 *
 * The client never throws. It answers with the path that Rust wrote, or with the failure in the
 * codes of `types.ts`, so the controller has one place that turns an answer into a notice.
 */

import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import {
  BACKEND_FRAME_EXPORT_ERROR_CODES,
  type FrameExportErrorCode,
  type FrameExportFailure,
  type FrameExportRequest,
} from "./types";

/** The answer of one command: the path of the image, or the failure. */
export type FrameExportResult =
  | { readonly kind: "done"; readonly outputPath: string }
  | { readonly kind: "failed"; readonly failure: FrameExportFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBackendCode(value: unknown): value is FrameExportErrorCode {
  return (
    typeof value === "string" &&
    (BACKEND_FRAME_EXPORT_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * The failure of a rejected `export_frame`. A rejection of Rust carries one of its codes and an
 * optional detail. Anything else, such as a refusal of the Tauri layer, is `unknown`, with no
 * detail: its text is not a diagnostic of the command (ADR 011).
 */
export function normalizeFrameExportError(error: unknown): FrameExportFailure {
  if (isRecord(error) && isBackendCode(error.code)) {
    const detail =
      typeof error.detail === "string" && error.detail.length > 0 ? error.detail : null;
    return { code: error.code, detail };
  }
  return { code: "unknown", detail: null };
}

/** Sends one request, and answers with the path of the image or with the failure. */
export async function exportFrame(
  request: FrameExportRequest,
  invoke?: InvokeFn,
): Promise<FrameExportResult> {
  let answer: unknown;
  try {
    answer = await invokeCommand<unknown>(
      BACKEND_COMMANDS.EXPORT_FRAME,
      { request },
      invoke,
    );
  } catch (error) {
    return { kind: "failed", failure: normalizeFrameExportError(error) };
  }
  if (
    isRecord(answer) &&
    typeof answer.outputPath === "string" &&
    answer.outputPath.length > 0
  ) {
    return { kind: "done", outputPath: answer.outputPath };
  }
  return { kind: "failed", failure: { code: "invalidResponse", detail: null } };
}
