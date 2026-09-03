import { describe, expect, it } from "vitest";
import {
  BACKEND_CAPABILITY_PROBE_ERROR_CODES,
  CAPABILITY_PROBE_ERROR_CODES,
  CapabilityProbeError,
  CODEC_KINDS,
  ENCODER_STATUSES,
  EXECUTABLE_ORIGINS,
  type InspectedCandidate,
} from "./types";

describe("FFmpeg Capability Probe Types", () => {
  describe("Constants & Enums", () => {
    it("contains exactly the expected executable origins", () => {
      expect(EXECUTABLE_ORIGINS).toEqual(["configured", "path", "appData"]);
    });

    it("contains exactly the expected codec kinds", () => {
      expect(CODEC_KINDS).toEqual(["video", "audio", "subtitle"]);
    });

    it("contains exactly the expected encoder statuses", () => {
      expect(ENCODER_STATUSES).toEqual(["works", "notListed", "failed", "timedOut"]);
    });

    it("contains all 8 backend capability probe error codes", () => {
      expect(BACKEND_CAPABILITY_PROBE_ERROR_CODES).toEqual([
        "appDataUnavailable",
        "ffmpegPairMissing",
        "ffmpegSpawnFailed",
        "ffmpegProcessFailed",
        "versionParseFailed",
        "encoderListParseFailed",
        "cacheUnavailable",
        "commandExecutionFailed",
      ]);
    });

    it("contains all backend codes plus the frontend-only fallback code 'unknown'", () => {
      expect(CAPABILITY_PROBE_ERROR_CODES).toEqual([
        ...BACKEND_CAPABILITY_PROBE_ERROR_CODES,
        "unknown",
      ]);
    });
  });

  describe("CapabilityProbeError", () => {
    it("instantiates correctly with minimal options", () => {
      const error = new CapabilityProbeError({ code: "ffmpegPairMissing" });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CapabilityProbeError);
      expect(error.name).toBe("CapabilityProbeError");
      expect(error.code).toBe("ffmpegPairMissing");
      expect(error.message).toBe("ffmpegPairMissing");
      expect(error.detail).toBeUndefined();
      expect(error.exitCode).toBeUndefined();
      expect(error.inspected).toBeUndefined();
    });

    it("instantiates correctly with detail, exitCode, and inspected candidates", () => {
      const inspected: InspectedCandidate[] = [
        {
          ffmpeg: "/usr/bin/ffmpeg",
          ffprobe: "/usr/bin/ffprobe",
          origin: "path",
        },
      ];

      const error = new CapabilityProbeError({
        code: "ffmpegProcessFailed",
        detail: "Process crashed with signal 9",
        exitCode: 137,
        inspected,
      });

      expect(error.name).toBe("CapabilityProbeError");
      expect(error.code).toBe("ffmpegProcessFailed");
      expect(error.detail).toBe("Process crashed with signal 9");
      expect(error.exitCode).toBe(137);
      expect(error.inspected).toEqual(inspected);
      expect(error.message).toBe("ffmpegProcessFailed: Process crashed with signal 9");
    });
  });
});
