import { describe, expect, it } from "vitest";
import {
  BACKEND_SETTINGS_ERROR_CODES,
  FRONTEND_SETTINGS_ERROR_CODES,
  PRESET_CONTAINERS,
  QUALITY_KINDS,
  SETTINGS_ERROR_CODES,
  SETTINGS_SCHEMA_VERSION,
  SettingsError,
} from "./types";

declare global {
  interface ObjectConstructor {
    hasOwn(o: object, v: PropertyKey): boolean;
  }
}

describe("Settings Types & Wire Constants", () => {
  describe("Schema Version", () => {
    it("pins the schema version to 1", () => {
      expect(SETTINGS_SCHEMA_VERSION).toBe(1);
    });
  });

  describe("Preset Containers", () => {
    it("contains exactly the literal wire strings for containers matching Rust", () => {
      expect(PRESET_CONTAINERS).toEqual(["mp4", "mov", "mkv"]);
      expect(PRESET_CONTAINERS).toContain("mp4");
      expect(PRESET_CONTAINERS).toContain("mov");
      expect(PRESET_CONTAINERS).toContain("mkv");
      expect(PRESET_CONTAINERS.length).toBe(3);
    });
  });

  describe("Quality Kinds", () => {
    it("contains exactly the literal wire strings for quality kinds matching Rust", () => {
      expect(QUALITY_KINDS).toEqual(["crf", "bitrate", "qualityScale"]);
      expect(QUALITY_KINDS).toContain("crf");
      expect(QUALITY_KINDS).toContain("bitrate");
      expect(QUALITY_KINDS).toContain("qualityScale");
      expect(QUALITY_KINDS.length).toBe(3);
    });
  });

  describe("Error Codes", () => {
    it("contains all twelve backend error codes verbatim from the Rust source", () => {
      expect(BACKEND_SETTINGS_ERROR_CODES).toEqual([
        "appDataUnavailable",
        "readFailed",
        "permissionDenied",
        "writeFailed",
        "invalidJson",
        "invalidSettings",
        "unsafeSettingsValue",
        "futureSchemaVersion",
        "settingsUnreadable",
        "backupFailed",
        "invalidPath",
        "commandExecutionFailed",
      ]);
      expect(BACKEND_SETTINGS_ERROR_CODES.length).toBe(12);
    });

    it("contains the frontend-only dialog code", () => {
      expect(FRONTEND_SETTINGS_ERROR_CODES).toEqual(["dialogFailed"]);
    });

    it("contains all backend codes, frontend dialog codes, and the unknown fallback", () => {
      expect(SETTINGS_ERROR_CODES).toEqual([
        ...BACKEND_SETTINGS_ERROR_CODES,
        ...FRONTEND_SETTINGS_ERROR_CODES,
        "unknown",
      ]);
      expect(SETTINGS_ERROR_CODES.length).toBe(14);
    });
  });

  describe("SettingsError", () => {
    it("instantiates correctly with minimal options without optional fields", () => {
      const error = new SettingsError({ code: "readFailed" });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(SettingsError);
      expect(error.name).toBe("SettingsError");
      expect(error.code).toBe("readFailed");
      expect(error.message).toBe("readFailed");
      expect(error.detail).toBeUndefined();
      expect(error.field).toBeUndefined();
      expect(error.value).toBeUndefined();
      expect(error.foundSchemaVersion).toBeUndefined();
      expect(error.supportedSchemaVersion).toBeUndefined();
      expect(Object.hasOwn(error, "detail")).toBe(false);
      expect(Object.hasOwn(error, "field")).toBe(false);
      expect(Object.hasOwn(error, "value")).toBe(false);
      expect(Object.hasOwn(error, "foundSchemaVersion")).toBe(false);
      expect(Object.hasOwn(error, "supportedSchemaVersion")).toBe(false);
    });

    it("omits optional keys when options are explicitly undefined", () => {
      const error = new SettingsError({
        code: "readFailed",
        detail: undefined,
        field: undefined,
        value: undefined,
        foundSchemaVersion: undefined,
        supportedSchemaVersion: undefined,
      });

      expect(Object.hasOwn(error, "detail")).toBe(false);
      expect(Object.hasOwn(error, "field")).toBe(false);
      expect(Object.hasOwn(error, "value")).toBe(false);
      expect(Object.hasOwn(error, "foundSchemaVersion")).toBe(false);
      expect(Object.hasOwn(error, "supportedSchemaVersion")).toBe(false);
    });

    it("instantiates correctly with detail formatting error message", () => {
      const error = new SettingsError({
        code: "writeFailed",
        detail: "Permission denied",
      });

      expect(error.name).toBe("SettingsError");
      expect(error.code).toBe("writeFailed");
      expect(error.detail).toBe("Permission denied");
      expect(error.message).toBe("writeFailed: Permission denied");
    });

    it("instantiates correctly with all fields provided", () => {
      const error = new SettingsError({
        code: "futureSchemaVersion",
        detail: "version mismatch",
        field: "schemaVersion",
        value: "2",
        foundSchemaVersion: 2,
        supportedSchemaVersion: 1,
      });

      expect(error.code).toBe("futureSchemaVersion");
      expect(error.detail).toBe("version mismatch");
      expect(error.field).toBe("schemaVersion");
      expect(error.value).toBe("2");
      expect(error.foundSchemaVersion).toBe(2);
      expect(error.supportedSchemaVersion).toBe(1);
      expect(error.message).toBe("futureSchemaVersion: version mismatch");
    });
  });
});
