import { describe, expect, it } from "vitest";
import {
  BACKEND_IMPORT_MEDIA_ERROR_CODES,
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
  isPositiveRational,
  isPositiveU32,
  isSignedRational,
  normalizeImportMediaError,
  U32_MAX,
  validateImportMediaResult,
} from "./validation";

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
    avgFrameRate: { n: 30000, d: 1001 },
    rFrameRate: { n: 30000, d: 1001 },
    startTime: { n: 0, d: 1 },
    duration: { n: 10010, d: 1000 },
    frameCount: 300,
    audio: {
      codec: "aac",
      sampleRate: 48000,
      channels: 2,
    },
    isVfr: false,
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
        expect(isPositiveU32(4_294_967_295)).toBe(true);
      });

      it("rejects zero, negative numbers, over-bound numbers, floats, and non-numbers", () => {
        expect(isPositiveU32(0)).toBe(false);
        expect(isPositiveU32(-1)).toBe(false);
        expect(isPositiveU32(U32_MAX + 1)).toBe(false);
        expect(isPositiveU32(4_294_967_296)).toBe(false);
        expect(isPositiveU32(1.5)).toBe(false);
        expect(isPositiveU32(NaN)).toBe(false);
        expect(isPositiveU32(Infinity)).toBe(false);
        expect(isPositiveU32(-Infinity)).toBe(false);
        expect(isPositiveU32("1920")).toBe(false);
        expect(isPositiveU32(null)).toBe(false);
        expect(isPositiveU32(undefined)).toBe(false);
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
        expect(isI32(127)).toBe(true);
      });

      it("rejects under-bound, over-bound, float, and non-numeric values", () => {
        expect(isI32(I32_MIN - 1)).toBe(false);
        expect(isI32(-2_147_483_649)).toBe(false);
        expect(isI32(I32_MAX + 1)).toBe(false);
        expect(isI32(2_147_483_648)).toBe(false);
        expect(isI32(Number.MAX_SAFE_INTEGER)).toBe(false);
        expect(isI32(Number.MIN_SAFE_INTEGER)).toBe(false);
        expect(isI32(1.5)).toBe(false);
        expect(isI32(-1.5)).toBe(false);
        expect(isI32(NaN)).toBe(false);
        expect(isI32(Infinity)).toBe(false);
        expect(isI32(-Infinity)).toBe(false);
        expect(isI32("0")).toBe(false);
        expect(isI32(null)).toBe(false);
      });
    });

    describe("Rational Validation Helpers", () => {
      describe("isSignedRational", () => {
        it("accepts safe integer numerators (negative, zero, positive) with positive denominators", () => {
          expect(isSignedRational({ n: -30, d: 1 })).toBe(true);
          expect(isSignedRational({ n: 0, d: 1 })).toBe(true);
          expect(isSignedRational({ n: 30, d: 1 })).toBe(true);
          expect(isSignedRational({ n: 30000, d: 1001 })).toBe(true);
          expect(isSignedRational({ n: Number.MIN_SAFE_INTEGER, d: 1 })).toBe(true);
          expect(
            isSignedRational({
              n: Number.MAX_SAFE_INTEGER,
              d: Number.MAX_SAFE_INTEGER,
            }),
          ).toBe(true);
        });

        it("rejects zero or negative denominators, floats, and unsafe integers", () => {
          expect(isSignedRational({ n: 1, d: 0 })).toBe(false);
          expect(isSignedRational({ n: 1, d: -1 })).toBe(false);
          expect(isSignedRational({ n: -1, d: -1 })).toBe(false);
          expect(isSignedRational({ n: 1.5, d: 1 })).toBe(false);
          expect(isSignedRational({ n: 1, d: 1.5 })).toBe(false);
          expect(isSignedRational({ n: Number.MAX_SAFE_INTEGER + 1, d: 1 })).toBe(
            false,
          );
          expect(isSignedRational({ n: 1, d: Number.MAX_SAFE_INTEGER + 1 })).toBe(
            false,
          );
          expect(isSignedRational(null)).toBe(false);
          expect(isSignedRational(undefined)).toBe(false);
          expect(isSignedRational({})).toBe(false);
        });
      });

      describe("isPositiveRational (avgFrameRate / rFrameRate)", () => {
        it("accepts strictly positive numerators with positive denominators", () => {
          expect(isPositiveRational({ n: 1, d: 1 })).toBe(true);
          expect(isPositiveRational({ n: 30, d: 1 })).toBe(true);
          expect(isPositiveRational({ n: 30000, d: 1001 })).toBe(true);
          expect(isPositiveRational({ n: 24000, d: 1001 })).toBe(true);
          expect(isPositiveRational({ n: 60, d: 1 })).toBe(true);
        });

        it("rejects zero numerator", () => {
          expect(isPositiveRational({ n: 0, d: 1 })).toBe(false);
          expect(isPositiveRational({ n: 0, d: 1001 })).toBe(false);
        });

        it("rejects negative numerator", () => {
          expect(isPositiveRational({ n: -1, d: 1 })).toBe(false);
          expect(isPositiveRational({ n: -30, d: 1 })).toBe(false);
          expect(isPositiveRational({ n: -30000, d: 1001 })).toBe(false);
        });

        it("rejects invalid denominators and non-integers", () => {
          expect(isPositiveRational({ n: 30, d: 0 })).toBe(false);
          expect(isPositiveRational({ n: 30, d: -1 })).toBe(false);
          expect(isPositiveRational({ n: 30.5, d: 1 })).toBe(false);
          expect(isPositiveRational({ n: 30, d: 1.5 })).toBe(false);
        });
      });

      describe("isNonNegativeRational (duration)", () => {
        it("accepts zero numerator (non-negative)", () => {
          expect(isNonNegativeRational({ n: 0, d: 1 })).toBe(true);
          expect(isNonNegativeRational({ n: 0, d: 1000 })).toBe(true);
        });

        it("accepts positive numerator", () => {
          expect(isNonNegativeRational({ n: 1, d: 1 })).toBe(true);
          expect(isNonNegativeRational({ n: 10, d: 1 })).toBe(true);
          expect(isNonNegativeRational({ n: 10010, d: 1000 })).toBe(true);
        });

        it("rejects negative numerator", () => {
          expect(isNonNegativeRational({ n: -1, d: 1 })).toBe(false);
          expect(isNonNegativeRational({ n: -10, d: 1 })).toBe(false);
          expect(isNonNegativeRational({ n: -100, d: 1000 })).toBe(false);
        });

        it("rejects invalid denominators and non-integers", () => {
          expect(isNonNegativeRational({ n: 10, d: 0 })).toBe(false);
          expect(isNonNegativeRational({ n: 10, d: -1 })).toBe(false);
          expect(isNonNegativeRational({ n: 10.5, d: 1 })).toBe(false);
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

    it("normalizes explicit 'unknown' code", () => {
      const raw = { code: "unknown", detail: "Something failed" };
      const normalized = normalizeImportMediaError(raw);
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBe("Something failed");
    });

    it("normalizes unrecognized code to 'unknown'", () => {
      const raw = { code: "unexpectedErrorCode", detail: "Internal error" };
      const normalized = normalizeImportMediaError(raw);
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBe("Internal error");
    });

    it("preserves detail ONLY when it is a string from backend/rejections", () => {
      const e1 = normalizeImportMediaError({
        code: "invalidPath",
        detail: 12345,
      });
      expect(e1.code).toBe("invalidPath");
      expect(e1.detail).toBeUndefined();

      const e2 = normalizeImportMediaError({
        code: "invalidPath",
        detail: null,
      });
      expect(e2.code).toBe("invalidPath");
      expect(e2.detail).toBeUndefined();

      const e3 = normalizeImportMediaError({ code: "invalidPath", detail: {} });
      expect(e3.code).toBe("invalidPath");
      expect(e3.detail).toBeUndefined();

      const e4 = normalizeImportMediaError({
        code: "invalidPath",
        detail: true,
      });
      expect(e4.code).toBe("invalidPath");
      expect(e4.detail).toBeUndefined();
    });

    it("preserves exitCode ONLY when it fits within Rust i32 range (-2_147_483_648..=2_147_483_647)", () => {
      // Valid boundaries and values
      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: 0,
        }).exitCode,
      ).toBe(0);

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: -1,
        }).exitCode,
      ).toBe(-1);

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: 127,
        }).exitCode,
      ).toBe(127);

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: I32_MIN,
        }).exitCode,
      ).toBe(-2_147_483_648);

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: I32_MAX,
        }).exitCode,
      ).toBe(2_147_483_647);

      // Under-bound and over-bound values
      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: I32_MIN - 1,
        }).exitCode,
      ).toBeUndefined();

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: -2_147_483_649,
        }).exitCode,
      ).toBeUndefined();

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: I32_MAX + 1,
        }).exitCode,
      ).toBeUndefined();

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: 2_147_483_648,
        }).exitCode,
      ).toBeUndefined();

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: Number.MAX_SAFE_INTEGER,
        }).exitCode,
      ).toBeUndefined();

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: "127",
        }).exitCode,
      ).toBeUndefined();

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: 1.5,
        }).exitCode,
      ).toBeUndefined();

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: NaN,
        }).exitCode,
      ).toBeUndefined();

      expect(
        normalizeImportMediaError({
          code: "ffprobeProcessFailed",
          exitCode: Infinity,
        }).exitCode,
      ).toBeUndefined();
    });

    it("normalizes Error instances to code 'unknown' with detail undefined to prevent leaking local English messages", () => {
      const err = new Error("Connection failed");
      const normalized = normalizeImportMediaError(err);
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBeUndefined();
    });

    it("normalizes TypeError validation errors to code 'unknown' with detail undefined", () => {
      const typeError = new TypeError(
        "Invalid media import result: probe payload is invalid or malformed",
      );
      const normalized = normalizeImportMediaError(typeError);
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBeUndefined();
    });

    it("normalizes plain string errors to code 'unknown' with string as detail", () => {
      const normalized = normalizeImportMediaError("Failed to invoke");
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBe("Failed to invoke");
    });

    it("normalizes empty string, null, undefined, and non-object primitives to bare { code: 'unknown' }", () => {
      expect(normalizeImportMediaError("").code).toBe("unknown");
      expect(normalizeImportMediaError(null).code).toBe("unknown");
      expect(normalizeImportMediaError(undefined).code).toBe("unknown");
      expect(normalizeImportMediaError(123).code).toBe("unknown");
      expect(normalizeImportMediaError(true).code).toBe("unknown");
      expect(normalizeImportMediaError(Symbol("err")).code).toBe("unknown");
      expect(normalizeImportMediaError({}).code).toBe("unknown");
    });
  });

  describe("validateImportMediaResult", () => {
    it("accepts a fully populated valid result", () => {
      const valid = createValidImportResult();
      expect(validateImportMediaResult(valid)).toEqual(valid);
    });

    it("accepts valid optional null fields in probe and audio", () => {
      const validWithNulls = createValidImportResult({
        probe: {
          ...createValidProbe(),
          formatLongName: null,
          videoProfile: null,
          pixelFormat: null,
          bitDepth: null,
          duration: null,
          audio: null,
        },
      });
      expect(validateImportMediaResult(validWithNulls)).toEqual(validWithNulls);

      const validWithEmptyAudio = createValidImportResult({
        probe: {
          ...createValidProbe(),
          audio: {
            codec: null,
            sampleRate: null,
            channels: null,
          },
        },
      });
      expect(validateImportMediaResult(validWithEmptyAudio)).toEqual(
        validWithEmptyAudio,
      );
    });

    it("rejects non-objects and null payloads", () => {
      expect(() => validateImportMediaResult(null)).toThrow(TypeError);
      expect(() => validateImportMediaResult(undefined)).toThrow(TypeError);
      expect(() => validateImportMediaResult("string")).toThrow(TypeError);
      expect(() => validateImportMediaResult(123)).toThrow(TypeError);
    });

    it("rejects invalid path and fileName", () => {
      expect(() =>
        validateImportMediaResult(
          createValidImportResult({ path: 123 as unknown as string }),
        ),
      ).toThrow(TypeError);
      expect(() =>
        validateImportMediaResult(
          createValidImportResult({ fileName: null as unknown as string }),
        ),
      ).toThrow(TypeError);
    });

    describe("size and mtime validation", () => {
      it("accepts valid boundary size values (0 through MAX_SAFE_INTEGER)", () => {
        expect(
          validateImportMediaResult(createValidImportResult({ size: 0 })),
        ).toBeDefined();
        expect(
          validateImportMediaResult(
            createValidImportResult({ size: Number.MAX_SAFE_INTEGER }),
          ),
        ).toBeDefined();
      });

      it("rejects negative, over-bound, float, or NaN size", () => {
        expect(() =>
          validateImportMediaResult(createValidImportResult({ size: -1 })),
        ).toThrow(TypeError);
        expect(() =>
          validateImportMediaResult(
            createValidImportResult({ size: Number.MAX_SAFE_INTEGER + 1 }),
          ),
        ).toThrow(TypeError);
        expect(() =>
          validateImportMediaResult(createValidImportResult({ size: 1.5 })),
        ).toThrow(TypeError);
        expect(() =>
          validateImportMediaResult(createValidImportResult({ size: NaN })),
        ).toThrow(TypeError);
      });

      it("accepts valid boundary mtime values (-MAX_SAFE_INTEGER through MAX_SAFE_INTEGER)", () => {
        expect(
          validateImportMediaResult(createValidImportResult({ mtime: 0 })),
        ).toBeDefined();
        expect(
          validateImportMediaResult(
            createValidImportResult({ mtime: Number.MIN_SAFE_INTEGER }),
          ),
        ).toBeDefined();
        expect(
          validateImportMediaResult(
            createValidImportResult({ mtime: Number.MAX_SAFE_INTEGER }),
          ),
        ).toBeDefined();
      });

      it("rejects unsafe or float mtime", () => {
        expect(() =>
          validateImportMediaResult(
            createValidImportResult({ mtime: Number.MIN_SAFE_INTEGER - 1 }),
          ),
        ).toThrow(TypeError);
        expect(() =>
          validateImportMediaResult(
            createValidImportResult({ mtime: Number.MAX_SAFE_INTEGER + 1 }),
          ),
        ).toThrow(TypeError);
        expect(() =>
          validateImportMediaResult(createValidImportResult({ mtime: 1.5 })),
        ).toThrow(TypeError);
        expect(() =>
          validateImportMediaResult(createValidImportResult({ mtime: NaN })),
        ).toThrow(TypeError);
      });
    });

    describe("MediaProbe Rational Semantic Roles", () => {
      const base = createValidImportResult();

      describe("avgFrameRate and rFrameRate (require safe integer n > 0 and d > 0)", () => {
        it("accepts positive integer frame rates", () => {
          expect(
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                avgFrameRate: { n: 30, d: 1 },
                rFrameRate: { n: 30000, d: 1001 },
              },
            }),
          ).toBeDefined();
        });

        it("rejects zero numerator for avgFrameRate and rFrameRate", () => {
          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                avgFrameRate: { n: 0, d: 1 },
              },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                rFrameRate: { n: 0, d: 1 },
              },
            }),
          ).toThrow(TypeError);
        });

        it("rejects negative numerator for avgFrameRate and rFrameRate", () => {
          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                avgFrameRate: { n: -30, d: 1 },
              },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                rFrameRate: { n: -30000, d: 1001 },
              },
            }),
          ).toThrow(TypeError);
        });

        it("rejects zero or negative denominator for avgFrameRate and rFrameRate", () => {
          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                avgFrameRate: { n: 30, d: 0 },
              },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                rFrameRate: { n: 30, d: -1 },
              },
            }),
          ).toThrow(TypeError);
        });
      });

      describe("duration (requires non-negative rational n >= 0, d > 0 when non-null)", () => {
        it("accepts zero duration rational (n = 0, d > 0)", () => {
          expect(
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                duration: { n: 0, d: 1 },
              },
            }),
          ).toBeDefined();
        });

        it("accepts positive duration rational", () => {
          expect(
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                duration: { n: 100, d: 1 },
              },
            }),
          ).toBeDefined();
        });

        it("rejects negative duration rational", () => {
          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                duration: { n: -1, d: 1 },
              },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                duration: { n: -10, d: 1 },
              },
            }),
          ).toThrow(TypeError);
        });

        it("rejects zero or negative denominator for duration", () => {
          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                duration: { n: 10, d: 0 },
              },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                duration: { n: 10, d: -1 },
              },
            }),
          ).toThrow(TypeError);
        });
      });

      describe("startTime (signed rational: may be negative, zero, or positive, with d > 0)", () => {
        it("accepts negative startTime rational", () => {
          expect(
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                startTime: { n: -10, d: 1 },
              },
            }),
          ).toBeDefined();

          expect(
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                startTime: { n: -1, d: 1000 },
              },
            }),
          ).toBeDefined();
        });

        it("accepts zero startTime rational", () => {
          expect(
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                startTime: { n: 0, d: 1 },
              },
            }),
          ).toBeDefined();
        });

        it("accepts positive startTime rational", () => {
          expect(
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                startTime: { n: 15, d: 1 },
              },
            }),
          ).toBeDefined();
        });

        it("rejects zero or negative denominator for startTime", () => {
          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                startTime: { n: 0, d: 0 },
              },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                startTime: { n: -5, d: -1 },
              },
            }),
          ).toThrow(TypeError);
        });
      });
    });

    describe("MediaProbe Rust Numeric Bounds (u32, frameCount, audio)", () => {
      const base = createValidImportResult();

      describe("width and height (u32: 1..=4_294_967_295)", () => {
        it("accepts boundary values (1 and U32_MAX)", () => {
          expect(
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                width: 1,
                height: U32_MAX,
              },
            }),
          ).toBeDefined();

          expect(
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                width: U32_MAX,
                height: 1,
              },
            }),
          ).toBeDefined();
        });

        it("rejects width <= 0 or over u32 bound", () => {
          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, width: 0 },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, width: -1 },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, width: U32_MAX + 1 },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, width: 1920.5 },
            }),
          ).toThrow(TypeError);
        });

        it("rejects height <= 0 or over u32 bound", () => {
          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, height: 0 },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, height: -1080 },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, height: U32_MAX + 1 },
            }),
          ).toThrow(TypeError);
        });
      });

      describe("bitDepth (Option<u32>: null or 1..=4_294_967_295)", () => {
        it("accepts valid bitDepth values and null", () => {
          expect(
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, bitDepth: null },
            }),
          ).toBeDefined();

          expect(
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, bitDepth: 1 },
            }),
          ).toBeDefined();

          expect(
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, bitDepth: 8 },
            }),
          ).toBeDefined();

          expect(
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, bitDepth: 10 },
            }),
          ).toBeDefined();

          expect(
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, bitDepth: U32_MAX },
            }),
          ).toBeDefined();
        });

        it("rejects bitDepth <= 0, over-bound, or float", () => {
          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, bitDepth: 0 },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, bitDepth: -8 },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, bitDepth: U32_MAX + 1 },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, bitDepth: 8.5 },
            }),
          ).toThrow(TypeError);
        });
      });

      describe("frameCount (i64 non-negative safe integer)", () => {
        it("accepts valid boundary frameCount values", () => {
          expect(
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, frameCount: 0 },
            }),
          ).toBeDefined();

          expect(
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, frameCount: Number.MAX_SAFE_INTEGER },
            }),
          ).toBeDefined();
        });

        it("rejects negative, over-bound, or float frameCount", () => {
          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, frameCount: -1 },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, frameCount: Number.MAX_SAFE_INTEGER + 1 },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: { ...base.probe, frameCount: 100.5 },
            }),
          ).toThrow(TypeError);
        });
      });

      describe("AudioProbe (sampleRate & channels from Option<u32>)", () => {
        it("accepts valid audio sampleRate and channels boundary values", () => {
          expect(
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                audio: {
                  codec: "aac",
                  sampleRate: 1,
                  channels: 1,
                },
              },
            }),
          ).toBeDefined();

          expect(
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                audio: {
                  codec: "flac",
                  sampleRate: U32_MAX,
                  channels: U32_MAX,
                },
              },
            }),
          ).toBeDefined();
        });

        it("rejects sampleRate <= 0, over-bound, or float", () => {
          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                audio: { codec: "aac", sampleRate: 0, channels: 2 },
              },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                audio: { codec: "aac", sampleRate: -48000, channels: 2 },
              },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                audio: { codec: "aac", sampleRate: U32_MAX + 1, channels: 2 },
              },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                audio: { codec: "aac", sampleRate: 48000.5, channels: 2 },
              },
            }),
          ).toThrow(TypeError);
        });

        it("rejects channels <= 0, over-bound, or float", () => {
          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                audio: { codec: "aac", sampleRate: 48000, channels: 0 },
              },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                audio: { codec: "aac", sampleRate: 48000, channels: -1 },
              },
            }),
          ).toThrow(TypeError);

          expect(() =>
            validateImportMediaResult({
              ...base,
              probe: {
                ...base.probe,
                audio: { codec: "aac", sampleRate: 48000, channels: U32_MAX + 1 },
              },
            }),
          ).toThrow(TypeError);
        });

        it("isAudioProbe validates standalone audio object", () => {
          expect(isAudioProbe(null)).toBe(false);
          expect(isAudioProbe(undefined)).toBe(false);
          expect(isAudioProbe("not-an-object")).toBe(false);
          expect(isAudioProbe({ codec: null, sampleRate: null, channels: null })).toBe(
            true,
          );
          expect(isAudioProbe({ codec: "opus", sampleRate: 48000, channels: 2 })).toBe(
            true,
          );
          expect(isAudioProbe({ codec: 123, sampleRate: 48000, channels: 2 })).toBe(
            false,
          );
        });

        it("isMediaProbe validates standalone media probe object", () => {
          expect(isMediaProbe(null)).toBe(false);
          expect(isMediaProbe(createValidProbe())).toBe(true);
          expect(isMediaProbe({ ...createValidProbe(), isVfr: "false" })).toBe(false);
        });
      });
    });
  });
});
