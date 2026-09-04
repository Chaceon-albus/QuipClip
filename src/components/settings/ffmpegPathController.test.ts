import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFfmpegPathController,
  FfmpegPathController,
} from "./ffmpegPathController";
import { settingsStore } from "@/features/settings/store";
import type { Preset, Settings } from "@/features/settings/types";
import type { OpenFfmpegPathDialogOptions } from "@/features/settings/dialog";

/**
 * Builds a preset for tests. Every field carries a deterministic default so a test overrides
 * only the field it cares about. Matches the helper in `presetLibraryController.test.ts`.
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
 * Creates a deferred promise helper to control async execution in tests, matching the helper
 * used by `languageMenuController.test.ts` and `presetLibraryController.test.ts`.
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

describe("FfmpegPathController", () => {
  describe("construction", () => {
    it("constructs with no options and reports a safe empty view", () => {
      const controller = new FfmpegPathController();
      const view = controller.getView();

      expect(view.path).toBeNull();
      expect(view.pending).toBe(false);
    });

    it("createFfmpegPathController builds a working controller", async () => {
      const settings = createSettings();
      const saveSettings = vi
        .fn()
        .mockResolvedValue(createSettings({ ffmpegPath: "/opt/ffmpeg/bin" }));
      const startProbe = vi.fn().mockResolvedValue(undefined);
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings,
        startProbe,
        openDialog: vi.fn().mockResolvedValue("/opt/ffmpeg/bin"),
      });

      const result = await controller.choose("directory");

      expect(result).toBe(true);
      expect(controller.getView().path).toBe("/opt/ffmpeg/bin");
    });
  });

  // RULE 1 -- the capability report is cached. Without force, the application keeps reporting
  // the OLD ffmpeg's encoders, so pointing at a new binary would look ignored.
  describe("RULE 1: force re-probe after a successful save", () => {
    it("calls startProbe with force === true after choose() saves successfully", async () => {
      const settings = createSettings();
      const saved = createSettings({ ffmpegPath: "/opt/ffmpeg/bin/ffmpeg" });
      const saveSettings = vi.fn().mockResolvedValue(saved);
      const startProbe = vi.fn().mockResolvedValue(undefined);
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings,
        startProbe,
        openDialog: vi.fn().mockResolvedValue("/opt/ffmpeg/bin/ffmpeg"),
      });

      const result = await controller.choose("file");

      expect(result).toBe(true);
      expect(startProbe).toHaveBeenCalledTimes(1);
      // Assert the ARGUMENT, not merely that startProbe was called: calling it with no
      // argument (or with false) would silently keep serving the cached, stale report.
      expect(startProbe).toHaveBeenCalledWith(true);
    });

    it("calls startProbe with force === true after clear() saves successfully", async () => {
      const settings = createSettings({ ffmpegPath: "/usr/bin/ffmpeg" });
      const saved = createSettings();
      const saveSettings = vi.fn().mockResolvedValue(saved);
      const startProbe = vi.fn().mockResolvedValue(undefined);
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings,
        startProbe,
      });

      const result = await controller.clear();

      expect(result).toBe(true);
      expect(startProbe).toHaveBeenCalledWith(true);
    });
  });

  // RULE 2 -- the whole document is written every time. Only ffmpegPath changes; schemaVersion,
  // presets, and activePresetId must survive a path change untouched.
  describe("RULE 2: writes the whole document, preserving everything else", () => {
    it("preserves presets and activePresetId across a choose() path change", async () => {
      const presets = [createPreset("p1")];
      const settings = createSettings({ presets, activePresetId: "p1" });
      const saveSettings = vi
        .fn()
        .mockImplementation((next: Settings) => Promise.resolve(next));
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings,
        startProbe: vi.fn().mockResolvedValue(undefined),
        openDialog: vi.fn().mockResolvedValue("/opt/ffmpeg/bin/ffmpeg"),
      });

      const result = await controller.choose("directory");

      expect(result).toBe(true);
      const sent = saveSettings.mock.calls[0]?.[0] as Settings;
      expect(sent.schemaVersion).toBe(1);
      expect(sent.presets).toBe(presets);
      expect(sent.activePresetId).toBe("p1");
      expect(sent.ffmpegPath).toBe("/opt/ffmpeg/bin/ffmpeg");
    });
  });

  // FIX 1 -- choose() must not write a settings snapshot taken before the dialog opened. The
  // dialog await can last as long as the user browses the filesystem; any preset add, edit,
  // delete, restore, or activePresetId change that lands during that window must survive.
  describe("FIX 1: choose() re-reads settings after the dialog resolves", () => {
    it("includes a preset added while the dialog was open in the saved document", async () => {
      const p1 = createPreset("p1");
      const p2 = createPreset("p2");
      let currentSettings = createSettings({ presets: [p1], activePresetId: "p1" });
      const dialog = createDeferred<string | null>();
      const saveSettings = vi
        .fn()
        .mockImplementation((next: Settings) => Promise.resolve(next));
      const controller = createFfmpegPathController({
        getSettings: () => currentSettings,
        saveSettings,
        startProbe: vi.fn().mockResolvedValue(undefined),
        openDialog: vi.fn().mockReturnValue(dialog.promise),
      });

      const pending = controller.choose("file");

      // While the native picker is still open, a preset add lands elsewhere in the app.
      currentSettings = createSettings({
        presets: [p1, p2],
        activePresetId: "p1",
      });

      dialog.resolve("/opt/ffmpeg/bin/ffmpeg");
      const result = await pending;

      expect(result).toBe(true);
      const sent = saveSettings.mock.calls[0]?.[0] as Settings;
      expect(sent.presets).toEqual([p1, p2]);
      expect(sent.ffmpegPath).toBe("/opt/ffmpeg/bin/ffmpeg");
    });

    it("returns false without saving when the document becomes null while the dialog was open", async () => {
      let currentSettings: Settings | null = createSettings();
      const dialog = createDeferred<string | null>();
      const saveSettings = vi.fn();
      const controller = createFfmpegPathController({
        getSettings: () => currentSettings,
        saveSettings,
        startProbe: vi.fn(),
        openDialog: vi.fn().mockReturnValue(dialog.promise),
      });

      const pending = controller.choose("file");
      currentSettings = null;
      dialog.resolve("/opt/ffmpeg/bin/ffmpeg");

      expect(await pending).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
    });
  });

  // FIX 2 -- the write already succeeded, so the new path is authoritative. Showing the OLD
  // path for the whole probe duration would contradict the write that just landed.
  describe("FIX 2: the displayed path updates before the probe, not after", () => {
    it("reports the new path in getView() while the probe is still pending", async () => {
      const settings = createSettings();
      const saved = createSettings({ ffmpegPath: "/opt/ffmpeg/bin/ffmpeg" });
      const probe = createDeferred<unknown>();
      const startProbe = vi.fn().mockReturnValue(probe.promise);
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings: vi.fn().mockResolvedValue(saved),
        startProbe,
        openDialog: vi.fn().mockResolvedValue("/opt/ffmpeg/bin/ffmpeg"),
      });

      const pending = controller.choose("file");

      // Flush microtasks until startProbe has actually been invoked. The path assignment
      // happens synchronously right before that call, so this is a deterministic checkpoint
      // regardless of exactly how many microtask turns openDialog/saveSettings consume.
      for (let i = 0; i < 20 && startProbe.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(startProbe).toHaveBeenCalledTimes(1);

      const view = controller.getView();
      expect(view.path).toBe("/opt/ffmpeg/bin/ffmpeg");
      expect(view.pending).toBe(true);

      probe.resolve(undefined);
      await pending;
    });
  });

  // FIX 3 -- pendingCount reported the in-flight state but did not gate it. Two choose() (or
  // choose()/clear()) calls in flight would open two native dialogs and issue two whole-document
  // writes, each racing from its own snapshot.
  describe("FIX 3: refuses a second concurrent choose or clear", () => {
    it("choose() returns false immediately, opening no second dialog, while a choose() is in flight", async () => {
      const settings = createSettings();
      const dialog = createDeferred<string | null>();
      const openDialog = vi.fn().mockReturnValue(dialog.promise);
      const saveSettings = vi.fn();
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings,
        startProbe: vi.fn(),
        openDialog,
      });

      const first = controller.choose("file");
      const second = await controller.choose("file");

      expect(second).toBe(false);
      expect(openDialog).toHaveBeenCalledTimes(1);

      dialog.resolve(null);
      await first;
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("clear() returns false immediately, performing no save, while a choose() is in flight", async () => {
      const settings = createSettings({ ffmpegPath: "/usr/bin/ffmpeg" });
      const dialog = createDeferred<string | null>();
      const saveSettings = vi.fn();
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings,
        startProbe: vi.fn(),
        openDialog: vi.fn().mockReturnValue(dialog.promise),
      });

      const choosing = controller.choose("file");
      const clearResult = await controller.clear();

      expect(clearResult).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();

      dialog.resolve(null);
      await choosing;
    });

    it("choose() returns false immediately, opening no dialog, while a clear() is in flight", async () => {
      const settings = createSettings({ ffmpegPath: "/usr/bin/ffmpeg" });
      const saveDeferred = createDeferred<Settings | null>();
      const openDialog = vi.fn();
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings: vi.fn().mockReturnValue(saveDeferred.promise),
        startProbe: vi.fn(),
        openDialog,
      });

      const clearing = controller.clear();
      const chooseResult = await controller.choose("file");

      expect(chooseResult).toBe(false);
      expect(openDialog).not.toHaveBeenCalled();

      saveDeferred.resolve(createSettings());
      await clearing;
    });
  });

  // RULE 3 -- clearing means the key is ABSENT: not an empty string, not null. Rust rejects a
  // blank path with InvalidFfmpegPath, so writing "" would make the setting impossible to clear.
  describe("RULE 3: clear() produces a document with no ffmpegPath key", () => {
    it("writes a document with the ffmpegPath key entirely absent", async () => {
      const settings = createSettings({
        ffmpegPath: "/usr/bin/ffmpeg",
        presets: [],
        activePresetId: "p1",
      });
      const saveSettings = vi
        .fn()
        .mockImplementation((next: Settings) => Promise.resolve(next));
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings,
        startProbe: vi.fn().mockResolvedValue(undefined),
      });

      const result = await controller.clear();

      expect(result).toBe(true);
      const sent = saveSettings.mock.calls[0]?.[0] as Settings;
      expect("ffmpegPath" in sent).toBe(false);
      expect(sent).toStrictEqual({
        schemaVersion: 1,
        presets: [],
        activePresetId: "p1",
      });
    });

    it("succeeds when the document already has no configured path", async () => {
      const settings = createSettings();
      const saveSettings = vi
        .fn()
        .mockImplementation((next: Settings) => Promise.resolve(next));
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings,
        startProbe: vi.fn().mockResolvedValue(undefined),
      });

      const result = await controller.clear();

      expect(result).toBe(true);
      expect(saveSettings).toHaveBeenCalledTimes(1);
      const sent = saveSettings.mock.calls[0]?.[0] as Settings;
      expect("ffmpegPath" in sent).toBe(false);
      expect(sent).toStrictEqual({ schemaVersion: 1, presets: [] });
    });
  });

  // RULE 4 -- cancel changes nothing: no save, no probe, and choose() returns false.
  describe("RULE 4: cancel performs no save and no probe", () => {
    it("returns false and performs no IPC when the dialog resolves null", async () => {
      const settings = createSettings();
      const saveSettings = vi.fn();
      const startProbe = vi.fn();
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings,
        startProbe,
        openDialog: vi.fn().mockResolvedValue(null),
      });

      const result = await controller.choose("file");

      expect(result).toBe(false);
      expect(saveSettings).not.toHaveBeenCalled();
      expect(startProbe).not.toHaveBeenCalled();
    });
  });

  describe("choose() ordering and mode passthrough", () => {
    it("saves then probes, in that order", async () => {
      const settings = createSettings();
      const saved = createSettings({ ffmpegPath: "/opt/ffmpeg/bin/ffmpeg" });
      const callOrder: string[] = [];
      const saveSettings = vi.fn().mockImplementation(() => {
        callOrder.push("save");
        return Promise.resolve(saved);
      });
      const startProbe = vi.fn().mockImplementation(() => {
        callOrder.push("probe");
        return Promise.resolve(undefined);
      });
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings,
        startProbe,
        openDialog: vi.fn().mockResolvedValue("/opt/ffmpeg/bin/ffmpeg"),
      });

      const result = await controller.choose("directory");

      expect(result).toBe(true);
      // Probing before the write would race the file: the save must be recorded first.
      expect(callOrder).toEqual(["save", "probe"]);
    });

    it("passes mode: 'file' through to the dialog with no filters option", async () => {
      const settings = createSettings();
      const openDialog = vi
        .fn<(options: OpenFfmpegPathDialogOptions) => Promise<string | null>>()
        .mockResolvedValue("/usr/bin/ffmpeg");
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings: vi
          .fn()
          .mockResolvedValue(createSettings({ ffmpegPath: "/usr/bin/ffmpeg" })),
        startProbe: vi.fn().mockResolvedValue(undefined),
        openDialog,
      });

      await controller.choose("file");

      expect(openDialog).toHaveBeenCalledTimes(1);
      const passed = openDialog.mock.calls[0]?.[0];
      expect(passed).toEqual({ mode: "file" });
      expect(passed).not.toHaveProperty("filters");
    });

    it("passes mode: 'directory' through to the dialog", async () => {
      const settings = createSettings();
      const openDialog = vi.fn().mockResolvedValue(null);
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings: vi.fn(),
        startProbe: vi.fn(),
        openDialog,
      });

      await controller.choose("directory");

      expect(openDialog).toHaveBeenCalledWith({ mode: "directory" });
    });
  });

  describe("failed save", () => {
    it("returns false and starts no probe when saveSettings resolves null", async () => {
      const settings = createSettings();
      const saveSettings = vi.fn().mockResolvedValue(null);
      const startProbe = vi.fn();
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings,
        startProbe,
        openDialog: vi.fn().mockResolvedValue("/opt/ffmpeg/bin/ffmpeg"),
      });

      const result = await controller.choose("directory");

      expect(result).toBe(false);
      expect(saveSettings).toHaveBeenCalledTimes(1);
      expect(startProbe).not.toHaveBeenCalled();
    });

    it("leaves the displayed path untouched on a failed clear()", async () => {
      const settings = createSettings({ ffmpegPath: "/usr/bin/ffmpeg" });
      const saveSettings = vi.fn().mockResolvedValue(null);
      const startProbe = vi.fn();
      const onChange = vi.fn();
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings,
        startProbe,
        onChange,
      });

      controller.syncFromSettings(settings);
      const result = await controller.clear();

      expect(result).toBe(false);
      expect(startProbe).not.toHaveBeenCalled();
      expect(controller.getView().path).toBe("/usr/bin/ffmpeg");
    });
  });

  describe("getSettings returning null", () => {
    it("makes choose() and clear() safe no-ops returning false", async () => {
      const saveSettings = vi.fn();
      const startProbe = vi.fn();
      const openDialog = vi.fn();
      const controller = createFfmpegPathController({
        getSettings: () => null,
        saveSettings,
        startProbe,
        openDialog,
      });

      await expect(controller.choose("file")).resolves.toBe(false);
      await expect(controller.clear()).resolves.toBe(false);

      expect(saveSettings).not.toHaveBeenCalled();
      expect(startProbe).not.toHaveBeenCalled();
      expect(openDialog).not.toHaveBeenCalled();
    });
  });

  describe("syncFromSettings", () => {
    it("updates the view path from the given document", () => {
      const onChange = vi.fn();
      const controller = createFfmpegPathController({ onChange });

      controller.syncFromSettings(createSettings({ ffmpegPath: "/usr/bin/ffmpeg" }));

      expect(controller.getView().path).toBe("/usr/bin/ffmpeg");
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/usr/bin/ffmpeg" }),
      );
    });

    it("yields path: null for a null document", () => {
      const controller = createFfmpegPathController();

      controller.syncFromSettings(createSettings({ ffmpegPath: "/usr/bin/ffmpeg" }));
      expect(controller.getView().path).toBe("/usr/bin/ffmpeg");

      controller.syncFromSettings(null);
      expect(controller.getView().path).toBeNull();
    });
  });

  describe("pending flag", () => {
    it("is true synchronously once choose() starts and false once it settles", async () => {
      const settings = createSettings();
      const deferred = createDeferred<Settings | null>();
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings: vi.fn().mockReturnValue(deferred.promise),
        startProbe: vi.fn().mockResolvedValue(undefined),
        openDialog: vi.fn().mockResolvedValue("/usr/bin/ffmpeg"),
      });

      expect(controller.getView().pending).toBe(false);
      const promise = controller.choose("file");

      // pendingCount is incremented synchronously, before the first await.
      expect(controller.getView().pending).toBe(true);

      deferred.resolve(createSettings({ ffmpegPath: "/usr/bin/ffmpeg" }));
      await promise;

      expect(controller.getView().pending).toBe(false);
    });

    // FIX 5 (property 2) -- pendingCount-- is correctly in a `finally`, but nothing previously
    // drove a rejecting injected function through it. `createDeferred`'s `reject` handle exists
    // for exactly this and was unused.
    it("releases pending back to false when saveSettings rejects", async () => {
      const settings = createSettings();
      const deferred = createDeferred<Settings | null>();
      const controller = createFfmpegPathController({
        getSettings: () => settings,
        saveSettings: vi.fn().mockReturnValue(deferred.promise),
        startProbe: vi.fn().mockResolvedValue(undefined),
        openDialog: vi.fn().mockResolvedValue("/usr/bin/ffmpeg"),
      });

      const promise = controller.choose("file");
      expect(controller.getView().pending).toBe(true);

      deferred.reject(new Error("boom"));

      await expect(promise).rejects.toThrow("boom");
      expect(controller.getView().pending).toBe(false);
    });
  });

  describe("lifecycle", () => {
    it("emits no onChange while deactivated; the divergence is emitted on activate()", () => {
      const onChange = vi.fn();
      const controller = createFfmpegPathController({ onChange });

      controller.deactivate();
      controller.syncFromSettings(createSettings({ ffmpegPath: "/usr/bin/ffmpeg" }));
      expect(onChange).not.toHaveBeenCalled();

      controller.activate();
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/usr/bin/ffmpeg" }),
      );
    });

    it("activate() twice in a row is safe (React StrictMode double-mount)", () => {
      const onChange = vi.fn();
      const controller = createFfmpegPathController({ onChange });

      expect(() => {
        controller.activate();
        controller.activate();
      }).not.toThrow();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("dispose() suppresses onChange like deactivate()", () => {
      const onChange = vi.fn();
      const controller = createFfmpegPathController({ onChange });

      controller.dispose();
      controller.syncFromSettings(createSettings({ ffmpegPath: "/usr/bin/ffmpeg" }));
      expect(onChange).not.toHaveBeenCalled();

      controller.activate();
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    // FIX 4 -- needsNotify used to be set by ANY notify() while deactivated, including a
    // syncFromSettings that produced an identical path, so activate() fired a spurious
    // onChange. It must fire only on real divergence, following LanguageMenuController's
    // lastNotifiedPreference idiom.
    it("FIX 4: does not emit onChange on activate() when the path did not actually change while deactivated", () => {
      const onChange = vi.fn();
      const controller = createFfmpegPathController({ onChange });

      // Establish a confirmed, already-notified path while active.
      controller.syncFromSettings(createSettings({ ffmpegPath: "/usr/bin/ffmpeg" }));
      expect(onChange).toHaveBeenCalledTimes(1);
      onChange.mockClear();

      controller.deactivate();
      // Same path as before: nothing actually diverged.
      controller.syncFromSettings(createSettings({ ffmpegPath: "/usr/bin/ffmpeg" }));
      controller.activate();

      expect(onChange).not.toHaveBeenCalled();
    });

    it("FIX 4: still emits onChange on activate() when the path genuinely changed while deactivated", () => {
      const onChange = vi.fn();
      const controller = createFfmpegPathController({ onChange });

      controller.syncFromSettings(createSettings({ ffmpegPath: "/usr/bin/ffmpeg" }));
      onChange.mockClear();

      controller.deactivate();
      controller.syncFromSettings(
        createSettings({ ffmpegPath: "/opt/ffmpeg/bin/ffmpeg" }),
      );
      controller.activate();

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/opt/ffmpeg/bin/ffmpeg" }),
      );
    });
  });

  // FIX 5 (property 1) -- rewriting the production defaults to capture
  // `settingsStore.getState().settings` once at construction leaves every OTHER test in this
  // file green, because every other test injects its own `getSettings`. Only exercising the
  // real, uninjected default catches that regression.
  describe("FIX 5: call-time default resolution of getSettings", () => {
    afterEach(() => {
      settingsStore.getState().reset();
    });

    it("reads settingsStore.getState().settings fresh on each call, not a value captured at construction", async () => {
      settingsStore.getState().reset();

      // No `getSettings` override here: the controller must fall through to the PRODUCTION
      // default. The other collaborators are still injected so no real IPC runs.
      const controller = createFfmpegPathController({
        saveSettings: vi
          .fn()
          .mockImplementation((next: Settings) => Promise.resolve(next)),
        startProbe: vi.fn().mockResolvedValue(undefined),
        openDialog: vi.fn().mockResolvedValue("/usr/bin/ffmpeg"),
      });

      // At construction time the store has no settings document yet.
      expect(await controller.choose("file")).toBe(false);

      // The document loads into the store AFTER construction. A default captured once at
      // construction time (`const settings = settingsStore.getState().settings`) would never
      // observe this; only a closure re-reading the store on each call does.
      settingsStore.setState({ settings: createSettings() });

      expect(await controller.choose("file")).toBe(true);
    });
  });
});
