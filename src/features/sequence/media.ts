/**
 * The media of the sequence for the interface (ADR 052).
 *
 * `sequenceMediaStore` has the shape of the media store, so the interface reads it with the same
 * selectors. Its `media` is the virtual media of the sequence (`virtualMedia.ts`): with one clip,
 * the media of that clip; with several, a media whose probe describes the virtual axis. The import
 * status, the error and every action are those of the media store.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { getGeneratedSourceId } from "@/features/media/sourceIdentity";
import { mediaStore, type MediaStore } from "@/features/media/store";
import type { MediaState, MediaStoreState } from "@/features/media/types";
import { timelineStore, type TimelineStore } from "@/features/timeline/store";
import { virtualMediaOf, type MediaBySource } from "./virtualMedia";

/** The media of every source of the session, by source ID. */
export function mediaBySourceOf(state: MediaState): MediaBySource {
  const id = state.media === null ? null : getGeneratedSourceId(state.media);
  const latest = state.media === null || id === null ? {} : { [id]: state.media };
  return { ...state.sources, ...latest };
}

/** Creates the store of the media of the sequence over the media store and the timeline store. */
export function createSequenceMediaStore(
  media: MediaStore,
  timeline: TimelineStore,
): StoreApi<MediaStoreState> {
  let memo: {
    virtual: unknown;
    clips: unknown;
    attachedClipId: string | null;
    generation: number;
    sources: unknown;
    latest: unknown;
    media: MediaStoreState["media"];
  } | null = null;
  const derive = (): Pick<MediaStoreState, "status" | "error" | "media"> => {
    const state = media.getState();
    const sequence = timeline.getState();
    // An empty sequence has no media (ADR 052). With several clips, the virtual media; with one
    // clip, the media of that clip. The result is kept while nothing it depends on changed, so an
    // edit does not look like a new file to the interface.
    if (
      memo === null ||
      memo.virtual !== sequence.virtual ||
      memo.clips !== sequence.clips ||
      memo.attachedClipId !== sequence.attachedClipId ||
      memo.generation !== sequence.generation ||
      memo.sources !== state.sources ||
      memo.latest !== state.media
    ) {
      memo = {
        virtual: sequence.virtual,
        clips: sequence.clips,
        attachedClipId: sequence.attachedClipId,
        generation: sequence.generation,
        sources: state.sources,
        latest: state.media,
        // A sequence that never had a clip passes the media store through, as before ADR 052.
        media:
          sequence.clips.length > 0
            ? virtualMediaOf(sequence, mediaBySourceOf(state))
            : sequence.generation === 0
              ? state.media
              : null,
      };
    }
    const derived = memo.media;
    return { status: state.status, error: state.error, media: derived };
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

/** The production store of the media of the sequence. */
export const sequenceMediaStore: StoreApi<MediaStoreState> = createSequenceMediaStore(
  mediaStore,
  timelineStore,
);

const defaultSelector = (state: MediaStoreState): MediaStoreState => state;

/** React hook for the media of the sequence. It takes the selectors of the media store. */
export function useSequenceMediaStore(): MediaStoreState;
export function useSequenceMediaStore<T>(selector: (state: MediaStoreState) => T): T;
export function useSequenceMediaStore<T>(
  selector?: (state: MediaStoreState) => T,
): T | MediaStoreState {
  return useStore(
    sequenceMediaStore,
    (selector ?? defaultSelector) as (state: MediaStoreState) => T,
  );
}
