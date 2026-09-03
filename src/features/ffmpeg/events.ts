/**
 * Event listener abstraction for ffmpeg capability probe events.
 */

import { BACKEND_EVENTS, listenEvent, type ListenFn, type UnlistenFn } from "@/lib/ipc";
import type { CapabilityProbeEvent } from "./types";
import { validateCapabilityProbeEvent } from "./validation";

/**
 * Options for configuring `subscribeCapabilityProbe` execution.
 */
export interface SubscribeCapabilityProbeOptions {
  /**
   * Optional custom listen function (useful for dependency injection in tests).
   */
  listen?: ListenFn;
}

/**
 * Callback handler type for validated capability probe events.
 */
export type CapabilityProbeEventHandler = (event: CapabilityProbeEvent) => void;

/**
 * Subscribes to backend `ffmpeg:capability-probe` events.
 *
 * Validates each incoming payload against the CapabilityProbeEvent schema.
 * Payloads that fail validation are dropped safely without throwing or killing the listener.
 *
 * @param handler Callback invoked when a valid capability probe event arrives.
 * @param options Optional configuration including custom listen implementation.
 * @returns Promise resolving to an unlisten function.
 */
export async function subscribeCapabilityProbe(
  handler: CapabilityProbeEventHandler,
  options: SubscribeCapabilityProbeOptions = {},
): Promise<UnlistenFn> {
  return await listenEvent<unknown>(
    BACKEND_EVENTS.CAPABILITY_PROBE,
    (rawPayload) => {
      try {
        const validatedEvent = validateCapabilityProbeEvent(rawPayload);
        handler(validatedEvent);
      } catch {
        // A payload that fails validation is dropped, not thrown.
        // A malformed event must never kill the listener.
      }
    },
    options.listen,
  );
}
