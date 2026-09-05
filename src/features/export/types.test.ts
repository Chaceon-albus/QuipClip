import { describe, expect, it } from "vitest";
import {
  BACKEND_EXPORT_ERROR_CODES,
  EXPORT_ERROR_CODES,
  EXPORT_STATUSES,
  ExportError,
  FRONTEND_EXPORT_ERROR_CODES,
} from "./types";

declare global {
  interface ObjectConstructor {
    hasOwn(o: object, v: PropertyKey): boolean;
  }
}

describe("Export Types & Wire Constants", () => {
  describe("Export Statuses", () => {
    it("contains exactly the expected lifecycle statuses", () => {
      expect(EXPORT_STATUSES).toEqual([
        "idle",
        "preparing",
        "running",
        "finished",
        "canceled",
        "failed",
      ]);
      expect(EXPORT_STATUSES.length).toBe(6);
    });
  });

  describe("Export Error Codes", () => {
    it("contains all 26 backend error codes matching expected literal list in order", () => {
      expect(BACKEND_EXPORT_ERROR_CODES).toEqual([
        "appDataUnavailable",
        "settingsUnreadable",
        "presetNotFound",
        "ffmpegPairMissing",
        "ffprobeSpawnFailed",
        "ffprobeProcessFailed",
        "ffprobeParseFailed",
        "noSegments",
        "tooManySegments",
        "invalidSegment",
        "sourcePathInvalid",
        "sourceNotFound",
        "sourceNotFile",
        "outputPathInvalid",
        "outputDirectoryMissing",
        "outputEqualsSource",
        "outputNotWritable",
        "sourceFrameRateUnknown",
        "encoderUnavailable",
        "ffmpegSpawnFailed",
        "ffmpegProcessFailed",
        "frameCountMismatch",
        "outputRenameFailed",
        "canceled",
        "commandExecutionFailed",
        "exportAlreadyRunning",
      ]);
      expect(BACKEND_EXPORT_ERROR_CODES.length).toBe(26);
    });

    it("contains the frontend dialog error code", () => {
      expect(FRONTEND_EXPORT_ERROR_CODES).toEqual(["dialogFailed"]);
      expect(FRONTEND_EXPORT_ERROR_CODES.length).toBe(1);
    });

    it("contains 28 entries, ends with 'unknown', and has no duplicates", () => {
      expect(EXPORT_ERROR_CODES).toEqual([
        ...BACKEND_EXPORT_ERROR_CODES,
        ...FRONTEND_EXPORT_ERROR_CODES,
        "unknown",
      ]);
      expect(EXPORT_ERROR_CODES.length).toBe(28);
      expect(EXPORT_ERROR_CODES[EXPORT_ERROR_CODES.length - 1]).toBe("unknown");
      expect(new Set(EXPORT_ERROR_CODES).size).toBe(28);
    });
  });

  describe("ExportError", () => {
    it("instantiates correctly with minimal options without optional fields", () => {
      const error = new ExportError({ code: "presetNotFound" });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ExportError);
      expect(error.name).toBe("ExportError");
      expect(error.code).toBe("presetNotFound");
      expect(error.message).toBe("presetNotFound");
      expect(error.detail).toBeUndefined();
      expect(error.exitCode).toBeUndefined();
      expect(error.encoder).toBeUndefined();
      expect("detail" in error).toBe(false);
      expect("exitCode" in error).toBe(false);
      expect("encoder" in error).toBe(false);
      expect(Object.hasOwn(error, "detail")).toBe(false);
      expect(Object.hasOwn(error, "exitCode")).toBe(false);
      expect(Object.hasOwn(error, "encoder")).toBe(false);
    });

    it("omits optional keys when options are explicitly undefined", () => {
      const error = new ExportError({
        code: "canceled",
        detail: undefined,
        exitCode: undefined,
        encoder: undefined,
      });

      expect("detail" in error).toBe(false);
      expect("exitCode" in error).toBe(false);
      expect("encoder" in error).toBe(false);
      expect(Object.hasOwn(error, "detail")).toBe(false);
      expect(Object.hasOwn(error, "exitCode")).toBe(false);
      expect(Object.hasOwn(error, "encoder")).toBe(false);
    });

    it("instantiates correctly with detail and formats message as code: detail", () => {
      const error = new ExportError({
        code: "outputRenameFailed",
        detail: "cross-device link not permitted",
      });

      expect(error.name).toBe("ExportError");
      expect(error.code).toBe("outputRenameFailed");
      expect(error.detail).toBe("cross-device link not permitted");
      expect(error.message).toBe("outputRenameFailed: cross-device link not permitted");
      expect("detail" in error).toBe(true);
      expect("exitCode" in error).toBe(false);
      expect("encoder" in error).toBe(false);
    });

    it("instantiates correctly with all optional fields provided", () => {
      const error = new ExportError({
        code: "ffmpegProcessFailed",
        detail: "encoder segmentation fault",
        exitCode: 139,
        encoder: "h264_videotoolbox",
      });

      expect(error.code).toBe("ffmpegProcessFailed");
      expect(error.detail).toBe("encoder segmentation fault");
      expect(error.exitCode).toBe(139);
      expect(error.encoder).toBe("h264_videotoolbox");
      expect(error.message).toBe("ffmpegProcessFailed: encoder segmentation fault");
      expect("detail" in error).toBe(true);
      expect("exitCode" in error).toBe(true);
      expect("encoder" in error).toBe(true);
    });
  });
});
