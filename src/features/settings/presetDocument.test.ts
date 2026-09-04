import { describe, expect, it } from "vitest";

import {
  addPreset,
  createPresetDraft,
  DEFAULT_CUSTOM_FRAME_RATE,
  DEFAULT_CUSTOM_RESOLUTION,
  deletePreset,
  findPreset,
  setActivePreset,
  updatePreset,
} from "./presetDocument";
import type { Preset, Settings } from "./types";

/**
 * Builds a preset for tests. Every field carries a deterministic default so a test overrides
 * only the field it cares about.
 */
function createPreset(id: string, overrides: Partial<Preset> = {}): Preset {
  return {
    id,
    name: `Preset ${id}`,
    container: "mp4",
    videoEncoder: "libx264",
    audioEncoder: "aac",
    quality: { kind: "crf", value: 20 },
    resolution: "source",
    frameRate: "source",
    ...overrides,
  };
}

/**
 * Builds a settings document for tests. `ffmpegPath` and `activePresetId` are omitted
 * entirely unless an override supplies them, matching ADR 013's "absent when unset" rule.
 */
function createSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    schemaVersion: 1,
    presets: [],
    ...overrides,
  };
}

/**
 * Recursively freezes a value and everything it references, so a function under test throws
 * (in strict-mode ES modules) if it ever tries to mutate the input in place.
 */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item: unknown) => deepFreeze(item));
    return Object.freeze(value) as T;
  }
  if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((item) => deepFreeze(item));
    return Object.freeze(value);
  }
  return value;
}

describe("createPresetDraft", () => {
  it("returns the documented defaults and uses the injected id and name", () => {
    const draft = createPresetDraft("new-preset", "New Preset");
    expect(draft).toStrictEqual({
      id: "new-preset",
      name: "New Preset",
      container: "mp4",
      videoEncoder: "libx264",
      audioEncoder: "aac",
      quality: { kind: "crf", value: 20 },
      resolution: "source",
      frameRate: "source",
    });
  });
});

describe("DEFAULT_CUSTOM_RESOLUTION and DEFAULT_CUSTOM_FRAME_RATE", () => {
  it("expose the documented literal defaults for switching from source to custom", () => {
    expect(DEFAULT_CUSTOM_RESOLUTION).toStrictEqual({ w: 1920, h: 1080 });
    expect(DEFAULT_CUSTOM_FRAME_RATE).toStrictEqual({ n: 30, d: 1 });
  });
});

describe("findPreset", () => {
  it("finds the preset with a matching id", () => {
    const a = createPreset("a");
    const b = createPreset("b");
    const settings = createSettings({ presets: [a, b] });
    expect(findPreset(settings, "b")).toStrictEqual(b);
  });

  it("returns undefined when no preset matches", () => {
    const settings = createSettings({ presets: [createPreset("a")] });
    expect(findPreset(settings, "missing")).toBeUndefined();
  });
});

describe("addPreset", () => {
  it("appends at the end and preserves order", () => {
    const a = createPreset("a");
    const b = createPreset("b");
    const settings = createSettings({ presets: [a, b] });
    const c = createPreset("c");

    const result = addPreset(settings, c);

    expect(result).toStrictEqual(createSettings({ presets: [a, b, c] }));
  });

  it("preserves ffmpegPath when present", () => {
    const settings = createSettings({ ffmpegPath: "/opt/homebrew/bin", presets: [] });

    const result = addPreset(settings, createPreset("a"));

    expect(result).toStrictEqual(
      createSettings({ ffmpegPath: "/opt/homebrew/bin", presets: [createPreset("a")] }),
    );
  });

  it("keeps ffmpegPath absent when absent", () => {
    const settings = createSettings({ presets: [] });

    const result = addPreset(settings, createPreset("a"));

    expect("ffmpegPath" in result).toBe(false);
  });

  it("does not enforce MAX_PRESETS and appends past 100 entries", () => {
    const many = Array.from({ length: 101 }, (_, i) => createPreset(`existing-${i}`));
    const settings = createSettings({ presets: many });

    const result = addPreset(settings, createPreset("one-oh-two"));

    expect(result.presets).toHaveLength(102);
    expect(result.presets[result.presets.length - 1]).toStrictEqual(
      createPreset("one-oh-two"),
    );
  });

  it("does not mutate a frozen input", () => {
    const original = createSettings({ presets: [createPreset("a")] });
    const frozen = deepFreeze(createSettings({ presets: [createPreset("a")] }));

    expect(() => addPreset(frozen, createPreset("b"))).not.toThrow();
    expect(frozen).toStrictEqual(original);
  });
});

describe("updatePreset", () => {
  it("replaces the preset with a matching id in place, preserving order", () => {
    const a = createPreset("a");
    const b = createPreset("b");
    const c = createPreset("c");
    const settings = createSettings({ presets: [a, b, c] });
    const updatedB = createPreset("b", { name: "Renamed B" });

    const result = updatePreset(settings, updatedB);

    expect(result).toStrictEqual(createSettings({ presets: [a, updatedB, c] }));
  });

  it("returns a document with the same values when no preset matches that id", () => {
    const a = createPreset("a");
    const settings = createSettings({ presets: [a] });
    const stranger = createPreset("does-not-exist");

    const result = updatePreset(settings, stranger);

    expect(result).toStrictEqual(createSettings({ presets: [a] }));
  });

  it("preserves ffmpegPath and activePresetId", () => {
    const a = createPreset("a");
    const settings = createSettings({
      ffmpegPath: "/opt/homebrew/bin",
      presets: [a],
      activePresetId: "a",
    });
    const updatedA = createPreset("a", { name: "Renamed A" });

    const result = updatePreset(settings, updatedA);

    expect(result).toStrictEqual(
      createSettings({
        ffmpegPath: "/opt/homebrew/bin",
        presets: [updatedA],
        activePresetId: "a",
      }),
    );
  });

  it("does not mutate a frozen input", () => {
    const original = createSettings({ presets: [createPreset("a")] });
    const frozen = deepFreeze(createSettings({ presets: [createPreset("a")] }));

    expect(() =>
      updatePreset(frozen, createPreset("a", { name: "New" })),
    ).not.toThrow();
    expect(frozen).toStrictEqual(original);
  });
});

describe("deletePreset", () => {
  it("deletes the active preset from the middle of three, re-pointing to the preset that now occupies that index", () => {
    const a = createPreset("a");
    const b = createPreset("b");
    const c = createPreset("c");
    const settings = createSettings({ presets: [a, b, c], activePresetId: "b" });

    const result = deletePreset(settings, "b");

    expect(result).toStrictEqual(
      createSettings({ presets: [a, c], activePresetId: "c" }),
    );
    // The invariant Rust enforces: a present activePresetId must name a preset that exists.
    expect(result.presets.some((preset) => preset.id === result.activePresetId)).toBe(
      true,
    );
  });

  it("deletes the active preset when it is last, re-pointing to the new last preset", () => {
    const a = createPreset("a");
    const b = createPreset("b");
    const c = createPreset("c");
    const settings = createSettings({ presets: [a, b, c], activePresetId: "c" });

    const result = deletePreset(settings, "c");

    expect(result).toStrictEqual(
      createSettings({ presets: [a, b], activePresetId: "b" }),
    );
    expect(result.presets.some((preset) => preset.id === result.activePresetId)).toBe(
      true,
    );
  });

  it("deletes the only preset when it is active, leaving presets empty and activePresetId absent", () => {
    const a = createPreset("a");
    const settings = createSettings({ presets: [a], activePresetId: "a" });

    const result = deletePreset(settings, "a");

    expect(result).toStrictEqual(createSettings({ presets: [] }));
    expect(result.presets).toHaveLength(0);
    expect("activePresetId" in result).toBe(false);
  });

  it("deletes a non-active preset, leaving activePresetId byte-identical", () => {
    const a = createPreset("a");
    const b = createPreset("b");
    const c = createPreset("c");
    const settings = createSettings({ presets: [a, b, c], activePresetId: "a" });

    const result = deletePreset(settings, "c");

    expect(result).toStrictEqual(
      createSettings({ presets: [a, b], activePresetId: "a" }),
    );
    expect(result.activePresetId).toBe("a");
    expect(result.presets.some((preset) => preset.id === result.activePresetId)).toBe(
      true,
    );
  });

  it("deletes an id that does not exist, returning an unchanged document", () => {
    const a = createPreset("a");
    const b = createPreset("b");
    const settings = createSettings({ presets: [a, b], activePresetId: "a" });

    const result = deletePreset(settings, "does-not-exist");

    expect(result).toStrictEqual(
      createSettings({ presets: [a, b], activePresetId: "a" }),
    );
    expect(
      result.activePresetId === undefined ||
        result.presets.some((preset) => preset.id === result.activePresetId),
    ).toBe(true);
  });

  it("deletes a preset when no preset is active, leaving activePresetId absent", () => {
    const a = createPreset("a");
    const b = createPreset("b");
    const settings = createSettings({ presets: [a, b] });

    const result = deletePreset(settings, "a");

    expect(result).toStrictEqual(createSettings({ presets: [b] }));
    expect("activePresetId" in result).toBe(false);
  });

  it("preserves ffmpegPath through every delete variant", () => {
    const a = createPreset("a");
    const b = createPreset("b");
    const settings = createSettings({
      ffmpegPath: "/opt/homebrew/bin",
      presets: [a, b],
      activePresetId: "a",
    });

    const result = deletePreset(settings, "a");

    expect(result).toStrictEqual(
      createSettings({
        ffmpegPath: "/opt/homebrew/bin",
        presets: [b],
        activePresetId: "b",
      }),
    );
  });

  it("keeps ffmpegPath absent when absent", () => {
    const a = createPreset("a");
    const settings = createSettings({ presets: [a], activePresetId: "a" });

    const result = deletePreset(settings, "a");

    expect("ffmpegPath" in result).toBe(false);
  });

  it("does not mutate a frozen input", () => {
    const original = createSettings({
      presets: [createPreset("a"), createPreset("b")],
      activePresetId: "a",
    });
    const frozen = deepFreeze(
      createSettings({
        presets: [createPreset("a"), createPreset("b")],
        activePresetId: "a",
      }),
    );

    expect(() => deletePreset(frozen, "b")).not.toThrow();
    expect(frozen).toStrictEqual(original);
  });
});

describe("setActivePreset", () => {
  it("removes the activePresetId key when set to null", () => {
    const a = createPreset("a");
    const settings = createSettings({ presets: [a], activePresetId: "a" });

    const result = setActivePreset(settings, null);

    expect(result).toStrictEqual(createSettings({ presets: [a] }));
    expect("activePresetId" in result).toBe(false);
  });

  it("sets the activePresetId key to the given id", () => {
    const a = createPreset("a");
    const b = createPreset("b");
    const settings = createSettings({ presets: [a, b] });

    const result = setActivePreset(settings, "b");

    expect(result).toStrictEqual(
      createSettings({ presets: [a, b], activePresetId: "b" }),
    );
  });

  it("preserves ffmpegPath when present and absent when absent", () => {
    const a = createPreset("a");
    const withPath = createSettings({ ffmpegPath: "/opt/homebrew/bin", presets: [a] });
    const withoutPath = createSettings({ presets: [a] });

    const resultWithPath = setActivePreset(withPath, "a");
    const resultWithoutPath = setActivePreset(withoutPath, "a");

    expect(resultWithPath.ffmpegPath).toBe("/opt/homebrew/bin");
    expect("ffmpegPath" in resultWithoutPath).toBe(false);
  });

  it("does not mutate a frozen input", () => {
    const original = createSettings({
      presets: [createPreset("a")],
      activePresetId: "a",
    });
    const frozen = deepFreeze(
      createSettings({ presets: [createPreset("a")], activePresetId: "a" }),
    );

    expect(() => setActivePreset(frozen, null)).not.toThrow();
    expect(frozen).toStrictEqual(original);
  });

  it("leaves activePresetId unchanged when the given id names no preset", () => {
    const a = createPreset("a");
    const b = createPreset("b");
    const settings = createSettings({ presets: [a, b], activePresetId: "a" });

    const result = setActivePreset(settings, "does-not-exist");

    expect(result).toStrictEqual(
      createSettings({ presets: [a, b], activePresetId: "a" }),
    );
    expect(result.activePresetId).toBe("a");
  });

  it("leaves activePresetId absent when the given id names no preset and none was active", () => {
    const a = createPreset("a");
    const settings = createSettings({ presets: [a] });

    const result = setActivePreset(settings, "does-not-exist");

    expect(result).toStrictEqual(createSettings({ presets: [a] }));
    expect("activePresetId" in result).toBe(false);
  });
});

describe("schemaVersion", () => {
  it("is carried through unchanged by every operation", () => {
    const settings = createSettings({
      presets: [createPreset("a")],
      activePresetId: "a",
    });

    expect(addPreset(settings, createPreset("b")).schemaVersion).toBe(1);
    expect(updatePreset(settings, createPreset("a")).schemaVersion).toBe(1);
    expect(deletePreset(settings, "a").schemaVersion).toBe(1);
    expect(setActivePreset(settings, null).schemaVersion).toBe(1);
  });
});

describe("referential freshness", () => {
  /**
   * Zustand selectors and React re-renders key on referential identity, not deep equality.
   * The deep-freeze tests above prove no mutation occurs; they do not prove a fresh object
   * comes back. Every path here -- including every no-op path, where it would be easy to
   * shortcut by returning the input as-is -- must still return a new document and a new
   * `presets` array.
   */

  it("addPreset returns a fresh document and a fresh presets array", () => {
    const settings = createSettings({ presets: [createPreset("a")] });

    const result = addPreset(settings, createPreset("b"));

    expect(result).not.toBe(settings);
    expect(result.presets).not.toBe(settings.presets);
  });

  it("updatePreset returns a fresh document and a fresh presets array on a match", () => {
    const a = createPreset("a");
    const settings = createSettings({ presets: [a] });

    const result = updatePreset(settings, createPreset("a", { name: "New" }));

    expect(result).not.toBe(settings);
    expect(result.presets).not.toBe(settings.presets);
  });

  it("updatePreset returns a fresh document and a fresh presets array on the no-op path", () => {
    const a = createPreset("a");
    const settings = createSettings({ presets: [a] });

    const result = updatePreset(settings, createPreset("does-not-exist"));

    expect(result).not.toBe(settings);
    expect(result.presets).not.toBe(settings.presets);
  });

  it("deletePreset returns a fresh document and a fresh presets array on a match", () => {
    const a = createPreset("a");
    const b = createPreset("b");
    const settings = createSettings({ presets: [a, b], activePresetId: "a" });

    const result = deletePreset(settings, "b");

    expect(result).not.toBe(settings);
    expect(result.presets).not.toBe(settings.presets);
  });

  it("deletePreset returns a fresh document and a fresh presets array on the no-op path", () => {
    const a = createPreset("a");
    const settings = createSettings({ presets: [a], activePresetId: "a" });

    const result = deletePreset(settings, "does-not-exist");

    expect(result).not.toBe(settings);
    expect(result.presets).not.toBe(settings.presets);
  });

  it("setActivePreset returns a fresh document and a fresh presets array when setting a known id", () => {
    const a = createPreset("a");
    const settings = createSettings({ presets: [a] });

    const result = setActivePreset(settings, "a");

    expect(result).not.toBe(settings);
    expect(result.presets).not.toBe(settings.presets);
  });

  it("setActivePreset returns a fresh document and a fresh presets array when clearing with null", () => {
    const a = createPreset("a");
    const settings = createSettings({ presets: [a], activePresetId: "a" });

    const result = setActivePreset(settings, null);

    expect(result).not.toBe(settings);
    expect(result.presets).not.toBe(settings.presets);
  });

  it("setActivePreset returns a fresh document and a fresh presets array on the no-op path", () => {
    const a = createPreset("a");
    const settings = createSettings({ presets: [a], activePresetId: "a" });

    const result = setActivePreset(settings, "does-not-exist");

    expect(result).not.toBe(settings);
    expect(result.presets).not.toBe(settings.presets);
  });
});
