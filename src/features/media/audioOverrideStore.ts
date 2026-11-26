/**
 * The audio stream overrides of the session (ADR 070), by source id.
 *
 * An override is state of the session, not an edit of the timeline: Undo does not change it, and
 * no project file holds it yet. It is kept for the id of a source, which names one revision of a
 * file (ADR 007), so a file that changed is a new source with no override, and the clips of one
 * source share one override. A source that leaves the media store loses its override.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { isFlvProbe, overrideOfStream, type AudioStreamOverride } from "./audioStream";
import { mediaStore } from "./store";
import type { ListedAudioStream, MediaProbe } from "./types";

export interface AudioOverrideState {
  /** The override of each source that has one, by source id. */
  readonly overrides: Readonly<Record<string, AudioStreamOverride>>;
}

export interface AudioOverrideActions {
  /**
   * Sets the override of `sourceId` to `stream`, a stream of `probe`, the probe of its import.
   * Choosing the preferred stream sets a real override too: the record keeps the override and the
   * preferred stream apart. An FLV holds no override (`isFlvProbe`), so the call changes nothing
   * for it.
   */
  choose: (
    sourceId: string,
    probe: Pick<MediaProbe, "formatNames">,
    stream: ListedAudioStream,
  ) => void;
  /** Drops the override of each source that is not in `sourceIds`. */
  retain: (sourceIds: Iterable<string>) => void;
}

export type AudioOverrideStoreState = AudioOverrideState & AudioOverrideActions;

export type AudioOverrideStore = StoreApi<AudioOverrideStoreState>;

function sameOverride(a: AudioStreamOverride, b: AudioStreamOverride): boolean {
  return (
    a.index === b.index &&
    a.codec === b.codec &&
    a.sampleRate === b.sampleRate &&
    a.channels === b.channels
  );
}

export function createAudioOverrideStore(): AudioOverrideStore {
  return createStore<AudioOverrideStoreState>()((set, get) => ({
    overrides: {},

    choose: (sourceId, probe, stream) => {
      if (isFlvProbe(probe)) {
        return;
      }
      const next = overrideOfStream(stream);
      const current = get().overrides[sourceId];
      // The same override again changes no state, so no reader reacts.
      if (current !== undefined && sameOverride(current, next)) {
        return;
      }
      set((state) => ({ overrides: { ...state.overrides, [sourceId]: next } }));
    },

    retain: (sourceIds) => {
      const kept = new Set(sourceIds);
      const { overrides } = get();
      const dropped = Object.keys(overrides).filter((id) => !kept.has(id));
      if (dropped.length === 0) {
        return;
      }
      const next = { ...overrides };
      for (const id of dropped) {
        delete next[id];
      }
      set({ overrides: next });
    },
  }));
}

/** The overrides of this page. */
export const audioOverrideStore: AudioOverrideStore = createAudioOverrideStore();

// A source that leaves the media store, as at a clear of the timeline, leaves the session, so its
// override goes too.
mediaStore.subscribe((state, previous) => {
  if (state.sources !== previous.sources) {
    audioOverrideStore.getState().retain(Object.keys(state.sources));
  }
});

const selectOverrides = (state: AudioOverrideStoreState) => state.overrides;

/** React hook for the overrides of this page. */
export function useAudioOverrides(): Readonly<Record<string, AudioStreamOverride>> {
  return useStore(audioOverrideStore, selectOverrides);
}
