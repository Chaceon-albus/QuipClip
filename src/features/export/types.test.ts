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

describe("Export Types & Wire Constants", () => {
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
      expect(EXPORT_STATUSES.length).toBe(7);
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
