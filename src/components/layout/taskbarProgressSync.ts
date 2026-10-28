/**
 * Mirrors the export progress on the macOS Dock icon and the Windows task bar (ADR 025).
 *
 * The mapping follows the export status and the tracking. A cancel request does not change
 * it. Between two runs of a batch, the bar shows no end (ADR 049).
 */

import {
  getCurrentWindow,
  ProgressBarStatus,
  type ProgressBarState,
} from "@tauri-apps/api/window";
import type { StoreApi } from "zustand/vanilla";
import {
  presentExportProgress,
  type ExportProgressInput,
} from "@/components/export/exportProgressPresenter";
import {
  exportBatchContinues,
  exportBatchEndsOf,
  exportBatchHasFailure,
  exportQueueStore,
  exportStore,
  isExportRunLive,
  type ExportBatchQueueState,
  type ExportStoreState,
} from "@/features/export";
import { isMacOS } from "@/lib/platform";

export type TaskbarProgressInput = ExportProgressInput & {
  /**
   * True while the batch goes on after the run of the export store
   * (`exportBatchContinues`). False when the field is not given.
   */
  batchContinues?: boolean;
  /**
   * True when the batch has more than one run and one of them failed
   * (`exportBatchHasFailure`). False when the field is not given.
   */
  batchFailed?: boolean;
};

/** The fields of the export queue store that the task bar reads. */
export type TaskbarQueueState = ExportBatchQueueState;

export interface TaskbarProgressOptions {
  /**
   * When true, every Indeterminate result carries `progress: 0`.
   *
   * On macOS, tao changes the drawn Dock value only when `progress` is present, so without a
   * value the Indeterminate state keeps the last drawn value. On Windows, tao sets the state
   * first and the value second, and `SetProgressValue` clears `TBPF_INDETERMINATE`, so no
   * value must be sent there.
   */
  resetIndeterminateValue: boolean;
}

/**
 * Pure mapping from the export state to the task bar state (ADR 025).
 *
 * A live run (`isExportRunLive`) shows its progress. That includes a `failed` status that the
 * store still tracks: a Stop request failed, and the backend still encodes, so the bar shows
 * the phase of the run and not the error state. A `failed` with no tracked run shows the
 * error state.
 *
 * A run that ended while the batch goes on (`batchContinues`) shows the Indeterminate state
 * until the next run reports its progress. The bar shows no finish and no error between two
 * runs, so a failed run in the middle of a batch does not leave the error state on.
 *
 * The end of a batch of more than one run shows the error state when one of its runs failed
 * (`batchFailed`), also when the last run finished, because the bar is the only sign of that
 * failure outside the window. Otherwise the end shows the end of the last run.
 */
export function resolveTaskbarProgress(
  input: TaskbarProgressInput,
  options: TaskbarProgressOptions,
): ProgressBarState {
  const indeterminate: ProgressBarState = options.resetIndeterminateValue
    ? { status: ProgressBarStatus.Indeterminate, progress: 0 }
    : { status: ProgressBarStatus.Indeterminate };

  if (!isExportRunLive(input)) {
    if (input.batchContinues === true) {
      return indeterminate;
    }
    return input.status === "failed" || input.batchFailed === true
      ? { status: ProgressBarStatus.Error, progress: 100 }
      : { status: ProgressBarStatus.None };
  }

  const view = presentExportProgress(input);
  if (view === null || view.basePhase === "preparing") {
    return indeterminate;
  }
  if (view.basePhase === "publishing") {
    return { status: ProgressBarStatus.Normal, progress: 100 };
  }
  if (view.barValue === null) {
    return indeterminate;
  }
  const clamped = Math.max(0, Math.min(view.barValue, 100));
  return { status: ProgressBarStatus.Normal, progress: Math.floor(clamped) };
}

function keyOf(state: ProgressBarState): string {
  return `${state.status ?? ""}:${state.progress ?? ""}`;
}

export interface TaskbarProgressSyncOptions {
  /** Defaults to the production `exportStore`. */
  store?: StoreApi<ExportStoreState>;
  /** Defaults to the production `exportQueueStore`. */
  queueStore?: StoreApi<TaskbarQueueState>;
  /** Defaults to `(state) => getCurrentWindow().setProgressBar(state)`. */
  setProgressBar?: (state: ProgressBarState) => Promise<void>;
  /** Defaults to `isMacOS()`. See `TaskbarProgressOptions.resetIndeterminateValue`. */
  resetIndeterminateValue?: boolean;
}

/**
 * Subscribes to the export store and the export queue store and mirrors them on the window.
 * Returns the unsubscribe function.
 *
 * The resolved state is sent once at start, also when it is None, because a webview reload
 * resets the store while the native bar can still show the last state. After that, a call is
 * sent only when the resolved state changes.
 *
 * `setProgressBar` is an async command, so two calls sent back to back have no guaranteed order.
 * At most one call is in flight. When it settles, the latest resolved state is sent if it
 * differs from the state of the settled call.
 */
export function startTaskbarProgressSync(
  options: TaskbarProgressSyncOptions = {},
): () => void {
  const store = options.store ?? exportStore;
  const queueStore = options.queueStore ?? exportQueueStore;
  const setProgressBar =
    options.setProgressBar ??
    ((state: ProgressBarState) => getCurrentWindow().setProgressBar(state));
  const resolveOptions: TaskbarProgressOptions = {
    resetIndeterminateValue: options.resetIndeterminateValue ?? isMacOS(),
  };

  function resolveCurrent(): ProgressBarState {
    const state = store.getState();
    const queue = queueStore.getState();
    return resolveTaskbarProgress(
      {
        ...state,
        batchContinues: exportBatchContinues(queue, state),
        batchFailed: exportBatchHasFailure(exportBatchEndsOf(queue, state)),
      },
      resolveOptions,
    );
  }

  let latest = resolveCurrent();
  let sentKey: string | null = null;
  let inFlight = false;
  let stopped = false;

  function settle(): void {
    inFlight = false;
    if (!stopped) {
      flush();
    }
  }

  function flush(): void {
    const key = keyOf(latest);
    if (inFlight || key === sentKey) {
      return;
    }
    sentKey = key;
    inFlight = true;
    // A missing permission or a platform without a task bar must not break the export.
    let pending: Promise<void>;
    try {
      pending = setProgressBar(latest);
    } catch {
      // No Tauri window exists, for example outside the application shell.
      settle();
      return;
    }
    void pending.then(settle, settle);
  }

  function apply(): void {
    latest = resolveCurrent();
    flush();
  }

  flush();
  const unsubscribe = store.subscribe(apply);
  // A change of the queue alone can end the batch, such as the removal of the last waiting
  // run after the run of the export store ended.
  const unsubscribeQueue = queueStore.subscribe(apply);
  return () => {
    stopped = true;
    unsubscribe();
    unsubscribeQueue();
  };
}
