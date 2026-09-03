/**
 * Ffmpeg store managing binary discovery, capability probing status, and encoder test results.
 *
 * Implements:
 * - Pre-invocation subscription to prevent losing early located/result events.
 * - Monotonic counter & active runId matching for latest-request-wins semantics.
 * - Idempotent, memoized event subscription holding a Tauri listener for the process lifetime.
 * - ADR 005, ADR 006, and ADR 011.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { UnlistenFn } from "@/lib/ipc";
import { startCapabilityProbe } from "./client";
import { subscribeCapabilityProbe } from "./events";
import {
  CapabilityProbeError,
  type CapabilityProbeEvent,
  type CapabilityProbeStart,
  type FfmpegState,
  type FfmpegStoreState,
} from "./types";
import { normalizeCapabilityProbeError } from "./validation";

/**
 * Dependencies that can be injected into the ffmpeg store factory for testing.
 */
export interface FfmpegStoreDependencies {
  /**
   * Function to start capability probe via backend command. Defaults to `startCapabilityProbe`.
   */
  startCapabilityProbe?: (force?: boolean) => Promise<CapabilityProbeStart>;
  /**
   * Function to subscribe to backend capability probe events. Defaults to `subscribeCapabilityProbe`.
   */
  subscribeCapabilityProbe?: (
    handler: (event: CapabilityProbeEvent) => void,
  ) => Promise<UnlistenFn>;
}

/**
 * Factory function creating a vanilla Zustand store instance for ffmpeg capability state.
 *
 * @param dependencies Injected dependencies for testability.
 * @param initialState Optional initial state overrides.
 */
export function createFfmpegStore(
  dependencies: FfmpegStoreDependencies = {},
  initialState?: Partial<FfmpegState>,
): StoreApi<FfmpegStoreState> {
  const startCapabilityProbeFn =
    dependencies.startCapabilityProbe ?? startCapabilityProbe;
  const subscribeCapabilityProbeFn =
    dependencies.subscribeCapabilityProbe ?? subscribeCapabilityProbe;

  let latestRequestId = 0;
  let activeRunId: string | null = initialState?.runId ?? null;
  let subscriptionPromise: Promise<UnlistenFn> | null = null;
  let activeUnlisten: UnlistenFn | null = null;
  let pendingEvents: CapabilityProbeEvent[] = [];
  let awaitingRunId = false;

  return createStore<FfmpegStoreState>()((set) => {
    function handleEvent(event: CapabilityProbeEvent): void {
      if (awaitingRunId && !activeRunId) {
        pendingEvents.push(event);
        return;
      }

      // MUST ignore any payload whose runId is not the active run
      if (!activeRunId || event.runId !== activeRunId) {
        return;
      }

      switch (event.event) {
        case "located": {
          set((state) => ({
            status: state.status === "ready" ? "ready" : "probing",
            paths: {
              ffmpeg: event.ffmpeg,
              ffprobe: event.ffprobe,
            },
            origin: event.origin,
            version: event.version,
            license: event.license,
          }));
          break;
        }
        case "result": {
          set((state) => {
            const existingIndex = state.results.findIndex(
              (r) => r.name === event.result.name,
            );
            const nextResults =
              existingIndex >= 0
                ? state.results.map((r, i) => (i === existingIndex ? event.result : r))
                : [...state.results, event.result];

            return {
              status: state.status === "ready" ? "ready" : "probing",
              results: nextResults,
              done: event.done,
              total: event.total,
            };
          });
          break;
        }
        case "finished": {
          set({
            status: "ready",
            version: event.report.version,
            license: event.report.license,
            hwaccels: event.report.hwaccels,
            results: event.report.encoders,
            source: event.source,
            done: event.report.encoders.length,
            total: event.report.encoders.length,
            error: null,
          });
          break;
        }
        case "failed": {
          activeRunId = null;
          const normalizedError = new CapabilityProbeError({
            code: event.code,
            detail: event.detail,
            exitCode: event.exitCode,
            inspected: event.inspected,
          });
          set({
            status: event.code === "ffmpegPairMissing" ? "missing" : "failed",
            error: normalizedError,
            inspected: event.inspected ?? null,
          });
          break;
        }
      }
    }

    async function ensureSubscribed(): Promise<void> {
      if (!subscriptionPromise) {
        const currentPromise = subscribeCapabilityProbeFn((event) => {
          handleEvent(event);
        })
          .then((unlisten) => {
            if (subscriptionPromise !== currentPromise) {
              unlisten();
              return unlisten;
            }
            activeUnlisten = unlisten;
            return unlisten;
          })
          .catch((e) => {
            if (subscriptionPromise === currentPromise) {
              subscriptionPromise = null;
              activeUnlisten = null;
            }
            throw e;
          });
        subscriptionPromise = currentPromise;
      }
      await subscriptionPromise;
    }

    function unsubscribe(): void {
      if (activeUnlisten) {
        activeUnlisten();
        activeUnlisten = null;
      }
      subscriptionPromise = null;
      latestRequestId++;
      awaitingRunId = false;
      pendingEvents = [];
    }

    return {
      status: initialState?.status ?? "idle",
      runId: initialState?.runId ?? null,
      paths: initialState?.paths ?? null,
      origin: initialState?.origin ?? null,
      version: initialState?.version ?? null,
      license: initialState?.license ?? null,
      hwaccels: initialState?.hwaccels ? [...initialState.hwaccels] : [],
      results: initialState?.results ? [...initialState.results] : [],
      done: initialState?.done ?? 0,
      total: initialState?.total ?? 0,
      source: initialState?.source ?? null,
      error: initialState?.error ?? null,
      inspected: initialState?.inspected ? [...initialState.inspected] : null,

      ensureSubscribed,
      unsubscribe,

      reset: () => {
        latestRequestId++;
        activeRunId = null;
        awaitingRunId = false;
        pendingEvents = [];
        set({
          status: "idle",
          runId: null,
          paths: null,
          origin: null,
          version: null,
          license: null,
          hwaccels: [],
          results: [],
          done: 0,
          total: 0,
          source: null,
          error: null,
          inspected: null,
        });
      },

      startProbe: async (force = false): Promise<CapabilityProbeStart | null> => {
        const requestId = ++latestRequestId;
        activeRunId = null;
        awaitingRunId = true;
        pendingEvents = [];

        set({
          status: "locating",
          runId: null,
          paths: null,
          origin: null,
          version: null,
          license: null,
          hwaccels: [],
          results: [],
          done: 0,
          total: 0,
          source: null,
          error: null,
          inspected: null,
        });

        try {
          // Acceptance criterion: subscribe BEFORE invoking the command
          await ensureSubscribed();

          if (requestId !== latestRequestId) {
            // A superseded run MUST NOT touch the buffering state: the successor
            // (or reset) already owns it.
            return null;
          }

          const start = await startCapabilityProbeFn(force);

          if (requestId !== latestRequestId) {
            // A superseded run MUST NOT touch the buffering state: the successor
            // (or reset) already owns it.
            return null;
          }

          activeRunId = start.runId;
          awaitingRunId = false;

          set((state) => ({
            status: state.status === "locating" ? "probing" : state.status,
            runId: start.runId,
            paths: {
              ffmpeg: start.ffmpeg,
              ffprobe: start.ffprobe,
            },
            origin: start.origin,
          }));

          const buffered = pendingEvents;
          pendingEvents = [];
          for (const e of buffered) {
            handleEvent(e);
          }

          return start;
        } catch (err) {
          const normalized = normalizeCapabilityProbeError(err);

          if (requestId !== latestRequestId) {
            // A superseded run MUST NOT touch the buffering state: the successor
            // (or reset) already owns it.
            return null;
          }

          activeRunId = null;
          awaitingRunId = false;
          pendingEvents = [];

          set({
            status: normalized.code === "ffmpegPairMissing" ? "missing" : "failed",
            runId: null,
            paths: null,
            origin: null,
            version: null,
            license: null,
            hwaccels: [],
            results: [],
            done: 0,
            total: 0,
            source: null,
            error: normalized,
            inspected: normalized.inspected ?? null,
          });

          return null;
        }
      },
    };
  });
}

export type FfmpegStore = ReturnType<typeof createFfmpegStore>;

/**
 * Default singleton ffmpeg store for production application use.
 */
export const ffmpegStore: FfmpegStore = createFfmpegStore();

const defaultSelector = (state: FfmpegStoreState): FfmpegStoreState => state;

/**
 * React hook for consuming the production ffmpeg store.
 */
export function useFfmpegStore(): FfmpegStoreState;
export function useFfmpegStore<T>(selector: (state: FfmpegStoreState) => T): T;
export function useFfmpegStore<T>(
  selector?: (state: FfmpegStoreState) => T,
): T | FfmpegStoreState {
  return useStore(
    ffmpegStore,
    (selector ?? defaultSelector) as (state: FfmpegStoreState) => T,
  );
}
