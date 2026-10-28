/**
 * Asks the system for the attention of the user when a batch of exports ends while the window
 * does not have the focus (ADR 025, ADR 049).
 *
 * `requestUserAttention(Informational)` bounces the Dock icon once on macOS. On Windows it
 * flashes the task bar button until the window gets the focus.
 *
 * The capability file grants `core:window:allow-request-user-attention`. The focus query needs
 * no permission of its own: `core:default` holds `core:window:default`, which allows
 * `is_focused`.
 */

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import type { StoreApi } from "zustand/vanilla";
import {
  exportBatchContinues,
  exportBatchEndsOf,
  exportQueueStore,
  exportStore,
  isExportRunLive,
  type ExportBatchEnd,
  type ExportBatchQueueState,
  type ExportRunLiveState,
  type ExportStoreState,
} from "@/features/export";

/** The two fields of the export store that decide whether a run ended. */
export type ExportAttentionState = ExportRunLiveState;

export interface ExportAttentionInput {
  /** The store before the change. */
  readonly previous: ExportAttentionState;
  /** The store after the change. */
  readonly next: ExportAttentionState;
  /** True when the window has the focus. */
  readonly focused: boolean;
  /** True when this run already asked for attention. */
  readonly alreadyRequested: boolean;
  /**
   * True when the batch goes on after this run (`exportBatchContinues`), read at the change.
   * False when the field is not given.
   */
  readonly batchContinues?: boolean;
}

/** The fields of the export queue store that the attention request reads. */
export type ExportAttentionQueueState = ExportBatchQueueState;

/**
 * True when the change ends a run in a result that the user did not ask for: the store goes
 * from a live run (`isExportRunLive`) to `finished` or `failed`, and no longer tracks a run.
 *
 * - A `failed` with `tracking` still true is not an end. A Stop request failed. The run
 *   continues, and its real end comes later, as `failed` to `failed`, or through
 *   `publishing` to `finished`.
 * - A failure of preparation counts as an end: `preparing` to `failed` with no tracked run.
 *   Preparation can take up to 90 seconds (ADR 016), which is long enough for the user to go
 *   to another window. A start that the backend refuses ends the same way.
 * - A run that ends `canceled` does not count, because the user asked for that result.
 * - A change from `idle` does not count either: the open step reports `noSegments` and
 *   similar codes as `failed` before any run starts, while the user is at the window.
 */
export function endsRunForAttention(
  previous: ExportAttentionState,
  next: ExportAttentionState,
): boolean {
  return (
    isExportRunLive(previous) &&
    (next.status === "finished" || next.status === "failed") &&
    !next.tracking
  );
}

/**
 * Pure decision: request attention once for a run that ended in `finished` or `failed`
 * while the window did not have the focus, when the run is the last run of its batch.
 *
 * A run that ends while runs wait or a submission has no answer does not ask: the batch goes
 * on, and only its end asks.
 */
export function shouldRequestExportAttention(input: ExportAttentionInput): boolean {
  return (
    !input.focused &&
    !input.alreadyRequested &&
    input.batchContinues !== true &&
    endsRunForAttention(input.previous, input.next)
  );
}

/**
 * True when the ends of a batch hold a run that `finished` or `failed`. A batch that ended
 * only `canceled`, or with no end, does not ask for attention (ADR 025).
 */
export function batchEndAsksForAttention(ends: readonly ExportBatchEnd[]): boolean {
  return ends.some((end) => end === "finished" || end === "failed");
}

export interface ExportAttentionSyncOptions {
  /** Defaults to the production `exportStore`. */
  store?: StoreApi<ExportStoreState>;
  /** Defaults to the production `exportQueueStore`. */
  queueStore?: StoreApi<ExportAttentionQueueState>;
  /** Defaults to `() => getCurrentWindow().isFocused()`. */
  isFocused?: () => Promise<boolean>;
  /**
   * Defaults to
   * `() => getCurrentWindow().requestUserAttention(UserAttentionType.Informational)`.
   */
  requestAttention?: () => Promise<void>;
  /** Defaults to `isTauri()`. When false, the sync does nothing. */
  enabled?: boolean;
}

/** Calls `call` and turns a synchronous throw into a rejected promise. */
function attempt<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Subscribes to the export store and the export queue store, and asks for attention when a
 * batch ends while the window does not have the focus. Returns the unsubscribe function.
 *
 * The queue state is read when the run ends. The queue adds the run to `ended` and adopts the
 * next run only at the `preparing` event of that next run, so at the end of a run the next
 * run is still in `waiting`. A run that ends while the batch goes on does not ask. Its end is
 * kept as a deferred end, and so is a reset of the export store while the batch goes on. When
 * a later change of the queue ends the batch while the export store holds no live run, it
 * asks: a waiting run failed before it took the slot, or the user removed the last waiting
 * run. The focus test leaves out an action that the user took at the window, and a batch
 * whose runs all ended canceled does not ask (`batchEndAsksForAttention`).
 *
 * The focus is read when the batch ends, not tracked, so a change that does not end a batch
 * sends no call.
 *
 * One run asks at most once, and only the last run of a batch asks. `endsRunForAttention`
 * already ignores the `failed` that a failed Stop reports while the run continues, and the
 * flag is a second guard on top of it. The flag clears only when a new run starts
 * (`preparing`) or the store resets (`idle`).
 *
 * The focus query settles later. Each new run or reset also discards the queries that are
 * still open, so an answer never asks for attention on behalf of a result that is gone.
 *
 * The request is only a hint. A rejected or thrown call is ignored, and a failed focus query
 * sends no request.
 */
export function startExportAttentionSync(
  options: ExportAttentionSyncOptions = {},
): () => void {
  if (!(options.enabled ?? isTauri())) {
    return () => {};
  }
  const store = options.store ?? exportStore;
  const queueStore = options.queueStore ?? exportQueueStore;
  const isFocused = options.isFocused ?? (() => getCurrentWindow().isFocused());
  const requestAttention =
    options.requestAttention ??
    (() => getCurrentWindow().requestUserAttention(UserAttentionType.Informational));

  let requested = false;
  /** True when the run of the export store ended while the batch went on. */
  let deferredEnd = false;
  let generation = 0;
  let stopped = false;

  /** Reads the focus, and asks for attention when the window does not have it. */
  function requestIfUnfocused(decide: (focused: boolean) => boolean): void {
    const queryGeneration = generation;
    attempt(isFocused).then(
      (focused) => {
        if (stopped || queryGeneration !== generation || !decide(focused)) {
          return;
        }
        requested = true;
        attempt(requestAttention).catch(() => {});
      },
      () => {},
    );
  }

  function apply(state: ExportStoreState, previousState: ExportStoreState): void {
    const previous: ExportAttentionState = {
      status: previousState.status,
      tracking: previousState.tracking,
    };
    const next: ExportAttentionState = {
      status: state.status,
      tracking: state.tracking,
    };
    if (next.status === "idle" || next.status === "preparing") {
      requested = false;
      // A reset while the batch goes on keeps the end of the batch to come.
      deferredEnd =
        next.status === "idle" && exportBatchContinues(queueStore.getState(), state);
      generation += 1;
      return;
    }
    const batchContinues = exportBatchContinues(queueStore.getState(), state);
    if (batchContinues && isExportRunLive(previous) && !isExportRunLive(next)) {
      deferredEnd = true;
      return;
    }
    if (requested || !endsRunForAttention(previous, next)) {
      return;
    }
    requestIfUnfocused((focused) =>
      shouldRequestExportAttention({
        previous,
        next,
        focused,
        alreadyRequested: requested,
        batchContinues,
      }),
    );
  }

  function applyQueue(queue: ExportAttentionQueueState): void {
    if (!deferredEnd || requested) {
      return;
    }
    const exportState = store.getState();
    if (isExportRunLive(exportState)) {
      return;
    }
    if (exportBatchContinues(queue, exportState)) {
      return;
    }
    // The batch ended here. A batch whose runs all ended canceled does not ask: the user
    // asked for that result, as for one run (`endsRunForAttention`).
    deferredEnd = false;
    if (!batchEndAsksForAttention(exportBatchEndsOf(queue, exportState))) {
      return;
    }
    requestIfUnfocused((focused) => !focused && !requested);
  }

  const unsubscribe = store.subscribe(apply);
  const unsubscribeQueue = queueStore.subscribe(applyQueue);
  return () => {
    stopped = true;
    unsubscribe();
    unsubscribeQueue();
  };
}
