import { describe, expect, it } from "vitest";
import {
  BACKEND_EXPORT_ERROR_CODES,
  EXPORT_ERROR_CODES,
  ExportError,
  type ExportProgressEvent,
  type ExportStart,
} from "./types";
import {
  isBackendExportErrorCode,
  isExportErrorCode,
  isExportProgressEvent,
  isExportStart,
  normalizeExportError,
  validateExportProgressEvent,
  validateExportStart,
} from "./validation";

function createValidStart(overrides: Partial<ExportStart> = {}): ExportStart {
  return {
    runId: "run-export-1",
    presetId: "preset-default-mp4",
    outputPath: "/Users/capric98/Movies/out.mp4",
    segmentCount: 3,
    totalDurationUs: 15_000_000,
    ...overrides,
  };
}

describe("Export Validation & Normalization", () => {
  describe("Type Guards", () => {
    it("validates representative backend error codes and rejects non-backend values", () => {
      expect(isBackendExportErrorCode("presetNotFound")).toBe(true);
      expect(isBackendExportErrorCode("ffmpegProcessFailed")).toBe(true);
      expect(isBackendExportErrorCode("frameCountMismatch")).toBe(true);
      expect(isBackendExportErrorCode("canceled")).toBe(true);

      for (const code of BACKEND_EXPORT_ERROR_CODES) {
        expect(isBackendExportErrorCode(code)).toBe(true);
      }

      expect(isBackendExportErrorCode("dialogFailed")).toBe(false);
      expect(isBackendExportErrorCode("unknown")).toBe(false);
      expect(isBackendExportErrorCode("invalidCode")).toBe(false);
      expect(isBackendExportErrorCode(null)).toBe(false);
      expect(isBackendExportErrorCode(123)).toBe(false);
    });

    it("validates representative export error codes and rejects unrecognized values", () => {
      expect(isExportErrorCode("presetNotFound")).toBe(true);
      expect(isExportErrorCode("dialogFailed")).toBe(true);
      expect(isExportErrorCode("unknown")).toBe(true);

      for (const code of EXPORT_ERROR_CODES) {
        expect(isExportErrorCode(code)).toBe(true);
      }

      expect(isExportErrorCode("notAnErrorCode")).toBe(false);
      expect(isExportErrorCode(null)).toBe(false);
    });

    it("validates isExportStart type guard", () => {
      const valid = createValidStart();
      expect(isExportStart(valid)).toBe(true);

      const withExpectedFrames = createValidStart({ expectedFrames: 900 });
      expect(isExportStart(withExpectedFrames)).toBe(true);

      expect(isExportStart(null)).toBe(false);
      expect(isExportStart({})).toBe(false);
      expect(isExportStart({ ...valid, runId: 123 })).toBe(false);
      expect(isExportStart({ ...valid, presetId: null })).toBe(false);
      expect(isExportStart({ ...valid, outputPath: true })).toBe(false);
      expect(isExportStart({ ...valid, segmentCount: 0 })).toBe(false);
      expect(isExportStart({ ...valid, segmentCount: -1 })).toBe(false);
      expect(isExportStart({ ...valid, segmentCount: 1.5 })).toBe(false);
      expect(isExportStart({ ...valid, totalDurationUs: -1 })).toBe(false);
      expect(isExportStart({ ...valid, totalDurationUs: 100.5 })).toBe(false);
      expect(isExportStart({ ...valid, expectedFrames: -1 })).toBe(false);
      expect(isExportStart({ ...valid, expectedFrames: 10.5 })).toBe(false);
    });

    it("validates isExportProgressEvent type guard", () => {
      const startedEvent: ExportProgressEvent = {
        event: "started",
        runId: "run-1",
        outputPath: "/out.mp4",
        segmentCount: 2,
        totalDurationUs: 20_000_000,
      };
      expect(isExportProgressEvent(startedEvent)).toBe(true);

      const publishingEvent: ExportProgressEvent = {
        event: "publishing",
        runId: "run-1",
      };
      expect(isExportProgressEvent(publishingEvent)).toBe(true);
      expect(isExportProgressEvent({ event: "publishing" })).toBe(false);
      expect(isExportProgressEvent({ event: "publishing", runId: 123 })).toBe(false);
      expect(isExportProgressEvent({ event: "publishing", runId: null })).toBe(false);
      expect(isExportProgressEvent({ event: "publishing", runId: undefined })).toBe(
        false,
      );

      expect(isExportProgressEvent(null)).toBe(false);
      expect(isExportProgressEvent({ event: "unknown", runId: "1" })).toBe(false);
      expect(isExportProgressEvent({ event: "finalizing", runId: "1" })).toBe(false);
      expect(isExportProgressEvent({ event: "post-processing", runId: "1" })).toBe(
        false,
      );
      expect(
        isExportProgressEvent({
          event: "progress",
          runId: "run-1",
          frame: 1,
          fps: { n: -60, d: 1 },
        }),
      ).toBe(false);
      expect(
        isExportProgressEvent({
          event: "progress",
          runId: "run-1",
          frame: 0,
          speed: { n: 0, d: 1 },
        }),
      ).toBe(true);
    });
  });

  describe("validateExportStart", () => {
    it("accepts a valid ExportStart payload", () => {
      const start = createValidStart({ expectedFrames: 450 });
      expect(validateExportStart(start)).toEqual(start);
    });

    it("throws TypeError for invalid start payloads", () => {
      expect(() => validateExportStart(null)).toThrow(TypeError);
      expect(() => validateExportStart({})).toThrow(TypeError);
      expect(() =>
        validateExportStart({
          runId: "run-1",
          presetId: "mp4",
          // missing outputPath
          segmentCount: 1,
          totalDurationUs: 1000,
        }),
      ).toThrow(TypeError);
      expect(() => validateExportStart(createValidStart({ segmentCount: 0 }))).toThrow(
        TypeError,
      );
    });
  });

  describe("validateExportProgressEvent", () => {
    it("accepts valid 'started' event with and without expectedFrames", () => {
      const minimalStarted: ExportProgressEvent = {
        event: "started",
        runId: "run-1",
        outputPath: "/tmp/out.mp4",
        segmentCount: 1,
        totalDurationUs: 5_000_000,
      };
      expect(validateExportProgressEvent(minimalStarted)).toEqual(minimalStarted);

      const fullStarted: ExportProgressEvent = {
        ...minimalStarted,
        expectedFrames: 300,
      };
      expect(validateExportProgressEvent(fullStarted)).toEqual(fullStarted);
    });

    it("accepts valid 'progress' event with and without optional fields", () => {
      const minimalProgress: ExportProgressEvent = {
        event: "progress",
        runId: "run-1",
        frame: 120,
      };
      expect(validateExportProgressEvent(minimalProgress)).toEqual(minimalProgress);

      const fullProgress: ExportProgressEvent = {
        event: "progress",
        runId: "run-1",
        frame: 150,
        expectedFrames: 300,
        fps: { n: 60, d: 1 },
        speed: { n: 15, d: 10 },
        totalSize: 1024 * 1024,
      };
      expect(validateExportProgressEvent(fullProgress)).toEqual(fullProgress);

      const zeroSpeedProgress: ExportProgressEvent = {
        event: "progress",
        runId: "run-1",
        frame: 0,
        speed: { n: 0, d: 1 },
      };
      expect(validateExportProgressEvent(zeroSpeedProgress)).toEqual(zeroSpeedProgress);
    });

    it("accepts valid 'publishing' event", () => {
      const publishing: ExportProgressEvent = {
        event: "publishing",
        runId: "run-1",
      };
      expect(validateExportProgressEvent(publishing)).toEqual(publishing);
    });

    it("accepts valid 'finished' event", () => {
      const finished: ExportProgressEvent = {
        event: "finished",
        runId: "run-1",
        outputPath: "/tmp/out.mp4",
        frames: 300,
      };
      expect(validateExportProgressEvent(finished)).toEqual(finished);
    });

    it("accepts valid 'failed' event with and without optional fields", () => {
      const minimalFailed: ExportProgressEvent = {
        event: "failed",
        runId: "run-1",
        code: "ffmpegSpawnFailed",
      };
      expect(validateExportProgressEvent(minimalFailed)).toEqual(minimalFailed);

      const fullFailed: ExportProgressEvent = {
        event: "failed",
        runId: "run-1",
        code: "ffmpegProcessFailed",
        detail: "Segmentation fault in libx264",
        exitCode: 139,
        encoder: "libx264",
      };
      expect(validateExportProgressEvent(fullFailed)).toEqual(fullFailed);
    });

    it("rejects event when runId is missing or non-string", () => {
      expect(() =>
        validateExportProgressEvent({
          event: "started",
          outputPath: "/out.mp4",
          segmentCount: 1,
          totalDurationUs: 1000,
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: 123,
          frame: 10,
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "publishing",
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "publishing",
          runId: 123,
        }),
      ).toThrow(TypeError);
    });

    it("rejects event when tag is non-string or unknown", () => {
      expect(() =>
        validateExportProgressEvent({
          event: 42,
          runId: "r",
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "unknownTag",
          runId: "run-1",
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "finalizing",
          runId: "run-1",
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "post-processing",
          runId: "run-1",
        }),
      ).toThrow(TypeError);
    });

    it("rejects 'failed' event with frontend-only or unknown error code", () => {
      expect(() =>
        validateExportProgressEvent({
          event: "failed",
          runId: "run-1",
          code: "unknown",
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "failed",
          runId: "run-1",
          code: "dialogFailed",
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "failed",
          runId: "run-1",
          code: "nonExistentCode",
        }),
      ).toThrow(TypeError);
    });

    it("rejects malformed 'started' events with invalid fields", () => {
      // segmentCount must be positive u32 (0 is invalid)
      expect(() =>
        validateExportProgressEvent({
          event: "started",
          runId: "r",
          outputPath: "/o",
          segmentCount: 0,
          totalDurationUs: 1,
        }),
      ).toThrow(TypeError);

      // outputPath must be string
      expect(() =>
        validateExportProgressEvent({
          event: "started",
          runId: "r",
          outputPath: 123,
          segmentCount: 1,
          totalDurationUs: 1,
        }),
      ).toThrow(TypeError);

      // totalDurationUs must be non-negative
      expect(() =>
        validateExportProgressEvent({
          event: "started",
          runId: "r",
          outputPath: "/o",
          segmentCount: 1,
          totalDurationUs: -5,
        }),
      ).toThrow(TypeError);

      // totalDurationUs must be a safe integer
      expect(() =>
        validateExportProgressEvent({
          event: "started",
          runId: "r",
          outputPath: "/o",
          segmentCount: 1,
          totalDurationUs: 1.5,
        }),
      ).toThrow(TypeError);

      // expectedFrames must be non-negative u32 when present
      expect(() =>
        validateExportProgressEvent({
          event: "started",
          runId: "r",
          outputPath: "/o",
          segmentCount: 1,
          totalDurationUs: 1,
          expectedFrames: -1,
        }),
      ).toThrow(TypeError);
    });

    it("rejects malformed 'finished' events with invalid or missing frames", () => {
      // no frames key at all
      expect(() =>
        validateExportProgressEvent({
          event: "finished",
          runId: "r",
          outputPath: "/o",
          durationUs: 1,
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "finished",
          runId: "r",
          outputPath: "/o",
        }),
      ).toThrow(TypeError);

      // frames must be non-negative u32
      expect(() =>
        validateExportProgressEvent({
          event: "finished",
          runId: "r",
          outputPath: "/o",
          durationUs: 1,
          frames: -1,
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "finished",
          runId: "r",
          outputPath: "/o",
          frames: -1,
        }),
      ).toThrow(TypeError);

      // frames must be safe integer u32
      expect(() =>
        validateExportProgressEvent({
          event: "finished",
          runId: "r",
          outputPath: "/o",
          frames: 1.5,
        }),
      ).toThrow(TypeError);

      // outputPath must be string
      expect(() =>
        validateExportProgressEvent({
          event: "finished",
          runId: "r",
          outputPath: 123,
          frames: 100,
        }),
      ).toThrow(TypeError);
    });

    it("rejects malformed 'failed' events with non-string detail, encoder, or out-of-range exitCode", () => {
      // detail must be string when present
      expect(() =>
        validateExportProgressEvent({
          event: "failed",
          runId: "r",
          code: "canceled",
          detail: { a: 1 },
        }),
      ).toThrow(TypeError);

      // encoder must be string when present
      expect(() =>
        validateExportProgressEvent({
          event: "failed",
          runId: "r",
          code: "canceled",
          encoder: 42,
        }),
      ).toThrow(TypeError);

      // exitCode must be i32 when present
      expect(() =>
        validateExportProgressEvent({
          event: "failed",
          runId: "run-1",
          code: "ffmpegProcessFailed",
          exitCode: 2_147_483_648,
        }),
      ).toThrow(TypeError);
    });

    it("rejects malformed 'progress' events with invalid speed, expectedFrames, totalSize, or frame", () => {
      // speed must be non-negative rational (n >= 0, d > 0)
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "r",
          frame: 1,
          speed: { n: -1, d: 1 },
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "r",
          frame: 1,
          speed: 42,
        }),
      ).toThrow(TypeError);

      // expectedFrames must be non-negative u32 when present
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "r",
          frame: 1,
          expectedFrames: -1,
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "r",
          frame: 1,
          expectedFrames: 1.5,
        }),
      ).toThrow(TypeError);

      // totalSize must be non-negative safe integer when present
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "r",
          frame: 1,
          totalSize: -1,
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "r",
          frame: 1,
          totalSize: 1024.5,
        }),
      ).toThrow(TypeError);

      // frame must be non-negative u32
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "r",
          frame: -1,
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "r",
          frame: 1.5,
        }),
      ).toThrow(TypeError);
    });

    it("rejects rational fields violating rational fraction constraints or positive/non-negative rules", () => {
      // fps: non-number n
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "run-1",
          frame: 10,
          fps: { n: "30", d: 1 },
        }),
      ).toThrow(TypeError);

      // fps: non-integer n
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "run-1",
          frame: 10,
          fps: { n: 30.5, d: 1 },
        }),
      ).toThrow(TypeError);

      // fps: non-number d
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "run-1",
          frame: 10,
          fps: { n: 30, d: "1" },
        }),
      ).toThrow(TypeError);

      // fps: non-integer d
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "run-1",
          frame: 10,
          fps: { n: 30, d: 1.5 },
        }),
      ).toThrow(TypeError);

      // fps: denominator zero (d > 0 required)
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "run-1",
          frame: 10,
          fps: { n: 30, d: 0 },
        }),
      ).toThrow(TypeError);

      // fps: denominator negative (d > 0 required)
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "run-1",
          frame: 10,
          fps: { n: 30, d: -1 },
        }),
      ).toThrow(TypeError);

      // fps: null is not an object
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "run-1",
          frame: 10,
          fps: null,
        }),
      ).toThrow(TypeError);

      // fps: negative frame rate (must be strictly positive, not merely signed)
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "run-1",
          frame: 10,
          fps: { n: -60, d: 1 },
        }),
      ).toThrow(TypeError);

      // fps: zero frame rate (must be strictly positive)
      expect(() =>
        validateExportProgressEvent({
          event: "progress",
          runId: "run-1",
          frame: 10,
          fps: { n: 0, d: 1 },
        }),
      ).toThrow(TypeError);
    });
  });

  describe("normalizeExportError", () => {
    it("returns the exact same instance if already an ExportError", () => {
      const existing = new ExportError({
        code: "presetNotFound",
        detail: "Custom preset missing",
      });
      expect(normalizeExportError(existing)).toBe(existing);
    });

    it("preserves a backend code with detail, exitCode, and encoder", () => {
      const raw = {
        code: "ffmpegProcessFailed",
        detail: "Diagnostic info for ffmpegProcessFailed",
        exitCode: 1,
        encoder: "h264_videotoolbox",
      };

      const normalized = normalizeExportError(raw);

      expect(normalized).toBeInstanceOf(ExportError);
      expect(normalized.code).toBe("ffmpegProcessFailed");
      expect(normalized.detail).toBe("Diagnostic info for ffmpegProcessFailed");
      expect(normalized.exitCode).toBe(1);
      expect(normalized.encoder).toBe("h264_videotoolbox");
    });

    it("normalizes an object with a known code and preserves detail", () => {
      const normalized = normalizeExportError({
        code: "invalidSegment",
        detail: "inPts is after outPts",
      });
      expect(normalized.code).toBe("invalidSegment");
      expect(normalized.detail).toBe("inPts is after outPts");
    });

    it("normalizes an object with an unknown code to code 'unknown'", () => {
      const normalized = normalizeExportError({
        code: "somethingTotallyUnexpected",
        detail: "Crash log info",
      });
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBe("Crash log info");
    });

    it("normalizes plain Error instances to code 'unknown' without leaking local message into detail", () => {
      const err = new Error("boom");
      const normalized = normalizeExportError(err);
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBeUndefined();
      expect("detail" in normalized).toBe(false);
    });

    it("normalizes a non-empty string to code 'unknown' with string as detail", () => {
      const normalized = normalizeExportError("Pipe broken abruptly");
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBe("Pipe broken abruptly");
    });

    it("normalizes null, undefined, numbers, and empty strings to code 'unknown' with no detail", () => {
      expect(normalizeExportError(null).code).toBe("unknown");
      expect(normalizeExportError(null).detail).toBeUndefined();

      expect(normalizeExportError(undefined).code).toBe("unknown");
      expect(normalizeExportError(undefined).detail).toBeUndefined();

      expect(normalizeExportError(42).code).toBe("unknown");
      expect(normalizeExportError(42).detail).toBeUndefined();

      expect(normalizeExportError("").code).toBe("unknown");
      expect(normalizeExportError("").detail).toBeUndefined();
    });

    it("preserves exitCode ONLY when within Rust i32 bounds", () => {
      expect(
        normalizeExportError({
          code: "ffmpegProcessFailed",
          exitCode: 0,
        }).exitCode,
      ).toBe(0);

      expect(
        normalizeExportError({
          code: "ffmpegProcessFailed",
          exitCode: 2_147_483_647,
        }).exitCode,
      ).toBe(2_147_483_647);

      expect(
        normalizeExportError({
          code: "ffmpegProcessFailed",
          exitCode: 2_147_483_648,
        }).exitCode,
      ).toBeUndefined();
    });

    it("preserves encoder ONLY when it is a string", () => {
      expect(
        normalizeExportError({
          code: "encoderUnavailable",
          encoder: "hevc_videotoolbox",
        }).encoder,
      ).toBe("hevc_videotoolbox");

      expect(
        normalizeExportError({
          code: "encoderUnavailable",
          encoder: 123,
        }).encoder,
      ).toBeUndefined();
    });
  });
});
