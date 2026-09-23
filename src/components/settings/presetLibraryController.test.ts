import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CUSTOM_FRAME_RATE,
  DEFAULT_CUSTOM_RESOLUTION,
} from "@/features/settings/presetDocument";
import { DEFAULT_AUDIO_BITRATE_KBPS } from "@/features/settings/audioCodecs";
import {
  defaultQualityValue,
  isValidEncoderName,
  MAX_PRESET_NAME_CHARS,
} from "@/features/settings/limits";
import {
  PRESET_NAME_SLOT,
  type CopyNameForms,
  type PresetNameForms,
} from "@/features/settings/presetNaming";
import type { Preset, Settings } from "@/features/settings/types";
import {
  CUSTOM_ENCODER_VALUE,
  createPresetLibraryController,
  PresetLibraryController,
} from "./presetLibraryController";

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
    audioBitrate: 320,
    audioSampleRate: "source",
    audioChannels: "source",
    quality: { kind: "crf", value: 20 },
    resolution: "source",
    frameRate: "source",
    ...overrides,
  };
}

/**
 * Builds a settings document for tests. `ffmpegPath` and `activePresetId` are omitted
 * entirely unless an override supplies them, matching ADR 013's "absent when unset" rule.
 *
 * `revision` defaults to a distinctive non-zero value on purpose. Zero is specifically what a
 * document written before the field existed reads as, so a fixture that used it would conflate
 * the two cases. Matches the helper in `presetDocument.test.ts`.
 */
const TEST_REVISION = 7;

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    schemaVersion: 1,
    revision: TEST_REVISION,
    presets: [],
    ...overrides,
  };
}

/**
 * Returns a deterministic id generator producing "id-1", "id-2", ... in call order. Tests
 * never rely on `crypto.randomUUID`.
 */
function makeIdGenerator(): () => string {
  let counter = 0;
  return () => `id-${++counter}`;
}

/**
 * The English name forms, as the component formats them from the catalog. The controller
 * never imports i18next, so the tests pass plain functions.
 */
const NEW_NAME_FORMS: PresetNameForms = {
  base: "New Preset",
  numbered: (n) => `New Preset ${n}`,
};

const COPY_NAME_FORMS: CopyNameForms = {
  base: `${PRESET_NAME_SLOT} Copy`,
  numbered: (n) => `${PRESET_NAME_SLOT} Copy ${n}`,
};

/**
 * Returns a `saveSettings` mock that accepts every document and makes it the current one, as
 * the store's optimistic write does, together with a reader of the current document.
 */
function createAcceptingStore(initial: Settings) {
  let settings = initial;
  const saveSettings = vi.fn().mockImplementation((next: Settings) => {
    settings = next;
    return Promise.resolve(next);
  });
  return { getSettings: () => settings, saveSettings };
}

/**
 * Creates a deferred promise helper to control async execution in tests, matching the helper
 * used by `languageMenuController.test.ts`.
 */
function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PresetLibraryController", () => {
  describe("construction", () => {
    it("constructs with no options and reports a safe empty view", () => {
      const controller = new PresetLibraryController();
      const view = controller.getView();

      expect(view.presets).toEqual([]);
      expect(view.selectedPresetId).toBeNull();
      expect(view.draft).toBeNull();
      expect(view.dirty).toBe(false);
      expect(view.pending).toBe(false);
    });

    it("createPresetLibraryController builds a working controller", () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const controller = createPresetLibraryController({ getSettings: () => settings });

      controller.select("p1");

      expect(controller.getView().draft?.id).toBe("p1");
    });
  });

  // RULE 1 -- write this test first. restoreDefaults must never rebuild a settings document
  // and must never call saveSettings: Rust already preserves ffmpegPath and merges seeds by
  // id, so the only way to lose a user's ffmpeg path is for this controller to do that itself.
  describe("restoreDefaults", () => {
    it("RULE 1: calls only restoreDefaultPresets and never builds or saves a document", async () => {
      const restored = createSettings({
        presets: [createPreset("seed-1")],
        ffmpegPath: "/usr/bin/ffmpeg",
      });
      const restoreDefaultPresets = vi.fn().mockResolvedValue(restored);
      const saveSettings = vi.fn();
      const getSettings = vi.fn().mockReturnValue(
        createSettings({
          presets: [createPreset("custom-1")],
          ffmpegPath: "/usr/bin/ffmpeg",
        }),
      );

      const controller = createPresetLibraryController({
        getSettings,
        saveSettings,
        restoreDefaultPresets,
      });

      const result = await controller.restoreDefaults();

      expect(result).toBe(true);
      expect(restoreDefaultPresets).toHaveBeenCalledTimes(1);
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("returns false without saving when restoreDefaultPresets resolves null", async () => {
      const restoreDefaultPresets = vi.fn().mockResolvedValue(null);
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => createSettings(),
        saveSettings,
        restoreDefaultPresets,
      });

      const result = await controller.restoreDefaults();

      expect(result).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
    });

    // FIX 5: a seed merge can change the selected preset's own fields. The draft must reflect
    // the restored document afterwards, not the pre-restore values it was loaded from.
    it("reloads the draft for the selected preset from the restored document", async () => {
      const settings = createSettings({
        presets: [createPreset("p1", { name: "Custom name" })],
      });
      const restored = createSettings({
        presets: [createPreset("p1", { name: "Seed name" })],
      });
      const restoreDefaultPresets = vi.fn().mockResolvedValue(restored);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
        restoreDefaultPresets,
      });

      controller.select("p1");
      expect(controller.getView().draft?.name).toBe("Custom name");

      const result = await controller.restoreDefaults();

      expect(result).toBe(true);
      expect(controller.getView().draft?.name).toBe("Seed name");
    });

    // FIX 5: when the merge removes the selected preset entirely, the draft must clear rather
    // than keep showing the stale, now-nonexistent preset.
    it("clears the draft when the restored document no longer contains the selected preset", async () => {
      const settings = createSettings({
        presets: [createPreset("p1"), createPreset("p2")],
      });
      const restored = createSettings({
        presets: [createPreset("p2")],
      });
      const restoreDefaultPresets = vi.fn().mockResolvedValue(restored);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
        restoreDefaultPresets,
      });

      controller.select("p1");
      expect(controller.getView().draft?.id).toBe("p1");

      const result = await controller.restoreDefaults();

      expect(result).toBe(true);
      expect(controller.getView().draft).toBeNull();
    });

    // BLOCKING 09-F2: a restore merges the seeds by id and keeps every other preset, so it
    // says nothing about the preset the user is editing. Reloading over a dirty draft would
    // discard that edit with no prompt and no undo.
    it("keeps a dirty draft when the selected preset survives the restore", async () => {
      const settings = createSettings({
        presets: [createPreset("p1", { name: "Stored name" })],
      });
      const restored = createSettings({
        presets: [createPreset("p1", { name: "Stored name" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
        restoreDefaultPresets: vi.fn().mockResolvedValue(restored),
      });

      controller.select("p1");
      controller.setName("Half-typed name");
      expect(controller.getView().dirty).toBe(true);

      const result = await controller.restoreDefaults();

      expect(result).toBe(true);
      expect(controller.getView().draft?.name).toBe("Half-typed name");
      expect(controller.getView().dirty).toBe(true);
    });

    // The one condition that still replaces a dirty draft: there is no longer anything to
    // save the edit back to.
    it("replaces a dirty draft when the restore drops the selected preset", async () => {
      const settings = createSettings({
        presets: [createPreset("p1"), createPreset("p2")],
      });
      const restored = createSettings({
        presets: [createPreset("p2")],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
        restoreDefaultPresets: vi.fn().mockResolvedValue(restored),
      });

      controller.select("p1");
      controller.setName("Half-typed name");
      expect(controller.getView().dirty).toBe(true);

      const result = await controller.restoreDefaults();

      expect(result).toBe(true);
      expect(controller.getView().draft).toBeNull();
      expect(controller.getView().dirty).toBe(false);
    });
  });

  // RULE 2 -- deleting the active preset must never leave a dangling activePresetId. This
  // controller delegates to `deletePreset` from presetDocument.ts, which repairs it, rather
  // than reimplementing removal here.
  describe("deletePreset", () => {
    it("RULE 2: hands saveSettings a document whose activePresetId names a surviving preset (or is absent)", async () => {
      const settings = createSettings({
        presets: [createPreset("p1"), createPreset("p2")],
        activePresetId: "p1",
      });
      const saveSettings = vi.fn().mockResolvedValue(settings);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      const result = await controller.deletePreset("p1");

      expect(result).toBe(true);
      expect(saveSettings).toHaveBeenCalledTimes(1);
      const written = saveSettings.mock.calls[0]?.[0] as Settings;
      const activeIsSafe =
        written.activePresetId === undefined ||
        written.presets.some((preset) => preset.id === written.activePresetId);
      expect(activeIsSafe).toBe(true);
      expect(written.activePresetId).toBe("p2");
    });

    it("leaves the selection alone when deleting a preset that is not selected", async () => {
      const settings = createSettings({
        presets: [createPreset("p1"), createPreset("p2")],
      });
      const saveSettings = vi.fn().mockResolvedValue(settings);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p2");
      const result = await controller.deletePreset("p1");

      expect(result).toBe(true);
      const view = controller.getView();
      expect(view.selectedPresetId).toBe("p2");
      expect(view.draft?.id).toBe("p2");
    });

    it("clears the selection and draft when the deleted preset was selected", async () => {
      const settings = createSettings({
        presets: [createPreset("p1"), createPreset("p2")],
      });
      const saveSettings = vi.fn().mockResolvedValue(settings);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p1");
      const result = await controller.deletePreset("p1");

      expect(result).toBe(true);
      const view = controller.getView();
      expect(view.selectedPresetId).toBeNull();
      expect(view.draft).toBeNull();
    });

    it("returns false and performs no IPC when there is no settings document", async () => {
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings,
      });

      const result = await controller.deletePreset("p1");

      expect(result).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
    });
  });

  // RULE 3 -- a save landing mid-edit must not wipe the user's typing. syncFromSettings must
  // return early, changing nothing, while dirty is true or a write is in flight.
  describe("syncFromSettings", () => {
    it("RULE 3: leaves a dirty draft untouched when the store delivers a different document", () => {
      const initial = createSettings({
        presets: [createPreset("p1", { name: "Original" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => initial,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.updateDraft({ name: "User typing..." });

      const incoming = createSettings({
        presets: [createPreset("p1", { name: "From disk" }), createPreset("p2")],
      });
      controller.syncFromSettings(incoming);

      const view = controller.getView();
      expect(view.dirty).toBe(true);
      expect(view.draft?.name).toBe("User typing...");
    });

    // This covers the `pendingCount > 0` half of RULE 3 specifically: the write below
    // (`setActive`) never touches `dirty` or `draft`, so the dirty guard alone cannot be why
    // the draft survives. Only the in-flight guard can. If `|| this.pendingCount > 0` is
    // removed from `syncFromSettings`, this test fails because the draft reloads to
    // "From disk" while the write is still pending.
    it("RULE 3: leaves the draft untouched while a write that does not dirty it is in flight", async () => {
      const initial = createSettings({
        presets: [createPreset("p1", { name: "Original" }), createPreset("p2")],
      });
      const deferred = createDeferred<Settings | null>();
      const saveSettings = vi.fn().mockReturnValue(deferred.promise);
      const controller = createPresetLibraryController({
        getSettings: () => initial,
        saveSettings,
      });

      controller.select("p1");
      const setActivePromise = controller.setActive("p2");
      expect(controller.getView().dirty).toBe(false);
      expect(controller.getView().pending).toBe(true);

      controller.syncFromSettings(
        createSettings({
          presets: [createPreset("p1", { name: "From disk" }), createPreset("p2")],
        }),
      );
      expect(controller.getView().draft?.name).toBe("Original");

      deferred.resolve(initial);
      await setActivePromise;
    });

    it("reloads the draft from the incoming document when idle and not dirty", () => {
      const initial = createSettings({
        presets: [createPreset("p1", { name: "Original" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => initial,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      const incoming = createSettings({
        presets: [createPreset("p1", { name: "Updated elsewhere" })],
      });
      controller.syncFromSettings(incoming);

      const view = controller.getView();
      expect(view.draft?.name).toBe("Updated elsewhere");
      expect(view.dirty).toBe(false);
    });
  });

  describe("saveDraft", () => {
    it("performs no IPC and returns false when there is no draft", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      const result = await controller.saveDraft();

      expect(result).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("performs no IPC and returns false when the draft has a validation issue", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p1");
      controller.updateDraft({ quality: { kind: "crf", value: 999 } });
      expect(controller.getView().issues.length).toBeGreaterThan(0);

      const result = await controller.saveDraft();

      expect(result).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
      expect(controller.getView().dirty).toBe(true);
    });

    it.each([
      { container: "mov" as const, audioEncoder: "flac" },
      { container: "mov" as const, audioEncoder: "libopus" },
    ])(
      "gives view.canSave === false and saveDraft makes no save call for $container + $audioEncoder draft",
      async ({ container, audioEncoder }) => {
        const settings = createSettings({ presets: [createPreset("p1")] });
        const saveSettings = vi.fn();
        const controller = createPresetLibraryController({
          getSettings: () => settings,
          saveSettings,
        });

        controller.select("p1");
        controller.updateDraft({ container, audioEncoder });

        const view = controller.getView();
        expect(view.canSave).toBe(false);
        expect(view.issues).toContainEqual({
          field: "audioEncoder",
          code: "containerMismatch",
          values: { container, encoder: audioEncoder },
        });

        const result = await controller.saveDraft();
        expect(result).toBe(false);
        expect(saveSettings).not.toHaveBeenCalled();
      },
    );

    it("returns false and performs no IPC when the draft is not dirty", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p1");
      expect(controller.getView().dirty).toBe(false);

      const result = await controller.saveDraft();

      expect(result).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
    });

    // FIX 1: a stale completion must not clear `dirty` for a draft it never saved. Select p1,
    // start saving it, then -- while that write is still in flight -- select p2 and type into
    // it. When the p1 write resolves, `dirty` must stay true and the p2 draft must keep its
    // unsaved text; otherwise the next syncFromSettings would silently discard it.
    it("does not clear dirty for a draft superseded by select() while its save is in flight", async () => {
      const p1 = createPreset("p1", { name: "P1 original" });
      const p2 = createPreset("p2", { name: "P2 original" });
      const settings = createSettings({ presets: [p1, p2] });
      const deferred = createDeferred<Settings | null>();
      const saveSettings = vi.fn().mockReturnValue(deferred.promise);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p1");
      controller.updateDraft({ name: "P1 typing" });
      const savePromise = controller.saveDraft();

      controller.select("p2");
      controller.updateDraft({ name: "P2 typing" });

      deferred.resolve(settings);
      await savePromise;

      const view = controller.getView();
      expect(view.selectedPresetId).toBe("p2");
      expect(view.draft?.name).toBe("P2 typing");
      expect(view.dirty).toBe(true);
    });

    // FIX 6: the injected `saveSettings` type permits rejection even though the production
    // default never rejects. A rejection must still release `pendingCount` (via `finally`)
    // rather than wedging the controller in `pending: true` forever, and must escape the
    // public method uncaught rather than being swallowed.
    it("releases pending when saveSettings rejects, and the rejection escapes", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi.fn().mockRejectedValue(new Error("boom"));
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p1");
      controller.updateDraft({ name: "Renamed" });

      await expect(controller.saveDraft()).rejects.toThrow("boom");
      expect(controller.getView().pending).toBe(false);
    });

    it("returns false and leaves dirty true when saveSettings resolves null", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi.fn().mockResolvedValue(null);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p1");
      controller.updateDraft({ name: "Renamed" });

      const result = await controller.saveDraft();

      expect(result).toBe(false);
      expect(saveSettings).toHaveBeenCalledTimes(1);
      expect(controller.getView().dirty).toBe(true);
    });

    it("adds a draft whose id is absent from the document", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi
        .fn()
        .mockImplementation((next: Settings) => Promise.resolve(next));
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p1");
      controller.updateDraft({ id: "new-id", name: "Cloned" });
      const result = await controller.saveDraft();

      expect(result).toBe(true);
      const saved = saveSettings.mock.calls[0]?.[0] as Settings;
      expect(saved.presets.map((preset) => preset.id)).toEqual(["p1", "new-id"]);
    });

    it("updates a draft whose id is present in the document, preserving array order", async () => {
      const settings = createSettings({
        presets: [createPreset("p1"), createPreset("p2"), createPreset("p3")],
      });
      const saveSettings = vi
        .fn()
        .mockImplementation((next: Settings) => Promise.resolve(next));
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p2");
      controller.updateDraft({ name: "Renamed p2" });
      const result = await controller.saveDraft();

      expect(result).toBe(true);
      const saved = saveSettings.mock.calls[0]?.[0] as Settings;
      expect(saved.presets.map((preset) => preset.id)).toEqual(["p1", "p2", "p3"]);
      expect(saved.presets[1].name).toBe("Renamed p2");
    });
  });

  // The settings dialog closes, and the preset library switches presets, only when this
  // resolves true. A true result must therefore mean that no edit is left unsaved.
  describe("saveDraftBeforeLeaving", () => {
    it("resolves true and clears dirty when the save succeeds", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi
        .fn()
        .mockImplementation((next: Settings) => Promise.resolve(next));
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p1");
      controller.setName("Renamed");

      await expect(controller.saveDraftBeforeLeaving()).resolves.toBe(true);
      expect(saveSettings).toHaveBeenCalledTimes(1);
      expect(controller.getView().dirty).toBe(false);
    });

    it("resolves false and keeps the edit when the save fails", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi.fn().mockResolvedValue(null);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p1");
      controller.setName("Renamed");

      await expect(controller.saveDraftBeforeLeaving()).resolves.toBe(false);
      expect(controller.getView().dirty).toBe(true);
      expect(controller.getView().draft?.name).toBe("Renamed");
    });

    it("resolves false with no IPC when the draft cannot be saved", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p1");
      controller.updateQualityValue("");
      expect(controller.getView().canSave).toBe(false);

      await expect(controller.saveDraftBeforeLeaving()).resolves.toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
      expect(controller.getView().dirty).toBe(true);
    });

    // The write carries the draft as it was when the save started. A keystroke that lands
    // while the write is in flight is not in it, so leaving would lose that keystroke.
    it("resolves false when an edit lands while the write is in flight", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const deferred = createDeferred<Settings | null>();
      const saveSettings = vi.fn().mockReturnValue(deferred.promise);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      controller.select("p1");
      controller.setName("Renamed");
      const leaving = controller.saveDraftBeforeLeaving();
      controller.setName("Renamed again");

      deferred.resolve(settings);

      await expect(leaving).resolves.toBe(false);
      expect(controller.getView().dirty).toBe(true);
      expect(controller.getView().draft?.name).toBe("Renamed again");
    });
  });

  describe("addPreset", () => {
    it("refuses to add and performs no IPC once the library holds MAX_PRESETS", async () => {
      const presets = Array.from({ length: 100 }, (_, index) =>
        createPreset(`p${index}`),
      );
      const settings = createSettings({ presets });
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      const result = await controller.addPreset(NEW_NAME_FORMS);

      expect(result).toBeNull();
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("uses the injected id and the base name, selects the new preset, and resolves its id", async () => {
      const store = createAcceptingStore(
        createSettings({ presets: [createPreset("existing")] }),
      );
      const controller = createPresetLibraryController({
        ...store,
        generateId: makeIdGenerator(),
      });

      const result = await controller.addPreset(NEW_NAME_FORMS);

      expect(result).toBe("id-1");
      expect(store.saveSettings).toHaveBeenCalledTimes(1);
      const view = controller.getView();
      expect(view.selectedPresetId).toBe("id-1");
      expect(view.draft?.id).toBe("id-1");
      expect(view.draft?.name).toBe("New Preset");
      expect(view.dirty).toBe(false);
      expect(view.pending).toBe(false);
    });

    it("numbers the name when the base name is taken, and fills a gap", async () => {
      const store = createAcceptingStore(
        createSettings({
          presets: [
            createPreset("a", { name: "New Preset" }),
            createPreset("b", { name: "New Preset 3" }),
          ],
        }),
      );
      const controller = createPresetLibraryController({
        ...store,
        generateId: makeIdGenerator(),
      });

      await controller.addPreset(NEW_NAME_FORMS);
      await controller.addPreset(NEW_NAME_FORMS);

      expect(store.getSettings().presets.map((preset) => preset.name)).toEqual([
        "New Preset",
        "New Preset 3",
        "New Preset 2",
        "New Preset 4",
      ]);
      expect(controller.getView().draft?.name).toBe("New Preset 4");
    });

    it("compares names case-sensitively and ignores their surrounding white space", async () => {
      const store = createAcceptingStore(
        createSettings({
          presets: [
            createPreset("a", { name: "new preset" }),
            createPreset("b", { name: " New Preset " }),
          ],
        }),
      );
      const controller = createPresetLibraryController({
        ...store,
        generateId: makeIdGenerator(),
      });

      await controller.addPreset(NEW_NAME_FORMS);

      expect(controller.getView().draft?.name).toBe("New Preset 2");
    });

    it("returns null and performs no IPC when there is no settings document", async () => {
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings,
      });

      const result = await controller.addPreset(NEW_NAME_FORMS);

      expect(result).toBeNull();
      expect(saveSettings).not.toHaveBeenCalled();
    });

    // The selection of the new preset would discard the edit. The view settles the draft
    // through the unsaved-changes prompt first, so a call over a dirty draft is a fault.
    it("refuses with no IPC while the draft holds an unsaved edit, and keeps the edit", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
        generateId: makeIdGenerator(),
      });

      controller.select("p1");
      controller.setName("Unsaved edit");

      const result = await controller.addPreset(NEW_NAME_FORMS);

      expect(result).toBeNull();
      expect(saveSettings).not.toHaveBeenCalled();
      const view = controller.getView();
      expect(view.selectedPresetId).toBe("p1");
      expect(view.dirty).toBe(true);
      expect(view.draft?.name).toBe("Unsaved edit");
    });

    // The two orders the unsaved-changes prompt uses before it adds: Discard cancels the
    // draft, and Save and Switch saves it.
    it("adds after the draft is cancelled or saved", async () => {
      const store = createAcceptingStore(
        createSettings({ presets: [createPreset("p1", { name: "Main" })] }),
      );
      const controller = createPresetLibraryController({
        ...store,
        generateId: makeIdGenerator(),
      });

      controller.select("p1");
      controller.setName("Discarded");
      controller.cancelDraft();
      await expect(controller.addPreset(NEW_NAME_FORMS)).resolves.toBe("id-1");

      controller.select("p1");
      controller.setName("Main saved");
      await expect(controller.saveDraftBeforeLeaving()).resolves.toBe(true);
      await expect(controller.addPreset(NEW_NAME_FORMS)).resolves.toBe("id-2");

      expect(store.getSettings().presets.map((preset) => preset.name)).toEqual([
        "Main saved",
        "New Preset",
        "New Preset 2",
      ]);
    });

    it("returns null and keeps the selection when the write fails", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi.fn().mockResolvedValue(null);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
        generateId: makeIdGenerator(),
      });

      controller.select("p1");

      const result = await controller.addPreset(NEW_NAME_FORMS);

      expect(result).toBeNull();
      const view = controller.getView();
      expect(view.selectedPresetId).toBe("p1");
      expect(view.draft?.id).toBe("p1");
      expect(view.pending).toBe(false);
    });

    // RULE 3: the fields of the current preset stay editable while the write is in flight.
    // The selection of the new preset would then discard that edit with no prompt.
    it("keeps the selection and an edit that lands while the write is in flight", async () => {
      let settings = createSettings({ presets: [createPreset("p1")] });
      const deferred = createDeferred<Settings | null>();
      const saveSettings = vi.fn().mockImplementation((next: Settings) => {
        settings = next;
        return deferred.promise;
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
        generateId: makeIdGenerator(),
      });

      controller.select("p1");
      const adding = controller.addPreset(NEW_NAME_FORMS);
      expect(controller.getView().pending).toBe(true);
      controller.setName("Typed during the write");
      deferred.resolve(settings);

      await expect(adding).resolves.toBeNull();
      const view = controller.getView();
      expect(view.selectedPresetId).toBe("p1");
      expect(view.dirty).toBe(true);
      expect(view.draft?.name).toBe("Typed during the write");
      // The new preset is in the library all the same.
      expect(settings.presets.map((preset) => preset.id)).toEqual(["p1", "id-1"]);
    });
  });

  describe("duplicatePreset", () => {
    it("appends a deep copy with a new id and the copy name, selects it, and resolves its id", async () => {
      const source = createPreset("p1", {
        name: "Main",
        container: "mkv",
        videoEncoder: "libx265",
        audioEncoder: "flac",
        audioSampleRate: 48000,
        audioChannels: "stereo",
        quality: { kind: "bitrate", value: 8000 },
        resolution: { w: 1280, h: 720 },
        frameRate: { n: 30000, d: 1001 },
      });
      delete source.audioBitrate;
      const store = createAcceptingStore(
        createSettings({ presets: [source, createPreset("p2")] }),
      );
      const controller = createPresetLibraryController({
        ...store,
        generateId: makeIdGenerator(),
      });

      controller.select("p1");
      const result = await controller.duplicatePreset("p1", COPY_NAME_FORMS);

      expect(result).toBe("id-1");
      expect(store.saveSettings).toHaveBeenCalledTimes(1);
      const presets = store.getSettings().presets;
      expect(presets.map((preset) => preset.id)).toEqual(["p1", "p2", "id-1"]);
      const copy = presets[2];
      expect(copy).toStrictEqual({ ...source, id: "id-1", name: "Main Copy" });
      expect("audioBitrate" in copy).toBe(false);

      // A deep copy: no nested object is shared with the source.
      expect(copy.quality).not.toBe(source.quality);
      expect(copy.resolution).not.toBe(source.resolution);
      expect(copy.frameRate).not.toBe(source.frameRate);
      expect(presets[0]).toBe(source);
      expect(source.id).toBe("p1");
      expect(source.name).toBe("Main");

      const view = controller.getView();
      expect(view.selectedPresetId).toBe("id-1");
      expect(view.draft?.id).toBe("id-1");
      expect(view.draft?.name).toBe("Main Copy");
      expect(view.dirty).toBe(false);
    });

    it("gives every copy an id that no other preset has", async () => {
      const store = createAcceptingStore(
        createSettings({ presets: [createPreset("p1", { name: "Main" })] }),
      );
      const controller = createPresetLibraryController({
        ...store,
        generateId: makeIdGenerator(),
      });

      await controller.duplicatePreset("p1", COPY_NAME_FORMS);
      await controller.duplicatePreset("p1", COPY_NAME_FORMS);

      const ids = store.getSettings().presets.map((preset) => preset.id);
      expect(ids).toEqual(["p1", "id-1", "id-2"]);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("numbers the copy name when it is taken", async () => {
      const store = createAcceptingStore(
        createSettings({
          presets: [
            createPreset("p1", { name: "Main" }),
            createPreset("p2", { name: "Main Copy" }),
          ],
        }),
      );
      const controller = createPresetLibraryController({
        ...store,
        generateId: makeIdGenerator(),
      });

      await controller.duplicatePreset("p1", COPY_NAME_FORMS);
      await controller.duplicatePreset("p1", COPY_NAME_FORMS);

      expect(store.getSettings().presets.map((preset) => preset.name)).toEqual([
        "Main",
        "Main Copy",
        "Main Copy 2",
        "Main Copy 3",
      ]);
    });

    it("fits the copy of a preset with the longest name into MAX_PRESET_NAME_CHARS", async () => {
      const longName = "L".repeat(MAX_PRESET_NAME_CHARS);
      const store = createAcceptingStore(
        createSettings({ presets: [createPreset("p1", { name: longName })] }),
      );
      const controller = createPresetLibraryController({
        ...store,
        generateId: makeIdGenerator(),
      });

      await controller.duplicatePreset("p1", COPY_NAME_FORMS);

      const copyName = store.getSettings().presets[1].name;
      expect([...copyName].length).toBe(MAX_PRESET_NAME_CHARS);
      expect(copyName.endsWith(" Copy")).toBe(true);
      expect(controller.getView().issues).toEqual([]);
    });

    it("keeps the active preset and every other key of the document", async () => {
      const store = createAcceptingStore(
        createSettings({
          presets: [createPreset("p1", { name: "Main" })],
          activePresetId: "p1",
          ffmpegPath: "/opt/homebrew/bin",
        }),
      );
      const controller = createPresetLibraryController({
        ...store,
        generateId: makeIdGenerator(),
      });

      await controller.duplicatePreset("p1", COPY_NAME_FORMS);

      const saved = store.getSettings();
      expect(saved.activePresetId).toBe("p1");
      expect(saved.ffmpegPath).toBe("/opt/homebrew/bin");
      expect(saved.revision).toBe(TEST_REVISION);
    });

    it("copies a preset that is not the selected one", async () => {
      const store = createAcceptingStore(
        createSettings({
          presets: [createPreset("p1"), createPreset("p2", { name: "Other" })],
        }),
      );
      const controller = createPresetLibraryController({
        ...store,
        generateId: makeIdGenerator(),
      });

      controller.select("p1");
      const result = await controller.duplicatePreset("p2", COPY_NAME_FORMS);

      expect(result).toBe("id-1");
      expect(store.getSettings().presets[2].name).toBe("Other Copy");
      expect(controller.getView().selectedPresetId).toBe("id-1");
    });

    // The copy is made from the stored preset, so it would not contain the edit on screen,
    // and the selection of the copy would discard that edit.
    it("refuses with no IPC while the draft holds an unsaved edit, and keeps the edit", async () => {
      const settings = createSettings({
        presets: [createPreset("p1", { name: "Main" })],
      });
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
        generateId: makeIdGenerator(),
      });

      controller.select("p1");
      controller.setName("Main edited");

      const result = await controller.duplicatePreset("p1", COPY_NAME_FORMS);

      expect(result).toBeNull();
      expect(saveSettings).not.toHaveBeenCalled();
      const view = controller.getView();
      expect(view.selectedPresetId).toBe("p1");
      expect(view.dirty).toBe(true);
      expect(view.draft?.name).toBe("Main edited");
    });

    it("copies the saved edit once the draft is saved", async () => {
      const store = createAcceptingStore(
        createSettings({ presets: [createPreset("p1", { name: "Main" })] }),
      );
      const controller = createPresetLibraryController({
        ...store,
        generateId: makeIdGenerator(),
      });

      controller.select("p1");
      controller.setName("Main edited");
      controller.updateQualityValue("28");
      await controller.saveDraft();

      await expect(controller.duplicatePreset("p1", COPY_NAME_FORMS)).resolves.toBe(
        "id-1",
      );
      const copy = store.getSettings().presets[1];
      expect(copy.name).toBe("Main edited Copy");
      expect(copy.quality).toEqual({ kind: "crf", value: 28 });
    });

    it("refuses with no IPC once the library holds MAX_PRESETS", async () => {
      const presets = Array.from({ length: 100 }, (_, index) =>
        createPreset(`p${index}`),
      );
      const settings = createSettings({ presets });
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      await expect(
        controller.duplicatePreset("p0", COPY_NAME_FORMS),
      ).resolves.toBeNull();
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("refuses with no IPC when no preset has the id", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      await expect(
        controller.duplicatePreset("missing", COPY_NAME_FORMS),
      ).resolves.toBeNull();
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("returns null and keeps the selection when the write fails", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const saveSettings = vi.fn().mockResolvedValue(null);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
        generateId: makeIdGenerator(),
      });

      controller.select("p1");

      const result = await controller.duplicatePreset("p1", COPY_NAME_FORMS);

      expect(result).toBeNull();
      const view = controller.getView();
      expect(view.selectedPresetId).toBe("p1");
      expect(view.dirty).toBe(false);
      expect(view.pending).toBe(false);
    });

    it("reports pending while the write is in flight", async () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const deferred = createDeferred<Settings | null>();
      const saveSettings = vi.fn().mockReturnValue(deferred.promise);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
        generateId: makeIdGenerator(),
      });

      const duplicating = controller.duplicatePreset("p1", COPY_NAME_FORMS);
      expect(controller.getView().pending).toBe(true);

      deferred.resolve(settings);
      await duplicating;
      expect(controller.getView().pending).toBe(false);
    });

    // RULE 3, as for `addPreset`.
    it("keeps the selection and an edit that lands while the write is in flight", async () => {
      let settings = createSettings({
        presets: [createPreset("p1", { name: "Main" })],
      });
      const deferred = createDeferred<Settings | null>();
      const saveSettings = vi.fn().mockImplementation((next: Settings) => {
        settings = next;
        return deferred.promise;
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
        generateId: makeIdGenerator(),
      });

      controller.select("p1");
      const duplicating = controller.duplicatePreset("p1", COPY_NAME_FORMS);
      controller.setName("Typed during the write");
      deferred.resolve(settings);

      await expect(duplicating).resolves.toBeNull();
      const view = controller.getView();
      expect(view.selectedPresetId).toBe("p1");
      expect(view.dirty).toBe(true);
      expect(view.draft?.name).toBe("Typed during the write");
      expect(settings.presets.map((preset) => preset.name)).toEqual([
        "Main",
        "Main Copy",
      ]);
    });
  });

  describe("select", () => {
    it("loads a copy of the preset: mutating the draft, including nested fields, does not alter the stored preset", () => {
      const original = createPreset("p1", {
        name: "Original",
        quality: { kind: "crf", value: 20 },
        resolution: { w: 1920, h: 1080 },
        frameRate: { n: 30, d: 1 },
      });
      const settings = createSettings({ presets: [original] });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      const view = controller.getView();
      if (view.draft) {
        view.draft.name = "Mutated";
        view.draft.quality.value = 63;
        if (view.draft.resolution !== "source") {
          view.draft.resolution.w = 100;
        }
        if (view.draft.frameRate !== "source") {
          view.draft.frameRate.n = 24;
        }
      }

      expect(original.name).toBe("Original");
      expect(original.quality.value).toBe(20);
      expect(original.resolution).toEqual({ w: 1920, h: 1080 });
      expect(original.frameRate).toEqual({ n: 30, d: 1 });
      expect(settings.presets[0]).toBe(original);
    });

    it("discards an unsaved draft without warning, leaving dirty for the caller to check first", () => {
      const settings = createSettings({
        presets: [
          createPreset("p1", { name: "One" }),
          createPreset("p2", { name: "Two" }),
        ],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.updateDraft({ name: "Unsaved edit" });
      expect(controller.getView().dirty).toBe(true);

      controller.select("p2");

      const view = controller.getView();
      expect(view.dirty).toBe(false);
      expect(view.draft?.name).toBe("Two");
    });
  });

  describe("updateDraft", () => {
    it("recomputes issues: a bad crf makes canSave false, and correcting it makes canSave true again", () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.updateDraft({ quality: { kind: "crf", value: 999 } });
      expect(controller.getView().canSave).toBe(false);
      expect(
        controller.getView().issues.some((issue) => issue.field === "quality"),
      ).toBe(true);

      controller.updateDraft({ quality: { kind: "crf", value: 20 } });
      expect(controller.getView().issues).toEqual([]);
      expect(controller.getView().canSave).toBe(true);
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.updateDraft({ name: "x" });

      expect(controller.getView().draft).toBeNull();
      expect(controller.getView().dirty).toBe(false);
    });
  });

  describe("cancelDraft", () => {
    it("restores the stored values and clears dirty", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { name: "Original" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.updateDraft({ name: "Scratch" });
      expect(controller.getView().dirty).toBe(true);

      controller.cancelDraft();

      const view = controller.getView();
      expect(view.dirty).toBe(false);
      expect(view.draft?.name).toBe("Original");
    });
  });

  describe("setActive", () => {
    it("writes the document with the new active preset id", async () => {
      const settings = createSettings({
        presets: [createPreset("p1"), createPreset("p2")],
        activePresetId: "p1",
      });
      const saveSettings = vi.fn().mockResolvedValue(settings);
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
      });

      const result = await controller.setActive("p2");

      expect(result).toBe(true);
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ activePresetId: "p2" }),
      );
    });

    it("returns false and performs no IPC when there is no settings document", async () => {
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings,
      });

      const result = await controller.setActive("p1");

      expect(result).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
    });
  });

  describe("lifecycle", () => {
    it("emits no onChange while deactivated; the divergence is emitted on activate()", () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const onChange = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
        onChange,
      });

      controller.deactivate();
      controller.select("p1");
      expect(onChange).not.toHaveBeenCalled();

      controller.activate();
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ selectedPresetId: "p1" }),
      );
    });

    it("activate() twice in a row is safe (React StrictMode double-mount)", () => {
      const onChange = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
        onChange,
      });

      expect(() => {
        controller.activate();
        controller.activate();
      }).not.toThrow();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("dispose() suppresses onChange like deactivate()", () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const onChange = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
        onChange,
      });

      controller.dispose();
      controller.select("p1");
      expect(onChange).not.toHaveBeenCalled();

      controller.activate();
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  describe("getSettings returning null", () => {
    it("makes every mutation a safe no-op rather than throwing", async () => {
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings,
      });

      expect(() => controller.select("anything")).not.toThrow();
      expect(controller.getView().draft).toBeNull();

      expect(() => controller.updateDraft({ name: "x" })).not.toThrow();

      await expect(controller.saveDraft()).resolves.toBe(false);
      await expect(controller.addPreset(NEW_NAME_FORMS)).resolves.toBeNull();
      await expect(
        controller.duplicatePreset("id", COPY_NAME_FORMS),
      ).resolves.toBeNull();
      await expect(controller.deletePreset("id")).resolves.toBe(false);
      await expect(controller.setActive("id")).resolves.toBe(false);

      expect(() => controller.cancelDraft()).not.toThrow();
      expect(() => controller.syncFromSettings(null)).not.toThrow();

      expect(saveSettings).not.toHaveBeenCalled();
    });
  });

  describe("CUSTOM_ENCODER_VALUE", () => {
    it("is never accepted as a valid encoder name, so it can never collide with a real one", () => {
      expect(isValidEncoderName(CUSTOM_ENCODER_VALUE)).toBe(false);
    });
  });

  describe("ready", () => {
    it("is false when no settings document is available", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      expect(controller.getView().ready).toBe(false);
    });

    it("is true once a settings document is available", () => {
      const controller = createPresetLibraryController({
        getSettings: () => createSettings(),
        saveSettings: vi.fn(),
      });

      expect(controller.getView().ready).toBe(true);
    });
  });

  describe("resolutionMode and frameRateMode", () => {
    it("report 'source' when the draft holds the literal string 'source'", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { resolution: "source", frameRate: "source" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");

      const view = controller.getView();
      expect(view.resolutionMode).toBe("source");
      expect(view.frameRateMode).toBe("source");
    });

    it("report 'custom' when the draft holds an explicit resolution or frame rate", () => {
      const settings = createSettings({
        presets: [
          createPreset("p1", {
            resolution: { w: 1280, h: 720 },
            frameRate: { n: 24, d: 1 },
          }),
        ],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");

      const view = controller.getView();
      expect(view.resolutionMode).toBe("custom");
      expect(view.frameRateMode).toBe("custom");
    });

    it("default to 'source' when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      const view = controller.getView();
      expect(view.resolutionMode).toBe("source");
      expect(view.frameRateMode).toBe("source");
    });
  });

  describe("setName", () => {
    it("sets the draft's name verbatim, recomputes issues, and marks dirty", () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setName("Renamed");

      const view = controller.getView();
      expect(view.draft?.name).toBe("Renamed");
      expect(view.dirty).toBe(true);
      expect(view.issues).toEqual([]);
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.setName("x");

      expect(controller.getView().draft).toBeNull();
      expect(controller.getView().dirty).toBe(false);
    });
  });

  describe("setContainer", () => {
    it("sets the draft's container, recomputes issues, and marks dirty", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { container: "mp4" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setContainer("mkv");

      const view = controller.getView();
      expect(view.draft?.container).toBe("mkv");
      expect(view.dirty).toBe(true);
    });

    it("raises a containerMismatch issue when setContainer('mov') is called on a libopus draft", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { container: "mkv", audioEncoder: "libopus" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      expect(controller.getView().issues).toEqual([]);

      controller.setContainer("mov");

      const view = controller.getView();
      expect(view.draft?.container).toBe("mov");
      expect(view.issues).toEqual([
        {
          field: "audioEncoder",
          code: "containerMismatch",
          values: { container: "mov", encoder: "libopus" },
        },
      ]);
      expect(view.canSave).toBe(false);
    });

    it("clears the containerMismatch issue when setContainer('mkv') is called on a mov + libopus draft", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { container: "mov", audioEncoder: "libopus" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      expect(controller.getView().issues).toContainEqual({
        field: "audioEncoder",
        code: "containerMismatch",
        values: { container: "mov", encoder: "libopus" },
      });

      controller.setContainer("mkv");

      const view = controller.getView();
      expect(view.draft?.container).toBe("mkv");
      expect(view.issues).toEqual([]);
      expect(view.dirty).toBe(true);
      expect(view.canSave).toBe(true);
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.setContainer("mkv");

      expect(controller.getView().draft).toBeNull();
      expect(controller.getView().dirty).toBe(false);
    });
  });

  describe("chooseEncoder", () => {
    it("sets the video custom flag and leaves the stored name unchanged for CUSTOM_ENCODER_VALUE", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { videoEncoder: "libx264" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.chooseEncoder("video", CUSTOM_ENCODER_VALUE);

      const view = controller.getView();
      expect(view.videoEncoderIsCustom).toBe(true);
      expect(view.draft?.videoEncoder).toBe("libx264");
      expect(view.dirty).toBe(true);
    });

    it("clears the video custom flag and stores the value for a real encoder name", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { videoEncoder: "libx264" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.chooseEncoder("video", CUSTOM_ENCODER_VALUE);
      expect(controller.getView().videoEncoderIsCustom).toBe(true);

      controller.chooseEncoder("video", "libx265");

      const view = controller.getView();
      expect(view.videoEncoderIsCustom).toBe(false);
      expect(view.draft?.videoEncoder).toBe("libx265");
    });

    it("tracks the audio side independently of the video side", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { audioEncoder: "aac" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.chooseEncoder("audio", CUSTOM_ENCODER_VALUE);

      let view = controller.getView();
      expect(view.audioEncoderIsCustom).toBe(true);
      expect(view.videoEncoderIsCustom).toBe(false);
      expect(view.draft?.audioEncoder).toBe("aac");

      controller.chooseEncoder("audio", "opus");

      view = controller.getView();
      expect(view.audioEncoderIsCustom).toBe(false);
      expect(view.draft?.audioEncoder).toBe("opus");
    });

    it("resets both custom flags to false when a different preset is selected", () => {
      const settings = createSettings({
        presets: [createPreset("p1"), createPreset("p2")],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.chooseEncoder("video", CUSTOM_ENCODER_VALUE);
      controller.chooseEncoder("audio", CUSTOM_ENCODER_VALUE);
      expect(controller.getView().videoEncoderIsCustom).toBe(true);
      expect(controller.getView().audioEncoderIsCustom).toBe(true);

      controller.select("p2");

      const view = controller.getView();
      expect(view.videoEncoderIsCustom).toBe(false);
      expect(view.audioEncoderIsCustom).toBe(false);
    });

    it("removes audioBitrate when choosing a lossless audio encoder", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { audioEncoder: "aac", audioBitrate: 256 })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      expect(controller.getView().draft?.audioBitrate).toBe(256);

      controller.chooseEncoder("audio", "flac");

      const view = controller.getView();
      expect(view.draft?.audioEncoder).toBe("flac");
      expect("audioBitrate" in (view.draft ?? {})).toBe(false);
      expect(view.draft?.audioBitrate).toBeUndefined();
      expect(view.dirty).toBe(true);
    });

    it("sets DEFAULT_AUDIO_BITRATE_KBPS when switching from a lossless encoder to a non-lossless encoder with no bitrate stored", () => {
      const presetWithoutBitrate = createPreset("p1", { audioEncoder: "flac" });
      delete presetWithoutBitrate.audioBitrate;
      const settings = createSettings({ presets: [presetWithoutBitrate] });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      expect(controller.getView().draft?.audioBitrate).toBeUndefined();

      controller.chooseEncoder("audio", "aac");

      const view = controller.getView();
      expect(view.draft?.audioEncoder).toBe("aac");
      expect(view.draft?.audioBitrate).toBe(DEFAULT_AUDIO_BITRATE_KBPS);
      expect(view.dirty).toBe(true);
    });

    it("preserves existing audioBitrate when switching between non-lossless encoders", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { audioEncoder: "aac", audioBitrate: 192 })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.chooseEncoder("audio", "libopus");

      const view = controller.getView();
      expect(view.draft?.audioEncoder).toBe("libopus");
      expect(view.draft?.audioBitrate).toBe(192);
      expect(view.dirty).toBe(true);
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.chooseEncoder("video", CUSTOM_ENCODER_VALUE);

      const view = controller.getView();
      expect(view.videoEncoderIsCustom).toBe(false);
      expect(view.draft).toBeNull();
    });
  });

  describe("setEncoderName", () => {
    it("stores the video encoder name verbatim, without trimming, yielding a charset issue for a padded name", () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setEncoderName("video", " libx264 ");

      const view = controller.getView();
      expect(view.draft?.videoEncoder).toBe(" libx264 ");
      expect(view.issues).toContainEqual({ field: "videoEncoder", code: "charset" });
      expect(view.dirty).toBe(true);
    });

    it("stores the audio encoder name verbatim the same way", () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setEncoderName("audio", " aac ");

      const view = controller.getView();
      expect(view.draft?.audioEncoder).toBe(" aac ");
      expect(view.issues).toContainEqual({ field: "audioEncoder", code: "charset" });
    });

    it("does not clear audioBitrate when typing a lossless encoder name in the free-text field", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { audioEncoder: "aac", audioBitrate: 320 })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setEncoderName("audio", "alac");

      const view = controller.getView();
      expect(view.draft?.audioEncoder).toBe("alac");
      expect(view.draft?.audioBitrate).toBe(320);
      expect(view.dirty).toBe(true);
    });

    it("does not reset audioBitrate when typing a non-lossless encoder name in the free-text field", () => {
      const presetWithoutBitrate = createPreset("p1", { audioEncoder: "alac" });
      delete presetWithoutBitrate.audioBitrate;
      const settings = createSettings({ presets: [presetWithoutBitrate] });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setEncoderName("audio", "libmp3lame");

      const view = controller.getView();
      expect(view.draft?.audioEncoder).toBe("libmp3lame");
      expect("audioBitrate" in (view.draft ?? {})).toBe(false);
      expect(view.dirty).toBe(true);
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.setEncoderName("video", "libx264");

      expect(controller.getView().draft).toBeNull();
      expect(controller.getView().dirty).toBe(false);
    });
  });

  describe("setAudioBitrate", () => {
    it("sets the draft audio bitrate, recomputes issues, and marks dirty", () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setAudioBitrate(192);

      const view = controller.getView();
      expect(view.draft?.audioBitrate).toBe(192);
      expect(view.dirty).toBe(true);
      expect(view.issues).toEqual([]);
    });

    it("removes the audioBitrate key completely when null is passed", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { audioBitrate: 320 })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setAudioBitrate(null);

      const view = controller.getView();
      expect("audioBitrate" in (view.draft ?? {})).toBe(false);
      expect(view.draft?.audioBitrate).toBeUndefined();
      expect(view.dirty).toBe(true);
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.setAudioBitrate(192);
      expect(controller.getView().draft).toBeNull();
    });
  });

  describe("setAudioSampleRate", () => {
    it("sets the draft audio sample rate, recomputes issues, and marks dirty", () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setAudioSampleRate(44100);

      let view = controller.getView();
      expect(view.draft?.audioSampleRate).toBe(44100);
      expect(view.dirty).toBe(true);

      controller.setAudioSampleRate("source");
      view = controller.getView();
      expect(view.draft?.audioSampleRate).toBe("source");
      expect(view.dirty).toBe(true);
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.setAudioSampleRate(48000);
      expect(controller.getView().draft).toBeNull();
    });
  });

  describe("setAudioChannels", () => {
    it("sets the draft audio channels, recomputes issues, and marks dirty", () => {
      const settings = createSettings({ presets: [createPreset("p1")] });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setAudioChannels("stereo");

      let view = controller.getView();
      expect(view.draft?.audioChannels).toBe("stereo");
      expect(view.dirty).toBe(true);

      controller.setAudioChannels("mono");
      view = controller.getView();
      expect(view.draft?.audioChannels).toBe("mono");

      controller.setAudioChannels("source");
      view = controller.getView();
      expect(view.draft?.audioChannels).toBe("source");
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.setAudioChannels("stereo");
      expect(controller.getView().draft).toBeNull();
    });
  });

  describe("setQualityKind", () => {
    it("replaces the value with the new kind's default rather than carrying the old value across", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { quality: { kind: "crf", value: 20 } })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setQualityKind("bitrate");

      const view = controller.getView();
      expect(view.draft?.quality).toEqual({
        kind: "bitrate",
        value: defaultQualityValue("bitrate"),
      });
      expect(view.dirty).toBe(true);
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.setQualityKind("bitrate");

      expect(controller.getView().draft).toBeNull();
      expect(controller.getView().dirty).toBe(false);
    });
  });

  describe("updateQualityValue", () => {
    it("stores a valid parsed integer and leaves canSave true", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { quality: { kind: "crf", value: 20 } })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.updateQualityValue("30");

      const view = controller.getView();
      expect(view.draft?.quality.value).toBe(30);
      expect(view.dirty).toBe(true);
      expect(view.canSave).toBe(true);
    });

    // PINNED: clearing the field must store NaN, never 0 -- Number("") === 0 in JavaScript,
    // and QUALITY_RANGES.crf.min === 0, so coercing a blank field to a number would silently
    // write a valid CRF 0 and leave Save enabled.
    it("stores NaN, not 0, for a blank value, producing a notInteger issue and disabling Save", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { quality: { kind: "crf", value: 20 } })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.updateQualityValue("");

      const view = controller.getView();
      expect(Number.isNaN(view.draft?.quality.value)).toBe(true);
      expect(view.draft?.quality.value).not.toBe(0);
      expect(view.issues).toContainEqual({ field: "quality", code: "notInteger" });
      expect(view.canSave).toBe(false);
    });

    it.each(["abc", "1.5", "  "])(
      "behaves the same way as a blank value for %j: stores NaN, notInteger, canSave false",
      (raw) => {
        const settings = createSettings({
          presets: [createPreset("p1", { quality: { kind: "crf", value: 20 } })],
        });
        const controller = createPresetLibraryController({
          getSettings: () => settings,
          saveSettings: vi.fn(),
        });

        controller.select("p1");
        controller.updateQualityValue(raw);

        const view = controller.getView();
        expect(Number.isNaN(view.draft?.quality.value)).toBe(true);
        expect(view.issues).toContainEqual({ field: "quality", code: "notInteger" });
        expect(view.canSave).toBe(false);
      },
    );

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.updateQualityValue("30");

      expect(controller.getView().draft).toBeNull();
      expect(controller.getView().dirty).toBe(false);
    });
  });

  describe("setResolutionMode", () => {
    it("switches to DEFAULT_CUSTOM_RESOLUTION", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { resolution: "source" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setResolutionMode("custom");

      const view = controller.getView();
      expect(view.draft?.resolution).toEqual(DEFAULT_CUSTOM_RESOLUTION);
      expect(view.resolutionMode).toBe("custom");
      expect(view.dirty).toBe(true);
    });

    it("switches back to the literal string 'source'", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { resolution: { w: 1280, h: 720 } })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setResolutionMode("source");

      const view = controller.getView();
      expect(view.draft?.resolution).toBe("source");
      expect(view.resolutionMode).toBe("source");
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.setResolutionMode("custom");

      expect(controller.getView().draft).toBeNull();
      expect(controller.getView().dirty).toBe(false);
    });
  });

  describe("updateResolutionField", () => {
    it("parses a valid width, carrying the height through unchanged", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { resolution: { w: 1920, h: 1080 } })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.updateResolutionField("w", "1280");

      const view = controller.getView();
      expect(view.draft?.resolution).toEqual({ w: 1280, h: 1080 });
      expect(view.dirty).toBe(true);
    });

    it.each(["", "abc", "1.5", "  "])(
      "stores NaN, not 0, for %j on either field, producing a notInteger issue",
      (raw) => {
        const settings = createSettings({
          presets: [createPreset("p1", { resolution: { w: 1920, h: 1080 } })],
        });
        const controller = createPresetLibraryController({
          getSettings: () => settings,
          saveSettings: vi.fn(),
        });

        controller.select("p1");
        controller.updateResolutionField("w", raw);

        const view = controller.getView();
        expect(
          view.draft?.resolution !== "source" && Number.isNaN(view.draft?.resolution.w),
        ).toBe(true);
        expect(
          view.draft?.resolution !== "source" && view.draft?.resolution.w,
        ).not.toBe(0);
        expect(view.issues).toContainEqual({ field: "resolution", code: "notInteger" });
        expect(view.canSave).toBe(false);
      },
    );

    it("falls back to DEFAULT_CUSTOM_RESOLUTION for the carried-through dimension when resolution is still 'source'", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { resolution: "source" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.updateResolutionField("w", "640");

      const view = controller.getView();
      expect(view.draft?.resolution).toEqual({
        w: 640,
        h: DEFAULT_CUSTOM_RESOLUTION.h,
      });
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.updateResolutionField("w", "640");

      expect(controller.getView().draft).toBeNull();
      expect(controller.getView().dirty).toBe(false);
    });
  });

  describe("setFrameRateMode", () => {
    it("switches to DEFAULT_CUSTOM_FRAME_RATE", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { frameRate: "source" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setFrameRateMode("custom");

      const view = controller.getView();
      expect(view.draft?.frameRate).toEqual(DEFAULT_CUSTOM_FRAME_RATE);
      expect(view.frameRateMode).toBe("custom");
      expect(view.dirty).toBe(true);
    });

    it("switches back to the literal string 'source'", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { frameRate: { n: 24, d: 1 } })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.setFrameRateMode("source");

      const view = controller.getView();
      expect(view.draft?.frameRate).toBe("source");
      expect(view.frameRateMode).toBe("source");
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.setFrameRateMode("custom");

      expect(controller.getView().draft).toBeNull();
      expect(controller.getView().dirty).toBe(false);
    });
  });

  describe("updateFrameRateField", () => {
    it("parses a valid numerator, carrying the denominator through unchanged", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { frameRate: { n: 30, d: 1 } })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.updateFrameRateField("n", "24");

      const view = controller.getView();
      expect(view.draft?.frameRate).toEqual({ n: 24, d: 1 });
      expect(view.dirty).toBe(true);
    });

    it.each(["", "abc", "1.5", "  "])(
      "stores NaN, not 0, for %j on either field, producing a notInteger issue",
      (raw) => {
        const settings = createSettings({
          presets: [createPreset("p1", { frameRate: { n: 30, d: 1 } })],
        });
        const controller = createPresetLibraryController({
          getSettings: () => settings,
          saveSettings: vi.fn(),
        });

        controller.select("p1");
        controller.updateFrameRateField("n", raw);

        const view = controller.getView();
        expect(
          view.draft?.frameRate !== "source" && Number.isNaN(view.draft?.frameRate.n),
        ).toBe(true);
        expect(view.draft?.frameRate !== "source" && view.draft?.frameRate.n).not.toBe(
          0,
        );
        expect(view.issues).toContainEqual({ field: "frameRate", code: "notInteger" });
        expect(view.canSave).toBe(false);
      },
    );

    it("falls back to DEFAULT_CUSTOM_FRAME_RATE for the carried-through component when frame rate is still 'source'", () => {
      const settings = createSettings({
        presets: [createPreset("p1", { frameRate: "source" })],
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
      });

      controller.select("p1");
      controller.updateFrameRateField("n", "60");

      const view = controller.getView();
      expect(view.draft?.frameRate).toEqual({
        n: 60,
        d: DEFAULT_CUSTOM_FRAME_RATE.d,
      });
    });

    it("is a no-op when there is no draft", () => {
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings: vi.fn(),
      });

      controller.updateFrameRateField("n", "60");

      expect(controller.getView().draft).toBeNull();
      expect(controller.getView().dirty).toBe(false);
    });
  });
});
