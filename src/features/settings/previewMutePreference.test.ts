import { describe, expect, it, vi } from "vitest";
import type { PreferenceStorage } from "@/i18n/types";
import {
  DEFAULT_PREVIEW_MUTED,
  PREVIEW_MUTED_STORAGE_KEY,
  createPreviewMutePreferenceStore,
  readStoredPreviewMuted,
  writeStoredPreviewMuted,
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
  });
});
