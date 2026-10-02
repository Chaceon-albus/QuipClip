/**
 * The choice of the output streams in the export setup step (ADR 036).
 *
 * The setup step shows one switch for the video and one for the audio. Both are on by
 * default, and the user can turn one off but never both. The choice lasts for the session:
 * it is not a field of the preset, and nothing stores it in the settings file or in the web
 * view. `bindStreamChoiceToMedia` turns both streams on again each time the open media
 * changes, so a choice made for one file never applies to the next.
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
};

export type ExportStreamChoiceActions = {
  /**
   * Turns one stream on or off. A change that would turn off the last stream that is on does
   * nothing, so at least one stream stays on.
   */
  setStream: (kind: ExportStreamKind, on: boolean) => void;
  /** Turns both streams on. */
  reset: () => void;
};

export type ExportStreamChoiceStoreState = ExportStreamChoiceState &
  ExportStreamChoiceActions;

export function createExportStreamChoiceStore(
  initialChoice: ExportStreamChoice = BOTH_EXPORT_STREAMS,
): StoreApi<ExportStreamChoiceStoreState> {
  return createStore<ExportStreamChoiceStoreState>()((set, get) => ({
    choice: initialChoice,
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
    reset: () => {
      const current = get().choice;
      if (!current.video || !current.audio) {
        set({ choice: BOTH_EXPORT_STREAMS });
      }
    },
  }));
}

export type ExportStreamChoiceStore = ReturnType<typeof createExportStreamChoiceStore>;

/**
 * Turns both streams of `choice` on again each time the media of `source` changes: another
 * file opens, the same file opens again, or the media closes. The media store makes a new
 * media object only for each of these. Returns the function that ends the binding.
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
