import { describe, expect, it, vi } from "vitest";
import { openMediaFileDialog, VIDEO_FILE_EXTENSIONS } from "./dialog";
import { ImportMediaError, type ImportMediaResult } from "./types";
import type { FrameCount, Pts, TickCount } from "@/types/project";

function createFakeMediaResult(fileName: string): ImportMediaResult {
  return {
    path: `/media/${fileName}`,
    fileName,
    size: 1048576,
    mtime: 1724976000,
    probe: {
      formatNames: ["mov", "mp4"],
      formatLongName: "QuickTime / MOV",
      videoCodec: "h264",
      videoProfile: "High",
      pixelFormat: "yuv420p",
      bitDepth: 8,
      width: 1920,
      height: 1080,
      videoStreamIndex: 0,
      videoTimeBase: { n: 1, d: 90000 },
      videoStartPts: "0" as Pts,
      videoDurationTicks: "900000" as TickCount,
      approximateDurationSeconds: 10,
      avgFrameRate: { n: 30, d: 1 },
      rFrameRate: { n: 30, d: 1 },
      reportedFrameCount: "300" as FrameCount,
      audio: null,
    },
  };
}

describe("Media Dialog Orchestration", () => {
  const defaultFilterName = "Video Files";

  describe("Constants & Filter Configuration", () => {
    it("defines sensible video extensions supported by the editor", () => {
      expect(VIDEO_FILE_EXTENSIONS).toContain("mp4");
      expect(VIDEO_FILE_EXTENSIONS).toContain("mov");
      expect(VIDEO_FILE_EXTENSIONS).toContain("mkv");
      expect(VIDEO_FILE_EXTENSIONS).toContain("webm");
    });
  });

  describe("File Selection Flow", () => {
    it("calls open with multiple: false, directory: false, and localized video filter", async () => {
      const openDialogMock = vi.fn().mockResolvedValue("/media/clip.mp4");
      const fakeResult = createFakeMediaResult("clip.mp4");
      const importPathMock = vi.fn().mockResolvedValue(fakeResult);
      const reportErrorMock = vi.fn();

      const result = await openMediaFileDialog({
        filterName: defaultFilterName,
        openDialog: openDialogMock,
        importPath: importPathMock,
        reportError: reportErrorMock,
      });

      expect(openDialogMock).toHaveBeenCalledTimes(1);
      expect(openDialogMock).toHaveBeenCalledWith({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "Video Files",
            extensions: [...VIDEO_FILE_EXTENSIONS],
          },
        ],
      });

      expect(importPathMock).toHaveBeenCalledTimes(1);
      expect(importPathMock).toHaveBeenCalledWith("/media/clip.mp4");
      expect(reportErrorMock).not.toHaveBeenCalled();
      expect(result).toEqual(fakeResult);
    });

    it("handles array return value from dialog and imports the first path", async () => {
      const openDialogMock = vi.fn().mockResolvedValue(["/media/array_clip.mp4"]);
      const fakeResult = createFakeMediaResult("array_clip.mp4");
      const importPathMock = vi.fn().mockResolvedValue(fakeResult);

      const result = await openMediaFileDialog({
        filterName: "视频文件",
        openDialog: openDialogMock,
        importPath: importPathMock,
      });

      expect(openDialogMock).toHaveBeenCalledWith({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "视频文件",
            extensions: [...VIDEO_FILE_EXTENSIONS],
          },
        ],
      });
      expect(importPathMock).toHaveBeenCalledTimes(1);
      expect(importPathMock).toHaveBeenCalledWith("/media/array_clip.mp4");
      expect(result).toEqual(fakeResult);
    });
  });

  describe("Cancel & Empty Selection Flow", () => {
    it("treats dialog cancel (null result) as a strict no-op", async () => {
      const openDialogMock = vi.fn().mockResolvedValue(null);
      const importPathMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openMediaFileDialog({
        filterName: defaultFilterName,
        openDialog: openDialogMock,
        importPath: importPathMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(importPathMock).not.toHaveBeenCalled();
      expect(reportErrorMock).not.toHaveBeenCalled();
    });

    it("treats empty string or empty array as a strict no-op", async () => {
      const openDialogEmptyArray = vi.fn().mockResolvedValue([]);
      const importPathMock = vi.fn();
      const reportErrorMock = vi.fn();

      const resArray = await openMediaFileDialog({
        filterName: defaultFilterName,
        openDialog: openDialogEmptyArray,
        importPath: importPathMock,
        reportError: reportErrorMock,
      });

      expect(resArray).toBeNull();
      expect(importPathMock).not.toHaveBeenCalled();
      expect(reportErrorMock).not.toHaveBeenCalled();

      const openDialogEmptyString = vi.fn().mockResolvedValue("");
      const resString = await openMediaFileDialog({
        filterName: defaultFilterName,
        openDialog: openDialogEmptyString,
        importPath: importPathMock,
        reportError: reportErrorMock,
      });

      expect(resString).toBeNull();
      expect(importPathMock).not.toHaveBeenCalled();
      expect(reportErrorMock).not.toHaveBeenCalled();
    });
  });

  describe("Dialog Rejection & Error Normalization", () => {
    it("catches dialog rejection and reports dialogFailed with NO detail (never copying Error.message)", async () => {
      const dialogError = new Error("Dialog window crashed or IPC disconnected");
      const openDialogMock = vi.fn().mockRejectedValue(dialogError);
      const importPathMock = vi.fn();
      const reportErrorMock = vi.fn();

      const result = await openMediaFileDialog({
        filterName: defaultFilterName,
        openDialog: openDialogMock,
        importPath: importPathMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(importPathMock).not.toHaveBeenCalled();
      expect(reportErrorMock).toHaveBeenCalledTimes(1);

      const reported = reportErrorMock.mock.calls[0][0] as ImportMediaError;
      expect(reported).toBeInstanceOf(ImportMediaError);
      expect(reported.code).toBe("dialogFailed");
      expect(reported.detail).toBeUndefined(); // Never copy generic Error.message into detail
    });

    it("strips pre-normalized ImportMediaError rejections and reports dialogFailed with no detail or exitCode", async () => {
      const existingError = new ImportMediaError({
        code: "invalidPath",
        detail: "Path parsing failed",
        exitCode: 23,
      });
      const openDialogMock = vi.fn().mockRejectedValue(existingError);
      const reportErrorMock = vi.fn();

      const result = await openMediaFileDialog({
        filterName: defaultFilterName,
        openDialog: openDialogMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      expect(reportErrorMock).toHaveBeenCalledTimes(1);
      const reported = reportErrorMock.mock.calls[0][0] as ImportMediaError;
      expect(reported).toBeInstanceOf(ImportMediaError);
      expect(reported.code).toBe("dialogFailed");
      expect(reported.detail).toBeUndefined();
      expect(reported.exitCode).toBeUndefined();
    });

    it("handles string rejections from openDialog without copying string into detail", async () => {
      const openDialogMock = vi.fn().mockRejectedValue("Permission denied");
      const reportErrorMock = vi.fn();

      const result = await openMediaFileDialog({
        filterName: defaultFilterName,
        openDialog: openDialogMock,
        reportError: reportErrorMock,
      });

      expect(result).toBeNull();
      const reported = reportErrorMock.mock.calls[0][0] as ImportMediaError;
      expect(reported.code).toBe("dialogFailed");
      expect(reported.detail).toBeUndefined();
    });
  });
});
