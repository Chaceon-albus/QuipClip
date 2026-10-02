/**
 * Keeps the stored preset test results of this window current, for the component that shows
 * them: the preset library of the Settings window and the export setup of the main window.
 *
 * The stored results depend on three things: the settings document, because each result is
 * named by the id of a saved preset; the FFmpeg binary, because Rust keys each result by it;
 * and the tests of the other window. `startPresetTestSync` reads the results again for the
 * third. This module supplies the first two, from the settings store and the ffmpeg store. A
 * new binary also raises the binary generation of the preset test store, so the tests of the
 * binary before stop showing.
 */

import { useEffect } from "react";
import type { StoreApi } from "zustand/vanilla";
import { ffmpegStore } from "@/features/ffmpeg/store";
import type { FfmpegStoreState } from "@/features/ffmpeg/types";
import {
  startPresetTestSync,
  type PresetTestSourceHandlers,
} from "@/features/settings/presetTestStore";
import { settingsStore } from "@/features/settings/store";
import type { SettingsStoreState } from "@/features/settings/types";

/** The two stores that `subscribePresetTestSources` watches. A test passes its own. */
export interface PresetTestSourceStores {
  readonly settings: Pick<StoreApi<SettingsStoreState>, "getState" | "subscribe">;
  readonly ffmpeg: Pick<StoreApi<FfmpegStoreState>, "getState" | "subscribe">;
}

/** The revision of the settings document, or null before one loaded. */
function settingsRevision(state: SettingsStoreState): number | null {
  return state.settings?.revision ?? null;
}

/**
 * The binary of the last probe that finished, as a key of its path and its version, or null
 * while no probe has finished with a binary.
 *
 * A probe clears the paths when it starts, sets them with no version when Rust answers, and
 * adds the version with a later event of the same run. Only a finished probe gives the key, so
 * a probe of the binary in use never looks like a new binary and raises nothing.
 */
export function binaryKeyOf(
  state: Pick<FfmpegStoreState, "status" | "paths" | "version">,
): string | null {
  return state.status !== "ready" || state.paths === null || state.version === null
    ? null
    : JSON.stringify([state.paths.ffmpeg, state.version]);
}

/** True when the probe ended with no binary that it could use: FFmpeg is missing, or the probe failed. */
function binaryLost(state: Pick<FfmpegStoreState, "status">): boolean {
  return state.status === "missing" || state.status === "failed";
}

/**
 * Calls `handlers.binary` with the binary that is known now, and then `handlers.changed` when
 * the revision of the settings document changes and `handlers.binary` when the key of the
 * binary changes. Returns the function that stops it.
 *
 * The revision changes with each document that reached the disk: a save of this window, a
 * write of the other window, and a load. An optimistic save of this window publishes its
 * document with the old revision first, so a write reads the results once, when it lands.
 */
export function subscribePresetTestSources(
  handlers: PresetTestSourceHandlers,
  stores: PresetTestSourceStores = { settings: settingsStore, ffmpeg: ffmpegStore },
): () => void {
  let revision = settingsRevision(stores.settings.getState());
  let binary = binaryKeyOf(stores.ffmpeg.getState());
  handlers.binary(binary);
  const stopSettings = stores.settings.subscribe((state) => {
    const next = settingsRevision(state);
    if (next !== revision) {
      revision = next;
      handlers.changed();
    }
  });
  let lost = binaryLost(stores.ffmpeg.getState());
  const stopFfmpeg = stores.ffmpeg.subscribe((state) => {
    const next = binaryKeyOf(state);
    if (next !== binary) {
      binary = next;
      handlers.binary(next);
    }
    // A probe that ends with no binary leaves the results of the last one on screen: the key
    // only turned null, which raises nothing. So the results are read again. When FFmpeg is
    // missing, Rust finds no binary and the read clears them. After another failure Rust can
    // still find the binary, and the read gives its results back.
    const nowLost = binaryLost(state);
    if (nowLost && !lost) {
      handlers.changed();
    }
    lost = nowLost;
  });
  return () => {
    stopSettings();
    stopFfmpeg();
  };
}

/** Mounts `startPresetTestSync` with the two sources above for the life of the component. */
export function usePresetTestSync(): void {
  useEffect(
    () =>
      startPresetTestSync({
        subscribeSources: (handlers) => subscribePresetTestSources(handlers),
      }),
    [],
  );
}
