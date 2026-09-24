/**
 * Asks the system for the attention of the user when an export ends while the window does not
 * have the focus.
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
  exportStore,
  isExportRunLive,
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
}

/**
 * True when the change ends a run in a result that the user did not ask for: the store goes
 * from a live run (`isExportRunLive`) to `finished` or `failed`, and no longer tracks a run.
 *
 * - A `failed` with `tracking` still true is not an end. A Stop request failed, by run id or
 *   by slot while the start waited for its run id. The run continues, and its real end comes
 *   later, as `failed` to `failed`, through `publishing` to `finished`, or as the refusal of
 *   the start.
 * - A refused start counts as an end: `preparing` to `failed` with no tracked run. The
 *   prepare step of `start_export` can take up to 30 seconds (ADR 016), which is long enough
 *   for the user to go to another window.
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
 * while the window did not have the focus.
 */
export function shouldRequestExportAttention(input: ExportAttentionInput): boolean {
  return (
    !input.focused &&
    !input.alreadyRequested &&
    endsRunForAttention(input.previous, input.next)
  );
}

export interface ExportAttentionSyncOptions {
  /** Defaults to the production `exportStore`. */
  store?: StoreApi<ExportStoreState>;
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
 * Subscribes to the export store and asks for attention when a run ends while the window does
 * not have the focus. Returns the unsubscribe function.
 *
 * The focus is read when the run ends, not tracked, so a change that does not end a run sends
 * no call.
 *
 * One run asks at most once. `endsRunForAttention` already ignores the `failed` that a failed
 * Stop reports while the run continues, and the flag is a second guard on top of it. The flag
 * clears only when a new run starts (`preparing`) or the store resets (`idle`).
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
  const isFocused = options.isFocused ?? (() => getCurrentWindow().isFocused());
  const requestAttention =
    options.requestAttention ??
    (() => getCurrentWindow().requestUserAttention(UserAttentionType.Informational));

  let requested = false;
  let generation = 0;
  let stopped = false;

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
      generation += 1;
      return;
    }
    if (requested || !endsRunForAttention(previous, next)) {
      return;
    }
    const queryGeneration = generation;
    attempt(isFocused).then(
      (focused) => {
        if (stopped || queryGeneration !== generation) {
          return;
        }
        if (
          !shouldRequestExportAttention({
            previous,
            next,
            focused,
            alreadyRequested: requested,
          })
        ) {
          return;
        }
        requested = true;
        attempt(requestAttention).catch(() => {});
      },
      () => {},
    );
  }

  const unsubscribe = store.subscribe(apply);
  return () => {
    stopped = true;
    unsubscribe();
  };
}
