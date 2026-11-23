/**
 * The measurement of the setup step (ADR 061): one at a time, with the kept results.
 *
 * `measure` asks for the values of one scope. A kept result answers at once. Otherwise the store
 * starts a measurement, and a measurement of another scope that still runs is canceled first:
 * Rust runs one measurement at a time, so the next one starts when the end of the last one
 * arrives. `stop` cancels the measurement and forgets the state.
 *
 * Each call of `measure` takes a new generation. The setup step fills the Gain field when the
 * state is complete with a generation that it has not filled yet, so a measurement that the
 * cache answers again fills the field again.
 *
 * The store records what it will do before it publishes a state, because Zustand calls the
 * subscribers at once, and a subscriber can call `measure` or `stop` again.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { LoudnessCache, loudnessCacheKey } from "./cache";
import { startLoudnessMeasurement, type LoudnessJob } from "./client";
import {
  LoudnessError,
  type LoudnessErrorCode,
  type LoudnessProgress,
  type LoudnessScope,
  type LoudnessValues,
} from "./types";

/** The state of the measurement of the setup step. */
export type LoudnessMeasurement =
  | { readonly status: "idle"; readonly generation: number }
  | {
      readonly status: "measuring";
      readonly generation: number;
      readonly progress: LoudnessProgress | null;
    }
  | {
      readonly status: "complete";
      readonly generation: number;
      readonly values: LoudnessValues;
    }
  | {
      readonly status: "failed";
      readonly generation: number;
      readonly code: LoudnessErrorCode;
      readonly detail: string | null;
    };

export type LoudnessStoreState = {
  measurement: LoudnessMeasurement;
  /** Measure `scope`, or give its kept result at once. */
  measure: (scope: LoudnessScope) => void;
  /** Cancel the measurement that runs, and go back to idle. */
  stop: () => void;
};

export interface LoudnessStoreDependencies {
  readonly start?: typeof startLoudnessMeasurement;
  readonly cache?: LoudnessCache;
  /** The time between two starts that Rust refused as `busy`. Defaults to `BUSY_RETRY_MS`. */
  readonly busyRetryMs?: number;
  /** How long the store tries again after `busy`. Defaults to `BUSY_RETRY_LIMIT_MS`. */
  readonly busyRetryLimitMs?: number;
}

/**
 * The time between two starts that Rust refused as `busy`. Rust frees its slot a little after the
 * page can learn that a measurement ended or failed, for example after an end message of the
 * wrong shape or a start reply of the wrong shape. So `busy` means that the slot is still taken
 * for a moment, and the store starts again rather than fail.
 */
export const BUSY_RETRY_MS = 250;

/** How long the store tries again after `busy`, before it reports the refusal. */
export const BUSY_RETRY_LIMIT_MS = 10_000;

/** One request of the step: its scope, and its identity. */
interface Request {
  readonly scope: LoudnessScope;
  /** The cache key, or the request itself when it is not kept. */
  readonly id: string;
  readonly cacheable: boolean;
}

function requestOf(scope: LoudnessScope): Request {
  const key = loudnessCacheKey(scope);
  if (key !== null) {
    return { scope, id: key, cacheable: true };
  }
  return {
    scope,
    id: JSON.stringify([
      "uncached",
      scope.sources,
      scope.pieces,
      scope.preset,
      scope.streams,
    ]),
    cacheable: false,
  };
}

/** A measurement that Rust runs or that the store started. */
interface Running {
  readonly id: string;
  job: LoudnessJob | null;
  /** The store asked to cancel it, so its progress and its end no longer count. */
  canceled: boolean;
}

export function createLoudnessStore(
  dependencies: LoudnessStoreDependencies = {},
): StoreApi<LoudnessStoreState> {
  const start = dependencies.start ?? startLoudnessMeasurement;
  const cache = dependencies.cache ?? new LoudnessCache();
  const busyRetryMs = dependencies.busyRetryMs ?? BUSY_RETRY_MS;
  const busyRetryLimitMs = dependencies.busyRetryLimitMs ?? BUSY_RETRY_LIMIT_MS;
  let running: Running | null = null;
  // The request that waits for the end of the running measurement.
  let pending: Request | null = null;
  // The identity of the request that the state answers, while it measures.
  let wanted: string | null = null;

  return createStore<LoudnessStoreState>()((set, get) => {
    /** True when `entry` is the measurement that the state waits for. */
    const answers = (entry: Running): boolean =>
      running === entry &&
      !entry.canceled &&
      wanted === entry.id &&
      get().measurement.status === "measuring";

    const cancelRunning = (): void => {
      if (running !== null && !running.canceled) {
        running.canceled = true;
        running.job?.cancel();
      }
    };

    /** Start the request that waits, now that no measurement runs. */
    /**
     * Start the request that waits, now that no measurement runs. A result that the cache got in
     * the meantime, from a canceled measurement that still completed, answers at once.
     */
    const launchPending = (): void => {
      const next = pending;
      pending = null;
      if (next === null || running !== null) {
        return;
      }
      const kept = next.cacheable ? cache.get(next.id) : undefined;
      if (kept === undefined) {
        launch(next);
        return;
      }
      if (wanted === next.id && get().measurement.status === "measuring") {
        wanted = null;
        const { generation } = get().measurement;
        set({ measurement: { status: "complete", generation, values: kept } });
      }
    };

    /**
     * Start `request`. `retryUntil` is the time until which a start that Rust refuses as `busy`
     * starts again, set at the first refusal.
     */
    const launch = (request: Request, retryUntil: number | null = null): void => {
      const entry: Running = { id: request.id, job: null, canceled: false };
      running = entry;
      const finished = (): void => {
        if (running === entry) {
          running = null;
          launchPending();
        }
      };
      const job = start(request.scope, {
        onProgress: (progress) => {
          const { measurement } = get();
          if (answers(entry) && measurement.status === "measuring") {
            set({ measurement: { ...measurement, progress } });
          }
        },
        onEnd: (end) => {
          const current = answers(entry);
          // A complete result is valid also when the step no longer waits for it.
          if (end.status === "complete" && request.cacheable) {
            cache.set(request.id, {
              integratedLufs: end.integratedLufs,
              truePeakDbtp: end.truePeakDbtp,
            });
          }
          // The slot of Rust is free: the next request can start before a subscriber runs.
          if (running === entry) {
            running = null;
          }
          if (current) {
            wanted = null;
            const { generation } = get().measurement;
            set({
              measurement:
                end.status === "complete"
                  ? {
                      status: "complete",
                      generation,
                      values: {
                        integratedLufs: end.integratedLufs,
                        truePeakDbtp: end.truePeakDbtp,
                      },
                    }
                  : end.status === "failed"
                    ? {
                        status: "failed",
                        generation,
                        code: end.code,
                        detail: end.detail,
                      }
                    : // A cancel that the page did not ask for, as at a page load.
                      { status: "idle", generation },
            });
          }
          if (running === null) {
            launchPending();
          }
        },
      });
      entry.job = job;
      // A cancel that came while the store waited for the job.
      if (entry.canceled) {
        job.cancel();
      }
      job.started.catch((error: unknown) => {
        // Rust holds no measurement, so no end comes.
        const failure =
          error instanceof LoudnessError
            ? error
            : new LoudnessError("commandExecutionFailed");
        const deadline = retryUntil ?? Date.now() + busyRetryLimitMs;
        if (failure.code === "busy" && Date.now() < deadline) {
          setTimeout(() => {
            if (running !== entry) {
              return;
            }
            running = null;
            if (!entry.canceled && wanted === entry.id && pending === null) {
              launch(request, deadline);
            } else {
              launchPending();
            }
          }, busyRetryMs);
          return;
        }
        const current = answers(entry);
        if (current) {
          wanted = null;
          finished();
          const { generation } = get().measurement;
          set({
            measurement: {
              status: "failed",
              generation,
              code: failure.code,
              detail: failure.detail,
            },
          });
        } else {
          finished();
        }
      });
    };

    return {
      measurement: { status: "idle", generation: 0 },
      measure: (scope) => {
        const generation = get().measurement.generation + 1;
        const request = requestOf(scope);
        const kept = request.cacheable ? cache.get(request.id) : undefined;
        if (kept !== undefined) {
          wanted = null;
          pending = null;
          cancelRunning();
          set({ measurement: { status: "complete", generation, values: kept } });
          return;
        }
        wanted = request.id;
        let launchNow = false;
        if (running === null) {
          launchNow = true;
        } else if (running.id === request.id && !running.canceled) {
          // The measurement that runs is the one that the step wants.
          pending = null;
        } else {
          // The next measurement starts at the end of the one that runs.
          pending = request;
          cancelRunning();
        }
        set({ measurement: { status: "measuring", generation, progress: null } });
        // A subscriber can have asked for another request, or stopped, in the meantime.
        if (
          launchNow &&
          running === null &&
          wanted === request.id &&
          get().measurement.generation === generation
        ) {
          launch(request);
        }
      },
      stop: () => {
        wanted = null;
        pending = null;
        cancelRunning();
        set({
          measurement: { status: "idle", generation: get().measurement.generation + 1 },
        });
      },
    };
  });
}

/** The measurement of the setup step, for the session. */
export const loudnessStore = createLoudnessStore();

export function useLoudnessMeasurement<T>(
  selector: (state: LoudnessStoreState) => T,
): T {
  return useStore(loudnessStore, selector);
}
