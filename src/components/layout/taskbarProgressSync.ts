/**
 * Mirrors the export progress on the macOS Dock icon and the Windows task bar (ADR 025).
 *
 * The mapping follows the export status only. A cancel request does not change it.
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
import { exportStore, type ExportStoreState } from "@/features/export";
import { isMacOS } from "@/lib/platform";

export type TaskbarProgressInput = ExportProgressInput;

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

/** Pure mapping from the export state to the task bar state (ADR 025). */
export function resolveTaskbarProgress(
  input: TaskbarProgressInput,
  options: TaskbarProgressOptions,
): ProgressBarState {
  const indeterminate: ProgressBarState = options.resetIndeterminateValue
    ? { status: ProgressBarStatus.Indeterminate, progress: 0 }
    : { status: ProgressBarStatus.Indeterminate };

  switch (input.status) {
    case "idle":
    case "finished":
    case "canceled":
      return { status: ProgressBarStatus.None };
    case "failed":
      return { status: ProgressBarStatus.Error, progress: 100 };
    case "preparing":
    case "running":
    case "publishing":
      break;
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
  /** Defaults to `(state) => getCurrentWindow().setProgressBar(state)`. */
  setProgressBar?: (state: ProgressBarState) => Promise<void>;
  /** Defaults to `isMacOS()`. See `TaskbarProgressOptions.resetIndeterminateValue`. */
  resetIndeterminateValue?: boolean;
}

/**
 * Subscribes to the export store and mirrors it on the window. Returns the unsubscribe function.
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
  const setProgressBar =
    options.setProgressBar ??
    ((state: ProgressBarState) => getCurrentWindow().setProgressBar(state));
  const resolveOptions: TaskbarProgressOptions = {
    resetIndeterminateValue: options.resetIndeterminateValue ?? isMacOS(),
  };

  let latest = resolveTaskbarProgress(store.getState(), resolveOptions);
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

  function apply(state: ExportStoreState): void {
    latest = resolveTaskbarProgress(state, resolveOptions);
    flush();
  }

  flush();
  const unsubscribe = store.subscribe(apply);
  return () => {
    stopped = true;
    unsubscribe();
  };
}
