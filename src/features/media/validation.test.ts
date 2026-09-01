import { describe, expect, it } from "vitest";
import {
  BACKEND_IMPORT_MEDIA_ERROR_CODES,
  FRONTEND_IMPORT_MEDIA_ERROR_CODES,
  IMPORT_MEDIA_ERROR_CODES,
  ImportMediaError,
  type BackendImportMediaErrorCode,
  type ImportMediaResult,
} from "./types";
import {
  I32_MAX,
  I32_MIN,
  isAudioProbe,
  isBackendImportMediaErrorCode,
  isI32,
  isImportMediaErrorCode,
  isMediaProbe,
  isNonNegativeRational,
  isNonNegativeU32,
  isPositiveRational,
  isPositiveU32,
  isSignedRational,
  normalizeImportMediaError,
  U32_MAX,
  validateImportMediaResult,
} from "./validation";
import type { FrameCount, Pts, TickCount } from "@/types/project";

function createValidProbe(): ImportMediaResult["probe"] {
  return {
    formatNames: ["mov", "mp4", "m4a"],
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
    approximateDurationSeconds: 10.0,
    avgFrameRate: { n: 30000, d: 1001 },
    rFrameRate: { n: 30000, d: 1001 },
    reportedFrameCount: "300" as FrameCount,
    audio: {
      codec: "aac",
      sampleRate: 48000,
      channels: 2,
    },
  };
}

function createValidImportResult(
  overrides: Partial<ImportMediaResult> = {},
): ImportMediaResult {
  return {
    path: "/Users/test/Videos/clip.mp4",
    fileName: "clip.mp4",
    size: 10485760,
    mtime: 1724976000,
    probe: createValidProbe(),
    ...overrides,
  };
}

describe("Media Validation & Normalization", () => {
  describe("Type Guards & Helpers", () => {
    it("recognizes all valid backend error codes", () => {
      for (const code of BACKEND_IMPORT_MEDIA_ERROR_CODES) {
        expect(isBackendImportMediaErrorCode(code)).toBe(true);
        expect(isImportMediaErrorCode(code)).toBe(true);
      }
    });

    it("recognizes all valid frontend error codes", () => {
      for (const code of FRONTEND_IMPORT_MEDIA_ERROR_CODES) {
        expect(isBackendImportMediaErrorCode(code)).toBe(false);
        expect(isImportMediaErrorCode(code)).toBe(true);
      }
    });

    it("recognizes the complete error code set including 'unknown'", () => {
      for (const code of IMPORT_MEDIA_ERROR_CODES) {
        expect(isImportMediaErrorCode(code)).toBe(true);
      }
      expect(isBackendImportMediaErrorCode("unknown")).toBe(false);
      expect(isImportMediaErrorCode("unknown")).toBe(true);
    });

    it("rejects non-string and unknown error code values", () => {
      expect(isBackendImportMediaErrorCode("notARealCode")).toBe(false);
      expect(isImportMediaErrorCode("notARealCode")).toBe(false);
      expect(isBackendImportMediaErrorCode(123)).toBe(false);
      expect(isBackendImportMediaErrorCode(null)).toBe(false);
      expect(isBackendImportMediaErrorCode(undefined)).toBe(false);
      expect(isBackendImportMediaErrorCode({})).toBe(false);
    });

    describe("isPositiveU32", () => {
      it("accepts valid positive u32 boundaries", () => {
        expect(isPositiveU32(1)).toBe(true);
        expect(isPositiveU32(1920)).toBe(true);
        expect(isPositiveU32(U32_MAX)).toBe(true);
      });

      it("rejects zero, negative numbers, over-bound numbers, floats, and non-numbers", () => {
        expect(isPositiveU32(0)).toBe(false);
        expect(isPositiveU32(-1)).toBe(false);
        expect(isPositiveU32(U32_MAX + 1)).toBe(false);
        expect(isPositiveU32(1.5)).toBe(false);
        expect(isPositiveU32(NaN)).toBe(false);
        expect(isPositiveU32(Infinity)).toBe(false);
        expect(isPositiveU32("1920")).toBe(false);
      });
    });

    describe("isNonNegativeU32", () => {
      it("accepts zero and positive u32 boundaries", () => {
        expect(isNonNegativeU32(0)).toBe(true);
        expect(isNonNegativeU32(1)).toBe(true);
        expect(isNonNegativeU32(U32_MAX)).toBe(true);
      });

      it("rejects negative numbers and values over u32", () => {
        expect(isNonNegativeU32(-1)).toBe(false);
        expect(isNonNegativeU32(U32_MAX + 1)).toBe(false);
      });
    });

    describe("isI32", () => {
      it("accepts valid signed i32 boundaries", () => {
        expect(isI32(I32_MIN)).toBe(true);
        expect(isI32(-2_147_483_648)).toBe(true);
        expect(isI32(I32_MAX)).toBe(true);
        expect(isI32(2_147_483_647)).toBe(true);
        expect(isI32(0)).toBe(true);
        expect(isI32(-1)).toBe(true);
        expect(isI32(1)).toBe(true);
      });

      it("rejects under-bound, over-bound, float, and non-numeric values", () => {
        expect(isI32(I32_MIN - 1)).toBe(false);
        expect(isI32(I32_MAX + 1)).toBe(false);
        expect(isI32(Number.MAX_SAFE_INTEGER)).toBe(false);
        expect(isI32(1.5)).toBe(false);
        expect(isI32(NaN)).toBe(false);
        expect(isI32(Infinity)).toBe(false);
        expect(isI32("0")).toBe(false);
      });
    });

    describe("Rational Validation Helpers", () => {
      describe("isSignedRational", () => {
        it("accepts safe integer numerators with positive denominators", () => {
          expect(isSignedRational({ n: -30, d: 1 })).toBe(true);
          expect(isSignedRational({ n: 0, d: 1 })).toBe(true);
          expect(isSignedRational({ n: 30, d: 1 })).toBe(true);
          expect(isSignedRational({ n: 30000, d: 1001 })).toBe(true);
        });

        it("rejects zero or negative denominators, floats, and unsafe integers", () => {
          expect(isSignedRational({ n: 1, d: 0 })).toBe(false);
          expect(isSignedRational({ n: 1, d: -1 })).toBe(false);
          expect(isSignedRational({ n: 1.5, d: 1 })).toBe(false);
          expect(isSignedRational(null)).toBe(false);
        });
      });

      describe("isPositiveRational", () => {
        it("accepts strictly positive numerators with positive denominators", () => {
          expect(isPositiveRational({ n: 1, d: 1 })).toBe(true);
          expect(isPositiveRational({ n: 30000, d: 1001 })).toBe(true);
        });

        it("rejects zero and negative numerators", () => {
          expect(isPositiveRational({ n: 0, d: 1 })).toBe(false);
          expect(isPositiveRational({ n: -1, d: 1 })).toBe(false);
        });
      });

      describe("isNonNegativeRational", () => {
        it("accepts zero numerator and positive numerator", () => {
          expect(isNonNegativeRational({ n: 0, d: 1 })).toBe(true);
          expect(isNonNegativeRational({ n: 10, d: 1 })).toBe(true);
        });

        it("rejects negative numerator", () => {
          expect(isNonNegativeRational({ n: -1, d: 1 })).toBe(false);
        });
      });
    });
  });

  describe("normalizeImportMediaError", () => {
    it("returns the exact same instance if already an ImportMediaError", () => {
      const err = new ImportMediaError({
        code: "invalidPath",
        detail: "bad path",
      });
      expect(normalizeImportMediaError(err)).toBe(err);
    });

    describe.each(BACKEND_IMPORT_MEDIA_ERROR_CODES)(
      "backend error code: %s",
      (code: BackendImportMediaErrorCode) => {
        it(`normalizes error with code ${code}`, () => {
          const raw = { code };
          const normalized = normalizeImportMediaError(raw);
          expect(normalized).toBeInstanceOf(ImportMediaError);
          expect(normalized.code).toBe(code);
          expect(normalized.detail).toBeUndefined();
          expect(normalized.exitCode).toBeUndefined();
        });

        it(`normalizes error with code ${code} and detail`, () => {
          const raw = { code, detail: "Specific diagnostic detail" };
          const normalized = normalizeImportMediaError(raw);
          expect(normalized.code).toBe(code);
          expect(normalized.detail).toBe("Specific diagnostic detail");
          expect(normalized.exitCode).toBeUndefined();
        });

        it(`normalizes error with code ${code}, detail, and exitCode`, () => {
          const raw = {
            code,
            detail: "Process failed",
            exitCode: 1,
          };
          const normalized = normalizeImportMediaError(raw);
          expect(normalized.code).toBe(code);
          expect(normalized.detail).toBe("Process failed");
          expect(normalized.exitCode).toBe(1);
        });
      },
    );

    it("normalizes unrecognized code to 'unknown'", () => {
      const raw = { code: "unexpectedErrorCode", detail: "Internal error" };
      const normalized = normalizeImportMediaError(raw);
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBe("Internal error");
    });

    it("preserves exitCode ONLY when within Rust i32 bounds", () => {
      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: 0,
        }).exitCode,
      ).toBe(0);

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: I32_MAX,
        }).exitCode,
      ).toBe(2_147_483_647);

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: I32_MAX + 1,
        }).exitCode,
      ).toBeUndefined();
    });

    it("normalizes Error instances to code 'unknown' with detail undefined", () => {
      const err = new Error("Connection failed");
      const normalized = normalizeImportMediaError(err);
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBeUndefined();
    });

    it("normalizes plain string errors to code 'unknown' with string as detail", () => {
      const normalized = normalizeImportMediaError("Failed to invoke");
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBe("Failed to invoke");
    });
  });

  describe("isAudioProbe", () => {
    it("validates audio stream probe fields", () => {
      expect(
        isAudioProbe({
          codec: "aac",
          sampleRate: 48000,
          channels: 2,
        }),
      ).toBe(true);

      expect(
        isAudioProbe({
          codec: null,
          sampleRate: null,
          channels: null,
        }),
      ).toBe(true);

      expect(
        isAudioProbe({
          codec: 123,
          sampleRate: 48000,
          channels: 2,
        }),
      ).toBe(false);
    });
  });

  describe("isMediaProbe", () => {
    it("returns true for a valid MediaProbe object", () => {
      expect(isMediaProbe(createValidProbe())).toBe(true);
    });

    it("returns false for non-objects or malformed structures", () => {
      expect(isMediaProbe(null)).toBe(false);
      expect(isMediaProbe(undefined)).toBe(false);
      expect(isMediaProbe("string")).toBe(false);
      expect(isMediaProbe({})).toBe(false);
    });
  });

  describe("validateImportMediaResult with source PTS contracts", () => {
    it("accepts a fully populated valid result", () => {
      const valid = createValidImportResult();
      expect(validateImportMediaResult(valid)).toEqual(valid);
    });

    it("accepts valid nullable optional fields in probe", () => {
      const validWithNulls = createValidImportResult({
        probe: {
          ...createValidProbe(),
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
      });
      expect(validateImportMediaResult(validWithNulls)).toEqual(validWithNulls);
    });

    it("accepts negative start PTS", () => {
      const validWithNegativeStart = createValidImportResult({
        probe: {
          ...createValidProbe(),
          videoStartPts: "-1800" as Pts,
        },
      });
      expect(validateImportMediaResult(validWithNegativeStart)).toEqual(
        validWithNegativeStart,
      );
    });

    it("rejects invalid PTS / TickCount strings in probe", () => {
      expect(() =>
        validateImportMediaResult(
          createValidImportResult({
            probe: {
              ...createValidProbe(),
              videoStartPts: "-0" as Pts,
            },
          }),
        ),
      ).toThrow(TypeError);

      expect(() =>
        validateImportMediaResult(
          createValidImportResult({
            probe: {
              ...createValidProbe(),
              videoDurationTicks: "-1" as TickCount,
            },
          }),
        ),
      ).toThrow(TypeError);

      expect(() =>
        validateImportMediaResult(
          createValidImportResult({
            probe: {
              ...createValidProbe(),
              reportedFrameCount: "invalid" as FrameCount,
            },
          }),
        ),
      ).toThrow(TypeError);
    });

    it.each([-0.5, NaN, Infinity, -Infinity])(
      "normalizes invalid approximateDurationSeconds %s to null",
      (approximateDurationSeconds) => {
        const result = validateImportMediaResult(
          createValidImportResult({
            probe: {
              ...createValidProbe(),
              approximateDurationSeconds,
            },
          }),
        );

        expect(result.probe.approximateDurationSeconds).toBeNull();
      },
    );

    it("rejects invalid videoStreamIndex and videoTimeBase", () => {
      expect(() =>
        validateImportMediaResult(
          createValidImportResult({
            probe: {
              ...createValidProbe(),
              videoStreamIndex: -1,
            },
          }),
        ),
      ).toThrow(TypeError);

      expect(() =>
        validateImportMediaResult(
          createValidImportResult({
            probe: {
              ...createValidProbe(),
              videoTimeBase: { n: 0, d: 1 },
            },
          }),
        ),
      ).toThrow(TypeError);

      expect(() =>
        validateImportMediaResult(
          createValidImportResult({
            probe: {
              ...createValidProbe(),
              videoTimeBase: { n: 1, d: 0 },
            },
          }),
        ),
      ).toThrow(TypeError);
    });

    it("rejects non-objects and null payloads", () => {
      expect(() => validateImportMediaResult(null)).toThrow(TypeError);
      expect(() => validateImportMediaResult(undefined)).toThrow(TypeError);
      expect(() => validateImportMediaResult("string")).toThrow(TypeError);
    });

    it("rejects invalid path, size, or mtime", () => {
      expect(() =>
        validateImportMediaResult(
          createValidImportResult({ path: 123 as unknown as string }),
        ),
      ).toThrow(TypeError);
      expect(() =>
        validateImportMediaResult(createValidImportResult({ size: -1 })),
      ).toThrow(TypeError);
      expect(() =>
        validateImportMediaResult(createValidImportResult({ mtime: NaN })),
      ).toThrow(TypeError);
    });
  });
});
