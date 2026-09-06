/**
 * Event listener abstraction for media export progress events.
 */

import { BACKEND_EVENTS, listenEvent, type ListenFn, type UnlistenFn } from "@/lib/ipc";
import type { ExportProgressEvent } from "./types";
import { validateExportProgressEvent } from "./validation";

/**
 * Options for configuring `subscribeExportProgress` execution.
 */
export interface SubscribeExportProgressOptions {
  /**
   * Optional custom listen function (useful for dependency injection in tests).
   */
  listen?: ListenFn;
}

/**
 * Callback handler type for validated export progress events.
 */
export type ExportProgressEventHandler = (event: ExportProgressEvent) => void;

/**
 * Subscribes to backend `export:progress` events.
 *
 * Validates each incoming payload against the ExportProgressEvent schema.
 * Payloads that fail validation are dropped safely without throwing or killing the listener.
 *
 * @param handler Callback invoked when a valid export progress event arrives.
 * @param options Optional configuration including custom listen implementation.
 * @returns Promise resolving to an unlisten function.
 */
export async function subscribeExportProgress(
  handler: ExportProgressEventHandler,
  options: SubscribeExportProgressOptions = {},
): Promise<UnlistenFn> {
  return await listenEvent<unknown>(
    BACKEND_EVENTS.EXPORT_PROGRESS,
    (rawPayload) => {
      try {
        const validatedEvent = validateExportProgressEvent(rawPayload);
        handler(validatedEvent);
      } catch {
        // A payload that fails validation is dropped, not thrown.
        // A malformed event must never kill the listener.
      }
    },
    options.listen,
  );
}
