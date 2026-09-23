import { describe, expect, it, vi } from "vitest";
import type { PreferenceStorage } from "@/i18n/types";
import type { ThemePreference } from "@/lib/theme";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_PREFERENCE_STORAGE_KEY,
  createThemePreferenceStore,
  readStoredThemePreference,
  writeStoredThemePreference,
} from "./themePreference";

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

describe("theme preference storage", () => {
  it("stores the preference under a quipclip key next to the language preference", () => {
    expect(THEME_PREFERENCE_STORAGE_KEY).toBe("quipclip.theme_preference");
  });

  it("defaults to system", () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe("system");
    expect(readStoredThemePreference(memoryStorage())).toBe("system");
  });

  it("reads each stored preference", () => {
    for (const value of ["system", "light", "dark"] as const) {
      const storage = memoryStorage({ [THEME_PREFERENCE_STORAGE_KEY]: value });
      expect(readStoredThemePreference(storage)).toBe(value);
    }
  });

  it("reads an unknown stored value as the default", () => {
    for (const raw of ["", "auto", "Dark", "LIGHT", " dark", "true"]) {
      const storage = memoryStorage({ [THEME_PREFERENCE_STORAGE_KEY]: raw });
      expect(readStoredThemePreference(storage)).toBe("system");
    }
  });

  it("reads the default when storage is missing or throws", () => {
    expect(readStoredThemePreference(null)).toBe("system");
    expect(readStoredThemePreference(throwingStorage())).toBe("system");
  });

  it("reads the default outside a browser when no storage is given", () => {
    expect(readStoredThemePreference()).toBe("system");
  });

  it("writes the preference, and ignores missing storage and write errors", () => {
    const storage = memoryStorage();
    writeStoredThemePreference("dark", storage);
    expect(storage.data.get(THEME_PREFERENCE_STORAGE_KEY)).toBe("dark");
    expect(() => writeStoredThemePreference("light", null)).not.toThrow();
    expect(() => writeStoredThemePreference("light", throwingStorage())).not.toThrow();
  });
});

describe("createThemePreferenceStore", () => {
  it("starts with the stored preference", () => {
    const storage = memoryStorage({ [THEME_PREFERENCE_STORAGE_KEY]: "light" });
    expect(createThemePreferenceStore({ storage }).getState().preference).toBe("light");
    expect(
      createThemePreferenceStore({ storage: memoryStorage() }).getState().preference,
    ).toBe("system");
  });

  it("applies and persists a change at once", () => {
    const storage = memoryStorage();
    const store = createThemePreferenceStore({ storage });
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().setPreference("dark");

    expect(store.getState().preference).toBe("dark");
    expect(storage.data.get(THEME_PREFERENCE_STORAGE_KEY)).toBe("dark");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the preference across a restart, and returns to system", () => {
    const storage = memoryStorage();
    createThemePreferenceStore({ storage }).getState().setPreference("dark");
    expect(createThemePreferenceStore({ storage }).getState().preference).toBe("dark");

    createThemePreferenceStore({ storage }).getState().setPreference("system");
    expect(createThemePreferenceStore({ storage }).getState().preference).toBe(
      "system",
    );
    expect(storage.data.get(THEME_PREFERENCE_STORAGE_KEY)).toBe("system");
  });

  it("does not notify subscribers when the preference does not change", () => {
    const store = createThemePreferenceStore({ storage: memoryStorage() });
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().setPreference("system");

    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores a value that is not a preference", () => {
    const storage = memoryStorage();
    const store = createThemePreferenceStore({ storage });

    store.getState().setPreference("auto" as unknown as ThemePreference);

    expect(store.getState().preference).toBe("system");
    expect(storage.data.has(THEME_PREFERENCE_STORAGE_KEY)).toBe(false);
  });

  it("still applies a change for the session when storage cannot be written", () => {
    const store = createThemePreferenceStore({ storage: throwingStorage() });
    expect(store.getState().preference).toBe("system");

    store.getState().setPreference("light");

    expect(store.getState().preference).toBe("light");
  });
});
