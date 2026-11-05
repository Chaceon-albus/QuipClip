import { describe, expect, it, vi } from "vitest";
import type { PreferenceStorage } from "@/i18n/types";
import {
  DEFAULT_PREVIEW_MUTED,
  DEFAULT_PREVIEW_VOLUME_PERCENT,
  MAX_PREVIEW_VOLUME_PERCENT,
  PREVIEW_MUTED_STORAGE_KEY,
  PREVIEW_VOLUME_STORAGE_KEY,
  createPreviewMutePreferenceStore,
  isPreviewSilent,
  normalizePreviewVolume,
  previewCueGain,
  previewElementVolume,
  readStoredPreviewMuted,
  readStoredPreviewVolume,
  writeStoredPreviewMuted,
  writeStoredPreviewVolume,
} from "./previewMutePreference";

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function throwingStorage(): PreferenceStorage {
  return {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
}

describe("preview mute preference storage", () => {
  it("stores the preference under a quipclip key next to the language preference", () => {
    expect(PREVIEW_MUTED_STORAGE_KEY).toBe("quipclip.preview_muted");
  });

  it("defaults to sound on", () => {
    expect(DEFAULT_PREVIEW_MUTED).toBe(false);
    expect(readStoredPreviewMuted(memoryStorage())).toBe(false);
  });

  it("reads the two stored values", () => {
    expect(
      readStoredPreviewMuted(memoryStorage({ [PREVIEW_MUTED_STORAGE_KEY]: "true" })),
    ).toBe(true);
    expect(
      readStoredPreviewMuted(memoryStorage({ [PREVIEW_MUTED_STORAGE_KEY]: "false" })),
    ).toBe(false);
  });

  it("reads an unknown stored value as the default", () => {
    for (const raw of ["", "1", "0", "True", "TRUE", " true", "muted", "yes"]) {
      const storage = memoryStorage({ [PREVIEW_MUTED_STORAGE_KEY]: raw });
      expect(readStoredPreviewMuted(storage)).toBe(false);
    }
  });

  it("reads the default when storage is missing or throws", () => {
    expect(readStoredPreviewMuted(null)).toBe(false);
    expect(readStoredPreviewMuted(throwingStorage())).toBe(false);
  });

  it("reads the default outside a browser when no storage is given", () => {
    expect(readStoredPreviewMuted()).toBe(false);
  });

  it("writes the preference, and ignores missing storage and write errors", () => {
    const storage = memoryStorage();
    writeStoredPreviewMuted(true, storage);
    expect(storage.data.get(PREVIEW_MUTED_STORAGE_KEY)).toBe("true");
    writeStoredPreviewMuted(false, storage);
    expect(storage.data.get(PREVIEW_MUTED_STORAGE_KEY)).toBe("false");
    expect(() => writeStoredPreviewMuted(true, null)).not.toThrow();
    expect(() => writeStoredPreviewMuted(true, throwingStorage())).not.toThrow();
  });
});

describe("preview volume storage", () => {
  it("stores the volume under a quipclip key next to the mute preference", () => {
    expect(PREVIEW_VOLUME_STORAGE_KEY).toBe("quipclip.preview_volume");
  });

  it("defaults to the full level, which is also the highest", () => {
    expect(DEFAULT_PREVIEW_VOLUME_PERCENT).toBe(100);
    expect(MAX_PREVIEW_VOLUME_PERCENT).toBe(100);
    expect(readStoredPreviewVolume(memoryStorage())).toBe(100);
  });

  it("reads every whole number of percent from 0 to 100", () => {
    for (const [raw, percent] of [
      ["0", 0],
      ["1", 1],
      ["55", 55],
      ["100", 100],
    ] as const) {
      const storage = memoryStorage({ [PREVIEW_VOLUME_STORAGE_KEY]: raw });
      expect(readStoredPreviewVolume(storage)).toBe(percent);
    }
  });

  it("reads an unknown stored value as the default", () => {
    for (const raw of [
      "",
      "101",
      "-1",
      "50.5",
      "0.5",
      "050",
      " 50",
      "50%",
      "1e2",
      "NaN",
    ]) {
      const storage = memoryStorage({ [PREVIEW_VOLUME_STORAGE_KEY]: raw });
      expect(readStoredPreviewVolume(storage)).toBe(100);
    }
  });

  it("reads the default when storage is missing or throws", () => {
    expect(readStoredPreviewVolume(null)).toBe(100);
    expect(readStoredPreviewVolume(throwingStorage())).toBe(100);
    expect(readStoredPreviewVolume()).toBe(100);
  });

  it("writes the volume, and ignores missing storage and write errors", () => {
    const storage = memoryStorage();
    writeStoredPreviewVolume(35, storage);
    expect(storage.data.get(PREVIEW_VOLUME_STORAGE_KEY)).toBe("35");
    expect(readStoredPreviewVolume(storage)).toBe(35);
    expect(() => writeStoredPreviewVolume(35, null)).not.toThrow();
    expect(() => writeStoredPreviewVolume(35, throwingStorage())).not.toThrow();
  });
});

describe("preview audio level", () => {
  it("rounds and holds a volume from 0 to 100, and refuses a value that is not finite", () => {
    expect(normalizePreviewVolume(42.4)).toBe(42);
    expect(normalizePreviewVolume(42.5)).toBe(43);
    expect(normalizePreviewVolume(-5)).toBe(0);
    expect(normalizePreviewVolume(250)).toBe(100);
    expect(normalizePreviewVolume(Number.NaN)).toBeNull();
    expect(normalizePreviewVolume(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizePreviewVolume("50" as unknown as number)).toBeNull();
  });

  it("is silent while mute is on or while the volume is 0", () => {
    expect(isPreviewSilent({ muted: false, volumePercent: 60 })).toBe(false);
    expect(isPreviewSilent({ muted: true, volumePercent: 60 })).toBe(true);
    expect(isPreviewSilent({ muted: false, volumePercent: 0 })).toBe(true);
  });

  it("gives the element its volume, and the cue a gain that is 0 while mute is on", () => {
    expect(previewElementVolume(100)).toBe(1);
    expect(previewElementVolume(25)).toBe(0.25);
    expect(previewElementVolume(0)).toBe(0);
    expect(previewCueGain({ muted: false, volumePercent: 25 })).toBe(0.25);
    expect(previewCueGain({ muted: true, volumePercent: 25 })).toBe(0);
  });
});

describe("createPreviewMutePreferenceStore", () => {
  it("starts with the stored preference, before any action runs", () => {
    const storage = memoryStorage({ [PREVIEW_MUTED_STORAGE_KEY]: "true" });
    expect(createPreviewMutePreferenceStore({ storage }).getState().muted).toBe(true);
    expect(
      createPreviewMutePreferenceStore({ storage: memoryStorage() }).getState().muted,
    ).toBe(false);
  });

  it("applies and persists a change at once", () => {
    const storage = memoryStorage();
    const store = createPreviewMutePreferenceStore({ storage });
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().setMuted(true);

    expect(store.getState().muted).toBe(true);
    expect(storage.data.get(PREVIEW_MUTED_STORAGE_KEY)).toBe("true");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("toggles between the two values and persists each one", () => {
    const storage = memoryStorage();
    const store = createPreviewMutePreferenceStore({ storage });

    store.getState().toggleMuted();
    expect(store.getState().muted).toBe(true);
    expect(storage.data.get(PREVIEW_MUTED_STORAGE_KEY)).toBe("true");

    store.getState().toggleMuted();
    expect(store.getState().muted).toBe(false);
    expect(storage.data.get(PREVIEW_MUTED_STORAGE_KEY)).toBe("false");
  });

  it("keeps the preference across a restart", () => {
    const storage = memoryStorage();
    createPreviewMutePreferenceStore({ storage }).getState().setMuted(true);
    expect(createPreviewMutePreferenceStore({ storage }).getState().muted).toBe(true);

    createPreviewMutePreferenceStore({ storage }).getState().toggleMuted();
    expect(createPreviewMutePreferenceStore({ storage }).getState().muted).toBe(false);
  });

  it("does not notify subscribers when the preference does not change", () => {
    const store = createPreviewMutePreferenceStore({ storage: memoryStorage() });
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().setMuted(false);

    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores a value that is not a boolean", () => {
    const storage = memoryStorage();
    const store = createPreviewMutePreferenceStore({ storage });

    store.getState().setMuted("true" as unknown as boolean);

    expect(store.getState().muted).toBe(false);
    expect(storage.data.has(PREVIEW_MUTED_STORAGE_KEY)).toBe(false);
  });

  it("still applies a change for the session when storage cannot be written", () => {
    const store = createPreviewMutePreferenceStore({ storage: throwingStorage() });
    expect(store.getState().muted).toBe(false);

    store.getState().setMuted(true);
    expect(store.getState().muted).toBe(true);

    store.getState().setVolumePercent(40);
    expect(store.getState().volumePercent).toBe(40);
  });

  it("starts with the stored volume, and keeps it across a restart", () => {
    const storage = memoryStorage({ [PREVIEW_VOLUME_STORAGE_KEY]: "30" });
    const store = createPreviewMutePreferenceStore({ storage });
    expect(store.getState().volumePercent).toBe(30);

    store.getState().setVolumePercent(65);

    expect(storage.data.get(PREVIEW_VOLUME_STORAGE_KEY)).toBe("65");
    expect(createPreviewMutePreferenceStore({ storage }).getState().volumePercent).toBe(
      65,
    );
  });

  it("stores a rounded volume, and ignores a value that is not finite", () => {
    const storage = memoryStorage();
    const store = createPreviewMutePreferenceStore({ storage });

    store.getState().setVolumePercent(33.7);
    expect(store.getState().volumePercent).toBe(34);

    store.getState().setVolumePercent(Number.NaN);
    expect(store.getState().volumePercent).toBe(34);
    expect(storage.data.get(PREVIEW_VOLUME_STORAGE_KEY)).toBe("34");
  });

  it("keeps the volume while mute is on, so unmute gives back the same level", () => {
    const storage = memoryStorage();
    const store = createPreviewMutePreferenceStore({ storage });
    store.getState().setVolumePercent(45);

    store.getState().toggleMuted();
    expect(store.getState()).toMatchObject({ muted: true, volumePercent: 45 });

    store.getState().toggleMuted();
    expect(store.getState()).toMatchObject({ muted: false, volumePercent: 45 });
  });

  it("turns mute off when the volume moves above 0", () => {
    const storage = memoryStorage({ [PREVIEW_MUTED_STORAGE_KEY]: "true" });
    const store = createPreviewMutePreferenceStore({ storage });
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().setVolumePercent(20);

    expect(store.getState()).toMatchObject({ muted: false, volumePercent: 20 });
    expect(storage.data.get(PREVIEW_MUTED_STORAGE_KEY)).toBe("false");
    // One update carries both values.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps mute on when the volume moves to 0", () => {
    const storage = memoryStorage({ [PREVIEW_MUTED_STORAGE_KEY]: "true" });
    const store = createPreviewMutePreferenceStore({ storage });

    store.getState().setVolumePercent(0);

    expect(store.getState()).toMatchObject({ muted: true, volumePercent: 0 });
  });

  it("ends the silence of a volume of 0 at the default volume", () => {
    const storage = memoryStorage();
    const store = createPreviewMutePreferenceStore({ storage });
    store.getState().setVolumePercent(0);
    expect(store.getState().muted).toBe(false);

    store.getState().toggleMuted();
    expect(store.getState()).toMatchObject({ muted: false, volumePercent: 100 });
    expect(storage.data.get(PREVIEW_VOLUME_STORAGE_KEY)).toBe("100");

    // Mute on at a volume of 0 ends the same way, in one update.
    store.getState().setMuted(true);
    store.getState().setVolumePercent(0);
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().toggleMuted();
    expect(store.getState()).toMatchObject({ muted: false, volumePercent: 100 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify subscribers when the volume does not change", () => {
    const store = createPreviewMutePreferenceStore({ storage: memoryStorage() });
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().setVolumePercent(100);

    expect(listener).not.toHaveBeenCalled();
  });
});
