import { describe, expect, it, vi } from "vitest";
import type { PreferenceStorage } from "@/i18n/types";
import {
  DEFAULT_TIMECODE_FORMAT,
  TIMECODE_FORMAT_STORAGE_KEY,
  createTimecodePreferenceStore,
  isTimecodeFormat,
  readStoredTimecodeFormat,
  writeStoredTimecodeFormat,
} from "./timecodePreference";

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

describe("timecode preference storage", () => {
  it("stores the preference under a quipclip key next to the language preference", () => {
    expect(TIMECODE_FORMAT_STORAGE_KEY).toBe("quipclip.timecode_format");
  });

  it("defaults to frames", () => {
    expect(DEFAULT_TIMECODE_FORMAT).toBe("frames");
    expect(readStoredTimecodeFormat(memoryStorage())).toBe("frames");
  });

  it("reads a stored milliseconds preference", () => {
    const storage = memoryStorage({ [TIMECODE_FORMAT_STORAGE_KEY]: "milliseconds" });
    expect(readStoredTimecodeFormat(storage)).toBe("milliseconds");
  });

  it("reads an unknown stored value as the default", () => {
    for (const raw of ["", "seconds", "Frames", "MILLISECONDS", " frames"]) {
      const storage = memoryStorage({ [TIMECODE_FORMAT_STORAGE_KEY]: raw });
      expect(readStoredTimecodeFormat(storage)).toBe("frames");
    }
  });

  it("reads the default when storage is missing or throws", () => {
    expect(readStoredTimecodeFormat(null)).toBe("frames");
    expect(readStoredTimecodeFormat(throwingStorage())).toBe("frames");
  });

  it("reads the default outside a browser when no storage is given", () => {
    expect(readStoredTimecodeFormat()).toBe("frames");
  });

  it("writes the preference, and ignores missing storage and write errors", () => {
    const storage = memoryStorage();
    writeStoredTimecodeFormat("milliseconds", storage);
    expect(storage.data.get(TIMECODE_FORMAT_STORAGE_KEY)).toBe("milliseconds");
    expect(() => writeStoredTimecodeFormat("frames", null)).not.toThrow();
    expect(() => writeStoredTimecodeFormat("frames", throwingStorage())).not.toThrow();
  });

  it("recognises only the two format names", () => {
    expect(isTimecodeFormat("frames")).toBe(true);
    expect(isTimecodeFormat("milliseconds")).toBe(true);
    expect(isTimecodeFormat("system")).toBe(false);
    expect(isTimecodeFormat(null)).toBe(false);
    expect(isTimecodeFormat(1)).toBe(false);
  });
});

describe("createTimecodePreferenceStore", () => {
  it("starts with the stored preference", () => {
    const storage = memoryStorage({ [TIMECODE_FORMAT_STORAGE_KEY]: "milliseconds" });
    expect(createTimecodePreferenceStore({ storage }).getState().format).toBe(
      "milliseconds",
    );
    expect(
      createTimecodePreferenceStore({ storage: memoryStorage() }).getState().format,
    ).toBe("frames");
  });

  it("applies and persists a change at once", () => {
    const storage = memoryStorage();
    const store = createTimecodePreferenceStore({ storage });
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().setFormat("milliseconds");

    expect(store.getState().format).toBe("milliseconds");
    expect(storage.data.get(TIMECODE_FORMAT_STORAGE_KEY)).toBe("milliseconds");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the preference across a restart", () => {
    const storage = memoryStorage();
    createTimecodePreferenceStore({ storage }).getState().setFormat("milliseconds");
    expect(createTimecodePreferenceStore({ storage }).getState().format).toBe(
      "milliseconds",
    );

    createTimecodePreferenceStore({ storage }).getState().setFormat("frames");
    expect(createTimecodePreferenceStore({ storage }).getState().format).toBe("frames");
  });

  it("does not notify subscribers when the format does not change", () => {
    const store = createTimecodePreferenceStore({ storage: memoryStorage() });
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().setFormat("frames");

    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores a value that is not a format", () => {
    const storage = memoryStorage();
    const store = createTimecodePreferenceStore({ storage });

    store.getState().setFormat("seconds" as unknown as "frames");

    expect(store.getState().format).toBe("frames");
    expect(storage.data.has(TIMECODE_FORMAT_STORAGE_KEY)).toBe(false);
  });

  it("still applies a change for the session when storage cannot be written", () => {
    const store = createTimecodePreferenceStore({ storage: throwingStorage() });
    expect(store.getState().format).toBe("frames");

    store.getState().setFormat("milliseconds");

    expect(store.getState().format).toBe("milliseconds");
  });
});
