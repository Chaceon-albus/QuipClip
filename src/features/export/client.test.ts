import { describe, expect, it, vi } from "vitest";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { BACKEND_COMMANDS } from "@/lib/ipc";
import type { Pts } from "@/types/project";
import { cancelActiveExport, cancelExport, startExport } from "./client";
import {
  BACKEND_EXPORT_ERROR_CODES,
  ExportError,
  type BackendExportErrorCode,
  type ExportRequest,
  type ExportStart,
} from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function createValidRequest(overrides: Partial<ExportRequest> = {}): ExportRequest {
  return {
    sourcePath: "/media/source.mp4",
    outputPath: "/media/output.mp4",
    segments: [
      {
        inPts: "0" as Pts,
        outPts: "1000" as Pts,
      },
    ],
    presetId: "mp4-h264",
    ...overrides,
  };
}

function createValidStartResult(overrides: Partial<ExportStart> = {}): ExportStart {
  return {
    runId: "export-run-123",
    presetId: "mp4-h264",
    outputPath: "/media/output.mp4",
    segmentCount: 1,
    totalDurationUs: 5_000_000,
    expectedFrames: 150,
    ...overrides,
  };
}

describe("Media Export Client", () => {
  describe("startExport", () => {
    it("invokes the backend command with request payload", async () => {
      const mockInvoke = vi.fn().mockResolvedValue(createValidStartResult());
      const request = createValidRequest();

      const result = await startExport(request, {
        invoke: mockInvoke,
      });

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith(BACKEND_COMMANDS.START_EXPORT, {
        request,
      });
      expect(BACKEND_COMMANDS.START_EXPORT).toBe("start_export");
      expect(result).toEqual(createValidStartResult());
    });

    it("delegates to default Tauri invoke when no custom invoke is provided", async () => {
      const mockedTauriInvoke = vi.mocked(tauriInvoke);
      mockedTauriInvoke.mockResolvedValueOnce(createValidStartResult());
      const request = createValidRequest();

      const result = await startExport(request);

      expect(mockedTauriInvoke).toHaveBeenCalledWith("start_export", {
        request,
      });
      expect(result.runId).toBe("export-run-123");
    });

    describe.each(BACKEND_EXPORT_ERROR_CODES)(
      "accepts backend error code: %s",
      (code: BackendExportErrorCode) => {
        it(`normalizes rejected error with code ${code}`, async () => {
          const mockInvoke = vi.fn().mockRejectedValue({
            code,
            detail: `Diagnostic info for ${code}`,
            exitCode: 1,
            encoder: "libx264",
          });

          await expect(
            startExport(createValidRequest(), { invoke: mockInvoke }),
          ).rejects.toMatchObject({
            code,
            detail: `Diagnostic info for ${code}`,
            exitCode: 1,
            encoder: "libx264",
          });

          try {
            await startExport(createValidRequest(), { invoke: mockInvoke });
          } catch (error) {
            expect(error).toBeInstanceOf(ExportError);
          }
        });
      },
    );

    it("normalizes malformed success responses to an error with code 'unknown'", async () => {
      const mockInvoke = vi.fn().mockResolvedValue({
        runId: "export-run-123",
        // missing presetId, outputPath, segmentCount, totalDurationUs
      });

      try {
        await startExport(createValidRequest(), { invoke: mockInvoke });
        expect.fail("Expected startExport to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(ExportError);
        const expErr = error as ExportError;
        expect(expErr.code).toBe("unknown");
        expect(expErr.detail).toBeUndefined();
        expect(expErr.exitCode).toBeUndefined();
        expect(expErr.encoder).toBeUndefined();
      }
    });

    it("normalizes Error object rejections with detail undefined to prevent leaking local messages", async () => {
      const mockInvoke = vi.fn().mockRejectedValue(new Error("Local IPC failed"));

      try {
        await startExport(createValidRequest(), { invoke: mockInvoke });
        expect.fail("Expected startExport to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(ExportError);
        const expErr = error as ExportError;
        expect(expErr.code).toBe("unknown");
        expect(expErr.detail).toBeUndefined();
        expect(expErr.exitCode).toBeUndefined();
        expect(expErr.encoder).toBeUndefined();
      }
    });
  });

  describe("cancelExport", () => {
    it("invokes the backend command with runId and returns true", async () => {
      const mockInvoke = vi.fn().mockResolvedValue(true);

      const result = await cancelExport("export-run-123", {
        invoke: mockInvoke,
      });

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith(BACKEND_COMMANDS.CANCEL_EXPORT, {
        runId: "export-run-123",
      });
      expect(BACKEND_COMMANDS.CANCEL_EXPORT).toBe("cancel_export");
      expect(result).toBe(true);
    });

    it("invokes the backend command and returns false when runId not found", async () => {
      const mockInvoke = vi.fn().mockResolvedValue(false);

      const result = await cancelExport("nonexistent-run", {
        invoke: mockInvoke,
      });

      expect(mockInvoke).toHaveBeenCalledWith(BACKEND_COMMANDS.CANCEL_EXPORT, {
        runId: "nonexistent-run",
      });
      expect(result).toBe(false);
    });

    it("delegates to default Tauri invoke when no custom invoke is provided", async () => {
      const mockedTauriInvoke = vi.mocked(tauriInvoke);
      mockedTauriInvoke.mockResolvedValueOnce(true);

      const result = await cancelExport("export-run-default");

      expect(mockedTauriInvoke).toHaveBeenCalledWith("cancel_export", {
        runId: "export-run-default",
      });
      expect(result).toBe(true);
    });

    it("throws normalized ExportError when backend returns non-boolean", async () => {
      const mockInvoke = vi.fn().mockResolvedValue("invalid-string-return");

      const promise = cancelExport("export-run-123", { invoke: mockInvoke });
      await expect(promise).rejects.toBeInstanceOf(ExportError);
      await expect(promise).rejects.toMatchObject({
        code: "unknown",
      });
    });

    it("normalizes Error object rejections with detail undefined to prevent leaking local messages", async () => {
      const mockInvoke = vi.fn().mockRejectedValue(new Error("Local IPC disconnect"));

      try {
        await cancelExport("export-run-123", { invoke: mockInvoke });
        expect.fail("Expected cancelExport to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(ExportError);
        const expErr = error as ExportError;
        expect(expErr.code).toBe("unknown");
        expect(expErr.detail).toBeUndefined();
      }
    });

    describe.each(BACKEND_EXPORT_ERROR_CODES)(
      "accepts backend error code: %s",
      (code: BackendExportErrorCode) => {
        it(`normalizes rejected error with code ${code}`, async () => {
          const mockInvoke = vi.fn().mockRejectedValue({
            code,
            detail: `Diagnostic for ${code}`,
          });

          await expect(
            cancelExport("export-run-123", { invoke: mockInvoke }),
          ).rejects.toMatchObject({
            code,
            detail: `Diagnostic for ${code}`,
          });

          try {
            await cancelExport("export-run-123", { invoke: mockInvoke });
          } catch (error) {
            expect(error).toBeInstanceOf(ExportError);
          }
        });
      },
    );
  });

  describe("cancelActiveExport", () => {
    it("invokes the backend command with no arguments and returns true", async () => {
      const mockInvoke = vi.fn().mockResolvedValue(true);

      const result = await cancelActiveExport({ invoke: mockInvoke });

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      // The command takes no run id: it cancels whichever run holds the single export slot,
      // which is the only run there can be while `start_export` has not answered yet.
      expect(mockInvoke).toHaveBeenCalledWith(BACKEND_COMMANDS.CANCEL_ACTIVE_EXPORT);
      expect(BACKEND_COMMANDS.CANCEL_ACTIVE_EXPORT).toBe("cancel_active_export");
      expect(result).toBe(true);
    });

    it("returns false when the export slot was already free", async () => {
      const mockInvoke = vi.fn().mockResolvedValue(false);

      expect(await cancelActiveExport({ invoke: mockInvoke })).toBe(false);
    });

    it("delegates to default Tauri invoke when no custom invoke is provided", async () => {
      const mockedTauriInvoke = vi.mocked(tauriInvoke);
      mockedTauriInvoke.mockResolvedValueOnce(true);

      const result = await cancelActiveExport();

      expect(mockedTauriInvoke).toHaveBeenCalledWith("cancel_active_export", undefined);
      expect(result).toBe(true);
    });

    it("throws normalized ExportError when backend returns non-boolean", async () => {
      const mockInvoke = vi.fn().mockResolvedValue("invalid-string-return");

      const promise = cancelActiveExport({ invoke: mockInvoke });
      await expect(promise).rejects.toBeInstanceOf(ExportError);
      await expect(promise).rejects.toMatchObject({ code: "unknown" });
    });

    it("normalizes Error object rejections with detail undefined to prevent leaking local messages", async () => {
      const mockInvoke = vi.fn().mockRejectedValue(new Error("Local IPC disconnect"));

      try {
        await cancelActiveExport({ invoke: mockInvoke });
        expect.fail("Expected cancelActiveExport to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(ExportError);
        const expErr = error as ExportError;
        expect(expErr.code).toBe("unknown");
        expect(expErr.detail).toBeUndefined();
      }
    });

    describe.each(BACKEND_EXPORT_ERROR_CODES)(
      "accepts backend error code: %s",
      (code: BackendExportErrorCode) => {
        it(`normalizes rejected error with code ${code}`, async () => {
          const mockInvoke = vi.fn().mockRejectedValue({
            code,
            detail: `Diagnostic for ${code}`,
          });

          await expect(
            cancelActiveExport({ invoke: mockInvoke }),
          ).rejects.toMatchObject({
            code,
            detail: `Diagnostic for ${code}`,
          });
        });
      },
    );
  });
});
