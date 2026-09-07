import { describe, expect, it, vi } from "vitest";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { BACKEND_COMMANDS, type BackendCommand } from "@/lib/ipc";
import {
  loadSettings,
  resetSettings,
  restoreDefaultPresets,
  saveSettings,
  type SettingsClientOptions,
} from "./client";
import {
  BACKEND_SETTINGS_ERROR_CODES,
  SettingsError,
  type BackendSettingsErrorCode,
  type LoadSettingsResult,
  type Preset,
  type Settings,
} from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function createValidPreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "default-h264-mp4",
    name: "H.264 MP4",
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
 * `revision` is a distinctive non-zero value on purpose. These fixtures stand for a document
 * that crossed the IPC boundary, and zero is specifically what a document written before the
 * field existed reads as, so using it here would conflate the two cases and leave a future
 * test about that case unwritable.
 */
const TEST_REVISION = 7;

function createValidSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    schemaVersion: 1,
    revision: TEST_REVISION,
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

describe("Settings Client", () => {
  describe("loadSettings", () => {
    it("invokes the backend load_settings command with no arguments", async () => {
      const mockResult = createValidLoadResult();
      const mockInvoke = vi.fn().mockResolvedValue(mockResult);

      const result = await loadSettings({ invoke: mockInvoke });

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith(BACKEND_COMMANDS.LOAD_SETTINGS);
      expect(BACKEND_COMMANDS.LOAD_SETTINGS).toBe("load_settings");
      expect(result).toEqual(mockResult);
    });

    it("accepts custom invoke constrained to BackendCommand (NON-BLOCKING 9)", async () => {
      const invokedCommands: BackendCommand[] = [];
      const customInvoke: NonNullable<SettingsClientOptions["invoke"]> = <T>(
        cmd: BackendCommand,
      ): Promise<T> => {
        invokedCommands.push(cmd);
        return Promise.resolve(createValidLoadResult() as unknown as T);
      };

      await loadSettings({ invoke: customInvoke });
      expect(invokedCommands).toEqual([BACKEND_COMMANDS.LOAD_SETTINGS]);
    });

    it("delegates to default Tauri invoke when no custom invoke is provided", async () => {
      const mockedTauriInvoke = vi.mocked(tauriInvoke);
      const mockResult = createValidLoadResult({ seeded: true });
      mockedTauriInvoke.mockResolvedValueOnce(mockResult);

      const result = await loadSettings();

      expect(mockedTauriInvoke).toHaveBeenCalledWith("load_settings", undefined);
      expect(result).toEqual(mockResult);
    });

    it("normalizes malformed success responses to an error with code 'unknown'", async () => {
      const mockInvoke = vi.fn().mockResolvedValue({
        settings: { schemaVersion: 999 },
        seeded: "not-a-boolean",
      });

      const promise = loadSettings({ invoke: mockInvoke });
      await expect(promise).rejects.toBeInstanceOf(SettingsError);
      await expect(promise).rejects.toMatchObject({
        code: "unknown",
      });
    });

    it("normalizes Error object rejections with detail undefined to prevent leaking local messages", async () => {
      const mockInvoke = vi.fn().mockRejectedValue(new Error("Local IPC failure"));

      try {
        await loadSettings({ invoke: mockInvoke });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SettingsError);
        expect((error as SettingsError).code).toBe("unknown");
        expect((error as SettingsError).detail).toBeUndefined();
      }
    });
  });

  describe("saveSettings", () => {
    it("invokes save_settings with { settings } argument", async () => {
      const settings = createValidSettings();
      const mockInvoke = vi.fn().mockResolvedValue(settings);

      const result = await saveSettings(settings, { invoke: mockInvoke });

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith(BACKEND_COMMANDS.SAVE_SETTINGS, {
        settings,
      });
      expect(BACKEND_COMMANDS.SAVE_SETTINGS).toBe("save_settings");
      expect(result).toEqual(settings);
    });

    it("normalizes malformed response on save to an error with code 'unknown'", async () => {
      const settings = createValidSettings();
      const mockInvoke = vi.fn().mockResolvedValue({ invalid: true });

      const promise = saveSettings(settings, { invoke: mockInvoke });
      await expect(promise).rejects.toBeInstanceOf(SettingsError);
      await expect(promise).rejects.toMatchObject({
        code: "unknown",
      });
    });
  });

  describe("restoreDefaultPresets", () => {
    it("invokes restore_default_presets with no arguments", async () => {
      const settings = createValidSettings();
      const mockInvoke = vi.fn().mockResolvedValue(settings);

      const result = await restoreDefaultPresets({ invoke: mockInvoke });

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith(BACKEND_COMMANDS.RESTORE_DEFAULT_PRESETS);
      expect(BACKEND_COMMANDS.RESTORE_DEFAULT_PRESETS).toBe("restore_default_presets");
      expect(result).toEqual(settings);
    });

    it("normalizes malformed response to an error with code 'unknown'", async () => {
      const mockInvoke = vi.fn().mockResolvedValue({ presets: "invalid" });

      const promise = restoreDefaultPresets({ invoke: mockInvoke });
      await expect(promise).rejects.toBeInstanceOf(SettingsError);
      await expect(promise).rejects.toMatchObject({
        code: "unknown",
      });
    });
  });

  describe("resetSettings", () => {
    it("invokes reset_settings with no arguments", async () => {
      const settings = createValidSettings();
      const mockInvoke = vi.fn().mockResolvedValue(settings);

      const result = await resetSettings({ invoke: mockInvoke });

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith(BACKEND_COMMANDS.RESET_SETTINGS);
      expect(BACKEND_COMMANDS.RESET_SETTINGS).toBe("reset_settings");
      expect(result).toEqual(settings);
    });

    it("normalizes malformed response to an error with code 'unknown'", async () => {
      const mockInvoke = vi.fn().mockResolvedValue(null);

      const promise = resetSettings({ invoke: mockInvoke });
      await expect(promise).rejects.toBeInstanceOf(SettingsError);
      await expect(promise).rejects.toMatchObject({
        code: "unknown",
      });
    });
  });

  describe.each(BACKEND_SETTINGS_ERROR_CODES)(
    "normalizes backend error code: %s",
    (code: BackendSettingsErrorCode) => {
      it(`normalizes rejected error with code ${code} for loadSettings`, async () => {
        const mockInvoke = vi.fn().mockRejectedValue({
          code,
          detail: `Diagnostic for ${code}`,
          field: "presets",
        });

        await expect(loadSettings({ invoke: mockInvoke })).rejects.toMatchObject({
          code,
          detail: `Diagnostic for ${code}`,
          field: "presets",
        });

        try {
          await loadSettings({ invoke: mockInvoke });
        } catch (error) {
          expect(error).toBeInstanceOf(SettingsError);
        }
      });

      it(`normalizes rejected error with code ${code} for saveSettings`, async () => {
        const settings = createValidSettings();
        const mockInvoke = vi.fn().mockRejectedValue({
          code,
          detail: `Diagnostic for ${code}`,
        });

        await expect(
          saveSettings(settings, { invoke: mockInvoke }),
        ).rejects.toMatchObject({
          code,
          detail: `Diagnostic for ${code}`,
        });

        try {
          await saveSettings(settings, { invoke: mockInvoke });
        } catch (error) {
          expect(error).toBeInstanceOf(SettingsError);
        }
      });
    },
  );
});
