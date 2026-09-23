import { describe, expect, it, vi } from "vitest";
import { createSettingsStore, settingsStore, useSettingsStore } from "./store";
import {
  SettingsError,
  type LoadSettingsResult,
  type Preset,
  type Settings,
} from "./types";

function createValidPreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "default-h264-mp4",
    name: "H.264 MP4",
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

function createValidSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    schemaVersion: 1,
    revision: 0,
    ffmpegPath: undefined,
    presets: [createValidPreset()],
    activePresetId: "default-h264-mp4",
    ...overrides,
  };
}

function createValidLoadResult(
  overrides: Partial<LoadSettingsResult> = {},
): LoadSettingsResult {
  return {
    settings: createValidSettings(),
    seeded: false,
    ...overrides,
  };
}

describe("Settings Store", () => {
  describe("Initial State", () => {
    it("starts with idle status, null settings, seeded false, and null error", () => {
      const store = createSettingsStore();
      const state = store.getState();

      expect(state.status).toBe("idle");
      expect(state.settings).toBeNull();
      expect(state.seeded).toBe(false);
      expect(state.error).toBeNull();
    });

    it("respects optional initial state parameters", () => {
      const initialSettings = createValidSettings({ activePresetId: "custom-id" });
      const store = createSettingsStore(
        {},
        {
          status: "ready",
          settings: initialSettings,
          seeded: true,
        },
      );
      const state = store.getState();

      expect(state.status).toBe("ready");
      expect(state.settings).toEqual(initialSettings);
      expect(state.seeded).toBe(true);
      expect(state.error).toBeNull();
    });
  });

  describe("Required Behavior Tests", () => {
    it("1. ORDERING: save(A) then save(B) with A resolving last leaves store holding B and receives A before B", async () => {
      const docA = createValidSettings({ activePresetId: "preset-A" });
      const docB = createValidSettings({ activePresetId: "preset-B" });

      let aResolved = false;
      let bReceivedBeforeAResolved = false;
      const calls: Settings[] = [];

      const saveSettingsMock = vi.fn(async (settings: Settings) => {
        calls.push(settings);
        if (settings.activePresetId === "preset-A") {
          await new Promise((resolve) => setTimeout(resolve, 30));
          aResolved = true;
          return settings;
        }
        if (!aResolved) {
          bReceivedBeforeAResolved = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return settings;
      });

      const store = createSettingsStore({ saveSettings: saveSettingsMock });

      const p1 = store.getState().saveSettings(docA);
      const p2 = store.getState().saveSettings(docB);

      await Promise.all([p1, p2]);

      expect(calls).toEqual([docA, docB]);
      expect(bReceivedBeforeAResolved).toBe(false);
      expect(saveSettingsMock).toHaveBeenNthCalledWith(1, docA);
      expect(saveSettingsMock).toHaveBeenNthCalledWith(2, docB);
      expect(store.getState().settings).toEqual(docB);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().error).toBeNull();
    });

    it("2. A rejected save restores the previously confirmed document and sets error", async () => {
      const confirmedDoc = createValidSettings({ activePresetId: "confirmed-doc" });
      const badDoc = createValidSettings({ activePresetId: "bad-doc" });

      const store = createSettingsStore(
        {
          saveSettings: vi
            .fn()
            .mockRejectedValue(
              new SettingsError({ code: "writeFailed", detail: "Disk write error" }),
            ),
        },
        {
          status: "ready",
          settings: confirmedDoc,
        },
      );

      const result = await store.getState().saveSettings(badDoc);

      expect(result).toBeNull();
      expect(store.getState().settings).toEqual(confirmedDoc);
      expect(store.getState().status).toBe("error");
      expect(store.getState().error).toBeInstanceOf(SettingsError);
      expect(store.getState().error?.code).toBe("writeFailed");
      expect(store.getState().error?.detail).toBe("Disk write error");
    });

    it("3. A rejected save that has ALREADY been superseded restores nothing and does not overwrite successor state", async () => {
      const initialDoc = createValidSettings({ activePresetId: "initial-doc" });
      const docA = createValidSettings({ activePresetId: "superseded-fail" });
      const docB = createValidSettings({ activePresetId: "successor-success" });

      let rejectA!: (err: unknown) => void;
      const promiseA = new Promise<Settings>((_, rej) => {
        rejectA = rej;
      });

      const saveSettingsMock = vi.fn((settings: Settings) => {
        if (settings.activePresetId === "superseded-fail") {
          return promiseA;
        }
        return Promise.resolve(settings);
      });

      const store = createSettingsStore(
        { saveSettings: saveSettingsMock },
        { status: "ready", settings: initialDoc },
      );

      const pA = store.getState().saveSettings(docA);
      expect(store.getState().settings).toEqual(docA);
      expect(store.getState().status).toBe("saving");

      const pB = store.getState().saveSettings(docB);
      expect(store.getState().settings).toEqual(docB);
      expect(store.getState().status).toBe("saving");

      rejectA(new SettingsError({ code: "writeFailed", detail: "A failed" }));
      await pA;

      expect(store.getState().settings).toEqual(docB);
      expect(store.getState().status).toBe("saving");
      expect(store.getState().error).toBeNull();

      await pB;
      expect(store.getState().settings).toEqual(docB);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().error).toBeNull();
    });

    it("4. The store adopts the document the command RETURNED, not the one it sent", async () => {
      const sentDoc = createValidSettings({
        ffmpegPath: undefined,
        activePresetId: "default-h264-mp4",
      });
      const returnedDoc = createValidSettings({
        ffmpegPath: "/opt/homebrew/bin/ffmpeg",
        activePresetId: "default-h264-mp4",
      });

      const store = createSettingsStore({
        saveSettings: vi.fn().mockResolvedValue(returnedDoc),
      });

      const result = await store.getState().saveSettings(sentDoc);

      expect(result).toEqual(returnedDoc);
      expect(store.getState().settings).toEqual(returnedDoc);
      expect(store.getState().settings?.ffmpegPath).toBe("/opt/homebrew/bin/ffmpeg");
      expect(store.getState().status).toBe("ready");
      expect(store.getState().error).toBeNull();
    });

    it("4a. The bumped revision propagates from each command's return value", async () => {
      // The store needs no revision handling of its own: it already assigns
      // `lastConfirmedSettings` and published state from each command's return value, and
      // Rust bumps `revision` in exactly that value (ADR 013). This pins that, because a
      // store that republished the document it SENT would leave the interface one revision
      // behind the file and every later save would be refused as a `settingsConflict`.
      const sentDoc = createValidSettings({ revision: 4 });

      const store = createSettingsStore({
        saveSettings: vi.fn().mockResolvedValue(createValidSettings({ revision: 5 })),
        restoreDefaultPresets: vi
          .fn()
          .mockResolvedValue(createValidSettings({ revision: 6 })),
        resetSettings: vi.fn().mockResolvedValue(createValidSettings({ revision: 1 })),
      });

      const saved = await store.getState().saveSettings(sentDoc);
      expect(saved?.revision).toBe(5);
      expect(store.getState().settings?.revision).toBe(5);

      const restored = await store.getState().restoreDefaultPresets();
      expect(restored?.revision).toBe(6);
      expect(store.getState().settings?.revision).toBe(6);

      const afterReset = await store.getState().resetSettings();
      expect(afterReset?.revision).toBe(1);
      expect(store.getState().settings?.revision).toBe(1);
    });

    it("4b. A settingsConflict rejection rolls back to the last confirmed document", async () => {
      // A genuine cross-process conflict: this save is refused whatever revision it carries,
      // which is the case the token exists for. The store surfaces the code and puts the
      // confirmed document back. The re-read that follows fails here, so the rollback is what
      // the user is left looking at.
      const confirmed = createValidSettings({ revision: 9 });
      const store = createSettingsStore(
        {
          saveSettings: vi
            .fn()
            .mockRejectedValue(new SettingsError({ code: "settingsConflict" })),
          loadSettings: vi
            .fn()
            .mockRejectedValue(new SettingsError({ code: "readFailed" })),
        },
        { status: "ready", settings: confirmed },
      );

      const result = await store
        .getState()
        .saveSettings(createValidSettings({ revision: 9, activePresetId: undefined }));

      expect(result).toBeNull();
      expect(store.getState().status).toBe("error");
      expect(store.getState().error?.code).toBe("settingsConflict");
      expect(store.getState().settings).toEqual(confirmed);
    });

    it("4c. A settingsConflict re-reads the file, and the next save is not refused again", async () => {
      // Without the re-read, `lastConfirmedSettings` keeps a revision the file has moved
      // past, so every later save in the session rebuilds from it and conflicts again -- the
      // session is wedged until the dialog is closed and reopened, which no message says.
      const confirmed = createValidSettings({ revision: 9 });
      const onDisk = createValidSettings({ revision: 12, activePresetId: undefined });
      const saveSettings = vi
        .fn()
        .mockRejectedValueOnce(new SettingsError({ code: "settingsConflict" }))
        .mockImplementation((next: Settings) =>
          Promise.resolve({ ...next, revision: next.revision + 1 }),
        );
      const loadSettings = vi
        .fn()
        .mockResolvedValue({ settings: onDisk, seeded: false });
      const store = createSettingsStore(
        { saveSettings, loadSettings },
        { status: "ready", settings: confirmed },
      );

      await store
        .getState()
        .saveSettings(createValidSettings({ revision: 9, ffmpegPath: "/opt/ffmpeg" }));

      // The re-read is queued behind the failed write, so it lands one turn later. The error
      // stays published: the edit did not reach disk, and the message is what says so.
      await vi.waitFor(() => {
        expect(store.getState().settings).toEqual(onDisk);
      });
      expect(store.getState().status).toBe("error");
      expect(store.getState().error?.code).toBe("settingsConflict");

      const retried = await store
        .getState()
        .saveSettings(createValidSettings({ revision: 12, ffmpegPath: "/opt/ffmpeg" }));
      expect(retried?.revision).toBe(13);
      expect(store.getState().status).toBe("ready");
    });

    it("4d. A second edit made inside one round trip is re-based, not refused", async () => {
      // `settings` is published optimistically, so between the send and the reply it carries a
      // revision the in-flight write is about to spend. Both settings controllers read the
      // document to edit from exactly there, and their pending gates are per-controller, so
      // one click in each section inside one round trip reaches this. Sending the spent
      // revision would report another copy of QuipClip as the writer, which would be false.
      const confirmed = createValidSettings({ revision: 3 });
      const sent: Settings[] = [];
      const saveSettings = vi.fn((next: Settings) => {
        sent.push(next);
        return Promise.resolve({ ...next, revision: next.revision + 1 });
      });
      const store = createSettingsStore(
        { saveSettings },
        { status: "ready", settings: confirmed },
      );

      const first = store
        .getState()
        .saveSettings({ ...confirmed, ffmpegPath: "/first" });
      const optimistic = store.getState().settings ?? confirmed;
      expect(optimistic.revision).toBe(3);
      const second = store
        .getState()
        .saveSettings({ ...optimistic, activePresetId: undefined });
      await Promise.all([first, second]);

      expect(sent.map((document) => document.revision)).toEqual([3, 4]);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().error).toBeNull();
      expect(store.getState().settings?.revision).toBe(5);
    });

    it("5. loadSettings() rejection leaves settings null and status 'error'", async () => {
      const store = createSettingsStore({
        loadSettings: vi
          .fn()
          .mockRejectedValue(
            new SettingsError({ code: "readFailed", detail: "Read error" }),
          ),
      });

      const result = await store.getState().loadSettings();

      expect(result).toBeNull();
      expect(store.getState().settings).toBeNull();
      expect(store.getState().status).toBe("error");
      expect(store.getState().error).toBeInstanceOf(SettingsError);
      expect(store.getState().error?.code).toBe("readFailed");
      expect(store.getState().error?.detail).toBe("Read error");
    });

    it("5b. loadSettings() rejection on store holding previous settings leaves settings null and status 'error'", async () => {
      const oldDoc = createValidSettings({ activePresetId: "old-doc" });
      const store = createSettingsStore(
        {
          loadSettings: vi
            .fn()
            .mockRejectedValue(new SettingsError({ code: "permissionDenied" })),
        },
        { status: "ready", settings: oldDoc },
      );

      await store.getState().loadSettings();

      expect(store.getState().settings).toBeNull();
      expect(store.getState().status).toBe("error");
      expect(store.getState().error?.code).toBe("permissionDenied");
    });

    it("6. A malformed payload from load becomes a SettingsError with code 'unknown', not a raw TypeError at call site", async () => {
      const malformed = {
        settings: { schemaVersion: 999 },
        seeded: "not-a-bool",
      };

      const store = createSettingsStore({
        loadSettings: vi.fn(() =>
          Promise.resolve(malformed as unknown as LoadSettingsResult),
        ),
      });

      let thrown: unknown = null;
      let result: LoadSettingsResult | null = null;
      try {
        result = await store.getState().loadSettings();
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeNull();
      expect(result).toBeNull();
      expect(store.getState().settings).toBeNull();
      expect(store.getState().status).toBe("error");
      expect(store.getState().error).toBeInstanceOf(SettingsError);
      expect(store.getState().error?.code).toBe("unknown");
    });
  });

  describe("Lifecycle and Actions", () => {
    it("loads settings successfully and sets seeded to true", async () => {
      const loadResult = createValidLoadResult({ seeded: true });
      const store = createSettingsStore({
        loadSettings: vi.fn().mockResolvedValue(loadResult),
      });

      const loadPromise = store.getState().loadSettings();
      expect(store.getState().status).toBe("loading");
      expect(store.getState().error).toBeNull();

      const result = await loadPromise;
      expect(result).toEqual(loadResult);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().settings).toEqual(loadResult.settings);
      expect(store.getState().seeded).toBe(true);
      expect(store.getState().error).toBeNull();
    });

    it("restores default presets via write queue", async () => {
      const restoredDoc = createValidSettings({ activePresetId: "restored-preset" });
      const store = createSettingsStore({
        restoreDefaultPresets: vi.fn().mockResolvedValue(restoredDoc),
      });

      const promise = store.getState().restoreDefaultPresets();
      expect(store.getState().status).toBe("saving");

      const result = await promise;
      expect(result).toEqual(restoredDoc);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().settings).toEqual(restoredDoc);
    });

    it("rolls back on restoreDefaultPresets rejection", async () => {
      const initialDoc = createValidSettings({ activePresetId: "initial-preset" });
      const store = createSettingsStore(
        {
          restoreDefaultPresets: vi
            .fn()
            .mockRejectedValue(new SettingsError({ code: "permissionDenied" })),
        },
        { status: "ready", settings: initialDoc },
      );

      const result = await store.getState().restoreDefaultPresets();
      expect(result).toBeNull();
      expect(store.getState().status).toBe("error");
      expect(store.getState().settings).toEqual(initialDoc);
      expect(store.getState().error?.code).toBe("permissionDenied");
    });

    it("resets settings to defaults on backend via resetSettings", async () => {
      const resetDoc = createValidSettings({ activePresetId: "reset-seed" });
      const store = createSettingsStore({
        resetSettings: vi.fn().mockResolvedValue(resetDoc),
      });

      const promise = store.getState().resetSettings();
      expect(store.getState().status).toBe("saving");

      const result = await promise;
      expect(result).toEqual(resetDoc);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().settings).toEqual(resetDoc);
      expect(store.getState().seeded).toBe(false);
    });

    it("clears seeded to false upon successful save", async () => {
      const doc = createValidSettings();
      const store = createSettingsStore(
        { saveSettings: vi.fn().mockResolvedValue(doc) },
        { status: "ready", settings: doc, seeded: true },
      );

      expect(store.getState().seeded).toBe(true);
      await store.getState().saveSettings(doc);
      expect(store.getState().seeded).toBe(false);
    });

    it("resets store in memory back to idle via reset()", () => {
      const store = createSettingsStore(
        {},
        {
          status: "ready",
          settings: createValidSettings(),
          seeded: true,
          error: new SettingsError({ code: "unknown" }),
        },
      );

      store.getState().reset();

      expect(store.getState().status).toBe("idle");
      expect(store.getState().settings).toBeNull();
      expect(store.getState().seeded).toBe(false);
      expect(store.getState().error).toBeNull();
    });

    it("reports an error via reportError()", () => {
      const store = createSettingsStore(
        {},
        {
          status: "ready",
          settings: createValidSettings(),
        },
      );

      store.getState().reportError(new SettingsError({ code: "backupFailed" }));

      expect(store.getState().status).toBe("error");
      expect(store.getState().error?.code).toBe("backupFailed");
    });

    it("keeps resetSettings and reset as different actions", () => {
      const store = createSettingsStore();
      const state = store.getState();

      expect(state.resetSettings).not.toBe(state.reset);
    });

    it("BLOCKING 1: never allows two writes to overlap across a reset()", async () => {
      let currentActive = 0;
      let maxConcurrent = 0;

      const saveSettingsMock = vi.fn(async (settings: Settings) => {
        currentActive++;
        maxConcurrent = Math.max(maxConcurrent, currentActive);
        await new Promise((resolve) => setTimeout(resolve, 30));
        currentActive--;
        return settings;
      });

      const store = createSettingsStore({ saveSettings: saveSettingsMock });
      const docA = createValidSettings({ activePresetId: "doc-A" });
      const docB = createValidSettings({ activePresetId: "doc-B" });

      const pA = store.getState().saveSettings(docA);
      store.getState().reset();
      const pB = store.getState().saveSettings(docB);

      await Promise.all([pA, pB]);

      expect(saveSettingsMock).toHaveBeenCalledTimes(2);
      expect(maxConcurrent).toBe(1);
    });

    it("BLOCKING 4: leaves store holding what save wrote when save is followed immediately by load", async () => {
      let currentDiskDoc = createValidSettings({ activePresetId: "OLD" });

      const saveSettingsMock = vi.fn(async (settings: Settings) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        currentDiskDoc = settings;
        return settings;
      });

      const loadSettingsMock = vi.fn(() =>
        Promise.resolve({ settings: currentDiskDoc, seeded: false }),
      );

      const store = createSettingsStore(
        {
          saveSettings: saveSettingsMock,
          loadSettings: loadSettingsMock,
        },
        { status: "ready", settings: currentDiskDoc },
      );

      const newDoc = createValidSettings({ activePresetId: "NEW" });

      const savePromise = store.getState().saveSettings(newDoc);
      const loadPromise = store.getState().loadSettings();

      await Promise.all([savePromise, loadPromise]);

      expect(store.getState().status).toBe("ready");
      expect(store.getState().settings?.activePresetId).toBe("NEW");
      expect(store.getState().error).toBeNull();
    });

    it("NON-BLOCKING 5: does not suppress in-flight save state update when reportError is called", async () => {
      const doc = createValidSettings({ activePresetId: "in-flight-save" });

      const saveSettingsMock = vi.fn(async (settings: Settings) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return settings;
      });

      const store = createSettingsStore({ saveSettings: saveSettingsMock });

      const savePromise = store.getState().saveSettings(doc);

      // External error reported while save is in flight
      store.getState().reportError(new SettingsError({ code: "dialogFailed" }));
      expect(store.getState().status).toBe("error");
      expect(store.getState().error?.code).toBe("dialogFailed");

      await savePromise;

      // In-flight save completed and transitions state to ready with saved doc
      expect(store.getState().status).toBe("ready");
      expect(store.getState().settings).toEqual(doc);
      expect(store.getState().error).toBeNull();
    });

    it("NON-BLOCKING 6a. ORDERING: restoreDefaultPresets call 1 then call 2 with call 1 resolving last processes sequentially", async () => {
      const docA = createValidSettings({ activePresetId: "restore-A" });
      const docB = createValidSettings({ activePresetId: "restore-B" });

      let aResolved = false;
      let bReceivedBeforeAResolved = false;
      const calls: string[] = [];

      let callCount = 0;
      const restoreMock = vi.fn(async () => {
        callCount++;
        const currentCall = callCount;
        calls.push(`call-${currentCall}`);
        if (currentCall === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          aResolved = true;
          return docA;
        }
        if (!aResolved) {
          bReceivedBeforeAResolved = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return docB;
      });

      const store = createSettingsStore({ restoreDefaultPresets: restoreMock });

      const p1 = store.getState().restoreDefaultPresets();
      const p2 = store.getState().restoreDefaultPresets();

      await Promise.all([p1, p2]);

      expect(calls).toEqual(["call-1", "call-2"]);
      expect(bReceivedBeforeAResolved).toBe(false);
      expect(store.getState().settings).toEqual(docB);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().error).toBeNull();
    });

    it("NON-BLOCKING 6b. SUPERSEDED: A rejected restoreDefaultPresets that has ALREADY been superseded restores nothing and does not overwrite successor state", async () => {
      const initialDoc = createValidSettings({ activePresetId: "initial-doc" });
      const docB = createValidSettings({ activePresetId: "successor-success" });

      let rejectA!: (err: unknown) => void;
      const promiseA = new Promise<Settings>((_, rej) => {
        rejectA = rej;
      });

      let callCount = 0;
      const restoreMock = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return promiseA;
        }
        return Promise.resolve(docB);
      });

      const store = createSettingsStore(
        { restoreDefaultPresets: restoreMock },
        { status: "ready", settings: initialDoc },
      );

      const pA = store.getState().restoreDefaultPresets();
      expect(store.getState().status).toBe("saving");

      const pB = store.getState().restoreDefaultPresets();
      expect(store.getState().status).toBe("saving");

      rejectA(new SettingsError({ code: "permissionDenied", detail: "A failed" }));
      await pA;

      expect(store.getState().status).toBe("saving");
      expect(store.getState().error).toBeNull();

      await pB;
      expect(store.getState().settings).toEqual(docB);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().error).toBeNull();
    });

    it("NON-BLOCKING 6c. ORDERING: resetSettings call 1 then call 2 with call 1 resolving last processes sequentially", async () => {
      const docA = createValidSettings({ activePresetId: "reset-A" });
      const docB = createValidSettings({ activePresetId: "reset-B" });

      let aResolved = false;
      let bReceivedBeforeAResolved = false;
      const calls: string[] = [];

      let callCount = 0;
      const resetMock = vi.fn(async () => {
        callCount++;
        const currentCall = callCount;
        calls.push(`call-${currentCall}`);
        if (currentCall === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          aResolved = true;
          return docA;
        }
        if (!aResolved) {
          bReceivedBeforeAResolved = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return docB;
      });

      const store = createSettingsStore({ resetSettings: resetMock });

      const p1 = store.getState().resetSettings();
      const p2 = store.getState().resetSettings();

      await Promise.all([p1, p2]);

      expect(calls).toEqual(["call-1", "call-2"]);
      expect(bReceivedBeforeAResolved).toBe(false);
      expect(store.getState().settings).toEqual(docB);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().error).toBeNull();
    });

    it("NON-BLOCKING 6d. SUPERSEDED: A rejected resetSettings that has ALREADY been superseded restores nothing and does not overwrite successor state", async () => {
      const initialDoc = createValidSettings({ activePresetId: "initial-doc" });
      const docB = createValidSettings({ activePresetId: "successor-success" });

      let rejectA!: (err: unknown) => void;
      const promiseA = new Promise<Settings>((_, rej) => {
        rejectA = rej;
      });

      let callCount = 0;
      const resetMock = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return promiseA;
        }
        return Promise.resolve(docB);
      });

      const store = createSettingsStore(
        { resetSettings: resetMock },
        { status: "ready", settings: initialDoc },
      );

      const pA = store.getState().resetSettings();
      expect(store.getState().status).toBe("saving");

      const pB = store.getState().resetSettings();
      expect(store.getState().status).toBe("saving");

      rejectA(new SettingsError({ code: "writeFailed", detail: "Reset A failed" }));
      await pA;

      expect(store.getState().status).toBe("saving");
      expect(store.getState().error).toBeNull();

      await pB;
      expect(store.getState().settings).toEqual(docB);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().error).toBeNull();
    });

    it("NON-BLOCKING 8: rejects malformed document early with invalidSettings and does not publish it", async () => {
      const initialDoc = createValidSettings({ activePresetId: "initial-doc" });
      const saveSettingsMock = vi.fn();

      const store = createSettingsStore(
        { saveSettings: saveSettingsMock },
        { status: "ready", settings: initialDoc },
      );

      const malformedDoc = {
        schemaVersion: 999,
        presets: "not-an-array",
      } as unknown as Settings;

      const result = await store.getState().saveSettings(malformedDoc);

      expect(result).toBeNull();
      expect(saveSettingsMock).not.toHaveBeenCalled();
      expect(store.getState().status).toBe("error");
      expect(store.getState().settings).toEqual(initialDoc);
      expect(store.getState().error).toBeInstanceOf(SettingsError);
      expect(store.getState().error?.code).toBe("invalidSettings");
    });

    it("NON-BLOCKING 7: an early-rejected save does not invalidate an in-flight load", async () => {
      const loadedDoc = createValidSettings({ activePresetId: "default-h264-mp4" });
      let releaseLoad: () => void = () => {};
      const loadGate = new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });

      const store = createSettingsStore({
        loadSettings: async () => {
          await loadGate;
          return { settings: loadedDoc, seeded: false };
        },
      });

      const loadPromise = store.getState().loadSettings();

      // Rejected before any IPC, so it has no result to win with and must not supersede
      // the load that is already on the wire.
      const saveResult = await store.getState().saveSettings({
        schemaVersion: 999,
        presets: "not-an-array",
      } as unknown as Settings);
      expect(saveResult).toBeNull();

      releaseLoad();
      await loadPromise;

      expect(store.getState().status).toBe("ready");
      expect(store.getState().settings).toEqual(loadedDoc);
      expect(store.getState().error).toBeNull();
    });
  });

  describe("useSettingsStore and singleton", () => {
    it("exports useSettingsStore hook function", () => {
      expect(typeof useSettingsStore).toBe("function");
    });

    it("uses singleton settingsStore by default", () => {
      expect(settingsStore).toBeDefined();
      expect(settingsStore.getState().status).toBe("idle");
      expect(typeof settingsStore.getState().loadSettings).toBe("function");
      expect(typeof settingsStore.getState().saveSettings).toBe("function");
      expect(typeof settingsStore.getState().restoreDefaultPresets).toBe("function");
      expect(typeof settingsStore.getState().resetSettings).toBe("function");
      expect(typeof settingsStore.getState().reset).toBe("function");
    });
  });
});
