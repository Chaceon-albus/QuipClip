/**
 * The media of the clip that the preview shows (ADR 052).
 *
 * `attachedMediaStore` has the shape of the media store, so the preview, the title bar and the
 * status bar read it with the same selectors. Its `media` is the media of the attached clip: the
 * file of that clip, with its own probe. While the sequence has no clip, it is null.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { mediaStore, type MediaStore } from "@/features/media/store";
import type { MediaStoreState } from "@/features/media/types";
import { timelineStore, type TimelineStore } from "@/features/timeline/store";
import { attachedMediaOf } from "./virtualMedia";

/** Creates the store of the attached media over the media store and the timeline store. */
export function createAttachedMediaStore(
  media: MediaStore,
  timeline: TimelineStore,
): StoreApi<MediaStoreState> {
  const derive = (): Pick<MediaStoreState, "status" | "error" | "media"> => {
    const state = media.getState();
    const sequence = timeline.getState();
    return {
      status: state.status,
      error: state.error,
      // An empty sequence attaches nothing (ADR 052): no file shows after Clear Timeline, the
      // removal of the last clip, or an Undo of the first import. A sequence that never had a
      // clip passes the media store through, as before ADR 052.
      media:
        sequence.clips.length > 0
          ? attachedMediaOf(sequence, state.sources)
          : sequence.generation === 0
            ? state.media
            : null,
    };
  };
  const store = createStore<MediaStoreState>()(() => ({
    ...media.getState(),
    ...derive(),
  }));
  const refresh = (): void => {
    const next = derive();
    const current = store.getState();
    if (
      next.media !== current.media ||
      next.status !== current.status ||
      next.error !== current.error
    ) {
      store.setState(next);
    }
  };
  media.subscribe(refresh);
  timeline.subscribe(refresh);
  return store;
}

/** The production store of the attached media. */
export const attachedMediaStore: StoreApi<MediaStoreState> = createAttachedMediaStore(
  mediaStore,
  timelineStore,
);

const defaultSelector = (state: MediaStoreState): MediaStoreState => state;

/** React hook for the attached media. It takes the selectors of the media store. */
export function useAttachedMediaStore(): MediaStoreState;
export function useAttachedMediaStore<T>(selector: (state: MediaStoreState) => T): T;
export function useAttachedMediaStore<T>(
  selector?: (state: MediaStoreState) => T,
): T | MediaStoreState {
  return useStore(
    attachedMediaStore,
    (selector ?? defaultSelector) as (state: MediaStoreState) => T,
  );
}
