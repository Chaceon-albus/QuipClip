/**
 * The start and the end of the export run, on a monotonic clock.
 *
 * No protocol field carries them, so a listener on the export store takes them when the
 * status or the tracking changes. The export dialog reads them for the Stop Export rule, the
 * elapsed time of its readout, and the time on the finished panel.
 *
 * The timing is a store of its own, not state of the dialog, so that a status change and its
 * timing always render together. The binding below changes the timing from a listener of the
 * export store, so both stores change in the same synchronous `setState`. React renders only
 * after that call returns, whatever the order of the listeners, and it reads both stores
 * through `useSyncExternalStore`. The first render of a finished run therefore already has
 * its time.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { isExportRunLive, type ExportRunLiveState } from "./runState";
import { exportStore } from "./store";
import type { ExportStoreState } from "./types";

/** The start and the end of the run, on one monotonic clock. */
export interface ExportRunTiming {
  /** When the run first showed as live, or null when no run was seen since `idle`. */
  readonly startedAt: number | null;
  /** When the run ended, or null while it continues or when no run was seen. */
  readonly endedAt: number | null;
}

export const NO_EXPORT_RUN_TIMING: ExportRunTiming = { startedAt: null, endedAt: null };

/**
 * Gives the timing after a change of the status or of `tracking`.
 *
 * A run continues while it is live (`isExportRunLive`): active, or `failed` while the store
 * still tracks it. That failed run can still finish, so it has not ended.
 *
 * 1. A run that continues keeps its start. When no run was open, `now` starts a new one.
 * 2. `idle` clears the timing.
 * 3. Any other status ends the open run at `now`. A status with no open run, such as a
 *    failure of the open step, keeps the timing.
 *
 * The result is `previous` itself when nothing changes, so a store update with it does not
 * notify.
 */
export function trackExportRunTiming(
  previous: ExportRunTiming,
  state: ExportRunLiveState,
  now: number,
): ExportRunTiming {
  const open = previous.startedAt !== null && previous.endedAt === null;
  if (isExportRunLive(state)) {
    return open ? previous : { startedAt: now, endedAt: null };
  }
  if (state.status === "idle") {
    return previous.startedAt === null && previous.endedAt === null
      ? previous
      : NO_EXPORT_RUN_TIMING;
  }
  return open ? { startedAt: previous.startedAt, endedAt: now } : previous;
}

export type ExportRunTimingStore = StoreApi<ExportRunTiming>;

export function createExportRunTimingStore(
  initial: ExportRunTiming = NO_EXPORT_RUN_TIMING,
): ExportRunTimingStore {
  return createStore<ExportRunTiming>()(() => initial);
}

/**
 * Keeps `timing` up to date with the run of `source`. It applies the current state at once,
 * so a binding made during a run starts the timing at the binding. Returns the unsubscribe
 * function.
 *
 * `now` defaults to `performance.now()`, which is monotonic, so a change of the system clock
 * cannot change the time that a run took.
 */
export function bindRunTimingToExportRun(
  source: StoreApi<ExportStoreState>,
  timing: ExportRunTimingStore,
  now: () => number = () => performance.now(),
): () => void {
  const apply = (state: ExportRunLiveState) => {
    timing.setState(trackExportRunTiming(timing.getState(), state, now()), true);
  };
  apply(source.getState());
  return source.subscribe((state, previous) => {
    if (state.status !== previous.status || state.tracking !== previous.tracking) {
      apply(state);
    }
  });
}

export const exportRunTimingStore: ExportRunTimingStore = createExportRunTimingStore();

// The binding lasts for the life of the web view, the same as both stores. A hot reload of
// this module in development makes a new timing store and a new binding, and the dispose
// callback below ends the old binding.
const unbindExportRunTiming = bindRunTimingToExportRun(
  exportStore,
  exportRunTimingStore,
);
import.meta.hot?.dispose(() => {
  unbindExportRunTiming();
});

export function useExportRunTiming(): ExportRunTiming {
  return useStore(exportRunTimingStore);
}
