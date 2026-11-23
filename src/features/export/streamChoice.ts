/**
 * The choice of the output streams in the export setup step (ADR 036), and of a copy of the
 * audio (ADR 048).
 *
 * The setup step shows one switch for the video and one for the audio. Both are on by
 * default, and the user can turn one off but never both. Where the step offers a copy of the
 * audio (`canCopyAudio`), a third switch asks for it, and it is off by default. The choice lasts
 * for the session: it is not a field of the preset, and nothing stores it in the settings file
 * or in the web view. `bindStreamChoiceToMedia` turns both streams on and the copy off again
 * each time the open media changes, so a choice made for one file never applies to the next.
 *
 * The Adjust switch of the Gain row (ADR 061) lasts for the session in the same way, and the
 * same reset turns it off. An Adjust switch that is on needs an encode of the audio, so the
 * store never holds it and the copy both on: a turn of Adjust to on turns the copy off, and a
 * turn of the copy to on does nothing while Adjust is on.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { mediaStore } from "@/features/media/store";
import type { MediaProbe, MediaState } from "@/features/media/types";
import type { PresetContainer } from "@/features/settings/types";
import type { ExportStreams } from "./types";

/** A stream of the source that the setup step can switch on or off. */
export type ExportStreamKind = "video" | "audio";

/** The switches of the setup step: true for each stream that the user wants to export. */
export type ExportStreamChoice = Readonly<Record<ExportStreamKind, boolean>>;

/** The default choice: the video and the audio. */
export const BOTH_EXPORT_STREAMS: ExportStreamChoice = { video: true, audio: true };

/**
 * True when the source can give an audio stream: the probe reports one, or no source is open
 * and nothing is known. The preset summary uses the same rule for its note on a source with
 * no audio.
 */
export function sourceHasAudio(source: Pick<MediaProbe, "audio"> | null): boolean {
  return source === null || source.audio !== null;
}

/**
 * The streams that the export writes, for the choice of the user and the source.
 *
 * - A source with no audio stream writes the video only, whatever the choice, because the
 *   backend refuses an audio-only export of such a source (`sourceHasNoAudio`).
 * - With the audio off, the export writes the video only.
 * - With the video off, it writes the audio only.
 *
 * The store never holds a choice with both streams off. Such a choice gives the video only,
 * so the result always names at least one stream.
 */
export function resolveExportStreams(
  choice: ExportStreamChoice,
  hasAudio: boolean,
): ExportStreams {
  if (!hasAudio || !choice.audio) {
    return "videoOnly";
  }
  return choice.video ? "videoAndAudio" : "audioOnly";
}

/**
 * The file extension of the output, with no dot.
 *
 * An audio-only export of an MP4 or a MOV preset writes an `.m4a` file, and one of an MKV
 * preset writes an `.mka` file (ADR 036). Every other export writes the extension of the
 * container. The backend does not change the extension, so the save dialog must use this one.
 */
export function exportOutputExtension(
  container: PresetContainer,
  streams: ExportStreams,
): string {
  if (streams !== "audioOnly") {
    return container;
  }
  return container === "mkv" ? "mka" : "m4a";
}

export type ExportStreamChoiceState = {
  choice: ExportStreamChoice;
  /**
   * True when the user asked for a copy of the audio. It asks for a copy only while the setup
   * step offers one (`resolveExportAudioMode`), so it can stay true while the step offers none,
   * and apply again when the step offers it again.
   */
  copyAudio: boolean;
  /**
   * True when the user turned on the Adjust switch of the Gain row (ADR 061): the step measures
   * the audio and the export applies the gain of the row. The store never holds it and the copy
   * of the audio both on, because a copy applies no gain.
   */
  adjustGain: boolean;
};

export type ExportStreamChoiceActions = {
  /**
   * Turns one stream on or off. A change that would turn off the last stream that is on does
   * nothing, so at least one stream stays on.
   */
  setStream: (kind: ExportStreamKind, on: boolean) => void;
  /** Asks for a copy of the audio, or for an encode. A copy does nothing while Adjust is on. */
  setCopyAudio: (on: boolean) => void;
  /**
   * Turns the Adjust switch on or off (ADR 061). On also turns the copy of the audio off, also a
   * copy that the step does not offer now.
   */
  setAdjustGain: (on: boolean) => void;
  /** Turns both streams on, and the copy of the audio and the Adjust switch off. */
  reset: () => void;
};

export type ExportStreamChoiceStoreState = ExportStreamChoiceState &
  ExportStreamChoiceActions;

export function createExportStreamChoiceStore(
  initialChoice: ExportStreamChoice = BOTH_EXPORT_STREAMS,
  initialCopyAudio = false,
  initialAdjustGain = false,
): StoreApi<ExportStreamChoiceStoreState> {
  return createStore<ExportStreamChoiceStoreState>()((set, get) => ({
    choice: initialChoice,
    // The two are never on together, whatever the caller passes.
    copyAudio: initialCopyAudio && !initialAdjustGain,
    adjustGain: initialAdjustGain,
    setStream: (kind, on) => {
      const current = get().choice;
      if (current[kind] === on) {
        return;
      }
      const next: ExportStreamChoice = { ...current, [kind]: on };
      if (!next.video && !next.audio) {
        return;
      }
      set({ choice: next });
    },
    setCopyAudio: (on) => {
      const { copyAudio, adjustGain } = get();
      if (copyAudio === on || (on && adjustGain)) {
        return;
      }
      set({ copyAudio: on });
    },
    setAdjustGain: (on) => {
      const { copyAudio, adjustGain } = get();
      if (adjustGain === on && !(on && copyAudio)) {
        return;
      }
      set(on ? { adjustGain: true, copyAudio: false } : { adjustGain: false });
    },
    reset: () => {
      const { choice, copyAudio, adjustGain } = get();
      if (!choice.video || !choice.audio || copyAudio || adjustGain) {
        set({ choice: BOTH_EXPORT_STREAMS, copyAudio: false, adjustGain: false });
      }
    },
  }));
}

export type ExportStreamChoiceStore = ReturnType<typeof createExportStreamChoiceStore>;

/**
 * Turns both streams of `choice` on, and its copy of the audio off, again each time the media
 * of `source` changes: another file opens, the same file opens again, or the media closes. The
 * media store makes a new media object only for each of these. Returns the function that ends
 * the binding.
 */
export function bindStreamChoiceToMedia(
  source: StoreApi<Pick<MediaState, "media">>,
  choice: ExportStreamChoiceStore,
): () => void {
  return source.subscribe((state, previous) => {
    if (state.media !== previous.media) {
      choice.getState().reset();
    }
  });
}

export const exportStreamChoiceStore: ExportStreamChoiceStore =
  createExportStreamChoiceStore();

// The binding lasts for the life of the web view, the same as both stores.
bindStreamChoiceToMedia(mediaStore, exportStreamChoiceStore);

const defaultSelector = (
  state: ExportStreamChoiceStoreState,
): ExportStreamChoiceStoreState => state;

export function useExportStreamChoice(): ExportStreamChoiceStoreState;
export function useExportStreamChoice<T>(
  selector: (state: ExportStreamChoiceStoreState) => T,
): T;
export function useExportStreamChoice<T>(
  selector?: (state: ExportStreamChoiceStoreState) => T,
): T | ExportStreamChoiceStoreState {
  return useStore(
    exportStreamChoiceStore,
    (selector ?? defaultSelector) as (state: ExportStreamChoiceStoreState) => T,
  );
}
