import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BACKEND_EXPORT_ERROR_CODES,
  EXPORT_ERROR_CODES,
  EXPORT_STATUSES,
  ExportError,
  FRONTEND_EXPORT_ERROR_CODES,
  type ExportActions,
  type ExportProgressEvent,
  type ExportPublishingEvent,
  type ExportState,
  type ExportStoreState,
} from "./types";

declare global {
  interface ObjectConstructor {
    hasOwn(o: object, v: PropertyKey): boolean;
  }
}

// Vitest does not typecheck, so a runtime assertion over a literal the test wrote
// proves nothing about the type. These exported compile-time assertions pin reportError
// and store action contracts against regression during `pnpm typecheck`.
export type Assert<T extends true> = T;
export type _ReportErrorIsPinned = Assert<
  "reportError" extends keyof ExportActions ? true : false
>;
export type _ReportErrorSignature = Assert<
  ExportActions["reportError"] extends (error: unknown) => void ? true : false
>;
export type _StoreIncludesState = Assert<
  ExportStoreState extends ExportState ? true : false
>;
export type _StoreIncludesActions = Assert<
  ExportStoreState extends ExportActions ? true : false
>;
export type _StoreReportErrorIsPinned = Assert<
  "reportError" extends keyof ExportStoreState ? true : false
>;

/**
 * Reads the wire strings of every `ExportErrorCode` out of the Rust source.
 *
 * `BACKEND_EXPORT_ERROR_CODES` and the Rust enum are two independent hand-written lists that
 * must name the same set, and until this test existed nothing compared them: a code added on
 * one side reached the user as the generic "unknown" message, which is the opposite of why a
 * stable code crosses the boundary at all (ADR 011).
 *
 * The `export_error_codes!` invocation is the one place that pairs a variant with its wire
 * string, and the Rust side already proves through serde that those strings are what the
 * backend actually emits (`every_error_code_serializes_to_its_stable_camel_case_string`).
 * Reading it here therefore needs no second table on either side. The invocation is matched
 * rather than the whole file so the macro's own definition, which carries the same `=>`
 * shape, cannot contribute a match.
 */
function readRustExportErrorCodes(): string[] {
  const source = readFileSync(
    fileURLToPath(
      new URL("../../../src-tauri/src/ffmpeg/export/mod.rs", import.meta.url),
    ),
    "utf8",
  );

  const invocation = /\nexport_error_codes! \{\n([\s\S]*?)\n\}\n/.exec(source);
  expect(invocation).not.toBeNull();

  const wireStrings = invocation![1].matchAll(/=>\s*"([A-Za-z]+)",/g);
  return Array.from(wireStrings, (match) => match[1]);
}

describe("Export Types & Wire Constants", () => {
  describe("Rust vocabulary parity", () => {
    it("names exactly the codes the Rust export vocabulary emits", () => {
      const rustCodes = readRustExportErrorCodes();

      // Guards the parse itself: a moved or renamed Rust file would otherwise read as an
      // empty vocabulary and pass every comparison below.
      expect(rustCodes.length).toBeGreaterThan(20);
      expect(new Set(rustCodes).size).toBe(rustCodes.length);

      expect([...BACKEND_EXPORT_ERROR_CODES].sort()).toEqual([...rustCodes].sort());
    });
  });

  describe("Export Statuses", () => {
    it("contains exactly the expected lifecycle statuses", () => {
      expect(EXPORT_STATUSES).toEqual([
        "idle",
        "preparing",
        "running",
        "publishing",
        "finished",
        "canceled",
        "failed",
      ]);
    });
  });

  describe("Export Error Codes", () => {
    it("matches the expected backend error code literals in order", () => {
      expect(BACKEND_EXPORT_ERROR_CODES).toEqual([
        "appDataUnavailable",
        "settingsUnreadable",
        "presetNotFound",
        "ffmpegPairMissing",
        "ffprobeSpawnFailed",
        "ffprobeProcessFailed",
        "ffprobeParseFailed",
        "ffprobeTimedOut",
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
        "sourceAudioRateUnknown",
        "encoderUnavailable",
        "ffmpegSpawnFailed",
        "ffmpegProcessFailed",
        "frameCountMismatch",
        "outputRenameFailed",
        "canceled",
        "commandExecutionFailed",
        "exportAlreadyRunning",
      ]);
    });

    it("contains the frontend dialog error code", () => {
      expect(FRONTEND_EXPORT_ERROR_CODES).toEqual(["dialogFailed"]);
    });

    // The literal above pins the content, so a count here would only restate it with a number
    // that goes stale the moment the backend gains a code. What is asserted instead is the
    // composition, the terminating fallback, and the absence of duplicates.
    it("concatenates the backend and frontend codes, ends with 'unknown', and has no duplicates", () => {
      expect(EXPORT_ERROR_CODES).toEqual([
        ...BACKEND_EXPORT_ERROR_CODES,
        ...FRONTEND_EXPORT_ERROR_CODES,
        "unknown",
      ]);
      expect(EXPORT_ERROR_CODES[EXPORT_ERROR_CODES.length - 1]).toBe("unknown");
      expect(new Set(EXPORT_ERROR_CODES).size).toBe(EXPORT_ERROR_CODES.length);
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

  describe("ExportProgressEvent", () => {
    it("supports ExportPublishingEvent standalone type", () => {
      const publishing: ExportPublishingEvent = {
        event: "publishing",
        runId: "run-1",
      };
      expect(publishing.event).toBe("publishing");
      expect(publishing.runId).toBe("run-1");
    });

    it("enumerates exactly the 5 valid event tag strings", () => {
      // Vitest does not typecheck, so a runtime assertion over a literal the test wrote
      // proves nothing about the type. A Record typed over the union tags pins the set
      // at compile time: adding a variant fails on a missing key, removing one fails on
      // an excess key.
      const ALL_EVENT_TAGS: Record<ExportProgressEvent["event"], true> = {
        started: true,
        progress: true,
        publishing: true,
        finished: true,
        failed: true,
      };
      expect(Object.keys(ALL_EVENT_TAGS)).toEqual([
        "started",
        "progress",
        "publishing",
        "finished",
        "failed",
      ]);
      expect(Object.keys(ALL_EVENT_TAGS).length).toBe(5);
    });
  });

  describe("ExportActions & ExportStoreState", () => {
    it("pins the shape of ExportActions including reportError at compile time", () => {
      // Vitest does not typecheck, so a runtime assertion over a literal the test wrote
      // proves nothing about the type. Compile-time assertions pin reportError on ExportActions
      // and ensure its parameter accepts unknown rather than pushing normalization to callers.
      const actions: ExportActions = {
        startExport: () => Promise.resolve(null),
        cancelExport: () => Promise.resolve(true),
        reset: () => {},
        ensureSubscribed: () => Promise.resolve(),
        unsubscribe: () => {},
        reportError: (_error: unknown) => {},
      };

      expect(typeof actions.startExport).toBe("function");
      expect(typeof actions.cancelExport).toBe("function");
      expect(typeof actions.reset).toBe("function");
      expect(typeof actions.ensureSubscribed).toBe("function");
      expect(typeof actions.unsubscribe).toBe("function");
      expect(typeof actions.reportError).toBe("function");
    });

    it("pins the shape of ExportStoreState combining state and actions at compile time", () => {
      // Vitest does not typecheck, so a runtime assertion over a literal the test wrote
      // proves nothing about the type. Compile-time assertions ensure ExportStoreState
      // preserves both state fields and action methods, including reportError.
      const storeState: ExportStoreState = {
        status: "idle",
        runId: null,
        outputPath: null,
        segmentCount: 0,
        frame: null,
        expectedFrames: null,
        error: null,
        startExport: () => Promise.resolve(null),
        cancelExport: () => Promise.resolve(true),
        reset: () => {},
        ensureSubscribed: () => Promise.resolve(),
        unsubscribe: () => {},
        reportError: (_error: unknown) => {},
      };

      expect(storeState.status).toBe("idle");
      expect(storeState.runId).toBeNull();
      expect(storeState.outputPath).toBeNull();
      expect(storeState.segmentCount).toBe(0);
      expect(storeState.frame).toBeNull();
      expect(storeState.expectedFrames).toBeNull();
      expect(storeState.error).toBeNull();
      expect(typeof storeState.reportError).toBe("function");
    });
  });
});
