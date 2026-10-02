import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUDIO_CHANNEL_SETTINGS,
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

/** The settings module of the Rust backend, the one source of the wire vocabulary. */
function readRustSettingsSource(): string {
  return readFileSync(
    fileURLToPath(new URL("../../../src-tauri/src/settings/mod.rs", import.meta.url)),
    "utf8",
  );
}

/**
 * Reads the wire strings of every `QualityKind` variant out of the Rust source, in their
 * order. The enum carries `#[serde(rename_all = "camelCase")]`, so the wire string of a variant
 * is its name with the first letter lowered. The attribute is asserted rather than assumed.
 */
function readRustQualityKinds(): string[] {
  const declaration =
    /#\[serde\(rename_all = "camelCase"\)\]\npub enum QualityKind \{\n([\s\S]*?)\n\}\n/.exec(
      readRustSettingsSource(),
    );
  expect(declaration).not.toBeNull();
  const variants = declaration![1].matchAll(/^ {4}([A-Z][A-Za-z0-9]*),$/gm);
  return Array.from(variants, (match) => match[1][0].toLowerCase() + match[1].slice(1));
}

describe("Settings Types & Wire Constants", () => {
  describe("Schema Version", () => {
    it("pins the schema version to 2, the version Rust writes", () => {
      expect(SETTINGS_SCHEMA_VERSION).toBe(2);
      expect(readRustSettingsSource()).toContain(
        "pub const CURRENT_SCHEMA_VERSION: u32 = 2;",
      );
    });
  });

  describe("Preset Containers", () => {
    it("contains exactly the literal wire strings for containers matching Rust", () => {
      expect(PRESET_CONTAINERS).toEqual(["mp4", "mov", "mkv"]);
      expect(PRESET_CONTAINERS).toContain("mp4");
      expect(PRESET_CONTAINERS).toContain("mov");
      expect(PRESET_CONTAINERS).toContain("mkv");
    });
  });

  describe("Quality Kinds", () => {
    it("contains exactly the literal wire strings for quality kinds matching Rust", () => {
      expect(QUALITY_KINDS).toEqual(["crf", "cq", "bitrate", "qualityScale"]);
      expect(QUALITY_KINDS).toContain("crf");
      expect(QUALITY_KINDS).toContain("cq");
      expect(QUALITY_KINDS).toContain("bitrate");
      expect(QUALITY_KINDS).toContain("qualityScale");
    });

    it("names exactly the variants of the Rust QualityKind enum, in its order", () => {
      expect([...QUALITY_KINDS]).toEqual(readRustQualityKinds());
    });
  });

  describe("Audio Channel Settings", () => {
    it("contains exactly the literal wire strings for audio channels matching Rust", () => {
      expect(AUDIO_CHANNEL_SETTINGS).toEqual(["source", "stereo", "mono"]);
      expect(AUDIO_CHANNEL_SETTINGS).toContain("source");
      expect(AUDIO_CHANNEL_SETTINGS).toContain("stereo");
      expect(AUDIO_CHANNEL_SETTINGS).toContain("mono");
    });
  });

  describe("Error Codes", () => {
    it("contains the backend error codes verbatim from the Rust source", () => {
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
        "settingsConflict",
        "backupFailed",
        "invalidPath",
        "commandExecutionFailed",
      ]);
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
