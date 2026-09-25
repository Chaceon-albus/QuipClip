import { describe, expect, it, vi } from "vitest";
import type { PreferenceStorage } from "@/i18n/types";
import {
  DEFAULT_TIMELINE_HEIGHT_PX,
  MAX_STORED_TIMELINE_HEIGHT_PX,
  MIN_TIMELINE_HEIGHT_PX,
  TIMELINE_HEIGHT_STORAGE_KEY,
  createTimelineHeightPreferenceStore,
  normalizeTimelineHeight,
  readStoredTimelineHeight,
  writeStoredTimelineHeight,
} from "./timelineHeightPreference";

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

describe("timeline height preference storage", () => {
  it("stores the preference under a quipclip key next to the language preference", () => {
    expect(TIMELINE_HEIGHT_STORAGE_KEY).toBe("quipclip.timeline_height");
  });

  it("defaults to the fixed height of earlier versions, above the minimum", () => {
    expect(DEFAULT_TIMELINE_HEIGHT_PX).toBe(180);
    expect(MIN_TIMELINE_HEIGHT_PX).toBe(108);
    expect(DEFAULT_TIMELINE_HEIGHT_PX).toBeGreaterThan(MIN_TIMELINE_HEIGHT_PX);
    expect(readStoredTimelineHeight(memoryStorage())).toBe(180);
  });

  it("reads a stored whole number of pixels in range", () => {
    for (const [raw, height] of [
      ["108", 108],
      ["180", 180],
      ["260", 260],
      ["0400", 400],
      [String(MAX_STORED_TIMELINE_HEIGHT_PX), MAX_STORED_TIMELINE_HEIGHT_PX],
    ] as const) {
      const storage = memoryStorage({ [TIMELINE_HEIGHT_STORAGE_KEY]: raw });
      expect(readStoredTimelineHeight(storage)).toBe(height);
    }
  });

  it("reads a bad stored value as the default", () => {
    for (const raw of [
      "",
      " ",
      "abc",
      "180px",
      " 180",
      "180 ",
      "+180",
      "-180",
      "180.5",
      "1e3",
      "0x100",
      "NaN",
      "Infinity",
      "null",
      "107",
      "0",
      String(MAX_STORED_TIMELINE_HEIGHT_PX + 1),
      "123456",
    ]) {
      const storage = memoryStorage({ [TIMELINE_HEIGHT_STORAGE_KEY]: raw });
      expect(readStoredTimelineHeight(storage)).toBe(DEFAULT_TIMELINE_HEIGHT_PX);
    }
  });

  it("reads the default when storage is missing or throws", () => {
    expect(readStoredTimelineHeight(null)).toBe(DEFAULT_TIMELINE_HEIGHT_PX);
    expect(readStoredTimelineHeight(throwingStorage())).toBe(
      DEFAULT_TIMELINE_HEIGHT_PX,
    );
  });

  it("reads the default outside a browser when no storage is given", () => {
    expect(readStoredTimelineHeight()).toBe(DEFAULT_TIMELINE_HEIGHT_PX);
  });

  it("writes the height as decimal digits, and ignores missing storage and write errors", () => {
    const storage = memoryStorage();
    writeStoredTimelineHeight(260, storage);
    expect(storage.data.get(TIMELINE_HEIGHT_STORAGE_KEY)).toBe("260");
    expect(readStoredTimelineHeight(storage)).toBe(260);
    expect(() => writeStoredTimelineHeight(260, null)).not.toThrow();
    expect(() => writeStoredTimelineHeight(260, throwingStorage())).not.toThrow();
  });
});

describe("normalizeTimelineHeight", () => {
  it("rounds a height in range to a whole pixel", () => {
    expect(normalizeTimelineHeight(180)).toBe(180);
    expect(normalizeTimelineHeight(200.4)).toBe(200);
    expect(normalizeTimelineHeight(200.5)).toBe(201);
    expect(normalizeTimelineHeight(107.5)).toBe(108);
  });

  it("refuses a height out of range or not a number", () => {
    expect(normalizeTimelineHeight(107)).toBeNull();
    expect(normalizeTimelineHeight(-1)).toBeNull();
    expect(normalizeTimelineHeight(MAX_STORED_TIMELINE_HEIGHT_PX + 1)).toBeNull();
    expect(normalizeTimelineHeight(Number.NaN)).toBeNull();
    expect(normalizeTimelineHeight(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeTimelineHeight("200")).toBeNull();
    expect(normalizeTimelineHeight(null)).toBeNull();
  });
});

describe("createTimelineHeightPreferenceStore", () => {
  it("starts with the stored height", () => {
    const storage = memoryStorage({ [TIMELINE_HEIGHT_STORAGE_KEY]: "300" });
    expect(createTimelineHeightPreferenceStore({ storage }).getState().heightPx).toBe(
      300,
    );
    expect(
      createTimelineHeightPreferenceStore({ storage: memoryStorage() }).getState()
        .heightPx,
    ).toBe(DEFAULT_TIMELINE_HEIGHT_PX);
  });

  it("applies and persists a change at once", () => {
    const storage = memoryStorage();
    const store = createTimelineHeightPreferenceStore({ storage });
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().setHeight(244);

    expect(store.getState().heightPx).toBe(244);
    expect(storage.data.get(TIMELINE_HEIGHT_STORAGE_KEY)).toBe("244");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stores a fraction as a whole pixel", () => {
    const storage = memoryStorage();
    const store = createTimelineHeightPreferenceStore({ storage });

    store.getState().setHeight(212.6);

    expect(store.getState().heightPx).toBe(213);
    expect(storage.data.get(TIMELINE_HEIGHT_STORAGE_KEY)).toBe("213");
  });

  it("keeps the height across a restart", () => {
    const storage = memoryStorage();
    createTimelineHeightPreferenceStore({ storage }).getState().setHeight(320);
    expect(createTimelineHeightPreferenceStore({ storage }).getState().heightPx).toBe(
      320,
    );
  });

  it("does not notify subscribers when the height does not change", () => {
    const store = createTimelineHeightPreferenceStore({ storage: memoryStorage() });
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().setHeight(DEFAULT_TIMELINE_HEIGHT_PX);

    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores a height out of range or not a number", () => {
    const storage = memoryStorage();
    const store = createTimelineHeightPreferenceStore({ storage });

    store.getState().setHeight(50);
    store.getState().setHeight(Number.NaN);
    store.getState().setHeight("300" as unknown as number);

    expect(store.getState().heightPx).toBe(DEFAULT_TIMELINE_HEIGHT_PX);
    expect(storage.data.has(TIMELINE_HEIGHT_STORAGE_KEY)).toBe(false);
  });

  it("still applies a change for the session when storage cannot be written", () => {
    const store = createTimelineHeightPreferenceStore({ storage: throwingStorage() });
    expect(store.getState().heightPx).toBe(DEFAULT_TIMELINE_HEIGHT_PX);

    store.getState().setHeight(260);

    expect(store.getState().heightPx).toBe(260);
  });
});
