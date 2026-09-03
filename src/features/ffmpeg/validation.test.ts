import { describe, expect, it } from "vitest";
import {
  BACKEND_CAPABILITY_PROBE_ERROR_CODES,
  CAPABILITY_PROBE_ERROR_CODES,
  CapabilityProbeError,
  CODEC_KINDS,
  ENCODER_STATUSES,
  EXECUTABLE_ORIGINS,
  type BackendCapabilityProbeErrorCode,
  type CapabilityProbeEvent,
  type CapabilityProbeStart,
  type CapabilityReport,
  type EncoderResult,
  type InspectedCandidate,
  type LicenseFlags,
} from "./types";
import {
  I32_MAX,
  I32_MIN,
  isBackendCapabilityProbeErrorCode,
  isCapabilityProbeErrorCode,
  isCapabilityProbeEvent,
  isCapabilityProbeStart,
  isCapabilityReport,
  isCodecKind,
  isEncoderResult,
  isEncoderStatus,
  isI32,
  isInspectedCandidate,
  isInspectedCandidateArray,
  isLicenseFlags,
  isNonNegativeU32,
  isOrigin,
  isPositiveU32,
  normalizeCapabilityProbeError,
  U32_MAX,
  validateCapabilityProbeEvent,
  validateCapabilityProbeStart,
} from "./validation";

function createValidLicense(): LicenseFlags {
  return {
    gpl: true,
    nonfree: false,
    version3: true,
  };
}

function createValidEncoderResult(
  overrides: Partial<EncoderResult> = {},
): EncoderResult {
  return {
    name: "libx264",
    kind: "video",
    listed: true,
    status: "works",
    ...overrides,
  };
}

function createValidReport(
  overrides: Partial<CapabilityReport> = {},
): CapabilityReport {
  return {
    version: "7.1.0",
    license: createValidLicense(),
    hwaccels: ["videotoolbox"],
    encoders: [createValidEncoderResult()],
    probedAt: 1724976000,
    ...overrides,
  };
}

function createValidCandidate(
  overrides: Partial<InspectedCandidate> = {},
): InspectedCandidate {
  return {
    ffmpeg: "/opt/homebrew/bin/ffmpeg",
    ffprobe: "/opt/homebrew/bin/ffprobe",
    origin: "path",
    ...overrides,
  };
}

describe("FFmpeg Capability Validation & Normalization", () => {
  describe("Type Guards", () => {
    it("validates Origin values", () => {
      for (const origin of EXECUTABLE_ORIGINS) {
        expect(isOrigin(origin)).toBe(true);
      }
      expect(isOrigin("invalid")).toBe(false);
      expect(isOrigin(null)).toBe(false);
      expect(isOrigin(123)).toBe(false);
    });

    it("validates CodecKind values", () => {
      for (const kind of CODEC_KINDS) {
        expect(isCodecKind(kind)).toBe(true);
      }
      expect(isCodecKind("attachment")).toBe(false);
      expect(isCodecKind(null)).toBe(false);
    });

    it("validates EncoderStatus values", () => {
      for (const status of ENCODER_STATUSES) {
        expect(isEncoderStatus(status)).toBe(true);
      }
      expect(isEncoderStatus("unknownStatus")).toBe(false);
      expect(isEncoderStatus(null)).toBe(false);
    });

    it("validates BackendCapabilityProbeErrorCode", () => {
      for (const code of BACKEND_CAPABILITY_PROBE_ERROR_CODES) {
        expect(isBackendCapabilityProbeErrorCode(code)).toBe(true);
        expect(isCapabilityProbeErrorCode(code)).toBe(true);
      }
      expect(isBackendCapabilityProbeErrorCode("unknown")).toBe(false);
      expect(isCapabilityProbeErrorCode("unknown")).toBe(true);
      expect(isBackendCapabilityProbeErrorCode("invalidCode")).toBe(false);
    });

    it("validates CAPABILITY_PROBE_ERROR_CODES includes all codes", () => {
      for (const code of CAPABILITY_PROBE_ERROR_CODES) {
        expect(isCapabilityProbeErrorCode(code)).toBe(true);
      }
    });

    it("validates integer boundaries (isPositiveU32, isNonNegativeU32, isI32)", () => {
      expect(isPositiveU32(1)).toBe(true);
      expect(isPositiveU32(U32_MAX)).toBe(true);
      expect(isPositiveU32(0)).toBe(false);
      expect(isPositiveU32(-1)).toBe(false);
      expect(isPositiveU32(U32_MAX + 1)).toBe(false);
      expect(isPositiveU32(1.5)).toBe(false);

      expect(isNonNegativeU32(0)).toBe(true);
      expect(isNonNegativeU32(100)).toBe(true);
      expect(isNonNegativeU32(U32_MAX)).toBe(true);
      expect(isNonNegativeU32(-1)).toBe(false);

      expect(isI32(I32_MIN)).toBe(true);
      expect(isI32(0)).toBe(true);
      expect(isI32(I32_MAX)).toBe(true);
      expect(isI32(I32_MIN - 1)).toBe(false);
      expect(isI32(I32_MAX + 1)).toBe(false);
      expect(isI32(NaN)).toBe(false);
      expect(isI32("0")).toBe(false);
    });

    it("validates LicenseFlags", () => {
      expect(isLicenseFlags(createValidLicense())).toBe(true);
      expect(isLicenseFlags({ gpl: true, nonfree: false })).toBe(false);
      expect(isLicenseFlags({ gpl: "true", nonfree: false, version3: true })).toBe(
        false,
      );
      expect(isLicenseFlags(null)).toBe(false);
    });

    it("validates InspectedCandidate and InspectedCandidateArray", () => {
      const candidate = createValidCandidate();
      expect(isInspectedCandidate(candidate)).toBe(true);
      expect(isInspectedCandidateArray([candidate])).toBe(true);
      expect(isInspectedCandidateArray([])).toBe(true);

      expect(isInspectedCandidate({ ...candidate, origin: "invalid" })).toBe(false);
      expect(isInspectedCandidate({ ffmpeg: 123, ffprobe: "p", origin: "path" })).toBe(
        false,
      );
      expect(isInspectedCandidateArray([candidate, { ffmpeg: "bad" }])).toBe(false);
      expect(isInspectedCandidateArray(null)).toBe(false);
    });

    it("validates EncoderResult with optional exitCode and detail", () => {
      const valid = createValidEncoderResult();
      expect(isEncoderResult(valid)).toBe(true);

      const withOptional = createValidEncoderResult({
        exitCode: 1,
        detail: "error detail",
      });
      expect(isEncoderResult(withOptional)).toBe(true);

      expect(
        isEncoderResult({
          ...valid,
          exitCode: 1.5,
        }),
      ).toBe(false);

      expect(
        isEncoderResult({
          ...valid,
          detail: 123 as unknown as string,
        }),
      ).toBe(false);

      expect(
        isEncoderResult({
          ...valid,
          status: "invalidStatus" as unknown as EncoderResult["status"],
        }),
      ).toBe(false);
    });

    it("validates CapabilityReport", () => {
      const valid = createValidReport();
      expect(isCapabilityReport(valid)).toBe(true);

      expect(
        isCapabilityReport({
          ...valid,
          probedAt: 123.45,
        }),
      ).toBe(false);

      expect(
        isCapabilityReport({
          ...valid,
          hwaccels: [123 as unknown as string],
        }),
      ).toBe(false);

      expect(
        isCapabilityReport({
          ...valid,
          encoders: [{ bad: "encoder" }],
        }),
      ).toBe(false);
    });

    it("rejects CapabilityReport with milliseconds-scale probedAt or out-of-range timestamps", () => {
      const valid = createValidReport();
      // Milliseconds timestamp (e.g. 13-digit Date.now()) exceeds U32_MAX and must be rejected
      expect(
        isCapabilityReport({
          ...valid,
          probedAt: 1724976000000,
        }),
      ).toBe(false);

      expect(
        isCapabilityReport({
          ...valid,
          probedAt: 4_294_967_296,
        }),
      ).toBe(false);

      expect(
        isCapabilityReport({
          ...valid,
          probedAt: 0,
        }),
      ).toBe(false);

      expect(
        isCapabilityReport({
          ...valid,
          probedAt: -1,
        }),
      ).toBe(false);
    });

    it("validates isCapabilityProbeStart type guard", () => {
      const validStart: CapabilityProbeStart = {
        runId: "run-1",
        ffmpeg: "/usr/bin/ffmpeg",
        ffprobe: "/usr/bin/ffprobe",
        origin: "path",
      };
      expect(isCapabilityProbeStart(validStart)).toBe(true);
      expect(isCapabilityProbeStart(null)).toBe(false);
      expect(isCapabilityProbeStart({ ...validStart, origin: "bad" })).toBe(false);
    });

    it("validates isCapabilityProbeEvent type guard", () => {
      const validLocated: CapabilityProbeEvent = {
        event: "located",
        runId: "run-1",
        ffmpeg: "/usr/bin/ffmpeg",
        ffprobe: "/usr/bin/ffprobe",
        origin: "path",
        version: "7.1",
        license: createValidLicense(),
      };
      expect(isCapabilityProbeEvent(validLocated)).toBe(true);
      expect(isCapabilityProbeEvent(null)).toBe(false);
      expect(isCapabilityProbeEvent({ event: "unknown", runId: "1" })).toBe(false);
    });
  });

  describe("validateCapabilityProbeStart", () => {
    it("accepts a valid CapabilityProbeStart payload", () => {
      const start: CapabilityProbeStart = {
        runId: "run-123",
        ffmpeg: "/usr/bin/ffmpeg",
        ffprobe: "/usr/bin/ffprobe",
        origin: "configured",
      };

      expect(validateCapabilityProbeStart(start)).toEqual(start);
    });

    it("throws TypeError for invalid start payloads", () => {
      expect(() => validateCapabilityProbeStart(null)).toThrow(TypeError);
      expect(() => validateCapabilityProbeStart({})).toThrow(TypeError);
      expect(() =>
        validateCapabilityProbeStart({
          runId: "123",
          ffmpeg: "/usr/bin/ffmpeg",
          // missing ffprobe
          origin: "path",
        }),
      ).toThrow(TypeError);
    });
  });

  describe("validateCapabilityProbeEvent", () => {
    it("accepts valid 'located' event", () => {
      const event: CapabilityProbeEvent = {
        event: "located",
        runId: "run-1",
        ffmpeg: "/usr/bin/ffmpeg",
        ffprobe: "/usr/bin/ffprobe",
        origin: "path",
        version: "7.1",
        license: createValidLicense(),
      };
      expect(validateCapabilityProbeEvent(event)).toEqual(event);
    });

    it("accepts valid 'result' event", () => {
      const event: CapabilityProbeEvent = {
        event: "result",
        runId: "run-1",
        result: createValidEncoderResult(),
        done: 1,
        total: 12,
      };
      expect(validateCapabilityProbeEvent(event)).toEqual(event);
    });

    it("accepts valid 'finished' event for probe and cache", () => {
      const probeFinished: CapabilityProbeEvent = {
        event: "finished",
        runId: "run-1",
        report: createValidReport(),
        source: "probe",
      };
      expect(validateCapabilityProbeEvent(probeFinished)).toEqual(probeFinished);

      const cacheFinished: CapabilityProbeEvent = {
        event: "finished",
        runId: "run-1",
        report: createValidReport(),
        source: "cache",
      };
      expect(validateCapabilityProbeEvent(cacheFinished)).toEqual(cacheFinished);
    });

    it("accepts valid 'failed' event with and without optional fields", () => {
      const minimalFailed: CapabilityProbeEvent = {
        event: "failed",
        runId: "run-1",
        code: "ffmpegPairMissing",
      };
      expect(validateCapabilityProbeEvent(minimalFailed)).toEqual(minimalFailed);

      const fullFailed: CapabilityProbeEvent = {
        event: "failed",
        runId: "run-1",
        code: "commandExecutionFailed",
        detail: "spawn error",
        exitCode: 1,
        inspected: [createValidCandidate()],
      };
      expect(validateCapabilityProbeEvent(fullFailed)).toEqual(fullFailed);
    });

    it("rejects 'result' event when done or total is not a positive integer", () => {
      expect(() =>
        validateCapabilityProbeEvent({
          event: "result",
          runId: "run-1",
          result: createValidEncoderResult(),
          done: 0,
          total: 12,
        }),
      ).toThrow(TypeError);

      expect(() =>
        validateCapabilityProbeEvent({
          event: "result",
          runId: "run-1",
          result: createValidEncoderResult(),
          done: 1,
          total: 0,
        }),
      ).toThrow(TypeError);
    });

    it("rejects 'failed' event with frontend-only 'unknown' error code", () => {
      expect(() =>
        validateCapabilityProbeEvent({
          event: "failed",
          runId: "run-1",
          code: "unknown",
        }),
      ).toThrow(TypeError);
    });

    it("throws TypeError for unknown or malformed events", () => {
      expect(() => validateCapabilityProbeEvent(null)).toThrow(TypeError);
      expect(() => validateCapabilityProbeEvent({})).toThrow(TypeError);
      expect(() =>
        validateCapabilityProbeEvent({ event: "unknownEvent", runId: "1" }),
      ).toThrow(TypeError);
      expect(() =>
        validateCapabilityProbeEvent({
          event: "located",
          runId: "1",
          // missing ffmpeg, ffprobe, etc.
        }),
      ).toThrow(TypeError);
    });
  });

  describe("normalizeCapabilityProbeError", () => {
    it("returns the exact same instance if already a CapabilityProbeError", () => {
      const existing = new CapabilityProbeError({
        code: "ffmpegPairMissing",
        detail: "Missing pair",
      });
      expect(normalizeCapabilityProbeError(existing)).toBe(existing);
    });

    describe.each(BACKEND_CAPABILITY_PROBE_ERROR_CODES)(
      "normalizes backend error code: %s",
      (code: BackendCapabilityProbeErrorCode) => {
        it(`preserves backend code ${code} with detail and exitCode`, () => {
          const inspected = [createValidCandidate()];
          const raw = {
            code,
            detail: `Diagnostic info for ${code}`,
            exitCode: 1,
            inspected,
          };

          const normalized = normalizeCapabilityProbeError(raw);

          expect(normalized).toBeInstanceOf(CapabilityProbeError);
          expect(normalized.code).toBe(code);
          expect(normalized.detail).toBe(`Diagnostic info for ${code}`);
          expect(normalized.exitCode).toBe(1);
          expect(normalized.inspected).toEqual(inspected);
        });
      },
    );

    it("normalizes unrecognized code to 'unknown'", () => {
      const normalized = normalizeCapabilityProbeError({
        code: "unexpectedCode",
        detail: "Internal crash",
      });
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBe("Internal crash");
    });

    it("preserves exitCode ONLY when within Rust i32 bounds", () => {
      expect(
        normalizeCapabilityProbeError({
          code: "ffmpegProcessFailed",
          exitCode: 0,
        }).exitCode,
      ).toBe(0);

      expect(
        normalizeCapabilityProbeError({
          code: "ffmpegProcessFailed",
          exitCode: I32_MAX,
        }).exitCode,
      ).toBe(2_147_483_647);

      expect(
        normalizeCapabilityProbeError({
          code: "ffmpegProcessFailed",
          exitCode: I32_MAX + 1,
        }).exitCode,
      ).toBeUndefined();
    });

    it("preserves inspected candidates ONLY when matching schema", () => {
      const validCandidate = createValidCandidate();
      expect(
        normalizeCapabilityProbeError({
          code: "ffmpegPairMissing",
          inspected: [validCandidate],
        }).inspected,
      ).toEqual([validCandidate]);

      expect(
        normalizeCapabilityProbeError({
          code: "ffmpegPairMissing",
          inspected: "invalid",
        }).inspected,
      ).toBeUndefined();
    });

    it("normalizes Error instances to code 'unknown' with detail undefined to prevent leaking local English messages", () => {
      const err = new Error("IPC network failed");
      const normalized = normalizeCapabilityProbeError(err);
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBeUndefined();
    });

    it("normalizes plain string errors to code 'unknown' with string as detail", () => {
      const normalized = normalizeCapabilityProbeError("Connection reset");
      expect(normalized.code).toBe("unknown");
      expect(normalized.detail).toBe("Connection reset");
    });

    it("normalizes undefined and null to code 'unknown'", () => {
      expect(normalizeCapabilityProbeError(undefined).code).toBe("unknown");
      expect(normalizeCapabilityProbeError(null).code).toBe("unknown");
    });
  });
});
