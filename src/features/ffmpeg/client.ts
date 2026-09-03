/**
 * Typed IPC client for ffmpeg capability probe operations.
 */

import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import type { CapabilityProbeStart } from "./types";
import {
  normalizeCapabilityProbeError,
  validateCapabilityProbeStart,
} from "./validation";

/**
 * Options for configuring `startCapabilityProbe` execution.
 */
export interface CapabilityProbeClientOptions {
  /**
   * Optional custom invoke function (useful for dependency injection in tests).
   */
  invoke?: InvokeFn;
}

/**
 * Invokes the backend `start_capability_probe` command with arguments `{ force }`.
 *
 * Validates the initial start response on success and normalizes any rejection into a `CapabilityProbeError`.
 *
 * @param force When true, ignores any existing cache and forces a fresh probe.
 * @param options Optional client configuration containing custom invoke.
 * @returns The validated CapabilityProbeStart.
 * @throws CapabilityProbeError if the backend rejects or returns malformed data.
 */
export async function startCapabilityProbe(
  force = false,
  options: CapabilityProbeClientOptions = {},
): Promise<CapabilityProbeStart> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.START_CAPABILITY_PROBE, {
      force,
    });
    return validateCapabilityProbeStart(rawResult);
  } catch (error) {
    throw normalizeCapabilityProbeError(error);
  }
}
