import { describe, expect, it, vi } from "vitest";
import { openFfmpegPathDialog } from "./dialog";
import { settingsStore } from "./store";
import { SettingsError } from "./types";

describe("FFmpeg Path Dialog Orchestration", () => {
  describe("1. Directory Mode Configuration", () => {
    it("calls openDialog with multiple: false and directory: true, asserting the whole argument object", async () => {
      const openDialogMock = vi.fn().mockResolvedValue("/opt/homebrew/bin");
      const onPickedMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openFfmpegPathDialog({
        mode: "directory",
        openDialog: openDialogMock,
        onPicked: onPickedMock,
        reportError: reportErrorMock,
      });

      expect(openDialogMock).toHaveBeenCalledTimes(1);
      expect(openDialogMock).toHaveBeenCalledWith({
        multiple: false,
        directory: true,
      });
      expect(openDialogMock.mock.calls[0]?.[0]).toEqual({
        multiple: false,
        directory: true,
      });

      expect(onPickedMock).toHaveBeenCalledTimes(1);
      expect(onPickedMock).toHaveBeenCalledWith("/opt/homebrew/bin");
      expect(reportErrorMock).not.toHaveBeenCalled();
      expect(result).toBe("/opt/homebrew/bin");
    });
  });

  describe("2. File Mode Configuration & No Filters Check", () => {
    it("calls openDialog with multiple: false, directory: false and asserts NO filters key exists", async () => {
      const openDialogMock = vi.fn().mockResolvedValue("/opt/homebrew/bin/ffmpeg");
      const onPickedMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openFfmpegPathDialog({
        mode: "file",
        openDialog: openDialogMock,
        onPicked: onPickedMock,
        reportError: reportErrorMock,
      });

      expect(openDialogMock).toHaveBeenCalledTimes(1);
      const dialogArg = openDialogMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(dialogArg).toEqual({
        multiple: false,
        directory: false,
      });
      expect(dialogArg).not.toHaveProperty("filters");

      expect(onPickedMock).toHaveBeenCalledTimes(1);
      expect(onPickedMock).toHaveBeenCalledWith("/opt/homebrew/bin/ffmpeg");
      expect(reportErrorMock).not.toHaveBeenCalled();
      expect(result).toBe("/opt/homebrew/bin/ffmpeg");
    });
  });

  describe("3. Cancel Behavior", () => {
    it("treats null dialog return as cancel: calls neither onPicked nor reportError and returns null", async () => {
      const openDialogMock = vi.fn().mockResolvedValue(null);
      const onPickedMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openFfmpegPathDialog({
        mode: "file",
        openDialog: openDialogMock,
        onPicked: onPickedMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(onPickedMock).not.toHaveBeenCalled();
      expect(reportErrorMock).not.toHaveBeenCalled();
    });

    it("treats undefined dialog return as cancel: calls neither onPicked nor reportError and returns null", async () => {
      const openDialogMock = vi.fn().mockResolvedValue(undefined);
      const onPickedMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openFfmpegPathDialog({
        mode: "directory",
        openDialog: openDialogMock,
        onPicked: onPickedMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(onPickedMock).not.toHaveBeenCalled();
      expect(reportErrorMock).not.toHaveBeenCalled();
    });
  });

  describe("4. Empty Selection Handling", () => {
    it("treats an empty array as cancel", async () => {
      const openDialogMock = vi.fn().mockResolvedValue([]);
      const onPickedMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openFfmpegPathDialog({
        mode: "file",
        openDialog: openDialogMock,
        onPicked: onPickedMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(onPickedMock).not.toHaveBeenCalled();
      expect(reportErrorMock).not.toHaveBeenCalled();
    });

    it("treats a whitespace-only string as cancel", async () => {
      const openDialogMock = vi.fn().mockResolvedValue("   \t\n  ");
      const onPickedMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openFfmpegPathDialog({
        mode: "directory",
        openDialog: openDialogMock,
        onPicked: onPickedMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(onPickedMock).not.toHaveBeenCalled();
      expect(reportErrorMock).not.toHaveBeenCalled();
    });

    it("treats an array with a whitespace-only string as cancel", async () => {
      const openDialogMock = vi.fn().mockResolvedValue(["    "]);
      const onPickedMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openFfmpegPathDialog({
        mode: "file",
        openDialog: openDialogMock,
        onPicked: onPickedMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(onPickedMock).not.toHaveBeenCalled();
      expect(reportErrorMock).not.toHaveBeenCalled();
    });
  });

  describe("5. Dialog Rejection & Error Handling", () => {
    it("calls reportError exactly once with code 'dialogFailed', does not call onPicked, does not rethrow, and returns null", async () => {
      const dialogError = new Error("IPC bridge disconnected or dialog window crashed");
      const openDialogMock = vi.fn().mockRejectedValue(dialogError);
      const onPickedMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openFfmpegPathDialog({
        mode: "file",
        openDialog: openDialogMock,
        onPicked: onPickedMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(onPickedMock).not.toHaveBeenCalled();
      expect(reportErrorMock).toHaveBeenCalledTimes(1);

      const reported = reportErrorMock.mock.calls[0]?.[0] as SettingsError;
      expect(reported).toBeInstanceOf(SettingsError);
      expect(reported.code).toBe("dialogFailed");
      expect(reported.detail).toBeUndefined();
    });

    it("handles non-Error string rejections without copying string into detail", async () => {
      const openDialogMock = vi.fn().mockRejectedValue("Access denied");
      const onPickedMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openFfmpegPathDialog({
        mode: "directory",
        openDialog: openDialogMock,
        onPicked: onPickedMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(onPickedMock).not.toHaveBeenCalled();
      expect(reportErrorMock).toHaveBeenCalledTimes(1);

      const reported = reportErrorMock.mock.calls[0]?.[0] as SettingsError;
      expect(reported).toBeInstanceOf(SettingsError);
      expect(reported.code).toBe("dialogFailed");
      expect(reported.detail).toBeUndefined();
    });

    it("falls back to settingsStore.getState().reportError when reportError is omitted", async () => {
      settingsStore.getState().reset();
      const openDialogMock = vi
        .fn()
        .mockRejectedValue(new Error("Native dialog crash"));

      const result = await openFfmpegPathDialog({
        mode: "file",
        openDialog: openDialogMock,
      });

      expect(result).toBeNull();
      const storeError = settingsStore.getState().error;
      expect(storeError).toBeInstanceOf(SettingsError);
      expect(storeError?.code).toBe("dialogFailed");
      expect(storeError?.detail).toBeUndefined();

      settingsStore.getState().reset();
    });
  });

  describe("6. Array Selection Handling", () => {
    it("uses element zero when a string[] selection is returned", async () => {
      const openDialogMock = vi
        .fn()
        .mockResolvedValue(["/usr/local/bin/ffmpeg", "/usr/local/bin/ffprobe"]);
      const onPickedMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openFfmpegPathDialog({
        mode: "file",
        openDialog: openDialogMock,
        onPicked: onPickedMock,
        reportError: reportErrorMock,
      });

      expect(result).toBe("/usr/local/bin/ffmpeg");
      expect(onPickedMock).toHaveBeenCalledTimes(1);
      expect(onPickedMock).toHaveBeenCalledWith("/usr/local/bin/ffmpeg");
      expect(reportErrorMock).not.toHaveBeenCalled();
    });
  });

  describe("7. Good Selection Flow", () => {
    it("calls onPicked exactly once with the path and returns the path", async () => {
      const openDialogMock = vi.fn().mockResolvedValue("/usr/bin/ffmpeg");
      const onPickedMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openFfmpegPathDialog({
        mode: "file",
        openDialog: openDialogMock,
        onPicked: onPickedMock,
        reportError: reportErrorMock,
      });

      expect(result).toBe("/usr/bin/ffmpeg");
      expect(onPickedMock).toHaveBeenCalledTimes(1);
      expect(onPickedMock).toHaveBeenCalledWith("/usr/bin/ffmpeg");
      expect(reportErrorMock).not.toHaveBeenCalled();
    });

    it("awaits an asynchronous onPicked handler before returning", async () => {
      let asyncDone = false;
      const openDialogMock = vi.fn().mockResolvedValue("/usr/bin/ffmpeg");
      const onPickedMock = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        asyncDone = true;
      });

      const result = await openFfmpegPathDialog({
        mode: "file",
        openDialog: openDialogMock,
        onPicked: onPickedMock,
      });

      expect(asyncDone).toBe(true);
      expect(result).toBe("/usr/bin/ffmpeg");
      expect(onPickedMock).toHaveBeenCalledTimes(1);
    });

    it("succeeds when onPicked is not provided", async () => {
      const openDialogMock = vi.fn().mockResolvedValue("/usr/bin/ffmpeg");

      const result = await openFfmpegPathDialog({
        mode: "file",
        openDialog: openDialogMock,
      });

      expect(result).toBe("/usr/bin/ffmpeg");
    });
  });

  describe("Title Configuration", () => {
    it("forwards custom title to openDialog when provided", async () => {
      const openDialogMock = vi.fn().mockResolvedValue("/opt/homebrew/bin/ffmpeg");

      await openFfmpegPathDialog({
        mode: "file",
        title: "Locate FFmpeg Binary",
        openDialog: openDialogMock,
      });

      expect(openDialogMock).toHaveBeenCalledWith({
        title: "Locate FFmpeg Binary",
        multiple: false,
        directory: false,
      });
    });
  });
});
