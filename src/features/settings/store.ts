/**
 * Application settings store managing settings document loading, serialized persistence,
 * optimistic updates with rollback, and preset restoration.
 *
 * Implements:
 * - Serialized write queue to prevent out-of-order write races (ADR 013).
 * - Monotonic counter for latest-request-wins semantics (ADR 008).
 * - Optimistic save with rollback to last confirmed document on failure.
 * - Compare-and-swap revision re-based onto the last confirmed document at send time, and one
 *   re-read after a `settingsConflict` so the session is not left on a spent revision.
 * - public serializable store state with closure-held queue and counters.
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

  return createStore<SettingsStoreState>()((set) => {
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

      const runRebase = async (): Promise<void> => {
        try {
          const result = validateLoadSettingsResult(await loadSettingsFn());

          // A newer request was issued while this re-read was in flight; its own outcome is
          // the authoritative one, so this leaves both the state and `lastConfirmedSettings`
          // to it.
          if (requestId !== latestRequestId) {
            return;
          }

          lastConfirmedSettings = result.settings;
          set({
            status: "error",
            settings: result.settings,
            seeded: result.seeded,
            error,
          });
        } catch {
          // The rollback the caller already published stands, and so does the error that
          // describes what happened to the user's edit.
        }
      };

      writeQueue = writeQueue.then(runRebase, runRebase).catch(() => {});
    };

    const load = async (): Promise<LoadSettingsResult | null> => {
      const requestId = ++latestRequestId;
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

          lastConfirmedSettings = result.settings;
          set({
            status: "ready",
            settings: result.settings,
            seeded: result.seeded,
            error: null,
          });

          return result;
        } catch (err) {
          const normalized = normalizeSettingsError(err);

          if (requestId !== latestRequestId) {
            return null;
          }

          lastConfirmedSettings = null;
          set({
            status: "error",
            settings: null,
            error: normalized,
          });

          return null;
        }
      };

      const task = writeQueue.then(runLoad, runLoad);
      writeQueue = task.catch(() => {});
      return task;
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
          const payload =
            lastConfirmedSettings === null
              ? next
              : { ...next, revision: lastConfirmedSettings.revision };

          // `saved`, not `payload`. Rust bumps `revision` -- the ADR 013 compare-and-swap
          // token -- inside the document it returns, so adopting the return value is what
          // carries the new revision into `lastConfirmedSettings` and into published state.
          // Republishing what was sent would leave the interface one revision behind the file
          // and the next save would be refused.
          const saved = await saveSettingsFn(payload);
          const validated = validateSettings(saved);
          lastConfirmedSettings = validated;

          if (requestId === latestRequestId) {
            set({
              status: "ready",
              settings: validated,
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
      const task = writeQueue.then(runWrite, runWrite);
      writeQueue = task.catch(() => {});
      return task;
    };

    const restoreDefaults = async (): Promise<Settings | null> => {
      const requestId = ++latestRequestId;

      set({
        status: "saving",
        error: null,
      });

      const runRestore = async (): Promise<Settings | null> => {
        try {
          const restored = await restoreDefaultPresetsFn();
          const validated = validateSettings(restored);
          lastConfirmedSettings = validated;

          if (requestId === latestRequestId) {
            set({
              status: "ready",
              settings: validated,
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

      const task = writeQueue.then(runRestore, runRestore);
      writeQueue = task.catch(() => {});
      return task;
    };

    const resetSettingsAction = async (): Promise<Settings | null> => {
      const requestId = ++latestRequestId;

      set({
        status: "saving",
        error: null,
      });

      const runReset = async (): Promise<Settings | null> => {
        try {
          const resetDoc = await resetSettingsFn();
          const validated = validateSettings(resetDoc);
          lastConfirmedSettings = validated;

          if (requestId === latestRequestId) {
            set({
              status: "ready",
              settings: validated,
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

      const task = writeQueue.then(runReset, runReset);
      writeQueue = task.catch(() => {});
      return task;
    };

    const reset = (): void => {
      latestRequestId++;
      lastConfirmedSettings = null;
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
