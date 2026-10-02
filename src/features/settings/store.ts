/**
 * Application settings store managing settings document loading, serialized persistence,
 * optimistic updates with rollback, and preset restoration.
 *
 * Implements:
 * - Serialized write queue to prevent out-of-order write races (ADR 013).
 * - Monotonic counter for latest-request-wins semantics.
 * - Optimistic save with rollback to last confirmed document on failure.
 * - Compare-and-swap revision re-based onto the last confirmed document at send time, and one
 *   re-read after a `settingsConflict` so the session is not left on a spent revision.
 * - Adoption of a document that another window wrote (`adoptExternal`), with a re-base floor
 *   so that an edit built before that write is refused as a conflict and never overwrites it.
 * - public serializable store state with closure-held queue and counters.
 *
 * # Two windows
 *
 * The main window and the Settings window each run this store, and each one writes the same
 * file. Rust sends every stored document to both (`settings:changed`), and the window that did
 * not write it calls `adoptExternal`. A document whose revision is not above the last
 * confirmed one is old news and changes nothing, so an event that arrives late, or twice, is
 * harmless. The revisions are compared as numbers: the u32 counter of ADR 013 wraps only after
 * four billion saves.
 *
 * The re-base at send time exists for this window's own writes that overlap, and it must not
 * reach past a write of the other window. A save of a document built on revision 5, sent after
 * this store took revision 6 from the other window, would otherwise go out as revision 6 and
 * replace the other window's write with no conflict. So the store keeps a floor: the revision
 * of the newest document that it took from outside its own writes, by an adoption or by a
 * read. A document built below the floor goes out with its own revision, and Rust refuses it
 * with `settingsConflict`, which re-reads the file as any conflict does.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  loadSettings,
  resetSettings,
  restoreDefaultPresets,
  saveSettings,
} from "./client";
import {
  SettingsError,
  type LoadSettingsResult,
  type Settings,
  type SettingsState,
  type SettingsStoreState,
} from "./types";
import {
  isSettings,
  normalizeSettingsError,
  validateLoadSettingsResult,
  validateSettings,
} from "./validation";

/**
 * Dependencies that can be injected into the settings store factory for testing.
 */
export interface SettingsStoreDependencies {
  loadSettings?: () => Promise<LoadSettingsResult>;
  saveSettings?: (settings: Settings) => Promise<Settings>;
  restoreDefaultPresets?: () => Promise<Settings>;
  resetSettings?: () => Promise<Settings>;
}

/**
 * Factory function creating a vanilla Zustand store instance for application settings.
 *
 * The write queue and monotonic request counter are maintained in the factory closure
 * so that the public store state remains strictly serializable.
 *
 * @param dependencies Injected dependencies for testability.
 * @param initialState Optional initial state overrides for testing.
 */
export function createSettingsStore(
  dependencies: SettingsStoreDependencies = {},
  initialState?: Partial<SettingsState>,
): StoreApi<SettingsStoreState> {
  const loadSettingsFn = dependencies.loadSettings ?? loadSettings;
  const saveSettingsFn = dependencies.saveSettings ?? saveSettings;
  const restoreDefaultPresetsFn =
    dependencies.restoreDefaultPresets ?? restoreDefaultPresets;
  const resetSettingsFn = dependencies.resetSettings ?? resetSettings;

  let latestRequestId = 0;
  let writeQueue: Promise<unknown> = Promise.resolve();
  let lastConfirmedSettings: Settings | null = initialState?.settings ?? null;
  // The requests in the queue that have not settled: loads, re-reads and writes. While one is
  // pending, an adopted document waits for it, because the request publishes a document when
  // it settles and that document would replace the adopted one.
  let pendingRequests = 0;
  // The re-base floor (see the module comment), or null before the store took any document
  // from outside its own writes.
  let rebaseFloor: number | null = null;
  // Counts the adopted documents, so that a request can tell whether an adoption happened
  // while it was in flight.
  let adoptions = 0;
  // An adopted document that waits for the pending requests, or null.
  let deferredAdoption: Settings | null = null;

  // A document that a read returned. It moves the floor when it is not the document this
  // store already held, because the file then changed without a write of this window.
  const noteRead = (settings: Settings): void => {
    if (
      lastConfirmedSettings === null ||
      lastConfirmedSettings.revision !== settings.revision
    ) {
      rebaseFloor = settings.revision;
    }
  };

  // The document that a request publishes when it succeeds: the document it read or wrote,
  // except when the store adopted a newer document while the request was in flight. A read
  // then reports the file from before the other window's write, and the result of a write and
  // the event of the other window arrive in no fixed order.
  const newestSince = (document: Settings, adoptionsAtStart: number): Settings =>
    adoptions !== adoptionsAtStart &&
    lastConfirmedSettings !== null &&
    lastConfirmedSettings.revision > document.revision
      ? lastConfirmedSettings
      : document;

  return createStore<SettingsStoreState>()((set, get) => {
    // Shows an adopted document. A failed write keeps its error: the message describes an
    // edit of this window that did not reach the disk. A failed load has no document, and the
    // adopted document replaces its error, because the file is readable again.
    const publishAdopted = (next: Settings): void => {
      const state = get();
      if (state.status === "error" && state.settings !== null) {
        set({ settings: next, seeded: false });
        return;
      }
      set({ status: "ready", settings: next, seeded: false, error: null });
    };

    // Queues a request behind every earlier one, and counts it as pending until it settles.
    // When the last pending request settles, an adopted document that no request showed
    // shows now. A request that a newer request or `reset` superseded publishes nothing.
    const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
      pendingRequests++;
      const settle = async (): Promise<T> => {
        try {
          return await run();
        } finally {
          pendingRequests--;
          const waiting = deferredAdoption;
          if (pendingRequests === 0 && waiting !== null) {
            deferredAdoption = null;
            if (lastConfirmedSettings === waiting && get().settings !== waiting) {
              publishAdopted(waiting);
            }
          }
        }
      };
      const task = writeQueue.then(settle, settle);
      writeQueue = task.catch(() => {});
      return task;
    };

    // A `settingsConflict` leaves `lastConfirmedSettings` holding a revision the file has
    // moved past, so every later write in the session would rebuild from it and be refused
    // again. This queues one re-read to put the session back on the document the other writer
    // left. The file is readable by definition in this arm -- the conflict came from a
    // successful read -- so the re-read cannot fail for the reason the write did.
    //
    // The error stays published, and the status stays `error`. The write did not reach disk,
    // and clearing the message would leave the user looking at a screen that changed under
    // them with nothing to say why.
    const rebaseAfterConflict = (requestId: number, error: SettingsError): void => {
      if (error.code !== "settingsConflict") {
        return;
      }

      const adoptionsAtStart = adoptions;
      const runRebase = async (): Promise<void> => {
        try {
          const result = validateLoadSettingsResult(await loadSettingsFn());

          // A newer request was issued while this re-read was in flight; its own outcome is
          // the authoritative one, so this leaves both the state and `lastConfirmedSettings`
          // to it.
          if (requestId !== latestRequestId) {
            return;
          }

          const newest = newestSince(result.settings, adoptionsAtStart);
          noteRead(newest);
          lastConfirmedSettings = newest;
          set({
            status: "error",
            settings: newest,
            seeded: newest === result.settings ? result.seeded : false,
            error,
          });
        } catch {
          // The rollback the caller already published stands, and so does the error that
          // describes what happened to the user's edit.
        }
      };

      void enqueue(runRebase);
    };

    const load = async (): Promise<LoadSettingsResult | null> => {
      const requestId = ++latestRequestId;
      const adoptionsAtStart = adoptions;
      set({
        status: "loading",
        error: null,
      });

      const runLoad = async (): Promise<LoadSettingsResult | null> => {
        try {
          const rawResult = await loadSettingsFn();
          const result = validateLoadSettingsResult(rawResult);

          if (requestId !== latestRequestId) {
            return null;
          }

          const newest = newestSince(result.settings, adoptionsAtStart);
          const published: LoadSettingsResult =
            newest === result.settings ? result : { settings: newest, seeded: false };
          noteRead(newest);
          lastConfirmedSettings = newest;
          set({
            status: "ready",
            settings: published.settings,
            seeded: published.seeded,
            error: null,
          });

          return published;
        } catch (err) {
          const normalized = normalizeSettingsError(err);

          if (requestId !== latestRequestId) {
            return null;
          }

          // A document that another window wrote while this read was in flight stays: Rust
          // read the file without fault to write it. The error still shows.
          const kept = adoptions !== adoptionsAtStart ? lastConfirmedSettings : null;
          lastConfirmedSettings = kept;
          set({
            status: "error",
            settings: kept,
            error: normalized,
          });

          return null;
        }
      };

      return enqueue(runLoad);
    };

    const save = async (next: Settings): Promise<Settings | null> => {
      // Reject malformed documents early before publishing to state (NON-BLOCKING 8).
      // This branch does NOT touch `latestRequestId`. The counter decides which of the
      // requests that were actually issued wins; a request rejected before any IPC has no
      // result to win with, and bumping the counter here would invalidate an in-flight
      // load and leave the dialog on "Loading…" forever.
      if (!isSettings(next)) {
        set({
          status: "error",
          settings: lastConfirmedSettings,
          error: new SettingsError({
            code: "invalidSettings",
            detail: "Invalid settings document: payload must match Settings schema",
          }),
        });

        return null;
      }

      const requestId = ++latestRequestId;
      const adoptionsAtStart = adoptions;

      // Optimistically update store state immediately
      set({
        status: "saving",
        settings: next,
        error: null,
      });

      const runWrite = async (): Promise<Settings | null> => {
        try {
          // Re-base the revision onto the last confirmed document immediately before the
          // send. `next` was built from `state.settings`, which is optimistically published
          // above and therefore carries a revision an in-flight write has already spent: a
          // second edit made inside one round trip would otherwise be refused as a conflict
          // with another copy of QuipClip, which would be a lie about this window's own
          // write. The queue serializes writes, so by the time this runs
          // `lastConfirmedSettings` holds the revision the file really has. A genuine
          // cross-process conflict still fails, which is the whole point of the token.
          //
          // A document built below the re-base floor predates a write that this window did
          // not make, so it goes out with its own revision and Rust refuses it. A re-base
          // there would replace the other write with no conflict.
          const confirmed = lastConfirmedSettings;
          const payload =
            confirmed !== null && (rebaseFloor === null || next.revision >= rebaseFloor)
              ? { ...next, revision: confirmed.revision }
              : next;

          // `saved`, not `payload`. Rust bumps `revision` -- the ADR 013 compare-and-swap
          // token -- inside the document it returns, so adopting the return value is what
          // carries the new revision into `lastConfirmedSettings` and into published state.
          // Republishing what was sent would leave the interface one revision behind the file
          // and the next save would be refused.
          const saved = await saveSettingsFn(payload);
          const validated = validateSettings(saved);
          const newest = newestSince(validated, adoptionsAtStart);
          lastConfirmedSettings = newest;

          if (requestId === latestRequestId) {
            set({
              status: "ready",
              settings: newest,
              seeded: false,
              error: null,
            });
          }

          return validated;
        } catch (err) {
          const normalized = normalizeSettingsError(err);

          // Roll back ONLY if this failed write is still the latest request
          if (requestId === latestRequestId) {
            set({
              status: "error",
              settings: lastConfirmedSettings,
              error: normalized,
            });
          }

          rebaseAfterConflict(requestId, normalized);

          return null;
        }
      };

      // Chain onto writeQueue so writes never fire concurrently
      return enqueue(runWrite);
    };

    const restoreDefaults = async (): Promise<Settings | null> => {
      const requestId = ++latestRequestId;
      const adoptionsAtStart = adoptions;

      set({
        status: "saving",
        error: null,
      });

      const runRestore = async (): Promise<Settings | null> => {
        try {
          const restored = await restoreDefaultPresetsFn();
          const validated = validateSettings(restored);
          const newest = newestSince(validated, adoptionsAtStart);
          lastConfirmedSettings = newest;

          if (requestId === latestRequestId) {
            set({
              status: "ready",
              settings: newest,
              error: null,
            });
          }

          return validated;
        } catch (err) {
          const normalized = normalizeSettingsError(err);

          if (requestId === latestRequestId) {
            set({
              status: "error",
              settings: lastConfirmedSettings,
              error: normalized,
            });
          }

          rebaseAfterConflict(requestId, normalized);

          return null;
        }
      };

      return enqueue(runRestore);
    };

    const resetSettingsAction = async (): Promise<Settings | null> => {
      const requestId = ++latestRequestId;
      const adoptionsAtStart = adoptions;

      set({
        status: "saving",
        error: null,
      });

      const runReset = async (): Promise<Settings | null> => {
        try {
          const resetDoc = await resetSettingsFn();
          const validated = validateSettings(resetDoc);
          const newest = newestSince(validated, adoptionsAtStart);
          lastConfirmedSettings = newest;

          if (requestId === latestRequestId) {
            set({
              status: "ready",
              settings: newest,
              seeded: false,
              error: null,
            });
          }

          return validated;
        } catch (err) {
          const normalized = normalizeSettingsError(err);

          if (requestId === latestRequestId) {
            set({
              status: "error",
              settings: lastConfirmedSettings,
              error: normalized,
            });
          }

          rebaseAfterConflict(requestId, normalized);

          return null;
        }
      };

      return enqueue(runReset);
    };

    const adoptExternal = (next: Settings): void => {
      if (!isSettings(next)) {
        return;
      }
      if (
        lastConfirmedSettings !== null &&
        next.revision <= lastConfirmedSettings.revision
      ) {
        return;
      }
      adoptions++;
      lastConfirmedSettings = next;
      rebaseFloor = next.revision;
      if (pendingRequests > 0) {
        // The pending request publishes when it settles: the adopted document, through
        // `newestSince` or a rollback to `lastConfirmedSettings`, or a newer document of its
        // own. `enqueue` publishes it when no request did.
        deferredAdoption = next;
        return;
      }
      publishAdopted(next);
    };

    const reset = (): void => {
      latestRequestId++;
      lastConfirmedSettings = null;
      rebaseFloor = null;
      deferredAdoption = null;
      set({
        status: "idle",
        settings: null,
        seeded: false,
        error: null,
      });
    };

    const reportError = (error: unknown): void => {
      const normalized = normalizeSettingsError(error);
      set((state) => ({
        status: "error",
        settings: state.settings,
        error: normalized,
      }));
    };

    const storeState = {
      status: initialState?.status ?? "idle",
      settings: initialState?.settings ?? null,
      seeded: initialState?.seeded ?? false,
      error: initialState?.error ?? null,

      loadSettings: load,
      saveSettings: save,
      restoreDefaultPresets: restoreDefaults,
      resetSettings: resetSettingsAction,
      adoptExternal,
      reportError,
      reset,
    };

    return storeState;
  });
}

export type SettingsStore = StoreApi<SettingsStoreState>;

/**
 * Default singleton settings store for application use.
 */
export const settingsStore: SettingsStore = createSettingsStore();

const defaultSelector = (state: SettingsStoreState): SettingsStoreState => state;

/**
 * React hook for consuming the settings store.
 */
export function useSettingsStore(): SettingsStoreState;
export function useSettingsStore<T>(selector: (state: SettingsStoreState) => T): T;
export function useSettingsStore<T>(
  selector?: (state: SettingsStoreState) => T,
): T | SettingsStoreState {
  return useStore(
    settingsStore,
    (selector ?? defaultSelector) as (state: SettingsStoreState) => T,
  );
}
