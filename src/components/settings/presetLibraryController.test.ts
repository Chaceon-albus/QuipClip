import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CUSTOM_FRAME_RATE,
  DEFAULT_CUSTOM_RESOLUTION,
} from "@/features/settings/presetDocument";
import { defaultQualityValue, isValidEncoderName } from "@/features/settings/limits";
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
 * Returns a deterministic id generator producing "id-1", "id-2", ... in call order. Tests
 * never rely on `crypto.randomUUID`.
 */
function makeIdGenerator(): () => string {
  let counter = 0;
  return () => `id-${++counter}`;
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

      const result = await controller.addPreset("One too many");

      expect(result).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("uses the injected id and the passed name, and selects the new preset", async () => {
      let settings = createSettings({ presets: [createPreset("existing")] });
      const saveSettings = vi.fn().mockImplementation((next: Settings) => {
        settings = next;
        return Promise.resolve(next);
      });
      const controller = createPresetLibraryController({
        getSettings: () => settings,
        saveSettings,
        generateId: makeIdGenerator(),
      });

      const result = await controller.addPreset("My Preset");

      expect(result).toBe(true);
      expect(saveSettings).toHaveBeenCalledTimes(1);
      const view = controller.getView();
      expect(view.selectedPresetId).toBe("id-1");
      expect(view.draft?.id).toBe("id-1");
      expect(view.draft?.name).toBe("My Preset");
    });

    it("returns false and performs no IPC when there is no settings document", async () => {
      const saveSettings = vi.fn();
      const controller = createPresetLibraryController({
        getSettings: () => null,
        saveSettings,
      });

      const result = await controller.addPreset("Name");

      expect(result).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
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
      await expect(controller.addPreset("name")).resolves.toBe(false);
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
