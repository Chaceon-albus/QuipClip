/**
 * The preset test store of one window: the stored results of the saved presets, and the tests
 * that this window ran.
 *
 * # Two sources of a result
 *
 * Rust stores each result for the current FFmpeg binary, keyed by the command of the test, and
 * `preset_test_results` answers with the stored result of each preset of the settings document
 * (`stored`). A test that this window runs also lands in `runs`, under the fingerprint of the
 * tested preset (`presetTestFingerprint`). That covers a draft that is not saved, and a test
 * whose result Rust did not store, such as a test that an export overlapped; such a run carries
 * `stored: false`.
 *
 * `selectPresetTestView` and `latestPresetTestResult` pick the newest of the two for a preset.
 * The stored result applies only while the fields of the preset that reach the test equal the
 * fields of the saved preset, so an edit of the encoder settings hides it until the next test.
 *
 * # One binary at a time
 *
 * A result describes the FFmpeg binary that ran it. Each run carries the binary generation of
 * the store when it started, and `noteBinary` raises the generation when the capability probe
 * locates another binary. The selectors ignore a run of an older generation, and so a result
 * that arrives late, from a test that still ran at the switch, never shows for the new binary.
 * The raise also empties `stored`, which the next read fills for the new binary.
 *
 * # Two windows
 *
 * The main window and the Settings window each run this store. When a test stores a result,
 * Rust sends `ffmpeg:preset-tested` to every window, and the other window reads the stored
 * results again (`startPresetTestSync`). A new settings document and a new FFmpeg binary change
 * the stored results too, so the sync reads them again for those.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  BACKEND_EVENTS,
  listenEvent,
  startEventListener,
  type EventSubscribe,
} from "@/lib/ipc";
import { getCurrentWindowLabel, isForeignOrigin } from "@/lib/windowLabel";
import {
  normalizePresetTestError,
  presetTestFingerprint,
  presetTestResults,
  testPreset,
  validatePresetTestedPayload,
  type PresetTestEntry,
  type PresetTestError,
  type PresetTestResponse,
  type PresetTestResult,
} from "./presetTest";
import type { Preset } from "./types";

/**
 * One test that this window ran: running, finished with a result, or refused. `generation` is
 * the binary generation of the store when the test started.
 */
export type PresetTestRun =
  | { readonly status: "running"; readonly generation: number }
  | {
      readonly status: "finished";
      readonly result: PresetTestResult;
      /** Whether Rust stored the result for the binary (`PresetTestResponse.stored`). */
      readonly stored: boolean;
      readonly generation: number;
    }
  | {
      readonly status: "failed";
      readonly error: PresetTestError;
      /** When the command refused, in whole seconds since the Unix epoch. */
      readonly at: number;
      readonly generation: number;
    };

/** The state of the stored results: not read yet, being read, read, or not readable. */
export type StoredPresetTestsStatus = "idle" | "loading" | "ready" | "error";

export type PresetTestState = {
  /** The stored result of each saved preset that has one, by preset id. */
  stored: Readonly<Record<string, PresetTestResult>>;
  /**
   * The state of the last read of `stored`. A read keeps the results of the read before it
   * on screen while it runs. A read that fails empties `stored`: no result is known then. A new
   * binary empties it too, and the state is `loading` until the read for that binary lands.
   */
  storedStatus: StoredPresetTestsStatus;
  /**
   * How many reads of `stored` published, a success or a failure. A view that must decide on
   * the results of a read that it started compares the count with the count it saw before.
   */
  storedReads: number;
  /** The binary generation: 0 for the first binary, and one more for each later binary. */
  generation: number;
  /** The tests of this window, by `presetTestFingerprint` of the tested preset. */
  runs: Readonly<Record<string, PresetTestRun>>;
};

export type PresetTestActions = {
  /**
   * Reads the stored results again. Resolves when this read settles. Only the newest read
   * publishes, so a read that a later read superseded changes nothing.
   */
  refreshStored: () => Promise<void>;
  /**
   * Tests `preset` on this machine, and resolves with the run when it ends. A second call for
   * a preset with the same fingerprint while the first runs for the same binary joins the
   * first.
   */
  runTest: (preset: Preset) => Promise<PresetTestRun>;
  /**
   * Notes the binary that the capability probe located, as a key of its path and its version,
   * or null while none is known. A key other than the last known key raises the generation,
   * empties `stored`, and drops the read in flight, and returns true. The first key and an
   * unknown binary raise nothing.
   */
  noteBinary: (key: string | null) => boolean;
};

export type PresetTestStoreState = PresetTestState & PresetTestActions;

export type PresetTestStore = StoreApi<PresetTestStoreState>;

/** The dependencies of the store. A test passes fakes. */
export interface PresetTestStoreDependencies {
  testPreset?: (preset: Preset) => Promise<PresetTestResponse>;
  presetTestResults?: () => Promise<PresetTestEntry[]>;
  /** Whole seconds since the Unix epoch. Defaults to the clock of the system. */
  now?: () => number;
}

/** Creates a preset test store. See the module comment. */
export function createPresetTestStore(
  dependencies: PresetTestStoreDependencies = {},
): PresetTestStore {
  const testPresetFn =
    dependencies.testPreset ?? ((preset: Preset) => testPreset(preset));
  const presetTestResultsFn =
    dependencies.presetTestResults ?? (() => presetTestResults());
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));

  let latestRead = 0;
  let binaryKey: string | null = null;
  // Keyed by the generation and the fingerprint, so a test after a change of binary never joins
  // a test of the binary before.
  const inFlight = new Map<string, Promise<PresetTestRun>>();

  return createStore<PresetTestStoreState>()((set, get) => ({
    stored: {},
    storedStatus: "idle",
    storedReads: 0,
    generation: 0,
    runs: {},

    refreshStored: async () => {
      const read = ++latestRead;
      set((state) => ({
        storedStatus: state.storedStatus === "ready" ? "ready" : "loading",
      }));
      try {
        const entries = await presetTestResultsFn();
        if (read !== latestRead) {
          return;
        }
        const stored: Record<string, PresetTestResult> = {};
        for (const entry of entries) {
          stored[entry.presetId] = entry.result;
        }
        set((state) => ({
          stored,
          storedStatus: "ready",
          storedReads: state.storedReads + 1,
        }));
      } catch {
        if (read !== latestRead) {
          return;
        }
        set((state) => ({
          stored: {},
          storedStatus: "error",
          storedReads: state.storedReads + 1,
        }));
      }
    },

    runTest: (preset) => {
      const key = presetTestFingerprint(preset);
      const generation = get().generation;
      const flightKey = `${generation}:${key}`;
      const joined = inFlight.get(flightKey);
      if (joined !== undefined) {
        return joined;
      }
      set((state) => ({
        runs: { ...state.runs, [key]: { status: "running", generation } },
      }));
      const run = (async (): Promise<PresetTestRun> => {
        let outcome: PresetTestRun;
        try {
          const response = await testPresetFn(preset);
          outcome = {
            status: "finished",
            result: response.result,
            stored: response.stored,
            generation,
          };
        } catch (error) {
          outcome = {
            status: "failed",
            error: normalizePresetTestError(error),
            at: now(),
            generation,
          };
        }
        inFlight.delete(flightKey);
        // A run of a newer binary with the same fingerprint keeps its place: this outcome
        // describes the binary before.
        set((state) => {
          const current = state.runs[key];
          if (current !== undefined && current.generation > generation) {
            return {};
          }
          return { runs: { ...state.runs, [key]: outcome } };
        });
        return outcome;
      })();
      inFlight.set(flightKey, run);
      return run;
    },

    noteBinary: (key) => {
      if (key === null || key === binaryKey) {
        return false;
      }
      const raised = binaryKey !== null;
      binaryKey = key;
      if (!raised) {
        return false;
      }
      // The read in flight answers for the binary before.
      latestRead++;
      set((state) => ({
        generation: state.generation + 1,
        stored: {},
        storedStatus: state.storedStatus === "idle" ? "idle" : "loading",
      }));
      return true;
    },
  }));
}

/** The preset test store of this window. */
export const presetTestStore: PresetTestStore = createPresetTestStore();

const defaultSelector = (state: PresetTestStoreState): PresetTestStoreState => state;

/** React hook for the preset test store of this window. */
export function usePresetTestStore(): PresetTestStoreState;
export function usePresetTestStore<T>(selector: (state: PresetTestStoreState) => T): T;
export function usePresetTestStore<T>(
  selector?: (state: PresetTestStoreState) => T,
): T | PresetTestStoreState {
  return useStore(
    presetTestStore,
    (selector ?? defaultSelector) as (state: PresetTestStoreState) => T,
  );
}

/**
 * What a window shows for the test of one preset. A result says whether Rust stored it: a
 * result that it did not store is not one for the export setup to rely on.
 */
export type PresetTestView =
  | { readonly kind: "none" }
  | { readonly kind: "running" }
  | {
      readonly kind: "result";
      readonly result: PresetTestResult;
      readonly stored: boolean;
    }
  | { readonly kind: "error"; readonly error: PresetTestError };

/** The part of the state that the selectors read. */
export type PresetTestSelection = Pick<
  PresetTestState,
  "stored" | "runs" | "generation"
>;

/** The run of this window for `preset`, or undefined, and never a run of an older binary. */
function currentRun(
  state: PresetTestSelection,
  preset: Preset,
): PresetTestRun | undefined {
  const run = state.runs[presetTestFingerprint(preset)];
  return run !== undefined && run.generation === state.generation ? run : undefined;
}

/**
 * The stored result of `saved` when it applies to `preset`: `saved` is the stored preset with
 * the id of `preset`, or null when there is none, and the stored result applies while the two
 * have the same fingerprint.
 */
function storedResultFor(
  state: PresetTestSelection,
  preset: Preset,
  saved: Preset | null,
): PresetTestResult | null {
  if (
    saved === null ||
    saved.id !== preset.id ||
    presetTestFingerprint(saved) !== presetTestFingerprint(preset)
  ) {
    return null;
  }
  return state.stored[saved.id] ?? null;
}

/** The newest known result of a preset, and whether Rust stored it. */
type KnownResult = { readonly result: PresetTestResult; readonly stored: boolean };

function latestKnownResult(
  state: PresetTestSelection,
  preset: Preset,
  saved: Preset | null,
): KnownResult | null {
  const run = currentRun(state, preset);
  const own: KnownResult | null =
    run?.status === "finished" ? { result: run.result, stored: run.stored } : null;
  const storedResult = storedResultFor(state, preset, saved);
  const stored: KnownResult | null =
    storedResult === null ? null : { result: storedResult, stored: true };
  if (own === null) {
    return stored;
  }
  if (stored === null) {
    return own;
  }
  return stored.result.testedAt > own.result.testedAt ? stored : own;
}

/**
 * The newest known result of `preset` on the current binary: the result of the last finished
 * test of this window with its fingerprint, or the stored result of `saved` when it applies,
 * whichever ran later. A test of this window wins a tie. Null when neither exists.
 *
 * For a row of the preset list and for the export setup, `preset` and `saved` are the same
 * stored preset. For the editor, `preset` is the draft and `saved` is the stored preset with
 * its id.
 */
export function latestPresetTestResult(
  state: PresetTestSelection,
  preset: Preset,
  saved: Preset | null,
): PresetTestResult | null {
  return latestKnownResult(state, preset, saved)?.result ?? null;
}

/**
 * What to show for the test of `preset` on the current binary: a test of this window that
 * runs, else the newest of the latest result (`latestPresetTestResult`) and a refusal of this
 * window's last test, else nothing. A refusal and a result of the same second show the refusal,
 * which answers the last action of the user.
 */
export function selectPresetTestView(
  state: PresetTestSelection,
  preset: Preset,
  saved: Preset | null,
): PresetTestView {
  const run = currentRun(state, preset);
  if (run?.status === "running") {
    return { kind: "running" };
  }
  const known = latestKnownResult(state, preset, saved);
  if (run?.status === "failed" && (known === null || run.at >= known.result.testedAt)) {
    return { kind: "error", error: run.error };
  }
  return known === null
    ? { kind: "none" }
    : { kind: "result", result: known.result, stored: known.stored };
}

/** The calls that `PresetTestSyncOptions.subscribeSources` makes. */
export interface PresetTestSourceHandlers {
  /** A change that can change the stored results, such as a new settings document. */
  readonly changed: () => void;
  /** The binary that the probe located, as a key of its path and its version, or null. */
  readonly binary: (key: string | null) => void;
}

/** What `startPresetTestSync` reads and calls. A test passes fakes. */
export interface PresetTestSyncOptions {
  /** The store to refresh. Defaults to the store of this window. */
  readonly store?: PresetTestStore;
  /** Subscribes to `ffmpeg:preset-tested`. Defaults to the Tauri event. */
  readonly subscribeTested?: EventSubscribe;
  /** The label of this window. Defaults to the label of the current Tauri window. */
  readonly ownLabel?: string | null;
  /**
   * Calls `binary` once with the binary that is known now, and then `changed` or `binary` for
   * each change that can change the stored results. Returns the function that stops it.
   */
  readonly subscribeSources: (handlers: PresetTestSourceHandlers) => () => void;
}

/**
 * Reads the stored results once the event subscription is in place, and again for each change
 * of `subscribeSources` and for each `ffmpeg:preset-tested` of another window. A new binary
 * raises the generation of the store first (`noteBinary`). Returns the function that stops it.
 * A test of this window already holds its result in `runs`, so its own event reads nothing.
 */
export function startPresetTestSync(options: PresetTestSyncOptions): () => void {
  const store = options.store ?? presetTestStore;
  const subscribe =
    options.subscribeTested ??
    ((handler) => listenEvent<unknown>(BACKEND_EVENTS.PRESET_TESTED, handler));
  const ownLabel =
    options.ownLabel !== undefined ? options.ownLabel : getCurrentWindowLabel();
  const refresh = () => {
    void store.getState().refreshStored();
  };
  const stopSources = options.subscribeSources({
    changed: refresh,
    binary: (key) => {
      if (store.getState().noteBinary(key)) {
        refresh();
      }
    },
  });
  const stopEvent = startEventListener(
    subscribe,
    (raw) => {
      const payload = validatePresetTestedPayload(raw);
      if (payload !== null && isForeignOrigin(payload.origin, ownLabel)) {
        refresh();
      }
    },
    refresh,
  );
  return () => {
    stopSources();
    stopEvent();
  };
}
