import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BACKEND_COMMANDS } from "@/lib/ipc";
import {
  BACKEND_EXPORT_OUTPUT_ERROR_CODES,
  ExportOutputError,
  normalizeExportOutputError,
  performExportOutputAction,
} from "./output";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

/**
 * Reads the wire strings of `ExportOutputErrorCode` out of the Rust source.
 *
 * Each variant carries an explicit `#[serde(rename = "...")]`, and the module has no other
 * serde rename, so every match is one code. A code that one side adds and the other lacks
 * would reach the user as the generic "unknown" message (ADR 011).
 */
function readRustOutputErrorCodes(): string[] {
  const source = readFileSync(
    fileURLToPath(
      new URL("../../../src-tauri/src/commands/export_output.rs", import.meta.url),
    ),
    "utf8",
  );
  const enumBody = /pub enum ExportOutputErrorCode \{([\s\S]*?)\n\}/.exec(source);
  expect(enumBody).not.toBeNull();
  return Array.from(
    enumBody![1].matchAll(/#\[serde\(rename = "([A-Za-z]+)"\)\]/g),
    (match) => match[1],
  );
}

describe("export output actions", () => {
  describe("Rust vocabulary parity", () => {
    it("names exactly the codes the Rust commands emit", () => {
      const rustCodes = readRustOutputErrorCodes();

      // Guards the parse itself: a moved file or a renamed enum would read as empty.
      expect(rustCodes.length).toBeGreaterThanOrEqual(5);
      expect([...BACKEND_EXPORT_OUTPUT_ERROR_CODES].sort()).toEqual(
        [...rustCodes].sort(),
      );
    });
  });

  describe("normalizeExportOutputError", () => {
    it("keeps a known code and its detail", () => {
      const error = normalizeExportOutputError({
        code: "openFailed",
        detail: "no application",
      });

      expect(error).toBeInstanceOf(ExportOutputError);
      expect(error.code).toBe("openFailed");
      expect(error.detail).toBe("no application");
    });

    it("keeps a known code with no detail", () => {
      const error = normalizeExportOutputError({ code: "outputMissing" });

      expect(error.code).toBe("outputMissing");
      expect(error.detail).toBeUndefined();
    });

    it("maps an unknown code to unknown and keeps the detail", () => {
      const error = normalizeExportOutputError({ code: "somethingElse", detail: "x" });

      expect(error.code).toBe("unknown");
      expect(error.detail).toBe("x");
    });

    it("maps a plain string, such as a refused command, to unknown with the text", () => {
      const error = normalizeExportOutputError("Command not allowed");

      expect(error.code).toBe("unknown");
      expect(error.detail).toBe("Command not allowed");
    });

    it("maps anything else to a bare unknown", () => {
      expect(normalizeExportOutputError(undefined).code).toBe("unknown");
      expect(normalizeExportOutputError(42).detail).toBeUndefined();
    });

    it("returns an ExportOutputError unchanged", () => {
      const original = new ExportOutputError("revealFailed", "busy");

      expect(normalizeExportOutputError(original)).toBe(original);
    });
  });

  describe("performExportOutputAction", () => {
    it("sends a reveal request with the run id and no path", async () => {
      const invoke = vi.fn().mockResolvedValue(null);

      await performExportOutputAction("reveal", "1-0", { invoke });

      expect(invoke).toHaveBeenCalledWith(BACKEND_COMMANDS.REVEAL_EXPORT_OUTPUT, {
        runId: "1-0",
      });
      expect(BACKEND_COMMANDS.REVEAL_EXPORT_OUTPUT).toBe("reveal_export_output");
    });

    it("sends an open request with the run id and no path", async () => {
      const invoke = vi.fn().mockResolvedValue(null);

      await performExportOutputAction("open", "1-0", { invoke });

      expect(invoke).toHaveBeenCalledWith(BACKEND_COMMANDS.OPEN_EXPORT_OUTPUT, {
        runId: "1-0",
      });
      expect(BACKEND_COMMANDS.OPEN_EXPORT_OUTPUT).toBe("open_export_output");
    });

    it("rejects with a normalized error", async () => {
      const invoke = vi.fn().mockRejectedValue({ code: "outputUnknown" });

      await expect(
        performExportOutputAction("open", "1-0", { invoke }),
      ).rejects.toEqual(new ExportOutputError("outputUnknown"));
    });
  });
});
