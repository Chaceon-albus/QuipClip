import { describe, expect, it, vi } from "vitest";
import { save as tauriSave } from "@tauri-apps/plugin-dialog";
import { openExportSaveDialog } from "./dialog";
import { exportStore } from "./store";
import { ExportError } from "./types";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

describe("Export Dialog Orchestration", () => {
  const defaultContainer = "mp4";
  const defaultFilterName = "MP4 Video";

  describe("File Save Flow", () => {
    it("calls save with container extension, localized filter name, and defaultName", async () => {
      const saveDialogMock = vi.fn().mockResolvedValue("/media/output.mp4");
      const reportErrorMock = vi.fn();

      const result = await openExportSaveDialog({
        container: "mp4",
        filterName: defaultFilterName,
        defaultName: "clip_export.mp4",
        saveDialog: saveDialogMock,
        reportError: reportErrorMock,
      });

      expect(saveDialogMock).toHaveBeenCalledTimes(1);
      expect(saveDialogMock).toHaveBeenCalledWith({
        defaultPath: "clip_export.mp4",
        filters: [
          {
            name: "MP4 Video",
            extensions: ["mp4"],
          },
        ],
      });
      expect(reportErrorMock).not.toHaveBeenCalled();
      expect(result).toBe("/media/output.mp4");
    });

    it("strips leading dot from container if present", async () => {
      const saveDialogMock = vi.fn().mockResolvedValue("/media/output.mkv");

      const result = await openExportSaveDialog({
        container: ".mkv",
        filterName: "Matroska Video",
        saveDialog: saveDialogMock,
      });

      expect(saveDialogMock).toHaveBeenCalledWith({
        filters: [
          {
            name: "Matroska Video",
            extensions: ["mkv"],
          },
        ],
      });
      expect(result).toBe("/media/output.mkv");
    });

    it("passes optional title and defaultName to save dialog", async () => {
      const saveDialogMock = vi.fn().mockResolvedValue("/media/custom.mp4");

      const result = await openExportSaveDialog({
        container: "mp4",
        filterName: defaultFilterName,
        title: "Save Export Video",
        defaultName: "custom.mp4",
        saveDialog: saveDialogMock,
      });

      expect(saveDialogMock).toHaveBeenCalledWith({
        title: "Save Export Video",
        defaultPath: "custom.mp4",
        filters: [
          {
            name: defaultFilterName,
            extensions: ["mp4"],
          },
        ],
      });
      expect(result).toBe("/media/custom.mp4");
    });

    it("delegates to default Tauri plugin-dialog save when saveDialog is omitted", async () => {
      const mockedTauriSave = vi.mocked(tauriSave);
      mockedTauriSave.mockResolvedValueOnce("/media/default-save.mp4");

      const result = await openExportSaveDialog({
        container: defaultContainer,
        filterName: defaultFilterName,
      });

      expect(mockedTauriSave).toHaveBeenCalledWith({
        filters: [
          {
            name: defaultFilterName,
            extensions: ["mp4"],
          },
        ],
      });
      expect(result).toBe("/media/default-save.mp4");
    });
  });

  describe("Cancel & Empty Selection Flow", () => {
    it("treats dialog cancel (null result) as a strict no-op returning null with no error reported", async () => {
      const saveDialogMock = vi.fn().mockResolvedValue(null);
      const reportErrorMock = vi.fn();

      const result = await openExportSaveDialog({
        container: defaultContainer,
        filterName: defaultFilterName,
        saveDialog: saveDialogMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(reportErrorMock).not.toHaveBeenCalled();
    });

    it("treats empty string as a strict no-op returning null with no error reported", async () => {
      const saveDialogMock = vi.fn().mockResolvedValue("");
      const reportErrorMock = vi.fn();

      const result = await openExportSaveDialog({
        container: defaultContainer,
        filterName: defaultFilterName,
        saveDialog: saveDialogMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(reportErrorMock).not.toHaveBeenCalled();
    });

    it("treats whitespace-only string as a strict no-op returning null", async () => {
      const saveDialogMock = vi.fn().mockResolvedValue("   ");
      const reportErrorMock = vi.fn();

      const result = await openExportSaveDialog({
        container: defaultContainer,
        filterName: defaultFilterName,
        saveDialog: saveDialogMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(reportErrorMock).not.toHaveBeenCalled();
    });
  });

  describe("Dialog Rejection & Error Normalization", () => {
    it("catches dialog rejection and reports dialogFailed with NO detail (never copying Error.message)", async () => {
      const dialogError = new Error("File dialog crashed or IPC disconnected");
      const saveDialogMock = vi.fn().mockRejectedValue(dialogError);
      const reportErrorMock = vi.fn();

      const result = await openExportSaveDialog({
        container: defaultContainer,
        filterName: defaultFilterName,
        saveDialog: saveDialogMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(reportErrorMock).toHaveBeenCalledTimes(1);

      const reported = reportErrorMock.mock.calls[0][0] as ExportError;
      expect(reported).toBeInstanceOf(ExportError);
      expect(reported.code).toBe("dialogFailed");
      expect(reported.detail).toBeUndefined(); // Never leak local error message
    });

    it("handles string rejections from saveDialog without copying string into detail", async () => {
      const saveDialogMock = vi.fn().mockRejectedValue("Permission denied");
      const reportErrorMock = vi.fn();

      const result = await openExportSaveDialog({
        container: defaultContainer,
        filterName: defaultFilterName,
        saveDialog: saveDialogMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(reportErrorMock).toHaveBeenCalledTimes(1);

      const reported = reportErrorMock.mock.calls[0][0] as ExportError;
      expect(reported).toBeInstanceOf(ExportError);
      expect(reported.code).toBe("dialogFailed");
      expect(reported.detail).toBeUndefined();
    });

    it("reports to exportStore.reportError by default when reportError is omitted", async () => {
      const saveDialogMock = vi.fn().mockRejectedValue(new Error("Crashed"));
      const storeReportSpy = vi.spyOn(exportStore.getState(), "reportError");

      const result = await openExportSaveDialog({
        container: defaultContainer,
        filterName: defaultFilterName,
        saveDialog: saveDialogMock,
      });

      expect(result).toBeNull();
      expect(storeReportSpy).toHaveBeenCalledTimes(1);
      const reported = storeReportSpy.mock.calls[0][0] as ExportError;
      expect(reported.code).toBe("dialogFailed");
      expect(reported.detail).toBeUndefined();

      storeReportSpy.mockRestore();
    });

    it("never rethrows any exception", async () => {
      const saveDialogMock = vi.fn().mockRejectedValue({
        code: "internalError",
        detail: "Fatal",
      });

      await expect(
        openExportSaveDialog({
          container: defaultContainer,
          filterName: defaultFilterName,
          saveDialog: saveDialogMock,
          reportError: () => {},
        }),
      ).resolves.toBeNull();
    });
  });
});
