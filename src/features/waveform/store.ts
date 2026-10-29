/**
 * The state of the envelope of each source for this application run (ADR 056), by generated
 * source ID. The codes themselves live in the data registry (`data.ts`), outside this store, so
 * a new piece of data never renders React again.
 *
 * One job runs at a time in the application, and `runningSourceId` names its source. The state
 * goes into no file, no undo stack and no web view storage.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { NO_WAVEFORM_FLAGS, type WaveformErrorCode, type WaveformFlags } from "./types";

/** At most 4 progress updates each second. */
// Below the 250 ms of Rust, which already limits the progress to four messages each second,
// so a message that comes a little early is not dropped.
export const WAVEFORM_PROGRESS_INTERVAL_MS = 200;

export type WaveformPhase = "idle" | "running" | "ready" | "failed";

export interface WaveformSourceState {
  readonly phase: WaveformPhase;
  /**
   * True when the envelope comes from the cache, false when the job reads the file, and null
   * while the reply of the start is pending.
   */
  readonly cached: boolean | null;
  /** The part of the job that is done, from 0 to 1, or null when it is not known. */
  readonly progress: number | null;
  /** The error of a failed job. */
  readonly errorCode: WaveformErrorCode | null;
  /** Untranslated diagnostic text beside the error (ADR 011). */
  readonly errorDetail: string | null;
  /** True when the user closed the notice of this job. */
  readonly noticeDismissed: boolean;
  readonly flags: WaveformFlags;
}

export const IDLE_WAVEFORM_SOURCE: WaveformSourceState = {
  phase: "idle",
  cached: false,
  progress: null,
  errorCode: null,
  errorDetail: null,
  noticeDismissed: false,
  flags: NO_WAVEFORM_FLAGS,
};

/** How a job ended, for `finish`. */
export type WaveformOutcome =
  | { readonly phase: "ready"; readonly cached: boolean; readonly flags: WaveformFlags }
  | { readonly phase: "idle" }
  | {
      readonly phase: "failed";
      readonly errorCode: WaveformErrorCode;
      readonly errorDetail: string | null;
    };

export interface WaveformState {
  /** The sources that are not idle. */
  readonly sources: Readonly<Record<string, WaveformSourceState>>;
  /** The source of the job that runs, or null. */
  readonly runningSourceId: string | null;
}

export interface WaveformActions {
  /** A job of `sourceId` starts and takes the one slot. */
  begin: (sourceId: string) => void;
  /** Notes whether the running job reads the cache. */
  setCached: (sourceId: string, cached: boolean) => void;
  /**
   * Notes the progress of the running job. An update less than 200 ms after the last stored
   * update is dropped.
   */
  setProgress: (sourceId: string, progress: number | null) => void;
  /** The job of `sourceId` ended, and frees the slot. */
  finish: (sourceId: string, outcome: WaveformOutcome) => void;
  /** Returns a source that does not run to idle. */
  reset: (sourceId: string) => void;
  dismissNotice: (sourceId: string) => void;
}

export type WaveformStoreState = WaveformState & WaveformActions;

export type WaveformStore = StoreApi<WaveformStoreState>;

export interface WaveformStoreDependencies {
  /** Milliseconds, for the throttle of the progress. Defaults to `performance.now`. */
  now?: () => number;
}

/** The state of one source, idle when the store holds none. */
export function selectWaveformSource(
  state: WaveformState,
  sourceId: string,
): WaveformSourceState {
  return state.sources[sourceId] ?? IDLE_WAVEFORM_SOURCE;
}

function withoutSource(
  sources: Readonly<Record<string, WaveformSourceState>>,
  sourceId: string,
): Record<string, WaveformSourceState> {
  const next = { ...sources };
  delete next[sourceId];
  return next;
}

export function createWaveformStore(
  dependencies: WaveformStoreDependencies = {},
): WaveformStore {
  const now = dependencies.now ?? (() => performance.now());
  const lastProgressAt = new Map<string, number>();

  return createStore<WaveformStoreState>()((set, get) => {
    const patch = (sourceId: string, change: Partial<WaveformSourceState>): void => {
      set((state) => ({
        sources: {
          ...state.sources,
          [sourceId]: { ...selectWaveformSource(state, sourceId), ...change },
        },
      }));
    };

    return {
      sources: {},
      runningSourceId: null,

      begin: (sourceId) => {
        lastProgressAt.delete(sourceId);
        set((state) => ({
          runningSourceId: sourceId,
          sources: {
            ...state.sources,
            [sourceId]: { ...IDLE_WAVEFORM_SOURCE, phase: "running", cached: null },
          },
        }));
      },

      setCached: (sourceId, cached) => {
        if (selectWaveformSource(get(), sourceId).phase !== "running") {
          return;
        }
        patch(sourceId, { cached });
      },

      setProgress: (sourceId, progress) => {
        const current = selectWaveformSource(get(), sourceId);
        if (current.phase !== "running" || current.progress === progress) {
          return;
        }
        const at = now();
        const last = lastProgressAt.get(sourceId);
        if (last !== undefined && at - last < WAVEFORM_PROGRESS_INTERVAL_MS) {
          return;
        }
        lastProgressAt.set(sourceId, at);
        patch(sourceId, { progress });
      },

      finish: (sourceId, outcome) => {
        lastProgressAt.delete(sourceId);
        set((state) => {
          const runningSourceId =
            state.runningSourceId === sourceId ? null : state.runningSourceId;
          switch (outcome.phase) {
            case "idle":
              return {
                runningSourceId,
                sources: withoutSource(state.sources, sourceId),
              };
            case "ready":
              return {
                runningSourceId,
                sources: {
                  ...state.sources,
                  [sourceId]: {
                    ...IDLE_WAVEFORM_SOURCE,
                    phase: "ready",
                    cached: outcome.cached,
                    flags: outcome.flags,
                  },
                },
              };
            case "failed":
              return {
                runningSourceId,
                sources: {
                  ...state.sources,
                  [sourceId]: {
                    ...IDLE_WAVEFORM_SOURCE,
                    phase: "failed",
                    errorCode: outcome.errorCode,
                    errorDetail: outcome.errorDetail,
                  },
                },
              };
          }
        });
      },

      reset: (sourceId) => {
        const current = get();
        if (
          current.runningSourceId === sourceId ||
          current.sources[sourceId] === undefined
        ) {
          return;
        }
        set((state) => ({ sources: withoutSource(state.sources, sourceId) }));
      },

      dismissNotice: (sourceId) => {
        const current = selectWaveformSource(get(), sourceId);
        if (current.phase === "idle" || current.noticeDismissed) {
          return;
        }
        patch(sourceId, { noticeDismissed: true });
      },
    };
  });
}

/** The envelope store of this page. */
export const waveformStore: WaveformStore = createWaveformStore();

const defaultSelector = (state: WaveformStoreState): WaveformStoreState => state;

/** React hook for the envelope store of this page. */
export function useWaveformStore(): WaveformStoreState;
export function useWaveformStore<T>(selector: (state: WaveformStoreState) => T): T;
export function useWaveformStore<T>(
  selector?: (state: WaveformStoreState) => T,
): T | WaveformStoreState {
  return useStore(
    waveformStore,
    (selector ?? defaultSelector) as (state: WaveformStoreState) => T,
  );
}
