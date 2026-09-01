import { describe, expect, it, vi } from "vitest";
import { createMediaStore, mediaStore } from "./store";
import { ImportMediaError, type ImportMediaResult } from "./types";
import type { Pts, TickCount } from "@/types/project";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeMediaResult(fileName: string): ImportMediaResult {
  return {
    path: `/media/${fileName}`,
    fileName,
    size: 1048576,
    mtime: 1724976000,
    probe: {
      formatNames: ["mov", "mp4"],
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
      avgFrameRate: { n: 30, d: 1 },
      rFrameRate: { n: 30, d: 1 },
      reportedFrameCount: "300" as TickCount,
      audio: null,
    },
  };
}

describe("Media Store", () => {
  describe("Initial State", () => {
    it("starts with idle status, null media, and null error", () => {
      const store = createMediaStore();
      const state = store.getState();

      expect(state.status).toBe("idle");
      expect(state.media).toBeNull();
      expect(state.error).toBeNull();
    });

    it("respects optional initial state parameters", () => {
      const initialMedia = createFakeMediaResult("initial.mp4");
      const store = createMediaStore(
        {},
        {
          status: "ready",
          media: initialMedia,
        },
      );
      const state = store.getState();

      expect(state.status).toBe("ready");
      expect(state.media).toEqual(initialMedia);
      expect(state.error).toBeNull();
    });
  });

  describe("Single Request Lifecycle", () => {
    it("transitions idle -> loading -> ready on successful import", async () => {
      const mediaResult = createFakeMediaResult("test.mp4");
      const importMediaMock = vi.fn().mockResolvedValue(mediaResult);
      const store = createMediaStore({ importMedia: importMediaMock });

      const importPromise = store.getState().importPath("/media/test.mp4");

      // Verify immediate transition to loading state
      expect(store.getState().status).toBe("loading");
      expect(store.getState().media).toBeNull();
      expect(store.getState().error).toBeNull();

      const result = await importPromise;

      expect(result).toEqual(mediaResult);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().media).toEqual(mediaResult);
      expect(store.getState().error).toBeNull();
      expect(importMediaMock).toHaveBeenCalledWith("/media/test.mp4");
    });

    it("transitions idle -> loading -> error on failed import", async () => {
      const importMediaMock = vi.fn().mockRejectedValue(
        new ImportMediaError({
          code: "pathNotFound",
          detail: "File does not exist",
        }),
      );
      const store = createMediaStore({ importMedia: importMediaMock });

      const importPromise = store.getState().importPath("/media/missing.mp4");

      expect(store.getState().status).toBe("loading");

      const result = await importPromise;

      expect(result).toBeNull();
      expect(store.getState().status).toBe("error");
      expect(store.getState().media).toBeNull();
      expect(store.getState().error?.code).toBe("pathNotFound");
      expect(store.getState().error?.detail).toBe("File does not exist");
    });

    it("recovers from error state on subsequent successful import", async () => {
      const mediaResult = createFakeMediaResult("good.mp4");
      let shouldFail = true;
      const importMediaMock = vi.fn().mockImplementation(() => {
        if (shouldFail) {
          return Promise.reject(new ImportMediaError({ code: "invalidPath" }));
        }
        return Promise.resolve(mediaResult);
      });
      const store = createMediaStore({ importMedia: importMediaMock });

      await store.getState().importPath("/media/bad.mp4");
      expect(store.getState().status).toBe("error");
      expect(store.getState().error?.code).toBe("invalidPath");

      shouldFail = false;
      await store.getState().importPath("/media/good.mp4");
      expect(store.getState().status).toBe("ready");
      expect(store.getState().media).toEqual(mediaResult);
      expect(store.getState().error).toBeNull();
    });
  });

  describe("Replacement Semantics & Preserving Current Media", () => {
    it("preserves currently loaded media while a replacement is loading", async () => {
      const initialMedia = createFakeMediaResult("initial.mp4");
      const deferred = createDeferred<ImportMediaResult>();
      const store = createMediaStore(
        { importMedia: () => deferred.promise },
        { status: "ready", media: initialMedia },
      );

      expect(store.getState().media).toEqual(initialMedia);

      void store.getState().importPath("/media/replacement.mp4");

      // While loading, previous media must remain intact
      expect(store.getState().status).toBe("loading");
      expect(store.getState().media).toEqual(initialMedia);
      expect(store.getState().error).toBeNull();

      const replacementMedia = createFakeMediaResult("replacement.mp4");
      deferred.resolve(replacementMedia);
      await Promise.resolve();

      expect(store.getState().status).toBe("ready");
      expect(store.getState().media).toEqual(replacementMedia);
    });

    it("preserves currently loaded media when a replacement fails", async () => {
      const initialMedia = createFakeMediaResult("initial.mp4");
      const importMediaMock = vi.fn().mockRejectedValue(
        new ImportMediaError({
          code: "ffprobeProcessFailed",
          detail: "Invalid stream format",
          exitCode: 1,
        }),
      );
      const store = createMediaStore(
        { importMedia: importMediaMock },
        { status: "ready", media: initialMedia },
      );

      const result = await store.getState().importPath("/media/corrupt.mp4");

      expect(result).toBeNull();
      // Status is error, but the editor is not blanked (media preserved)
      expect(store.getState().status).toBe("error");
      expect(store.getState().media).toEqual(initialMedia);
      expect(store.getState().error?.code).toBe("ffprobeProcessFailed");
      expect(store.getState().error?.detail).toBe("Invalid stream format");
      expect(store.getState().error?.exitCode).toBe(1);
    });
  });

  describe("Reset Action", () => {
    it("resets store state to idle, null media, and null error", () => {
      const store = createMediaStore(
        {},
        {
          status: "ready",
          media: createFakeMediaResult("test.mp4"),
          error: null,
        },
      );

      store.getState().reset();

      expect(store.getState().status).toBe("idle");
      expect(store.getState().media).toBeNull();
      expect(store.getState().error).toBeNull();
    });

    it("invalidates in-flight requests so late completions do not overwrite reset state", async () => {
      const deferred = createDeferred<ImportMediaResult>();
      const store = createMediaStore({
        importMedia: () => deferred.promise,
      });

      const importPromise = store.getState().importPath("/media/test.mp4");
      expect(store.getState().status).toBe("loading");

      store.getState().reset();
      expect(store.getState().status).toBe("idle");
      expect(store.getState().media).toBeNull();

      deferred.resolve(createFakeMediaResult("test.mp4"));
      const result = await importPromise;

      expect(result).toBeNull();
      expect(store.getState().status).toBe("idle");
      expect(store.getState().media).toBeNull();
    });
  });

  describe("Concurrent Requests (Latest-Selection-Wins)", () => {
    it("ignores stale success when a newer request completes first", async () => {
      const req1 = createDeferred<ImportMediaResult>();
      const req2 = createDeferred<ImportMediaResult>();

      const importMediaMock = vi.fn().mockImplementation((path: string) => {
        if (path.includes("first")) return req1.promise;
        return req2.promise;
      });

      const store = createMediaStore({ importMedia: importMediaMock });

      const p1 = store.getState().importPath("/media/first.mp4");
      const p2 = store.getState().importPath("/media/second.mp4");

      const media1 = createFakeMediaResult("first.mp4");
      const media2 = createFakeMediaResult("second.mp4");

      // Req2 (newer) finishes first
      req2.resolve(media2);
      const res2 = await p2;

      expect(res2).toEqual(media2);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().media).toEqual(media2);

      // Req1 (older) finishes later
      req1.resolve(media1);
      const res1 = await p1;

      expect(res1).toBeNull();
      // State MUST remain at second.mp4
      expect(store.getState().status).toBe("ready");
      expect(store.getState().media).toEqual(media2);
      expect(store.getState().error).toBeNull();
    });

    it("ignores stale failure when a newer request completes successfully", async () => {
      const req1 = createDeferred<ImportMediaResult>();
      const req2 = createDeferred<ImportMediaResult>();

      const importMediaMock = vi.fn().mockImplementation((path: string) => {
        if (path.includes("first")) return req1.promise;
        return req2.promise;
      });

      const store = createMediaStore({ importMedia: importMediaMock });

      const p1 = store.getState().importPath("/media/first.mp4");
      const p2 = store.getState().importPath("/media/second.mp4");

      const media2 = createFakeMediaResult("second.mp4");

      // Newer request succeeds
      req2.resolve(media2);
      const res2 = await p2;
      expect(res2).toEqual(media2);
      expect(store.getState().status).toBe("ready");
      expect(store.getState().media).toEqual(media2);

      // Older request fails later
      req1.reject(new ImportMediaError({ code: "pathNotFound" }));
      const res1 = await p1;

      expect(res1).toBeNull();
      // State MUST remain ready with second.mp4 and NO error
      expect(store.getState().status).toBe("ready");
      expect(store.getState().media).toEqual(media2);
      expect(store.getState().error).toBeNull();
    });

    it("ignores stale success when a newer request failed", async () => {
      const req1 = createDeferred<ImportMediaResult>();
      const req2 = createDeferred<ImportMediaResult>();

      const importMediaMock = vi.fn().mockImplementation((path: string) => {
        if (path.includes("first")) return req1.promise;
        return req2.promise;
      });

      const initialMedia = createFakeMediaResult("initial.mp4");
      const store = createMediaStore(
        { importMedia: importMediaMock },
        { status: "ready", media: initialMedia },
      );

      const p1 = store.getState().importPath("/media/first.mp4");
      const p2 = store.getState().importPath("/media/second.mp4");

      // Newer request fails
      req2.reject(new ImportMediaError({ code: "assetScopeDenied" }));
      const res2 = await p2;
      expect(res2).toBeNull();
      expect(store.getState().status).toBe("error");
      expect(store.getState().error?.code).toBe("assetScopeDenied");
      expect(store.getState().media).toEqual(initialMedia);

      // Older request succeeds later
      req1.resolve(createFakeMediaResult("first.mp4"));
      const res1 = await p1;

      expect(res1).toBeNull();
      // State MUST remain at error from req2, not overwritten by req1
      expect(store.getState().status).toBe("error");
      expect(store.getState().error?.code).toBe("assetScopeDenied");
      expect(store.getState().media).toEqual(initialMedia);
    });

    it("ignores stale failure when a newer request also failed", async () => {
      const req1 = createDeferred<ImportMediaResult>();
      const req2 = createDeferred<ImportMediaResult>();

      const importMediaMock = vi.fn().mockImplementation((path: string) => {
        if (path.includes("first")) return req1.promise;
        return req2.promise;
      });

      const store = createMediaStore({ importMedia: importMediaMock });

      const p1 = store.getState().importPath("/media/first.mp4");
      const p2 = store.getState().importPath("/media/second.mp4");

      // Newer request fails first with E2
      req2.reject(new ImportMediaError({ code: "ffmpegPairMissing" }));
      await p2;
      expect(store.getState().error?.code).toBe("ffmpegPairMissing");

      // Older request fails later with E1
      req1.reject(new ImportMediaError({ code: "invalidPath" }));
      await p1;

      // State MUST keep error from req2
      expect(store.getState().status).toBe("error");
      expect(store.getState().error?.code).toBe("ffmpegPairMissing");
    });

    it("handles multiple interleaved requests and only lets the latest win", async () => {
      const deferreds = [
        createDeferred<ImportMediaResult>(),
        createDeferred<ImportMediaResult>(),
        createDeferred<ImportMediaResult>(),
        createDeferred<ImportMediaResult>(),
      ];

      const importMediaMock = vi.fn().mockImplementation((path: string) => {
        const match = path.match(/file-(\d+)/);
        const index = match ? parseInt(match[1], 10) : -1;
        return deferreds[index].promise;
      });

      const store = createMediaStore({ importMedia: importMediaMock });

      const promises = [
        store.getState().importPath("/media/file-0.mp4"),
        store.getState().importPath("/media/file-1.mp4"),
        store.getState().importPath("/media/file-2.mp4"),
        store.getState().importPath("/media/file-3.mp4"),
      ];

      // Resolve in random out-of-order sequence: 1, 3, 0, 2
      deferreds[1].resolve(createFakeMediaResult("file-1.mp4"));
      deferreds[3].resolve(createFakeMediaResult("file-3.mp4"));
      deferreds[0].resolve(createFakeMediaResult("file-0.mp4"));
      deferreds[2].reject(new ImportMediaError({ code: "invalidPath" }));

      const results = await Promise.all(promises);

      expect(results[0]).toBeNull();
      expect(results[1]).toBeNull();
      expect(results[2]).toBeNull();
      expect(results[3]).toEqual(createFakeMediaResult("file-3.mp4"));

      expect(store.getState().status).toBe("ready");
      expect(store.getState().media?.fileName).toBe("file-3.mp4");
      expect(store.getState().error).toBeNull();
    });
  });

  describe("Report Error Action", () => {
    it("reports an error while preserving existing media", () => {
      const initialMedia = createFakeMediaResult("initial.mp4");
      const store = createMediaStore(
        {},
        {
          status: "ready",
          media: initialMedia,
          error: null,
        },
      );

      store.getState().reportError(
        new ImportMediaError({
          code: "dialogFailed",
          detail: "Dialog cancelled abnormally",
        }),
      );

      expect(store.getState().status).toBe("error");
      expect(store.getState().media).toEqual(initialMedia);
      expect(store.getState().error?.code).toBe("dialogFailed");
      expect(store.getState().error?.detail).toBe("Dialog cancelled abnormally");
    });

    it("normalizes unknown errors passed to reportError", () => {
      const store = createMediaStore();

      store.getState().reportError("Unknown failure");

      expect(store.getState().status).toBe("error");
      expect(store.getState().media).toBeNull();
      expect(store.getState().error?.code).toBe("unknown");
      expect(store.getState().error?.detail).toBe("Unknown failure");
    });

    it("invalidates in-flight requests so late completions do not overwrite the error state", async () => {
      const deferred = createDeferred<ImportMediaResult>();
      const store = createMediaStore({
        importMedia: () => deferred.promise,
      });

      const importPromise = store.getState().importPath("/media/test.mp4");
      expect(store.getState().status).toBe("loading");

      store.getState().reportError(new ImportMediaError({ code: "dialogFailed" }));
      expect(store.getState().status).toBe("error");
      expect(store.getState().error?.code).toBe("dialogFailed");

      // Late resolution of earlier in-flight import
      deferred.resolve(createFakeMediaResult("test.mp4"));
      const result = await importPromise;

      expect(result).toBeNull();
      expect(store.getState().status).toBe("error");
      expect(store.getState().media).toBeNull();
      expect(store.getState().error?.code).toBe("dialogFailed");
    });
  });

  describe("Default Store Singleton", () => {
    it("provides a default singleton store instance in idle state", () => {
      const state = mediaStore.getState();
      expect(state.status).toBe("idle");
      expect(state.media).toBeNull();
      expect(state.error).toBeNull();
      expect(typeof state.importPath).toBe("function");
      expect(typeof state.reportError).toBe("function");
      expect(typeof state.reset).toBe("function");
    });
  });
});
