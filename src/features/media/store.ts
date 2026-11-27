/**
 * Media store managing imported video state, loading status, and async import actions.
 *
 * Implements latest-selection-wins concurrency semantics and preserves currently loaded
 * media during in-flight replacements or failed attempts.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { importMedia } from "./client";
import { getGeneratedSourceId } from "./sourceIdentity";
import type {
  ImportMediaError,
  ImportMediaResult,
  MediaState,
  MediaStoreState,
} from "./types";
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

  return createStore<MediaStoreState>()((set, get) => ({
    status: initialState?.status ?? "idle",
    media: initialState?.media ?? null,
    sources: initialState?.sources ?? {},
    error: initialState?.error ?? null,

    reset: () => {
      // Monotonically advance request counter to discard any pending in-flight requests
      latestRequestId++;
      set({
        status: "idle",
        media: null,
        sources: {},
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

    dismissError: (error?: ImportMediaError) => {
      // Only the error goes away. No import is in flight while the status is `error`, so the
      // request counter stays as it is.
      set((state) =>
        state.status !== "error" || (error !== undefined && state.error !== error)
          ? state
          : {
              status: state.media ? "ready" : "idle",
              media: state.media,
              error: null,
            },
      );
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

        // A revision that the session has as a source keeps its facts (ADR 052, ADR 072): the
        // import answers with the facts of the result that the store has, not with the new
        // answer of the backend. So an import after the open of a project does not replace the
        // end that the open gave to an FLV. The answer is still a new object, because a new
        // media object is a new open of the file for its readers: the export stream choice
        // resets, and the preview drops a decode failure.
        const id = getGeneratedSourceId(result);
        const known = id === null ? undefined : get().sources[id];
        const answer: ImportMediaResult = known === undefined ? result : { ...known };
        set((state) => ({
          status: "ready",
          media: answer,
          sources: id === null ? state.sources : { ...state.sources, [id]: answer },
          error: null,
        }));

        return answer;
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
