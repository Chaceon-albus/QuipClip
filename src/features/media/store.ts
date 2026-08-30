/**
 * Media store managing imported video state, loading status, and async import actions.
 *
 * Implements latest-selection-wins concurrency semantics (ADR 008, ADR 009)
 * and preserves currently loaded media during in-flight replacements or failed attempts.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { importMedia } from "./client";
import type { ImportMediaResult, MediaState, MediaStoreState } from "./types";
import { normalizeImportMediaError } from "./validation";

/**
 * Dependencies that can be injected into the media store factory for testing.
 */
export interface MediaStoreDependencies {
  /**
   * Function to import media at the given path. Defaults to `importMedia`.
   */
  importMedia?: (path: string) => Promise<ImportMediaResult>;
}

/**
 * Factory function creating a vanilla Zustand store instance for media state.
 *
 * @param dependencies Injected dependencies for testability.
 * @param initialState Optional initial state overrides.
 */
export function createMediaStore(
  dependencies: MediaStoreDependencies = {},
  initialState?: Partial<MediaState>,
): StoreApi<MediaStoreState> {
  const importMediaFn = dependencies.importMedia ?? importMedia;
  let latestRequestId = 0;

  return createStore<MediaStoreState>()((set) => ({
    status: initialState?.status ?? "idle",
    media: initialState?.media ?? null,
    error: initialState?.error ?? null,

    reset: () => {
      // Monotonically advance request counter to discard any pending in-flight requests
      latestRequestId++;
      set({
        status: "idle",
        media: null,
        error: null,
      });
    },

    reportError: (error: unknown) => {
      // Invalidate in-flight requests so late completions do not overwrite the error state
      latestRequestId++;
      const normalized = normalizeImportMediaError(error);
      set((state) => ({
        status: "error",
        media: state.media,
        error: normalized,
      }));
    },

    importPath: async (path: string): Promise<ImportMediaResult | null> => {
      const requestId = ++latestRequestId;

      // Enter loading state while strictly preserving any existing loaded media
      set((state) => ({
        status: "loading",
        media: state.media,
        error: null,
      }));

      try {
        const result = await importMediaFn(path);

        // Discard stale responses from superseded requests
        if (requestId !== latestRequestId) {
          return null;
        }

        set({
          status: "ready",
          media: result,
          error: null,
        });

        return result;
      } catch (err) {
        const normalized = normalizeImportMediaError(err);

        // Discard stale error responses from superseded requests
        if (requestId !== latestRequestId) {
          return null;
        }

        // Preserve previous media on failure so editor does not blank
        set((state) => ({
          status: "error",
          media: state.media,
          error: normalized,
        }));

        return null;
      }
    },
  }));
}

export type MediaStore = ReturnType<typeof createMediaStore>;

/**
 * Default singleton media store for production application use.
 */
export const mediaStore: MediaStore = createMediaStore();

const defaultSelector = (state: MediaStoreState): MediaStoreState => state;

/**
 * React hook for consuming the production media store.
 */
export function useMediaStore(): MediaStoreState;
export function useMediaStore<T>(selector: (state: MediaStoreState) => T): T;
export function useMediaStore<T>(
  selector?: (state: MediaStoreState) => T,
): T | MediaStoreState {
  return useStore(
    mediaStore,
    (selector ?? defaultSelector) as (state: MediaStoreState) => T,
  );
}
