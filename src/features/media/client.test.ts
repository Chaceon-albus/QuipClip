import { describe, expect, it, vi } from "vitest";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { BACKEND_COMMANDS, invokeCommand, type BackendCommand } from "@/lib/ipc";
import { importMedia, readSourceRevision } from "./client";
import {
  BACKEND_IMPORT_MEDIA_ERROR_CODES,
  ImportMediaError,
  type BackendImportMediaErrorCode,
  type ImportMediaResult,
} from "./types";
import type { FrameCount, Pts, TickCount } from "@/types/project";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function createValidImportResult(): ImportMediaResult {
  return {
    path: "/Users/test/Videos/clip.mp4",
    fileName: "clip.mp4",
    size: 5242880,
    mtime: 1724976000,
    probe: {
      formatNames: ["mov", "mp4"],
      formatLongName: "QuickTime / MOV",
      formatStartTime: null,
      videoCodec: "h264",
      videoProfile: "High",
      pixelFormat: "yuv420p",
      bitDepth: 8,
      width: 1920,
      height: 1080,
      videoStreamIndex: 0,
      videoTimeBase: { n: 1, d: 90000 },
      videoStartPts: "-1800" as Pts,
      videoDurationTicks: "900000" as TickCount,
      approximateDurationSeconds: 10.0,
      avgFrameRate: { n: 30000, d: 1001 },
      rFrameRate: { n: 30000, d: 1001 },
      reportedFrameCount: "300" as FrameCount,
      audio: {
        index: 0,
        codec: "aac",
        sampleRate: 48000,
        channels: 2,
      },
    },
  };
}

describe("IPC & invokeCommand", () => {
  it("invokes Tauri backend using injected invoke function with exact command and args", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({ status: "ok" });
    const result = await invokeCommand(
      BACKEND_COMMANDS.IMPORT_MEDIA,
      { path: "/test/file.mp4" },
      mockInvoke,
    );

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("import_media", {
      path: "/test/file.mp4",
    });
    expect(result).toEqual({ status: "ok" });
  });

  it("delegates to default Tauri invoke when no custom invokeFn is passed", async () => {
    const mockedTauriInvoke = vi.mocked(tauriInvoke);
    mockedTauriInvoke.mockResolvedValueOnce({ ok: true });

    const result = await invokeCommand(BACKEND_COMMANDS.IMPORT_MEDIA, {
      path: "/test.mp4",
    });

    expect(mockedTauriInvoke).toHaveBeenCalledWith("import_media", {
      path: "/test.mp4",
    });
    expect(result).toEqual({ ok: true });
  });

  it("enforces BackendCommand type safety at compile time", () => {
    const validCommand: BackendCommand = BACKEND_COMMANDS.IMPORT_MEDIA;
    expect(validCommand).toBe("import_media");

    // @ts-expect-error - Arbitrary strings must not be accepted by invokeCommand
    void invokeCommand("arbitrary_unknown_command", {});
  });
});

describe("Media Import Client", () => {
  it("invokes the backend with the exact command name and arguments", async () => {
    const mockInvoke = vi.fn().mockResolvedValue(createValidImportResult());

    const result = await importMedia("/path/to/source.mp4", {
      invoke: mockInvoke,
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(BACKEND_COMMANDS.IMPORT_MEDIA, {
      path: "/path/to/source.mp4",
    });
    expect(BACKEND_COMMANDS.IMPORT_MEDIA).toBe("import_media");
    expect(result.path).toBe("/Users/test/Videos/clip.mp4");
  });

  it("successfully parses and validates complete import results", async () => {
    const expected = createValidImportResult();
    const mockInvoke = vi.fn().mockResolvedValue(expected);

    const result = await importMedia("/path/to/source.mp4", {
      invoke: mockInvoke,
    });

    expect(result).toEqual(expected);
  });

  it("handles results with nullable optional fields", async () => {
    const withNulls: ImportMediaResult = {
      ...createValidImportResult(),
      probe: {
        ...createValidImportResult().probe,
        formatLongName: null,
        videoProfile: null,
        pixelFormat: null,
        bitDepth: null,
        videoStartPts: null,
        videoDurationTicks: null,
        approximateDurationSeconds: null,
        avgFrameRate: null,
        rFrameRate: null,
        reportedFrameCount: null,
        audio: null,
      },
    };
    const mockInvoke = vi.fn().mockResolvedValue(withNulls);

    const result = await importMedia("/path/to/source.mp4", {
      invoke: mockInvoke,
    });

    expect(result).toEqual(withNulls);
  });

  describe.each(BACKEND_IMPORT_MEDIA_ERROR_CODES)(
    "accepts backend error code: %s",
    (code: BackendImportMediaErrorCode) => {
      it(`normalizes rejected error with code ${code}`, async () => {
        const mockInvoke = vi.fn().mockRejectedValue({
          code,
          detail: `Diagnostic info for ${code}`,
          exitCode: 1,
        });

        await expect(
          importMedia("/path/to/source.mp4", { invoke: mockInvoke }),
        ).rejects.toMatchObject({
          code,
          detail: `Diagnostic info for ${code}`,
          exitCode: 1,
        });

        try {
          await importMedia("/path/to/source.mp4", { invoke: mockInvoke });
        } catch (error) {
          expect(error).toBeInstanceOf(ImportMediaError);
        }
      });
    },
  );

  it("normalizes unknown or malformed string rejections into safe ImportMediaError with code 'unknown'", async () => {
    const mockInvoke = vi.fn().mockRejectedValue("unexpected rejection");

    await expect(
      importMedia("/path/to/source.mp4", { invoke: mockInvoke }),
    ).rejects.toMatchObject({
      code: "unknown",
      detail: "unexpected rejection",
    });
  });

  it("normalizes Error object rejections with detail undefined to prevent leaking local English messages", async () => {
    const mockInvoke = vi.fn().mockRejectedValue(new Error("IPC failed"));

    const promise = importMedia("/path/to/source.mp4", { invoke: mockInvoke });
    await expect(promise).rejects.toBeInstanceOf(ImportMediaError);
    await expect(promise).rejects.toMatchObject({
      code: "unknown",
      detail: undefined,
      exitCode: undefined,
    });
  });

  it("normalizes malformed success responses to an error with code 'unknown' and undefined detail", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({
      path: "/path/to/source.mp4",
      // missing fileName and probe
    });

    const promise = importMedia("/path/to/source.mp4", { invoke: mockInvoke });
    await expect(promise).rejects.toBeInstanceOf(ImportMediaError);
    await expect(promise).rejects.toMatchObject({
      code: "unknown",
      detail: undefined,
      exitCode: undefined,
    });
  });

  describe("readSourceRevision", () => {
    it("invokes read_source_revision with the path and returns the three facts", async () => {
      const mockInvoke = vi.fn().mockResolvedValue({
        path: "/Users/test/Videos/clip.mp4",
        size: 5242880,
        mtime: 1724976000,
      });

      const revision = await readSourceRevision("/Users/test/Videos/clip.mp4", {
        invoke: mockInvoke,
      });

      expect(mockInvoke).toHaveBeenCalledWith(BACKEND_COMMANDS.READ_SOURCE_REVISION, {
        path: "/Users/test/Videos/clip.mp4",
      });
      expect(revision).toStrictEqual({
        path: "/Users/test/Videos/clip.mp4",
        size: 5242880,
        mtime: 1724976000,
      });
    });

    it("normalizes a backend rejection into an ImportMediaError with its stable code", async () => {
      const mockInvoke = vi.fn().mockRejectedValue({ code: "pathNotFound" });

      const promise = readSourceRevision("/gone.mp4", { invoke: mockInvoke });
      await expect(promise).rejects.toBeInstanceOf(ImportMediaError);
      await expect(promise).rejects.toMatchObject({ code: "pathNotFound" });
    });

    it("normalizes a malformed success response rather than answering a partial revision", async () => {
      const mockInvoke = vi.fn().mockResolvedValue({ path: "/clip.mp4", size: 1 });

      const promise = readSourceRevision("/clip.mp4", { invoke: mockInvoke });
      await expect(promise).rejects.toBeInstanceOf(ImportMediaError);
      await expect(promise).rejects.toMatchObject({ code: "unknown" });
    });
  });
});
